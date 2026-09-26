/** Delivery events from Resend (Svix-signed). Unsigned or stale requests are refused. */

import { NextResponse } from 'next/server';
import { db } from '@/allset/db/client';
import { resendWebhookSecret } from '@/allset/env';
import { NO_STORE } from '@/allset/http';
import { applyDeliveryEvent, verifySvixSignature } from '@/allset/notifications/webhook';
import { log } from '@/allset/log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const secret = resendWebhookSecret();
  if (!secret) return NextResponse.json({ error: 'not configured' }, { status: 503, headers: NO_STORE });

  const payload = await request.text();
  if (payload.length > 64_000) return NextResponse.json({ error: 'too large' }, { status: 413, headers: NO_STORE });

  const valid = verifySvixSignature(
    secret,
    {
      id: request.headers.get('svix-id'),
      timestamp: request.headers.get('svix-timestamp'),
      signature: request.headers.get('svix-signature'),
    },
    payload,
  );
  if (!valid) return NextResponse.json({ error: 'invalid signature' }, { status: 401, headers: NO_STORE });

  try {
    const outcome = await applyDeliveryEvent(db(), JSON.parse(payload) as Parameters<typeof applyDeliveryEvent>[1]);
    log.info('webhook.resend', { outcome });
    return NextResponse.json({ ok: true, outcome }, { headers: NO_STORE });
  } catch (error) {
    log.error('webhook.resend_failed', error);
    return NextResponse.json({ error: 'failed' }, { status: 500, headers: NO_STORE });
  }
}
