/**
 * Two-step sign-in for staff: TOTP codes from an authenticator app, one-time
 * recovery codes, remembered devices, and the owner-run reset.
 *
 * The rules:
 *  - Every staff account must set it up. Until then a session reaches only
 *    the setup page.
 *  - A correct password on an enrolled account yields a short-lived,
 *    single-use challenge, never a session. The session comes only from a
 *    correct code.
 *  - A password reset does not remove the second step. Losing the
 *    authenticator means a recovery code, or an owner resetting it (audited).
 *  - Codes can't be replayed: each accepted time step is recorded.
 */

import 'server-only';
import { randomInt } from 'node:crypto';
import type { Sql, TransactionSql } from '@/allset/db/client';
import { randomToken, sha256Hex } from '@/allset/crypto';
import { recordAudit, type AuditActor } from '@/allset/audit';
import { hit, LIMITS } from '@/allset/ratelimit';
import { open, seal } from './secretbox';
import { matchTotp, newTotpSecret, otpauthUri } from './totp';
import { PermissionError, can, type Actor } from './roles';

export const CHALLENGE_MINUTES = 5;
export const CHALLENGE_MAX_ATTEMPTS = 5;
export const DEVICE_DAYS = 90;
export const RECOVERY_CODE_COUNT = 10;

const SEAL_PURPOSE = 'totp-secret';

function audit(actor: Actor): AuditActor {
  return { id: actor.id, label: `${actor.displayName} (${actor.role})` };
}

// ── Remembered devices ───────────────────────────────────────────────────

/** Which account a device cookie belongs to, if it's valid. */
export async function findDevice(sql: Sql, token: string | null): Promise<{ id: string; staffId: string } | null> {
  if (!token || token.length > 100) return null;
  const [row] = await sql<{ id: string; staff_id: string }[]>`
    select id, staff_id from allset.staff_devices
    where token_hash = ${sha256Hex(token)} and expires_at > now()`;
  return row ? { id: row.id, staffId: row.staff_id } : null;
}

/** After a full sign-in: refresh this browser's device record, or start one. */
export async function rememberDevice(
  sql: Sql,
  staffId: string,
  existingToken: string | null,
): Promise<{ token: string; expiresAt: Date }> {
  const existing = await findDevice(sql, existingToken);
  if (existing && existing.staffId === staffId && existingToken) {
    const [row] = await sql<{ expires_at: Date }[]>`
      update allset.staff_devices
      set last_used_at = now(), expires_at = now() + make_interval(days => ${DEVICE_DAYS})
      where id = ${existing.id}
      returning expires_at`;
    return { token: existingToken, expiresAt: row!.expires_at };
  }
  const token = randomToken(32);
  const [row] = await sql<{ expires_at: Date }[]>`
    insert into allset.staff_devices (token_hash, staff_id, expires_at)
    values (${sha256Hex(token)}, ${staffId}, now() + make_interval(days => ${DEVICE_DAYS}))
    returning expires_at`;
  return { token, expiresAt: row!.expires_at };
}

// ── Sign-in challenge ────────────────────────────────────────────────────

export async function createChallenge(
  sql: Sql,
  staffId: string,
  deviceId: string | null,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken(32);
  const [row] = await sql<{ expires_at: Date }[]>`
    insert into allset.staff_mfa_challenges (token_hash, staff_id, device_id, expires_at)
    values (${sha256Hex(token)}, ${staffId}, ${deviceId}, now() + make_interval(mins => ${CHALLENGE_MINUTES}))
    returning expires_at`;
  return { token, expiresAt: row!.expires_at };
}

export type ChallengeResult =
  | { readonly ok: true; readonly staffId: string; readonly usedRecoveryCode: boolean; readonly recoveryCodesLeft: number | null }
  | { readonly ok: false; readonly reason: 'invalid' | 'expired' | 'throttled'; readonly retryAfterSeconds?: number };

/**
 * Checks a code (or a recovery code) against a challenge. Each challenge
 * allows a few attempts; accounts and recovery codes also have their own
 * limits. On success the challenge is consumed.
 */
