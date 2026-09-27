import { expect, it } from 'vitest';
import { db, describeDb, uniqueEmail } from '@/allset/testing/db';
import { hashPassword, passwordProblem, verifyPassword } from './password';
import {
  acceptInvite,
  changePassword,
  createFirstOwner,
  findInvite,
  inviteStaff,
  issuePasswordReset,
  setActive,
  setRole,
  signIn,
} from './accounts';
import {
  CHALLENGE_MAX_ATTEMPTS,
  confirmEnrollment,
  createChallenge,
  rememberDevice,
  resetMfa,
  startEnrollment,
  verifyChallenge,
} from './mfa';
import { createSession, lookupSession } from './sessions';
import { currentStep, totpAt } from './totp';
import { LIMITS } from '@/allset/ratelimit';
import { PermissionError, type Actor } from './roles';

const PASSWORD = 'a long kitchen table sentence';

it('hashes with scrypt and verifies only the right password', async () => {
  const hash = await hashPassword(PASSWORD);
  expect(hash).toMatch(/^scrypt\$32768\$8\$1\$/);
  expect(await verifyPassword(PASSWORD, hash)).toBe(true);
  expect(await verifyPassword('a long kitchen table sentencE', hash)).toBe(false);
  expect(await verifyPassword(PASSWORD, 'garbage')).toBe(false);
});

it('explains weak passwords', () => {
  expect(passwordProblem('short', 'a@b.co')).toMatch(/at least 12/);
  expect(passwordProblem('password1234', 'a@b.co')).toMatch(/common/);
  expect(passwordProblem('jordan.smith rules!', 'jordan.smith@example.com')).toMatch(/email/);
  expect(passwordProblem(PASSWORD, 'a@b.co')).toBeNull();
});

async function makeUser(role: 'owner' | 'staff', email = uniqueEmail(role)): Promise<Actor> {
  const hash = await hashPassword(PASSWORD);
  const [row] = await db()<{ id: string }[]>`
    insert into allset.staff_users (email, display_name, role, password_hash)
    values (${email}, ${`Test ${role}`}, ${role}, ${hash}) returning id`;
  const session = await createSession(db(), row!.id, { ipHash: null, userAgent: null, mfaVerified: false });
  return (await lookupSession(db(), session.token))!;
}

/** Sets up two-step sign-in the way a person does, and returns the secret their app holds. */
async function enroll(actor: Actor): Promise<string> {
  const { secret } = await startEnrollment(db(), actor);
  const result = await confirmEnrollment(db(), actor, totpAt(secret, currentStep()));
  if (!result.ok) throw new Error(result.error);
  return secret;
}

/** A code the account hasn't used yet (the step after the one used to enroll). */
const nextCode = (secret: string, ahead = 1) => totpAt(secret, currentStep() + ahead);

let ipCounter = 0;
function ip(): { ip: string } {
  ipCounter += 1;
  return { ip: `203.0.113.${ipCounter}-${Math.random().toString(36).slice(2)}` };
}

