/**
 * Accessibility and interaction: WCAG 2.2 AA scans (axe), the mobile menu,
 * keyboard paths, visible focus, scroll reveals and reduced motion.
 */

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { PUBLIC_ROUTES, TESTER_STATE } from './helpers';

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];

async function axe(page: Page, label: string): Promise<void> {
  // @axe-core/playwright is typed against a newer playwright-core; the Page API it uses is the same.
  const results = await new AxeBuilder({ page: page as never }).withTags(WCAG).analyze();
  const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  expect(summary, label).toEqual([]);
}

for (const route of PUBLIC_ROUTES) {
  test(`axe WCAG 2.2 AA: ${route} (desktop and phone)`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(route);
    await axe(page, `${route} desktop`);
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(route);
    await axe(page, `${route} phone`);
  });
}

test('axe: the open mobile menu, open FAQs, and a form with errors', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/');
  await page.getByText('Menu', { exact: true }).click();
  await axe(page, 'menu open');

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  for (const summary of await page.locator('details summary').all()) {
    if (await summary.isVisible()) await summary.click();
  }
  await axe(page, 'faqs open');

  // The closed notice the public sees before launch.
  await page.goto('/contact');
  await axe(page, 'contact closed');
});

test.describe('forms (as the preview tester)', () => {
  test.use({ storageState: TESTER_STATE });

  test('axe: the open form with errors', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/contact');
    await page.waitForTimeout(2200);
    await page.getByRole('button', { name: 'Send my request' }).click();
    await expect(page.getByText(/things to fix/)).toBeVisible();
    await axe(page, 'contact with errors');
  });

  test('keyboard: the whole coverage form can be completed without a mouse', async ({ page }) => {
    await page.setExtraHTTPHeaders({ 'x-real-ip': '10.250.250.1' });
    await page.goto('/contact');
    await page.waitForTimeout(2200);
    await page.getByLabel('Full name').focus();
    await page.keyboard.type('Key Board');
    await page.keyboard.press('Tab');
    await page.keyboard.type(`keyboard.${Date.now()}@example.com`);
    await page.keyboard.press('Tab');
    await page.keyboard.type('33101');
    await page.keyboard.press('Tab'); // state
    await page.keyboard.type('Florida');
    await expect(page.getByLabel('State', { exact: true })).toHaveValue('FL');
    await page.keyboard.press('Tab'); // interest radio group
    await page.keyboard.press('Space');
    await page.keyboard.press('Tab'); // contact method radio group
    await page.keyboard.press('Space');
    await page.keyboard.press('Tab'); // consent checkbox
    await page.keyboard.press('Space');
    await expect(page.locator('#inquiry-consent')).toBeChecked();
    await page.keyboard.press('Tab'); // privacy link
    await page.keyboard.press('Tab'); // submit
    await page.keyboard.press('Enter');
    await expect(page.getByText(/We have your request/)).toBeVisible();
  });
});

test('axe: sign-in and setup pages', async ({ page }) => {
  for (const path of ['/admin/login', '/admin/login/verify', '/admin/setup', '/admin/invite#token=nope', '/admin/confirm-alert#token=nope']) {
    await page.goto(path);
    await axe(page, path);
  }
});

test('mobile menu: opens, closes on Escape with focus returned, and navigates', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/');
  const button = page.locator('summary', { hasText: 'Menu' });
  const menu = page.locator('details:has(summary:has-text("Menu"))');
  await expect(button).toBeVisible();
  // The wide-screen list is hidden at this size and the menu is closed, so
  // no nav link is exposed until it opens — and then exactly one of each.
  const coverageLink = page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Coverage', exact: true });
  await expect(coverageLink).toHaveCount(0);

  await button.focus();
  await page.keyboard.press('Enter');
  await expect(menu).toHaveAttribute('open', '');
  await expect(coverageLink).toHaveCount(1);
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav.getByRole('link', { name: 'Our story' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).not.toHaveAttribute('open', '');
  await expect(button).toBeFocused();

  await button.click();
  await nav.getByRole('link', { name: 'Our story' }).click();
  await expect(page).toHaveURL(/\/story$/);
  await expect(menu).not.toHaveAttribute('open', '');
  // The current page is marked in both the wide list and the (closed) menu.
  await expect(page.locator('nav[aria-label="Main"] a[aria-current="page"]')).toHaveCount(2);
  await expect(page.locator('nav[aria-label="Main"] a[aria-current="page"]').first()).toHaveAttribute('href', '/story');

  // Clicking outside closes it.
  await button.click();
  await expect(menu).toHaveAttribute('open', '');
  await page.mouse.click(10, 700);
  await expect(menu).not.toHaveAttribute('open', '');
});