export async function verifyChallenge(
  sql: Sql,
  challengeToken: string,
  input: { code?: string; recoveryCode?: string },
): Promise<ChallengeResult> {
  if (!challengeToken || challengeToken.length > 100) return { ok: false, reason: 'expired' };

  // Claim an attempt atomically, so parallel guesses can't exceed the budget.
  const [challenge] = await sql<{ id: string; staff_id: string; attempts: number }[]>`
    update allset.staff_mfa_challenges
    set attempts = attempts + 1
    where token_hash = ${sha256Hex(challengeToken)} and expires_at > now()
    returning id, staff_id, attempts`;
  if (!challenge) return { ok: false, reason: 'expired' };
  if (challenge.attempts > CHALLENGE_MAX_ATTEMPTS) {
    await sql`delete from allset.staff_mfa_challenges where id = ${challenge.id}`;
    return { ok: false, reason: 'expired' };
  }

  const usingRecovery = Boolean(input.recoveryCode?.trim());
  const limit = await hit(sql, usingRecovery ? LIMITS.recoveryPerStaff : LIMITS.mfaPerStaff, challenge.staff_id);
  if (!limit.allowed) {
    await recordAudit(sql, { actor: null, action: 'auth.mfa_throttled', entityType: 'staff', entityId: challenge.staff_id, details: { recovery: usingRecovery } });
    return { ok: false, reason: 'throttled', retryAfterSeconds: limit.retryAfterSeconds };
  }

  let accepted = false;
  let recoveryCodesLeft: number | null = null;
  if (usingRecovery) {
    const used = await sql<{ id: string }[]>`
      update allset.staff_recovery_codes
      set used_at = now()
      where staff_id = ${challenge.staff_id} and code_hash = ${recoveryHash(input.recoveryCode!)} and used_at is null
      returning id`;
    accepted = used.length > 0;
    if (accepted) {
      const [left] = await sql<{ n: number }[]>`
        select count(*)::int as n from allset.staff_recovery_codes where staff_id = ${challenge.staff_id} and used_at is null`;
      recoveryCodesLeft = left?.n ?? 0;
    }
  } else {
    accepted = await acceptTotp(sql, challenge.staff_id, input.code ?? '');
  }

  if (!accepted) {
    await recordAudit(sql, { actor: null, action: 'auth.mfa_failed', entityType: 'staff', entityId: challenge.staff_id, details: { recovery: usingRecovery } });
    return { ok: false, reason: 'invalid' };
  }

  await sql`delete from allset.staff_mfa_challenges where id = ${challenge.id}`;
  await recordAudit(sql, {
    actor: null,
    action: usingRecovery ? 'auth.recovery_code_used' : 'auth.mfa_passed',
    entityType: 'staff',
    entityId: challenge.staff_id,
    ...(usingRecovery ? { details: { remaining: recoveryCodesLeft ?? 0 } } : {}),
  });
  return { ok: true, staffId: challenge.staff_id, usedRecoveryCode: usingRecovery, recoveryCodesLeft };
}

/** Checks a TOTP code and records its time step, so it can't be used again. */
async function acceptTotp(sql: Sql | TransactionSql, staffId: string, code: string): Promise<boolean> {
  const [row] = await sql<{ mfa_secret_enc: string | null; mfa_last_step: string | null }[]>`
    select mfa_secret_enc, mfa_last_step::text from allset.staff_users where id = ${staffId} and is_active`;
  const secret = row?.mfa_secret_enc ? open(SEAL_PURPOSE, row.mfa_secret_enc) : null;
  if (!secret) return false;
  const step = matchTotp(secret, code, { lastStep: row?.mfa_last_step ? Number(row.mfa_last_step) : null });
  if (step === null) return false;
  // Atomic replay guard: only one request can claim a given step.
  const claimed = await sql`
    update allset.staff_users set mfa_last_step = ${step}
    where id = ${staffId} and (mfa_last_step is null or mfa_last_step < ${step})
    returning id`;
  return claimed.length > 0;
}

// ── Enrollment ───────────────────────────────────────────────────────────

export interface EnrollmentStart {
  readonly secret: string;
  readonly uri: string;
}

/** Starts (or restarts) setup: a new secret waits until a code proves the app has it. */
export async function startEnrollment(sql: Sql, actor: Actor): Promise<EnrollmentStart> {
  const [row] = await sql<{ mfa_enabled_at: Date | null }[]>`select mfa_enabled_at from allset.staff_users where id = ${actor.id}`;
  if (row?.mfa_enabled_at) throw new PermissionError('Two-step sign-in is already set up for this account.');
  const secret = newTotpSecret();
  await sql`update allset.staff_users set mfa_pending_secret_enc = ${seal(SEAL_PURPOSE, secret)}, updated_at = now() where id = ${actor.id}`;
  return { secret, uri: otpauthUri(secret, actor.email) };
}

/** The pending secret, to show again after a wrong code (never after setup completes). */
export async function pendingEnrollment(sql: Sql, actor: Actor): Promise<EnrollmentStart | null> {
  const [row] = await sql<{ mfa_pending_secret_enc: string | null; mfa_enabled_at: Date | null }[]>`
    select mfa_pending_secret_enc, mfa_enabled_at from allset.staff_users where id = ${actor.id}`;
  if (!row || row.mfa_enabled_at || !row.mfa_pending_secret_enc) return null;
  const secret = open(SEAL_PURPOSE, row.mfa_pending_secret_enc);
  return secret ? { secret, uri: otpauthUri(secret, actor.email) } : null;
}

export type EnrollmentResult =
  | { readonly ok: true; readonly recoveryCodes: readonly string[] }
  | { readonly ok: false; readonly error: string };

