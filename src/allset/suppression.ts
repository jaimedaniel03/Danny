/**
 * The do-not-contact list: keyed hashes of the email addresses and phone
 * numbers of people who asked us to stop. It outlives the leads themselves,
 * so a later submission in their name is flagged before anyone reaches out.
 *
 * Keyed with APP_SECRET: rotating that secret orphans this list, so rotate it
 * only with a plan to re-mark suppressed contacts.
 */

import 'server-only';
import type { Sql, TransactionSql } from '@/allset/db/client';
import { hmacHex } from '@/allset/crypto';

export function emailHash(emailNormalized: string): string {
  return hmacHex('suppress:email', emailNormalized.trim().toLowerCase());
}

export function phoneHash(phoneE164: string): string {
  return hmacHex('suppress:phone', phoneE164);
}

export async function suppress(
  sql: Sql | TransactionSql,
  contact: { emailNormalized: string; phoneE164: string | null },
  actorId: string | null,
): Promise<void> {
  await sql`
    insert into allset.contact_suppressions (value_hash, kind, created_by)
    values (${emailHash(contact.emailNormalized)}, 'email', ${actorId})
    on conflict (value_hash) do nothing`;
  if (contact.phoneE164) {
    await sql`
      insert into allset.contact_suppressions (value_hash, kind, created_by)
      values (${phoneHash(contact.phoneE164)}, 'phone', ${actorId})
      on conflict (value_hash) do nothing`;
  }
}

export async function isSuppressed(
  sql: Sql | TransactionSql,
  contact: { emailNormalized: string; phoneE164: string | null },
): Promise<boolean> {
  const hashes = [emailHash(contact.emailNormalized), ...(contact.phoneE164 ? [phoneHash(contact.phoneE164)] : [])];
  const rows = await sql`select 1 from allset.contact_suppressions where value_hash = any(${hashes}::text[]) limit 1`;
  return rows.length > 0;
}
