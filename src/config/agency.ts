/**
 * The agency profile — one file describing your business, read by everything.
 *
 * Before this existed, your agency name lived in an env var, your licensed
 * states in a different env var, your NPN in a third, and the producer's name
 * was hardcoded in a prompt. Changing agencies meant finding all of them.
 *
 * More importantly: several of these fields are **legally load-bearing**, and a
 * wrong value fails in opposite directions.
 *
 *   `licensedStates` too narrow  → the gate blocks leads you could lawfully work
 *   `licensedStates` too wide    → the gate permits an unlicensed solicitation
 *
 * The second one is a regulatory problem with your state DOI, not a bug report.
 * So `validateProfile` is strict, `loadProfile` refuses to return an invalid
 * profile, and CI runs the validation as part of the compliance suite.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { LicenseClass, LineOfBusiness } from '@/types';
import { LINE_LICENSE, MEDICARE_LINES } from '@/types';

// ─────────────────────────────────────────────────────────────
// Shape
// ─────────────────────────────────────────────────────────────

export interface ProducerProfile {
  /** Legal name as it appears on the license. */
  readonly legalName: string;
  /** What Danny calls them out loud: "let me get you to Sarah". */
  readonly displayName: string;
  readonly npn: string;
  readonly email: string;
  /** E.164. Where warm transfers land. */
  readonly transferPhoneE164: string | null;
  /** Whose voice is cloned, if any. At most one producer should be true. */
  readonly isVoiceSubject: boolean;
}

export interface StateLicense {
  readonly stateCode: string;
  readonly classes: readonly LicenseClass[];
  readonly licenseNumber: string;
  /** ISO date. The gate refuses to dial into a state whose license has lapsed. */
  readonly expiresAt: string;
}

export interface AgencyProfile {
  /** Exactly as it appears on the license and in the disclosure. */
  readonly legalName: string;
  /** What customers call you, if different. Used in email copy. */
  readonly displayName: string;
  /** Agency-level National Producer Number. Required for Medicare. */
  readonly npn: string | null;

  /** CAN-SPAM requires a real physical address in every commercial email. */
  readonly postalAddress: string;

  /** The name Danny gives itself on calls. */
  readonly agentDisplayName: string;

  readonly producers: readonly ProducerProfile[];
  readonly licenses: readonly StateLicense[];

  /** Lines you actually sell. Drives discovery fields and license checks. */
  readonly lines: readonly LineOfBusiness[];

  /** Carriers you hold appointments with. You cannot quote what you can't sell. */
  readonly appointedCarriers: readonly string[];

  readonly phone: {
    /** The DID prospects see and call back. */
    readonly callerIdE164: string;
    /** Set once A2P 10DLC registration is approved. */
    readonly messagingServiceSid: string | null;
  };

  readonly email: {
    readonly fromName: string;
    readonly fromAddress: string;
    readonly replyTo: string;
  };

  /**
   * Medicare only. CMS requires a truthful count in the TPMO disclaimer, so
   * this is not decorative — an inflated number is a marketing violation.
   */
  readonly medicarePlanCount: {
    readonly carriers: number;
    readonly plans: number;
  } | null;

  /** Set by counsel once the consent language has been reviewed. */
  readonly disclosureVersion: string;
}

// ─────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────

export interface ProfileProblem {
  readonly field: string;
  readonly message: string;
  /** `blocking` refuses to load. `warning` loads but is reported loudly. */
  readonly severity: 'blocking' | 'warning';
}

const USPS = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY',
  'LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH',
  'OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY',
]);

