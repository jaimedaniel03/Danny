/**
 * The private lead desk: authentication, the permission boundary, and every
 * lead workflow — run in order, as one owner and one staff member would.
 */

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import {
  closeDb,
  confirmationToken,
  db,
  enrollTwoStep,
  fillCoverage,
  freshCode,
  referenceFromSuccess,
  searchLeads,
  signInWithCode,
  TESTER_STATE,
  uniqueEmail,
  useFreshIp,
  waitLikeAPerson,
} from './helpers';

test.describe.configure({ mode: 'serial' });

const SETUP_TOKEN = process.env['E2E_SETUP_TOKEN'] ?? '';
const OWNER = { name: 'Olivia Owner', email: uniqueEmail('owner'), password: 'olivia kitchen table long password' };
const STAFF = { name: 'Sam Staff', email: uniqueEmail('staff'), password: 'sam front porch long password' };

let ownerContext: BrowserContext;
let owner: Page;
let staffContext: BrowserContext;
let staff: Page;
let inviteLink = '';
let ownerSecret = '';
let staffSecret = '';
let staffRecoveryCodes: readonly string[] = [];
const leads: { reference: string; email: string }[] = [];

/** Leads come in through the form, sent by the synthetic preview tester (staff-only before launch). */
async function submitLead(browser: Browser, name: string): Promise<{ reference: string; email: string }> {
  const context = await browser.newContext({ storageState: TESTER_STATE });
  const page = await context.newPage();
  await useFreshIp(page);
  const email = uniqueEmail('desk');
  await page.goto('/contact');
  await waitLikeAPerson(page);
  await fillCoverage(page, { name, email, zip: '60601', interest: 'Life insurance', method: 'Phone call', phone: '312-555-0177' });
  await page.getByRole('button', { name: 'Send my request' }).click();
  const reference = await referenceFromSuccess(page);
  await context.close();
  return { reference, email };
}

async function openLead(page: Page, reference: string): Promise<void> {
  await searchLeads(page, reference);
  await page.locator('.data-table a').first().click();
  await expect(page).toHaveURL(/\/admin\/leads\/[0-9a-f-]{36}$/);
}

test.afterAll(async () => {
  await ownerContext?.close();
  await staffContext?.close();
  await closeDb();
});

test('anonymous visitors are kept out of every private page and endpoint', async ({ page, request }) => {
  for (const path of ['/admin', '/admin/leads', '/admin/team', '/admin/alerts', '/admin/audit', '/admin/launch', '/admin/account', '/admin/leads/00000000-0000-4000-8000-000000000000']) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/admin\/login\?next=/);
  }
  const origin = new URL(page.url()).origin;
  const exported = await request.post('/api/admin/export', { headers: { origin }, form: { status: 'all' } });
  expect(exported.status(), `${origin} → ${await exported.text()}`).toBe(401);
  const crossSite = await request.post('/api/admin/export', { headers: { origin: 'https://evil.example' }, form: {} });
  expect(crossSite.status()).toBe(403);
  const cron = await request.get('/api/cron/retention');
  expect(cron.status()).toBe(401);
  const hook = await request.post('/api/webhooks/resend', { data: '{}' });
  expect([401, 503]).toContain(hook.status());
  // Private pages are never indexed or cached.
  const login = await request.get('/admin/login');
  expect(login.headers()['x-robots-tag']).toContain('noindex');
  expect(login.headers()['cache-control']).toContain('no-store');
  expect(login.headers()['content-security-policy']).toMatch(/'nonce-[^']+' 'strict-dynamic'/);
});

