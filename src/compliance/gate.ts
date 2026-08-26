/**
 * The compliance gate.
 *
 * Every outbound dial in this system passes through `evaluateGate()`. There is
 * no second path and no override flag. The dialer's signature accepts only a
 * `DialAuthorization`, and the only way to obtain one is to be handed it by this
 * function — the branded field cannot be constructed elsewhere.
 *
 * The gate is deliberately slow and chatty. It runs every check even after the
 * first failure, because the audit record is the product. When you are sitting
 * across from a plaintiff's lawyer, "we checked and here is the frozen evidence
 * blob from 400ms before the dial" is a different conversation from "our policy
 * was to check."
 *
 * ── The rule that shapes everything ──────────────────────────────────────────
 * An AI voice is an *artificial voice* under 47 U.S.C. 227(b)(1)(A)(iii). The
 * FCC said so in its February 2024 Declaratory Ruling. Artificial voice to a
 * wireless number requires **prior express written consent**. Not implied
 * consent. Not "they filled out a form." Not an established business
 * relationship. Signed, and naming the seller.
 *
 * Statutory damages are $500 per call, trebled to $1,500 for willful or knowing
 * violations, with no cap and a private right of action. A 10,000-dial campaign
 * with bad consent is a $5–15M exposure. This is why the gate is the first
 * thing in the repo and not a later hardening pass.
 */

import type {
  Contact,
  ConsentRecord,
  DialAuthorization,
  GateFailure,
  GateResult,
  LineOfBusiness,
} from '@/types';
import { AI_DIALABLE_BASES, LINE_LICENSE, MEDICARE_LINES } from '@/types';
import { checkCallingHours } from './calling-hours';
import { buildOpeningDisclosure, type DisclosureContext } from './disclosure';
import { scrub, type DncProvider, type EbrEvidence, type ScrubVerdict } from './dnc';

/** How long an authorization stays valid. Short by design. */
const AUTHORIZATION_TTL_MS = 60_000;

/** Attempt caps. Federal law is quieter here than you'd hope; these are policy. */
export const ATTEMPT_CAPS = {
  perContactPerDay: 2,
  perContactPerWeek: 5,
  /** Florida's FTSA caps solicitation on the same subject at 3 per 24h. */
  floridaPer24h: 3,
} as const;

export interface LicenseGrant {
  readonly stateCode: string;
  readonly classes: readonly ('p_and_c' | 'life' | 'health')[];
  readonly expiresAt: Date;
}

export interface MedicareContext {
  /**
   * CMS prohibits unsolicited contact with Medicare beneficiaries. A permission
   * to contact must be captured, is scoped to the product it names, and expires
   * — commonly treated as 12 months, shorter for some plan types.
   */
  readonly permissionToContactAt: Date | null;
  readonly permissionScope: readonly LineOfBusiness[];
}

export interface GateInput {
  readonly contact: Contact;
  readonly line: LineOfBusiness;
  readonly consents: readonly ConsentRecord[];
  readonly licenses: readonly LicenseGrant[];
  readonly ebr: EbrEvidence;
  readonly medicare: MedicareContext | null;
  readonly attempts: {
    readonly today: number;
    readonly thisWeek: number;
    readonly last24h: number;
  };
  readonly disclosure: Omit<DisclosureContext, 'line' | 'contactStateCode'>;
  readonly dncProvider: DncProvider;
  readonly at: Date;
  /** Global stop. Flipping this halts all dialing without a deploy. */
  readonly killSwitchEngaged: boolean;
}

const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * Select the consent record that actually authorizes an AI dial for this line,
 * if one exists. Returns the record plus the reasons every candidate was
 * rejected, so the audit trail explains the near-misses too.
 */
function selectConsent(
  consents: readonly ConsentRecord[],
  line: LineOfBusiness,
  at: Date,
): { chosen: ConsentRecord | null; rejections: GateFailure[] } {
  const rejections: GateFailure[] = [];

  if (consents.length === 0) {
    rejections.push({
      code: 'NO_CONSENT_RECORD',
      detail: 'No consent record exists for this number.',
      humanMayDial: false,
    });
    return { chosen: null, rejections };
  }

  let chosen: ConsentRecord | null = null;

  for (const c of consents) {
    if (c.revokedAt !== null && c.revokedAt <= at) {
      rejections.push({
        code: 'CONSENT_REVOKED',
        detail: `Consent ${c.id} revoked at ${c.revokedAt.toISOString()}.`,
        humanMayDial: false,
      });
      continue;
    }
    if (c.expiresAt !== null && c.expiresAt <= at) {
      rejections.push({
        code: 'CONSENT_EXPIRED',
        detail: `Consent ${c.id} expired at ${c.expiresAt.toISOString()}.`,
        humanMayDial: true,
      });
      continue;
    }
    if (c.scopedLines.length > 0 && !c.scopedLines.includes(line)) {
      rejections.push({
        code: 'CONSENT_SCOPE_MISMATCH',
        detail:
          `Consent ${c.id} covers [${c.scopedLines.join(', ')}] but this call is ` +
          `for ${line}. Consent does not travel across lines of business.`,
        humanMayDial: false,
      });
      continue;
    }
    if (!AI_DIALABLE_BASES.has(c.basis)) {
      rejections.push({
        code: 'CONSENT_BASIS_INSUFFICIENT_FOR_AI',
        detail:
          `Consent ${c.id} rests on "${c.basis}". An AI voice is an artificial ` +
          `voice under TCPA 227(b) and requires prior express written consent. ` +
          `A licensed human producer may dial this contact.`,
        // This is the single most important flag in the system: it routes the
        // lead to a human queue instead of silently discarding a real prospect.
        humanMayDial: true,
      });
      continue;
    }

    // First fully-valid record wins. Records are expected to arrive newest-first.
    chosen ??= c;
  }

  return { chosen, rejections };
}

