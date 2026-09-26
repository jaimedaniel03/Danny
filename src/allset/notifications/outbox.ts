/**
 * The notification outbox.
 *
 * A new inquiry writes one `pending` row per confirmed recipient inside the
 * same transaction that saves the lead, so an alert can never be lost between
 * "saved" and "sent". Delivery runs afterwards (right after the response, and
 * again from a scheduled job), claims rows with SKIP LOCKED so two workers
 * never send the same alert, and records exactly what happened:
 *
 *   pending → sending → sent (provider accepted) → delivered | bounced
 *                     ↘ pending again (retryable, with backoff)
 *                     ↘ failed (gave up, or not retryable)
 *
 * Staff see every failure in the admin, with its reason, and can retry.
 */

import 'server-only';
import type { Sql, TransactionSql } from '@/allset/db/client';
import { publicBaseUrl } from '@/allset/env';
import { randomToken, sha256Hex } from '@/allset/crypto';
import { log } from '@/allset/log';
import { recordAudit } from '@/allset/audit';
import { DeliveryError, emailTransport, type OutgoingEmail } from './transport';

/** Minutes to wait before attempt n+1, indexed by attempts already made. */
const BACKOFF_MINUTES = [1, 5, 30, 120] as const;
export const MAX_ATTEMPTS = BACKOFF_MINUTES.length + 1;
/** A row stuck in `sending` this long belongs to a worker that died. */
const STALE_SENDING_MINUTES = 10;
export const CONFIRMATION_TTL_HOURS = 72;

/** Beyond this many new-inquiry alerts an hour, stop emailing: a flood of submissions must not flood inboxes or burn the email quota. Leads still save. */
export const ALERTS_PER_HOUR_CAP = 60;

export async function enqueueLeadAlerts(
  tx: TransactionSql,
  leadId: string,
  reference: string,
): Promise<number> {
  const [recent] = await tx<{ n: number }[]>`
    select count(*)::int as n from allset.notifications
    where kind = 'lead_received' and created_at > now() - interval '1 hour'`;
  if ((recent?.n ?? 0) >= ALERTS_PER_HOUR_CAP) {
    await recordAudit(tx, { actor: null, action: 'alerts.throttled', entityType: 'lead', entityId: leadId, entityRef: reference, details: { cap: ALERTS_PER_HOUR_CAP } });
    return 0;
  }
  const rows = await tx`
    insert into allset.notifications (kind, lead_id, recipient_id, subject_ref)
    select 'lead_received', ${leadId}, r.id, ${reference}
    from allset.notification_recipients r
    where r.confirmed_at is not null and r.disabled_at is null
    returning id`;
  return rows.length;
}

/** Owner action: one test alert per confirmed recipient, to prove delivery end to end. */
export async function enqueueTestAlerts(sql: Sql, actor: { id: string; label: string }): Promise<number> {
  return sql.begin(async (tx) => {
    const rows = await tx`
      insert into allset.notifications (kind, recipient_id)
      select 'test_alert', r.id from allset.notification_recipients r
      where r.confirmed_at is not null and r.disabled_at is null
      returning id`;
    await recordAudit(tx, { actor, action: 'alerts.test_sent', entityType: 'notification', details: { recipients: rows.length } });
    return rows.length;
  });
}

export async function enqueueRecipientConfirmation(sql: Sql | TransactionSql, recipientId: string): Promise<void> {
  await sql`
    insert into allset.notifications (kind, recipient_id)
    values ('recipient_confirmation', ${recipientId})`;
}

interface ClaimedRow {
  readonly id: string;
  readonly kind: 'lead_received' | 'recipient_confirmation' | 'test_alert';
  readonly attempts: number;
  readonly lead_id: string | null;
  readonly subject_ref: string | null;
  readonly recipient_id: string;
  readonly recipient_email: string;
  readonly recipient_disabled: boolean;
  readonly recipient_confirmed: boolean;
  readonly lead_kind: string | null;
}

function base(): string {
  return publicBaseUrl() ?? 'http://localhost:3000';
}

async function compose(sql: Sql, row: ClaimedRow): Promise<OutgoingEmail> {
  if (row.kind === 'recipient_confirmation') {
    // The token is minted at send time and only its hash is stored, so a
    // database read can never produce a working confirmation link.
    const token = randomToken();
    await sql`
      update allset.notification_recipients
      set confirm_token_hash = ${sha256Hex(token)},
          confirm_expires_at = now() + make_interval(hours => ${CONFIRMATION_TTL_HOURS})
      where id = ${row.recipient_id}`;
    return {
      to: row.recipient_email,
      subject: 'Confirm All Set Check lead alerts',
      text: [
        'Someone on the All Set Check team added this address to receive an email when a new inquiry arrives.',
        '',
        `To start receiving alerts, confirm within ${CONFIRMATION_TTL_HOURS} hours:`,
        `${base()}/admin/confirm-alert#token=${encodeURIComponent(token)}`,
        '',
        'If you did not expect this, ignore it and no alerts will be sent.',
      ].join('\n'),
      idempotencyKey: `${row.id}:${row.attempts}`,
    };
  }

  if (row.kind === 'test_alert') {
    return {
      to: row.recipient_email,
      subject: 'Test alert from the All Set Check lead desk',
      text: [
        'This is a test. If you are reading it, new-inquiry alerts reach this address.',
        '',
        `Lead desk: ${base()}/admin`,
      ].join('\n'),
      idempotencyKey: row.id,
    };
  }

  const kindLabel = row.lead_kind === 'team' ? 'team' : 'coverage';
  return {
    to: row.recipient_email,
    subject: `New ${kindLabel} inquiry · ${row.subject_ref ?? ''}`.trim(),
    text: [
      `A new ${kindLabel} inquiry arrived. Reference: ${row.subject_ref ?? 'unknown'}.`,
      '',
      'Open it in the lead desk (sign-in required):',
      `${base()}/admin/leads/${row.lead_id ?? ''}`,
      '',
      'This email intentionally contains no personal details.',
    ].join('\n'),
    idempotencyKey: row.id,
  };
}

