import { describe, expect, it } from 'vitest';
import { findOpportunities, rankBook, summarizeBook } from './gaps';
import {
  activeLines,
  ebrEvidence,
  householdLtvCents,
  nextRenewal,
  retentionFor,
  type Household,
  type Policy,
} from './types';
import type { LineOfBusiness } from '@/types';

const NOW = new Date('2026-09-06T12:00:00Z');

function policy(over: Partial<Policy> & { line: LineOfBusiness }): Policy {
  return {
    id: `p_${over.line}`,
    householdId: 'h1',
    carrier: 'Safeco',
    policyNumber: 'X1',
    status: 'active',
    annualPremiumCents: 200_000,
    annualCommissionCents: 23_000,
    effectiveDate: new Date('2024-01-15'),
    // Far from NOW so renewal_save does not fire unless a test wants it.
    renewalDate: new Date('2027-03-15'),
    writtenDate: new Date('2021-01-15'),
    ...over,
  };
}

function household(over: Partial<Household> = {}): Household {
  return {
    id: 'h1',
    primaryFirstName: 'Dana',
    primaryLastName: 'Ruiz',
    phoneE164: '+14155550123',
    email: 'dana@example.com',
    stateCode: 'CA',
    postalCode: '94110',
    dateOfBirth: new Date('1985-04-02'),
    policies: [policy({ line: 'auto' })],
    ownsHome: null,
    hasMortgage: null,
    dependents: null,
    maritalStatus: null,
    businessOwner: null,
    hasUmbrella: null,
    lastContactAt: null,
    notes: null,
    ...over,
  };
}

const kinds = (h: Household): string[] => findOpportunities(h, NOW).map((o) => o.kind);

// ── Retention economics ──────────────────────────────────────────────────────

describe('retention drives the whole model', () => {
  it('rates a monoline household well below a bundled one', () => {
    const mono = household();
    const bundled = household({ policies: [policy({ line: 'auto' }), policy({ line: 'home' })] });

    expect(retentionFor(mono)).toBe(0.8);
    expect(retentionFor(bundled)).toBe(0.94);
  });

  it('treats a life policy as the strongest retention signal', () => {
    const withLife = household({
      policies: [policy({ line: 'auto' }), policy({ line: 'life_term' })],
    });
    expect(retentionFor(withLife)).toBe(0.97);
  });

  it('turns a 14-point retention gap into roughly triple the lifetime value', () => {
    const mono = household();
    const bundled = household({
      policies: [
        policy({ line: 'auto' }),
        policy({ line: 'home', annualCommissionCents: 0 }),
      ],
    });

    // Same commission, different composition — the difference is retention alone.
    expect(householdLtvCents(mono)).toBe(115_000); // 23000 / 0.20
    expect(householdLtvCents(bundled)).toBeCloseTo(383_333, -2); // 23000 / 0.06
  });
});

// ── Cross-sell detection ─────────────────────────────────────────────────────

describe('cross-sell gaps', () => {
  it('finds the home bundle on an auto-only household', () => {
    expect(kinds(household())).toContain('home_bundle');
  });

  it('does not offer a home bundle to someone who already has home', () => {
    const bundled = household({ policies: [policy({ line: 'auto' }), policy({ line: 'home' })] });
    expect(kinds(bundled)).not.toContain('home_bundle');
  });

  it('skips the home bundle for a known renter', () => {
    expect(kinds(household({ ownsHome: false }))).not.toContain('home_bundle');
  });

  it('offers the auto bundle to a home-only household', () => {
    const homeOnly = household({ policies: [policy({ line: 'home' })] });
    expect(kinds(homeOnly)).toContain('auto_bundle');
    expect(kinds(homeOnly)).not.toContain('auto_bundle_duplicate');
  });

  it('offers an umbrella only once already bundled', () => {
    expect(kinds(household())).not.toContain('umbrella');
    const bundled = household({ policies: [policy({ line: 'auto' }), policy({ line: 'home' })] });
    expect(kinds(bundled)).toContain('umbrella');
  });

  it('stops pitching an umbrella to someone who already has one', () => {
    // Umbrella rides the P&C license and is modelled as the home line, so
    // without an explicit flag these households get pitched every single month.
    const covered = household({
      policies: [policy({ line: 'auto' }), policy({ line: 'home' })],
      hasUmbrella: true,
    });
    expect(kinds(covered)).not.toContain('umbrella');
  });

  it('values the home bundle mostly as retention, not as a new sale', () => {
    const opportunity = findOpportunities(household(), NOW).find((o) => o.kind === 'home_bundle');
    expect(opportunity).toBeDefined();
    // The point of the whole module: protecting existing LTV outweighs the new policy.
    expect(opportunity!.retentionLiftCents).toBeGreaterThan(0);
    expect(opportunity!.retentionLiftCents).toBeGreaterThan(opportunity!.newPolicyLtvCents / 2);
  });
});