/** Finishes setup with a code from the app. Returns recovery codes, shown once. */
export async function confirmEnrollment(sql: Sql, actor: Actor, code: string): Promise<EnrollmentResult> {
  const limit = await hit(sql, LIMITS.mfaEnrollPerStaff, actor.id);
  if (!limit.allowed) return { ok: false, error: 'Too many attempts. Wait 15 minutes and try again.' };
  const pending = await pendingEnrollment(sql, actor);
  if (!pending) return { ok: false, error: 'Start setup again: the code on this page has expired.' };
  const step = matchTotp(pending.secret, code);
  if (step === null) return { ok: false, error: 'That code doesn’t match. Check the time on your phone and try the newest code.' };

  const codes = newRecoveryCodes();
  await sql.begin(async (tx) => {
    const rows = await tx`
      update allset.staff_users
      set mfa_secret_enc = mfa_pending_secret_enc, mfa_pending_secret_enc = null,
          mfa_enabled_at = now(), mfa_last_step = ${step}, updated_at = now()
      where id = ${actor.id} and mfa_enabled_at is null and mfa_pending_secret_enc is not null
      returning id`;
    if (rows.length === 0) throw new PermissionError('Two-step sign-in is already set up for this account.');
    await replaceRecoveryCodes(tx, actor.id, codes);
    // This session has now passed both steps.
    await tx`update allset.staff_sessions set mfa_verified_at = now() where id = ${actor.sessionId}`;
    await recordAudit(tx, { actor: audit(actor), action: 'staff.mfa_enabled', entityType: 'staff', entityId: actor.id });
  });
  return { ok: true, recoveryCodes: codes };
}

// ── Recovery codes ───────────────────────────────────────────────────────

const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

/** Ten characters from a 30-letter alphabet (about 49 bits), grouped 5-5 for reading aloud. */
function newRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    let out = '';
    for (let i = 0; i < 10; i += 1) out += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
    return `${out.slice(0, 5)}-${out.slice(5)}`;
  });
}

function recoveryHash(code: string): string {
  return sha256Hex(`recovery:${code.toUpperCase().replace(/[^A-Z0-9]/g, '')}`);
}

async function replaceRecoveryCodes(tx: Sql | TransactionSql, staffId: string, codes: readonly string[]): Promise<void> {
  await tx`delete from allset.staff_recovery_codes where staff_id = ${staffId}`;
  for (const code of codes) {
    await tx`insert into allset.staff_recovery_codes (staff_id, code_hash) values (${staffId}, ${recoveryHash(code)})`;
  }
}

/** A fully signed-in person replaces their codes; the old ones stop working. */
export async function regenerateRecoveryCodes(sql: Sql, actor: Actor): Promise<readonly string[]> {
  const codes = newRecoveryCodes();
  await sql.begin(async (tx) => {
    const [row] = await tx<{ mfa_enabled_at: Date | null }[]>`select mfa_enabled_at from allset.staff_users where id = ${actor.id}`;
    if (!row?.mfa_enabled_at) throw new PermissionError('Set up two-step sign-in first.');
    await replaceRecoveryCodes(tx, actor.id, codes);
    await recordAudit(tx, { actor: audit(actor), action: 'staff.recovery_codes_replaced', entityType: 'staff', entityId: actor.id });
  });
  return codes;
}

export async function mfaStatus(sql: Sql, staffId: string): Promise<{ enabledAt: Date | null; recoveryCodesLeft: number }> {
  const [row] = await sql<{ enabled_at: Date | null; left: number }[]>`
    select u.mfa_enabled_at as enabled_at,
           (select count(*)::int from allset.staff_recovery_codes c where c.staff_id = u.id and c.used_at is null) as left
    from allset.staff_users u where u.id = ${staffId}`;
  return { enabledAt: row?.enabled_at ?? null, recoveryCodesLeft: row?.left ?? 0 };
}

// ── Owner reset ──────────────────────────────────────────────────────────

/**
 * For someone who lost their authenticator and recovery codes. Their
 * sessions and remembered devices end, and they set it up again at their
 * next sign-in (their password still has to be right). Owners can't reset
 * their own: that must be another owner, so a stolen owner session can't
 * quietly remove the second step.
 */
export async function resetMfa(sql: Sql, actor: Actor, staffId: string): Promise<void> {
  if (!can(actor, 'staff.manage')) throw new PermissionError();
  if (staffId === actor.id) throw new PermissionError('Another owner has to reset your two-step sign-in.');
  await sql.begin(async (tx) => {
    const rows = await tx`
      update allset.staff_users
      set mfa_secret_enc = null, mfa_pending_secret_enc = null, mfa_enabled_at = null, mfa_last_step = null, updated_at = now()
      where id = ${staffId}
      returning id`;
    if (rows.length === 0) throw new PermissionError('That account doesn’t exist.');
    await tx`delete from allset.staff_recovery_codes where staff_id = ${staffId}`;
    await tx`delete from allset.staff_sessions where staff_id = ${staffId}`;
    await tx`delete from allset.staff_devices where staff_id = ${staffId}`;
    await tx`delete from allset.staff_mfa_challenges where staff_id = ${staffId}`;
    await recordAudit(tx, { actor: audit(actor), action: 'staff.mfa_reset', entityType: 'staff', entityId: staffId });
  });
}
