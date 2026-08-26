/**
 * Fish Audio TTS — streaming synthesis in the cloned voice.
 *
 * ── The latency budget ───────────────────────────────────────────────────────
 * Human turn-taking tolerates roughly 500–800ms of silence before the other
 * party starts to feel that something is wrong. Past about 1200ms they say
 * "hello?" and the call is damaged. Our budget, from the prospect's last
 * phoneme to the first byte of our audio hitting the carrier:
 *
 *   endpointing (VAD confirms they stopped)      ~200ms   ← biggest lever
 *   STT final transcript                          ~80ms
 *   LLM time-to-first-token                    ~250-400ms
 *   TTS time-to-first-audio (Fish, streaming)  ~150-300ms
 *   network + jitter buffer + PSTN               ~120ms
 *   ────────────────────────────────────────────────────
 *   total                                      ~800ms-1.1s
 *
 * That is already at the edge. Two things buy it back and both are implemented
 * here rather than hoped for:
 *
 *  1. **Sentence-level pipelining.** Do not wait for the LLM to finish. Cut the
 *     token stream at the first sentence boundary and start synthesizing while
 *     the model is still writing. Saves 300–600ms on a typical turn — usually
 *     the difference between "natural" and "laggy".
 *  2. **Pre-warmed openers.** The disclosure and the top handful of responses
 *     are synthesized once and cached as audio. The first thing the prospect
 *     hears has zero generation latency, which sets their expectation for the
 *     rest of the call.
 *
 * ── The codec trap ───────────────────────────────────────────────────────────
 * PSTN audio is 8kHz μ-law. Synthesizing 44.1kHz and downsampling at the edge
 * wastes bytes and introduces resampling artifacts on exactly the sibilants that
 * make a clone sound human. Request 8kHz PCM and let Twilio's media stream take
 * it directly.
 */

import { assertReleaseValid, type VoiceModel, type VoiceRelease } from './clone';
import type { LineOfBusiness } from '@/types';

export interface FishConfig {
  readonly apiKey: string;
  readonly apiBase: string;
  readonly modelId: string;
  /** Twilio media streams speak 8kHz mono μ-law. Match it at the source. */
  readonly sampleRateHz: 8000 | 16000 | 24000 | 44100;
  readonly format: 'pcm' | 'mp3' | 'wav' | 'opus';
  /** 0 is fastest and least expressive. Insurance wants warm, not theatrical. */
  readonly temperature: number;
  readonly topP: number;
}

export const DEFAULT_FISH_CONFIG: Omit<FishConfig, 'apiKey' | 'modelId'> = {
  apiBase: 'https://api.fish.audio',
  sampleRateHz: 8000,
  format: 'pcm',
  temperature: 0.7,
  topP: 0.7,
};

/** Hard ceiling. Past this we fail over rather than let the call go dead. */
export const TTS_FIRST_BYTE_BUDGET_MS = 400;

export interface SynthesisContext {
  readonly release: VoiceRelease;
  readonly model: VoiceModel;
  readonly line: LineOfBusiness;
  readonly use: 'outbound_call' | 'inbound_call' | 'voicemail';
  readonly at: Date;
}

export class TtsTimeoutError extends Error {
  constructor(readonly elapsedMs: number) {
    super(`Fish TTS exceeded the ${TTS_FIRST_BYTE_BUDGET_MS}ms first-byte budget (${elapsedMs}ms)`);
    this.name = 'TtsTimeoutError';
  }
}

/**
 * Split a token stream into speakable chunks at sentence boundaries.
 *
 * The subtlety is abbreviations and numbers, which are everywhere in insurance
 * copy: "Mr." and "$1,250.00" and "St." all contain periods that are not
 * sentence ends. Splitting on them produces audible mid-number pauses — the
 * single most common tell that a voice agent is a voice agent.
 */
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'st', 'ave', 'blvd', 'rd', 'jr', 'sr',
  'inc', 'llc', 'co', 'corp', 'no', 'vs', 'approx', 'est',
]);

