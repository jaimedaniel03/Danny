/**
 * Generate consent links for the human queue.
 *
 *   npm run leads:links -- out/human_queue.csv --campaign winter_crosssell
 *
 * This is the bridge between the two halves of the lead problem. Triage sorts
 * ~70% of a typical list into `human_queue` — leads a licensed human may call
 * but Danny may not, because there is no written consent. This script mints a
 * signed link per lead. A human works the queue, and every call that goes
 * anywhere ends with one sentence:
 *
 *   "Want me to have my assistant follow up with you directly? I'll text you a
 *    link to okay it — takes ten seconds."
 *
 * Each signature moves that lead into `ai_ready` permanently: for this campaign,
 * for renewals, for cross-sell, for every future campaign. That is how a
 * 300-lead list becomes an AI-dialable book over a quarter instead of a
 * spreadsheet that goes stale.
 *
 * Output is a CSV with a `consent_url` column, ready to merge into a texting
 * tool or paste into a CRM. Links expire in 14 days.
 *
 * ── One thing to be careful about ────────────────────────────────────────────
 * Sending the link is itself outreach. A text message to a wireless number is a
 * "call" under the TCPA. Sending it *manually*, one at a time, from a human who
 * just spoke to that person, is ordinary business communication. Blasting 210 of
 * them from an automated system is the thing this whole architecture exists to
 * avoid, and it would be a straightforward violation. The script deliberately
 * does not send anything — it only produces the column.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parseCsv, toCsvLine, normalizePhoneUS } from '../src/leads/normalize';
import { issueConsentToken, consentUrl } from '../src/consent/tokens';

const args = process.argv.slice(2);
const inputPath = args.find((a) => !a.startsWith('--')) ?? 'out/human_queue.csv';

function flag(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  const next = idx >= 0 ? args[idx + 1] : undefined;
  return next !== undefined && !next.startsWith('--') ? next : fallback;
}

const campaignId = flag('campaign', 'default');
const agencyId = flag('agency', process.env['AGENCY_ID'] ?? 'agency_local');
const outDir = flag('out', 'out');

if (!process.env['CONSENT_TOKEN_SECRET']) {
  console.error(
    'CONSENT_TOKEN_SECRET is not set. Generate one and put it in .env.local:\n\n' +
      '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n\n' +
      'Links signed with a throwaway secret stop working the moment the real one ' +
      'is set, which is a confusing failure to debug three weeks from now.',
  );
  process.exit(1);
}

if (!process.env['PUBLIC_BASE_URL']) {
  console.error('PUBLIC_BASE_URL is not set — links would have no host.');
  process.exit(1);
}

if (!existsSync(inputPath)) {
  console.error(`No file at "${inputPath}". Run \`npm run leads:triage\` first.`);
  process.exit(1);
}

const rows = parseCsv(readFileSync(inputPath, 'utf-8'));
const headerRow = rows[0];
if (!headerRow) {
  console.error('Input file is empty.');
  process.exit(1);
}

const header = headerRow.map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
const phoneIdx = header.indexOf('phone_e164') >= 0 ? header.indexOf('phone_e164') : header.indexOf('phone');
const firstNameIdx = header.indexOf('first_name');

if (phoneIdx < 0) {
  console.error(`Input needs a "phone_e164" or "phone" column. Found: ${header.join(', ')}`);
  process.exit(1);
}

const outRows: string[] = [toCsvLine([...header, 'consent_url', 'suggested_text'])];
let issued = 0;
let skipped = 0;

for (let r = 1; r < rows.length; r++) {
  const row = rows[r];
  if (!row) continue;

  const phoneE164 = normalizePhoneUS(row[phoneIdx] ?? '');
  if (!phoneE164) {
    skipped++;
    continue;
  }

  const token = issueConsentToken({
    // Stable per phone so re-running does not orphan links already sent.
    contactId: `lead_${phoneE164}`,
    phoneE164,
    agencyId,
    campaignId,
  });

  const url = consentUrl(token);
  const firstName = (firstNameIdx >= 0 ? row[firstNameIdx] : '')?.trim() ?? '';
  const greeting = firstName ? `Hi ${firstName}, ` : 'Hi, ';

  // Written for a human to send by hand after a real conversation, which is
  // both the compliant path and the one that actually gets tapped.
  const suggestedText =
    `${greeting}great talking just now. Here's the link to okay a follow-up ` +
    `call so I can get you that quote: ${url}`;

  outRows.push(toCsvLine([...row, url, suggestedText]));
  issued++;
}

mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, 'consent_links.csv');
writeFileSync(outPath, outRows.join('\n') + '\n');

console.log(`
════════════════════════════════════════════════════════════════
  CONSENT LINKS — ${basename(inputPath)}
════════════════════════════════════════════════════════════════

  Links issued          ${issued}
  Skipped (bad phone)   ${skipped}
  Campaign              ${campaignId}
  Expires               14 days from now

  Written to            ${outPath}

────────────────────────────────────────────────────────────────
  These links are NOT sent by this script, on purpose.

  A text to a wireless number is a "call" under the TCPA. Sent by
  hand, one at a time, by the person who just spoke to that lead,
  it is ordinary business follow-up. Blasted from an automated
  system to ${issued} numbers, it is the exact violation this
  architecture exists to prevent.

  Work the queue by phone. Send the link after the conversation.
────────────────────────────────────────────────────────────────
`);