test('the first owner is created with the setup code, and setup then closes', async ({ browser }) => {
  ownerContext = await browser.newContext();
  owner = await ownerContext.newPage();
  await useFreshIp(owner);
  await owner.goto('/admin/setup');
  await owner.getByLabel('Setup code').fill('wrong-code');
  await owner.getByLabel('Your name').fill(OWNER.name);
  await owner.getByLabel('Email').fill(OWNER.email);
  await owner.getByLabel('Password').fill(OWNER.password);
  await owner.getByRole('button', { name: 'Create owner account' }).click();
  await expect(owner.getByText('That setup code isn’t right.')).toBeVisible();

  await owner.getByLabel('Setup code').fill(SETUP_TOKEN);
  await owner.getByLabel('Your name').fill(OWNER.name);
  await owner.getByLabel('Email').fill(OWNER.email);
  await owner.getByLabel('Password').fill(OWNER.password);
  await owner.getByRole('button', { name: 'Create owner account' }).click();
  // Nothing else is reachable until two-step sign-in is set up.
  await expect(owner).toHaveURL(/\/admin\/two-step$/);
  await owner.goto('/admin/leads');
  await expect(owner).toHaveURL(/\/admin\/two-step$/);
  ownerSecret = (await enrollTwoStep(owner)).secret;
  await expect(owner.locator('h1')).toHaveText('Today');

  const anon = await browser.newPage();
  await anon.goto('/admin/setup');
  await expect(anon.getByText(/Setup is closed/)).toBeVisible();
  await anon.close();

  // The owner can now sign in anywhere with the password and a code.
  const elsewhere = await browser.newContext();
  const second = await elsewhere.newPage();
  await useFreshIp(second);
  await signInWithCode(second, OWNER.email, OWNER.password, ownerSecret);
  await expect(second.locator('h1')).toHaveText('Today');
  // A full sign-in remembers the browser: its own sign-in budget from now on.
  const device = (await elsewhere.cookies()).find((c) => c.name.includes('asc_device'));
  expect(device).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict' });
  expect(device!.name.startsWith('__Host-')).toBe(true);
  await elsewhere.close();
});

test('the session cookie is HttpOnly, SameSite=Lax, and host-only', async () => {
  const cookies = await ownerContext.cookies();
  const session = cookies.find((c) => c.name.includes('asc_session'));
  expect(session).toBeDefined();
  expect(session!.httpOnly).toBe(true);
  expect(session!.sameSite).toBe('Lax');
  expect(session!.name.startsWith('__Host-')).toBe(true);
  expect(session!.secure).toBe(true);
});

test('wrong credentials are refused with one generic message', async ({ page }) => {
  await useFreshIp(page);
  await page.goto('/admin/login');
  await page.getByLabel('Email').fill(OWNER.email);
  await page.getByLabel('Password').fill('not the password at all');
  await page.getByRole('button', { name: 'Sign in' }).click();
  const problem = page.locator('.notice--error[role="alert"]');
  await expect(problem).toHaveText('That email and password don’t match an active account.');
  await page.getByLabel('Email').fill('nobody@example.com');
  await page.getByLabel('Password').fill('not the password at all');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(problem).toHaveText('That email and password don’t match an active account.');
});

test('the owner sees that alerts are not configured, and a failed alert is listed with its reason', async () => {
  await expect(owner.getByText('New-inquiry alerts need attention')).toBeVisible();
  await owner.goto('/admin/alerts');
  await expect(owner.getByText('Email is not configured on this deployment')).toBeVisible();
  await owner.getByLabel('Email address', { exact: true }).fill(uniqueEmail('alerts'));
  await owner.getByRole('button', { name: 'Add and send confirmation' }).click();
  await expect(owner.getByText(/A confirmation email is on its way/)).toBeVisible();
  await expect
    .poll(async () => {
      await owner.reload();
      return owner.locator('.data-table').innerText().catch(() => '');
    }, { timeout: 15_000 })
    .toMatch(/Failed[\s\S]*not configured/);
});

