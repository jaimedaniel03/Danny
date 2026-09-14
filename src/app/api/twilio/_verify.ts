/**
 * Shared Twilio webhook verification.
 *
 * Every Twilio route does the same three things before trusting a request:
 * parse the form body, check the signature and the shared secret, and turn a
 * failure into a 403 rather than an exception. Duplicating that across five
 * routes is how one of them ends up missing the check.
 *
 * Leading underscore keeps this out of Next's route scan — `_verify` is not a
 * route segment.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { loadTwilioConfig, validateWebhook, type TwilioConfig } from '@/telephony/twilio';

export interface VerifiedWebhook {
  readonly params: Record<string, string>;
  readonly config: TwilioConfig;
}

export type VerifyResult =
  | { readonly ok: true; readonly webhook: VerifiedWebhook }
  | { readonly ok: false; readonly response: NextResponse };

export async function verifyTwilioRequest(request: NextRequest): Promise<VerifyResult> {
  let config: TwilioConfig;
  try {
    config = loadTwilioConfig();
  } catch (err) {
    console.error('[twilio] configuration error', err);
    return { ok: false, response: new NextResponse('not configured', { status: 500 }) };
  }

  let params: Record<string, string>;
  try {
    const form = await request.formData();
    params = {};
    for (const [key, value] of form.entries()) {
      if (typeof value === 'string') params[key] = value;
    }
  } catch {
    return { ok: false, response: new NextResponse('bad request', { status: 400 }) };
  }

  const check = validateWebhook({
    signature: request.headers.get('x-twilio-signature'),
    url: request.url,
    params,
    config,
  });

  if (!check.valid) {
    // Do not echo the reason to the caller — an unauthenticated client learning
    // which of the two checks failed is a probing oracle.
    console.warn('[twilio] rejected webhook:', check.reason, new URL(request.url).pathname);
    return { ok: false, response: new NextResponse('unauthorized', { status: 403 }) };
  }

  return { ok: true, webhook: { params, config } };
}

export function twimlResponse(body: string): NextResponse {
  return new NextResponse(body, { status: 200, headers: { 'Content-Type': 'text/xml' } });
}

/**
 * Twilio retries any non-2xx. For status callbacks that is pure noise — the
 * event has already happened and a retry cannot change it — so handlers
 * acknowledge even when their own bookkeeping failed, and log instead.
 */
export function acknowledged(): NextResponse {
  return new NextResponse(null, { status: 204 });
}
