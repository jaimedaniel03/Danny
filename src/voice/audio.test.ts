import { describe, expect, it } from 'vitest';
import {
  BargeInDetector,
  BYTES_PER_MULAW_FRAME,
  chunkIntoFrames,
  frameEnergy,
  mulawToPcm16,
  pcm16ToMulaw,
  silenceFrames,
} from './audio';

function pcmFromSamples(samples: readonly number[]): Buffer<ArrayBufferLike> {
  const buf = Buffer.allocUnsafe(samples.length * 2);
  samples.forEach((s, i) => buf.writeInt16LE(s, i * 2));
  return buf;
}

/** A loud sine at 8kHz — stands in for speech. */
function tone(sampleCount: number, amplitude = 12000): Buffer<ArrayBufferLike> {
  const samples = Array.from({ length: sampleCount }, (_, i) =>
    Math.round(amplitude * Math.sin((2 * Math.PI * 300 * i) / 8000)),
  );
  return pcm16ToMulaw(pcmFromSamples(samples));
}

describe('μ-law codec', () => {
  it('round-trips within quantization error', () => {
    const original = [0, 100, -100, 1000, -1000, 8000, -8000, 20000, -20000];
    const decoded = mulawToPcm16(pcm16ToMulaw(pcmFromSamples(original)));

    original.forEach((sample, i) => {
      const got = decoded.readInt16LE(i * 2);
      // μ-law is logarithmic: error grows with amplitude. 8% is well inside spec.
      const tolerance = Math.max(64, Math.abs(sample) * 0.08);
      expect(Math.abs(got - sample)).toBeLessThanOrEqual(tolerance);
    });
  });

  it('produces one byte per sample', () => {
    expect(pcm16ToMulaw(pcmFromSamples([1, 2, 3, 4])).length).toBe(4);
  });

  it('clips rather than wrapping at the extremes', () => {
    const encoded = pcm16ToMulaw(pcmFromSamples([32767, -32768]));
    const decoded = mulawToPcm16(encoded);
    // Sign must survive clipping — a wrap would flip it and sound catastrophic.
    expect(decoded.readInt16LE(0)).toBeGreaterThan(0);
    expect(decoded.readInt16LE(2)).toBeLessThan(0);
  });
});

describe('frame chunking', () => {
  it('emits exact 20ms frames and carries the remainder', () => {
    const input = Buffer.alloc(BYTES_PER_MULAW_FRAME * 2 + 40, 0x7f);
    const { frames, remainder } = chunkIntoFrames(input);

    expect(frames).toHaveLength(2);
    for (const f of frames) expect(f.length).toBe(BYTES_PER_MULAW_FRAME);
    expect(remainder.length).toBe(40);
  });

  it('joins a carried remainder with the next chunk rather than padding', () => {
    const first = chunkIntoFrames(Buffer.alloc(100, 0x7f));
    expect(first.frames).toHaveLength(0);
    expect(first.remainder.length).toBe(100);

    const second = chunkIntoFrames(Buffer.alloc(60, 0x7f), first.remainder);
    expect(second.frames).toHaveLength(1);
    expect(second.remainder.length).toBe(0);
  });

  it('loses no bytes across a sequence of ragged chunks', () => {
    let carry: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let framed = 0;
    const sizes = [37, 211, 5, 160, 99, 400];

    for (const size of sizes) {
      const result = chunkIntoFrames(Buffer.alloc(size, 0x7f), carry);
      framed += result.frames.length * BYTES_PER_MULAW_FRAME;
      carry = result.remainder;
    }

    const total = sizes.reduce((a, b) => a + b, 0);
    expect(framed + carry.length).toBe(total);
  });
});

describe('silence', () => {
  it('uses 0xFF, not 0x00 — 0x00 is loud in μ-law', () => {
    const frames = silenceFrames(100);
    expect(frames).toHaveLength(5);
    expect(frames[0]?.[0]).toBe(0xff);
    expect(frameEnergy(frames[0]!)).toBeLessThan(0.01);
  });
});

describe('barge-in detection', () => {
  const quiet = Buffer.alloc(BYTES_PER_MULAW_FRAME, 0xff);

  it('stays silent on silence', () => {
    const detector = new BargeInDetector();
    for (let i = 0; i < 20; i++) expect(detector.observe(quiet)).toBe(false);
  });

  it('fires only after sustained speech, not a single click', () => {
    const detector = new BargeInDetector();
    const speech = tone(BYTES_PER_MULAW_FRAME);

    // One loud frame is a click, not an interruption.
    expect(detector.observe(speech)).toBe(false);
    expect(detector.observe(quiet)).toBe(false);

    // Three consecutive loud frames (60ms) is someone talking.
    expect(detector.observe(speech)).toBe(false);
    expect(detector.observe(speech)).toBe(false);
    expect(detector.observe(speech)).toBe(true);
  });

  it('fires once per interruption, not on every subsequent frame', () => {
    const detector = new BargeInDetector();
    const speech = tone(BYTES_PER_MULAW_FRAME);

    const fires = Array.from({ length: 10 }, () => detector.observe(speech)).filter(Boolean);
    expect(fires).toHaveLength(1);
  });

  it('re-arms after the far end goes quiet again', () => {
    const detector = new BargeInDetector();
    const speech = tone(BYTES_PER_MULAW_FRAME);

    for (let i = 0; i < 5; i++) detector.observe(speech);
    for (let i = 0; i < 5; i++) detector.observe(quiet);

    detector.observe(speech);
    detector.observe(speech);
    expect(detector.observe(speech)).toBe(true);
  });
});
