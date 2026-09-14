/**
 * Lead triage — sort a raw lead CSV into queues by what is legally and
 * economically possible with each contact.
 *
 *   npm run leads:triage -- leads/leads.csv
 *   npm run leads:triage -- leads/leads.csv --states CA,AZ --line auto
 *
 * Every lead is run through the real compliance gate (`evaluateGate`) — the
 * same code that will guard production dials — and lands in exactly one queue:
 *
 *   ai_ready      Danny may call it (pending live DNC scrub — see caveat).
 *   human_queue   A licensed human may call it; Danny may not.
 *   needs_review  Fixable data problem: unknown state/timezone, unparseable
 *                 field, split-timezone state, unrecognized consent label.
 *   out_of_scope  Nobody calls it: invalid phone, DNC, unlicensed state.
 *
 * ── THE BIG CAVEAT, printed on every run ─────────────────────────────────────
 * This script has no DNC SAN and no litigator-scrub credentials, so it uses
 * the permissive test provider: every number reports as UNLISTED. Triage
 * output is a *sorting* of your list, not clearance to dial any row of it.
 * The production gate re-runs with live scrubbing before every single call.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { evaluateGate, type GateInput, type LicenseGrant } from '../src/compliance/gate';
import { permissiveTestProvider } from '../src/compliance/dnc';
import { localClock } from '../src/compliance/calling-hours';
import {
  disclosureContext,
  licenseGrants,
  licensedStateCodes,
  loadProfileSafe,
  PROFILE_PATH,
} from '../src/config/agency';
import {
  inferConsentBasis,
  normalizePhoneUS,
  normalizeState,
  parseCsv,
  stateToTimezone,
  toCsvLine,
  zipToState,
} from '../src/leads/normalize';
import type { ConsentRecord, Contact, GateFailureCode, LineOfBusiness } from '../src/types';

// ── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const inputPath = args.find((a) => !a.startsWith('--')) ?? 'leads/leads.csv';

function flag(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  const next = idx >= 0 ? args[idx + 1] : undefined;
  return next !== undefined && !next.startsWith('--') ? next : fallback;
}

const defaultLine = flag('line', 'auto') as LineOfBusiness;
const outDir = flag('out', 'out');

/**
 * Triage must sort against the *same* licensing the production gate will apply.
 *
 * It used to synthesize licenses from `--states` and grant every class in every
 * one of them, which quietly inverts the point of the exercise: a life lead in a
 * P&C-only agency sorts `ai_ready` here and is refused at dial time with
 * LICENSE_CLASS_MISSING. A triage that disagrees with the gate is worse than no
 * triage, because you work the queue believing it.
 *
 * So the profile wins whenever there is one. `--states` remains for a first run
 * before `npm run setup`, and that path says out loud that it is guessing.
 */
const profile = loadProfileSafe();
const statesFlag = flag('states', '');

const licensedStates: string[] = profile
  ? [...licensedStateCodes(profile)]
  : statesFlag
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);

if (!profile && licensedStates.length === 0) {
  console.error(
    `No ${PROFILE_PATH} and no --states.\n\n` +
      `Run \`npm run setup\` so triage sorts against the licenses the gate will\n` +
      `actually enforce. To sort a list before then, pass the states by hand:\n\n` +
      `  npm run leads:triage -- ${inputPath} --states CA,AZ\n\n` +
      `That path assumes every license class in every state, which will sort some\n` +
      `leads optimistically.`,
  );
  process.exit(1);
}

if (profile && statesFlag) {
  console.warn(
    `[triage] --states ignored: ${PROFILE_PATH} lists ${licensedStates.join(', ')}.\n` +
      `         Edit the profile rather than the flag, or the gate will disagree.\n`,
  );
}

// ── Load ─────────────────────────────────────────────────────────────────────

if (!existsSync(inputPath)) {
  console.error(
    `No lead file at "${inputPath}".\n` +
      `Copy leads/TEMPLATE.csv, fill it in (phone is the only required column),\n` +
      `save it as leads/leads.csv, and run again. The leads/ directory is\n` +
      `gitignored — real lead data never gets committed.`,
  );
  process.exit(1);
}

