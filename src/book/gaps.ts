/**
 * Cross-sell gap analysis and opportunity ranking.
 *
 * ── The question this answers ───────────────────────────────────────────────
 * You have ~300 households and one of you. Fifteen real conversations a day is
 * a good day. So the only question that matters is which fifteen.
 *
 * ── How opportunities are valued ────────────────────────────────────────────
 * Not by first-year commission. By **expected lifetime value created**, which
 * has two parts, and the second is the one most agents never count:
 *
 *   1. The new policy's own LTV — commission ÷ (1 − retention).
 *   2. **The retention lift on what they already have.** A monoline auto
 *      household retains ~80%; add the home and it retains ~94%. On a $230/yr
 *      auto commission that is the difference between $1,150 and $3,833 of
 *      lifetime value. The bundle is worth more as a retention play than as a
 *      new sale, and ranking on first-year commission alone hides that entirely.
 *
 * Everything is multiplied by a close probability, so the ranking is expected
 * value rather than best case.
 */

import type { LineOfBusiness } from '@/types';
import {
  activeLines,
  ageAt,
  annualCommissionCents,
  daysUntil,
  nextRenewal,
  retentionFor,
  tenureYears,
  type Household,
} from './types';

export type OpportunityKind =
  | 'home_bundle'
  | 'auto_bundle'
  | 'umbrella'
  | 'life_attach'
  | 'medicare_t65'
  | 'commercial'
  | 'renewal_save'
  | 'reengage_lapsed';

export interface Opportunity {
  readonly kind: OpportunityKind;
  readonly householdId: string;
  readonly line: LineOfBusiness;
  /** Expected LTV created, in cents, after close probability. The ranking key. */
  readonly expectedValueCents: number;
  /** New-policy LTV alone, before retention effects. */
  readonly newPolicyLtvCents: number;
  /** LTV protected on existing policies by the retention lift. */
  readonly retentionLiftCents: number;
  readonly closeProbability: number;
  /** Days until this stops being timely. Null when it is not time-sensitive. */
  readonly windowDays: number | null;
  /** One sentence, in your words, for why you are calling. */
  readonly pitch: string;
  /** Why this ranks where it does — shown in the CLI so the ranking is auditable. */
  readonly reasoning: string;
}

// ─────────────────────────────────────────────────────────────
// Typical economics
// ─────────────────────────────────────────────────────────────

/**
 * First-year commission by line, in cents. Replace with your actual carrier
 * schedules once you have them — these are independent-agency typicals and the
 * ranking is only as good as these numbers.
 */
export const TYPICAL_COMMISSION_CENTS: Readonly<Record<string, number>> = {
  auto: 23_000,
  home: 21_600,
  umbrella: 4_500,
  life_term: 32_000,
  life_final_expense: 80_000,
  commercial: 30_000,
  /** Medicare Advantage: CMS-capped first year, then renewal. LTV modelled separately. */
  health_medicare: 62_600,
};

/**
 * Close probability by opportunity type, on a warm own-book call.
 *
 * These are deliberately conservative. A bundle offered to a happy five-year
 * customer converts far better than a cold quote, but "far better" is 25%, not
 * 60% — and a model that assumes 60% will send you after the wrong households.
 */
export const CLOSE_PROBABILITY: Readonly<Record<OpportunityKind, number>> = {
  home_bundle: 0.22,
  auto_bundle: 0.20,
  umbrella: 0.30,
  life_attach: 0.08,
  medicare_t65: 0.25,
  commercial: 0.10,
  renewal_save: 0.70,
  reengage_lapsed: 0.12,
};

function ltv(annualCommissionCents: number, retention: number): number {
  return Math.round(annualCommissionCents / (1 - retention));
}

// ─────────────────────────────────────────────────────────────
// Detection
// ─────────────────────────────────────────────────────────────

/**
 * Find every opportunity in a household, valued and ranked.
 */
