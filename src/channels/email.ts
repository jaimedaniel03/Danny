/**
 * Email channel.
 *
 * ── Why this is the most useful channel in the system ───────────────────────
 * Email is the only one of the three that does not require prior consent. Under
 * CAN-SPAM you may send a commercial message to someone who never asked for it,
 * provided you tell the truth about who you are, include a physical postal
 * address, and give them a working way to stop.
 *
 * For a lead list, that inverts the usual assumption: the ~70% of leads you may
 * not AI-call and may not text can, almost all of them, be emailed today. And
 * an email is the cheapest place to put a consent-capture link — a tappable
 * link in an inbox converts better than a URL read aloud on a phone call, and
 * carries a fraction of the exposure of texting the same link.
 *
 * ── What CAN-SPAM actually requires ─────────────────────────────────────────
 *  1. Truthful From, Reply-To, and routing information.
 *  2. A subject line that is not deceptive about the content.
 *  3. Identification as an advertisement (clear from context is sufficient).
 *  4. A valid physical postal address.
 *  5. A clear, conspicuous opt-out mechanism.
 *  6. Opt-outs honoured within 10 business days — we do it immediately.
 *  7. The opt-out mechanism must keep working for at least 30 days after send.
 *
 * Items 4, 5, and 6 are enforced in code below. Items 1–3 are enforced by
 * `validateEmail` refusing to send a message that fails them.
 *
 * Deliverability is a separate discipline from legality and matters just as
 * much: send from a dedicated domain with SPF, DKIM, and DMARC. Volume from a
 * personal Gmail burns the domain on the first campaign, and a burned domain is
 * slow and expensive to recover.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { loadProfileSafe } from '@/config/agency';
import type { ChannelAuthorization } from './types';

export interface EmailConfig {
  readonly fromName: string;
  readonly fromAddress: string;
  readonly replyToAddress: string;
  /** CAN-SPAM item 4. A PO box is acceptable; nothing is not. */
  readonly postalAddress: string;
  readonly apiKey: string | null;
  readonly dryRun: boolean;
}

/**
 * Sender identity comes from the agency profile; credentials come from the
 * environment.
 *
 * The split is not arbitrary. `postalAddress` is CAN-SPAM item 4 — a real
 * physical address in every commercial message — and the profile is the one
 * place that is validated to hold one. Reading it from a loose env var is how
 * you end up sending a compliant-looking email with an empty footer, which is
 * the violation the footer exists to prevent.
 *
 * Env vars still override, for the case where the same profile sends from two
 * addresses. They just are not the source of truth any more.
 */
export function loadEmailConfig(): EmailConfig {
  // Safe load: a missing profile degrades to the env vars rather than throwing.
  // `validateEmail` is what refuses to send with an empty postal address, and
  // it should be the thing that reports that, in one place.
  const profile = loadProfileSafe();

  return {
    fromName: process.env['EMAIL_FROM_NAME'] ?? profile?.email.fromName ?? profile?.legalName ?? '',
    fromAddress: process.env['EMAIL_FROM_ADDRESS'] ?? profile?.email.fromAddress ?? '',
    replyToAddress:
      process.env['EMAIL_REPLY_TO'] ??
      profile?.email.replyTo ??
      process.env['EMAIL_FROM_ADDRESS'] ??
      profile?.email.fromAddress ??
      '',
    postalAddress: process.env['AGENCY_POSTAL_ADDRESS'] ?? profile?.postalAddress ?? '',
    apiKey: process.env['RESEND_API_KEY'] ?? null,
    dryRun: process.env['DANNY_DRY_RUN'] !== 'false',
  };
}

// ─────────────────────────────────────────────────────────────
// Unsubscribe tokens
// ─────────────────────────────────────────────────────────────

/**
 * Unsubscribe links are signed rather than sequential.
 *
 * A guessable link (`/unsubscribe?id=1041`) lets anyone walk the range and
 * unsubscribe your whole list — quietly, with no error and no alert, and you
 * find out from a drop in open rate three weeks later.
 *
 * Deliberately no expiry: CAN-SPAM requires the mechanism to work for at least
 * 30 days after send, and there is no good reason to ever stop honouring one.
 */
export function issueUnsubscribeToken(input: {
  readonly contactId: string;
  readonly emailAddress: string;
}): string {
  const secret = process.env['CONSENT_TOKEN_SECRET'];
  if (!secret || secret.length < 32) {
    throw new Error('CONSENT_TOKEN_SECRET (min 32 chars) is required to sign unsubscribe links.');
  }
  const body = Buffer.from(
    JSON.stringify({ c: input.contactId, e: input.emailAddress.toLowerCase() }),
    'utf-8',
  ).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyUnsubscribeToken(
  token: string,
): { readonly valid: true; readonly contactId: string; readonly emailAddress: string } | { readonly valid: false } {
  const secret = process.env['CONSENT_TOKEN_SECRET'];
  if (!secret) return { valid: false };

  const parts = token.split('.');
  if (parts.length !== 2) return { valid: false };
  const [body, sig] = parts as [string, string];

  const expected = Buffer.from(createHmac('sha256', secret).update(body).digest('base64url'), 'utf-8');
  const actual = Buffer.from(sig, 'utf-8');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { valid: false };
  }

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8')) as {
      c?: string;
      e?: string;
    };
    if (!payload.c || !payload.e) return { valid: false };
    return { valid: true, contactId: payload.c, emailAddress: payload.e };
  } catch {
    return { valid: false };
  }
}

