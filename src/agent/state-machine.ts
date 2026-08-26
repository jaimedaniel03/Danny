/**
 * Conversation state machine.
 *
 * ── Why a state machine and not "just prompt the model" ──────────────────────
 * A free-running LLM on a phone call is a liability surface. It will, given
 * enough turns, quote a premium it cannot honour, agree to bind coverage, claim
 * to be a licensed human, or keep talking to someone who asked it to stop. None
 * of those are model-quality problems you fix with a better prompt — they are
 * control-flow problems, and control flow belongs in code.
 *
 * So: the model chooses *what to say* inside a state. The machine chooses *which
 * state we are in*, and some transitions are not the model's to make. The three
 * interrupts below fire on the raw transcript before the model is invoked at
 * all, and they cannot be overridden by anything the model or the prospect says.
 */

import { detectDncRequest, detectHumanRequest } from '@/compliance/disclosure';
import type { CallDisposition, LineOfBusiness } from '@/types';

export type ConversationState =
  /** Runtime speaks the mandated disclosure. Model has no turn here. */
  | 'DISCLOSING'
  /** Confirm we have the right person before saying anything substantive. */
  | 'VERIFYING_IDENTITY'
  /** The reason for the call, in one sentence, with a permission ask. */
  | 'STATING_PURPOSE'
  /** Structured intake. The only state that collects underwriting data. */
  | 'DISCOVERY'
  /** Reading back a quote. Guardrailed — see `QUOTE_GUARDRAILS`. */
  | 'PRESENTING_QUOTE'
  /** Named objection handling. Bounded attempts. */
  | 'HANDLING_OBJECTION'
  /** Booking a human appointment or a live transfer. The actual goal. */
  | 'CLOSING'
  /** Warm transfer in progress. */
  | 'TRANSFERRING'
  /** Honouring a DNC request. Terminal, and reached from anywhere. */
  | 'HONORING_DNC'
  /** Wrapping up. Terminal. */
  | 'CLOSING_OUT'
  | 'ENDED';

export const TERMINAL_STATES: ReadonlySet<ConversationState> = new Set([
  'HONORING_DNC',
  'ENDED',
]);

// ─────────────────────────────────────────────────────────────
// Interrupts — evaluated before the model, override everything
// ─────────────────────────────────────────────────────────────

export type Interrupt =
  | { readonly kind: 'DNC_REQUESTED'; readonly utterance: string }
  | { readonly kind: 'HUMAN_REQUESTED'; readonly utterance: string }
  | { readonly kind: 'WRONG_PARTY'; readonly utterance: string }
  | { readonly kind: 'MAX_DURATION'; readonly seconds: number }
  | { readonly kind: 'SILENCE_TIMEOUT'; readonly seconds: number };

/** Calls longer than this are not going well. End gracefully. */
export const MAX_CALL_SECONDS = 600;
/** Consecutive silence after which we assume the line is dead. */
export const SILENCE_TIMEOUT_SECONDS = 12;

const WRONG_PARTY_PHRASES = [
  'wrong number',
  'no one here by that name',
  'nobody by that name',
  'you have the wrong',
  'they dont live here',
  'she passed away',
  'he passed away',
  'they passed away',
];

/**
 * Detect an interrupt in a prospect utterance. Runs on every turn, before the
 * model sees anything. Order is priority order.
 */
