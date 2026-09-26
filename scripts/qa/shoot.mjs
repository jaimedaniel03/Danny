// Usage: node scripts/qa/shoot.mjs <url-path> <outfile> [width] [fullPage] [height]
import { chromium } from '@playwright/test';
const [, , path = '/', out = 'shot.png', width = '1440', full = 'true', height = '900'] = process.argv;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: Number(width), height: Number(height) }, reducedMotion: 'reduce' });
await page.goto(`${process.env.BASE_URL ?? 'http://localhost:3000'}${path}`, { waitUntil: 'networkidle' });
// Walk the page so lazy images load before a full-page capture.
await page.evaluate(async () => {
  for (let y = 0; y < document.body.scrollHeight; y += 400) {
    window.scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 60));
  }
  window.scrollTo(0, 0);
});
await page.waitForLoadState('networkidle');
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(300);
await page.screenshot({ path: out, fullPage: full === 'true' });
console.log('shot', out, await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]));
await browser.close();
