/**
 * Small, boring cryptographic helpers. Everything here is node:crypto; no
 * hand-rolled primitives.
 */

import 'server-only';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { appSecret } from '@/allset/env';

/** URL-safe random token. 32 bytes = 256 bits unless told otherwise. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Keyed hash with a purpose label, so a hashed IP in one table can never be
 * matched against a hashed value from another context.
 */
/** A URL-safe secret derived from APP_SECRET: the same input always gives the same token. */
export function hmacToken(purpose: string, value: string): string {
  return createHmac('sha256', appSecret()).update(`${purpose}\u0000${value}`, 'utf8').digest('base64url');
}

export function hmacHex(purpose: string, value: string): string {
  return createHmac('sha256', appSecret()).update(`${purpose}\u0000${value}`, 'utf8').digest('hex');
}

/** Constant-time string comparison that does not leak length. */
export function safeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(left, right);
}

// Crockford base32: no I, L, O or U, so a reference read aloud over the phone
// cannot be misheard as a different one.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Reference shown to a person after they submit, e.g. ASC-7K4M-2QXP. */
export function newReference(): string {
  const bytes = randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i += 1) {
    // 256 is a multiple of 32, so masking is unbiased.
    out += CROCKFORD[bytes[i]! & 31];
    if (i === 3) out += '-';
  }
  return `ASC-${out}`;
}
