/**
 * Interactive setup — writes agency.config.json.
 *
 *   npm run setup
 *
 * Asks only what cannot be inferred, validates as it goes, and refuses to write
 * a profile that would fail `validateProfile`. The alternative — a template you
 * fill in by hand — reliably produces a config with a placeholder agency name
 * and a guessed licensed state, and both of those are legal problems rather
 * than typos.
 *
 * Re-running is safe: an existing profile is loaded as defaults, so you can
 * change one field by pressing Enter through the rest.
 */

import { createInterface } from 'node:readline/promises';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { stdin, stdout } from 'node:process';
import { validateProfile, PROFILE_PATH, type AgencyProfile, type StateLicense, type ProducerProfile } from '../src/config/agency';
import type { LicenseClass, LineOfBusiness } from '../src/types';

const rl = createInterface({ input: stdin, output: stdout });

const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
const red = (s: string): string => `\x1b[31m${s}\x1b[0m`;
const green = (s: string): string => `\x1b[32m${s}\x1b[0m`;
const amber = (s: string): string => `\x1b[33m${s}\x1b[0m`;

async function ask(question: string, fallback?: string): Promise<string> {
  const suffix = fallback ? dim(` [${fallback}]`) : '';
  const answer = (await rl.question(`${question}${suffix}\n> `)).trim();
  return answer || fallback || '';
}

async function askRequired(question: string, fallback?: string): Promise<string> {
  for (;;) {
    const answer = await ask(question, fallback);
    if (answer) return answer;
    console.log(red('  Required.'));
  }
}

async function askYesNo(question: string, fallback = false): Promise<boolean> {
  const answer = await ask(`${question} ${dim('(y/n)')}`, fallback ? 'y' : 'n');
  return /^y/i.test(answer);
}

/** Accepts anything a person would type and normalizes to E.164. */
function toE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (raw.startsWith('+') && digits.length >= 8) return `+${digits}`;
  return null;
}

async function askPhone(question: string, fallback?: string): Promise<string> {
  for (;;) {
    const raw = await askRequired(question, fallback);
    const e164 = toE164(raw);
    if (e164) return e164;
    console.log(red('  Not a usable number. Try 510-555-0100 or +15105550100.'));
  }
}

const ALL_LINES: readonly { key: LineOfBusiness; label: string; className: LicenseClass }[] = [
  { key: 'auto', label: 'Auto', className: 'p_and_c' },
  { key: 'home', label: 'Home', className: 'p_and_c' },
  { key: 'commercial', label: 'Commercial / business', className: 'p_and_c' },
  { key: 'life_term', label: 'Term life', className: 'life' },
  { key: 'life_permanent', label: 'Whole / IUL', className: 'life' },
  { key: 'life_final_expense', label: 'Final expense', className: 'life' },
  { key: 'health_uh65', label: 'Health (under 65 / ACA)', className: 'health' },
  { key: 'health_medicare', label: 'Medicare', className: 'health' },
];