const rows = parseCsv(readFileSync(inputPath, 'utf-8'));
const headerRow = rows[0];
if (!headerRow) {
  console.error('Lead file is empty.');
  process.exit(1);
}
const header = headerRow.map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
const col = (name: string): number => header.indexOf(name);

const idx = {
  firstName: col('first_name'),
  lastName: col('last_name'),
  phone: col('phone'),
  email: col('email'),
  city: col('city'),
  state: col('state'),
  zip: col('zip'),
  consentBasis: col('consent_basis'),
  consentProof: col('consent_proof_url'),
  consentDate: col('consent_date'),
  source: col('source'),
  line: col('line'),
};

if (idx.phone < 0) {
  console.error(`Lead file needs a "phone" column. Found: ${header.join(', ')}`);
  process.exit(1);
}

const cell = (row: readonly string[], i: number): string => (i >= 0 ? (row[i] ?? '').trim() : '');

// ── Evaluate ─────────────────────────────────────────────────────────────────

type Queue = 'ai_ready' | 'human_queue' | 'needs_review' | 'out_of_scope';

interface TriagedLead {
  readonly queue: Queue;
  readonly reasons: readonly string[];
  readonly row: readonly string[];
  readonly phoneE164: string | null;
  readonly stateCode: string | null;
  readonly stateInferred: boolean;
  readonly tzSplit: boolean;
}

const licenses: readonly LicenseGrant[] = profile
  ? licenseGrants(profile)
  : licensedStates.map((stateCode) => ({
      stateCode,
      // No profile means no way to know which classes are held, so this assumes
      // all three and the report says so. It is the optimistic direction, which
      // is why the profile path exists.
      classes: ['p_and_c', 'life', 'health'],
      expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000),
    }));

/**
 * Find an instant whose local wall-clock in `tz` is mid-window (~2pm), so the
 * calling-hours check reflects the lead's dialability in principle rather than
 * whatever time this script happens to run.
 */
function midWindowInstant(tz: string): Date {
  const base = new Date();
  base.setUTCMinutes(30, 0, 0);
  for (let h = 0; h < 24; h++) {
    const candidate = new Date(base);
    candidate.setUTCHours(h);
    try {
      const clock = localClock(candidate, tz);
      if (clock.minuteOfDay >= 13 * 60 && clock.minuteOfDay <= 15 * 60) return candidate;
    } catch {
      break;
    }
  }
  return base;
}

const OUT_OF_SCOPE_CODES: ReadonlySet<GateFailureCode> = new Set([
  'INVALID_PHONE',
  'INTERNAL_DNC',
  'FEDERAL_DNC',
  'STATE_DNC',
  'LITIGATOR_LIST',
  'STATE_NOT_LICENSED',
  'LICENSE_CLASS_MISSING',
]);

const seenPhones = new Map<string, number>();
const triaged: TriagedLead[] = [];
let duplicates = 0;

