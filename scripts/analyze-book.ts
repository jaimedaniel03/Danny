/**
 * Book analysis — turn a policy export into a ranked call list.
 *
 *   npm run book:analyze -- book/book.csv
 *   npm run book:analyze -- book/book.csv --today 25   (today's fifteen, plus ten)
 *
 * Takes one row per POLICY, groups into households, finds every cross-sell and
 * renewal opportunity, and ranks by expected lifetime value created — not by
 * first-year commission, because that hides the retention effect that makes
 * bundling worth doing at all.
 *
 * Writes:
 *   out/call-list.csv        every household, ranked, with the pitch
 *   out/today.csv            the top N, for a single day's block
 *   out/opportunities.csv    one row per opportunity, for the CRM
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parseCsv, toCsvLine, normalizePhoneUS, normalizeState } from '../src/leads/normalize';
import {
  activeLines,
  annualCommissionCents,
  ageAt,
  retentionFor,
  tenureYears,
  type Household,
  type Policy,
  type PolicyStatus,
} from '../src/book/types';
import { rankBook, summarizeBook } from '../src/book/gaps';
import type { LineOfBusiness } from '../src/types';

const args = process.argv.slice(2);
const inputPath = args.find((a) => !a.startsWith('--')) ?? 'book/book.csv';

function flag(name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`);
  const next = i >= 0 ? args[i + 1] : undefined;
  return next !== undefined && !next.startsWith('--') ? next : fallback;
}

const todayCount = Number.parseInt(flag('today', '15'), 10);
const outDir = flag('out', 'out');
const NOW = new Date();

if (!existsSync(inputPath)) {
  console.error(
    `No book file at "${inputPath}".\n\n` +
      `Export one row per policy from your AMS with these columns (only the first\n` +
      `four are required):\n\n` +
      `  household_id, line, phone, annual_premium,\n` +
      `  first_name, last_name, email, state, zip, dob,\n` +
      `  carrier, policy_number, status, annual_commission,\n` +
      `  effective_date, renewal_date, written_date,\n` +
      `  owns_home, has_mortgage, dependents, business_owner, last_contact\n\n` +
      `See book/BOOK-TEMPLATE.csv. The book/ directory is gitignored.`,
  );
  process.exit(1);
}

const rows = parseCsv(readFileSync(inputPath, 'utf-8'));
const headerRow = rows[0];
if (!headerRow) {
  console.error('Book file is empty.');
  process.exit(1);
}

const header = headerRow.map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
const col = (n: string): number => header.indexOf(n);
const cell = (row: readonly string[], i: number): string => (i >= 0 ? (row[i] ?? '').trim() : '');

const idx = {
  householdId: col('household_id'),
  line: col('line'),
  phone: col('phone'),
  email: col('email'),
  firstName: col('first_name'),
  lastName: col('last_name'),
  state: col('state'),
  zip: col('zip'),
  dob: col('dob'),
  carrier: col('carrier'),
  policyNumber: col('policy_number'),
  status: col('status'),
  premium: col('annual_premium'),
  commission: col('annual_commission'),
  effective: col('effective_date'),
  renewal: col('renewal_date'),
  written: col('written_date'),
  ownsHome: col('owns_home'),
  hasMortgage: col('has_mortgage'),
  dependents: col('dependents'),
  businessOwner: col('business_owner'),
  lastContact: col('last_contact'),
};

for (const [name, i] of [['line', idx.line], ['annual_premium', idx.premium]] as const) {
  if (i < 0) {
    console.error(`Book file needs a "${name}" column. Found: ${header.join(', ')}`);
    process.exit(1);
  }
}

// ── Parsing helpers ──────────────────────────────────────────────────────────

function money(raw: string): number {
  const n = Number.parseFloat(raw.replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function date(raw: string, fallback: Date): Date {
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

function bool(raw: string): boolean | null {
  const v = raw.toLowerCase();
  if (['y', 'yes', 'true', '1'].includes(v)) return true;
  if (['n', 'no', 'false', '0'].includes(v)) return false;
  return null;
}

/**
 * Normalize whatever the AMS calls a line into our enum. Every AMS spells these
 * differently and none of them use ours.
 */
function toLine(raw: string): LineOfBusiness | null {
  const v = raw.toLowerCase().replace(/[^a-z]/g, '');
  if (/auto|car|vehicle|pap/.test(v)) return 'auto';
  if (/home|ho[0-9]|dwelling|renter|condo|property/.test(v)) return 'home';
  if (/commercial|bop|generalliability|workerscomp|business/.test(v)) return 'commercial';
  if (/medicare|mapd|medsupp|pdp/.test(v)) return 'health_medicare';
  if (/health|aca|marketplace/.test(v)) return 'health_uh65';
  if (/term/.test(v)) return 'life_term';
  if (/finalexpense|burial/.test(v)) return 'life_final_expense';
  if (/life|whole|iul|gul|universal/.test(v)) return 'life_permanent';
  if (/umbrella|excess/.test(v)) return 'home'; // rides the P&C license
  return null;
}

