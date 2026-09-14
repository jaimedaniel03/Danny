/**
 * Twilio media-stream server — the live call loop.
 *
 * This is the process the roadmap calls out as the reason Vercel cannot host
 * the whole product: it holds a WebSocket open for the duration of a call.
 * Deploy it on Fly.io, Railway, or a container. The Next.js control plane
 * points Twilio at it via the `<Connect><Stream>` TwiML.
 *
 * ── Protocol ────────────────────────────────────────────────────────────────
 * Twilio sends JSON frames: `connected`, `start`, `media` (base64 μ-law, 20ms),
 * `stop`, and `mark` (echoed back when our audio finishes playing). We send
 * `media`, `mark`, and `clear`.
 *
 * ── The thing that is easy to get wrong ─────────────────────────────────────
 * Barge-in has two halves and everybody implements the first one.
 *
 *   1. Stop speaking. Send `clear`, which flushes Twilio's playback buffer.
 *   2. **Know what they actually heard.** We may have written six sentences
 *      into Twilio's buffer and the prospect heard one and a half. If the
 *      conversation history records all six, the next turn is incoherent —
 *      Danny will reference things nobody heard.
 *
 * We solve (2) with marks: every sentence is followed by a `mark`, and Twilio
 * echoes each mark back only once that audio has finished playing. On a
 * barge-in, sentences whose marks have not come back were never heard, and are
 * dropped from history. That bookkeeping is why `spokenSentences` and
 * `pendingMarks` exist below, and it is the difference between an agent that
 * repeats itself after every interruption and one that does not.
 */

import { WebSocketServer, type WebSocket, type RawData } from 'ws';
import type { IncomingMessage } from 'node:http';
import { secretMatches } from '@/telephony/twilio';
import Anthropic from '@anthropic-ai/sdk';
import {
  BargeInDetector,
  chunkIntoFrames,
  pcm16ToMulaw,
  silenceFrames,
  BYTES_PER_MULAW_FRAME,
  FRAME_MS,
  type AudioBuffer,
} from '@/voice/audio';
import {
  streamTurn,
  GuardrailViolationError,
  SAFE_FALLBACK_LINE,
  type TurnContext,
} from '@/agent/brain';
import {
  detectInterrupt,
  dispositionFor,
  interruptTransition,
  transition,
  REQUIRED_DISCOVERY,
  SILENCE_TIMEOUT_SECONDS,
  TERMINAL_STATES,
  type ConversationState,
  type Signal,
} from '@/agent/state-machine';
import type { CallDisposition, DialAuthorization, LineOfBusiness } from '@/types';

// ── Twilio wire types ────────────────────────────────────────────────────────

interface TwilioStartEvent {
  readonly event: 'start';
  readonly start: {
    readonly streamSid: string;
    readonly callSid: string;
    readonly customParameters?: Record<string, string>;
  };
}
interface TwilioMediaEvent {
  readonly event: 'media';
  readonly media: { readonly payload: string; readonly timestamp: string };
}
interface TwilioMarkEvent {
  readonly event: 'mark';
  readonly mark: { readonly name: string };
}
interface TwilioStopEvent {
  readonly event: 'stop';
}
type TwilioEvent =
  | TwilioStartEvent
  | TwilioMediaEvent
  | TwilioMarkEvent
  | TwilioStopEvent
  | { readonly event: 'connected' };

// ── Ports the session needs. Injected so the loop is testable without a PSTN. ─

export interface TranscriptionSession {
  /** Feed inbound μ-law audio. */
  send(mulaw: AudioBuffer): void;
  /** Fires when the far end finishes an utterance. */
  onFinal(handler: (text: string) => void): void;
  /** Fires on the first interim result — earliest possible barge-in signal. */
  onInterim(handler: (text: string) => void): void;
  close(): void;
}

export interface SynthesisPort {
  /** Synthesize to 8kHz PCM16. Streamed so playback can start early. */
  synthesize(text: string): AsyncIterable<Uint8Array>;
}

export interface CallSessionDeps {
  readonly authorization: DialAuthorization;
  readonly line: LineOfBusiness;
  readonly agencyName: string;
  readonly producerName: string;
  readonly contactSummary: string;
  readonly createTranscription: () => TranscriptionSession;
  readonly synthesis: SynthesisPort;
  readonly anthropic?: Anthropic;
  /** Called once at the end with the outcome. Persists the call record. */
  readonly onComplete: (outcome: CallOutcome) => void | Promise<void>;
  readonly onDncRequested: (phoneE164: string) => void | Promise<void>;
  readonly onTransferRequested: () => void | Promise<void>;
}

