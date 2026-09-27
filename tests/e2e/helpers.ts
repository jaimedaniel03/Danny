import { expect, type Page } from '@playwright/test';
import { createHmac, randomBytes, scryptSync } from 'node:crypto';
import postgres from 'postgres';

export const PUBLIC_ROUTES = ['/', '/coverage', '/story', '/team', '/contact', '/privacy', '/terms'] as const;

let sql: postgres.Sql | null = null;
/** Direct database access, to prove what the UI claims was saved really was. */
export function db(): postgres.Sql {
  const url = process.env['E2E_DATABASE_URL'];
  if (!url) throw new Error('E2E_DATABASE_URL is not set');
  sql ??= postgres(url, { max: 2, onnotice: () => {} });
  return sql;
}

export async function closeDb(): Promise<void> {
  await sql?.end({ timeout: 5 });
  sql = null;
}

let ipCounter = 0;
/**
 * Each test submits from its own address, so per-IP rate limits don't bleed
 * between tests. The app trusts x-real-ip here only because the e2e server
 * runs with TRUST_PROXY_IP_HEADERS=true (on Vercel, the edge sets it).
 */
export async function useFreshIp(page: Page): Promise<string> {
  ipCounter += 1;
  const ip = `10.${(process.pid % 250) + 1}.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;
  await page.setExtraHTTPHeaders({ 'x-real-ip': ip });
  return ip;
}

let emailCounter = 0;
export function uniqueEmail(label: string): string {
  emailCounter += 1;
  return `${label}.${Date.now().toString(36)}.${emailCounter}@example.com`;
}

export interface CoverageInput {
  readonly name: string;
  readonly email: string;
  readonly zip: string;
  readonly state?: string;
  readonly interest: 'Life insurance' | 'Health insurance' | 'Both life and health' | 'Not sure yet';
  readonly method: 'Email' | 'Phone call' | 'Text message';
  readonly phone?: string;
  readonly consent?: boolean;
}

/** The form rejects submissions faster than 2s after render; wait it out like a person would. */
export async function waitLikeAPerson(page: Page): Promise<void> {
  await page.waitForTimeout(2200);
}

export async function fillCoverage(page: Page, input: CoverageInput): Promise<void> {
  await page.getByLabel('Full name').fill(input.name);
  await page.getByLabel('Email address', { exact: true }).fill(input.email);
  await page.getByLabel('ZIP code').fill(input.zip);
  await page.getByLabel('State', { exact: true }).selectOption(input.state ?? 'IL');
  await page.getByRole('radio', { name: input.interest, exact: true }).check();
  await page.getByRole('radio', { name: input.method, exact: true }).check();
  if (input.phone !== undefined) await page.getByRole('textbox', { name: /Phone number/ }).fill(input.phone);
  if (input.consent !== false) await page.locator('#inquiry-consent').check();
}

export async function referenceFromSuccess(page: Page): Promise<string> {
  const text = await page.getByRole('status').filter({ hasText: /We have your (request|inquiry)/ }).innerText();
  const match = text.match(/ASC-[0-9A-Z]{4}-[0-9A-Z]{4}/);
  if (!match) throw new Error(`No reference in: ${text}`);
  return match[0];
}

/**
 * Search the lead desk the way staff do: through the form. The search text
 * travels in a cookie, never the URL.
 */
export async function searchLeads(
  page: Page,
  q: string,
  filters: { readonly status?: string; readonly assigned?: string } = {},
): Promise<void> {
  await page.goto('/admin/leads');
  await page.getByLabel('Search').fill(q);
  await page.getByLabel('Status').selectOption(filters.status ?? 'all');
  if (filters.assigned) await page.getByLabel('Assigned', { exact: true }).selectOption(filters.assigned);
  await page.getByRole('button', { name: 'Apply' }).click();
  await page.waitForURL(/\/admin\/leads\?.*search=1/);
}

// ── Two-step sign-in ─────────────────────────────────────────────────────

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text.toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 6238 code for a time step, computed independently of the app's own implementation. */
export function totpAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  return ((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}

const usedSteps = new Map<string, number>();

/**
 * A code the server hasn't seen: it refuses any time step at or before the
 * last one used, as it should. When the whole ±1 window is used up, wait for
 * the clock, like a person would.
 */
export async function freshCode(secret: string): Promise<string> {
  for (;;) {
    const now = Math.floor(Date.now() / 30_000);
    const last = usedSteps.get(secret) ?? -Infinity;
    for (const step of [now - 1, now, now + 1]) {
      if (step > last) {
        usedSteps.set(secret, step);
        return totpAt(secret, step);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

export interface Enrollment {
  readonly secret: string;
  readonly recoveryCodes: readonly string[];
}

/** From the two-step setup page (where a new account lands), through to the lead desk. */
export async function enrollTwoStep(page: Page): Promise<Enrollment> {
  await expect(page).toHaveURL(/\/admin\/two-step/);
  await page.getByRole('button', { name: 'Set up two-step sign-in' }).click();
  const key = page.locator('.secret-key');
  await expect(key).toBeVisible();
  const secret = (await key.innerText()).replace(/\s/g, '');
  await page.getByLabel('6-digit code from the app').fill(await freshCode(secret));
  await page.getByRole('button', { name: 'Turn on two-step sign-in' }).click();
  const list = page.getByRole('list', { name: 'Recovery codes' });
  await expect(list).toBeVisible();
  const recoveryCodes = await list.locator('code').allInnerTexts();
  await page.getByRole('link', { name: /continue to the lead desk/ }).click();
  await expect(page).toHaveURL(/\/admin$/);
  return { secret, recoveryCodes };
}

/** Both steps: password, then a code from the authenticator. */
export async function signInWithCode(page: Page, email: string, password: string, secret: string): Promise<void> {
  await page.goto('/admin/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/admin\/login\/verify/);
  await page.getByLabel('6-digit code').fill(await freshCode(secret));
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page).toHaveURL(/\/admin(\/|$)(?!login)/);
}

// ── The preview tester ───────────────────────────────────────────────────
//
// Before launch the forms are open only to signed-in staff on a preview
// deployment. Form tests run as this synthetic staff member.

export const TESTER_STATE = 'test-results/.auth/tester.json';
export const TESTER = { name: 'Preview Tester', email: 'preview.tester@example.com', password: 'preview tester long password' };

/** The app's password format (scrypt$N$r$p$salt$hash), made here so the tester needs no owner. */
export function scryptHash(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password.normalize('NFKC'), salt, 64, { N: 2 ** 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 });
  return `scrypt$${2 ** 15}$8$1$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** The alert-confirmation token the app derives for a notification (needs APP_SECRET, as the app does). */
export function confirmationToken(notificationId: string): string {
  const secret = process.env['APP_SECRET'];
  if (!secret) throw new Error('APP_SECRET is not set');
  return createHmac('sha256', secret).update(`alert-confirmation\u0000${notificationId}`, 'utf8').digest('base64url');
}
