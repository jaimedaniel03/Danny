/**
 * Delivery verification. Resend reports what happened after it accepted a
 * message (delivered, bounced, marked as spam) through signed webhooks
 * (Svix format). We verify the signature, then move the matching outbox row
 * to its final state, so "sent" in the admin never silently means "lost".
 */

import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Sql } from '@/allset/db/client';

const TOLERANCE_SECONDS = 5 * 60;

export function verifySvixSignature(
  secret: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  payload: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > TOLERANCE_SECONDS) return false;

  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${payload}`).digest();

  // The header may carry several space-separated "v1,<base64>" signatures.
  return signature.split(' ').some((part) => {
    const [version, value] = part.split(',');
    if (version !== 'v1' || !value) return false;
    const given = Buffer.from(value, 'base64');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

interface ResendEvent {
  readonly type?: unknown;
  readonly data?: { readonly email_id?: unknown; readonly bounce?: { readonly message?: unknown } };
}

export type WebhookOutcome = 'updated' | 'ignored' | 'unknown_message';

export async function applyDeliveryEvent(sql: Sql, event: ResendEvent): Promise<WebhookOutcome> {
  const type = typeof event.type === 'string' ? event.type : '';
  const messageId = typeof event.data?.email_id === 'string' ? event.data.email_id : null;
  if (!messageId) return 'ignored';

  let rows: readonly unknown[];
  if (type === 'email.delivered') {
    rows = await sql`
      update allset.notifications
      set status = 'delivered', delivered_at = now(), updated_at = now()
      where provider_message_id = ${messageId} and status in ('sent', 'sending')
      returning id`;
  } else if (type === 'email.bounced' || type === 'email.complained' || type === 'email.failed') {
    const reason =
      type === 'email.complained'
        ? 'The recipient marked the alert as spam.'
        : type === 'email.failed'
          ? 'The provider could not deliver the message.'
          : 'The message bounced; check the recipient address.';
    rows = await sql`
      update allset.notifications
      set status = 'bounced', last_error = ${reason}, updated_at = now()
      where provider_message_id = ${messageId}
      returning id`;
  } else {
    return 'ignored';
  }
  return rows.length > 0 ? 'updated' : 'unknown_message';
}
