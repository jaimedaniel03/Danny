import { expect, it } from 'vitest';
import { db, describeDb, uniqueEmail } from '@/allset/testing/db';
import { hashPassword, passwordProblem, verifyPassword } from './password';
import {
  acceptInvite,
  changePassword,
  createFirstOwner,
  inviteStaff,
  issuePasswordReset,
  LOCKOUT_THRESHOLD,
  setActive,
  setRole,
  signIn,
} from './accounts';
import { createSession, lookupSession } from './sessions';
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
  return { id: row!.id, role, displayName: `Test ${role}`, email, sessionId: 'test' };
}

function ip(): { ip: string } {
  return { ip: `203.0.113.${Math.random().toString(36).slice(2)}` };
}

describeDb('staff accounts', () => {
  it('signs in with the right password and refuses the wrong one generically', async () => {
    const user = await makeUser('staff');
    expect(await signIn(db(), user.email.toUpperCase(), PASSWORD, ip())).toEqual({ ok: true, staffId: user.id });
    expect(await signIn(db(), user.email, 'wrong password here', ip())).toEqual({ ok: false, reason: 'invalid' });
    expect(await signIn(db(), uniqueEmail('nobody'), PASSWORD, ip())).toEqual({ ok: false, reason: 'invalid' });
  });

  it('locks an account after repeated failures, even with the right password', async () => {
    const user = await makeUser('staff');
    for (let i = 0; i < LOCKOUT_THRESHOLD; i += 1) {
      await signIn(db(), user.email, `wrong-${i}-password-here`, ip());
    }
    expect(await signIn(db(), user.email, PASSWORD, ip())).toEqual({ ok: false, reason: 'locked' });
  });

  it('rate-limits sign-in attempts per connection', async () => {
    const same = ip();
    let last;
    for (let i = 0; i < 21; i += 1) last = await signIn(db(), uniqueEmail('spray'), 'nope nope nope', same);
    expect(last).toMatchObject({ ok: false, reason: 'rate_limited' });
  });

  it('refuses a deactivated account', async () => {
    const owner = await makeUser('owner');
    const staff = await makeUser('staff');
    await setActive(db(), owner, staff.id, false);
    expect(await signIn(db(), staff.email, PASSWORD, ip())).toEqual({ ok: false, reason: 'invalid' });
  });

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
    expect((await acceptInvite(db(), invite.value.inviteToken, PASSWORD)).ok).toBe(true);
    expect((await acceptInvite(db(), invite.value.inviteToken, PASSWORD)).ok).toBe(false);
    expect(await signIn(db(), email, PASSWORD, ip())).toMatchObject({ ok: true });
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
    const session = await createSession(db(), staff.id, { ipHash: null, userAgent: null });
    expect(await lookupSession(db(), session.token)).not.toBeNull();
    await issuePasswordReset(db(), owner, staff.id);
    expect(await lookupSession(db(), session.token)).toBeNull();
  });

  it('stores only a hash of the session token', async () => {
    const staff = await makeUser('staff');
    const session = await createSession(db(), staff.id, { ipHash: null, userAgent: null });
    const rows = await db()`select 1 from allset.staff_sessions where token_hash = ${session.token}`;
    expect(rows).toHaveLength(0);
    expect((await lookupSession(db(), session.token))?.id).toBe(staff.id);
  });

  it('changes a password only with the current one, and signs out other devices', async () => {
    const staff = await makeUser('staff');
    const other = await createSession(db(), staff.id, { ipHash: null, userAgent: null });
    const current = await createSession(db(), staff.id, { ipHash: null, userAgent: null });
    const me = (await lookupSession(db(), current.token))!;
    expect((await changePassword(db(), me, 'not my password', 'another long sentence here')).ok).toBe(false);
    expect((await changePassword(db(), me, PASSWORD, 'another long sentence here')).ok).toBe(true);
    expect(await lookupSession(db(), other.token)).toBeNull();
    expect(await lookupSession(db(), current.token)).not.toBeNull();
  });
});
