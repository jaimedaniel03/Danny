/**
 * Consent link tokens.
 *
 * A consent link is texted or emailed to a lead: "tap here to okay a follow-up
 * call." The token in that URL is the only thing standing between your consent
 * ledger and anyone who can guess a URL, so it is signed rather than random-
 * looking.
 *
 * Design:
 *  - **HMAC-signed, not a database lookup.** The token carries its own payload
 *    (contact id, phone, campaign, expiry) and a signature. No round trip to
 *    validate, and a forged token fails signature verification rather than
 *    hitting a row that happens to exist.
 *  - **The phone number is inside the signed payload.** This is the important
 *    one. Consent attaches to a number; if the number were a form field the
 *    submitter controlled, anyone could consent on behalf of any number. The
 *    form displays it and cannot change it.
 *  - **Short expiry.** 14 days. A consent link found in an old text message two
 *    years later should not still mint consent.
 *  - **Constant-time comparison.** Signature checks use `timingSafeEqual`.
 */

import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

export const TOKEN_TTL_DAYS = 14;

export interface ConsentTokenPayload {
  /** Contact row this consent will attach to. */
  readonly contactId: string;
  /** E.164. Signed, so the form cannot change what is being consented to. */
  readonly phoneE164: string;
  readonly agencyId: string;
  /** Which outreach produced this link — for attribution and revocation sweeps. */
  readonly campaignId: string;
  /** Unix seconds. */
  readonly issuedAt: number;
  readonly expiresAt: number;
  /** Random, so two links for the same contact are distinguishable in logs. */
  readonly nonce: string;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function signingKey(): Buffer {
  const secret = process.env['CONSENT_TOKEN_SECRET'];
  if (!secret || secret.length < 32) {
    throw new Error(
      'CONSENT_TOKEN_SECRET must be set to at least 32 characters. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  return Buffer.from(secret, 'utf-8');
}

function sign(body: string): string {
  return b64url(createHmac('sha256', signingKey()).update(body).digest());
}

export function issueConsentToken(input: {
  readonly contactId: string;
  readonly phoneE164: string;
  readonly agencyId: string;
  readonly campaignId: string;
  readonly now?: Date;
}): string {
  const now = input.now ?? new Date();
  const issuedAt = Math.floor(now.getTime() / 1000);

  const payload: ConsentTokenPayload = {
    contactId: input.contactId,
    phoneE164: input.phoneE164,
    agencyId: input.agencyId,
    campaignId: input.campaignId,
    issuedAt,
    expiresAt: issuedAt + TOKEN_TTL_DAYS * 86_400,
    nonce: randomBytes(9).toString('base64url'),
  };

  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf-8'));
  return `${body}.${sign(body)}`;
}

export type TokenVerdict =
  | { readonly valid: true; readonly payload: ConsentTokenPayload }
  | { readonly valid: false; readonly reason: 'malformed' | 'bad_signature' | 'expired' };

export function verifyConsentToken(token: string, now: Date = new Date()): TokenVerdict {
  const parts = token.split('.');
  if (parts.length !== 2) return { valid: false, reason: 'malformed' };

  const [body, signature] = parts as [string, string];

  const expected = Buffer.from(sign(body), 'utf-8');
  const actual = Buffer.from(signature, 'utf-8');
  // Length check first: timingSafeEqual throws on a length mismatch, and the
  // length of a signature is not a secret.
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { valid: false, reason: 'bad_signature' };
  }

  let payload: ConsentTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8')) as ConsentTokenPayload;
  } catch {
    return { valid: false, reason: 'malformed' };
  }

  if (
    typeof payload.contactId !== 'string' ||
    typeof payload.phoneE164 !== 'string' ||
    typeof payload.expiresAt !== 'number'
  ) {
    return { valid: false, reason: 'malformed' };
  }

  if (Math.floor(now.getTime() / 1000) >= payload.expiresAt) {
    return { valid: false, reason: 'expired' };
  }

  return { valid: true, payload };
}

/** The link you text or email. */
export function consentUrl(token: string, baseUrl?: string): string {
  const base = (baseUrl ?? process.env['PUBLIC_BASE_URL'] ?? '').replace(/\/+$/, '');
  return `${base}/consent/${token}`;
}

/**
 * Mask a number for display: +14155550123 → (415) •••-0123.
 *
 * The consumer needs to recognize the number as theirs; nobody needs the full
 * digits rendered on a page that might be screenshotted or shoulder-surfed.
 */
export function maskPhoneForDisplay(phoneE164: string): string {
  const digits = phoneE164.replace(/\D/g, '');
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (ten.length !== 10) return phoneE164;
  return `(${ten.slice(0, 3)}) •••-${ten.slice(6)}`;
}