function toStatus(raw: string): PolicyStatus {
  const v = raw.toLowerCase();
  if (/lapse/.test(v)) return 'lapsed';
  if (/cancel/.test(v)) return 'cancelled';
  if (/non.?renew/.test(v)) return 'non_renewed';
  return 'active';
}

/**
 * Commission when the export does not carry it. Independent-agency typicals;
 * the ranking is only as good as this, so map the real column if you have one.
 */
function estimateCommission(line: LineOfBusiness, premiumCents: number): number {
  const rate: Record<string, number> = {
    auto: 0.11,
    home: 0.12,
    commercial: 0.13,
    life_term: 0.85,
    life_permanent: 0.9,
    life_final_expense: 1.0,
    health_uh65: 0.05,
    health_medicare: 0.2,
  };
  return Math.round(premiumCents * (rate[line] ?? 0.1));
}

// ── Group into households ────────────────────────────────────────────────────

const households = new Map<string, { row: readonly string[]; policies: Policy[]; hasUmbrella: boolean }>();
let skipped = 0;

for (let r = 1; r < rows.length; r++) {
  const row = rows[r];
  if (!row) continue;

  const line = toLine(cell(row, idx.line));
  if (!line) {
    skipped++;
    continue;
  }

  const phone = normalizePhoneUS(cell(row, idx.phone));
  // Group by explicit household id, else by phone — the best proxy an export
  // usually offers for "same household".
  const key =
    cell(row, idx.householdId) || phone || `${cell(row, idx.lastName)}_${cell(row, idx.zip)}` || `row${r}`;

  const premium = money(cell(row, idx.premium));
  const commissionRaw = cell(row, idx.commission);
  const renewal = date(cell(row, idx.renewal), new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate()));

  const policy: Policy = {
    id: `p_${r}`,
    householdId: key,
    line,
    carrier: cell(row, idx.carrier) || 'unknown',
    policyNumber: cell(row, idx.policyNumber) || `row_${r}`,
    status: toStatus(cell(row, idx.status)),
    annualPremiumCents: premium,
    annualCommissionCents: commissionRaw ? money(commissionRaw) : estimateCommission(line, premium),
    effectiveDate: date(cell(row, idx.effective), renewal),
    renewalDate: renewal,
    writtenDate: date(cell(row, idx.written), date(cell(row, idx.effective), renewal)),
  };

  // Umbrella is written as the home line for licensing, so remember the raw
  // text — otherwise a household that already has one gets pitched forever.
  const isUmbrella = /umbrella|excess/i.test(cell(row, idx.line));

  const existing = households.get(key);
  if (existing) {
    existing.policies.push(policy);
    if (isUmbrella) existing.hasUmbrella = true;
  } else {
    households.set(key, { row, policies: [policy], hasUmbrella: isUmbrella });
  }
}

const parsed: Household[] = [...households.entries()].map(([id, { row, policies, hasUmbrella }]) => ({
  id,
  primaryFirstName: cell(row, idx.firstName) || null,
  primaryLastName: cell(row, idx.lastName) || null,
  phoneE164: normalizePhoneUS(cell(row, idx.phone)),
  email: cell(row, idx.email) || null,
  stateCode: normalizeState(cell(row, idx.state)),
  postalCode: cell(row, idx.zip) || null,
  dateOfBirth: cell(row, idx.dob) ? date(cell(row, idx.dob), new Date(0)) : null,
  policies,
  ownsHome: bool(cell(row, idx.ownsHome)),
  hasMortgage: bool(cell(row, idx.hasMortgage)),
  dependents: cell(row, idx.dependents) ? Number.parseInt(cell(row, idx.dependents), 10) : null,
  maritalStatus: null,
  businessOwner: bool(cell(row, idx.businessOwner)),
  hasUmbrella: hasUmbrella ? true : null,
  lastContactAt: cell(row, idx.lastContact) ? date(cell(row, idx.lastContact), new Date(0)) : null,
  notes: null,
}));

// ── Analyze ──────────────────────────────────────────────────────────────────

const ranked = rankBook(parsed, NOW);
const summary = summarizeBook(parsed, NOW);
const dollars = (cents: number): string => `$${Math.round(cents / 100).toLocaleString('en-US')}`;

mkdirSync(outDir, { recursive: true });

writeFileSync(
  join(outDir, 'call-list.csv'),
  [
    toCsvLine([
      'rank', 'household_id', 'first_name', 'last_name', 'phone_e164', 'email', 'state',
      'current_lines', 'annual_commission', 'urgent', 'top_opportunity',
      'expected_value', 'window_days', 'pitch',
    ]),
    ...ranked.map((r, i) => {
      const h = r.household;
      const top = r.topOpportunity;
      return toCsvLine([
        String(i + 1),
        h.id,
        h.primaryFirstName,
        h.primaryLastName,
        h.phoneE164,
        h.email,
        h.stateCode,
        [...activeLines(h)].join('+'),
        (annualCommissionCents(h) / 100).toFixed(2),
        r.urgent ? 'YES' : '',
        top?.kind ?? '',
        (r.totalExpectedValueCents / 100).toFixed(2),
        top?.windowDays !== null && top?.windowDays !== undefined ? String(top.windowDays) : '',
        top?.pitch ?? '',
      ]);
    }),
  ].join('\n') + '\n',
);

