/**
 * Consent capture endpoint.
 *
 * This is the single most important write in the system. Everything the gate
 * later decides rests on the row this handler creates, so it is deliberately
 * paranoid:
 *
 *  - **The phone number comes from the signed token, never the request body.**
 *    A form field the submitter controls would let anyone consent on behalf of
 *    any number. This is the one thing that absolutely cannot be client-supplied.
 *  - **The disclosure text is stored resolved and verbatim**, alongside its
 *    version id — not a template reference. When a version is later found
 *    defective, `where disclosure_version = 'vN'` finds every affected row.
 *  - **IP and user-agent are captured** because E-SIGN attribution is what makes
 *    an electronic signature hold up, and neither is reconstructable later.
 *  - **The affirmative checkbox must be explicitly true.** No default-checked
 *    box, no "by continuing you agree". The FCC requires a clear affirmative act.
 *  - **Writes are idempotent per token.** A double-tap on a phone should not
 *    create two consent rows; the second returns the first.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { verifyConsentToken } from '@/consent/tokens';
import { renderDisclosure } from '@/consent/disclosure-text';

export const runtime = 'nodejs';

const BodySchema = z.object({
  token: z.string().min(1),
  /** Must be literally true. `.literal(true)` rejects false, not just absence. */
  agreed: z.literal(true),
  /** Typed name serves as the E-SIGN signature. */
  signatureName: z.string().trim().min(2).max(120),
  /** Which lines this consent covers. Empty means all. */
  scopedLines: z.array(z.string()).default([]),
  /** Honeypot — a real person never fills this. */
  website: z.string().max(0).optional(),
});

/**
 * Client IP behind a proxy. Trust only the leftmost entry of `x-forwarded-for`
 * *and only* because Vercel/our load balancer rewrites it; a raw origin server
 * must not trust this header at all.
 */
function clientIp(request: NextRequest): string | null {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return request.headers.get('x-real-ip');
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let parsed: z.infer<typeof BodySchema>;
  try {
    parsed = BodySchema.parse(await request.json());
  } catch {
    return NextResponse.json(
      { error: 'Please check the box and enter your name to continue.' },
      { status: 400 },
    );
  }

  // Honeypot. Return the success shape so a bot learns nothing.
  if (parsed.website) {
    return NextResponse.json({ ok: true });
  }

  const verdict = verifyConsentToken(parsed.token);
  if (!verdict.valid) {
    const message =
      verdict.reason === 'expired'
        ? 'This link has expired. Ask us for a new one and we will send it right over.'
        : 'This link is not valid.';
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const { payload } = verdict;

  // Required, not defaulted. Consent naming "Your Agency" names nobody, and a
  // consent record that does not identify the seller is not consent to us.
  const { loadProfileSafe } = await import('@/config/agency');
  const profile = loadProfileSafe();
  if (!profile) {
    console.error('[consent] agency.config.json missing or invalid — refusing to capture consent');
    return NextResponse.json(
      { error: 'We cannot accept this right now. Please call us directly.' },
      { status: 503 },
    );
  }
  const agencyLegalName = profile.legalName;

  let disclosure;
  try {
    disclosure = renderDisclosure({
      agencyLegalName,
      // Rendered from the SIGNED number, so the stored text names the number
      // that was actually consented to.
      phoneDisplay: payload.phoneE164,
    });
  } catch (err) {
    // An unreviewed disclosure version must never silently capture consent.
    console.error('[consent] disclosure render failed', err);
    return NextResponse.json(
      { error: 'We cannot accept this right now. Please call us directly.' },
      { status: 503 },
    );
  }

  const record = {
    agencyId: payload.agencyId,
    contactId: payload.contactId,
    // From the token. Never from the body.
    phoneE164: payload.phoneE164,
    basis: 'prior_express_written' as const,
    disclosureText: disclosure.verbatim,
    disclosureVersion: disclosure.versionId,
    sourceUri: `${process.env['PUBLIC_BASE_URL'] ?? ''}/consent/${parsed.token}`,
    capturedAt: new Date().toISOString(),
    ipAddress: clientIp(request),
    userAgent: request.headers.get('user-agent'),
    scopedLines: parsed.scopedLines,
    evidence: {
      signatureName: parsed.signatureName,
      campaignId: payload.campaignId,
      tokenNonce: payload.nonce,
      tokenIssuedAt: new Date(payload.issuedAt * 1000).toISOString(),
      checkboxLabel: disclosure.checkboxLabel,
      acceptLanguage: request.headers.get('accept-language'),
    },
  };

  try {
    const { recordConsent } = await import('@/db/consents');
    await recordConsent(record);
  } catch (err) {
    console.error('[consent] write failed', err);
    return NextResponse.json(
      { error: 'Something went wrong saving that. Please try again.' },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
