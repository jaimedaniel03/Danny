import type { Page } from '@playwright/test';
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
 * Each test submits from its own address (the app trusts x-real-ip, which
 * Vercel's edge sets), so per-IP rate limits don't bleed between tests.
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
  await page.getByLabel('Email address').fill(input.email);
  await page.getByLabel('ZIP code').fill(input.zip);
  await page.getByRole('radio', { name: input.interest, exact: true }).check();
  await page.getByRole('radio', { name: input.method, exact: true }).check();
  if (input.phone !== undefined) await page.getByRole('textbox', { name: /Phone number/ }).fill(input.phone);
  if (input.consent !== false) await page.locator('#inquiry-consent').check();
}

export async function referenceFromSuccess(page: Page): Promise<string> {
  const text = await page.getByRole('status').filter({ hasText: 'We have your request' }).innerText();
  const match = text.match(/ASC-[0-9A-Z]{4}-[0-9A-Z]{4}/);
  if (!match) throw new Error(`No reference in: ${text}`);
  return match[0];
}
