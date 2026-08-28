/**
 * Streaming speech-to-text (Deepgram).
 *
 * Two settings carry most of the quality here, and both are easy to get wrong:
 *
 *  - **Feed μ-law directly.** Deepgram accepts `encoding=mulaw&sample_rate=8000`,
 *    so the Twilio payload goes straight in with no conversion. Decoding to PCM
 *    first costs CPU on every frame of every call and buys nothing.
 *  - **Endpointing is context-dependent, not a constant.** People pause *inside*
 *    phone numbers, addresses, and dollar amounts — which is most of what an
 *    insurance call consists of. A flat 250ms endpoint cuts them off mid-digit;
 *    a flat 500ms makes every turn feel sluggish. `endpointingForState` below
 *    is the compromise, driven by the conversation state.
 */

import { createClient, LiveTranscriptionEvents, type ListenLiveClient } from '@deepgram/sdk';
import type { TranscriptionSession } from '@/telephony/media-server';
import type { AudioBuffer } from '@/voice/audio';
import type { ConversationState } from '@/agent/state-machine';

export const DEFAULT_STT_MODEL = 'nova-3';

/**
 * Deepgram's socket accepts an ArrayBuffer. A Node Buffer is a view into a
 * possibly-larger pool, so hand over exactly this frame's bytes — passing the
 * whole backing store would ship neighbouring frames' audio with every send.
 */
function toSocketPayload(buf: AudioBuffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/**
 * Endpointing (silence before an utterance is considered final), in ms.
 * See docs/03-VOICE-PIPELINE.md for why these differ.
 */
export function endpointingForState(state: ConversationState): number {
  switch (state) {
    // People pause inside numbers. Cutting off "four one five ... five five
    // five" mid-string is the most common cause of a re-ask.
    case 'DISCOVERY':
      return 500;
    // Interrupting an objection is fatal. Let them finish.
    case 'HANDLING_OBJECTION':
      return 350;
    // After a price, silence is the product. Do not rush it.
    case 'PRESENTING_QUOTE':
      return 900;
    default:
      return 250;
  }
}

export interface SttOptions {
  readonly apiKey?: string;
  readonly model?: string;
  readonly endpointingMs?: number;
  /** Redact PII in the returned transcript. Off by default — see below. */
  readonly redact?: readonly string[];
}

/**
 * Open a live transcription session over a Twilio media stream.
 *
 * On redaction: Deepgram can redact PCI and numeric PII server-side. We leave
 * it **off** by default and redact at the storage boundary instead, because an
 * insurance discovery call legitimately needs the numbers the redactor removes
 * — dates of birth, VINs, premiums, coverage limits. Redacting them here would
 * break the product; redacting them in the transcript we retain is the correct
 * layer. If a deployment needs stricter handling, pass `redact` explicitly.
 */
export function createDeepgramSession(options: SttOptions = {}): TranscriptionSession {
  const apiKey = options.apiKey ?? process.env['DEEPGRAM_API_KEY'];
  if (!apiKey) throw new Error('DEEPGRAM_API_KEY is required for transcription.');

  const deepgram = createClient(apiKey);

  const connection: ListenLiveClient = deepgram.listen.live({
    model: options.model ?? process.env['DEEPGRAM_MODEL'] ?? DEFAULT_STT_MODEL,
    language: 'en-US',
    // Match the Twilio media stream exactly — no transcoding on our side.
    encoding: 'mulaw',
    sample_rate: 8000,
    channels: 1,
    // Interim results are what let barge-in fire before the utterance ends.
    interim_results: true,
    // Punctuation matters downstream: the TTS chunker splits on sentence
    // boundaries, and the tonality pipeline needs them too.
    punctuate: true,
    smart_format: true,
    endpointing: options.endpointingMs ?? 250,
    // Fires when the speaker stops, independent of endpointing. Belt and braces
    // against a hung utterance on a noisy line.
    utterance_end_ms: 1000,
    vad_events: true,
    ...(options.redact ? { redact: [...options.redact] } : {}),
  });

  const finalHandlers: ((text: string) => void)[] = [];
  const interimHandlers: ((text: string) => void)[] = [];

  /** Audio arriving before the socket opens would be silently dropped. */
  const preOpenBuffer: AudioBuffer[] = [];
  let open = false;

  connection.on(LiveTranscriptionEvents.Open, () => {
    open = true;
    for (const buf of preOpenBuffer) connection.send(toSocketPayload(buf));
    preOpenBuffer.length = 0;
  });

  connection.on(LiveTranscriptionEvents.Transcript, (data: unknown) => {
    const payload = data as {
      is_final?: boolean;
      speech_final?: boolean;
      channel?: { alternatives?: { transcript?: string }[] };
    };
    const text = payload.channel?.alternatives?.[0]?.transcript?.trim();
    if (!text) return;

    // `speech_final` means Deepgram's endpointer decided the speaker stopped —
    // that is a turn. `is_final` alone only means this segment will not be
    // revised, which happens several times inside one utterance.
    if (payload.speech_final) {
      for (const handler of finalHandlers) handler(text);
    } else {
      for (const handler of interimHandlers) handler(text);
    }
  });

  connection.on(LiveTranscriptionEvents.Error, (err: unknown) => {
    console.error('[stt] deepgram error', err);
  });

  return {
    send(mulaw: AudioBuffer): void {
      if (open) connection.send(toSocketPayload(mulaw));
      // Bound the buffer: ~200 frames is 4 seconds. If the socket has not
      // opened by then, the call has a bigger problem than lost audio.
      else if (preOpenBuffer.length < 200) preOpenBuffer.push(mulaw);
    },
    onFinal(handler): void {
      finalHandlers.push(handler);
    },
    onInterim(handler): void {
      interimHandlers.push(handler);
    },
    close(): void {
      open = false;
      try {
        connection.requestClose();
      } catch {
        /* already closed */
      }
    },
  };
}