const E164 = /^\+[1-9]\d{7,14}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validateProfile(profile: AgencyProfile, now = new Date()): readonly ProfileProblem[] {
  const problems: ProfileProblem[] = [];
  const blocking = (field: string, message: string): void => {
    problems.push({ field, message, severity: 'blocking' });
  };
  const warn = (field: string, message: string): void => {
    problems.push({ field, message, severity: 'warning' });
  };

  // ── Identity ──────────────────────────────────────────────
  if (!profile.legalName.trim()) {
    blocking('legalName', 'Required. This is the name spoken in the AI disclosure and named in every consent record.');
  }
  if (/example|your agency|acme|test/i.test(profile.legalName)) {
    blocking('legalName', `"${profile.legalName}" looks like a placeholder. Consent naming a fictional seller is not consent.`);
  }
  if (!profile.postalAddress.trim()) {
    blocking('postalAddress', 'Required by CAN-SPAM in every commercial email. A PO box is acceptable.');
  }

  // ── Licensing — the field most likely to be wrong ─────────
  if (profile.licenses.length === 0) {
    blocking('licenses', 'At least one state license is required. With none, the gate blocks every outbound contact.');
  }

  for (const license of profile.licenses) {
    const code = license.stateCode.toUpperCase();
    if (!USPS.has(code)) {
      blocking('licenses', `"${license.stateCode}" is not a USPS state code.`);
    }
    if (license.classes.length === 0) {
      blocking('licenses', `${code} lists no license classes.`);
    }
    const expiry = new Date(license.expiresAt);
    if (Number.isNaN(expiry.getTime())) {
      blocking('licenses', `${code} has an unparseable expiry "${license.expiresAt}".`);
    } else if (expiry <= now) {
      blocking('licenses', `${code} license expired ${license.expiresAt}. Renew it or remove the state.`);
    } else if (expiry.getTime() - now.getTime() < 60 * 86_400_000) {
      warn('licenses', `${code} license expires ${license.expiresAt} — inside 60 days. Outreach into ${code} stops that day.`);
    }
  }

  // ── Lines must be covered by a license class somewhere ────
  for (const line of profile.lines) {
    const required: LicenseClass = LINE_LICENSE[line];
    const covered = profile.licenses.some((l) => {
      const held = new Set(l.classes);
      return required === 'life_and_health'
        ? held.has('life') && held.has('health')
        : held.has(required) || held.has('life_and_health');
    });
    if (!covered) {
      blocking(
        'lines',
        `You list "${line}" as a line you sell, but no state license carries the "${required}" class. ` +
          `Either remove the line or add the license.`,
      );
    }
  }

  if (profile.lines.length === 0) {
    blocking('lines', 'At least one line of business is required.');
  }

  // ── Medicare carries extra requirements ───────────────────
  const sellsMedicare = profile.lines.some((l) => MEDICARE_LINES.has(l));
  if (sellsMedicare) {
    if (!profile.npn) {
      blocking('npn', 'Medicare requires the agency NPN in the CMS TPMO disclaimer.');
    }
    if (!profile.medicarePlanCount) {
      blocking(
        'medicarePlanCount',
        'Medicare requires a truthful carrier and plan count in the TPMO disclaimer. ' +
          'An inflated count is a CMS marketing violation.',
      );
    }
    if (profile.appointedCarriers.length === 0) {
      warn('appointedCarriers', 'Medicare listed but no carrier appointments recorded.');
    }
  }

  // ── Producers ─────────────────────────────────────────────
  if (profile.producers.length === 0) {
    blocking('producers', 'At least one licensed producer is required — Danny qualifies, a human closes.');
  }

  const voiceSubjects = profile.producers.filter((p) => p.isVoiceSubject);
  if (voiceSubjects.length > 1) {
    blocking('producers', 'More than one producer marked as the voice subject. Exactly one voice is cloned.');
  }

  const transferable = profile.producers.filter((p) => p.transferPhoneE164);
  if (transferable.length === 0) {
    blocking(
      'producers',
      'No producer has a transfer number. The AI disclosure promises a human on request — ' +
        'without one, that promise is a lie and the disclosure is defective.',
    );
  }
  for (const p of profile.producers) {
    if (p.transferPhoneE164 && !E164.test(p.transferPhoneE164)) {
      blocking('producers', `${p.displayName}'s transfer number "${p.transferPhoneE164}" is not E.164 (+15551234567).`);
    }
    if (p.email && !EMAIL.test(p.email)) {
      warn('producers', `${p.displayName}'s email "${p.email}" looks malformed.`);
    }
  }

  // ── Channels ──────────────────────────────────────────────
  if (!E164.test(profile.phone.callerIdE164)) {
    blocking('phone.callerIdE164', `"${profile.phone.callerIdE164}" is not E.164. Use +1 then ten digits.`);
  }
  if (!profile.phone.messagingServiceSid) {
    warn(
      'phone.messagingServiceSid',
      'No A2P 10DLC Messaging Service. SMS will be silently filtered by carriers — ' +
        'messages look sent and never arrive. Voice and email are unaffected.',
    );
  }
  if (!EMAIL.test(profile.email.fromAddress)) {
    blocking('email.fromAddress', `"${profile.email.fromAddress}" is not a valid address.`);
  }
  if (/@(gmail|yahoo|outlook|hotmail|icloud)\./i.test(profile.email.fromAddress)) {
    warn(
      'email.fromAddress',
      'Sending from a consumer mailbox. Volume from a personal address burns its reputation ' +
        'on the first campaign. Use a dedicated domain with SPF, DKIM and DMARC.',
    );
  }

  // ── Disclosure ────────────────────────────────────────────
  if (profile.disclosureVersion.startsWith('draft-')) {
    warn(
      'disclosureVersion',
      'Consent disclosure language has not been reviewed by counsel. Fine for development; ' +
        'consent captured under unreviewed text may be void.',
    );
  }

  return problems;
}

