/**
 * The coaching loop — Prompt 01 and Prompt 02, as code.
 *
 * `prompts/01-tonality-transcript.md` tags one recording. `prompts/02-tonality-coach.md`
 * reads the trailing fifty and names what to fix. This module runs both.
 *
 * ── Why this is the part that compounds ─────────────────────────────────────
 * A competitor can buy the same TTS vendor and the same model. They cannot buy
 * your call library. Every call produces a transcript, every transcript feeds
 * the coach, and the coach's findings become configuration that makes the next
 * thousand calls slightly better.
 *
 * The honest caveat is that it takes roughly 20,000 calls before the advantage
 * is real — nine to twelve months of one agency's volume. Instrument it from
 * call one anyway, because the data is not reconstructable later.
 *
 * ── Two model choices worth stating ─────────────────────────────────────────
 * Prompt 01 needs **audio input**. Tone lives in the waveform, not the text;
 * running it against an existing transcript produces confident fiction.
 *
 * Both run at high effort and are streamed. Unlike the live turn loop — where
 * `effort: low` buys latency that matters — nothing here is latency-sensitive,
 * and the output is long enough that a non-streaming request risks an HTTP
 * timeout.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Speaker, TonalityTag, Transcript, Utterance } from '@/types';

export const DEFAULT_ANALYSIS_MODEL = 'claude-opus-5';

function analysisModel(): string {
  return process.env['DANNY_ANALYSIS_MODEL'] ?? DEFAULT_ANALYSIS_MODEL;
}

// ─────────────────────────────────────────────────────────────
// Prompt 01 — tag one recording
// ─────────────────────────────────────────────────────────────

const TONALITY_TRANSCRIPT_PROMPT = `You are analyzing a recorded insurance sales call. Work from the audio itself, not from any text you may have seen.

1. Label each speaker [REP] and [PROSPECT] and timestamp every turn as [mm:ss].

2. After each line add a tonality tag covering:
   - terminal pitch direction (rising / falling / flat)
   - pace against that speaker's own baseline for this call, as a percentage
   - energy against the other speaker's running level, in relative terms
   - hedge words quoted exactly as spoken
   - any pause longer than one second, with its duration

3. Mark every moment the rep's tone changes mid-sentence, and say what changed.

4. Flag the timestamp where the prospect's tone first turns, and quote the rep line immediately before it.

5. Do not paraphrase. Do not fix grammar. Do not clean up filler words. Keep "um", "uh", false starts, and self-interruptions exactly as spoken. Verbatim means verbatim.

6. Flag every price delivery separately. For each moment a number is spoken, note the pitch contour across the number itself and the length of silence immediately after it. Mark whether the rep held the silence or filled it.

7. Flag every compliance utterance — the AI disclosure, the recording notice, and on Medicare calls the CMS disclaimer. For each, note whether pace increased relative to the surrounding speech. A disclosure read faster than the sales copy around it is a disclosure the listener did not absorb, and regulators treat delivery as part of adequacy.

8. Flag every moment the rep introduces a coverage term (deductible, limit, rider, elimination period, coinsurance). Note whether the prospect's next turn shows comprehension or confusion.

9. Note every instance of the rep speaking over the prospect, with timestamp and who yielded.

10. End with three lines: rep average energy, prospect average energy, and the gap.`;

/** Structured shape the tagger returns, so downstream reads fields not prose. */
const TRANSCRIPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['utterances', 'repAverageEnergy', 'prospectAverageEnergy', 'prospectTurnMs'],
  properties: {
    utterances: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'speaker', 'startMs', 'endMs', 'text', 'tonality'],
        properties: {
          index: { type: 'integer' },
          speaker: { type: 'string', enum: ['REP', 'PROSPECT'] },
          startMs: { type: 'integer' },
          endMs: { type: 'integer' },
          text: { type: 'string', description: 'Verbatim. Filler words preserved.' },
          tonality: {
            type: 'object',
            additionalProperties: false,
            required: [
              'terminalPitch',
              'paceVsOwnBaseline',
              'energyVsCounterpart',
              'hedgeWords',
              'precedingPauseMs',
              'midSentenceShifts',
            ],
            properties: {
              terminalPitch: { type: 'string', enum: ['rising', 'falling', 'flat'] },
              paceVsOwnBaseline: { type: 'number' },
              energyVsCounterpart: { type: 'number' },
              hedgeWords: { type: 'array', items: { type: 'string' } },
              precedingPauseMs: { type: ['integer', 'null'] },
              midSentenceShifts: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
    repAverageEnergy: { type: 'number' },
    prospectAverageEnergy: { type: 'number' },
    prospectTurnMs: {
      type: ['integer', 'null'],
      description: 'Where the prospect tone first turned. Null if it never did.',
    },
  },
} as const;

interface TaggedTranscript {
  utterances: {
    index: number;
    speaker: Speaker;
    startMs: number;
    endMs: number;
    text: string;
    tonality: TonalityTag;
  }[];
  repAverageEnergy: number;
  prospectAverageEnergy: number;
  prospectTurnMs: number | null;
}

export interface TagOptions {
  readonly client?: Anthropic;
  readonly model?: string;
}

/**
 * Run Prompt 01 against one recording.
 *
 * `audio` is the raw recording bytes. Note this needs a model with audio input —
 * handing it a text transcript would produce tonality tags invented from
 * wording, which is worse than no tags because they look authoritative.
 */
export async function tagRecording(
  input: {
    readonly callId: string;
    readonly audio: Uint8Array;
    readonly mediaType: 'audio/mpeg' | 'audio/wav';
  },
  options: TagOptions = {},
): Promise<Transcript> {
  const client = options.client ?? new Anthropic();

  const stream = client.messages.stream({
    model: options.model ?? analysisModel(),
    max_tokens: 64_000,
    thinking: { type: 'adaptive' },
    output_config: {
      // Quality over latency: nothing waits on this.
      effort: 'high',
      format: { type: 'json_schema', schema: TRANSCRIPT_SCHEMA },
    },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: input.mediaType,
              data: Buffer.from(input.audio).toString('base64'),
            },
          },
          { type: 'text', text: TONALITY_TRANSCRIPT_PROMPT },
        ] as unknown as Anthropic.ContentBlockParam[],
      },
    ],
  });

  const message = await stream.finalMessage();
  const text = message.content.find((b) => b.type === 'text');
  if (!text || text.type !== 'text') {
    throw new Error('Tonality tagging returned no text block.');
  }

  const tagged = JSON.parse(text.text) as TaggedTranscript;

  return {
    id: `t_${input.callId}`,
    callId: input.callId,
    utterances: tagged.utterances satisfies readonly Utterance[],
    repAverageEnergy: tagged.repAverageEnergy,
    prospectAverageEnergy: tagged.prospectAverageEnergy,
    energyGap: tagged.repAverageEnergy - tagged.prospectAverageEnergy,
    prospectTurnMs: tagged.prospectTurnMs,
  };
}

