/**
 * Public site: every route, every link, metadata, and the layout rules
 * (no overflow from 360px up and at 200% zoom, text ≥16px, targets ≥44px).
 */

import { expect, test, type Page } from '@playwright/test';
import { PUBLIC_ROUTES } from './helpers';

const TITLES: Record<string, RegExp> = {
  '/': /Are you really|All Set Check/,
  '/coverage': /Life and health coverage, explained · All Set Check/,
  '/story': /Our story · All Set Check/,
  '/team': /Join the team · All Set Check/,
  '/contact': /Start a coverage check · All Set Check/,
  '/privacy': /Privacy policy · All Set Check/,
  '/terms': /Terms of use · All Set Check/,
};

for (const route of PUBLIC_ROUTES) {
  test(`${route} renders with one h1, metadata, and pre-launch noindex`, async ({ page }) => {
    const response = await page.goto(route);
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle(TITLES[route]!);
    await expect(page.locator('h1')).toHaveCount(1);
    const description = await page.locator('meta[name="description"]').getAttribute('content');
    expect(description?.length ?? 0).toBeGreaterThan(40);
    expect(description?.length ?? 999).toBeLessThanOrEqual(160);
    // Not launch-ready: required business facts are unverified.
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
    await expect(page.locator('meta[property="og:image"]')).toHaveCount(1);
    if (route !== '/') {
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', new RegExp(`${route}$`));
    }
    // Every image has alt text (decorative SVGs are aria-hidden instead).
    for (const img of await page.locator('img').all()) {
      expect(await img.getAttribute('alt')).toBeTruthy();
    }
  });
}

test('the hero says exactly what the brief says, with both calls to action', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toHaveText(/Are you\s+really\s+all set\?/);
  await expect(page.getByText('Understand your options. Protect your people. Choose what fits your budget.')).toBeVisible();
  await page.getByRole('link', { name: 'Explore coverage' }).click();
  await expect(page).toHaveURL(/\/coverage$/);
  await page.goto('/');
  await page.getByRole('main').getByRole('link', { name: 'Join the team' }).first().click();
  await expect(page).toHaveURL(/\/team$/);
});

test('every internal link and in-page anchor on every public page resolves', async ({ page, request }) => {
  const seen = new Map<string, number>();
  for (const route of PUBLIC_ROUTES) {
    await page.goto(route);
    const hrefs = await page.locator('a[href]').evaluateAll((links) => links.map((a) => a.getAttribute('href') ?? ''));
    for (const href of hrefs) {
      if (!href.startsWith('/') && !href.startsWith('#')) continue;
      const [path, hash] = href.startsWith('#') ? [route, href.slice(1)] : href.split('#');
      if (!seen.has(path!)) {
        const res = await request.get(path!);
        seen.set(path!, res.status());
      }
      expect(seen.get(path!), `${route} → ${href}`).toBe(200);
      if (hash) {
        if (path !== route) await page.goto(path!);
        await expect(page.locator(`[id="${hash}"]`), `${route} → ${href} target`).toHaveCount(1);
        if (path !== route) await page.goto(route);
      }
    }
  }
  expect(seen.size).toBeGreaterThanOrEqual(PUBLIC_ROUTES.length);
});

test('external links are to official or expected sites and open safely', async ({ page }) => {
  for (const route of PUBLIC_ROUTES) {
    await page.goto(route);
    const external = await page
      .locator('a[href^="http"]')
      .evaluateAll((links) => links.map((a) => ({ href: a.getAttribute('href') ?? '', rel: a.getAttribute('rel') ?? '' })));
    for (const link of external) {
      expect(link.href, route).toMatch(/^https:\/\/www\.(healthcare|medicaid|medicare)\.gov(\/|$)/);
      expect(link.rel, `${route} ${link.href}`).toContain('noopener');
    }
  }
});

