/**
 * Audio primitives for the phone leg.
 *
 * Twilio media streams carry 8kHz mono G.711 μ-law in 20ms frames — 160 bytes
 * per frame, base64 encoded, one frame per WebSocket message. Fish Audio hands
 * us signed 16-bit PCM at 8kHz. So the one conversion that matters is
 * PCM16 → μ-law, and it runs on every frame of every call, which is why it is a
 * table lookup rather than the textbook branchy implementation.
 */

/** Twilio media stream frame geometry. */
export const SAMPLE_RATE_HZ = 8000;
export const FRAME_MS = 20;
export const SAMPLES_PER_FRAME = (SAMPLE_RATE_HZ * FRAME_MS) / 1000; // 160
export const BYTES_PER_MULAW_FRAME = SAMPLES_PER_FRAME; // μ-law is 1 byte/sample

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

/**
 * Encode one PCM16 sample to μ-law. Standard G.711 with the usual bias/clip.
 * Kept as a function so the table below can be built from it once at load.
 */
function encodeSampleToMulaw(sample: number): number {
  let s = Math.max(-MULAW_CLIP, Math.min(MULAW_CLIP, sample));
  const sign = s < 0 ? 0x80 : 0x00;
  if (s < 0) s = -s;
  s += MULAW_BIAS;

  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; exponent--, mask >>= 1) {
    /* find the highest set bit */
  }
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/**
 * Precomputed PCM16 → μ-law table, indexed by (sample + 32768).
 * 64KB of memory to remove a per-sample branch loop from the hot path; at 8000
 * samples/second/call across concurrent calls, this is worth it.
 */
const PCM_TO_MULAW: Uint8Array = (() => {
  const table = new Uint8Array(65536);
  for (let i = 0; i < 65536; i++) {
    table[i] = encodeSampleToMulaw(i - 32768);
  }
  return table;
})();

const MULAW_TO_PCM: Int16Array = (() => {
  const table = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    const inverted = ~i & 0xff;
    const sign = inverted & 0x80;
    const exponent = (inverted >> 4) & 0x07;
    const mantissa = inverted & 0x0f;
    let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
    sample -= MULAW_BIAS;
    table[i] = sign ? -sample : sample;
  }
  return table;
})();

/**
 * Audio buffers cross `subarray`, `concat`, and socket boundaries, all of which
 * widen `Buffer<ArrayBuffer>` to `Buffer<ArrayBufferLike>` under Node 22 typings.
 * One alias keeps every signature in the pipeline compatible instead of
 * scattering casts at each hop.
 */
export type AudioBuffer = Buffer<ArrayBufferLike>;

/** Little-endian signed 16-bit PCM → μ-law. */
export function pcm16ToMulaw(pcm: AudioBuffer): AudioBuffer {
  const sampleCount = pcm.length >> 1;
  const out = Buffer.allocUnsafe(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    out[i] = PCM_TO_MULAW[pcm.readInt16LE(i * 2) + 32768] ?? 0xff;
  }
  return out;
}

export function mulawToPcm16(mulaw: AudioBuffer): AudioBuffer {
  const out = Buffer.allocUnsafe(mulaw.length * 2);
  for (let i = 0; i < mulaw.length; i++) {
    out.writeInt16LE(MULAW_TO_PCM[mulaw[i] ?? 0xff] ?? 0, i * 2);
  }
  return out;
}

/**
 * Split a μ-law buffer into exactly-sized 20ms frames.
 *
 * Twilio tolerates odd frame sizes but paces playback by frame, so ragged
 * frames produce audible jitter. The remainder is returned rather than padded
 * with silence: padding every chunk boundary inserts a click on each sentence,
 * which across a call sounds like a bad line. The caller carries it forward.
 */
export function chunkIntoFrames(
  mulaw: AudioBuffer,
  carry: AudioBuffer = Buffer.alloc(0),
): { readonly frames: readonly AudioBuffer[]; readonly remainder: AudioBuffer } {
  const joined = carry.length > 0 ? Buffer.concat([carry, mulaw]) : mulaw;
  const frameCount = Math.floor(joined.length / BYTES_PER_MULAW_FRAME);
  const frames: AudioBuffer[] = [];

  for (let i = 0; i < frameCount; i++) {
    frames.push(joined.subarray(i * BYTES_PER_MULAW_FRAME, (i + 1) * BYTES_PER_MULAW_FRAME));
  }

  return { frames, remainder: joined.subarray(frameCount * BYTES_PER_MULAW_FRAME) };
}

/**
 * RMS energy of a μ-law frame, normalized to roughly 0..1.
 *
 * Used for barge-in detection. This is a crude voice-activity proxy — it
 * cannot tell speech from a slammed door — and that is an acceptable trade:
 * the cost of a false positive is that Danny stops talking when it did not
 * need to, which is exactly what a polite person does when they hear a noise.
 * The cost of a false negative is talking over someone, which is not.
 */
export function frameEnergy(mulawFrame: AudioBuffer): number {
  if (mulawFrame.length === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < mulawFrame.length; i++) {
    const sample = MULAW_TO_PCM[mulawFrame[i] ?? 0xff] ?? 0;
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / mulawFrame.length) / 32768;
}

/** Energy above which we treat a frame as speech. Tuned for phone-band noise. */
export const BARGE_IN_ENERGY_THRESHOLD = 0.045;

/**
 * Consecutive above-threshold frames before we call it real speech.
 * Three frames is 60ms — long enough to reject a click, short enough that the
 * interruption still feels immediate.
 */
export const BARGE_IN_FRAME_COUNT = 3;

/**
 * Tracks whether the far end has started talking over us.
 *
 * Deliberately stateful and deliberately trivial: the hard part of barge-in is
 * not detection, it is what you do with the audio you already sent (see
 * `media-server.ts` and the `mark` bookkeeping).
 */
export class BargeInDetector {
  private consecutive = 0;

  constructor(
    private readonly threshold: number = BARGE_IN_ENERGY_THRESHOLD,
    private readonly requiredFrames: number = BARGE_IN_FRAME_COUNT,
  ) {}

  /** Returns true on the frame where an interruption becomes confirmed. */
  observe(frame: AudioBuffer): boolean {
    if (frameEnergy(frame) >= this.threshold) {
      this.consecutive++;
      if (this.consecutive === this.requiredFrames) return true;
    } else {
      this.consecutive = 0;
    }
    return false;
  }

  reset(): void {
    this.consecutive = 0;
  }
}

/** Silence, for padding a deliberate pause after a price. */
export function silenceFrames(durationMs: number): AudioBuffer[] {
  const count = Math.round(durationMs / FRAME_MS);
  // 0xFF is μ-law silence, not 0x00.
  const frame = Buffer.alloc(BYTES_PER_MULAW_FRAME, 0xff);
  return Array.from({ length: count }, () => frame);
}
