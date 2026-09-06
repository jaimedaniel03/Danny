/**
 * Book of business — households and policies.
 *
 * ── Why this module exists ──────────────────────────────────────────────────
 * A lead list asks "who can I call?" A book asks a better question: "who do I
 * call FIRST?" With ~300 households and one producer, prioritization is the
 * entire problem — you have maybe 15 real conversations a day, so the ranking
 * decides the year.
 *
 * The unit here is the HOUSEHOLD, not the policy. Cross-sell opportunities only
 * exist at household level: "has auto, no home" is invisible if you look at
 * policies one at a time, and it is the single most valuable pattern in a P&C
 * book.
 */

import type { LineOfBusiness } from '@/types';

export type PolicyStatus = 'active' | 'lapsed' | 'cancelled' | 'non_renewed';

export interface Policy {
  readonly id: string;
  readonly householdId: string;
  readonly line: LineOfBusiness;
  readonly carrier: string;
  readonly policyNumber: string;
  readonly status: PolicyStatus;
  /** Annual premium in cents. */
  readonly annualPremiumCents: number;
  /** Your annual commission in cents. What the relationship is actually worth. */
  readonly annualCommissionCents: number;
  readonly effectiveDate: Date;
  /** The date the whole calendar hangs off. */
  readonly renewalDate: Date;
  /** When it was first written — drives the EBR clock and tenure. */
  readonly writtenDate: Date;
}

export interface Household {
  readonly id: string;
  readonly primaryFirstName: string | null;
  readonly primaryLastName: string | null;
  readonly phoneE164: string | null;
  readonly email: string | null;
  readonly stateCode: string | null;
  readonly postalCode: string | null;
  /** Primary insured's DOB. Drives the T-65 Medicare flag. */
  readonly dateOfBirth: Date | null;

  readonly policies: readonly Policy[];

  // ── Signals that create opportunities ──────────────────────
  /** Owns rather than rents. An auto-only homeowner is the best cross-sell there is. */
  readonly ownsHome: boolean | null;
  readonly hasMortgage: boolean | null;
  readonly dependents: number | null;
  readonly maritalStatus: 'single' | 'married' | 'unknown' | null;
  /** Self-employed or owns a business — a commercial opportunity hiding in a personal book. */
  readonly businessOwner: boolean | null;
  /**
   * Already carries a personal umbrella.
   *
   * Tracked separately because umbrella rides the P&C license and is modelled
   * as the `home` line — so without this flag a household that already has one
   * is indistinguishable from one that needs one, and gets pitched forever.
   */
  readonly hasUmbrella: boolean | null;

  /** Last time you spoke to them. Silence is itself a retention risk. */
  readonly lastContactAt: Date | null;
  readonly notes: string | null;
}

// ─────────────────────────────────────────────────────────────
// Retention economics
// ─────────────────────────────────────────────────────────────

/**
 * Annual retention by household composition.
 *
 * These figures are the reason cross-sell matters more than it looks. A
 * monoline auto policy retains around 80%; add the home and the household
 * retains around 94%. Selling the bundle is not only ~$216 of new commission —
 * it protects the auto commission you already have, every year, compounding.
 *
 * Industry ranges, not your book. Once you have twelve months of your own
 * renewal data, replace them.
 */
export const RETENTION_BY_COMPOSITION = {
  monoline: 0.80,
  bundled_two: 0.94,
  bundled_three_plus: 0.96,
  /** A life policy in the household is the strongest retention signal there is. */
  with_life: 0.97,
} as const;

export function retentionFor(household: Household): number {
  const active = household.policies.filter((p) => p.status === 'active');
  const lines = new Set(active.map((p) => p.line));
  const hasLife = [...lines].some((l) => l.startsWith('life_'));

  if (hasLife) return RETENTION_BY_COMPOSITION.with_life;
  if (lines.size >= 3) return RETENTION_BY_COMPOSITION.bundled_three_plus;
  if (lines.size === 2) return RETENTION_BY_COMPOSITION.bundled_two;
  return RETENTION_BY_COMPOSITION.monoline;
}

