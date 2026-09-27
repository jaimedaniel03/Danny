/**
 * Staff accounts: sign-in, first-owner setup, invitations, password changes,
 * roles and deactivation. Every change is audited; no function here trusts a
 * role or id that did not come from a verified session.
 */

import 'server-only';
import type { Sql, TransactionSql } from '@/allset/db/client';
import { randomToken, sha256Hex, safeEqual } from '@/allset/crypto';
import { recordAudit, type AuditActor } from '@/allset/audit';
import { hit, LIMITS } from '@/allset/ratelimit';
import { dummyHash, hashPassword, passwordProblem, verifyPassword } from './password';
import { findDevice } from './mfa';
import { revokeAllSessions } from './sessions';
import { PermissionError, can, type Actor, type Role } from './roles';

export const INVITE_TTL_HOURS = 48;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function auditActor(actor: Actor): AuditActor {
  return { id: actor.id, label: `${actor.displayName} (${actor.role})` };
}

// ── Sign-in (first step: the password) ───────────────────────────────────

export type SignInResult =
  /** Password right; the account has two-step sign-in, so a code comes next. */
  | { readonly ok: true; readonly staffId: string; readonly next: 'mfa'; readonly deviceId: string | null }
  /** Password right; two-step sign-in isn't set up yet, so that comes next. */
  | { readonly ok: true; readonly staffId: string; readonly next: 'enroll' }
  | { readonly ok: false; readonly reason: 'invalid' | 'throttled'; readonly retryAfterSeconds?: number };

interface AccountRow {
  readonly id: string;
  readonly password_hash: string;
  readonly mfa_enabled_at: Date | null;
}

/**
 * The password step, built so an attacker can't lock the real person out:
 *
 *  1. Every attempt counts against the connection (per IP) and against a
 *     second budget before any password work, so a parallel burst can't slip
 *     under either limit.
 *  2. That second budget depends on the browser. A browser that has already
 *     completed a full sign-in to this account (a remembered device) has its
 *     own budget. Every other browser shares the account's "new device"
 *     budget. Someone hammering the account from elsewhere exhausts only the
 *     shared one; the owner's own devices keep working.
 *  3. Windows are short and fixed. Nothing locks an account beyond one window.
 *  4. Unknown emails do the same work and get the same answers, so neither
 *     the timing nor the switch to "throttled" reveals which accounts exist.
 *
 * A right password never produces a full session by itself: the second step
 * (or, for a new account, setting it up) always follows.
 */
export async function signIn(
  sql: Sql,
  rawEmail: string,
  password: string,
  ctx: { readonly ip: string; readonly deviceToken?: string | null },
): Promise<SignInResult> {
  const email = rawEmail.trim().toLowerCase().slice(0, 254);
  const [account] = await sql<AccountRow[]>`
    select id, password_hash, mfa_enabled_at from allset.staff_users
    where lower(email) = ${email} and is_active and password_hash is not null`;
  const device = await findDevice(sql, ctx.deviceToken ?? null);
  const trusted = Boolean(account && device && device.staffId === account.id);

  const byIp = await hit(sql, LIMITS.loginPerIp, ctx.ip);
  const budget = trusted
    ? await hit(sql, LIMITS.loginPerDevice, device!.id)
    : await hit(sql, LIMITS.loginPerAccountNewDevice, email);
  if (!byIp.allowed || !budget.allowed) {
    await recordAudit(sql, {
      actor: null,
      action: 'auth.sign_in_throttled',
      ...(account ? { entityType: 'staff' as const, entityId: account.id } : {}),
      details: { per_connection: !byIp.allowed, per_account: !budget.allowed, remembered_device: trusted },
    });
    return {
      ok: false,
      reason: 'throttled',
      retryAfterSeconds: Math.max(byIp.allowed ? 0 : byIp.retryAfterSeconds, budget.allowed ? 0 : budget.retryAfterSeconds),
    };
  }

  const matches = await verifyPassword(password.slice(0, 256), account ? account.password_hash : await dummyHash());
  if (!account || !matches) {
    await recordAudit(sql, {
      actor: null,
      action: 'auth.sign_in_failed',
      ...(account ? { entityType: 'staff' as const, entityId: account.id } : {}),
      details: { known_account: Boolean(account), remembered_device: trusted },
    });
    return { ok: false, reason: 'invalid' };
  }

  await recordAudit(sql, { actor: null, action: 'auth.password_accepted', entityType: 'staff', entityId: account.id, details: { remembered_device: trusted } });
  return account.mfa_enabled_at
    ? { ok: true, staffId: account.id, next: 'mfa', deviceId: trusted ? device!.id : null }
    : { ok: true, staffId: account.id, next: 'enroll' };
}

