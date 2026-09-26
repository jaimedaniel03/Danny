/**
 * Who gets an email when an inquiry arrives.
 *
 * An address receives lead alerts only after someone clicks the link sent to
 * it. That proves the address exists and that its owner wants the alerts —
 * a typo in an owner's settings cannot quietly route inquiries elsewhere.
 */

import 'server-only';
import type { Sql } from '@/allset/db/client';
import { sha256Hex } from '@/allset/crypto';
import { recordAudit, type AuditActor } from '@/allset/audit';
import { enqueueRecipientConfirmation } from './outbox';

export interface Recipient {
  readonly id: string;
  readonly email: string;
  readonly confirmedAt: Date | null;
  readonly disabledAt: Date | null;
  readonly createdAt: Date;
  readonly lastStatus: string | null;
  readonly lastError: string | null;
}

export async function listRecipients(sql: Sql): Promise<Recipient[]> {
  return sql<Recipient[]>`
    select r.id, r.email, r.confirmed_at as "confirmedAt", r.disabled_at as "disabledAt", r.created_at as "createdAt",
      (select status from allset.notifications n where n.recipient_id = r.id order by n.created_at desc limit 1) as "lastStatus",
      (select last_error from allset.notifications n where n.recipient_id = r.id and n.last_error is not null order by n.updated_at desc limit 1) as "lastError"
    from allset.notification_recipients r
    order by r.disabled_at nulls first, r.created_at`;
}

export type AddRecipientResult = { ok: true; id: string } | { ok: false; error: string };

export async function addRecipient(sql: Sql, actor: AuditActor, rawEmail: string): Promise<AddRecipientResult> {
  const email = rawEmail.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) {
    return { ok: false, error: 'Enter a valid email address.' };
  }
  return sql.begin(async (tx) => {
    const [existing] = await tx<{ id: string; disabled_at: Date | null }[]>`
      select id, disabled_at from allset.notification_recipients where lower(email) = lower(${email})`;
    let id: string;
    if (existing) {
      if (!existing.disabled_at) return { ok: false as const, error: 'That address is already on the list.' };
      // Re-adding a removed address starts confirmation over.
      await tx`
        update allset.notification_recipients
        set disabled_at = null, confirmed_at = null, confirm_token_hash = null, confirm_expires_at = null, added_by = ${actor.id}
        where id = ${existing.id}`;
      id = existing.id;
    } else {
      const [row] = await tx<{ id: string }[]>`
        insert into allset.notification_recipients (email, added_by) values (${email}, ${actor.id}) returning id`;
      id = row!.id;
    }
    await enqueueRecipientConfirmation(tx, id);
    await recordAudit(tx, { actor, action: 'recipient.added', entityType: 'recipient', entityId: id });
    return { ok: true as const, id };
  });
}

export async function resendConfirmation(sql: Sql, actor: AuditActor, id: string): Promise<boolean> {
  return sql.begin(async (tx) => {
    const [row] = await tx`
      select id from allset.notification_recipients
      where id = ${id} and disabled_at is null and confirmed_at is null`;
    if (!row) return false;
    await enqueueRecipientConfirmation(tx, id);
    await recordAudit(tx, { actor, action: 'recipient.confirmation_resent', entityType: 'recipient', entityId: id });
    return true;
  });
}

export async function removeRecipient(sql: Sql, actor: AuditActor, id: string): Promise<boolean> {
  return sql.begin(async (tx) => {
    const rows = await tx`
      update allset.notification_recipients
      set disabled_at = now(), confirm_token_hash = null, confirm_expires_at = null
      where id = ${id} and disabled_at is null
      returning id`;
    if (rows.length === 0) return false;
    await recordAudit(tx, { actor, action: 'recipient.removed', entityType: 'recipient', entityId: id });
    return true;
  });
}

export type ConfirmResult = 'confirmed' | 'invalid';

/** Public endpoint: the link in the confirmation email. Single use. */
export async function confirmRecipient(sql: Sql, token: string): Promise<ConfirmResult> {
  if (!token || token.length > 200) return 'invalid';
  return sql.begin(async (tx) => {
    const rows = await tx<{ id: string }[]>`
      update allset.notification_recipients
      set confirmed_at = now(), confirm_token_hash = null, confirm_expires_at = null
      where confirm_token_hash = ${sha256Hex(token)}
        and confirm_expires_at > now()
        and disabled_at is null
      returning id`;
    const row = rows[0];
    if (!row) return 'invalid' as const;
    await recordAudit(tx, { actor: null, action: 'recipient.confirmed', entityType: 'recipient', entityId: row.id });
    return 'confirmed' as const;
  });
}
