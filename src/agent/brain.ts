/**
 * The turn generator.
 *
 * Takes conversation state, produces the next thing Danny says — as a stream of
 * guardrail-checked sentence chunks, so TTS can start synthesizing before the
 * model has finished writing.
 *
 * ── The pipelining / safety tension, and how it resolves ─────────────────────
 * Sentence-level pipelining saves 300–600ms per turn (see docs/03-VOICE-PIPELINE.md),
 * which is most of the difference between "natural" and "laggy". But you cannot
 * guardrail-check text you have not finished generating, and you cannot un-say
 * audio you have already put on the wire.
 *
 * The resolution: **check at the sentence boundary, emit after.** Each chunk is
 * run through `checkGuardrails` the moment it completes and before it is
 * yielded. A violation aborts the stream mid-turn and regenerates with the
 * violation named. The cost is that a prohibited phrase in sentence three does
 * not stop sentence one from being spoken — which is why the guardrails target
 * statements that are individually harmful ("you're covered", "I'm a licensed
 * human") rather than requiring whole-turn context to judge.
 *
 * ── Latency ─────────────────────────────────────────────────────────────────
 * Turn budget is ~250–400ms to first token. Two settings do the work:
 *   - `effort: 'low'`. A phone turn is a short, well-scoped generation; low
 *     effort is the documented setting for latency-sensitive routes and it does
 *     not measurably hurt quality here.
 *   - Prompt caching on the system block. The system prompt plus contact
 *     summary is stable for the whole call and across every call in a campaign;
 *     caching it is the difference between paying for ~2k tokens per turn and
 *     paying for ~200.
 *
 * Thinking stays on (adaptive). Disabling it on Opus 5 has two documented
 * failure modes — tool calls written into visible text, and `<thinking>` tags
 * leaking into the response — and a leaked tag would be *spoken out loud* to a
 * prospect. Low effort is the correct lever; disabled thinking is not.
 */

import Anthropic from '@anthropic-ai/sdk';
import { checkGuardrails, type ConversationState, type GuardrailViolation } from './state-machine';
import { splitIntoSpeakableChunks } from '@/voice/tts-fish';
import type { LineOfBusiness } from '@/types';

export const DEFAULT_TURN_MODEL = 'claude-opus-5';
export const DEFAULT_ANALYSIS_MODEL = 'claude-opus-5';

/** A phone turn is one or two sentences. This is a runaway guard, not a target. */
const MAX_TURN_TOKENS = 300;

export interface TurnContext {
  readonly state: ConversationState;
  readonly stateInstructions: string;
  readonly line: LineOfBusiness;
  readonly agencyName: string;
  readonly producerName: string;
  readonly contactSummary: string;
  readonly discoverySoFar: string;
  readonly missingFields: readonly string[];
  /** Verbatim conversation so far. */
  readonly history: readonly Anthropic.MessageParam[];
}

export interface TurnChunk {
  /** A complete, guardrail-cleared sentence, ready to synthesize. */
  readonly text: string;
  readonly index: number;
}

export class GuardrailViolationError extends Error {
  constructor(
    readonly violations: readonly GuardrailViolation[],
    readonly partialText: string,
  ) {
    super(
      `Generated turn violated guardrails: ` +
        violations.map((v) => `"${v.matched}" (${v.why})`).join('; '),
    );
    this.name = 'GuardrailViolationError';
  }
}

/**
 * Build the system prompt. Split into two blocks so the stable half can be
 * cached across every call in a campaign and the volatile half cannot
 * invalidate it — cache is a prefix match, so ordering here is load-bearing.
 */
