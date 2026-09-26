/**
 * Staff accounts: sign-in, first-owner setup, invitations, password changes,
 * roles and deactivation. Every change is audited; no function here trusts a
 * role or id that did not come from a verified session.
 */

import 'server-only';
import type { Sql, TransactionSql } from '@/allset/db/client';
import { randomToken, sha256Hex, safeEqual } from '@/allset/crypto';
import { recordAudit, type AuditActor } from '@/allset/audit';
import { hit, peek, LIMITS } from '@/allset/ratelimit';
import { dummyHash, hashPassword, passwordProblem, verifyPassword } from './password';
import { revokeAllSessions } from './sessions';
import { PermissionError, can, type Actor, type Role } from './roles';

export const LOCKOUT_THRESHOLD = 5;
export const LOCKOUT_MINUTES = 15;
export const INVITE_TTL_HOURS = 48;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function auditActor(actor: Actor): AuditActor {
  return { id: actor.id, label: `${actor.displayName} (${actor.role})` };
}

// ── Sign-in ──────────────────────────────────────────────────────────────

export type SignInResult =
  | { readonly ok: true; readonly staffId: string }
  | { readonly ok: false; readonly reason: 'invalid' | 'locked' | 'rate_limited'; readonly retryAfterSeconds?: number };

interface LoginRow {
  readonly id: string;
  readonly password_hash: string | null;
  readonly is_active: boolean;
  readonly locked: boolean;
  readonly display_name: string;
  readonly role: Role;
}

export async function signIn(
  sql: Sql,
  rawEmail: string,
  password: string,
  ctx: { ip: string },
): Promise<SignInResult> {
  const email = rawEmail.trim().toLowerCase().slice(0, 254);

  // Check both limits before doing any expensive work.
  const byIp = await peek(sql, LIMITS.loginPerIp, ctx.ip);
  const byEmail = await peek(sql, LIMITS.loginPerEmail, email);
  if (!byIp.allowed || !byEmail.allowed) {
    return {
      ok: false,
      reason: 'rate_limited',
      retryAfterSeconds: Math.max(byIp.allowed ? 0 : byIp.retryAfterSeconds, byEmail.allowed ? 0 : byEmail.retryAfterSeconds),
    };
  }

  const [user] = await sql<LoginRow[]>`
    select id, password_hash, is_active, display_name, role,
           coalesce(locked_until > now(), false) as locked
    from allset.staff_users where lower(email) = ${email}`;

  const usable = user && user.is_active && user.password_hash;
  // Always spend the same work, whether or not the account exists.
  const matches = await verifyPassword(password.slice(0, 256), usable ? usable : await dummyHash());

  if (!usable || !matches || user.locked) {
    await hit(sql, LIMITS.loginPerIp, ctx.ip);
    await hit(sql, LIMITS.loginPerEmail, email);
    if (user && usable && !user.locked) {
      const [row] = await sql<{ failed_login_count: number }[]>`
        update allset.staff_users
        set failed_login_count = failed_login_count + 1,
            locked_until = case when failed_login_count + 1 >= ${LOCKOUT_THRESHOLD}
                                then now() + make_interval(mins => ${LOCKOUT_MINUTES}) else locked_until end,
            updated_at = now()
        where id = ${user.id}
        returning failed_login_count`;
      if ((row?.failed_login_count ?? 0) >= LOCKOUT_THRESHOLD) {
        await sql`update allset.staff_users set failed_login_count = 0 where id = ${user.id}`;
        await recordAudit(sql, { actor: null, action: 'auth.locked', entityType: 'staff', entityId: user.id });
      }
    }
    await recordAudit(sql, {
      actor: null,
      action: 'auth.sign_in_failed',
      ...(user ? { entityType: 'staff' as const, entityId: user.id } : {}),
      details: { known_account: Boolean(user), locked: Boolean(user?.locked) },
    });
    // A correct password on a locked account still says "locked", so the
    // lock is noticeable to the real owner without confirming the password.
    return { ok: false, reason: user?.locked && matches ? 'locked' : 'invalid' };
  }

  await sql`
    update allset.staff_users
    set failed_login_count = 0, locked_until = null, last_login_at = now(), updated_at = now()
    where id = ${user.id}`;
  await recordAudit(sql, {
    actor: { id: user.id, label: `${user.display_name} (${user.role})` },
    action: 'auth.signed_in',
    entityType: 'staff',
    entityId: user.id,
  });
  return { ok: true, staffId: user.id };
}

