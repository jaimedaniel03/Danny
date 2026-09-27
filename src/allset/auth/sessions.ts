/**
 * Staff sessions. The cookie carries a random 256-bit token; the database
 * stores only its SHA-256, so a leaked table cannot be replayed as a login.
 */

import 'server-only';
import type { Sql } from '@/allset/db/client';
import { randomToken, sha256Hex } from '@/allset/crypto';
import type { Actor, Role } from './roles';

export const SESSION_ABSOLUTE_HOURS = 12;
export const SESSION_IDLE_MINUTES = 120;
/** Don't write last_seen_at on every request; five-minute granularity is plenty. */
const TOUCH_AFTER_MINUTES = 5;

/**
 * `mfaVerified: false` makes a session that can only reach the two-step
 * setup page: used right after a new account's first password, before it has
 * an authenticator.
 */
export async function createSession(
  sql: Sql,
  staffId: string,
  meta: { ipHash: string | null; userAgent: string | null; mfaVerified: boolean },
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken(32);
  const [row] = await sql<{ expires_at: Date }[]>`
    insert into allset.staff_sessions (token_hash, staff_id, expires_at, ip_hash, user_agent, mfa_verified_at)
    values (${sha256Hex(token)}, ${staffId}, now() + make_interval(hours => ${SESSION_ABSOLUTE_HOURS}),
            ${meta.ipHash}, ${meta.userAgent ? meta.userAgent.slice(0, 256) : null},
            ${meta.mfaVerified ? sql`now()` : null})
    returning expires_at`;
  return { token, expiresAt: row!.expires_at };
}

interface SessionRow {
  readonly session_id: string;
  readonly staff_id: string;
  readonly role: Role;
  readonly display_name: string;
  readonly email: string;
  readonly stale: boolean;
  readonly mfa_verified: boolean;
}

export async function lookupSession(sql: Sql, token: string): Promise<Actor | null> {
  if (!token || token.length > 100) return null;
  const [row] = await sql<SessionRow[]>`
    select s.id as session_id, u.id as staff_id, u.role, u.display_name, u.email,
           s.last_seen_at < now() - make_interval(mins => ${TOUCH_AFTER_MINUTES}) as stale,
           (s.mfa_verified_at is not null and u.mfa_enabled_at is not null) as mfa_verified
    from allset.staff_sessions s
    join allset.staff_users u on u.id = s.staff_id
    where s.token_hash = ${sha256Hex(token)}
      and s.expires_at > now()
      and s.last_seen_at > now() - make_interval(mins => ${SESSION_IDLE_MINUTES})
      and u.is_active
      and u.password_hash is not null`;
  if (!row) return null;
  if (row.stale) {
    await sql`update allset.staff_sessions set last_seen_at = now() where id = ${row.session_id}`;
  }
  return {
    id: row.staff_id,
    role: row.role,
    displayName: row.display_name,
    email: row.email,
    sessionId: row.session_id,
    mfaVerified: row.mfa_verified,
  };
}

export async function revokeSession(sql: Sql, token: string): Promise<void> {
  await sql`delete from allset.staff_sessions where token_hash = ${sha256Hex(token)}`;
}

export async function revokeAllSessions(sql: Sql, staffId: string, exceptSessionId?: string): Promise<number> {
  const rows = exceptSessionId
    ? await sql`delete from allset.staff_sessions where staff_id = ${staffId} and id <> ${exceptSessionId} returning id`
    : await sql`delete from allset.staff_sessions where staff_id = ${staffId} returning id`;
  return rows.length;
}