export function findOpportunities(household: Household, now = new Date()): readonly Opportunity[] {
  const lines = activeLines(household);
  const currentRetention = retentionFor(household);
  const currentAnnual = annualCommissionCents(household);
  const opportunities: Opportunity[] = [];

  const hasAuto = lines.has('auto');
  const hasHome = lines.has('home');
  const hasLife = [...lines].some((l) => l.startsWith('life_'));
  const age = ageAt(household.dateOfBirth, now);
  const tenure = tenureYears(household, now);

  // ── Home bundle: the single most valuable pattern in a P&C book ──────────
  if (hasAuto && !hasHome && household.ownsHome !== false) {
    const commission = TYPICAL_COMMISSION_CENTS['home'] ?? 0;
    const newLtv = ltv(commission, 0.94);
    // The retention lift: what the existing book is worth at 94% vs at 80%.
    const protectedNow = ltv(currentAnnual, currentRetention);
    const protectedAfter = ltv(currentAnnual, 0.94);
    const lift = Math.max(0, protectedAfter - protectedNow);
    const p = CLOSE_PROBABILITY.home_bundle;

    opportunities.push({
      kind: 'home_bundle',
      householdId: household.id,
      line: 'home',
      expectedValueCents: Math.round((newLtv + lift) * p),
      newPolicyLtvCents: newLtv,
      retentionLiftCents: lift,
      closeProbability: p,
      windowDays: null,
      pitch:
        `You've had your auto with me ${tenure >= 1 ? `${Math.floor(tenure)} years` : 'a while'} ` +
        `— I've never quoted your home. Bundling usually takes 15–25% off the auto too.`,
      reasoning:
        `Monoline auto at ${Math.round(currentRetention * 100)}% retention. Bundling lifts it to 94%, ` +
        `which protects $${(lift / 100).toFixed(0)} of existing LTV on top of the new policy.`,
    });
  }

  // ── Auto bundle (the mirror image) ───────────────────────────────────────
  if (hasHome && !hasAuto) {
    const commission = TYPICAL_COMMISSION_CENTS['auto'] ?? 0;
    const newLtv = ltv(commission, 0.94);
    const protectedNow = ltv(currentAnnual, currentRetention);
    const protectedAfter = ltv(currentAnnual, 0.94);
    const lift = Math.max(0, protectedAfter - protectedNow);
    const p = CLOSE_PROBABILITY.auto_bundle;

    opportunities.push({
      kind: 'auto_bundle',
      householdId: household.id,
      line: 'auto',
      expectedValueCents: Math.round((newLtv + lift) * p),
      newPolicyLtvCents: newLtv,
      retentionLiftCents: lift,
      closeProbability: p,
      windowDays: null,
      pitch: `I have your home but not your cars. Want me to run the auto and see if bundling helps?`,
      reasoning: `Monoline home. Same retention economics as the home bundle, slightly lower close rate.`,
    });
  }

  // ── Umbrella: small premium, excellent margin, very sticky ───────────────
  if (hasAuto && hasHome && household.hasUmbrella !== true && currentAnnual > 30_000) {
    const commission = TYPICAL_COMMISSION_CENTS['umbrella'] ?? 0;
    const newLtv = ltv(commission, 0.96);
    const p = CLOSE_PROBABILITY.umbrella;

    opportunities.push({
      kind: 'umbrella',
      householdId: household.id,
      // Umbrella rides on the P&C license; modelled as home for licensing.
      line: 'home',
      expectedValueCents: Math.round(newLtv * p),
      newPolicyLtvCents: newLtv,
      retentionLiftCents: 0,
      closeProbability: p,
      windowDays: null,
      pitch:
        `You're bundled with me, which means an umbrella is cheap — usually around $200 a year ` +
        `for a million in extra liability. Worth five minutes?`,
      reasoning:
        `Already bundled, so the third line pushes retention to 96%. Highest close rate of any ` +
        `cross-sell because the ask is small and the customer already trusts you.`,
    });
  }

  // ── Life attach: low close rate, enormous retention effect ───────────────
  if ((hasAuto || hasHome) && !hasLife && age !== null && age >= 25 && age <= 60) {
    const commission = TYPICAL_COMMISSION_CENTS['life_term'] ?? 0;
    const newLtv = commission; // Term commission is front-loaded; treat as one-time.
    const protectedNow = ltv(currentAnnual, currentRetention);
    const protectedAfter = ltv(currentAnnual, 0.97);
    const lift = Math.max(0, protectedAfter - protectedNow);

    // Dependents or a mortgage roughly doubles the close rate.
    const motivated = (household.dependents ?? 0) > 0 || household.hasMortgage === true;
    const p = CLOSE_PROBABILITY.life_attach * (motivated ? 2 : 1);

    opportunities.push({
      kind: 'life_attach',
      householdId: household.id,
      line: 'life_term',
      expectedValueCents: Math.round((newLtv + lift) * p),
      newPolicyLtvCents: newLtv,
      retentionLiftCents: lift,
      closeProbability: p,
      windowDays: null,
      pitch: motivated
        ? `You've got the house and the kids covered on the P&C side. Nobody's ever asked you ` +
          `about term life — a healthy ${age}-year-old is usually $30–40 a month for half a million.`
        : `Quick one: has anyone ever run term life for you? At ${age} it's cheap, and it gets ` +
          `more expensive every year you wait.`,
      reasoning:
        `Age ${age}${motivated ? ', has dependents or a mortgage' : ''}. Low close rate (${Math.round(p * 100)}%) ` +
        `but a life policy in the household takes retention to 97% — the strongest signal in the book.`,
    });
  }

  // ── T-65 Medicare: the most commonly missed opportunity in a P&C book ────
  if (age !== null && age >= 63.5 && age < 65.5 && !lines.has('health_medicare')) {
    const birthday65 = household.dateOfBirth
      ? new Date(household.dateOfBirth.getFullYear() + 65, household.dateOfBirth.getMonth(), household.dateOfBirth.getDate())
      : null;
    const daysTo65 = birthday65 ? daysUntil(birthday65, now) : null;

    // MA first-year plus renewals at ~85% persistency ≈ $1,600 realistic LTV.
    const newLtv = 160_000;
    const p = CLOSE_PROBABILITY.medicare_t65;

    opportunities.push({
      kind: 'medicare_t65',
      householdId: household.id,
      line: 'health_medicare',
      expectedValueCents: Math.round(newLtv * p),
      newPolicyLtvCents: newLtv,
      retentionLiftCents: 0,
      closeProbability: p,
      // The Initial Enrollment Period is 3 months either side of the 65th birthday.
      windowDays: daysTo65 !== null ? daysTo65 + 90 : 180,
      pitch:
        `You're coming up on 65. Your Medicare enrollment window opens three months before your ` +
        `birthday — want me to walk you through the options before you get buried in mail?`,
      reasoning:
        `Age ${age}. ~$1,600 LTV — below a home bundle, but the opportunity most agents never look ` +
        `for at all, and it expires. Needs an active health license and CMS permission-to-contact.`,
    });
  }

  // ── Commercial hiding in a personal book ─────────────────────────────────
  if (household.businessOwner === true && !lines.has('commercial')) {
    const commission = TYPICAL_COMMISSION_CENTS['commercial'] ?? 0;
    const newLtv = ltv(commission, 0.90);
    const p = CLOSE_PROBABILITY.commercial;

    opportunities.push({
      kind: 'commercial',
      householdId: household.id,
      line: 'commercial',
      expectedValueCents: Math.round(newLtv * p),
      newPolicyLtvCents: newLtv,
      retentionLiftCents: 0,
      closeProbability: p,
      windowDays: null,
      pitch: `I insure you personally — who handles the business side? Happy to take a look at that too.`,
      reasoning: `Business owner in a personal-lines book. Long cycle, low close rate, but large premium.`,
    });
  }

  // ── Renewal save: the highest-probability call you will make all month ────
  for (const policy of household.policies.filter((p) => p.status === 'active')) {
    const renewal = nextRenewal(policy.renewalDate, now);
    const days = daysUntil(renewal, now);
    if (days > 45 || days < 0) continue;

    const p = CLOSE_PROBABILITY.renewal_save;
    const atRisk = ltv(policy.annualCommissionCents, currentRetention);

    opportunities.push({
      kind: 'renewal_save',
      householdId: household.id,
      line: policy.line,
      expectedValueCents: Math.round(atRisk * (1 - currentRetention) * p),
      newPolicyLtvCents: 0,
      retentionLiftCents: atRisk,
      closeProbability: p,
      windowDays: days,
      pitch:
        `Your ${policy.line.replace(/_/g, ' ')} renews ${renewal.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}. ` +
        `I want to re-shop it before it does rather than after you get the bill.`,
      reasoning:
        `Renews in ${days} days. A proactive re-shop call is the single highest-conversion call in ` +
        `the book — you are not selling, you are preventing a shop.`,
    });
  }

  // ── Win-back ─────────────────────────────────────────────────────────────
  const lapsed = household.policies.filter(
    (p) => p.status === 'lapsed' || p.status === 'non_renewed',
  );
  if (lapsed.length > 0 && household.policies.every((p) => p.status !== 'active')) {
    const lostCommission = lapsed.reduce((s, p) => s + p.annualCommissionCents, 0);
    const p = CLOSE_PROBABILITY.reengage_lapsed;
    const newLtv = ltv(lostCommission, 0.85);

    opportunities.push({
      kind: 'reengage_lapsed',
      householdId: household.id,
      line: lapsed[0]?.line ?? 'auto',
      expectedValueCents: Math.round(newLtv * p),
      newPolicyLtvCents: newLtv,
      retentionLiftCents: 0,
      closeProbability: p,
      windowDays: null,
      pitch: `We used to handle your ${lapsed[0]?.line.replace(/_/g, ' ')}. Worth another look at what's out there now?`,
      reasoning:
        `Former customer, no active policies. Low close rate, but the DNC established-business-relationship ` +
        `exemption runs 18 months from the last transaction — check the clock before dialling.`,
    });
  }

  return opportunities.sort((a, b) => b.expectedValueCents - a.expectedValueCents);
}