writeFileSync(
  join(outDir, 'today.csv'),
  [
    toCsvLine(['household', 'phone', 'why', 'pitch', 'expected_value']),
    ...ranked.slice(0, todayCount).map((r) =>
      toCsvLine([
        `${r.household.primaryFirstName ?? ''} ${r.household.primaryLastName ?? ''}`.trim(),
        r.household.phoneE164,
        r.topOpportunity?.kind ?? '',
        r.topOpportunity?.pitch ?? '',
        (r.totalExpectedValueCents / 100).toFixed(2),
      ]),
    ),
  ].join('\n') + '\n',
);

writeFileSync(
  join(outDir, 'opportunities.csv'),
  [
    toCsvLine([
      'household_id', 'name', 'phone_e164', 'kind', 'line', 'expected_value',
      'new_policy_ltv', 'retention_lift', 'close_probability', 'window_days', 'pitch', 'reasoning',
    ]),
    ...ranked.flatMap((r) =>
      r.opportunities.map((o) =>
        toCsvLine([
          r.household.id,
          `${r.household.primaryFirstName ?? ''} ${r.household.primaryLastName ?? ''}`.trim(),
          r.household.phoneE164,
          o.kind,
          o.line,
          (o.expectedValueCents / 100).toFixed(2),
          (o.newPolicyLtvCents / 100).toFixed(2),
          (o.retentionLiftCents / 100).toFixed(2),
          o.closeProbability.toFixed(2),
          o.windowDays !== null ? String(o.windowDays) : '',
          o.pitch,
          o.reasoning,
        ]),
      ),
    ),
  ].join('\n') + '\n',
);

// ── Report ───────────────────────────────────────────────────────────────────

const kindLabel: Record<string, string> = {
  renewal_save: 'Renewal saves (next 45 days)',
  home_bundle: 'Home bundle (auto-only households)',
  auto_bundle: 'Auto bundle (home-only households)',
  umbrella: 'Umbrella (already bundled)',
  life_attach: 'Term life attach',
  medicare_t65: 'Medicare — turning 65',
  commercial: 'Commercial (business owners)',
  reengage_lapsed: 'Win-back (lapsed)',
};

const sortedKinds = Object.entries(summary.opportunitiesByKind).sort(
  (a, b) => b[1].valueCents - a[1].valueCents,
);

console.log(`
════════════════════════════════════════════════════════════════
  BOOK ANALYSIS — ${basename(inputPath)}
════════════════════════════════════════════════════════════════

  Households              ${summary.households}
  Active policies         ${summary.activePolicies}
  Annual commission       ${dollars(summary.annualCommissionCents)}
  Book lifetime value     ${dollars(summary.bookLtvCents)}
  Monoline households     ${summary.monolineHouseholds} ${
    summary.households > 0
      ? `(${Math.round((summary.monolineHouseholds / summary.households) * 100)}% — each retaining at ~80% instead of ~94%)`
      : ''
  }${skipped > 0 ? `\n  Rows skipped            ${skipped} (unrecognized line of business)` : ''}

  ── OPPORTUNITIES, by expected lifetime value created ──────────
${sortedKinds
  .map(
    ([kind, v]) =>
      `  ${(kindLabel[kind] ?? kind).padEnd(38)} ${String(v.count).padStart(4)}   ${dollars(v.valueCents).padStart(10)}`,
  )
  .join('\n')}
  ${'─'.repeat(56)}
  ${'TOTAL'.padEnd(38)} ${String(ranked.length).padStart(4)}   ${dollars(summary.totalOpportunityCents).padStart(10)}

  ── FILES ──────────────────────────────────────────────────────
  ${outDir}/today.csv          the next ${todayCount} calls, in order
  ${outDir}/call-list.csv      every household, ranked
  ${outDir}/opportunities.csv  one row per opportunity, for your CRM

────────────────────────────────────────────────────────────────
  Ranked by expected LIFETIME value, not first-year commission.
  A home bundle on an auto-only household is worth more as a
  retention play than as a sale: it moves that household from
  ~80% to ~94% annual retention, which roughly triples what the
  auto policy you already have is worth over its life.

  ${summary.renewalsNext45Days > 0
    ? `${summary.renewalsNext45Days} renewal(s) inside 45 days sort first. Those are the
  highest-conversion calls you will make this month, and a missed
  one is gone for a year.`
    : 'No renewals inside 45 days — this is a cross-sell month.'}

  ⚠  These are YOUR customers, so a manual call is clean after a
     DNC scrub. An AI call still needs written consent — an
     established business relationship does not satisfy TCPA
     227(b). Capture consent on these calls and the AI opens up
     for every future campaign.
────────────────────────────────────────────────────────────────
`);