/** Records a completed sign-in (both steps). */
export async function recordSignedIn(sql: Sql, staffId: string, detail: { usedRecoveryCode: boolean }): Promise<void> {
  const [row] = await sql<{ display_name: string; role: Role }[]>`
    update allset.staff_users set last_login_at = now(), updated_at = now()
    where id = ${staffId}
    returning display_name, role`;
  await recordAudit(sql, {
    actor: { id: staffId, label: `${row?.display_name ?? 'Staff'} (${row?.role ?? 'staff'})` },
    action: 'auth.signed_in',
    entityType: 'staff',
    entityId: staffId,
    details: { recovery_code: detail.usedRecoveryCode },
  });
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
          updated_at = now()
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
): Promise<FieldResult<{ staffId: string; mfaEnabled: boolean }>> {
  const invite = await findInvite(sql, token);
  if (!invite) return { ok: false, errors: { token: 'This link has expired or was already used. Ask an owner for a new one.' } };
  const problem = passwordProblem(password, invite.email);
  if (problem) return { ok: false, errors: { password: problem } };
  const passwordHash = await hashPassword(password);
  const rows = await sql`
    update allset.staff_users
    set password_hash = ${passwordHash}, invite_token_hash = null, invite_expires_at = null,
        updated_at = now()
    where id = ${invite.staffId} and invite_token_hash = ${sha256Hex(token)} and invite_expires_at > now()
    returning id, mfa_enabled_at`;
  if (rows.length === 0) return { ok: false, errors: { token: 'This link has expired or was already used.' } };
  await recordAudit(sql, {
    actor: { id: invite.staffId, label: invite.displayName },
    action: 'staff.password_set',
    entityType: 'staff',
    entityId: invite.staffId,
  });
  // A reset keeps the second step: someone holding only the link still needs the code.
  const mfaEnabled = Boolean((rows[0] as { mfa_enabled_at: Date | null } | undefined)?.mfa_enabled_at);
  return { ok: true, value: { staffId: invite.staffId, mfaEnabled } };
}

export async function changePassword(
  sql: Sql,
  actor: Actor,
  current: string,
  next: string,
): Promise<FieldResult<null>> {
  // A stolen session must not become a way to brute-force the real password.
  const limit = await hit(sql, LIMITS.passwordChangePerStaff, actor.id);
  if (!limit.allowed) return { ok: false, errors: { current: 'Too many attempts. Try again in 15 minutes.' } };
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
      await tx`delete from allset.staff_devices where staff_id = ${staffId}`;
      await tx`delete from allset.staff_mfa_challenges where staff_id = ${staffId}`;
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
  readonly mfaEnabled: boolean;
  readonly lastLoginAt: Date | null;
  readonly openLeads: number;
}

export async function listStaff(sql: Sql, actor: Actor): Promise<StaffSummary[]> {
  if (!can(actor, 'staff.manage')) throw new PermissionError();
  return sql<StaffSummary[]>`
    select u.id, u.email, u.display_name as "displayName", u.role, u.is_active as "isActive",
           (u.password_hash is null and u.invite_expires_at > now()) as "pendingInvite",
           (u.mfa_enabled_at is not null) as "mfaEnabled",
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