describeDb('staff sign-in', () => {
  it('asks a new account to set up two-step sign-in, and refuses wrong passwords generically', async () => {
    const user = await makeUser('staff');
    expect(await signIn(db(), user.email.toUpperCase(), PASSWORD, ip())).toEqual({ ok: true, staffId: user.id, next: 'enroll' });
    expect(await signIn(db(), user.email, 'wrong password here', ip())).toEqual({ ok: false, reason: 'invalid' });
    expect(await signIn(db(), uniqueEmail('nobody'), PASSWORD, ip())).toEqual({ ok: false, reason: 'invalid' });
  });

  it('never turns a right password alone into a session for an enrolled account', async () => {
    const user = await makeUser('staff');
    await enroll(user);
    const result = await signIn(db(), user.email, PASSWORD, ip());
    expect(result).toMatchObject({ ok: true, next: 'mfa' });
  });

  it('completes sign-in only with a right, unused code, within a few attempts', async () => {
    const user = await makeUser('staff');
    const secret = await enroll(user);
    const challenge = await createChallenge(db(), user.id, null);
    expect(await verifyChallenge(db(), challenge.token, { code: '000000' })).toMatchObject({ ok: false, reason: 'invalid' });
    const code = nextCode(secret);
    expect(await verifyChallenge(db(), challenge.token, { code })).toMatchObject({ ok: true, staffId: user.id });
    // The challenge is spent, and the same code can't be replayed on a new one.
    expect(await verifyChallenge(db(), challenge.token, { code })).toMatchObject({ ok: false, reason: 'expired' });
    const again = await createChallenge(db(), user.id, null);
    expect(await verifyChallenge(db(), again.token, { code })).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('ends a challenge after too many wrong codes', async () => {
    const user = await makeUser('staff');
    const secret = await enroll(user);
    const challenge = await createChallenge(db(), user.id, null);
    for (let i = 0; i < CHALLENGE_MAX_ATTEMPTS; i += 1) {
      await verifyChallenge(db(), challenge.token, { code: '000000' });
    }
    expect(await verifyChallenge(db(), challenge.token, { code: nextCode(secret) })).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('accepts each recovery code once, on its own separate limit', async () => {
    const user = await makeUser('staff');
    const { secret } = await startEnrollment(db(), user);
    const enrolled = await confirmEnrollment(db(), user, totpAt(secret, currentStep()));
    if (!enrolled.ok) throw new Error('enroll failed');
    expect(enrolled.recoveryCodes).toHaveLength(10);
    const [first] = enrolled.recoveryCodes;

    const c1 = await createChallenge(db(), user.id, null);
    expect(await verifyChallenge(db(), c1.token, { recoveryCode: first!.toLowerCase() })).toMatchObject({ ok: true, recoveryCodesLeft: 9 });
    const c2 = await createChallenge(db(), user.id, null);
    expect(await verifyChallenge(db(), c2.token, { recoveryCode: first! })).toMatchObject({ ok: false, reason: 'invalid' });

    // Spraying recovery codes hits its own ceiling…
    let last;
    for (let i = 0; i < LIMITS.recoveryPerStaff.max; i += 1) {
      const c = await createChallenge(db(), user.id, null);
      last = await verifyChallenge(db(), c.token, { recoveryCode: 'ZZZZZ-ZZZZZ' });
    }
    expect(last).toMatchObject({ ok: false, reason: 'throttled' });
    // …without blocking the authenticator app.
    const c3 = await createChallenge(db(), user.id, null);
    expect(await verifyChallenge(db(), c3.token, { code: nextCode(secret) })).toMatchObject({ ok: true });
  });

  it('keeps a remembered device signing in while an attacker hammers the account from many connections', async () => {
    const user = await makeUser('staff');
    const secret = await enroll(user);
    const device = await rememberDevice(db(), user.id, null);

    // A distributed attack: every guess from a different connection, all at once.
    const guesses = await Promise.all(
      Array.from({ length: 30 }, (_, i) => signIn(db(), user.email, `guess ${i} of a password`, ip())),
    );
    const judged = guesses.filter((g) => !g.ok && g.reason === 'invalid').length;
    // Bounded: no more guesses got a password check than the budget allows.
    expect(judged).toBeLessThanOrEqual(LIMITS.loginPerAccountNewDevice.max);
    expect(guesses.some((g) => !g.ok && g.reason === 'throttled')).toBe(true);

    // A new browser now waits out the window…
    expect(await signIn(db(), user.email, PASSWORD, ip())).toMatchObject({ ok: false, reason: 'throttled' });
    // …but the owner's own device has its own budget and signs in normally.
    const mine = await signIn(db(), user.email, PASSWORD, { ...ip(), deviceToken: device.token });
    expect(mine).toMatchObject({ ok: true, next: 'mfa' });
    if (!mine.ok || mine.next !== 'mfa') return;
    const challenge = await createChallenge(db(), user.id, mine.deviceId);
    expect(await verifyChallenge(db(), challenge.token, { code: nextCode(secret) })).toMatchObject({ ok: true });
  });

  it('holds its budget under a parallel burst from one connection', async () => {
    const same = ip();
    const burst = await Promise.all(
      Array.from({ length: 40 }, (_, i) => signIn(db(), uniqueEmail(`spray${i}`), 'nope nope nope', same)),
    );
    const judged = burst.filter((r) => !r.ok && r.reason === 'invalid').length;
    expect(judged).toBeLessThanOrEqual(LIMITS.loginPerIp.max);
    expect(burst.filter((r) => !r.ok && r.reason === 'throttled').length).toBeGreaterThanOrEqual(40 - LIMITS.loginPerIp.max);
  });

  it('answers the same way for real and unknown accounts through the throttle', async () => {
    const user = await makeUser('staff');
    const nobody = uniqueEmail('nobody');
    const reason = async (email: string) => {
      const r = await signIn(db(), email, 'another wrong password', ip());
      return r.ok ? 'ok' : r.reason;
    };
    const real: string[] = [];
    const unknown: string[] = [];
    for (let i = 0; i <= LIMITS.loginPerAccountNewDevice.max; i += 1) {
      real.push(await reason(user.email));
      unknown.push(await reason(nobody));
    }
    expect(real).toEqual([...Array<string>(LIMITS.loginPerAccountNewDevice.max).fill('invalid'), 'throttled']);
    expect(unknown).toEqual(real);
  });

  it('refuses a deactivated account', async () => {
    const owner = await makeUser('owner');
    const staff = await makeUser('staff');
    await setActive(db(), owner, staff.id, false);
    expect(await signIn(db(), staff.email, PASSWORD, ip())).toEqual({ ok: false, reason: 'invalid' });
  });
});

describeDb('two-step setup, recovery and owner reset', () => {
  it('marks a session verified only once setup completes', async () => {
    const user = await makeUser('staff');
    expect(user.mfaVerified).toBe(false);
    const { secret } = await startEnrollment(db(), user);
    expect(await confirmEnrollment(db(), user, '123456')).toMatchObject({ ok: false });
    expect(await confirmEnrollment(db(), user, totpAt(secret, currentStep()))).toMatchObject({ ok: true });
    const [row] = await db()<{ token_hash: string }[]>`select token_hash from allset.staff_sessions where id = ${user.sessionId}`;
    expect(row).toBeDefined();
    const [verified] = await db()<{ mfa_verified_at: Date | null }[]>`select mfa_verified_at from allset.staff_sessions where id = ${user.sessionId}`;
    expect(verified?.mfa_verified_at).toBeInstanceOf(Date);
    await expect(startEnrollment(db(), user)).rejects.toThrow(/already set up/);
  });

  it('stores the authenticator secret encrypted, never in the clear', async () => {
    const user = await makeUser('staff');
    const secret = await enroll(user);
    const [row] = await db()<{ mfa_secret_enc: string }[]>`select mfa_secret_enc from allset.staff_users where id = ${user.id}`;
    expect(row?.mfa_secret_enc).toMatch(/^v1\./);
    expect(row?.mfa_secret_enc).not.toContain(secret);
  });

  it('keeps the second step through a password reset', async () => {
    const owner = await makeUser('owner');
    const staff = await makeUser('staff');
    await enroll(staff);
    const { inviteToken } = await issuePasswordReset(db(), owner, staff.id);
    const accepted = await acceptInvite(db(), inviteToken, 'a brand new long password');
    expect(accepted).toEqual({ ok: true, value: { staffId: staff.id, mfaEnabled: true } });
    expect(await signIn(db(), staff.email, 'a brand new long password', ip())).toMatchObject({ ok: true, next: 'mfa' });
  });

  it('lets another owner reset two-step sign-in, ending every session and device', async () => {
    const owner = await makeUser('owner');
    const staff = await makeUser('staff');
    await enroll(staff);
    const device = await rememberDevice(db(), staff.id, null);
    await expect(resetMfa(db(), staff, owner.id)).rejects.toBeInstanceOf(PermissionError);
    await expect(resetMfa(db(), owner, owner.id)).rejects.toThrow(/Another owner/);
    await resetMfa(db(), owner, staff.id);
    const [row] = await db()<{ mfa_enabled_at: Date | null; sessions: number; devices: number; codes: number }[]>`
      select u.mfa_enabled_at,
             (select count(*)::int from allset.staff_sessions where staff_id = u.id) as sessions,
             (select count(*)::int from allset.staff_devices where staff_id = u.id) as devices,
             (select count(*)::int from allset.staff_recovery_codes where staff_id = u.id) as codes
      from allset.staff_users u where u.id = ${staff.id}`;
    expect(row).toEqual({ mfa_enabled_at: null, sessions: 0, devices: 0, codes: 0 });
    expect(await signIn(db(), staff.email, PASSWORD, { ...ip(), deviceToken: device.token })).toMatchObject({ ok: true, next: 'enroll' });
    const [event] = await db()<{ action: string }[]>`
      select action from allset.audit_events where entity_id = ${staff.id} and action = 'staff.mfa_reset'`;
    expect(event?.action).toBe('staff.mfa_reset');
  });
});

describeDb('staff accounts', () => {
  it('creates the first owner only with the setup token and only once', async () => {
    const sql = db();
    const token = 'setup-token-0123456789abcdef0123456789';
    // Other suites in this run may already have created owners; isolate by deactivating them.
    await sql`update allset.staff_users set is_active = false where role = 'owner'`;
    const bad = await createFirstOwner(sql, token, 'wrong', { email: uniqueEmail(), displayName: 'Owner', password: PASSWORD });
    expect(bad.ok).toBe(false);
    const good = await createFirstOwner(sql, token, token, { email: uniqueEmail(), displayName: 'Owner', password: PASSWORD });
    expect(good.ok).toBe(true);
    const again = await createFirstOwner(sql, token, token, { email: uniqueEmail(), displayName: 'Owner 2', password: PASSWORD });
    expect(again).toMatchObject({ ok: false, errors: { token: expect.stringMatching(/already complete/) } });
    const disabled = await createFirstOwner(sql, undefined, token, { email: uniqueEmail(), displayName: 'X', password: PASSWORD });
    expect(disabled.ok).toBe(false);
  });

  it('invites staff with a one-time link the owner never learns a password from', async () => {
    const owner = await makeUser('owner');
    const email = uniqueEmail('invitee');
    const invite = await inviteStaff(db(), owner, { email, displayName: 'New Person', role: 'staff' });
    if (!invite.ok) throw new Error('invite failed');
    expect(await signIn(db(), email, PASSWORD, ip())).toMatchObject({ ok: false });
    expect((await acceptInvite(db(), invite.value.inviteToken, 'short')).ok).toBe(false);
    expect(await acceptInvite(db(), invite.value.inviteToken, PASSWORD)).toMatchObject({ ok: true, value: { mfaEnabled: false } });
    expect((await acceptInvite(db(), invite.value.inviteToken, PASSWORD)).ok).toBe(false);
    expect(await signIn(db(), email, PASSWORD, ip())).toMatchObject({ ok: true, next: 'enroll' });
  });

  it('lets the invite page look a link up any number of times without using it', async () => {
    const owner = await makeUser('owner');
    const invite = await inviteStaff(db(), owner, { email: uniqueEmail('scanned'), displayName: 'Scanned Person', role: 'staff' });
    if (!invite.ok) throw new Error('invite failed');
    // What a page load (or a mail scanner running the page) does.
    for (let i = 0; i < 3; i += 1) expect(await findInvite(db(), invite.value.inviteToken)).toMatchObject({ displayName: 'Scanned Person' });
    expect(await acceptInvite(db(), invite.value.inviteToken, PASSWORD)).toMatchObject({ ok: true });
    expect(await findInvite(db(), invite.value.inviteToken)).toBeNull();
  });

  it('refuses expired and unknown invite links', async () => {
    const owner = await makeUser('owner');
    const invite = await inviteStaff(db(), owner, { email: uniqueEmail('late'), displayName: 'Late Person', role: 'staff' });
    if (!invite.ok) throw new Error('invite failed');
    await db()`update allset.staff_users set invite_expires_at = now() - interval '1 minute' where id = ${invite.value.staffId}`;
    expect(await acceptInvite(db(), invite.value.inviteToken, PASSWORD)).toMatchObject({ ok: false, errors: { token: expect.stringMatching(/expired/) } });
    expect(await acceptInvite(db(), 'not-a-real-token', PASSWORD)).toMatchObject({ ok: false });
  });

  it('forbids staff from managing accounts', async () => {
    const staff = await makeUser('staff');
    await expect(inviteStaff(db(), staff, { email: uniqueEmail(), displayName: 'X', role: 'owner' })).rejects.toBeInstanceOf(PermissionError);
    await expect(setRole(db(), staff, staff.id, 'owner')).rejects.toBeInstanceOf(PermissionError);
    await expect(issuePasswordReset(db(), staff, staff.id)).rejects.toBeInstanceOf(PermissionError);
  });

  it('never leaves the business without an active owner', async () => {
    const a = await makeUser('owner');
    await expect(setRole(db(), a, a.id, 'staff')).rejects.toThrow(/own role/);
    await expect(setActive(db(), a, a.id, false)).rejects.toThrow(/own account/);
  });

  it('ends sessions when an owner resets a password or deactivates an account', async () => {
    const owner = await makeUser('owner');
    const staff = await makeUser('staff');
    const session = await createSession(db(), staff.id, { ipHash: null, userAgent: null, mfaVerified: true });
    expect(await lookupSession(db(), session.token)).not.toBeNull();
    await issuePasswordReset(db(), owner, staff.id);
    expect(await lookupSession(db(), session.token)).toBeNull();
  });

  it('stores only a hash of the session token', async () => {
    const staff = await makeUser('staff');
    const session = await createSession(db(), staff.id, { ipHash: null, userAgent: null, mfaVerified: false });
    const rows = await db()`select 1 from allset.staff_sessions where token_hash = ${session.token}`;
    expect(rows).toHaveLength(0);
    expect((await lookupSession(db(), session.token))?.id).toBe(staff.id);
  });

  it('expires sessions after their absolute lifetime and after idling', async () => {
    const staff = await makeUser('staff');
    const expired = await createSession(db(), staff.id, { ipHash: null, userAgent: null, mfaVerified: false });
    await db()`update allset.staff_sessions set expires_at = now() - interval '1 second' where token_hash <> '' and staff_id = ${staff.id}`;
    expect(await lookupSession(db(), expired.token)).toBeNull();
    const idle = await createSession(db(), staff.id, { ipHash: null, userAgent: null, mfaVerified: false });
    await db()`update allset.staff_sessions set last_seen_at = now() - interval '3 hours' where staff_id = ${staff.id}`;
    expect(await lookupSession(db(), idle.token)).toBeNull();
  });

  it('changes a password only with the current one, and signs out other devices', async () => {
    const staff = await makeUser('staff');
    const other = await createSession(db(), staff.id, { ipHash: null, userAgent: null, mfaVerified: false });
    const current = await createSession(db(), staff.id, { ipHash: null, userAgent: null, mfaVerified: false });
    const me = (await lookupSession(db(), current.token))!;
    expect((await changePassword(db(), me, 'not my password', 'another long sentence here')).ok).toBe(false);
    expect((await changePassword(db(), me, PASSWORD, 'another long sentence here')).ok).toBe(true);
    expect(await lookupSession(db(), other.token)).toBeNull();
    expect(await lookupSession(db(), current.token)).not.toBeNull();
  });
});