// ─────────────────────────────────────────────────────────────
// Book-level ranking
// ─────────────────────────────────────────────────────────────

export interface RankedHousehold {
  readonly household: Household;
  readonly opportunities: readonly Opportunity[];
  readonly totalExpectedValueCents: number;
  /** Best single reason to call today. */
  readonly topOpportunity: Opportunity | null;
  /** Time-sensitive opportunities move to the front regardless of value. */
  readonly urgent: boolean;
}

/**
 * Rank a whole book.
 *
 * Urgency beats value: a renewal 12 days out that you miss is gone for a year,
 * while a life cross-sell is worth the same next month. So anything with a
 * window under 45 days sorts ahead of everything without one, and value ranks
 * within each group.
 */
export function rankBook(
  households: readonly Household[],
  now = new Date(),
): readonly RankedHousehold[] {
  const ranked = households.map((household): RankedHousehold => {
    const opportunities = findOpportunities(household, now);
    const urgent = opportunities.some((o) => o.windowDays !== null && o.windowDays <= 45);
    return {
      household,
      opportunities,
      totalExpectedValueCents: opportunities.reduce((s, o) => s + o.expectedValueCents, 0),
      topOpportunity: opportunities[0] ?? null,
      urgent,
    };
  });

  return ranked
    .filter((r) => r.opportunities.length > 0)
    .sort((a, b) => {
      if (a.urgent !== b.urgent) return a.urgent ? -1 : 1;
      return b.totalExpectedValueCents - a.totalExpectedValueCents;
    });
}