test('sitemap lists every public route; robots blocks crawling before launch', async ({ request }) => {
  const sitemap = await (await request.get('/sitemap.xml')).text();
  for (const route of PUBLIC_ROUTES) {
    expect(sitemap).toContain(route === '/' ? '<loc>' : `${route}</loc>`);
  }
  const robots = await (await request.get('/robots.txt')).text();
  expect(robots).toMatch(/Disallow: \//);
});

test('unknown pages return a real 404 with navigation', async ({ page }) => {
  const response = await page.goto('/definitely-not-a-page');
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await expect(page.locator('h1')).toHaveCount(1);
});

test('security headers are set on public pages', async ({ request }) => {
  const res = await request.get('/');
  const headers = res.headers();
  expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  expect(headers['x-powered-by']).toBeUndefined();
});

test('every page runs only the scripts and styles its own response authorizes', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (message) => {
    if (/Content Security Policy/i.test(message.text())) violations.push(`${page.url()}: ${message.text()}`);
  });
  const nonces = new Set<string>();
  const paths = [...PUBLIC_ROUTES, '/contact', '/nope', '/admin/login', '/admin/setup', '/admin/invite#token=x', '/admin/confirm-alert#token=x'];
  for (const path of paths) {
    const response = await page.goto(path);
    await page.waitForLoadState('networkidle');
    const csp = response?.headers()['content-security-policy'] ?? '';
    expect(csp, path).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'(;|$)/);
    expect(csp, path).toMatch(/style-src 'self' 'nonce-[A-Za-z0-9+/=]+'(;|$)/);
    expect(csp, path).not.toContain('unsafe-inline');
    expect(csp, path).not.toContain('unsafe-eval');
    expect(csp, path).toContain("frame-ancestors 'none'");
    const nonce = /'nonce-([^']+)'/.exec(csp)![1]!;
    nonces.add(nonce);
    // Every script tag the server sent carries this response's nonce. (Chunks those scripts
    // load later are trusted through 'strict-dynamic' and need none.)
    const html = (await response?.text()) ?? '';
    const tags = html.match(/<script\b[^>]*>/g) ?? [];
    expect(tags.length, path).toBeGreaterThan(0);
    const unsigned = tags.filter((tag) => !tag.includes(`nonce="${nonce}"`) && !/type="application\/ld\+json"/.test(tag));
    expect(unsigned, path).toEqual([]);
  }
  // A fresh nonce every time; a reused one would be no protection.
  expect(nonces.size).toBe(paths.length);
  expect(violations).toEqual([]);
});

test('every public page says plainly that the site is a preview until launch', async ({ page }) => {
  for (const route of PUBLIC_ROUTES) {
    await page.goto(route);
    await expect(page.getByRole('complementary', { name: 'Site status' }), route).toContainText('not open to the public yet');
  }
});

async function layoutProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];
    const doc = document.documentElement;
    if (doc.scrollWidth > doc.clientWidth + 1) problems.push(`horizontal overflow ${doc.scrollWidth} > ${doc.clientWidth}`);

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const small = new Set<string>();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      if (!el || !node.textContent?.trim()) continue;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || el.closest('[aria-hidden="true"], .visually-hidden, .skip-link, script, style')) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (parseFloat(style.fontSize) < 16) small.add(`${el.tagName.toLowerCase()} "${node.textContent.trim().slice(0, 30)}" ${style.fontSize}`);
    }
    problems.push(...[...small].map((s) => `small text: ${s}`));

    // Touch targets: buttons, form controls, and standalone links (not links inside running text).
    const controls = document.querySelectorAll<HTMLElement>('button, input:not([type=hidden]), select, textarea, summary, a[href]');
    for (const el of controls) {
      if (el.closest('[aria-hidden="true"], .visually-hidden') || el.classList.contains('skip-link')) continue;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      if (el.tagName === 'A' && el.closest('p, li p, dd, td, figcaption, .prose p, blockquote, .fine-print')) continue;
      // Radios/checkboxes are measured by their whole clickable label row.
      if (el instanceof HTMLInputElement && (el.type === 'radio' || el.type === 'checkbox')) {
        const label = el.closest('label');
        if (label && label.getBoundingClientRect().height >= 44) continue;
      }
      if (el.tagName === 'A' && el.parentElement?.tagName === 'LI' && el.closest('.prose')) continue;
      if (rect.height < 44 - 0.5) problems.push(`small target: ${el.tagName.toLowerCase()} "${(el.textContent ?? el.getAttribute('aria-label') ?? '').trim().slice(0, 30)}" ${Math.round(rect.height)}px`);
    }
    return problems;
  });
}

for (const [label, viewport] of [
  ['360px phone', { width: 360, height: 780 }],
  ['200% zoom of a 1280px window', { width: 640, height: 450 }],
  ['desktop', { width: 1440, height: 900 }],
] as const) {
  test(`layout rules hold at ${label}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    for (const route of PUBLIC_ROUTES) {
      await page.goto(route);
      const problems = await layoutProblems(page);
      expect(problems, `${route} at ${label}`).toEqual([]);
    }
  });
}
