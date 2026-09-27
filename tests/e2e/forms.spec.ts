/**
 * Inquiry forms, proven against the database: what the page says was saved
 * is checked row by row.
 */

import { expect, test } from '@playwright/test';
import { closeDb, db, fillCoverage, referenceFromSuccess, TESTER_STATE, uniqueEmail, useFreshIp, waitLikeAPerson } from './helpers';

// Before launch the forms are open only to signed-in staff on a preview, with
// made-up details. Every test here runs as the synthetic preview tester.
test.use({ storageState: TESTER_STATE });

test.afterAll(async () => {
  await closeDb();
});

test('the public sees the closed notice, whatever the preview setting', async ({ browser }) => {
  const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await anonymous.newPage();
  for (const path of ['/contact', '/team']) {
    await page.goto(path);
    await expect(page.getByRole('status').filter({ hasText: /not taking/ }), path).toBeVisible();
    await expect(page.getByLabel('Full name'), path).toHaveCount(0);
  }
  await anonymous.close();
});

test('staff on a preview see that it is a test, and what they send is stored as test data', async ({ page }) => {
  await useFreshIp(page);
  const email = uniqueEmail('synthetic');
  await page.goto('/contact');
  await expect(page.getByRole('note').filter({ hasText: 'Test preview' })).toBeVisible();
  await waitLikeAPerson(page);
  await fillCoverage(page, { name: 'Made Up Person', email, zip: '60601', interest: 'Life insurance', method: 'Email' });
  await page.getByRole('button', { name: 'Send my request' }).click();
  await referenceFromSuccess(page);
  const [lead] = await db()<{ is_synthetic: boolean; state: string }[]>`select is_synthetic, state from allset.leads where email = ${email}`;
  expect(lead).toEqual({ is_synthetic: true, state: 'IL' });
});

test('coverage form: errors are summarized, focused, tied to fields, and input is kept', async ({ page }) => {
  await useFreshIp(page);
  await page.goto('/contact');
  await waitLikeAPerson(page);
  await page.getByLabel('Full name').fill('Ana Ruiz');
  await page.getByLabel('Email address', { exact: true }).fill('not-an-email');
  await page.getByRole('button', { name: 'Send my request' }).click();

  const summary = page.getByRole('alert').filter({ hasText: 'things to fix' });
  await expect(summary).toBeVisible();
  await expect(summary).toBeFocused();
  await expect(summary.getByRole('link')).toHaveCount(6);
  await expect(page.getByLabel('Email address', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByLabel('Email address', { exact: true })).toHaveAccessibleDescription(/Enter an email address like/);
  // What the person typed is still there.
  await expect(page.getByLabel('Full name')).toHaveValue('Ana Ruiz');
  await expect(page.getByLabel('Email address', { exact: true })).toHaveValue('not-an-email');
  // The consent box was never pre-checked.
  await expect(page.locator('#inquiry-consent')).not.toBeChecked();

  // Summary links move focus to the field.
  await summary.getByRole('link', { name: /ZIP code/ }).click();
  await expect(page.getByLabel('ZIP code')).toBeFocused();
});

test('coverage form: phone appears only for a call or text, and is then required', async ({ page }) => {
  await useFreshIp(page);
  await page.goto('/contact');
  const phone = page.getByRole('textbox', { name: /Phone number/ });
  await expect(phone).toBeHidden();
  await page.getByRole('radio', { name: 'Phone call' }).check();
  await expect(phone).toBeVisible();
  await page.getByRole('radio', { name: 'Email', exact: true }).check();
  await expect(phone).toBeHidden();

  await waitLikeAPerson(page);
  await fillCoverage(page, { name: 'Lee Park', email: uniqueEmail('phone-needed'), zip: '30301', interest: 'Life insurance', method: 'Text message' });
  await page.getByRole('button', { name: 'Send my request' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'thing' })).toContainText('mobile number');
  await expect(phone).toBeVisible();
});

test('coverage form: a valid request is saved with its consent before success is shown', async ({ page }) => {
  await useFreshIp(page);
  const email = uniqueEmail('saved');
  await page.goto('/contact');
  await waitLikeAPerson(page);
  await fillCoverage(page, { name: 'Grace O’Neil', email, zip: '60601-1234', interest: 'Both life and health', method: 'Phone call', phone: '(312) 555-0142' });
  await page.getByRole('button', { name: 'Send my request' }).click();
  const reference = await referenceFromSuccess(page);
  await expect(page.getByRole('heading', { name: /We have your request/ })).toBeFocused();

  const rows = await db()<{ full_name: string; zip: string; state: string; phone_e164: string; coverage_interest: string; status: string; consent_text: string; consent_version: string; consented_at: Date; consent_channels: string[]; source_path: string }[]>`
    select l.full_name, l.zip, l.state, l.phone_e164, l.coverage_interest, l.status, i.consent_text, i.consent_version,
           i.consented_at, i.consent_channels, i.source_path
    from allset.inquiries i join allset.leads l on l.id = i.lead_id where i.reference = ${reference}`;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ full_name: 'Grace O’Neil', zip: '60601', state: 'IL', phone_e164: '+13125550142', coverage_interest: 'both', status: 'new', source_path: '/contact', consent_channels: ['phone'] });
  expect(rows[0]!.consent_text).toContain('not consent to automated or prerecorded calls');
  expect(rows[0]!.consent_version).toMatch(/^coverage-v1-[0-9a-f]{10}$/);
  // The consent wording on the page is exactly what was stored.
  await page.goto('/contact');
  await expect(page.locator('label:has(#inquiry-consent)')).toContainText(rows[0]!.consent_text);
});