function buildSystem(ctx: TurnContext): Anthropic.TextBlockParam[] {
  const stable = `You are Danny, an AI assistant making a phone call on behalf of ${ctx.agencyName}, a licensed insurance agency. You are speaking out loud on a live telephone call.

WHAT YOU ARE
You are an AI. The caller has already been told this — the disclosure was spoken before you were given a turn. If they ask again, confirm it plainly and offer a human. Never claim to be a person, never deflect the question, never answer it with a joke.

WHAT YOU ARE FOR
Find out whether this person has an insurance need worth a licensed producer's time, and if they do, get them booked with one. You are not closing a sale. You are qualifying and scheduling. A call that ends with an appointment is a win. A call that ends with a clear no in ninety seconds is also a win.

HOW TO SPEAK
- One idea per turn. This is a phone call, not an email.
- Under 30 words unless you are reading a quote back.
- Ask one question at a time, then stop talking.
- Contractions. "I'll", "you're", "that's". Nobody says "I will" out loud.
- No bullet points, no lists, no markdown. You are being spoken by a TTS engine.
- Numbers as words in context: "four ninety-two a month", not "$492.00/mo".
- When you say a price, say it and then stop. Do not soften it, qualify it, or stack another sentence on top of it. Let them react first.
- Never say "as an AI", "I'd be happy to", "great question", or "absolutely".

WHAT YOU NEVER DO
- Never say coverage is bound, active, approved, or guaranteed. You cannot bind.
- Never quote a number that did not come from a carrier API in this call.
- Never promise savings. You can say what the quote came back as. That is all.
- Never imply any connection to Medicare, CMS, Social Security, or any government program.
- Never suggest the prospect's current coverage is at risk to create urgency.
- Never continue after someone asks you to stop. Not one more sentence.
- Never give advice about which plan is better. Route that to a licensed producer.

WHEN YOU DON'T KNOW
Say so, and hand it to a human: "That's a good question and I don't want to guess — let me get you to ${ctx.producerName}." Being uncertain out loud costs you nothing. Guessing at a coverage question costs the agency an E&O claim.

IF THEY ASK FOR A HUMAN
Say yes immediately. No qualifying first, no "let me just grab one thing". The disclosure promised this. Keep it.

Respond with only the words to speak. No stage directions, no labels, no quotation marks.`;

  const volatile = `CURRENT STATE: ${ctx.state}
${ctx.stateInstructions}

LINE OF BUSINESS: ${ctx.line}

WHAT YOU KNOW
${ctx.contactSummary}

COLLECTED SO FAR
${ctx.discoverySoFar || '(nothing yet)'}

${ctx.missingFields.length > 0 ? `STILL NEEDED: ${ctx.missingFields.join(', ')}` : ''}`;

  return [
    // Stable block, cached. Identical across every call for this agency.
    { type: 'text', text: stable, cache_control: { type: 'ephemeral' } },
    // Volatile block, after the breakpoint so it cannot invalidate the cache.
    { type: 'text', text: volatile },
  ];
}

export interface BrainOptions {
  readonly client?: Anthropic;
  readonly model?: string;
  /** Raise for post-call analysis; leave low for live turns. */
  readonly effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

/**
 * Stream the next turn as guardrail-cleared sentence chunks.
 *
 * Throws `GuardrailViolationError` mid-stream on a violation. The caller
 * (`media-server.ts`) catches it, logs the attempt, and retries once with the
 * violation named; a second failure falls back to a safe canned line rather
 * than risking a third generation on a live call.
 */
export async function* streamTurn(
  ctx: TurnContext,
  options: BrainOptions = {},
): AsyncGenerator<TurnChunk, void, undefined> {
  const client = options.client ?? new Anthropic();
  const model = options.model ?? process.env['DANNY_TURN_MODEL'] ?? DEFAULT_TURN_MODEL;

  const stream = client.messages.stream({
    model,
    max_tokens: MAX_TURN_TOKENS,
    system: buildSystem(ctx),
    messages: [...ctx.history],
    thinking: { type: 'adaptive' },
    output_config: { effort: options.effort ?? 'low' },
  });

  let buffered = '';
  let emitted = 0;
  let emittedChars = 0;

  for await (const event of stream) {
    if (event.type !== 'content_block_delta') continue;
    if (event.delta.type !== 'text_delta') continue;

    buffered += event.delta.text;

    // Re-split the whole buffer each time rather than tracking offsets: the
    // chunker needs full context to tell "St." from a sentence end, and at
    // ~300 tokens the cost is irrelevant.
    const chunks = splitIntoSpeakableChunks(buffered);

    // The last chunk may still be growing; only emit completed ones.
    for (let i = emitted; i < chunks.length - 1; i++) {
      const text = chunks[i];
      if (text === undefined) continue;

      const violations = checkGuardrails(text);
      if (violations.length > 0) {
        stream.abort();
        throw new GuardrailViolationError(violations, buffered);
      }

      emitted++;
      emittedChars += text.length;
      yield { text, index: i };
    }
  }

  // Whatever is left after the stream closes is the final sentence.
  const tail = buffered.slice(emittedChars).trim();
  if (tail) {
    const violations = checkGuardrails(tail);
    if (violations.length > 0) {
      throw new GuardrailViolationError(violations, buffered);
    }
    yield { text: tail, index: emitted };
  }
}

/**
 * Non-streaming convenience for tests and for the states where the whole turn
 * is checked before anything is spoken (the close, where a bad line is most
 * costly and 300ms of extra latency is least).
 */
export async function generateTurn(
  ctx: TurnContext,
  options: BrainOptions = {},
): Promise<string> {
  const parts: string[] = [];
  for await (const chunk of streamTurn(ctx, options)) parts.push(chunk.text);
  return parts.join(' ');
}

/**
 * Safe fallback line, spoken when generation fails twice. It is deliberately
 * a hand-off rather than a retry: two failed generations on a live call is a
 * signal to get a human on the phone, not to roll the dice again.
 */
export const SAFE_FALLBACK_LINE =
  "Sorry — I'm having trouble on my end. Let me get you to someone who can help.";