export interface TranscriptEntry {
  readonly speaker: 'REP' | 'PROSPECT';
  readonly text: string;
  readonly atMs: number;
}

export interface CallOutcome {
  readonly disposition: CallDisposition;
  readonly finalState: ConversationState;
  readonly transcript: readonly TranscriptEntry[];
  readonly aiDisclosedAt: Date | null;
  readonly durationMs: number;
}

/**
 * Decode a WebSocket frame to text.
 *
 * `ws` hands back `Buffer | ArrayBuffer | Buffer[]` — the array case is a
 * FRAGMENTED message, and calling `.toString()` on it yields comma-joined
 * garbage that fails JSON.parse. Twilio fragments under load and on large
 * payloads, so this is not theoretical: the symptom is media events silently
 * dropped during exactly the busy moments you most need them.
 */
function decodeFrame(raw: RawData): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf-8');
  if (Buffer.isBuffer(raw)) return raw.toString('utf-8');
  return Buffer.from(raw).toString('utf-8');
}

// ── The session ──────────────────────────────────────────────────────────────

export class CallSession {
  private state: ConversationState = 'DISCLOSING';
  private readonly signals: Signal[] = [];
  private readonly history: Anthropic.MessageParam[] = [];
  private readonly transcript: TranscriptEntry[] = [];
  private readonly discovery = new Map<string, string>();

  private streamSid: string | null = null;
  private readonly startedAt = Date.now();
  private aiDisclosedAt: Date | null = null;

  private readonly bargeIn = new BargeInDetector();
  private stt: TranscriptionSession | null = null;
  private frameCarry: AudioBuffer = Buffer.alloc(0);

  /** Sentences written to Twilio but not yet confirmed played. */
  private pendingMarks = new Map<string, string>();
  /** Sentences the prospect has actually heard. */
  private readonly spokenSentences: string[] = [];
  private markCounter = 0;

  private speaking = false;
  private abortSpeech = false;
  private silenceSinceMs = 0;
  private closed = false;
  /** Set by the first interrupt. See `handleInterrupt`. */
  private interrupted = false;

  constructor(
    private readonly ws: WebSocket,
    private readonly deps: CallSessionDeps,
  ) {}

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  attach(): void {
    this.ws.on('message', (raw) => {
      void this.handleMessage(decodeFrame(raw)).catch((err: unknown) => {
        console.error('[media] handler error', err);
      });
    });
    this.ws.on('close', () => void this.finish());
    this.ws.on('error', (err) => {
      console.error('[media] socket error', err);
      void this.finish();
    });
  }

  private async handleMessage(raw: string): Promise<void> {
    let event: TwilioEvent;
    try {
      event = JSON.parse(raw) as TwilioEvent;
    } catch {
      return;
    }

    switch (event.event) {
      case 'start':
        await this.onStart(event);
        return;
      case 'media':
        this.onMedia(event);
        return;
      case 'mark':
        this.onMark(event);
        return;
      case 'stop':
        await this.finish();
        return;
      default:
        return;
    }
  }

  private async onStart(event: TwilioStartEvent): Promise<void> {
    this.streamSid = event.start.streamSid;

    this.stt = this.deps.createTranscription();
    this.stt.onInterim(() => {
      // Earliest barge-in signal available. Energy detection usually fires
      // first, but on a quiet line the STT interim can beat it.
      if (this.speaking) this.interruptSpeech();
    });
    this.stt.onFinal((text) => {
      void this.onProspectUtterance(text).catch((err: unknown) => {
        console.error('[media] turn error', err);
      });
    });

    // ── The disclosure. Spoken by the runtime, before the model exists in
    // this conversation. Not generated, not skippable, not overridable.
    await this.speak(this.deps.authorization.requiredDisclosure, { interruptible: false });
    this.aiDisclosedAt = new Date();

    // Someone can interrupt *during* the disclosure — it is the moment they
    // learn they are talking to an AI, so it is the likeliest moment. If they
    // did, the call is already over: advancing here would log an invalid
    // transition out of HONORING_DNC, and `takeTurn` would ring the producer a
    // second time on a transfer, because TRANSFERRING is not a terminal state.
    if (this.stopped()) return;

    this.advance('DISCLOSURE_SPOKEN');
    await this.takeTurn();
  }

