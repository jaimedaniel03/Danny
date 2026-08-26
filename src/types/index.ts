/**
 * Core domain types for Danny.
 *
 * Design note: every type that crosses the compliance boundary is nominal-ish —
 * you cannot construct a `DialAuthorization` yourself, only receive one from
 * `evaluateGate()`. That makes "dial without checking" a type error rather than
 * a code-review comment.
 */

// ─────────────────────────────────────────────────────────────
// Lines of business
// ─────────────────────────────────────────────────────────────

/**
 * The five lines Danny sells. These are not interchangeable — each has a
 * different regulator, a different consent standard, and a different economic
 * profile. `health_medicare` is split out from `health_uh65` deliberately:
 * Medicare carries CMS marketing rules that no other line does.
 */
export type LineOfBusiness =
  | 'auto'
  | 'home'
  | 'commercial' // BOP, GL, workers comp, commercial auto
  | 'health_uh65' // ACA / under-65 individual & family
  | 'health_medicare' // MA, MAPD, PDP, Med Supp — CMS rules apply
  | 'life_term'
  | 'life_permanent' // whole, IUL, GUL
  | 'life_final_expense';

export const MEDICARE_LINES: ReadonlySet<LineOfBusiness> = new Set([
  'health_medicare',
]);

/** Lines that require an active health producer license (vs P&C vs life). */
export type LicenseClass = 'p_and_c' | 'life' | 'health' | 'life_and_health';

export const LINE_LICENSE: Record<LineOfBusiness, LicenseClass> = {
  auto: 'p_and_c',
  home: 'p_and_c',
  commercial: 'p_and_c',
  health_uh65: 'health',
  health_medicare: 'health',
  life_term: 'life',
  life_permanent: 'life',
  life_final_expense: 'life',
};

// ─────────────────────────────────────────────────────────────
// Consent
// ─────────────────────────────────────────────────────────────

/**
 * How we came to be allowed to call this number.
 *
 * `prior_express_written` is the only basis that permits an artificial or
 * prerecorded voice to a wireless number under TCPA 47 U.S.C. 227(b)(1)(A)(iii).
 * An AI voice agent IS an artificial voice — the FCC said so explicitly in its
 * February 2024 Declaratory Ruling. Everything else on this list is enough for a
 * *human* to dial and not enough for Danny.
 */
export type ConsentBasis =
  | 'prior_express_written' // signed/e-signed disclosure naming us. The only AI-safe basis.
  | 'prior_express' // gave us the number for this purpose, unsigned. Human-only.
  | 'established_business_relationship' // current policyholder. DNC-exempt, NOT artificial-voice-exempt.
  | 'inbound_call' // they called us. Best basis there is.
  | 'inbound_web_request' // quote form, no signature captured
  | 'none';

/** Consent bases under which Danny (an artificial voice) may initiate a call. */
export const AI_DIALABLE_BASES: ReadonlySet<ConsentBasis> = new Set([
  'prior_express_written',
  'inbound_call',
]);

export interface ConsentRecord {
  readonly id: string;
  readonly contactId: string;
  readonly phoneE164: string;
  readonly basis: ConsentBasis;
  /** Verbatim text the consumer saw and agreed to. Retained forever. */
  readonly disclosureText: string | null;
  /** Where it happened: form URL, call SID, or paper scan reference. */
  readonly sourceUri: string | null;
  readonly capturedAt: Date;
  /** Some sources (purchased leads) age out of usefulness before they age out of law. */
  readonly expiresAt: Date | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  /** Lines this consent covers. Empty = all lines. */
  readonly scopedLines: readonly LineOfBusiness[];
  readonly revokedAt: Date | null;
}

// ─────────────────────────────────────────────────────────────
// Contacts
// ─────────────────────────────────────────────────────────────

export type PhoneLineType = 'mobile' | 'landline' | 'voip' | 'unknown';

export interface Contact {
  readonly id: string;
  readonly phoneE164: string;
  readonly lineType: PhoneLineType;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly email: string | null;
  /** USPS two-letter code. Drives licensing, calling hours, and recording law. */
  readonly stateCode: string | null;
  readonly postalCode: string | null;
  /** IANA zone, resolved from address when known, from the DID as a fallback. */
  readonly timezone: string | null;
  readonly dateOfBirth: Date | null;
  readonly isExistingPolicyholder: boolean;
  readonly internalDncAt: Date | null;
}

// ─────────────────────────────────────────────────────────────
// The gate
// ─────────────────────────────────────────────────────────────

export type GateFailureCode =
  | 'NO_CONSENT_RECORD'
  | 'CONSENT_BASIS_INSUFFICIENT_FOR_AI'
  | 'CONSENT_EXPIRED'
  | 'CONSENT_REVOKED'
  | 'CONSENT_SCOPE_MISMATCH'
  | 'INTERNAL_DNC'
  | 'FEDERAL_DNC'
  | 'STATE_DNC'
  | 'LITIGATOR_LIST'
  | 'OUTSIDE_CALLING_HOURS'
  | 'UNKNOWN_TIMEZONE'
  | 'STATE_NOT_LICENSED'
  | 'LICENSE_CLASS_MISSING'
  | 'MEDICARE_PTC_MISSING'
  | 'MEDICARE_LOCKOUT_WINDOW'
  | 'ATTEMPT_CAP_EXCEEDED'
  | 'REASSIGNED_NUMBER'
  | 'INVALID_PHONE'
  | 'KILL_SWITCH_ENGAGED';

