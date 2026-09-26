/**
 * Generates the All Set Check brand assets from source geometry.
 *
 *   npm run brand:build
 *
 * The mark is a checkbox whose coral tick breaks out past the top-right
 * corner: checked, and then some — "really all set". The wordmark is
 * Newsreader set as outlines, so the SVGs render identically everywhere with
 * no font dependency. Outputs are committed; rerun only when the brand changes.
 *
 * Needs network access to Google Fonts (to fetch the TTFs it outlines).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import opentype from 'opentype.js';
import sharp from 'sharp';

const INK = '#17323A';
const PAPER = '#F8FAFA';
const CORAL = '#EC6D50';

const ROOT = process.cwd();
const PUBLIC_BRAND = join(ROOT, 'public/brand');
const APP = join(ROOT, 'src/app');

async function fetchFont(family: string, axes: string): Promise<opentype.Font> {
  // An old user agent makes Google Fonts answer with TTF, which opentype.js
  // parses; modern agents get WOFF2.
  const css = await fetch(`https://fonts.googleapis.com/css2?family=${family}:${axes}`, {
    headers: { 'User-Agent': 'Mozilla/4.0' },
  }).then((r) => r.text());
  const url = css.match(/src:\s*url\((https:[^)]+\.ttf)\)/)?.[1];
  if (!url) throw new Error(`No TTF in Google Fonts CSS for ${family}`);
  const buffer = await fetch(url).then((r) => r.arrayBuffer());
  return opentype.parse(buffer);
}

// ── Mark geometry (48×48) ────────────────────────────────────────────────

const TICK = 'M12.5 26.5 L20 34 L42.5 7.5';

function markSvg(boxColor: string, tickColor: string, id: string): string {
  // The box stroke is masked where the tick crosses it, so the tick reads as
  // breaking out of the box on any background colour.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48" role="img" aria-label="All Set Check">
  <defs>
    <mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="48" height="48">
      <rect width="48" height="48" fill="#fff"/>
      <path d="${TICK}" fill="none" stroke="#000" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>
    </mask>
  </defs>
  <rect x="5" y="11" width="30" height="30" rx="7" fill="none" stroke="${boxColor}" stroke-width="3.5" mask="url(#${id})"/>
  <path d="${TICK}" fill="none" stroke="${tickColor}" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;
}

/** App icon: ink tile, paper box, coral tick. Legible down to 16px. */
function iconSvg(size = 48): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="${size}" height="${size}">
  <defs>
    <mask id="k" maskUnits="userSpaceOnUse" x="0" y="0" width="48" height="48">
      <rect width="48" height="48" fill="#fff"/>
      <path d="M14 26 L20.5 32.5 L38.5 11" fill="none" stroke="#000" stroke-width="10.5" stroke-linecap="round" stroke-linejoin="round"/>
    </mask>
  </defs>
  <rect width="48" height="48" rx="11" fill="${INK}"/>
  <rect x="9" y="14" width="25" height="25" rx="6" fill="none" stroke="${PAPER}" stroke-width="3.5" mask="url(#k)"/>
  <path d="M14 26 L20.5 32.5 L38.5 11" fill="none" stroke="${CORAL}" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;
}

// ── Wordmark ────────────────────────────────────────────────────────────

interface Outline {
  readonly d: string;
  readonly width: number;
  readonly ascent: number;
}

function outline(font: opentype.Font, text: string, size: number): Outline {
  const path = font.getPath(text, 0, 0, size, { kerning: true });
  const box = path.getBoundingBox();
  // Shift so the path starts at x=0; baseline stays at y=0.
  const shifted = font.getPath(text, -box.x1, 0, size, { kerning: true });
  return { d: shifted.toPathData(2), width: box.x2 - box.x1, ascent: -box.y1 };
}