async function claim(sql: Sql, limit: number): Promise<ClaimedRow[]> {
  return sql<ClaimedRow[]>`
    with due as (
      select n.id
      from allset.notifications n
      where (n.status = 'pending' and n.next_attempt_at <= now())
         or (n.status = 'sending' and n.updated_at < now() - make_interval(mins => ${STALE_SENDING_MINUTES}))
      order by n.next_attempt_at
      limit ${limit}
      for update skip locked
    )
    update allset.notifications n
    set status = 'sending', attempts = n.attempts + 1, updated_at = now()
    from due, allset.notification_recipients r
    where n.id = due.id and r.id = n.recipient_id
    returning
      n.id, n.kind, n.attempts, n.lead_id, n.subject_ref, n.recipient_id,
      r.email as recipient_email,
      (r.disabled_at is not null) as recipient_disabled,
      (r.confirmed_at is not null) as recipient_confirmed,
      (select kind from allset.leads where id = n.lead_id) as lead_kind`;
}

async function markSent(sql: Sql, id: string, providerId: string): Promise<void> {
  await sql`
    update allset.notifications
    set status = 'sent', provider_message_id = ${providerId}, sent_at = now(), last_error = null, updated_at = now()
    where id = ${id}`;
}

async function markFailure(sql: Sql, row: ClaimedRow, reason: string, retryable: boolean): Promise<void> {
  const giveUp = !retryable || row.attempts >= MAX_ATTEMPTS;
  const waitMinutes = BACKOFF_MINUTES[Math.min(row.attempts - 1, BACKOFF_MINUTES.length - 1)] ?? 120;
  await sql`
    update allset.notifications
    set status = ${giveUp ? 'failed' : 'pending'},
        last_error = ${reason.slice(0, 300)},
        next_attempt_at = now() + make_interval(mins => ${giveUp ? 0 : waitMinutes}),
        updated_at = now()
    where id = ${row.id}`;
}

export interface DeliveryReport {
  readonly attempted: number;
  readonly sent: number;
  readonly failed: number;
  readonly retrying: number;
}

export async function deliverPending(sql: Sql, limit = 20): Promise<DeliveryReport> {
  const rows = await claim(sql, limit);
  const transport = emailTransport();
  let sent = 0;
  let failed = 0;
  let retrying = 0;

  for (const row of rows) {
    if (row.recipient_disabled) {
      await markFailure(sql, row, 'Recipient was removed before this alert was sent.', false);
      failed += 1;
      continue;
    }
    if ((row.kind === 'lead_received' || row.kind === 'test_alert') && !row.recipient_confirmed) {
      await markFailure(sql, row, 'Recipient is not confirmed.', false);
      failed += 1;
      continue;
    }
    if (row.kind === 'lead_received' && row.lead_id === null) {
      await markFailure(sql, row, 'The lead was deleted before this alert was sent.', false);
      failed += 1;
      continue;
    }

    try {
      const email = await compose(sql, row);
      const { providerId } = await transport.send(email);
      await markSent(sql, row.id, providerId);
      sent += 1;
    } catch (error) {
      const reason = error instanceof DeliveryError ? error.reason : 'Unexpected error while sending.';
      const retryable = error instanceof DeliveryError ? error.retryable : true;
      await markFailure(sql, row, reason, retryable);
      if (!retryable || row.attempts >= MAX_ATTEMPTS) failed += 1;
      else retrying += 1;
      log.warn('notification.send_failed', { notification_id: row.id, kind: row.kind, attempts: row.attempts, retryable });
    }
  }

  return { attempted: rows.length, sent, failed, retrying };
}

/** Owner action: put failed alerts back in the queue now. */
export async function retryFailed(sql: Sql, ids?: readonly string[]): Promise<number> {
  const rows = ids
    ? await sql`
        update allset.notifications
        set status = 'pending', attempts = 0, next_attempt_at = now(), updated_at = now()
        where status = 'failed' and id = any(${ids as string[]}::uuid[])
        returning id`
    : await sql`
        update allset.notifications
        set status = 'pending', attempts = 0, next_attempt_at = now(), updated_at = now()
        where status = 'failed'
        returning id`;
  return rows.length;
}

export interface NotificationHealth {
  readonly confirmedRecipients: number;
  readonly pending: number;
  readonly failed: number;
  readonly lastFailureReason: string | null;
}

export async function notificationHealth(sql: Sql): Promise<NotificationHealth> {
  const [row] = await sql<
    { confirmed: number; pending: number; failed: number; last_error: string | null }[]
  >`
    select
      (select count(*)::int from allset.notification_recipients where confirmed_at is not null and disabled_at is null) as confirmed,
      (select count(*)::int from allset.notifications where status in ('pending', 'sending')) as pending,
      (select count(*)::int from allset.notifications where status in ('failed', 'bounced')) as failed,
      (select last_error from allset.notifications where status in ('failed', 'bounced') order by updated_at desc limit 1) as last_error`;
  return {
    confirmedRecipients: row?.confirmed ?? 0,
    pending: row?.pending ?? 0,
    failed: row?.failed ?? 0,
    lastFailureReason: row?.last_error ?? null,
  };
}