test('coverage form: a network failure keeps everything, and the retry saves exactly one record', async ({ page }) => {
  await useFreshIp(page);
  const email = uniqueEmail('retry');
  await page.goto('/contact');
  await waitLikeAPerson(page);
  await fillCoverage(page, { name: 'Retry Person', email, zip: '94110', interest: 'Health insurance', method: 'Email' });

  // Drop the first submission on the floor, as a flaky connection would.
  let dropped = false;
  await page.route('**/contact', async (route) => {
    if (route.request().method() === 'POST' && !dropped) {
      dropped = true;
      await route.abort('internetdisconnected');
      return;
    }
    await route.continue();
  });

  await page.getByRole('button', { name: 'Send my request' }).click();
  const problem = page.getByRole('alert').filter({ hasText: 'Receipt unconfirmed' });
  // A lost response can't tell us whether it arrived, so the page doesn't claim either way.
  await expect(problem).toBeFocused();
  await expect(problem).toContainText('didn’t get confirmation that your request reached us');
  await expect(problem).toContainText('won’t create a duplicate');
  await expect(page.getByLabel('Full name')).toHaveValue('Retry Person');
  await expect(page.getByLabel('Email address', { exact: true })).toHaveValue(email);
  await expect(page.locator('#inquiry-consent')).toBeChecked();

  await page.getByRole('button', { name: 'Send my request' }).click();
  const reference = await referenceFromSuccess(page);
  const saved = await db()`select 1 from allset.inquiries i join allset.leads l on l.id = i.lead_id where l.email = ${email}`;
  expect(saved).toHaveLength(1);
  expect(reference).toMatch(/^ASC-/);
});