// ── First owner ──────────────────────────────────────────────────────────

export async function hasActiveOwner(sql: Sql): Promise<boolean> {
  const [row] = await sql<{ exists: boolean }[]>`
    select exists(select 1 from allset.staff_users where role = 'owner' and is_active) as exists`;
  return Boolean(row?.exists);
}

export interface NewAccountInput {
  readonly email: string;
  readonly displayName: string;
  readonly password: string;
}

export type FieldResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly errors: Record<string, string> };

function checkAccountFields(input: NewAccountInput, withPassword: boolean): Record<string, string> {
  const errors: Record<string, string> = {};
  const email = input.email.trim();
  const name = input.displayName.trim();
  if (!name) errors['displayName'] = 'Enter a name.';
  else if (name.length > 80) errors['displayName'] = 'Use 80 characters or fewer.';
  if (!EMAIL.test(email) || email.length > 254) errors['email'] = 'Enter a valid email address.';
  if (withPassword) {
    const problem = passwordProblem(input.password, email);
    if (problem) errors['password'] = problem;
  }
  return errors;
}

/**
 * Creates the first owner. Allowed only with the one-time setup token and
 * only while no active owner exists — after that, owners invite everyone.
 */
export async function createFirstOwner(
  sql: Sql,
  expectedToken: string | undefined,
  givenToken: string,
  input: NewAccountInput,
): Promise<FieldResult<{ staffId: string }>> {
  if (!expectedToken || !safeEqual(givenToken, expectedToken)) {
    return { ok: false, errors: { token: 'That setup code isn’t right.' } };
  }
  const errors = checkAccountFields(input, true);
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const passwordHash = await hashPassword(input.password);
  return sql.begin(async (tx) => {
    // Serialize concurrent setup attempts.
    await tx`lock table allset.staff_users in share row exclusive mode`;
    const [existing] = await tx`select 1 from allset.staff_users where role = 'owner' and is_active`;
    if (existing) return { ok: false as const, errors: { token: 'Setup is already complete. Sign in instead.' } };
    const [taken] = await tx`select 1 from allset.staff_users where lower(email) = lower(${input.email.trim()})`;
    if (taken) return { ok: false as const, errors: { email: 'An account with that email already exists.' } };
    const [row] = await tx<{ id: string }[]>`
      insert into allset.staff_users (email, display_name, role, password_hash)
      values (${input.email.trim()}, ${input.displayName.trim()}, 'owner', ${passwordHash})
      returning id`;
    await recordAudit(tx, {
      actor: { id: row!.id, label: `${input.displayName.trim()} (owner)` },
      action: 'staff.owner_created_via_setup',
      entityType: 'staff',
      entityId: row!.id,
    });
    return { ok: true as const, value: { staffId: row!.id } };
  });
}

// ── Invitations and resets ───────────────────────────────────────────────

export async function inviteStaff(
  sql: Sql,
  actor: Actor,
  input: { email: string; displayName: string; role: Role },
): Promise<FieldResult<{ staffId: string; inviteToken: string }>> {
  if (!can(actor, 'staff.manage')) throw new PermissionError();
  const errors = checkAccountFields({ ...input, password: '' }, false);
  if (input.role !== 'owner' && input.role !== 'staff') errors['role'] = 'Choose a role.';
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const token = randomToken(32);
  return sql.begin(async (tx) => {
    const [taken] = await tx`select 1 from allset.staff_users where lower(email) = lower(${input.email.trim()})`;
    if (taken) return { ok: false as const, errors: { email: 'Someone with that email already has an account.' } };
    const [row] = await tx<{ id: string }[]>`
      insert into allset.staff_users (email, display_name, role, invite_token_hash, invite_expires_at, created_by)
      values (${input.email.trim()}, ${input.displayName.trim()}, ${input.role}, ${sha256Hex(token)},
              now() + make_interval(hours => ${INVITE_TTL_HOURS}), ${actor.id})
      returning id`;
    await recordAudit(tx, {
      actor: auditActor(actor),
      action: 'staff.invited',
      entityType: 'staff',
      entityId: row!.id,
      details: { role: input.role },
    });
    return { ok: true as const, value: { staffId: row!.id, inviteToken: token } };
  });
}