function checkLicensing(
  licenses: readonly LicenseGrant[],
  contact: Contact,
  line: LineOfBusiness,
  at: Date,
): GateFailure[] {
  const failures: GateFailure[] = [];
  const state = contact.stateCode?.toUpperCase() ?? null;

  if (!state) {
    failures.push({
      code: 'STATE_NOT_LICENSED',
      detail: 'Contact state unknown; cannot verify producer licensing.',
      humanMayDial: false,
    });
    return failures;
  }

  const grant = licenses.find((l) => l.stateCode.toUpperCase() === state && l.expiresAt > at);
  if (!grant) {
    failures.push({
      code: 'STATE_NOT_LICENSED',
      detail:
        `No active producer license in ${state}. Soliciting insurance in a state ` +
        `where you are not appointed is an unauthorized-practice problem before ` +
        `it is a TCPA problem.`,
      humanMayDial: false,
    });
    return failures;
  }

  const required = LINE_LICENSE[line];
  const held = new Set(grant.classes);
  const satisfied =
    required === 'life_and_health'
      ? held.has('life') && held.has('health')
      : held.has(required);

  if (!satisfied) {
    failures.push({
      code: 'LICENSE_CLASS_MISSING',
      detail: `${state} license does not include the "${required}" class required for ${line}.`,
      humanMayDial: false,
    });
  }

  return failures;
}

function checkMedicare(
  medicare: MedicareContext | null,
  line: LineOfBusiness,
  at: Date,
): GateFailure[] {
  if (!MEDICARE_LINES.has(line)) return [];

  if (!medicare || medicare.permissionToContactAt === null) {
    return [
      {
        code: 'MEDICARE_PTC_MISSING',
        detail:
          'CMS prohibits unsolicited contact with Medicare beneficiaries. A scoped, ' +
          'documented permission to contact is required before any outbound call.',
        humanMayDial: false,
      },
    ];
  }

  const twelveMonthsAgo = new Date(at);
  twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
  if (medicare.permissionToContactAt < twelveMonthsAgo) {
    return [
      {
        code: 'MEDICARE_PTC_MISSING',
        detail: 'Permission to contact is older than 12 months and has lapsed.',
        humanMayDial: false,
      },
    ];
  }

  if (medicare.permissionScope.length > 0 && !medicare.permissionScope.includes(line)) {
    return [
      {
        code: 'MEDICARE_PTC_MISSING',
        detail: `Permission to contact does not cover ${line}.`,
        humanMayDial: false,
      },
    ];
  }

  return [];
}

function checkAttemptCaps(
  attempts: GateInput['attempts'],
  stateCode: string | null,
): GateFailure[] {
  const failures: GateFailure[] = [];

  if (attempts.today >= ATTEMPT_CAPS.perContactPerDay) {
    failures.push({
      code: 'ATTEMPT_CAP_EXCEEDED',
      detail: `${attempts.today} attempts already today (cap ${ATTEMPT_CAPS.perContactPerDay}).`,
      humanMayDial: false,
    });
  }
  if (attempts.thisWeek >= ATTEMPT_CAPS.perContactPerWeek) {
    failures.push({
      code: 'ATTEMPT_CAP_EXCEEDED',
      detail: `${attempts.thisWeek} attempts this week (cap ${ATTEMPT_CAPS.perContactPerWeek}).`,
      humanMayDial: false,
    });
  }
  if (
    stateCode?.toUpperCase() === 'FL' &&
    attempts.last24h >= ATTEMPT_CAPS.floridaPer24h
  ) {
    failures.push({
      code: 'ATTEMPT_CAP_EXCEEDED',
      detail: 'Florida FTSA caps solicitation calls on the same subject at 3 per 24 hours.',
      humanMayDial: false,
    });
  }

  return failures;
}

