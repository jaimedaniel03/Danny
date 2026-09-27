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

export type WebhookOutcome = 'updated' | 'stale' | 'ignored' | 'duplicate' | 'unknown_message';

/**
 * Where each event may move a row from. Events can arrive twice or out of
 * order, so a later state is never overwritten by an earlier one: a
 * "delayed" that arrives after "delivered" changes nothing.
 */
const TRANSITIONS: Record<string, { readonly to: string; readonly from: readonly string[]; readonly reason: string | null }> = {
  'email.delivery_delayed': { to: 'delayed', from: ['sending', 'sent'], reason: 'The provider accepted the message but delivery is delayed.' },
  'email.delivered': { to: 'delivered', from: ['sending', 'sent', 'delayed'], reason: null },
  'email.bounced': { to: 'bounced', from: ['sending', 'sent', 'delayed'], reason: 'The message bounced; check the recipient address.' },
  'email.failed': { to: 'failed', from: ['sending', 'sent', 'delayed'], reason: 'The provider could not deliver the message.' },
};

class UnknownMessage extends Error {}

/**
 * Apply one verified delivery event exactly once. The event id is recorded in
 * the same transaction as the change; if the message isn't known yet (the
 * webhook beat our own write), nothing is recorded and the caller answers
 * with an error so the provider retries later.
 */
export async function applyDeliveryEvent(sql: Sql, event: ResendEvent, eventId: string): Promise<WebhookOutcome> {
  const type = typeof event.type === 'string' ? event.type.slice(0, 64) : '';
  const messageId = typeof event.data?.email_id === 'string' ? event.data.email_id : null;
  if (!messageId || !eventId) return 'ignored';

  try {
    return await sql.begin(async (tx) => {
      const fresh = await tx`
        insert into allset.webhook_events (event_id, event_type) values (${eventId.slice(0, 100)}, ${type})
        on conflict (event_id) do nothing
        returning event_id`;
      if (fresh.length === 0) return 'duplicate' as const;

      const [row] = await tx<{ id: string; status: string }[]>`
        select id, status from allset.notifications where provider_message_id = ${messageId} for update`;
      if (!row) throw new UnknownMessage();

      if (type === 'email.complained') {
        // It was delivered; the recipient then flagged it. Keep the state, say what happened.
        await tx`
          update allset.notifications
          set last_error = 'The recipient marked this alert as spam.', updated_at = now()
          where id = ${row.id}`;
        return 'updated' as const;
      }
      const transition = TRANSITIONS[type];
      if (!transition) return 'ignored' as const;
      if (!transition.from.includes(row.status)) return 'stale' as const;
      await tx`
        update allset.notifications
        set status = ${transition.to},
            last_error = ${transition.reason},
            delivered_at = ${transition.to === 'delivered' ? tx`now()` : tx`delivered_at`},
            delayed_at = ${transition.to === 'delayed' ? tx`now()` : tx`delayed_at`},
            updated_at = now()
        where id = ${row.id}`;
      return 'updated' as const;
    });
  } catch (error) {
    if (error instanceof UnknownMessage) return 'unknown_message';
    throw error;
  }
}