  /** True once the call is finished or an interrupt has taken it over. */
  private stopped(): boolean {
    return this.closed || this.interrupted;
  }

  private onMedia(event: TwilioMediaEvent): void {
    const mulaw = Buffer.from(event.media.payload, 'base64');
    this.stt?.send(mulaw);

    const { frames, remainder } = chunkIntoFrames(mulaw, this.frameCarry);
    this.frameCarry = remainder;

    let anySpeech = false;
    for (const frame of frames) {
      if (this.bargeIn.observe(frame)) {
        anySpeech = true;
        if (this.speaking) this.interruptSpeech();
      }
    }

    // Silence bookkeeping for the dead-line timeout. The threshold is the same
    // constant the utterance path checks — a second hardcoded 12 here would let
    // the two disagree the first time anyone tuned it.
    this.silenceSinceMs = anySpeech ? 0 : this.silenceSinceMs + frames.length * FRAME_MS;
    const silentSeconds = this.silenceSinceMs / 1000;
    if (silentSeconds >= SILENCE_TIMEOUT_SECONDS && !this.speaking) {
      void this.handleInterrupt({ kind: 'SILENCE_TIMEOUT', seconds: silentSeconds });
    }
  }

  /**
   * Twilio echoes a mark once the audio preceding it has finished playing.
   * That is the only reliable signal that the prospect actually heard a
   * sentence, so it is what promotes a sentence into conversation history.
   */
  private onMark(event: TwilioMarkEvent): void {
    const sentence = this.pendingMarks.get(event.mark.name);
    if (sentence === undefined) return;
    this.pendingMarks.delete(event.mark.name);
    this.spokenSentences.push(sentence);
    this.transcript.push({ speaker: 'REP', text: sentence, atMs: Date.now() - this.startedAt });
  }

  // ── Speaking ───────────────────────────────────────────────────────────────

