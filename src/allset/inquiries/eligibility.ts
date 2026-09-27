/**
 * Whether the business may take this request: the person's state must be
 * one it serves, and for coverage, one where it holds a license for each line
 * they asked about. Checked on the server for every submission; nothing is
 * saved when the answer is no.
 */

import { FACTS, type BusinessFacts } from '@/allset/content/facts';
import { stateName } from '@/allset/content/states';
import type { CoverageInterest, ValidInquiry } from './fields';

type Line = 'life' | 'health';

export type Eligibility = { readonly ok: true } | { readonly ok: false; readonly message: string };

function linesFor(interest: CoverageInterest | null): { readonly all: readonly Line[]; readonly anyOf: boolean } {
  if (interest === 'life') return { all: ['life'], anyOf: false };
  if (interest === 'health') return { all: ['health'], anyOf: false };
  if (interest === 'both') return { all: ['life', 'health'], anyOf: false };
  // "Not sure yet": we can talk if we hold either license there.
  return { all: ['life', 'health'], anyOf: true };
}

export function checkEligibility(inquiry: ValidInquiry, facts: BusinessFacts = FACTS): Eligibility {
  const where = stateName(inquiry.state);
  const served = facts.serviceArea?.value.states.includes(inquiry.state) ?? false;
  if (!served) {
    return {
      ok: false,
      message:
        inquiry.kind === 'coverage'
          ? `We don’t work with families in ${where} yet. For health coverage, HealthCare.gov lists your state’s options, and your state’s insurance department can point you to licensed agents near you.`
          : `We aren’t building a team in ${where} yet, so we can’t take your inquiry there.`,
    };
  }
  if (inquiry.kind === 'team') return { ok: true };

  const licensed = (line: Line) =>
    facts.licenses.some((l) => l.value.state === inquiry.state && l.value.lines.includes(line));
  const { all, anyOf } = linesFor(inquiry.coverageInterest);
  const ok = anyOf ? all.some(licensed) : all.every(licensed);
  if (ok) return { ok: true };
  const missing = all.filter((line) => !licensed(line)).map((line) => (line === 'life' ? 'life insurance' : 'health insurance'));
  return {
    ok: false,
    message: `We aren’t licensed for ${missing.join(' or ')} in ${where}, so we can’t help with that there. Your state’s insurance department can point you to licensed agents${missing.includes('health insurance') ? ', and HealthCare.gov lists health plans' : ''}.`,
  };
}