for (let r = 1; r < rows.length; r++) {
  const row = rows[r];
  if (!row) continue;
  const reasons: string[] = [];

  // Phone
  const phoneRaw = cell(row, idx.phone);
  const phoneE164 = normalizePhoneUS(phoneRaw);
  if (!phoneE164) {
    triaged.push({
      queue: 'out_of_scope',
      reasons: [`unparseable phone "${phoneRaw}"`],
      row, phoneE164: null, stateCode: null, stateInferred: false, tzSplit: false,
    });
    continue;
  }

  // Dedupe on the number: the second row for a phone is noise, and dialing it
  // twice doubles the attempt count against the frequency caps.
  const firstSeen = seenPhones.get(phoneE164);
  if (firstSeen !== undefined) {
    duplicates++;
    triaged.push({
      queue: 'needs_review',
      reasons: [`duplicate of row ${firstSeen} (${phoneE164})`],
      row, phoneE164, stateCode: null, stateInferred: false, tzSplit: false,
    });
    continue;
  }
  seenPhones.set(phoneE164, r + 1);

  // State: explicit column first, zip inference second.
  let stateCode = normalizeState(cell(row, idx.state));
  let stateInferred = false;
  if (!stateCode) {
    stateCode = zipToState(cell(row, idx.zip));
    if (stateCode) {
      stateInferred = true;
      reasons.push(`state ${stateCode} inferred from zip — confirm`);
    }
  }

  const tzGuess = stateToTimezone(stateCode);
  const tzSplit = tzGuess?.confidence === 'split';
  if (tzSplit) {
    reasons.push(
      `${stateCode} spans timezones; assumed ${tzGuess?.timezone} — confirm before edge-of-window dials`,
    );
  }

  // Consent
  const { basis, recognized } = inferConsentBasis(cell(row, idx.consentBasis));
  if (!recognized) {
    reasons.push(
      `consent label "${cell(row, idx.consentBasis)}" not recognized — treated as none`,
    );
  }
  const proof = cell(row, idx.consentProof);
  let effectiveBasis = basis;
  if (basis === 'prior_express_written' && !proof) {
    // Written consent you cannot produce evidence for is not written consent
    // in the only venue where the distinction matters.
    effectiveBasis = 'prior_express';
    reasons.push('claims written consent but no proof URL — downgraded to human-only');
  }

  const line = (cell(row, idx.line) as LineOfBusiness) || defaultLine;

  const contact: Contact = {
    id: `lead_${r}`,
    phoneE164,
    lineType: 'unknown',
    firstName: cell(row, idx.firstName) || null,
    lastName: cell(row, idx.lastName) || null,
    email: cell(row, idx.email) || null,
    stateCode,
    postalCode: cell(row, idx.zip) || null,
    timezone: tzGuess?.timezone ?? null,
    dateOfBirth: null,
    isExistingPolicyholder: effectiveBasis === 'established_business_relationship',
    internalDncAt: null,
    // The source column was already parsed and then thrown away. The gate
    // refuses an AI call on a prospecting-database source, so carrying it is
    // the difference between that control existing and merely being declared.
    leadSource: cell(row, idx.source) || null,
  };

  const consentDateRaw = cell(row, idx.consentDate);
  const capturedAt = consentDateRaw ? new Date(consentDateRaw) : new Date(0);
  const consent: ConsentRecord = {
    id: `lead_consent_${r}`,
    contactId: contact.id,
    phoneE164,
    basis: effectiveBasis,
    disclosureText: null,
    sourceUri: proof || null,
    capturedAt: Number.isNaN(capturedAt.getTime()) ? new Date(0) : capturedAt,
    expiresAt: null,
    ipAddress: null,
    userAgent: null,
    scopedLines: [],
    revokedAt: null,
  };

  const at = contact.timezone ? midWindowInstant(contact.timezone) : new Date();

  const input: GateInput = {
    contact,
    line,
    consents: effectiveBasis === 'none' ? [] : [consent],
    licenses,
    ebr: { lastTransactionAt: null, lastInquiryAt: null },
    medicare: null,
    attempts: { today: 0, thisWeek: 0, last24h: 0 },
    disclosure: profile
      ? disclosureContext(profile)
      : {
          agentDisplayName: 'Danny',
          agencyLegalName: 'Unconfigured Agency',
          agencyNpn: null,
          medicarePlanCount: null,
        },
    dncProvider: permissiveTestProvider,
    at,
    killSwitchEngaged: false,
  };

  // Top-level await keeps ordering simple for a 300-row file.
  const result = await evaluateGate(input);

  let queue: Queue;
  if (result.ok) {
    // A clean pass with inferred/split location data still needs eyes before a dial.
    queue = stateInferred || tzSplit ? 'needs_review' : 'ai_ready';
    if (queue === 'ai_ready') reasons.push('gate passed (DNC unscrubbed — see report caveat)');
  } else {
    const codes = new Set(result.failures.map((f) => f.code));
    for (const f of result.failures) reasons.push(`${f.code}: ${f.detail}`);

    if ([...codes].some((c) => OUT_OF_SCOPE_CODES.has(c))) {
      queue = 'out_of_scope';
    } else if (
      result.failures.length > 0 &&
      result.failures.every((f) => f.humanMayDial)
    ) {
      queue = 'human_queue';
    } else if (codes.has('NO_CONSENT_RECORD')) {
      // No consent at all: Danny never; a human may still cold-call after a
      // real DNC scrub, which is a human-queue decision, not a dead lead.
      queue = 'human_queue';
    } else {
      queue = 'needs_review';
    }
  }

  triaged.push({ queue, reasons, row, phoneE164, stateCode, stateInferred, tzSplit });
}