export interface BookSummary {
  readonly households: number;
  readonly activePolicies: number;
  readonly annualCommissionCents: number;
  readonly bookLtvCents: number;
  readonly monolineHouseholds: number;
  readonly opportunitiesByKind: Readonly<Record<string, { count: number; valueCents: number }>>;
  readonly totalOpportunityCents: number;
  readonly renewalsNext45Days: number;
}

export function summarizeBook(
  households: readonly Household[],
  now = new Date(),
): BookSummary {
  const byKind: Record<string, { count: number; valueCents: number }> = {};
  let totalOpportunity = 0;
  let renewalsSoon = 0;
  let monoline = 0;
  let activePolicies = 0;
  let annual = 0;
  let bookLtv = 0;

  for (const household of households) {
    const lines = activeLines(household);
    if (lines.size === 1) monoline++;
    activePolicies += household.policies.filter((p) => p.status === 'active').length;
    annual += annualCommissionCents(household);
    bookLtv += Math.round(annualCommissionCents(household) / (1 - retentionFor(household)));

    for (const opportunity of findOpportunities(household, now)) {
      const bucket = (byKind[opportunity.kind] ??= { count: 0, valueCents: 0 });
      bucket.count++;
      bucket.valueCents += opportunity.expectedValueCents;
      totalOpportunity += opportunity.expectedValueCents;
      if (opportunity.kind === 'renewal_save') renewalsSoon++;
    }
  }

  return {
    households: households.length,
    activePolicies,
    annualCommissionCents: annual,
    bookLtvCents: bookLtv,
    monolineHouseholds: monoline,
    opportunitiesByKind: byKind,
    totalOpportunityCents: totalOpportunity,
    renewalsNext45Days: renewalsSoon,
  };
}
