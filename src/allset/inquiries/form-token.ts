/**
 * A signed token issued with each rendered form.
 *
 * It carries the render time and the version of the consent (and, for team
 * inquiries, the acknowledgment) wording that was on the page. That lets the
 * server:
 *   - spot submissions that arrive impossibly fast or were never rendered by
 *     this site (one spam signal among several; the honeypot and rate limits
 *     do most of the work), and
 *   - refuse to record consent to wording the person never saw, if the
 *     wording changed between render and submit.
 * A failed check never discards a person's input: the form comes back filled
 * in with a fresh token.
 */

import 'server-only';
import { hmacHex, safeEqual } from '@/allset/crypto';
import { consentWording, TEAM_DISCLOSURE_ACK, type InquiryKind } from './consent';

const MIN_AGE_MS = 2_000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** The wording versions a form of this kind currently shows. */
export function wordingVersion(kind: InquiryKind): string {
  const consent = consentWording(kind).version;
  return kind === 'team' ? `${consent}+${TEAM_DISCLOSURE_ACK.version}` : consent;
}

export function issueFormToken(kind: InquiryKind, now = Date.now()): string {
  const body = `${now}.${wordingVersion(kind)}`;
  return `${body}.${hmacHex(`form:${kind}`, body)}`;
}

export type TokenVerdict = 'ok' | 'too_fast' | 'expired' | 'invalid' | 'wording_changed';

export function checkFormToken(kind: InquiryKind, token: string, now = Date.now()): TokenVerdict {
  const parts = token.split('.');
  if (parts.length !== 3) return 'invalid';
  const [issued, version, signature] = parts as [string, string, string];
  if (!/^\d{10,16}$/.test(issued) || !version || !signature) return 'invalid';
  if (!safeEqual(signature, hmacHex(`form:${kind}`, `${issued}.${version}`))) return 'invalid';
  const age = now - Number(issued);
  if (age < 0) return 'invalid';
  if (version !== wordingVersion(kind)) return 'wording_changed';
  if (age < MIN_AGE_MS) return 'too_fast';
  if (age > MAX_AGE_MS) return 'expired';
  return 'ok';
}