export function detectInterrupt(input: {
  readonly utterance: string;
  readonly elapsedSeconds: number;
  readonly silentSeconds: number;
}): Interrupt | null {
  const { utterance, elapsedSeconds, silentSeconds } = input;

  if (detectDncRequest(utterance)) {
    return { kind: 'DNC_REQUESTED', utterance };
  }
  if (detectHumanRequest(utterance)) {
    return { kind: 'HUMAN_REQUESTED', utterance };
  }

  const normalized = utterance.toLowerCase().replace(/['‘’]/g, '').replace(/[^a-z\s]/g, ' ');
  if (WRONG_PARTY_PHRASES.some((p) => normalized.includes(p))) {
    return { kind: 'WRONG_PARTY', utterance };
  }

  if (elapsedSeconds >= MAX_CALL_SECONDS) {
    return { kind: 'MAX_DURATION', seconds: elapsedSeconds };
  }
  if (silentSeconds >= SILENCE_TIMEOUT_SECONDS) {
    return { kind: 'SILENCE_TIMEOUT', seconds: silentSeconds };
  }

  return null;
}

/**
 * Where an interrupt sends us. Note that DNC and human requests are *immediate*
 * and unconditional. There is no "let me just finish this thought" — the whole
 * credibility of the AI disclosure rests on the promise being kept instantly.
 */
export function interruptTransition(interrupt: Interrupt): ConversationState {
  switch (interrupt.kind) {
    case 'DNC_REQUESTED':
      return 'HONORING_DNC';
    case 'HUMAN_REQUESTED':
      return 'TRANSFERRING';
    case 'WRONG_PARTY':
    case 'MAX_DURATION':
    case 'SILENCE_TIMEOUT':
      return 'CLOSING_OUT';
  }
}

// ─────────────────────────────────────────────────────────────
// Normal transitions
// ─────────────────────────────────────────────────────────────

export type Signal =
  | 'DISCLOSURE_SPOKEN'
  | 'IDENTITY_CONFIRMED'
  | 'IDENTITY_DENIED'
  | 'PERMISSION_GRANTED'
  | 'PERMISSION_DECLINED'
  | 'DISCOVERY_COMPLETE'
  | 'QUOTE_READY'
  | 'QUOTE_UNAVAILABLE'
  | 'OBJECTION_RAISED'
  | 'OBJECTION_RESOLVED'
  | 'OBJECTION_UNRESOLVED'
  | 'INTEREST_CONFIRMED'
  | 'APPOINTMENT_BOOKED'
  | 'CALLBACK_REQUESTED'
  | 'TRANSFER_ACCEPTED'
  | 'TRANSFER_FAILED'
  | 'HANGUP';

const TRANSITIONS: Readonly<Record<ConversationState, Partial<Record<Signal, ConversationState>>>> = {
  DISCLOSING: {
    DISCLOSURE_SPOKEN: 'VERIFYING_IDENTITY',
    HANGUP: 'ENDED',
  },
  VERIFYING_IDENTITY: {
    IDENTITY_CONFIRMED: 'STATING_PURPOSE',
    IDENTITY_DENIED: 'CLOSING_OUT',
    HANGUP: 'ENDED',
  },
  STATING_PURPOSE: {
    PERMISSION_GRANTED: 'DISCOVERY',
    PERMISSION_DECLINED: 'HANDLING_OBJECTION',
    OBJECTION_RAISED: 'HANDLING_OBJECTION',
    HANGUP: 'ENDED',
  },
  DISCOVERY: {
    DISCOVERY_COMPLETE: 'PRESENTING_QUOTE',
    OBJECTION_RAISED: 'HANDLING_OBJECTION',
    CALLBACK_REQUESTED: 'CLOSING_OUT',
    HANGUP: 'ENDED',
  },
  PRESENTING_QUOTE: {
    QUOTE_READY: 'CLOSING',
    // No quote is not a dead end — it is a reason to get a human involved.
    QUOTE_UNAVAILABLE: 'CLOSING',
    OBJECTION_RAISED: 'HANDLING_OBJECTION',
    INTEREST_CONFIRMED: 'CLOSING',
    HANGUP: 'ENDED',
  },
  HANDLING_OBJECTION: {
    OBJECTION_RESOLVED: 'DISCOVERY',
    OBJECTION_UNRESOLVED: 'CLOSING_OUT',
    INTEREST_CONFIRMED: 'CLOSING',
    CALLBACK_REQUESTED: 'CLOSING_OUT',
    HANGUP: 'ENDED',
  },
  CLOSING: {
    APPOINTMENT_BOOKED: 'CLOSING_OUT',
    TRANSFER_ACCEPTED: 'TRANSFERRING',
    CALLBACK_REQUESTED: 'CLOSING_OUT',
    OBJECTION_RAISED: 'HANDLING_OBJECTION',
    HANGUP: 'ENDED',
  },
  TRANSFERRING: {
    TRANSFER_ACCEPTED: 'ENDED',
    TRANSFER_FAILED: 'CLOSING_OUT',
    HANGUP: 'ENDED',
  },
  HONORING_DNC: { HANGUP: 'ENDED' },
  CLOSING_OUT: { HANGUP: 'ENDED' },
  ENDED: {},
};

export class InvalidTransitionError extends Error {
  constructor(from: ConversationState, signal: Signal) {
    super(`No transition from ${from} on ${signal}`);
    this.name = 'InvalidTransitionError';
  }
}

export function transition(from: ConversationState, signal: Signal): ConversationState {
  const next = TRANSITIONS[from][signal];
  if (!next) throw new InvalidTransitionError(from, signal);
  return next;
}

// ─────────────────────────────────────────────────────────────
// Guardrails
// ─────────────────────────────────────────────────────────────

/**
 * Things the agent may never say, checked against generated text before it is
 * synthesized. A regex filter is crude, and it is crude in the right direction:
 * these are statements that create either a binding obligation or a
 * misrepresentation, and there is no phrasing of them that is acceptable.
 */
export const PROHIBITED_PATTERNS: readonly { pattern: RegExp; why: string }[] = [
  {
    pattern: /\b(you'?re|you are|this is) (now )?(covered|insured|bound)\b/i,
    why: 'Only a licensed producer with binding authority may bind coverage.',
  },
  {
    pattern: /\bi(?:'| a)?m (?:a )?(?:licensed|human|real person|not an ai)\b/i,
    why: 'Contradicts the mandated AI disclosure. This is the fact pattern regulators fine.',
  },
  {
    pattern: /\bguarantee[ds]?\b.{0,30}\b(rate|premium|price|savings|approv)/i,
    why: 'Rate guarantees are a misrepresentation; final premium is underwriting-dependent.',
  },
  {
    pattern: /\b(will|definitely|certainly) save you\b/i,
    why: 'Unqualified savings claims are actionable under state UDAP statutes.',
  },
  {
    pattern: /\b(medicare|social security|cms|the government) (sent|asked|authorized) (me|us)\b/i,
    why: 'Implying government affiliation is a CMS marketing violation and likely fraud.',
  },
  {
    pattern: /\byour (policy|coverage) (is|will be) (cancel|terminat|expir)/i,
    why: 'Manufacturing urgency about a consumer\'s existing coverage is a deceptive practice.',
  },
];

export interface GuardrailViolation {
  readonly matched: string;
  readonly why: string;
}

export function checkGuardrails(candidate: string): readonly GuardrailViolation[] {
  const violations: GuardrailViolation[] = [];
  for (const { pattern, why } of PROHIBITED_PATTERNS) {
    const m = candidate.match(pattern);
    if (m) violations.push({ matched: m[0], why });
  }
  return violations;
}

/**
 * Quote presentation rules. Applied in PRESENTING_QUOTE.
 *
 * The agent reads a number that came from a carrier API. It never estimates,
 * never rounds in the customer's favour, and always attaches the conditionality
 * — because a quote read without its conditions is heard as a promise.
 */
export const QUOTE_GUARDRAILS = {
  requireCarrierSourced: true,
  requireConditionalLanguage: true,
  conditionalSuffix:
    'That\'s based on what you\'ve told me and it\'s subject to underwriting — ' +
    'a licensed agent will confirm the final number with you.',
  maxQuotesPerCall: 3,
} as const;

// ─────────────────────────────────────────────────────────────
// Disposition
// ─────────────────────────────────────────────────────────────

export function dispositionFor(
  finalState: ConversationState,
  history: readonly Signal[],
): CallDisposition {
  if (finalState === 'HONORING_DNC') return 'do_not_call_requested';
  if (history.includes('APPOINTMENT_BOOKED')) return 'appointment_set';
  if (history.includes('TRANSFER_ACCEPTED')) return 'transferred_to_human';
  if (history.includes('QUOTE_READY')) return 'quoted';
  if (history.includes('CALLBACK_REQUESTED')) return 'callback_requested';
  if (history.includes('IDENTITY_DENIED')) return 'wrong_number';
  if (history.includes('OBJECTION_UNRESOLVED') || history.includes('PERMISSION_DECLINED')) {
    return 'not_interested';
  }
  return 'abandoned_by_agent';
}

/** Discovery fields per line. The machine will not leave DISCOVERY without these. */
export const REQUIRED_DISCOVERY: Readonly<Record<LineOfBusiness, readonly string[]>> = {
  auto: ['vehicle_year_make_model', 'drivers', 'current_carrier', 'current_premium', 'garaging_zip', 'incidents_5yr'],
  home: ['property_address', 'year_built', 'square_feet', 'roof_age', 'current_carrier', 'dwelling_coverage'],
  commercial: ['entity_name', 'industry_naics', 'annual_revenue', 'employee_count', 'current_carriers', 'claims_3yr'],
  health_uh65: ['household_size', 'household_income', 'current_coverage', 'preferred_providers', 'prescriptions'],
  health_medicare: ['medicare_parts_enrolled', 'effective_dates', 'prescriptions', 'preferred_providers', 'county'],
  life_term: ['dob', 'tobacco_use', 'height_weight', 'coverage_target', 'term_length', 'health_conditions'],
  life_permanent: ['dob', 'tobacco_use', 'coverage_target', 'funding_capacity', 'existing_policies'],
  life_final_expense: ['dob', 'tobacco_use', 'coverage_target', 'health_conditions', 'beneficiary'],
};