test('coverage form: a slow answer shows “Receipt unconfirmed”, then the late success, and saves one record', async ({ page }) => {
  test.setTimeout(90_000);
  await useFreshIp(page);
  const email = uniqueEmail('slow');
  await page.goto('/contact');
  await waitLikeAPerson(page);
  await fillCoverage(page, { name: 'Slow Network', email, zip: '30301', state: 'GA', interest: 'Life insurance', method: 'Email' });
  // Hold the request past the page's 20-second wait, then let it through.
  await page.route('**/contact', async (route) => {
    if (route.request().method() === 'POST') await new Promise((resolve) => setTimeout(resolve, 23_000));
    await route.continue();
  });
  await page.getByRole('button', { name: 'Send my request' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Receipt unconfirmed' })).toBeVisible({ timeout: 25_000 });
  await expect(page.getByLabel('Full name')).toHaveValue('Slow Network');
  // The answer arrives after all: the page shows it, with the reference.
  const reference = await (async () => {
    await expect(page.getByRole('status').filter({ hasText: /We have your request/ })).toBeVisible({ timeout: 30_000 });
    return referenceFromSuccess(page);
  })();
  const saved = await db()<{ reference: string }[]>`
    select i.reference from allset.inquiries i join allset.leads l on l.id = i.lead_id where l.email = ${email}`;
  expect(saved).toEqual([{ reference }]);
});

test('coverage form: a double submit creates one record and one reference', async ({ page }) => {
  await useFreshIp(page);
  const email = uniqueEmail('double');
  await page.goto('/contact');
  await waitLikeAPerson(page);
  await fillCoverage(page, { name: 'Double Click', email, zip: '10001', interest: 'Not sure yet', method: 'Email' });
  const button = page.getByRole('button', { name: 'Send my request' });
  await button.dblclick();
  await referenceFromSuccess(page);
  const saved = await db()`select 1 from allset.inquiries i join allset.leads l on l.id = i.lead_id where l.email = ${email}`;
  expect(saved).toHaveLength(1);
});

test('coverage form: the same person twice becomes one lead with two requests', async ({ page }) => {
  await useFreshIp(page);
  const email = uniqueEmail('twice');
  for (const interest of ['Life insurance', 'Health insurance'] as const) {
    await page.goto('/contact');
    await waitLikeAPerson(page);
    await fillCoverage(page, { name: 'Twice Person', email, zip: '02134', interest, method: 'Email' });
    await page.getByRole('button', { name: 'Send my request' }).click();
    await referenceFromSuccess(page);
  }
  // The lead keeps what it was first told; the change waits for a person to confirm it.
  const leads = await db()<{ submission_count: number; coverage_interest: string; needs_review: boolean }[]>`
    select submission_count, coverage_interest, needs_review from allset.leads where email = ${email}`;
  expect(leads).toEqual([{ submission_count: 2, coverage_interest: 'life', needs_review: true }]);
});

test('coverage form: the hidden spam trap is answered like success and saves nothing', async ({ page }) => {
  await useFreshIp(page);
  const email = uniqueEmail('bot');
  await page.goto('/contact');
  await waitLikeAPerson(page);
  await fillCoverage(page, { name: 'Bot Bot', email, zip: '10001', interest: 'Life insurance', method: 'Email' });
  await page.locator('input[name="company_website"]').evaluate((el: HTMLInputElement) => {
    el.value = 'http://spam.example';
  });
  await page.getByRole('button', { name: 'Send my request' }).click();
  await referenceFromSuccess(page);
  const saved = await db()`select 1 from allset.leads where email = ${email}`;
  expect(saved).toHaveLength(0);
});

test('coverage form: a burst from one connection is rate-limited with input kept', async ({ page }) => {
  await useFreshIp(page);
  for (let i = 0; i < 5; i += 1) {
    await page.goto('/contact');
    await waitLikeAPerson(page);
    await fillCoverage(page, { name: 'Burst Person', email: uniqueEmail(`burst${i}`), zip: '73301', interest: 'Life insurance', method: 'Email' });
    await page.getByRole('button', { name: 'Send my request' }).click();
    await referenceFromSuccess(page);
  }
  const email = uniqueEmail('burst-limited');
  await page.goto('/contact');
  await waitLikeAPerson(page);
  await fillCoverage(page, { name: 'Burst Person', email, zip: '73301', interest: 'Life insurance', method: 'Email' });
  await page.getByRole('button', { name: 'Send my request' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'couldn’t finish sending' })).toContainText('several requests recently from this connection');
  await expect(page.getByLabel('Email address', { exact: true })).toHaveValue(email);
  expect(await db()`select 1 from allset.leads where email = ${email}`).toHaveLength(0);
});

test('team form: role disclosures come first, acknowledgment is required, and it saves separately', async ({ page }) => {
  await useFreshIp(page);
  const email = uniqueEmail('recruit');
  await page.goto('/team');
  // Disclosures appear before the form in the document.
  const order = await page.evaluate(() => {
    const disclosures = document.getElementById('role-disclosures');
    const form = document.querySelector('form');
    return disclosures && form ? disclosures.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING : 0;
  });
  expect(order).toBeTruthy();
  for (const topic of ['Licensing', 'Training', 'Pay', 'Expenses', 'Chargebacks']) {
    await expect(page.locator('#role-disclosures').getByRole('heading', { name: new RegExp(topic) }).first()).toBeVisible();
  }
  await expect(page.getByText(/not a job offer/i).first()).toBeVisible();
  await expect(page.getByText(/No income is guaranteed/i).first()).toBeVisible();

  await waitLikeAPerson(page);
  await page.getByLabel('Full name').fill('Chris Recruit');
  await page.getByLabel('Email address', { exact: true }).fill(email);
  await page.getByLabel('ZIP code').fill('85001');
  await page.getByLabel('State', { exact: true }).selectOption('AZ');
  await page.getByRole('radio', { name: /studying for the licensing exam/ }).check();
  await page.getByRole('radio', { name: 'Email', exact: true }).check();
  await page.locator('#inquiry-consent').check();
  await page.getByRole('button', { name: 'Send my team inquiry' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'thing' })).toContainText('information about this work');

  await page.locator('#inquiry-disclosure-ack').check();
  await page.getByRole('button', { name: 'Send my team inquiry' }).click();
  const reference = await referenceFromSuccess(page);
  const [row] = await db()<{ kind: string; licensing_status: string; payload: { disclosureAcknowledged: boolean }; consent_text: string }[]>`
    select l.kind, l.licensing_status, i.payload, i.consent_text from allset.inquiries i join allset.leads l on l.id = i.lead_id
    where i.reference = ${reference}`;
  expect(row).toMatchObject({ kind: 'team', licensing_status: 'studying', payload: { disclosureAcknowledged: true } });
  expect(row!.consent_text).toContain('not a job application or an offer of work');
});

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('the coverage form still validates, keeps input, and saves', async ({ page }) => {
    await useFreshIp(page);
    const email = uniqueEmail('nojs');
    await page.goto('/contact');
    await page.waitForTimeout(2200);
    await page.getByLabel('Full name').fill('No Script');
    await page.getByLabel('Email address', { exact: true }).fill(email);
    await page.getByRole('button', { name: 'Send my request' }).click();
    await expect(page.getByText(/things to fix/)).toBeVisible();
    await expect(page.getByLabel('Full name')).toHaveValue('No Script');

    await page.waitForTimeout(500);
    await fillCoverage(page, { name: 'No Script', email, zip: '97201', interest: 'Life insurance', method: 'Phone call', phone: '503-555-0100' });
    await page.getByRole('button', { name: 'Send my request' }).click();
    await expect(page.getByText(/We have your request/)).toBeVisible();
    const saved = await db()<{ phone_e164: string }[]>`select phone_e164 from allset.leads where email = ${email}`;
    expect(saved).toEqual([{ phone_e164: '+15035550100' }]);
  });
});