// ─────────────────────────────────────────────────────────────
// Prompt 02 — coach across the trailing fifty
// ─────────────────────────────────────────────────────────────

const COACH_PROMPT = `You are reviewing tone-tagged sales call transcripts.

1. Rank the three most repeated tonality mistakes by how often they appear in the sixty seconds before a hang-up.

2. For each one quote three real lines from the transcripts, with timestamps.

3. Rewrite each line the way it should have been said. Same words, different delivery.

4. Describe that delivery in one sentence that can actually be executed: pitch, pace, pause, volume.

5. Find the single line across all calls where the tone worked best, and say why.

6. Name one drill that can be run in ten minutes before tomorrow's block. No compliments, no summary.

Constraint that matters: hold the WORDS fixed and change only the DELIVERY. Handing someone new words reads as being told they were stupid, and they revert within a week. Changing delivery on words they already believe in is executable in a single rehearsal.`;

const COACH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['mistakes', 'bestLine', 'drill'],
  properties: {
    mistakes: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'frequencyBeforeHangup', 'examples', 'delivery', 'agentConfigFix'],
        properties: {
          name: { type: 'string' },
          frequencyBeforeHangup: { type: 'integer' },
          examples: {
            type: 'array',
            maxItems: 3,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['timestamp', 'said', 'rewrite'],
              properties: {
                timestamp: { type: 'string' },
                said: { type: 'string' },
                rewrite: { type: 'string', description: 'Same words. Different delivery.' },
              },
            },
          },
          delivery: { type: 'string' },
          agentConfigFix: {
            type: ['string', 'null'],
            description:
              'The equivalent change for the AI agent rather than a human — a VAD ' +
              'threshold, a pause insertion, a guardrail pattern. Null if human-only.',
          },
        },
      },
    },
    bestLine: {
      type: 'object',
      additionalProperties: false,
      required: ['timestamp', 'said', 'why'],
      properties: {
        timestamp: { type: 'string' },
        said: { type: 'string' },
        why: { type: 'string' },
      },
    },
    drill: { type: 'string' },
  },
} as const;

export interface CoachingReport {
  readonly mistakes: readonly {
    readonly name: string;
    readonly frequencyBeforeHangup: number;
    readonly examples: readonly {
      readonly timestamp: string;
      readonly said: string;
      readonly rewrite: string;
    }[];
    readonly delivery: string;
    /** The agent-side equivalent, where one exists. This is the compounding half. */
    readonly agentConfigFix: string | null;
  }[];
  readonly bestLine: { readonly timestamp: string; readonly said: string; readonly why: string };
  readonly drill: string;
}