  private send(payload: Record<string, unknown>): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(payload));
  }

  /**
   * Stop mid-sentence. `clear` flushes Twilio's playback buffer; anything still
   * pending was never heard and is dropped rather than recorded as said.
   */
  private interruptSpeech(): void {
    this.abortSpeech = true;
    this.send({ event: 'clear', streamSid: this.streamSid });
    this.pendingMarks.clear();
  }

  private async speak(
    text: string,
    options: { readonly interruptible?: boolean } = {},
  ): Promise<void> {
    const interruptible = options.interruptible ?? true;
    this.speaking = true;
    this.abortSpeech = false;

    let carry: AudioBuffer = Buffer.alloc(0);
    try {
      for await (const pcmChunk of this.deps.synthesis.synthesize(text)) {
        if (interruptible && this.abortSpeech) return;

        const mulaw = pcm16ToMulaw(Buffer.from(pcmChunk));
        const { frames, remainder } = chunkIntoFrames(mulaw, carry);
        carry = remainder;

        for (const frame of frames) {
          if (interruptible && this.abortSpeech) return;
          this.send({
            event: 'media',
            streamSid: this.streamSid,
            media: { payload: frame.toString('base64') },
          });
        }
      }

      // Flush a partial trailing frame, padded — one click at the end of an
      // utterance is inaudible; a dropped 15ms of a final word is not.
      if (carry.length > 0) {
        const padded = Buffer.alloc(BYTES_PER_MULAW_FRAME, 0xff);
        carry.copy(padded);
        this.send({
          event: 'media',
          streamSid: this.streamSid,
          media: { payload: padded.toString('base64') },
        });
      }

      const markName = `m${++this.markCounter}`;
      this.pendingMarks.set(markName, text);
      this.send({ event: 'mark', streamSid: this.streamSid, mark: { name: markName } });
    } finally {
      this.speaking = false;
      // The prospect's window to answer starts now.
      //
      // Inbound frames carry no speech while we are talking — they are the
      // prospect politely listening — so the silence counter climbs through
      // every turn we take. Left alone, a turn longer than the dead-line
      // threshold means the first frame after we stop instantly trips the
      // timeout, and the call hangs up on someone who was waiting for us to
      // finish. Reset it here rather than at the timeout, so the threshold
      // measures what it claims to: silence *after* a question.
      this.silenceSinceMs = 0;
    }
  }

  /**
   * A deliberate silence — used after a price, per the coaching loop.
   *
   * Frames are written immediately rather than paced with a timer: Twilio
   * buffers and plays them at 20ms each, so the pause happens on the wire, not
   * in this process. Sleeping here would delay the NEXT turn as well.
   */
  private pause(ms: number): void {
    for (const frame of silenceFrames(ms)) {
      if (this.abortSpeech) return;
      this.send({
        event: 'media',
        streamSid: this.streamSid,
        media: { payload: frame.toString('base64') },
      });
    }
  }

  // ── Turn taking ────────────────────────────────────────────────────────────

  private async onProspectUtterance(text: string): Promise<void> {
    if (this.closed || !text.trim()) return;

    this.transcript.push({ speaker: 'PROSPECT', text, atMs: Date.now() - this.startedAt });
    this.history.push({ role: 'user', content: text });

    // Interrupts run on the raw transcript, before the model is invoked at all.
    // Nothing the model or the prospect says can route around this.
    const interrupt = detectInterrupt({
      utterance: text,
      elapsedSeconds: (Date.now() - this.startedAt) / 1000,
      silentSeconds: this.silenceSinceMs / 1000,
    });
    if (interrupt) {
      await this.handleInterrupt(interrupt);
      return;
    }

    await this.takeTurn();
  }

  /**
   * Handle an interrupt exactly once per call.
   *
   * The latch is load-bearing, not defensive. `onMedia` evaluates the silence
   * timeout on every inbound frame — fifty a second — and each branch below
   * awaits a full synthesis before it reaches `finish()`. Without the latch the
   * first frame past the threshold starts a handler, the next forty-nine start
   * forty-nine more, and the prospect hears the goodbye line overlapping itself
   * while `onDncRequested` fires fifty times. `finish()` being idempotent does
   * not help: the damage is all done before anything calls it.
   */
  private async handleInterrupt(
    interrupt: ReturnType<typeof detectInterrupt> & object,
  ): Promise<void> {
    if (this.interrupted || this.closed) return;
    this.interrupted = true;

    this.state = interruptTransition(interrupt);

    switch (interrupt.kind) {
      case 'DNC_REQUESTED':
        // Honoured in-turn, not within the 10 business days the law allows.
        await this.deps.onDncRequested(this.deps.authorization.phoneE164);
        await this.speak(
          "Absolutely — I'm taking you off our list right now. Sorry to bother you.",
          { interruptible: false },
        );
        break;
      case 'HUMAN_REQUESTED':
        await this.speak('Of course — let me get you to a licensed agent.', {
          interruptible: false,
        });
        await this.deps.onTransferRequested();
        break;
      case 'RECORDING_DECLINED':
        // Not an apology for having recorded — the announcement came first and
        // they are answering it. Just stop, and leave the door open.
        await this.speak(
          "That's completely fine — I'll end the call here. If you'd like to talk " +
            'without a recording, call our office any time and a licensed agent will help.',
          { interruptible: false },
        );
        break;
      case 'WRONG_PARTY':
        await this.speak("Sorry about that — I'll update our records. Have a good one.", {
          interruptible: false,
        });
        break;
      case 'MAX_DURATION':
      case 'SILENCE_TIMEOUT':
        await this.speak("Looks like we got disconnected. I'll follow up another time.", {
          interruptible: false,
        });
        break;
    }

    await this.finish();
  }

  private buildTurnContext(): TurnContext {
    const required = REQUIRED_DISCOVERY[this.deps.line] ?? [];
    return {
      state: this.state,
      stateInstructions: STATE_INSTRUCTIONS[this.state] ?? '',
      line: this.deps.line,
      agencyName: this.deps.agencyName,
      producerName: this.deps.producerName,
      contactSummary: this.deps.contactSummary,
      discoverySoFar: [...this.discovery.entries()].map(([k, v]) => `${k}: ${v}`).join('\n'),
      missingFields: required.filter((f) => !this.discovery.has(f)),
      history: this.history,
    };
  }

  /**
   * Generate and speak one turn, pipelined: each sentence is synthesized as
   * soon as the model finishes writing it, rather than after the whole turn.
   */
  private async takeTurn(attempt = 1): Promise<void> {
    // `stopped()` rather than `closed` alone: TRANSFERRING and CLOSING_OUT are
    // not terminal states, so an interrupt that routed there would otherwise
    // still get a model turn — and on a transfer that means ringing the
    // producer twice for one call.
    if (this.stopped() || TERMINAL_STATES.has(this.state)) return;

    const spokenThisTurn: string[] = [];
    try {
      for await (const chunk of streamTurn(this.buildTurnContext(), {
        ...(this.deps.anthropic ? { client: this.deps.anthropic } : {}),
      })) {
        if (this.abortSpeech) break;
        await this.speak(chunk.text);
        spokenThisTurn.push(chunk.text);

        // Hold the silence after a price. The single most coachable behaviour
        // in insurance sales, and free to implement here.
        if (this.state === 'PRESENTING_QUOTE' && /\d/.test(chunk.text)) {
          this.pause(900);
        }
      }
    } catch (err) {
      if (err instanceof GuardrailViolationError && attempt === 1) {
        console.warn('[media] guardrail violation, regenerating:', err.violations);
        await this.takeTurn(2);
        return;
      }
      console.error('[media] generation failed, falling back', err);
      await this.speak(SAFE_FALLBACK_LINE, { interruptible: false });
      await this.deps.onTransferRequested();
      await this.finish();
      return;
    }

    if (spokenThisTurn.length > 0) {
      this.history.push({ role: 'assistant', content: spokenThisTurn.join(' ') });
    }
  }

  private advance(signal: Signal): void {
    try {
      this.state = transition(this.state, signal);
      this.signals.push(signal);
    } catch {
      // An invalid transition is a bug, not a call-ending event. Log and hold
      // state rather than dropping a live call on the floor.
      console.warn(`[media] invalid transition ${this.state} on ${signal}`);
    }
  }

  private async finish(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    this.stt?.close();
    if (this.ws.readyState === this.ws.OPEN) this.ws.close();

    await this.deps.onComplete({
      disposition: dispositionFor(this.state, this.signals),
      finalState: this.state,
      transcript: this.transcript,
      aiDisclosedAt: this.aiDisclosedAt,
      durationMs: Date.now() - this.startedAt,
    });
  }
}