/** Owner-issued reset: the old password stops working immediately. */
export async function issuePasswordReset(sql: Sql, actor: Actor, staffId: string): Promise<{ inviteToken: string }> {
  if (!can(actor, 'staff.manage')) throw new PermissionError();
  const token = randomToken(32);
  return sql.begin(async (tx) => {
    const rows = await tx`
      update allset.staff_users
      set password_hash = null, invite_token_hash = ${sha256Hex(token)},
          invite_expires_at = now() + make_interval(hours => ${INVITE_TTL_HOURS}),
          failed_login_count = 0, locked_until = null, updated_at = now()
      where id = ${staffId} and is_active
      returning id`;
    if (rows.length === 0) throw new PermissionError('That account is not active.');
    await tx`delete from allset.staff_sessions where staff_id = ${staffId}`;
    await recordAudit(tx, { actor: auditActor(actor), action: 'staff.password_reset_issued', entityType: 'staff', entityId: staffId });
    return { inviteToken: token };
  });
}

export interface InviteInfo {
  readonly staffId: string;
  readonly email: string;
  readonly displayName: string;
}

export async function findInvite(sql: Sql, token: string): Promise<InviteInfo | null> {
  if (!token || token.length > 100) return null;
  const [row] = await sql<{ id: string; email: string; display_name: string }[]>`
    select id, email, display_name from allset.staff_users
    where invite_token_hash = ${sha256Hex(token)} and invite_expires_at > now() and is_active`;
  return row ? { staffId: row.id, email: row.email, displayName: row.display_name } : null;
}

export async function acceptInvite(
  sql: Sql,
  token: string,
  password: string,
): Promise<FieldResult<{ staffId: string }>> {
  const invite = await findInvite(sql, token);
  if (!invite) return { ok: false, errors: { token: 'This link has expired or was already used. Ask an owner for a new one.' } };
  const problem = passwordProblem(password, invite.email);
  if (problem) return { ok: false, errors: { password: problem } };
  const passwordHash = await hashPassword(password);
  const rows = await sql`
    update allset.staff_users
    set password_hash = ${passwordHash}, invite_token_hash = null, invite_expires_at = null,
        failed_login_count = 0, locked_until = null, updated_at = now()
    where id = ${invite.staffId} and invite_token_hash = ${sha256Hex(token)} and invite_expires_at > now()
    returning id`;
  if (rows.length === 0) return { ok: false, errors: { token: 'This link has expired or was already used.' } };
  await recordAudit(sql, {
    actor: { id: invite.staffId, label: invite.displayName },
    action: 'staff.password_set',
    entityType: 'staff',
    entityId: invite.staffId,
  });
  return { ok: true, value: { staffId: invite.staffId } };
}

export async function changePassword(
  sql: Sql,
  actor: Actor,
  current: string,
  next: string,
): Promise<FieldResult<null>> {
  const [row] = await sql<{ password_hash: string | null }[]>`
    select password_hash from allset.staff_users where id = ${actor.id}`;
  if (!row?.password_hash || !(await verifyPassword(current.slice(0, 256), row.password_hash))) {
    return { ok: false, errors: { current: 'Your current password isn’t right.' } };
  }
  const problem = passwordProblem(next, actor.email);
  if (problem) return { ok: false, errors: { next: problem } };
  if (current === next) return { ok: false, errors: { next: 'Choose a password you haven’t used here.' } };
  const passwordHash = await hashPassword(next);
  await sql`update allset.staff_users set password_hash = ${passwordHash}, updated_at = now() where id = ${actor.id}`;
  // Every other signed-in device is signed out.
  await revokeAllSessions(sql, actor.id, actor.sessionId);
  await recordAudit(sql, { actor: auditActor(actor), action: 'staff.password_changed', entityType: 'staff', entityId: actor.id });
  return { ok: true, value: null };
}