test('the owner invites a staff member, who sets their own password', async ({ browser }) => {
  await owner.goto('/admin/team');
  const inviteForm = owner.getByRole('form', { name: 'Invite a team member' });
  await inviteForm.getByLabel('Name').fill(STAFF.name);
  await inviteForm.getByLabel('Email').fill(STAFF.email);
  await inviteForm.getByLabel('Role').selectOption('staff');
  await inviteForm.getByRole('button', { name: 'Create account and get link' }).click();
  inviteLink = (await inviteForm.getByLabel('One-time link').innerText()).trim();
  // The token rides in the fragment, so it never reaches a server log or a Referer header.
  expect(inviteLink).toMatch(/\/admin\/invite#token=/);

  // A mail scanner (or a preview pane) that opens the link, scripts and all, doesn't use it up.
  const scanner = await browser.newPage();
  await scanner.goto(new URL(inviteLink).pathname + new URL(inviteLink).hash);
  await expect(scanner.getByText(`Welcome, ${STAFF.name}`)).toBeVisible();
  await scanner.close();

  staffContext = await browser.newContext();
  staff = await staffContext.newPage();
  await useFreshIp(staff);
  await staff.goto(new URL(inviteLink).pathname + new URL(inviteLink).hash);
  // The token is stripped from the address bar once read.
  await expect(staff.getByLabel('New password')).toBeVisible();
  expect(new URL(staff.url()).hash).toBe('');
  await staff.getByLabel('New password').fill(STAFF.password);
  await staff.getByLabel('Type it again').fill(STAFF.password);
  await staff.getByRole('button', { name: 'Set password and sign in' }).click();
  const enrolled = await enrollTwoStep(staff);
  staffSecret = enrolled.secret;
  staffRecoveryCodes = enrolled.recoveryCodes;
  expect(staffRecoveryCodes).toHaveLength(10);
  await expect(staff.getByText(`${STAFF.name} · Staff`)).toBeVisible();

  // The link works once.
  const reuse = await browser.newPage();
  await reuse.goto(new URL(inviteLink).pathname + new URL(inviteLink).hash);
  await expect(reuse.getByText(/expired or was already used/)).toBeVisible();
  await reuse.goto('/admin/invite#token=not-a-real-token');
  await expect(reuse.getByText(/expired or was already used/)).toBeVisible();
  await reuse.close();
});

test('signing in takes the password and then a fresh code; a wrong code is refused', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await useFreshIp(page);
  await page.goto('/admin/login');
  await page.getByLabel('Email').fill(STAFF.email);
  await page.getByLabel('Password').fill(STAFF.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/admin\/login\/verify/);
  // The password alone opens nothing.
  await page.goto('/admin/leads');
  await expect(page).toHaveURL(/\/admin\/login/);
  await page.goto('/admin/login/verify');
  await page.getByLabel('6-digit code').fill('000000');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'That code isn’t right' })).toBeVisible();
  await page.getByLabel('6-digit code').fill(await freshCode(staffSecret));
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await context.close();
});

test('a recovery code signs in once, and says how many are left', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await useFreshIp(page);
  await page.goto('/admin/login');
  await page.getByLabel('Email').fill(STAFF.email);
  await page.getByLabel('Password').fill(STAFF.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByText('Use a recovery code instead').click();
  await page.getByLabel('Recovery code').fill(staffRecoveryCodes[0]!);
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page).toHaveURL(/\/admin\/two-step\?recovery_used=9/);
  await expect(page.getByText(/signed in with a recovery code/)).toBeVisible();
  await context.close();

  const again = await browser.newContext();
  const retry = await again.newPage();
  await useFreshIp(retry);
  await retry.goto('/admin/login');
  await retry.getByLabel('Email').fill(STAFF.email);
  await retry.getByLabel('Password').fill(STAFF.password);
  await retry.getByRole('button', { name: 'Sign in' }).click();
  await retry.getByText('Use a recovery code instead').click();
  await retry.getByLabel('Recovery code').fill(staffRecoveryCodes[0]!);
  await retry.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(retry.getByRole('alert').filter({ hasText: 'isn’t valid or was already used' })).toBeVisible();
  await again.close();
});

test('staff cannot reach owner pages or owner endpoints', async () => {
  for (const path of ['/admin/team', '/admin/alerts', '/admin/audit', '/admin/launch']) {
    await staff.goto(path);
    await expect(staff, path).toHaveURL(/\/admin\?notice=owner-only$/);
    await expect(staff.getByText('That page is for owners only.')).toBeVisible();
  }
  await expect(staff.getByRole('navigation', { name: 'Lead desk' }).getByRole('link')).toHaveText(['Today', 'Leads', 'Account']);
  const origin = new URL(staff.url()).origin;
  const res = await staff.request.post('/api/admin/export', { headers: { origin }, form: { status: 'all' } });
  expect(res.status()).toBe(403);
});