// ─────────────────────────────────────────────────────────────
// Loading
// ─────────────────────────────────────────────────────────────

export class ProfileInvalidError extends Error {
  constructor(readonly problems: readonly ProfileProblem[]) {
    const blockers = problems.filter((p) => p.severity === 'blocking');
    super(
      `agency.config.json has ${blockers.length} blocking problem(s):\n` +
        blockers.map((p) => `  ✗ ${p.field}: ${p.message}`).join('\n') +
        `\n\nRun \`npm run setup\` to fix them interactively.`,
    );
    this.name = 'ProfileInvalidError';
  }
}

let cached: AgencyProfile | null = null;

export const PROFILE_PATH = 'agency.config.json';

/**
 * Load and validate the profile. Throws on any blocking problem — a
 * misconfigured agency must not reach the point of dialling.
 */
export function loadProfile(options: { readonly path?: string; readonly force?: boolean } = {}): AgencyProfile {
  if (cached && !options.force) return cached;

  const path = options.path ?? join(process.cwd(), PROFILE_PATH);
  if (!existsSync(path)) {
    throw new Error(
      `No ${PROFILE_PATH} found. Run \`npm run setup\` to create one, or copy ` +
        `agency.config.example.json and fill it in.`,
    );
  }

  const profile = JSON.parse(readFileSync(path, 'utf-8')) as AgencyProfile;
  const problems = validateProfile(profile);

  const warnings = problems.filter((p) => p.severity === 'warning');
  for (const w of warnings) console.warn(`[agency] ⚠ ${w.field}: ${w.message}`);

  if (problems.some((p) => p.severity === 'blocking')) {
    throw new ProfileInvalidError(problems);
  }

  cached = profile;
  return profile;
}

/**
 * Load the profile for a DISPLAY-ONLY context, returning null rather than
 * throwing when it is absent or invalid.
 *
 * Two different failure postures, deliberately:
 *
 *   `loadProfile()`      throws. Anything that dials, sends, or captures
 *                        consent must refuse rather than improvise, because an
 *                        improvised agency name in a consent record is a
 *                        consent record naming the wrong seller.
 *
 *   `loadProfileSafe()`  returns null. A rendered page that cannot find the
 *                        profile should degrade, not 500 — but its callers must
 *                        then handle null explicitly rather than substituting a
 *                        placeholder into anything legally operative.
 */
export function loadProfileSafe(): AgencyProfile | null {
  try {
    return loadProfile();
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Derived views
// ─────────────────────────────────────────────────────────────

/** The shape `evaluateGate` wants. */
export function licenseGrants(
  profile: AgencyProfile,
): readonly { stateCode: string; classes: readonly ('p_and_c' | 'life' | 'health')[]; expiresAt: Date }[] {
  return profile.licenses.map((l) => ({
    stateCode: l.stateCode.toUpperCase(),
    classes: l.classes.flatMap((c) =>
      c === 'life_and_health' ? (['life', 'health'] as const) : ([c] as const),
    ),
    expiresAt: new Date(l.expiresAt),
  }));
}

/** The shape the disclosure builder wants. */
export function disclosureContext(profile: AgencyProfile): {
  readonly agencyLegalName: string;
  readonly agencyPostalAddress: string;
  readonly agentDisplayName: string;
  readonly agencyNpn: string | null;
  readonly medicarePlanCount: { readonly carriers: number; readonly plans: number } | null;
} {
  return {
    agencyLegalName: profile.legalName,
    agencyPostalAddress: profile.postalAddress,
    agentDisplayName: profile.agentDisplayName,
    agencyNpn: profile.npn,
    medicarePlanCount: profile.medicarePlanCount,
  };
}

export function primaryProducer(profile: AgencyProfile): ProducerProfile {
  const producer = profile.producers.find((p) => p.transferPhoneE164) ?? profile.producers[0];
  if (!producer) throw new Error('Profile has no producers — validation should have caught this.');
  return producer;
}

export function voiceSubject(profile: AgencyProfile): ProducerProfile | null {
  return profile.producers.find((p) => p.isVoiceSubject) ?? null;
}

export function licensedStateCodes(profile: AgencyProfile): readonly string[] {
  return profile.licenses.map((l) => l.stateCode.toUpperCase());
}