/**
 * Lifetime value of a household at a given retention rate.
 *
 * Geometric sum: annual commission / (1 - retention). At 80% retention a
 * household is worth 5× its annual commission; at 94% it is worth 16.7×.
 * That gap — not the first-year commission — is what a bundle actually buys.
 */
export function householdLtvCents(household: Household): number {
  const annual = household.policies
    .filter((p) => p.status === 'active')
    .reduce((sum, p) => sum + p.annualCommissionCents, 0);
  const retention = retentionFor(household);
  return Math.round(annual / (1 - retention));
}

export function annualCommissionCents(household: Household): number {
  return household.policies
    .filter((p) => p.status === 'active')
    .reduce((sum, p) => sum + p.annualCommissionCents, 0);
}

export function activeLines(household: Household): ReadonlySet<LineOfBusiness> {
  return new Set(
    household.policies.filter((p) => p.status === 'active').map((p) => p.line),
  );
}

/** Earliest write date across active policies — how long they have been with you. */
export function tenureYears(household: Household, now = new Date()): number {
  const active = household.policies.filter((p) => p.status === 'active');
  if (active.length === 0) return 0;
  const earliest = Math.min(...active.map((p) => p.writtenDate.getTime()));
  return (now.getTime() - earliest) / (365.25 * 86_400_000);
}

/**
 * Established business relationship dates, for the compliance gate.
 *
 * An active policy is a continuing transaction, so the EBR clock runs from the
 * most recent renewal rather than the original sale. This exempts you from the
 * federal DNC registry — and, importantly, does NOT exempt you from the
 * artificial-voice consent rule. A current customer is still an AI call that
 * needs written consent.
 */
export function ebrEvidence(household: Household, now = new Date()): {
  readonly lastTransactionAt: Date | null;
  readonly lastInquiryAt: Date | null;
} {
  const active = household.policies.filter((p) => p.status === 'active');
  if (active.length === 0) {
    // A lapsed customer still counts for a while — from their last renewal.
    const lapsed = household.policies
      .map((p) => p.renewalDate.getTime())
      .filter((t) => t <= now.getTime());
    return {
      lastTransactionAt: lapsed.length > 0 ? new Date(Math.max(...lapsed)) : null,
      lastInquiryAt: household.lastContactAt,
    };
  }

  // Most recent renewal that has already occurred.
  const past = active
    .map((p) => mostRecentRenewal(p.renewalDate, now).getTime())
    .filter((t) => t <= now.getTime());

  return {
    lastTransactionAt: past.length > 0 ? new Date(Math.max(...past)) : null,
    lastInquiryAt: household.lastContactAt,
  };
}

/**
 * Policies renew annually. Walk the stored date to the most recent anniversary
 * at or before `now` — in BOTH directions.
 *
 * Stepping only backwards was a real bug: an export carrying the original 2021
 * renewal date for a policy still in force would report the EBR as five years
 * stale, wrongly failing the 18-month DNC exemption and blocking a call that is
 * entirely lawful.
 */
function mostRecentRenewal(renewalDate: Date, now: Date): Date {
  const d = new Date(renewalDate);
  while (d > now) d.setFullYear(d.getFullYear() - 1);
  // Then forward, in case the stored date is years in the past.
  for (;;) {
    const next = new Date(d);
    next.setFullYear(next.getFullYear() + 1);
    if (next > now) break;
    d.setFullYear(d.getFullYear() + 1);
  }
  return d;
}

/** Next renewal anniversary at or after `now`. */
export function nextRenewal(renewalDate: Date, now = new Date()): Date {
  const d = new Date(renewalDate);
  while (d < now) d.setFullYear(d.getFullYear() + 1);
  return d;
}

export function daysUntil(date: Date, now = new Date()): number {
  return Math.ceil((date.getTime() - now.getTime()) / 86_400_000);
}

/** Age in whole years, or null when the DOB is unknown. */
export function ageAt(dateOfBirth: Date | null, at = new Date()): number | null {
  if (!dateOfBirth) return null;
  let age = at.getFullYear() - dateOfBirth.getFullYear();
  const monthDiff = at.getMonth() - dateOfBirth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && at.getDate() < dateOfBirth.getDate())) age--;
  return age;
}
