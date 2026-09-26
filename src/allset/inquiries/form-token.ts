/**
 * A signed timestamp issued with each rendered form.
 *
 * It lets the server spot submissions that arrive impossibly fast (a script
 * posting the instant a page loads) or that were never rendered by this site
 * at all. It is one signal among several — the honeypot and rate limits do
 * most of the work — and a failed check never discards a person's input: the
 * form comes back with everything filled in and a fresh token.
 */

import 'server-only';
import { hmacHex, safeEqual } from '@/allset/crypto';
import type { InquiryKind } from './consent';

const MIN_AGE_MS = 2_000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function issueFormToken(kind: InquiryKind, now = Date.now()): string {
  const issued = String(now);
  return `${issued}.${hmacHex(`form:${kind}`, issued)}`;
}

export type TokenVerdict = 'ok' | 'too_fast' | 'expired' | 'invalid';

export function checkFormToken(kind: InquiryKind, token: string, now = Date.now()): TokenVerdict {
  const [issued, signature] = token.split('.');
  if (!issued || !signature || !/^\d{10,16}$/.test(issued)) return 'invalid';
  if (!safeEqual(signature, hmacHex(`form:${kind}`, issued))) return 'invalid';
  const age = now - Number(issued);
  if (age < 0) return 'invalid';
  if (age < MIN_AGE_MS) return 'too_fast';
  if (age > MAX_AGE_MS) return 'expired';
  return 'ok';
}