export interface GateFailure {
  readonly code: GateFailureCode;
  readonly detail: string;
  /** True when a human licensed producer could legally make this call even though Danny cannot. */
  readonly humanMayDial: boolean;
}

/**
 * The only object the dialer accepts. Produced exclusively by `evaluateGate()`.
 * The private brand prevents construction anywhere else in the codebase.
 */
export interface DialAuthorization {
  readonly __brand: unique symbol;
  readonly contactId: string;
  readonly phoneE164: string;
  readonly line: LineOfBusiness;
  readonly consentId: string;
  readonly consentBasis: ConsentBasis;
  /** Frozen copy of everything the gate saw, written to the audit log before the dial. */
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly issuedAt: Date;
  /** Authorizations are short-lived. A stale one is a re-evaluation, not a retry. */
  readonly expiresAt: Date;
  /** Verbatim disclosure the runtime will speak as turn one. Not model-generated. */
  readonly requiredDisclosure: string;
}

export type GateResult =
  | { readonly ok: true; readonly authorization: DialAuthorization }
  | { readonly ok: false; readonly failures: readonly GateFailure[] };

// ─────────────────────────────────────────────────────────────
// Calls
// ─────────────────────────────────────────────────────────────

export type CallDirection = 'outbound' | 'inbound';

export type CallDisposition =
  | 'quoted'
  | 'appointment_set'
  | 'transferred_to_human'
  | 'callback_requested'
  | 'not_interested'
  | 'do_not_call_requested'
  | 'wrong_number'
  | 'voicemail'
  | 'no_answer'
  | 'busy'
  | 'failed'
  | 'abandoned_by_agent'
  | 'human_takeover';

export interface CallRecord {
  readonly id: string;
  readonly providerSid: string;
  readonly contactId: string;
  readonly direction: CallDirection;
  readonly line: LineOfBusiness;
  readonly authorizationId: string | null;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
  readonly durationSeconds: number | null;
  readonly disposition: CallDisposition | null;
  readonly recordingUri: string | null;
  readonly transcriptId: string | null;
  /** Set when the recording disclosure was actually spoken and acknowledged. */
  readonly recordingDisclosedAt: Date | null;
  readonly aiDisclosedAt: Date | null;
  readonly costCents: number | null;
}

// ─────────────────────────────────────────────────────────────
// Transcript & tonality
// ─────────────────────────────────────────────────────────────

export type Speaker = 'REP' | 'PROSPECT';

export type PitchDirection = 'rising' | 'falling' | 'flat';

/**
 * Tonality annotation attached to a single utterance. This is the payload the
 * coaching loop runs on — see `prompts/01-tonality-transcript.md`.
 */
export interface TonalityTag {
  readonly terminalPitch: PitchDirection;
  /** Words per minute relative to this speaker's own baseline for the call. */
  readonly paceVsOwnBaseline: number;
  /** Loudness relative to the other speaker's running mean, in dB. */
  readonly energyVsCounterpart: number;
  /** Hedges quoted exactly as spoken: "kind of", "I guess", "just wanted to". */
  readonly hedgeWords: readonly string[];
  /** Silences over 1000ms that preceded this utterance. */
  readonly precedingPauseMs: number | null;
  /** Mid-sentence tonal shifts and what changed. */
  readonly midSentenceShifts: readonly string[];
}

export interface Utterance {
  readonly index: number;
  readonly speaker: Speaker;
  readonly startMs: number;
  readonly endMs: number;
  /** Verbatim. Never cleaned, never grammar-fixed. Filler words preserved. */
  readonly text: string;
  readonly tonality: TonalityTag | null;
}

export interface Transcript {
  readonly id: string;
  readonly callId: string;
  readonly utterances: readonly Utterance[];
  readonly repAverageEnergy: number;
  readonly prospectAverageEnergy: number;
  /** repAverageEnergy - prospectAverageEnergy. The number the coach loop optimizes. */
  readonly energyGap: number;
  /** Timestamp where the prospect's tone first turned. Null if it never did. */
  readonly prospectTurnMs: number | null;
}

// ─────────────────────────────────────────────────────────────
// Quoting
// ─────────────────────────────────────────────────────────────

export interface QuoteRequest {
  readonly line: LineOfBusiness;
  readonly contactId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface QuoteResult {
  readonly carrier: string;
  readonly annualPremiumCents: number;
  readonly estimatedCommissionCents: number;
  readonly bindable: boolean;
  readonly expiresAt: Date;
  readonly rawResponse: Readonly<Record<string, unknown>>;
}
