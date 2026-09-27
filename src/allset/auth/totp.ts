/**
 * Time-based one-time passwords (RFC 6238, HMAC-SHA1, 6 digits, 30-second
 * steps): what every authenticator app speaks. No dependency; it is a dozen
 * lines of HMAC.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const STEP_SECONDS = 30;
const DIGITS = 6;
/** Accept the previous and next step too, for phones whose clocks drift. */
const WINDOW = 1;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Uint8Array {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error('invalid base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/** 160 random bits, the size RFC 4226 recommends. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function currentStep(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000 / STEP_SECONDS);
}

export function totpAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', Buffer.from(base32Decode(secret))).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return binary.toString().padStart(DIGITS, '0');
}

/**
 * The time step a code matches, or null. Steps at or before `lastStep` are
 * refused, so an observed code cannot be replayed.
 */
export function matchTotp(secret: string, code: string, options: { nowMs?: number; lastStep?: number | null } = {}): number | null {
  const given = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(given)) return null;
  const now = currentStep(options.nowMs);
  for (let delta = -WINDOW; delta <= WINDOW; delta += 1) {
    const step = now + delta;
    if (options.lastStep !== null && options.lastStep !== undefined && step <= options.lastStep) continue;
    const expected = Buffer.from(totpAt(secret, step));
    if (timingSafeEqual(expected, Buffer.from(given))) return step;
  }
  return null;
}

/** What an authenticator app scans. */
export function otpauthUri(secret: string, account: string, issuer = 'All Set Check'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}