/**
 * Evaluate every gate condition and, on a clean pass, mint a short-lived
 * authorization carrying a frozen snapshot of the evidence.
 */
export async function evaluateGate(input: GateInput): Promise<GateResult> {
  const { contact, line, at } = input;
  const failures: GateFailure[] = [];

  if (input.killSwitchEngaged) {
    return {
      ok: false,
      failures: [
        {
          code: 'KILL_SWITCH_ENGAGED',
          detail: 'Global dialing kill switch is engaged.',
          humanMayDial: false,
        },
      ],
    };
  }

  if (!E164.test(contact.phoneE164)) {
    return {
      ok: false,
      failures: [
        {
          code: 'INVALID_PHONE',
          detail: `"${contact.phoneE164}" is not a valid E.164 number.`,
          humanMayDial: false,
        },
      ],
    };
  }

  // ── Consent ────────────────────────────────────────────────────────────────
  const { chosen: consent, rejections } = selectConsent(input.consents, line, at);
  if (!consent) failures.push(...rejections);

  // ── DNC ────────────────────────────────────────────────────────────────────
  const scrubResult = await scrub({
    contact,
    at,
    ebr: input.ebr,
    provider: input.dncProvider,
  });
  failures.push(...scrubResult.failures);

  // ── Hours ──────────────────────────────────────────────────────────────────
  const hours = checkCallingHours({
    at,
    timezone: contact.timezone,
    stateCode: contact.stateCode,
  });
  if (!hours.allowed) {
    failures.push({
      code: contact.timezone ? 'OUTSIDE_CALLING_HOURS' : 'UNKNOWN_TIMEZONE',
      detail: hours.reason,
      humanMayDial: false,
    });
  }

  // ── Licensing, Medicare, attempt caps ──────────────────────────────────────
  failures.push(...checkLicensing(input.licenses, contact, line, at));
  failures.push(...checkMedicare(input.medicare, line, at));
  failures.push(...checkAttemptCaps(input.attempts, contact.stateCode));

  if (failures.length > 0 || !consent) {
    return { ok: false, failures };
  }

  // ── Mint the authorization ─────────────────────────────────────────────────
  const disclosureCtx: DisclosureContext = {
    ...input.disclosure,
    line,
    contactStateCode: contact.stateCode,
  };

  const evidence: Record<string, unknown> = {
    gateVersion: GATE_VERSION,
    evaluatedAt: at.toISOString(),
    phone: contact.phoneE164,
    lineType: contact.lineType,
    stateCode: contact.stateCode,
    timezone: contact.timezone,
    consent: {
      id: consent.id,
      basis: consent.basis,
      capturedAt: consent.capturedAt.toISOString(),
      sourceUri: consent.sourceUri,
      disclosureText: consent.disclosureText,
      scopedLines: consent.scopedLines,
    },
    scrub: scrubResult.verdicts.map((v: ScrubVerdict) => ({
      list: v.list,
      listed: v.listed,
      checkedAt: v.checkedAt.toISOString(),
      detail: v.detail ?? null,
    })),
    callingWindow: hours.allowed ? hours.window : null,
    attempts: input.attempts,
    ebr: {
      lastTransactionAt: input.ebr.lastTransactionAt?.toISOString() ?? null,
      lastInquiryAt: input.ebr.lastInquiryAt?.toISOString() ?? null,
    },
  };

  const authorization = Object.freeze({
    contactId: contact.id,
    phoneE164: contact.phoneE164,
    line,
    consentId: consent.id,
    consentBasis: consent.basis,
    evidence: Object.freeze(evidence),
    issuedAt: at,
    expiresAt: new Date(at.getTime() + AUTHORIZATION_TTL_MS),
    requiredDisclosure: buildOpeningDisclosure(disclosureCtx),
  }) as unknown as DialAuthorization;

  return { ok: true, authorization };
}

/** Bump whenever check semantics change. Stamped into every evidence blob. */
export const GATE_VERSION = '2026.08.1';

/** An authorization is single-use and short-lived; the dialer re-checks freshness. */
export function isAuthorizationFresh(auth: DialAuthorization, now: Date): boolean {
  return now < auth.expiresAt;
}

/**
 * Partition failures into "nobody may call" and "route to a human producer".
 * The second bucket is where a large share of the business actually lives:
 * a lead with unsigned web-form consent is worthless to Danny and perfectly
 * good for a licensed human, and throwing it away is the most expensive
 * mistake this system could quietly make.
 */
export function routeFailures(failures: readonly GateFailure[]): {
  readonly dead: readonly GateFailure[];
  readonly humanQueue: readonly GateFailure[];
} {
  const dead = failures.filter((f) => !f.humanMayDial);
  return {
    dead,
    humanQueue: dead.length === 0 ? failures.filter((f) => f.humanMayDial) : [],
  };
}