test('mobile menu works with scripts off', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 375, height: 800 } });
  const page = await context.newPage();
  await page.goto('/');
  await page.locator('summary', { hasText: 'Menu' }).click();
  await page.getByRole('link', { name: 'Coverage', exact: true }).click();
  await expect(page).toHaveURL(/\/coverage$/);
  await context.close();
});

test('keyboard: the skip link is first, visible when focused, and lands on the main content', async ({ page }) => {
  await page.goto('/coverage');
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to main content' });
  await expect(skip).toBeFocused();
  const box = await skip.boundingBox();
  expect(box && box.y >= 0).toBeTruthy();
  await page.keyboard.press('Enter');
  await expect(page.locator('main#main')).toBeFocused();
});

test('keyboard: every focusable control shows a visible focus indicator', async ({ page }) => {
  await page.goto('/');
  const missing: string[] = [];
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const style = getComputedStyle(el);
      const outline = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2;
      const shadow = style.boxShadow !== 'none';
      return { label: `${el.tagName} ${(el.textContent ?? '').trim().slice(0, 30)}`, visible: outline || shadow };
    });
    if (info && !info.visible) missing.push(info.label);
  }
  expect(missing).toEqual([]);
});

test('scroll reveals run once and never hide content above the fold', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toBeVisible();
  const pending = page.locator('[data-reveal-state="pending"]');
  expect(await pending.count()).toBeGreaterThan(0);
  const firstPending = pending.first();
  await firstPending.scrollIntoViewIfNeeded();
  await expect(page.locator('[data-reveal-state="shown"]').first()).toBeVisible();
  // Nothing in the first viewport was ever hidden.
  const aboveFoldHidden = await page.evaluate(() =>
    [...document.querySelectorAll('[data-reveal-state="pending"]')].filter((el) => el.getBoundingClientRect().top < window.innerHeight * 0.5).length,
  );
  expect(aboveFoldHidden).toBe(0);
});

test('reduced motion: nothing is hidden or animated, and all content is visible', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.locator('[data-reveal-state]')).toHaveCount(0);
  const hidden = await page.evaluate(() =>
    [...document.querySelectorAll('[data-reveal]')].filter((el) => getComputedStyle(el).opacity !== '1').length,
  );
  expect(hidden).toBe(0);
  const duration = await page.locator('.btn').first().evaluate((el) => getComputedStyle(el).transitionDuration);
  expect(duration.split(',').every((d) => parseFloat(d) <= 0.001)).toBe(true);
});

test('with scripts off, every section of every page is visible', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  for (const route of PUBLIC_ROUTES) {
    await page.goto(route);
    const hidden = await page.evaluate(() =>
      [...document.querySelectorAll('[data-reveal]')].filter((el) => getComputedStyle(el).opacity !== '1').length,
    );
    expect(hidden, route).toBe(0);
    await expect(page.locator('h1')).toBeVisible();
  }
  await context.close();
});

test('hover and focus feedback use 150–250ms transitions', async ({ page }) => {
  await page.goto('/');
  const durations = await page.evaluate(() =>
    [...document.querySelectorAll('.btn, a, summary, .input')].slice(0, 30).flatMap((el) =>
      getComputedStyle(el).transitionDuration.split(',').map((d) => parseFloat(d) * 1000),
    ),
  );
  const nonzero = durations.filter((d) => d > 0);
  expect(nonzero.length).toBeGreaterThan(0);
  expect(nonzero.every((d) => d >= 150 && d <= 250)).toBe(true);
});
