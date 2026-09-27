/**
 * Creates the synthetic preview tester (a staff account, made directly in the
 * test database) and signs it in through the real two-step flow, saving the
 * browser state the form tests reuse.
 */

import { test as setup } from '@playwright/test';
import { closeDb, db, enrollTwoStep, scryptHash, TESTER, TESTER_STATE, useFreshIp } from './helpers';

setup('sign in the preview tester', async ({ page }) => {
  await db()`
    insert into allset.staff_users (email, display_name, role, password_hash)
    values (${TESTER.email}, ${TESTER.name}, 'staff', ${scryptHash(TESTER.password)})
    on conflict do nothing`;
  await useFreshIp(page);
  await page.goto('/admin/login');
  await page.getByLabel('Email').fill(TESTER.email);
  await page.getByLabel('Password').fill(TESTER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await enrollTwoStep(page);
  await page.context().storageState({ path: TESTER_STATE });
  await closeDb();
});
