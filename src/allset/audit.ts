/**
 * The staff audit trail. Every change a person makes — to a lead, to an
 * account, to who gets alerts — lands here, append-only (the table rejects
 * UPDATE, and DELETE before the retention horizon).
 *
 * `details` holds identifiers and transitions, never a person's contact
 * details: an audit trail that repeats names and phone numbers would outlive
 * the deletion of the lead it describes.
 */

import 'server-only';
import type { Sql, TransactionSql } from '@/allset/db/client';

export interface AuditActor {
  readonly id: string;
  readonly label: string;
}

type DetailValue = string | number | boolean | null;

export interface AuditEvent {
  readonly actor: AuditActor | null;
  readonly action: string;
  readonly entityType?: 'lead' | 'staff' | 'recipient' | 'notification' | 'export' | 'session' | 'inquiry';
  readonly entityId?: string | null;
  readonly entityRef?: string | null;
  readonly details?: Readonly<Record<string, DetailValue | readonly string[]>>;
}

const PERSONAL = /(^|_)(email|phone|name|zip|address|note|body|password|token)s?($|_)/i;

export function assertNoPersonalData(details: AuditEvent['details']): void {
  for (const key of Object.keys(details ?? {})) {
    if (PERSONAL.test(key)) {
      throw new Error(`audit details must not carry personal data (field "${key}")`);
    }
  }
}

export async function recordAudit(sql: Sql | TransactionSql, event: AuditEvent): Promise<void> {
  assertNoPersonalData(event.details);
  await sql`
    insert into allset.audit_events (actor_id, actor_label, action, entity_type, entity_id, entity_ref, details)
    values (
      ${event.actor?.id ?? null},
      ${event.actor?.label ?? null},
      ${event.action},
      ${event.entityType ?? null},
      ${event.entityId ?? null},
      ${event.entityRef ?? null},
      ${sql.json(event.details ?? {})}
    )`;
}