const STATE_INSTRUCTIONS: Readonly<Record<ConversationState, string>> = {
  DISCLOSING: '',
  VERIFYING_IDENTITY:
    'Confirm you are speaking to the right person. One question. If it is not them, do not describe why you called — say you will update your records and end politely.',
  STATING_PURPOSE:
    'One sentence on why you called, then ask permission to continue. Reference the specific thing that made this call relevant.',
  DISCOVERY:
    'Collect the fields listed under STILL NEEDED. Conversationally, one at a time. If they volunteer something out of order, take it and move on.',
  PRESENTING_QUOTE:
    'Read back exactly what the carrier returned. Say the number, then stop. Never present more than three options out loud.',
  HANDLING_OBJECTION:
    'Acknowledge, ask one question that gets at what is actually behind it, then stop. Two attempts maximum on the same objection.',
  CLOSING:
    'Offer two specific times, not "when works for you". If they decline both, ask permission to follow up by email and get the address.',
  TRANSFERRING: 'Tell them you are connecting them now. One sentence.',
  HONORING_DNC: 'One sentence confirming they are removed. Then stop.',
  CLOSING_OUT: 'Close politely in one sentence.',
  ENDED: '',
};

// ── Server ───────────────────────────────────────────────────────────────────

export interface MediaServerOptions {
  readonly port: number;
  readonly webhookSecret: string;
  /** Resolve per-call dependencies from the callRecordId in the stream URL. */
  readonly resolveCall: (callRecordId: string) => Promise<CallSessionDeps | null>;
}

export function startMediaServer(options: MediaServerOptions): WebSocketServer {
  const wss = new WebSocketServer({ port: options.port, path: '/media' });

  wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
    const url = new URL(request.url ?? '/', 'http://localhost');

    // Same two-factor check as the HTTP webhooks: a media stream that anyone
    // can open is a media stream anyone can put audio into.
    if (!secretMatches(url.searchParams.get('s'), options.webhookSecret)) {
      ws.close(1008, 'unauthorized');
      return;
    }

    const callRecordId = url.searchParams.get('call');
    if (!callRecordId) {
      ws.close(1008, 'missing call id');
      return;
    }

    void options
      .resolveCall(callRecordId)
      .then((deps) => {
        if (!deps) {
          ws.close(1008, 'unknown call');
          return;
        }
        new CallSession(ws, deps).attach();
      })
      .catch((err: unknown) => {
        console.error('[media] failed to resolve call', err);
        ws.close(1011, 'resolve failed');
      });
  });

  console.log(`[media] listening on :${options.port}/media`);
  return wss;
}