// ── Write outputs ────────────────────────────────────────────────────────────

mkdirSync(outDir, { recursive: true });

const outHeader = [...header, 'phone_e164', 'state_resolved', 'triage_reasons'];
const queues: Queue[] = ['ai_ready', 'human_queue', 'needs_review', 'out_of_scope'];

for (const q of queues) {
  const members = triaged.filter((t) => t.queue === q);
  const lines = [
    toCsvLine(outHeader),
    ...members.map((t) =>
      toCsvLine([...t.row, t.phoneE164, t.stateCode, t.reasons.join(' | ')]),
    ),
  ];
  writeFileSync(join(outDir, `${q}.csv`), lines.join('\n') + '\n');
}

// ── Report ───────────────────────────────────────────────────────────────────

const count = (q: Queue): number => triaged.filter((t) => t.queue === q).length;
const total = triaged.length;
const pct = (n: number): string => (total ? `${Math.round((n / total) * 100)}%` : '0%');

const stateTally = new Map<string, number>();
for (const t of triaged) {
  const key = t.stateCode ?? '??';
  stateTally.set(key, (stateTally.get(key) ?? 0) + 1);
}
const stateLine = [...stateTally.entries()]
  .sort((a, b) => b[1] - a[1])
  .map(([s, n]) => `${s}:${n}`)
  .join('  ');

console.log(`
════════════════════════════════════════════════════════════════
  LEAD TRIAGE — ${basename(inputPath)}
════════════════════════════════════════════════════════════════

  Leads read            ${total}${duplicates ? `   (${duplicates} duplicate number${duplicates === 1 ? '' : 's'})` : ''}
  Licensed states       ${licensedStates.join(', ')}${profile ? '' : '   (from --states, not a profile)'}
  License classes       ${profile ? [...new Set(licenses.flatMap((l) => l.classes))].join(', ') : 'all assumed — see caveat'}
  Default line          ${defaultLine}

  ai_ready              ${String(count('ai_ready')).padStart(4)}   ${pct(count('ai_ready'))}
  human_queue           ${String(count('human_queue')).padStart(4)}   ${pct(count('human_queue'))}
  needs_review          ${String(count('needs_review')).padStart(4)}   ${pct(count('needs_review'))}
  out_of_scope          ${String(count('out_of_scope')).padStart(4)}   ${pct(count('out_of_scope'))}

  By state              ${stateLine}

  Queue files written to ${outDir}/

────────────────────────────────────────────────────────────────
  ⚠  DNC WAS NOT SCRUBBED. This run had no DNC SAN or litigator
     credentials, so every number reported as unlisted. Triage
     sorts your list; it does not clear any number to dial. The
     production gate re-checks with live scrubbing per call.
${
  profile
    ? ''
    : `
  ⚠  NO AGENCY PROFILE. Licensing came from --states and assumed
     every class in every one of them, so some rows sorted
     ai_ready that the production gate will refuse for
     LICENSE_CLASS_MISSING. Run \`npm run setup\` and triage again
     before working this list.
`
}
  Next steps, in order — see docs/09-LEAD-TRIAGE.md:
    1. Fix and re-run needs_review rows (usually minutes of work).
    2. human_queue is worked by a licensed person, after a real
       DNC scrub. It is probably your biggest queue — that is
       normal and those leads are not wasted.
    3. ai_ready dials only after the Phase 0 checklist is done.
────────────────────────────────────────────────────────────────
`);