function lockupSvg(word: Outline, boxColor: string, textColor: string, id: string): string {
  const markSize = 48;
  const gap = 4;
  const height = 48;
  // Optically centre the cap height against the checkbox (y 11–41).
  const baseline = 36.5;
  const width = Math.ceil(markSize + gap + word.width + 2);
  const mark = markSvg(boxColor, CORAL, id)
    .replace(/^<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="All Set Check">
  <g>${mark}</g>
  <path transform="translate(${markSize + gap} ${baseline})" d="${word.d}" fill="${textColor}"/>
</svg>
`;
}

// ── Open Graph card (1200×630) ──────────────────────────────────────────

function ogSvg(headline: opentype.Font, body: opentype.Font, word: Outline): string {
  const line1 = outline(headline, 'Are you really', 96);
  const line2 = outline(headline, 'all set?', 96);
  const really = outline(headline, 'Are you ', 96);
  const reallyWord = outline(headline, 'really', 96);
  const sub = outline(body, 'Understand your options. Protect your people.', 32);
  const sub2 = outline(body, 'Choose what fits your budget.', 32);
  const x = 88;
  const underlineX = x + really.width + 22;
  const underlineY = 318;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="${INK}"/>
  <g transform="translate(${x} 72) scale(1.1)">
    ${markSvg(PAPER, CORAL, 'ogm').replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')}
    <path transform="translate(60 36.5)" d="${word.d}" fill="${PAPER}"/>
  </g>
  <path transform="translate(${x} 290)" d="${line1.d}" fill="${PAPER}"/>
  <path d="M${underlineX} ${underlineY} C ${underlineX + reallyWord.width * 0.3} ${underlineY + 10}, ${underlineX + reallyWord.width * 0.7} ${underlineY - 6}, ${underlineX + reallyWord.width - 8} ${underlineY + 4}" fill="none" stroke="${CORAL}" stroke-width="9" stroke-linecap="round"/>
  <path transform="translate(${x} 400)" d="${line2.d}" fill="${PAPER}"/>
  <path transform="translate(${x} 500)" d="${sub.d}" fill="#C9D6D9"/>
  <path transform="translate(${x} 548)" d="${sub2.d}" fill="#C9D6D9"/>
  <rect x="0" y="618" width="1200" height="12" fill="${CORAL}"/>
</svg>
`;
}

// ── ICO container (PNG-in-ICO, supported by every current browser) ──────

function ico(images: readonly { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries: Buffer[] = [];
  let offset = 6 + 16 * images.length;
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

async function main(): Promise<void> {
  mkdirSync(PUBLIC_BRAND, { recursive: true });

  const newsreader = await fetchFont('Newsreader', 'opsz,wght@72,600');
  const newsreaderText = await fetchFont('Newsreader', 'opsz,wght@72,500');
  const publicSans = await fetchFont('Public+Sans', 'wght@400');

  const word = outline(newsreader, 'All Set Check', 30);

  writeFileSync(join(PUBLIC_BRAND, 'mark.svg'), markSvg(INK, CORAL, 'm'));
  writeFileSync(join(PUBLIC_BRAND, 'mark-reversed.svg'), markSvg(PAPER, CORAL, 'm'));
  writeFileSync(join(PUBLIC_BRAND, 'lockup.svg'), lockupSvg(word, INK, INK, 'l'));
  writeFileSync(join(PUBLIC_BRAND, 'lockup-reversed.svg'), lockupSvg(word, PAPER, PAPER, 'l'));
  writeFileSync(join(APP, 'icon.svg'), iconSvg());

  const icon = Buffer.from(iconSvg(512));
  const png = (size: number) => sharp(icon, { density: 72 * (size / 48) * 1.5 }).resize(size, size).png().toBuffer();

  writeFileSync(join(APP, 'apple-icon.png'), await png(180));
  writeFileSync(join(PUBLIC_BRAND, 'icon-192.png'), await png(192));
  writeFileSync(join(PUBLIC_BRAND, 'icon-512.png'), await png(512));
  writeFileSync(
    join(APP, 'favicon.ico'),
    ico([
      { size: 16, png: await png(16) },
      { size: 32, png: await png(32) },
      { size: 48, png: await png(48) },
    ]),
  );

  const og = Buffer.from(ogSvg(newsreaderText, publicSans, word));
  writeFileSync(join(PUBLIC_BRAND, 'og.svg'), og);
  await sharp(og).png({ compressionLevel: 9 }).toFile(join(APP, 'opengraph-image.png'));
  await sharp(og).png({ compressionLevel: 9 }).toFile(join(APP, 'twitter-image.png'));

  console.log('Brand assets written.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