test('staff see unassigned leads, claim one, and work it', async ({ browser }) => {
  leads.push(await submitLead(browser, 'Unclaimed Family'));
  await staff.goto('/admin/leads?assigned=unassigned');
  await expect(staff.getByRole('link', { name: 'Unclaimed Family' }).first()).toBeVisible();
  await openLead(staff, leads[0]!.reference);
  await expect(staff.getByText('Claim this lead to add notes.')).toBeVisible();
  await staff.getByRole('button', { name: 'Claim this lead' }).click();
  await expect(staff.getByText('Lead assigned to you.')).toBeVisible();
  await staff.reload();

  await staff.getByLabel('Status', { exact: true }).selectOption('contacted');
  await staff.getByRole('button', { name: 'Save status' }).click();
  await expect(staff.getByText('Status updated.')).toBeVisible();

  await staff.getByLabel('Follow up on', { exact: true }).fill('2031-03-04');
  await staff.getByRole('button', { name: 'Save date' }).click();
  await expect(staff.getByText('Follow-up date saved.')).toBeVisible();

  await staff.getByRole('textbox', { name: 'Add a note' }).fill('Spoke on the phone. Sending a comparison Tuesday.');
  await staff.getByRole('button', { name: 'Save note' }).click();
  await expect(staff.getByText('Note saved.')).toBeVisible();

  await staff.reload();
  await expect(staff.getByText('Spoke on the phone. Sending a comparison Tuesday.')).toBeVisible();
  const history = staff.locator('#history-title').locator('..');
  for (const entry of ['Claimed', 'Status changed', 'Follow-up scheduled', 'Note added', 'Inquiry received']) {
    await expect(history).toContainText(entry);
  }
  // The consent record is on the lead.
  await expect(staff.getByText(/Agreed .* to wording version/)).toBeVisible();
  await expect(staff.getByRole('button', { name: /Delete this lead/ })).toHaveCount(0);
});

test('a server action replayed from another site is refused and changes nothing', async () => {
  // Same signed-in browser, same form, same action id: only the Origin says another site sent it.
  await openLead(staff, leads[0]!.reference);
  const probe = `Cross-site probe ${Date.now()}`;
  await staff.route('**/admin/leads/**', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    return route.continue({ headers: { ...route.request().headers(), origin: 'https://evil.example' } });
  });
  const answer = staff.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/admin/leads/'));
  await staff.getByRole('textbox', { name: 'Add a note' }).fill(probe);
  await staff.getByRole('button', { name: 'Save note' }).click();
  const response = await answer;
  expect(response.status()).toBeGreaterThanOrEqual(400);
  await staff.unroute('**/admin/leads/**');

  await staff.reload();
  await expect(staff.getByText(probe)).toHaveCount(0);
  const stored = await db()`select count(*)::int as n from allset.lead_notes where body = ${probe}`;
  expect(stored[0]!.n).toBe(0);
});

test('a lead assigned to someone else is invisible to staff', async ({ browser }) => {
  leads.push(await submitLead(browser, 'Owner Family'));
  await openLead(owner, leads[1]!.reference);
  await owner.getByLabel('Assigned to', { exact: true }).selectOption({ label: OWNER.name });
  await owner.getByRole('button', { name: 'Save assignment' }).click();
  await expect(owner.getByText('Lead assigned to you.')).toBeVisible();
  const leadUrl = owner.url();

  await searchLeads(staff, leads[1]!.reference);
  await expect(staff.getByText('No leads match.')).toBeVisible();
  const response = await staff.goto(new URL(leadUrl).pathname);
  expect(response?.status()).toBe(404);
});