async function main(): Promise<void> {
  console.log(`
${bold('Danny — agency setup')}
${dim('Writes agency.config.json. Everything here is read by the compliance gate,')}
${dim('so a wrong answer changes what the system will and will not do.')}
`);

  const existing: Partial<AgencyProfile> = existsSync(PROFILE_PATH)
    ? (JSON.parse(readFileSync(PROFILE_PATH, 'utf-8')) as AgencyProfile)
    : {};

  if (existsSync(PROFILE_PATH)) {
    console.log(dim('Found an existing profile — press Enter to keep each value.\n'));
  }

  // ── Agency ────────────────────────────────────────────────
  console.log(bold('\n1. Your agency\n'));

  const legalName = await askRequired(
    'Legal name, exactly as licensed.\n' +
      dim('  Spoken in the AI disclosure and named in every consent record.'),
    existing.legalName,
  );
  const displayName = await ask('What customers call you', existing.displayName ?? legalName);
  const postalAddress = await askRequired(
    'Physical postal address.\n' + dim('  CAN-SPAM requires this in every commercial email. A PO box is fine.'),
    existing.postalAddress,
  );
  const agentDisplayName = await ask(
    'What should the AI call itself on calls?',
    existing.agentDisplayName ?? 'Danny',
  );

  // ── Lines ─────────────────────────────────────────────────
  console.log(bold('\n2. What you sell\n'));
  ALL_LINES.forEach((l, i) => console.log(`  ${i + 1}. ${l.label}`));

  const linesInput = await askRequired(
    '\nWhich lines? Numbers separated by commas.',
    existing.lines?.map((l) => ALL_LINES.findIndex((a) => a.key === l) + 1).join(','),
  );
  const lines = linesInput
    .split(',')
    .map((n) => ALL_LINES[Number.parseInt(n.trim(), 10) - 1])
    .filter((l): l is (typeof ALL_LINES)[number] => Boolean(l));

  const requiredClasses = new Set<LicenseClass>(lines.map((l) => l.className));
  console.log(
    dim(`\n  Those lines need: ${[...requiredClasses].join(', ')}\n`),
  );

  // ── Licensing ─────────────────────────────────────────────
  console.log(bold('3. Where you are licensed\n'));
  console.log(
    amber('  Only states where you hold an ACTIVE license.\n') +
      dim('  Too few blocks leads you could lawfully work. Too many lets the system\n') +
      dim('  solicit where you are not licensed — a DOI problem, not a bug.\n'),
  );

  const stateCodes = (
    await askRequired(
      'State codes, comma separated (CA,NV,AZ)',
      existing.licenses?.map((l) => l.stateCode).join(','),
    )
  )
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  const licenses: StateLicense[] = [];
  for (const stateCode of stateCodes) {
    const prior = existing.licenses?.find((l) => l.stateCode.toUpperCase() === stateCode);
    console.log(dim(`\n  ${stateCode}:`));
    const licenseNumber = await askRequired(`  License number`, prior?.licenseNumber);
    const expiresAt = await askRequired(`  Expires (YYYY-MM-DD)`, prior?.expiresAt);

    const classes: LicenseClass[] = [];
    for (const className of requiredClasses) {
      const held = await askYesNo(
        `  Does the ${stateCode} license cover ${className.replace(/_/g, ' ')}?`,
        prior?.classes.includes(className) ?? true,
      );
      if (held) classes.push(className);
    }
    licenses.push({ stateCode, classes, licenseNumber, expiresAt });
  }

  // ── Producers ─────────────────────────────────────────────
  console.log(bold('\n4. Who closes\n'));
  console.log(
    dim('  Danny qualifies and books; a licensed human closes. Calls transfer here\n') +
      dim('  whenever someone asks for a person — the AI disclosure promises that.\n'),
  );

  const producers: ProducerProfile[] = [];
  let addMore = true;
  let index = 0;
  while (addMore) {
    const prior = existing.producers?.[index];
    const producerLegal = await askRequired('  Producer legal name', prior?.legalName);
    const producerDisplay = await ask(
      '  First name the AI says out loud',
      prior?.displayName ?? producerLegal.split(' ')[0] ?? '',
    );
    const npn = await ask('  Their NPN', prior?.npn ?? '');
    const email = await ask('  Their email', prior?.email ?? '');
    const transferPhoneE164 = await askPhone(
      '  Transfer number (where warm transfers ring)',
      prior?.transferPhoneE164 ?? undefined,
    );
    const isVoiceSubject =
      producers.length === 0
        ? await askYesNo("  Clone this person's voice?", prior?.isVoiceSubject ?? true)
        : false;

    producers.push({
      legalName: producerLegal,
      displayName: producerDisplay,
      npn,
      email,
      transferPhoneE164,
      isVoiceSubject,
    });
    index++;
    addMore = await askYesNo('  Add another producer?', false);
  }

  // ── Channels ──────────────────────────────────────────────
  console.log(bold('\n5. How you reach people\n'));

  const callerIdE164 = await askPhone(
    'Your Twilio number — what prospects see and call back',
    existing.phone?.callerIdE164,
  );
  const messagingServiceSid = await ask(
    `Twilio Messaging Service SID ${dim('(blank if 10DLC is not registered yet)')}`,
    existing.phone?.messagingServiceSid ?? '',
  );
  const fromAddress = await askRequired(
    'Email "from" address.\n' + dim('  Use a dedicated domain, not Gmail — volume burns a personal address.'),
    existing.email?.fromAddress,
  );
  const fromName = await ask('Email "from" name', existing.email?.fromName ?? displayName);
  const replyTo = await ask('Reply-to address', existing.email?.replyTo ?? fromAddress);

  // ── Medicare ──────────────────────────────────────────────
  let npn: string | null = existing.npn ?? null;
  let medicarePlanCount: AgencyProfile['medicarePlanCount'] = existing.medicarePlanCount ?? null;

  if (lines.some((l) => l.key === 'health_medicare')) {
    console.log(bold('\n6. Medicare\n'));
    console.log(
      amber('  CMS requires a truthful carrier and plan count read aloud on every call.\n') +
        dim('  An inflated count is a marketing violation. Count what you actually represent.\n'),
    );
    npn = await askRequired('  Agency NPN', npn ?? '');
    const carriers = Number.parseInt(await askRequired('  How many carriers do you represent?'), 10);
    const plans = Number.parseInt(await askRequired('  How many plans across them?'), 10);
    medicarePlanCount = { carriers, plans };
  } else if (!npn) {
    npn = (await ask('\nAgency NPN (optional for your lines)')) || null;
  }

  const appointedCarriers = (
    await ask(
      'Carriers you are appointed with, comma separated',
      existing.appointedCarriers?.join(', ') ?? '',
    )
  )
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);

  // ── Assemble & validate ───────────────────────────────────
  const profile: AgencyProfile = {
    legalName,
    displayName,
    npn,
    postalAddress,
    agentDisplayName,
    producers,
    licenses,
    lines: lines.map((l) => l.key),
    appointedCarriers,
    phone: { callerIdE164, messagingServiceSid: messagingServiceSid || null },
    email: { fromName, fromAddress, replyTo },
    medicarePlanCount,
    disclosureVersion: existing.disclosureVersion ?? 'draft-v1',
  };

  const problems = validateProfile(profile);
  const blocking = problems.filter((p) => p.severity === 'blocking');
  const warnings = problems.filter((p) => p.severity === 'warning');

  console.log('');
  for (const w of warnings) console.log(amber(`  ⚠ ${w.field}: ${w.message}`));
  for (const b of blocking) console.log(red(`  ✗ ${b.field}: ${b.message}`));

  if (blocking.length > 0) {
    console.log(
      red(`\n${blocking.length} blocking problem(s). Nothing written — re-run and correct them.\n`),
    );
    rl.close();
    process.exit(1);
  }

  writeFileSync(PROFILE_PATH, JSON.stringify(profile, null, 2) + '\n');
  console.log(green(`\n  ✓ Wrote ${PROFILE_PATH}\n`));

  console.log(`${bold('Next:')}
  1. ${warnings.some((w) => w.field === 'disclosureVersion')
        ? amber('Have counsel review the consent language in src/consent/disclosure-text.ts,\n     then add a reviewed version and update disclosureVersion.')
        : 'Consent language is marked reviewed.'}
  2. Fill in .env.local — API keys only; everything about your agency now lives
     in ${PROFILE_PATH}.
  3. ${dim('npm run compliance:selftest')} — must pass before anything dials.
  4. ${dim('npm run leads:triage -- leads/leads.csv')} — sort your list.

  Licensed in: ${licenses.map((l) => l.stateCode).join(', ')}
  Selling: ${lines.map((l) => l.label).join(', ')}
  Transfers ring: ${producers.filter((p) => p.transferPhoneE164).map((p) => p.displayName).join(', ')}
`);

  rl.close();
}

main().catch((err: unknown) => {
  console.error(red(`\nSetup failed: ${String(err)}`));
  rl.close();
  process.exit(1);
});
