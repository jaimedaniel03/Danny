/**
 * Do-Not-Call scrubbing.
 *
 * Four independent lists, checked in cost order (cheapest and most damaging
 * first). Any hit is fatal for the dial.
 *
 *  1. **Internal DNC** — someone told *us* to stop. Cheapest check, highest
 *     liability if missed, and the one that most often gets skipped because it
 *     lives in your own database rather than a vendor's.
 *  2. **Federal DNC Registry** — requires a paid SAN. Established-business-
 *     relationship gives an exemption for 18 months after a transaction or 3
 *     months after an inquiry, but note carefully: EBR exempts you from the
 *     *registry*, not from the artificial-voice consent rule. Danny still needs
 *     written consent.
 *  3. **State DNC registries** — a shrinking set still runs their own.
 *  4. **Litigator / serial-plaintiff lists** — commercial. Not a legal
 *     requirement; purely self-defence. A few hundred people file a large share
 *     of TCPA suits and they salt lead forms deliberately.
 *
 * Scrub results are cached with a hard TTL. Federal registry data must be
 * re-pulled at least every 31 days; we use 7 to leave margin.
 */

import type { Contact, GateFailure } from '@/types';

export const FEDERAL_SCRUB_TTL_DAYS = 7;

/** EBR exemption windows under 47 CFR 64.1200(f)(5). */
export const EBR_TRANSACTION_MONTHS = 18;
export const EBR_INQUIRY_MONTHS = 3;

export interface ScrubVerdict {
  readonly list: 'internal' | 'federal' | 'state' | 'litigator';
  readonly listed: boolean;
  readonly checkedAt: Date;
  readonly detail?: string;
}

export interface DncProvider {
  /** Federal registry lookup against our SAN. */
  checkFederal(phoneE164: string): Promise<ScrubVerdict>;
  checkState(phoneE164: string, stateCode: string | null): Promise<ScrubVerdict>;
  checkLitigator(phoneE164: string): Promise<ScrubVerdict>;
}

export interface EbrEvidence {
  /** Last completed transaction (policy bound, premium paid). */
  readonly lastTransactionAt: Date | null;
  /** Last inbound inquiry or application from the consumer. */
  readonly lastInquiryAt: Date | null;
}

function monthsAgo(count: number, from: Date): Date {
  const d = new Date(from);
  d.setMonth(d.getMonth() - count);
  return d;
}

/**
 * Whether an established business relationship exempts this contact from the
 * federal registry. Note the deliberately narrow return: this answers *only* the
 * registry question. It says nothing about whether an artificial voice may be
 * used, which is governed by 227(b) and needs written consent regardless.
 */
export function hasRegistryExemptingEbr(evidence: EbrEvidence, at: Date): boolean {
  const { lastTransactionAt, lastInquiryAt } = evidence;
  if (lastTransactionAt && lastTransactionAt >= monthsAgo(EBR_TRANSACTION_MONTHS, at)) {
    return true;
  }
  if (lastInquiryAt && lastInquiryAt >= monthsAgo(EBR_INQUIRY_MONTHS, at)) {
    return true;
  }
  return false;
}

export interface ScrubInput {
  readonly contact: Contact;
  readonly at: Date;
  readonly ebr: EbrEvidence;
  readonly provider: DncProvider;
}

export interface ScrubOutput {
  readonly verdicts: readonly ScrubVerdict[];
  readonly failures: readonly GateFailure[];
}

/**
 * Run the full scrub. Returns every verdict (for the audit trail) alongside any
 * failures, rather than short-circuiting — a partial audit record is worth less
 * than a complete one, and the checks are cheap relative to a call.
 */
export async function scrub(input: ScrubInput): Promise<ScrubOutput> {
  const { contact, at, ebr, provider } = input;
  const verdicts: ScrubVerdict[] = [];
  const failures: GateFailure[] = [];

  // 1. Internal DNC. No exemption exists for this one, ever. An EBR does not
  //    override a person telling you personally to stop.
  const internallyListed = contact.internalDncAt !== null;
  verdicts.push({
    list: 'internal',
    listed: internallyListed,
    checkedAt: at,
    ...(internallyListed
      ? { detail: `Internal DNC set at ${contact.internalDncAt?.toISOString()}` }
      : {}),
  });
  if (internallyListed) {
    failures.push({
      code: 'INTERNAL_DNC',
      detail: 'Contact previously asked us to stop calling. No exemption applies.',
      humanMayDial: false,
    });
  }

  // 2–4 run concurrently; they are independent network calls.
  const [federal, state, litigator] = await Promise.all([
    provider.checkFederal(contact.phoneE164),
    provider.checkState(contact.phoneE164, contact.stateCode),
    provider.checkLitigator(contact.phoneE164),
  ]);
  verdicts.push(federal, state, litigator);

  const ebrExempt = hasRegistryExemptingEbr(ebr, at);

  if (federal.listed && !ebrExempt) {
    failures.push({
      code: 'FEDERAL_DNC',
      detail:
        'Number is on the National Do Not Call Registry and no established ' +
        'business relationship exemption applies.',
      humanMayDial: false,
    });
  }

  if (state.listed && !ebrExempt) {
    failures.push({
      code: 'STATE_DNC',
      detail: `Number is on the ${contact.stateCode ?? 'state'} do-not-call registry.`,
      humanMayDial: false,
    });
  }

  if (litigator.listed) {
    failures.push({
      code: 'LITIGATOR_LIST',
      detail:
        'Number appears on a serial-plaintiff list. Not a legal bar, but the ' +
        'expected value of this call is deeply negative.',
      // A human could legally dial. They should not want to.
      humanMayDial: true,
    });
  }

  return { verdicts, failures };
}

/**
 * Null-object provider for dev and CI. Reports everything as unlisted, which is
 * exactly why `DANNY_DRY_RUN` must be true whenever this is wired up — it is a
 * test double, not a fallback. Production wiring lives in
 * `src/connectors/dnc-provider.ts` and fails loudly on a missing SAN.
 */
export const permissiveTestProvider: DncProvider = {
  async checkFederal(): Promise<ScrubVerdict> {
    return { list: 'federal', listed: false, checkedAt: new Date(), detail: 'TEST DOUBLE' };
  },
  async checkState(): Promise<ScrubVerdict> {
    return { list: 'state', listed: false, checkedAt: new Date(), detail: 'TEST DOUBLE' };
  },
  async checkLitigator(): Promise<ScrubVerdict> {
    return { list: 'litigator', listed: false, checkedAt: new Date(), detail: 'TEST DOUBLE' };
  },
};