export function splitIntoSpeakableChunks(text: string): string[] {
  const chunks: string[] = [];
  let current = '';

  const tokens = text.split(/(?<=[.!?])\s+/);
  for (const token of tokens) {
    current += (current ? ' ' : '') + token;

    const trimmed = current.trimEnd();
    const lastWord = trimmed.split(/\s+/).pop() ?? '';
    const bare = lastWord.replace(/[.!?]+$/, '').toLowerCase();

    // Not a boundary if the "sentence" ends in a known abbreviation…
    if (ABBREVIATIONS.has(bare)) continue;
    // …or in a digit followed by a period, i.e. a decimal we clipped.
    if (/\d\.$/.test(trimmed)) continue;
    // …or if it's too short to be worth a round trip.
    if (trimmed.length < 12) continue;

    if (/[.!?]$/.test(trimmed)) {
      chunks.push(trimmed);
      current = '';
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

export interface FishClient {
  /**
   * Stream synthesized audio. Yields chunks as they arrive so the caller can
   * begin writing to the carrier before generation completes.
   */
  synthesizeStream(
    text: string,
    ctx: SynthesisContext,
  ): AsyncIterable<Uint8Array>;
}

export function createFishClient(config: FishConfig): FishClient {
  return {
    async *synthesizeStream(text, ctx): AsyncIterable<Uint8Array> {
      // Governance first. A revoked release must stop synthesis mid-call, not
      // merely prevent the next call from starting.
      assertReleaseValid({
        release: ctx.release,
        model: ctx.model,
        use: ctx.use,
        line: ctx.line,
        at: ctx.at,
      });

      const startedAt = performance.now();

      const response = await fetch(`${config.apiBase}/v1/tts`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
          // Fish streams incrementally when asked; without this you wait for
          // the whole utterance and blow the budget on anything over a sentence.
          'Accept': 'application/octet-stream',
        },
        body: JSON.stringify({
          text,
          reference_id: config.modelId,
          format: config.format,
          sample_rate: config.sampleRateHz,
          latency: 'balanced',
          temperature: config.temperature,
          top_p: config.topP,
          // Normalization off: it "helpfully" rewrites currency and dates in
          // ways that fight our own number formatting in `speakableNumber`.
          normalize: false,
          streaming: true,
        }),
      });

      if (!response.ok || !response.body) {
        throw new Error(
          `Fish TTS failed: ${response.status} ${response.statusText}`,
        );
      }

      const reader = response.body.getReader();
      let firstByteSeen = false;

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;

          if (!firstByteSeen) {
            firstByteSeen = true;
            const elapsed = performance.now() - startedAt;
            if (elapsed > TTS_FIRST_BYTE_BUDGET_MS) {
              // Surface it rather than swallowing it — the failover path in the
              // orchestrator decides whether to switch providers for this call.
              throw new TtsTimeoutError(Math.round(elapsed));
            }
          }
          yield value;
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
}

/**
 * Render numbers the way a person says them out loud.
 *
 * TTS models read "$1,250.00/mo" as "dollar one comma two five zero point zero
 * zero slash m o" often enough that you cannot ship without this. Insurance
 * conversations are almost entirely numbers, so this function does more for
 * perceived quality than the voice model does.
 */
export function speakableNumber(input: {
  readonly cents: number;
  readonly period?: 'month' | 'year' | 'six_months' | null;
}): string {
  const dollars = Math.round(input.cents / 100);
  const remainder = input.cents % 100;

  const spokenDollars =
    remainder === 0
      ? `${dollars.toLocaleString('en-US')} dollars`
      : `${dollars.toLocaleString('en-US')} dollars and ${remainder} cents`;

  switch (input.period) {
    case 'month':
      return `${spokenDollars} a month`;
    case 'year':
      return `${spokenDollars} a year`;
    case 'six_months':
      return `${spokenDollars} every six months`;
    default:
      return spokenDollars;
  }
}

/**
 * Openers worth pre-synthesizing and caching as audio. Anything the agent says
 * in more than ~5% of calls belongs here: cache hits cost nothing and remove the
 * generation latency from the moments that set the prospect's impression.
 */
export const PREWARM_PHRASES: readonly string[] = [
  'Sure, one moment.',
  'Let me pull that up.',
  'Got it, thank you.',
  'That makes sense.',
  'No problem at all.',
  "I'll take you off the list right now. Have a good one.",
  'Let me get you over to a licensed agent.',
  'Can you hear me okay?',
];