test('the owner searches, filters, reassigns and exports', async () => {
  await owner.goto('/admin/leads');
  await owner.getByLabel('Search').fill(leads[0]!.email);
  await owner.getByLabel('Status').selectOption('all');
  await owner.getByRole('button', { name: 'Apply' }).click();
  await expect(owner.getByRole('link', { name: 'Unclaimed Family' })).toBeVisible();

  // The search text never appears in the address bar (or the server's request logs).
  expect(owner.url()).not.toContain(encodeURIComponent(leads[0]!.email));
  expect(owner.url()).not.toContain(leads[0]!.email);

  await searchLeads(owner, leads[0]!.reference, { assigned: 'unassigned' });
  await expect(owner.getByText('No leads match.')).toBeVisible();

  await owner.goto('/admin/leads?status=all');
  const downloadPromise = owner.waitForEvent('download');
  await owner.getByRole('button', { name: 'Export these as CSV' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^all-set-check-leads-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = readFileSync(await download.path(), 'utf8');
  expect(csv).toContain('Reference,Kind,Status');
  expect(csv).toContain(leads[0]!.reference);
});

test('a repeat request with new details is held for review until the owner confirms it', async ({ browser }) => {
  const first = await submitLead(browser, 'Changed Family');
  const context = await browser.newContext({ storageState: TESTER_STATE });
  const page = await context.newPage();
  await useFreshIp(page);
  await page.goto('/contact');
  await waitLikeAPerson(page);
  await fillCoverage(page, { name: 'Changed Family', email: first.email, zip: '60601', interest: 'Health insurance', method: 'Text message', phone: '312-555-0188' });
  await page.getByRole('button', { name: 'Send my request' }).click();
  const second = await referenceFromSuccess(page);
  await context.close();

  await openLead(owner, first.reference);
  await expect(owner.getByText('A later request has different details.')).toBeVisible();
  // Still the original phone until someone confirms the change.
  await expect(owner.locator('section[aria-labelledby="contact-title"]')).toContainText('(312) 555-0177');

  await owner.getByRole('form', { name: `Use details from ${second}` }).getByRole('button', { name: 'Use these details' }).click();
  // The button that was used is gone, so the confirmation is announced and takes focus.
  const done = owner.getByRole('status').filter({ hasText: 'Contact details updated from that request.' });
  await expect(done).toBeVisible();
  await expect(done).toBeFocused();
  await expect(owner.getByText('A later request has different details.')).toBeHidden();
  const [row] = await db()<{ phone_e164: string; contact_method: string; coverage_interest: string; needs_review: boolean }[]>`
    select phone_e164, contact_method, coverage_interest, needs_review from allset.leads where email = ${first.email}`;
  expect(row).toEqual({ phone_e164: '+13125550188', contact_method: 'text', coverage_interest: 'health', needs_review: false });
});

test('the owner deletes a lead only after typing its reference, and the audit log records it', async () => {
  await openLead(owner, leads[1]!.reference);
  await owner.getByLabel(/Type the reference/).fill('ASC-0000-0000');
  await owner.getByRole('button', { name: 'Delete this lead' }).click();
  await expect(owner.getByText(/Type one of this lead’s reference numbers exactly/)).toBeVisible();
  await owner.getByLabel(/Type the reference/).fill(leads[1]!.reference);
  await owner.getByRole('button', { name: 'Delete this lead' }).click();
  await expect(owner).toHaveURL(/\/admin\/leads\?deleted=/);
  await expect(owner.getByText(`Lead ${leads[1]!.reference} and its records were permanently deleted.`)).toBeVisible();
  expect(await db()`select 1 from allset.inquiries where reference = ${leads[1]!.reference}`).toHaveLength(0);

  await owner.goto('/admin/audit?area=lead');
  await expect(owner.locator('.data-table')).toContainText('Deleted');
  await expect(owner.locator('.data-table')).toContainText(leads[1]!.reference);
  await expect(owner.locator('.data-table')).not.toContainText(leads[1]!.email);
  await owner.goto('/admin/audit?area=export');
  await expect(owner.locator('.data-table')).toContainText('Leads exported');
});

test('every lead desk page passes axe WCAG 2.2 AA, for owner and staff', async () => {
  const tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];
  const check = async (page: Page, path: string) => {
    await page.goto(path);
    const results = await new AxeBuilder({ page: page as never }).withTags(tags).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' | ')}`), path).toEqual([]);
  };
  for (const path of ['/admin', '/admin/leads', '/admin/leads?status=all', '/admin/team', '/admin/alerts', '/admin/audit', '/admin/launch', '/admin/account']) {
    await check(owner, path);
  }
  await openLead(owner, leads[0]!.reference);
  await check(owner, new URL(owner.url()).pathname);
  await check(staff, '/admin');
  await check(staff, '/admin/leads');
  await openLead(staff, leads[0]!.reference);
  await check(staff, new URL(staff.url()).pathname);
  // Narrow screens: the tables stack into rows.
  await owner.setViewportSize({ width: 375, height: 800 });
  await check(owner, '/admin/leads?status=all');
  const overflow = await owner.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await owner.setViewportSize({ width: 1280, height: 900 });
});

test('staff password changes sign out other devices; sign-out ends the session', async ({ browser }) => {
  const second = await browser.newContext();
  const other = await second.newPage();
  await useFreshIp(other);
  await signInWithCode(other, STAFF.email, STAFF.password, staffSecret);

  await staff.goto('/admin/account');
  await staff.getByLabel('Current password').fill(STAFF.password);
  await staff.getByLabel('New password').fill('sam new longer password here');
  await staff.getByLabel('Type it again').fill('sam new longer password here');
  await staff.getByRole('button', { name: 'Change password' }).click();
  await expect(staff.getByText('Password changed. Any other devices were signed out.')).toBeVisible();

  await other.goto('/admin/leads');
  await expect(other).toHaveURL(/\/admin\/login/);
  await second.close();

  await staff.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(staff).toHaveURL(/\/admin\/login\?signed_out=1/);
  // Nothing personal is left in the browser: no session, no remembered search.
  const leftover = (await staffContext.cookies()).filter((c) => /asc_(session|lead_q)/.test(c.name) && c.value);
  expect(leftover).toEqual([]);
  await staff.goto('/admin');
  await expect(staff).toHaveURL(/\/admin\/login/);
});

test('an owner-issued password reset still needs the second step', async ({ browser }) => {
  await owner.goto('/admin/team');
  const form = owner.getByRole('form', { name: `Reset password for ${STAFF.name}` });
  await form.getByRole('button', { name: 'Issue reset link' }).click();
  const link = (await form.getByLabel('One-time link').innerText()).trim();
  expect(link).toMatch(/\/admin\/invite#token=/);

  const context = await browser.newContext();
  const page = await context.newPage();
  await useFreshIp(page);
  await page.goto(new URL(link).pathname + new URL(link).hash);
  await page.getByLabel('New password').fill('sam reset long password here');
  await page.getByLabel('Type it again').fill('sam reset long password here');
  await page.getByRole('button', { name: 'Set password and sign in' }).click();
  // The link alone is not a sign-in: the code is still required.
  await expect(page).toHaveURL(/\/admin\/login\?password_set=1/);
  await expect(page.getByText(/new password is set/)).toBeVisible();
  await signInWithCode(page, STAFF.email, 'sam reset long password here', staffSecret);
  await expect(page.getByText(`${STAFF.name} · Staff`)).toBeVisible();
  await context.close();
});

test('an owner resets someone’s two-step sign-in, and they set it up again', async ({ browser }) => {
  await owner.goto('/admin/team');
  await owner.getByRole('form', { name: `Reset two-step sign-in for ${STAFF.name}` }).getByRole('button', { name: 'Reset two-step sign-in' }).click();
  const done = owner.getByRole('status').filter({ hasText: /Two-step sign-in was reset/ });
  await expect(done).toBeVisible();
  await expect(done).toBeFocused();

  const context = await browser.newContext();
  const page = await context.newPage();
  await useFreshIp(page);
  await page.goto('/admin/login');
  await page.getByLabel('Email').fill(STAFF.email);
  await page.getByLabel('Password').fill('sam reset long password here');
  await page.getByRole('button', { name: 'Sign in' }).click();
  staffSecret = (await enrollTwoStep(page)).secret;
  await context.close();
});

test('alert-confirmation links: loading never confirms, the button does once, bad or old links are refused', async ({ browser }) => {
  const address = uniqueEmail('confirm-me');
  await owner.goto('/admin/alerts');
  await owner.getByLabel('Email address', { exact: true }).fill(address);
  await owner.getByRole('button', { name: 'Add and send confirmation' }).click();
  await expect(owner.getByText(/A confirmation email is on its way/)).toBeVisible();
  // Email isn't configured here, so read the link the app derived for that email instead.
  let notificationId = '';
  await expect
    .poll(async () => {
      const [row] = await db()<{ id: string; hash: string | null }[]>`
        select n.id, r.confirm_token_hash as hash from allset.notifications n
        join allset.notification_recipients r on r.id = n.recipient_id
        where lower(r.email) = lower(${address}) and n.kind = 'recipient_confirmation'`;
      notificationId = row?.hash ? row.id : '';
      return notificationId;
    }, { timeout: 15_000 })
    .not.toBe('');
  const token = confirmationToken(notificationId);
  const confirmed = async () =>
    (await db()<{ confirmed_at: Date | null }[]>`select confirmed_at from allset.notification_recipients where lower(email) = lower(${address})`)[0]?.confirmed_at ?? null;

  const context = await browser.newContext();
  const page = await context.newPage();
  // Each visit is a fresh page load, as clicking a link in an email is. (Changing only the
  // #fragment of the current address would not reload the page.)
  const open = async (link: string) => {
    await page.goto('about:blank');
    await page.goto(link);
  };
  const confirmButton = page.getByRole('button', { name: 'Yes, send me new-inquiry alerts' });
  // Opening the link (what a mail scanner does) changes nothing, however often.
  await open(`/admin/confirm-alert#token=${token}`);
  await expect(confirmButton).toBeVisible();
  await open(`/admin/confirm-alert#token=${token}`);
  await expect(confirmButton).toBeVisible();
  expect(await confirmed()).toBeNull();
  // Under the production CSP, the page's script read the token and the button works.
  await confirmButton.click();
  await expect(page.getByText(/Confirmed\. This address will now receive an email/)).toBeVisible();
  expect(await confirmed()).toBeInstanceOf(Date);
  // Used once.
  await open(`/admin/confirm-alert#token=${token}`);
  await confirmButton.click();
  await expect(page.getByRole('alert').filter({ hasText: 'expired or was already used' })).toBeVisible();
  // Made up.
  await open('/admin/confirm-alert#token=not-a-real-token');
  await confirmButton.click();
  await expect(page.getByRole('alert').filter({ hasText: 'expired or was already used' })).toBeVisible();
  // Expired: a fresh link whose time has run out.
  await db()`update allset.notification_recipients set confirmed_at = null, confirm_expires_at = now() - interval '1 minute', confirm_token_hash = encode(sha256(${token}::bytea), 'hex') where lower(email) = lower(${address})`;
  await open(`/admin/confirm-alert#token=${token}`);
  await confirmButton.click();
  await expect(page.getByRole('alert').filter({ hasText: 'expired or was already used' })).toBeVisible();
  expect(await confirmed()).toBeNull();
  await context.close();
  // Stop alerting this test address.
  await db()`update allset.notification_recipients set disabled_at = now() where lower(email) = lower(${address})`;
});

test('exports are limited per owner, and the limit answers 429 with Retry-After', async () => {
  const origin = new URL(owner.url()).origin;
  let last = 0;
  let retryAfter: string | undefined;
  for (let i = 0; i < 12 && last !== 429; i += 1) {
    const res = await owner.request.post('/api/admin/export', { headers: { origin }, form: { status: 'all' } });
    last = res.status();
    retryAfter = res.headers()['retry-after'];
  }
  expect(last).toBe(429);
  expect(Number(retryAfter)).toBeGreaterThan(0);
});

test('the launch checklist shows the site is not ready and why', async () => {
  await owner.goto('/admin/launch');
  await expect(owner.getByText('Not ready for public launch: required business facts are missing.')).toBeVisible();
  await expect(owner.getByText(/Registered legal entity name/)).toBeVisible();
  await expect(owner.getByText(/Team role terms/)).toBeVisible();
});