describe('life attach', () => {
  it('offers term life to an insurable-age P&C household', () => {
    expect(kinds(household())).toContain('life_attach');
  });

  it('does not offer it to someone who already has life', () => {
    const withLife = household({
      policies: [policy({ line: 'auto' }), policy({ line: 'life_term' })],
    });
    expect(kinds(withLife)).not.toContain('life_attach');
  });

  it('skips it outside the practical age band', () => {
    expect(kinds(household({ dateOfBirth: new Date('1950-01-01') }))).not.toContain('life_attach');
    expect(kinds(household({ dateOfBirth: new Date('2008-01-01') }))).not.toContain('life_attach');
  });

  it('doubles the close probability when there are dependents or a mortgage', () => {
    const plain = findOpportunities(household(), NOW).find((o) => o.kind === 'life_attach');
    const motivated = findOpportunities(
      household({ dependents: 2, hasMortgage: true }),
      NOW,
    ).find((o) => o.kind === 'life_attach');

    expect(motivated!.closeProbability).toBeGreaterThan(plain!.closeProbability);
    expect(motivated!.expectedValueCents).toBeGreaterThan(plain!.expectedValueCents);
  });
});

describe('Medicare T-65 — the highest-value flag in a P&C book', () => {
  it('fires inside the run-up to 65', () => {
    // Turns 65 in about four months.
    const turning = household({ dateOfBirth: new Date('1962-01-15') });
    expect(kinds(turning)).toContain('medicare_t65');
  });

  it('does not fire at 50 or at 70', () => {
    expect(kinds(household({ dateOfBirth: new Date('1976-01-01') }))).not.toContain('medicare_t65');
    expect(kinds(household({ dateOfBirth: new Date('1956-01-01') }))).not.toContain('medicare_t65');
  });

  it('outranks a life attach but NOT a home bundle', () => {
    const turning = household({ dateOfBirth: new Date('1962-01-15') });
    const found = findOpportunities(turning, NOW);

    const value = (kind: string): number =>
      found.find((o) => o.kind === kind)?.expectedValueCents ?? 0;

    // Worth stating plainly, because the intuition runs the other way: a home
    // bundle is ~$3,600 of lifetime value against Medicare's ~$1,600, so the
    // bundle wins. Medicare is the most-MISSED opportunity, not the largest.
    expect(value('medicare_t65')).toBeGreaterThan(value('life_attach'));
    expect(value('medicare_t65')).toBeLessThan(value('home_bundle'));
  });

  it('carries an enrollment window', () => {
    const turning = household({ dateOfBirth: new Date('1962-01-15') });
    const medicare = findOpportunities(turning, NOW).find((o) => o.kind === 'medicare_t65');
    expect(medicare!.windowDays).toBeGreaterThan(0);
  });
});

describe('renewal saves', () => {
  it('fires inside 45 days and not outside', () => {
    const soon = household({
      policies: [policy({ line: 'auto', renewalDate: new Date('2026-10-01') })],
    });
    const later = household({
      policies: [policy({ line: 'auto', renewalDate: new Date('2027-06-01') })],
    });

    expect(kinds(soon)).toContain('renewal_save');
    expect(kinds(later)).not.toContain('renewal_save');
  });

  it('handles a renewal anniversary that has already passed this year', () => {
    // Written in 2021, renewing every Sept 20 — the next one is days away.
    const anniversary = household({
      policies: [policy({ line: 'auto', renewalDate: new Date('2021-09-20') })],
    });
    expect(kinds(anniversary)).toContain('renewal_save');
    expect(nextRenewal(new Date('2021-09-20'), NOW).getFullYear()).toBe(2026);
  });
});