// ── Roles and deactivation ───────────────────────────────────────────────

async function activeOwnerCount(sql: Sql | TransactionSql): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from allset.staff_users where role = 'owner' and is_active`;
  return row?.n ?? 0;
}

export async function setRole(sql: Sql, actor: Actor, staffId: string, role: Role): Promise<void> {
  if (!can(actor, 'staff.manage')) throw new PermissionError();
  if (staffId === actor.id) throw new PermissionError('You can’t change your own role. Ask another owner.');
  if (role !== 'owner' && role !== 'staff') throw new PermissionError('Unknown role.');
  await sql.begin(async (tx) => {
    await tx`lock table allset.staff_users in share row exclusive mode`;
    const [target] = await tx<{ role: Role; is_active: boolean }[]>`select role, is_active from allset.staff_users where id = ${staffId}`;
    if (!target) throw new PermissionError('That account doesn’t exist.');
    if (target.role === role) return;
    if (target.role === 'owner' && target.is_active && (await activeOwnerCount(tx)) <= 1) {
      throw new PermissionError('There must always be at least one active owner.');
    }
    await tx`update allset.staff_users set role = ${role}, updated_at = now() where id = ${staffId}`;
    // A demoted owner's open sessions carry no stale role: roles are read per request.
    await recordAudit(tx, {
      actor: auditActor(actor),
      action: 'staff.role_changed',
      entityType: 'staff',
      entityId: staffId,
      details: { from: target.role, to: role },
    });
  });
}

export async function setActive(sql: Sql, actor: Actor, staffId: string, active: boolean): Promise<void> {
  if (!can(actor, 'staff.manage')) throw new PermissionError();
  if (staffId === actor.id) throw new PermissionError('You can’t deactivate your own account.');
  await sql.begin(async (tx) => {
    await tx`lock table allset.staff_users in share row exclusive mode`;
    const [target] = await tx<{ role: Role; is_active: boolean }[]>`select role, is_active from allset.staff_users where id = ${staffId}`;
    if (!target) throw new PermissionError('That account doesn’t exist.');
    if (target.is_active === active) return;
    if (!active && target.role === 'owner' && (await activeOwnerCount(tx)) <= 1) {
      throw new PermissionError('There must always be at least one active owner.');
    }
    await tx`
      update allset.staff_users
      set is_active = ${active}, deactivated_at = ${active ? null : new Date()}, updated_at = now(),
          invite_token_hash = case when ${active} then invite_token_hash else null end
      where id = ${staffId}`;
    if (!active) {
      await tx`delete from allset.staff_sessions where staff_id = ${staffId}`;
      // Their leads go back to the shared pool so nobody's request goes quiet.
      await tx`
        update allset.leads set assigned_to = null, updated_at = now()
        where assigned_to = ${staffId} and closed_at is null`;
    }
    await recordAudit(tx, {
      actor: auditActor(actor),
      action: active ? 'staff.reactivated' : 'staff.deactivated',
      entityType: 'staff',
      entityId: staffId,
    });
  });
}

export interface StaffSummary {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: Role;
  readonly isActive: boolean;
  readonly pendingInvite: boolean;
  readonly lastLoginAt: Date | null;
  readonly openLeads: number;
}

export async function listStaff(sql: Sql, actor: Actor): Promise<StaffSummary[]> {
  if (!can(actor, 'staff.manage')) throw new PermissionError();
  return sql<StaffSummary[]>`
    select u.id, u.email, u.display_name as "displayName", u.role, u.is_active as "isActive",
           (u.password_hash is null and u.invite_expires_at > now()) as "pendingInvite",
           u.last_login_at as "lastLoginAt",
           (select count(*)::int from allset.leads l where l.assigned_to = u.id and l.closed_at is null) as "openLeads"
    from allset.staff_users u
    order by u.is_active desc, u.role, u.display_name`;
}

/** Active staff, for assignment pickers. Names only; any signed-in user may see who's on the team. */
export async function listAssignable(sql: Sql): Promise<{ id: string; displayName: string }[]> {
  return sql<{ id: string; displayName: string }[]>`
    select id, display_name as "displayName" from allset.staff_users
    where is_active and password_hash is not null
    order by display_name`;
}