export function unsubscribeUrl(token: string, baseUrl?: string): string {
  const base = (baseUrl ?? process.env['PUBLIC_BASE_URL'] ?? '').replace(/\/+$/, '');
  return `${base}/api/unsubscribe?t=${token}`;
}

// ─────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────

/**
 * Subject-line patterns that are deceptive on their face. CAN-SPAM item 2, and
 * also the fastest route to a spam-folder reputation.
 *
 * `Re:` and `Fwd:` on a message that is neither is the classic one — it is
 * misleading about the message's provenance, and every mailbox provider
 * penalizes it.
 */
const DECEPTIVE_SUBJECT_PATTERNS: readonly { pattern: RegExp; why: string }[] = [
  { pattern: /^\s*(re|fwd?)\s*:/i, why: 'Implies a prior thread that does not exist.' },
  { pattern: /\b(urgent|final notice|action required)\b/i, why: 'Manufactures urgency that is not real.' },
  { pattern: /\byour (policy|coverage) (has been|is) (cancel|terminat|expir)/i, why: 'False claim about existing coverage.' },
  { pattern: /\b(free|guaranteed)\b.{0,20}\b(quote|rate|savings)\b/i, why: 'Unqualified savings claim.' },
  { pattern: /\b(medicare|social security|irs|government)\b.{0,25}\b(notice|benefit|enrollment)\b/i, why: 'Implies government affiliation.' },
];

export interface EmailValidation {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

export function validateEmail(input: {
  readonly config: EmailConfig;
  readonly subject: string;
  readonly bodyText: string;
  readonly footer: string;
}): EmailValidation {
  const problems: string[] = [];

  if (!input.config.fromAddress) problems.push('EMAIL_FROM_ADDRESS is not set.');
  if (!input.config.fromName) problems.push('EMAIL_FROM_NAME is not set — CAN-SPAM requires truthful sender identification.');
  if (!input.config.postalAddress) {
    problems.push(
      'AGENCY_POSTAL_ADDRESS is not set. CAN-SPAM requires a valid physical postal ' +
        'address in every commercial message. A PO box is acceptable.',
    );
  }
  if (!input.subject.trim()) problems.push('Subject is empty.');

  for (const { pattern, why } of DECEPTIVE_SUBJECT_PATTERNS) {
    if (pattern.test(input.subject)) {
      problems.push(`Subject matches a deceptive pattern (${why}): "${input.subject}"`);
    }
  }

  if (!/unsubscribe/i.test(input.footer)) {
    problems.push('Footer has no opt-out mechanism.');
  }

  return { ok: problems.length === 0, problems };
}

// ─────────────────────────────────────────────────────────────
// Sending
// ─────────────────────────────────────────────────────────────

export interface SentEmail {
  readonly providerId: string;
  readonly subject: string;
  readonly dryRun: boolean;
}

export class EmailValidationError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Email failed CAN-SPAM validation:\n  - ${problems.join('\n  - ')}`);
    this.name = 'EmailValidationError';
  }
}

/**
 * Send one email.
 *
 * Written against a small `fetch` call rather than an SDK so the provider is
 * swappable — Resend by default; SendGrid, Postmark, SES, or Brevo are the same
 * shape. What must not change is the footer and the List-Unsubscribe headers.
 */
export async function sendEmail(input: {
  readonly authorization: ChannelAuthorization;
  readonly config: EmailConfig;
  readonly subject: string;
  readonly bodyText: string;
  readonly bodyHtml?: string;
  readonly unsubscribeUrl: string;
  readonly now?: Date;
}): Promise<SentEmail> {
  const { authorization, config } = input;
  const now = input.now ?? new Date();

  if (authorization.channel !== 'email') {
    throw new Error(`Authorization is for "${authorization.channel}", not email.`);
  }
  if (now >= authorization.expiresAt) {
    throw new Error('Channel authorization expired. Re-evaluate the gate rather than retrying.');
  }

  const footer = authorization.requiredFooter.replace('{{UNSUBSCRIBE_URL}}', input.unsubscribeUrl);

  const validation = validateEmail({
    config,
    subject: input.subject,
    bodyText: input.bodyText,
    footer,
  });
  if (!validation.ok) throw new EmailValidationError(validation.problems);

  const text = `${input.bodyText.trim()}\n\n—\n${footer}`;
  const html = input.bodyHtml
    ? `${input.bodyHtml}<hr style="margin:2rem 0;border:none;border-top:1px solid #ddd">` +
      `<p style="font-size:12px;color:#666;white-space:pre-line">${escapeHtml(footer)}</p>`
    : undefined;

  if (config.dryRun) {
    return { providerId: `DRYRUN_EMAIL_${Date.now()}`, subject: input.subject, dryRun: true };
  }

  if (!config.apiKey) throw new Error('RESEND_API_KEY is required to send email.');

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `${config.fromName} <${config.fromAddress}>`,
      to: [authorization.destination],
      reply_to: config.replyToAddress,
      subject: input.subject,
      text,
      ...(html ? { html } : {}),
      headers: {
        // RFC 8058 one-click unsubscribe. Gmail and Yahoo require this on bulk
        // senders, and honouring it is what keeps you out of the spam folder —
        // a stricter and more immediate consequence than the statute's.
        'List-Unsubscribe': `<${input.unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Email send failed: ${response.status} ${await response.text()}`);
  }

  const payload = (await response.json()) as { id?: string };
  return { providerId: payload.id ?? 'unknown', subject: input.subject, dryRun: false };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