describe('commercial and win-back', () => {
  it('finds commercial hiding in a personal book', () => {
    expect(kinds(household({ businessOwner: true }))).toContain('commercial');
  });

  it('offers a win-back only when nothing is active', () => {
    const lapsed = household({ policies: [policy({ line: 'auto', status: 'lapsed' })] });
    expect(kinds(lapsed)).toContain('reengage_lapsed');

    const stillActive = household({
      policies: [policy({ line: 'auto' }), policy({ line: 'home', status: 'lapsed' })],
    });
    expect(kinds(stillActive)).not.toContain('reengage_lapsed');
  });
});

// ── Ranking ──────────────────────────────────────────────────────────────────

describe('ranking the book', () => {
  it('puts urgency ahead of raw value — a missed renewal is gone for a year', () => {
    const valuable = household({
      id: 'valuable',
      dateOfBirth: new Date('1962-01-15'), // Medicare, high value, no deadline pressure
      policies: [policy({ line: 'auto', annualCommissionCents: 50_000 })],
    });
    const urgent = household({
      id: 'urgent',
      dateOfBirth: new Date('1985-04-02'),
      policies: [
        policy({ line: 'auto', annualCommissionCents: 5_000, renewalDate: new Date('2026-09-20') }),
        policy({ line: 'home', annualCommissionCents: 5_000, renewalDate: new Date('2026-09-20') }),
      ],
    });

    const ranked = rankBook([valuable, urgent], NOW);
    expect(ranked[0]?.household.id).toBe('urgent');
    expect(ranked[0]?.urgent).toBe(true);
  });

  it('drops households with nothing to offer', () => {
    const complete = household({
      dateOfBirth: new Date('1950-01-01'),
      policies: [
        policy({ line: 'auto' }),
        policy({ line: 'home' }),
        policy({ line: 'life_term' }),
      ],
      businessOwner: false,
      hasUmbrella: true,
    });
    expect(rankBook([complete], NOW)).toHaveLength(0);
  });

  it('summarizes the book with a monoline count', () => {
    const summary = summarizeBook(
      [
        household({ id: 'a' }),
        household({ id: 'b' }),
        household({ id: 'c', policies: [policy({ line: 'auto' }), policy({ line: 'home' })] }),
      ],
      NOW,
    );

    expect(summary.households).toBe(3);
    expect(summary.monolineHouseholds).toBe(2);
    expect(summary.totalOpportunityCents).toBeGreaterThan(0);
    expect(summary.opportunitiesByKind['home_bundle']?.count).toBe(2);
  });
});

// ── Compliance interaction ───────────────────────────────────────────────────

describe('established business relationship', () => {
  it('dates the EBR from the most recent renewal, not the original sale', () => {
    const h = household({
      policies: [policy({ line: 'auto', renewalDate: new Date('2021-03-15'), writtenDate: new Date('2019-03-15') })],
    });
    const ebr = ebrEvidence(h, NOW);

    // Anniversary stepping should land on March 2026, not 2021 or 2019.
    expect(ebr.lastTransactionAt?.getFullYear()).toBe(2026);
    expect(ebr.lastTransactionAt?.getMonth()).toBe(2);
  });

  it('still reports an EBR for a lapsed customer, so the 18-month clock is checkable', () => {
    const lapsed = household({
      policies: [policy({ line: 'auto', status: 'lapsed', renewalDate: new Date('2025-06-01') })],
    });
    expect(ebrEvidence(lapsed, NOW).lastTransactionAt).not.toBeNull();
  });
});

describe('line accounting', () => {
  it('counts only active policies as current lines', () => {
    const h = household({
      policies: [policy({ line: 'auto' }), policy({ line: 'home', status: 'cancelled' })],
    });
    expect([...activeLines(h)]).toEqual(['auto']);
  });
});