export interface CoachOptions extends TagOptions {
  /**
   * Restrict to calls that ended a given way.
   *
   * Default is every call. Note the trap the prompt file warns about: coaching
   * toward "prospect stayed on longer" optimizes for a tone that never closes.
   * Rank against bound-and-persisting outcomes, not call duration.
   */
  readonly dispositionFilter?: readonly string[];
}

export async function generateCoaching(
  transcripts: readonly Transcript[],
  options: CoachOptions = {},
): Promise<CoachingReport> {
  if (transcripts.length === 0) {
    throw new Error('Coaching needs at least one tagged transcript.');
  }

  const client = options.client ?? new Anthropic();

  const corpus = transcripts
    .map((t) =>
      [
        `## Call ${t.callId} (energy gap ${t.energyGap.toFixed(2)})`,
        ...t.utterances.map((u) => {
          const tone = u.tonality;
          const tags = tone
            ? ` [${tone.terminalPitch}, pace ${tone.paceVsOwnBaseline}%, energy ${tone.energyVsCounterpart}` +
              (tone.hedgeWords.length > 0 ? `, hedges: ${tone.hedgeWords.join('/')}` : '') +
              (tone.precedingPauseMs ? `, pause ${tone.precedingPauseMs}ms` : '') +
              ']'
            : '';
          const ts = `[${String(Math.floor(u.startMs / 60_000)).padStart(2, '0')}:${String(
            Math.floor((u.startMs % 60_000) / 1000),
          ).padStart(2, '0')}]`;
          return `${ts} [${u.speaker}] ${u.text}${tags}`;
        }),
      ].join('\n'),
    )
    .join('\n\n');

  const stream = client.messages.stream({
    model: options.model ?? analysisModel(),
    max_tokens: 32_000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high', format: { type: 'json_schema', schema: COACH_SCHEMA } },
    system: [
      {
        type: 'text',
        text: COACH_PROMPT,
        // Stable across every weekly run; the corpus after it is what varies.
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: `${transcripts.length} tone-tagged transcripts follow.\n\n${corpus}`,
      },
    ],
  });

  const message = await stream.finalMessage();
  const text = message.content.find((b) => b.type === 'text');
  if (!text || text.type !== 'text') {
    throw new Error('Coaching returned no text block.');
  }

  return JSON.parse(text.text) as CoachingReport;
}

// ─────────────────────────────────────────────────────────────
// Derived metrics
// ─────────────────────────────────────────────────────────────

/**
 * The one behaviour that separates reps who close from reps who don't, more
 * cleanly than any other single variable: what happens in the two seconds after
 * the premium is spoken.
 *
 * Saying "four ninety-two a month" and stopping is an offer. Saying it and
 * continuing — "but that's before the bundling discount and honestly there's a
 * few other things we could do" — apologizes for the price before the prospect
 * has reacted to it, and tells them the number is negotiable. So it gets
 * negotiated.
 */
export function heldTheSilenceAfterPrice(transcript: Transcript): {
  readonly priceDeliveries: number;
  readonly held: number;
  readonly rate: number;
} {
  const utterances = transcript.utterances;
  let deliveries = 0;
  let held = 0;

  utterances.forEach((u, i) => {
    if (u.speaker !== 'REP') return;
    // A spoken premium: digits, or a number written out with a period word.
    if (!/\d|\b(hundred|thousand|ninety|eighty|seventy|sixty|fifty|forty|thirty|twenty)\b/i.test(u.text)) {
      return;
    }
    if (!/\b(month|year|premium|dollar|a month|six months)\b/i.test(u.text)) return;

    deliveries++;
    const next = utterances[i + 1];
    // Held means the prospect spoke next, or the rep left a real gap.
    if (!next || next.speaker === 'PROSPECT' || (next.tonality?.precedingPauseMs ?? 0) >= 800) {
      held++;
    }
  });

  return { priceDeliveries: deliveries, held, rate: deliveries === 0 ? 1 : held / deliveries };
}

/** Compliance utterances read faster than the surrounding copy. */
export function disclosureRushedBy(transcript: Transcript): number | null {
  const rep = transcript.utterances.filter((u) => u.speaker === 'REP' && u.tonality);
  const disclosure = rep.find((u) => /AI assistant|not a human|recorded for quality/i.test(u.text));
  if (!disclosure?.tonality) return null;

  const others = rep.filter((u) => u !== disclosure);
  if (others.length === 0) return null;

  const baseline =
    others.reduce((s, u) => s + (u.tonality?.paceVsOwnBaseline ?? 0), 0) / others.length;
  return disclosure.tonality.paceVsOwnBaseline - baseline;
}
