/**
 * Outreach channels.
 *
 * ── The thing that reorganizes this whole module ─────────────────────────────
 * Text, email, and call are NOT three ways of doing the same thing. They sit
 * under three different statutes with three different consent bars, and the gap
 * between them is enormous:
 *
 *   AI VOICE   TCPA §227(b). Artificial voice to a wireless number needs
 *              PRIOR EXPRESS WRITTEN CONSENT. $500–$1,500/call, uncapped.
 *
 *   SMS        Also TCPA §227(b) — a text IS a "call". But the bar splits:
 *              • marketing/promotional  → prior express WRITTEN consent
 *                (same bar as AI voice — people are constantly surprised by this)
 *              • transactional/informational → prior express consent, unwritten
 *                (a reply to their question, an appointment confirmation)
 *              Plus carrier rules: 10DLC registration, mandatory STOP/HELP.
 *
 *   EMAIL      CAN-SPAM. **No prior consent required at all.** What it requires
 *              instead is truthful headers, a non-deceptive subject, a physical
 *              postal address, a working opt-out, and honouring that opt-out
 *              within 10 business days.
 *
 * The practical consequence, and it is the most useful fact in this file: a lead
 * you may not AI-call and may not text can almost always be **emailed today**.
 * Which makes email the cheapest legal path to collecting the written consent
 * that unlocks the other two.
 *
 * So the consent-link play is: email the link, do not text it. Same message,
 * same conversion, a fraction of the exposure.
 */

import type { ConsentBasis, GateFailure, LineOfBusiness } from '@/types';

export type Channel = 'ai_voice' | 'human_voice' | 'sms' | 'email';

/**
 * Message intent. Only meaningful for SMS, where it moves the consent bar, and
 * for email, where it decides whether CAN-SPAM's commercial-message rules
 * (postal address, opt-out) attach.
 */
export type MessageIntent =
  /** Promoting a product. The high bar. */
  | 'marketing'
  /** Answering something they asked, confirming something they booked. */
  | 'transactional'
  /** Servicing an existing policy: renewal notice, claim update, ID card. */
  | 'servicing';

export interface ChannelRequest {
  readonly channel: Channel;
  readonly intent: MessageIntent;
  readonly line: LineOfBusiness;
}

// ─────────────────────────────────────────────────────────────
// Consent bars, per channel × intent
// ─────────────────────────────────────────────────────────────

/**
 * Consent bases sufficient for each channel/intent pair.
 *
 * An empty set means "no consent basis required" — which is true for exactly
 * one cell in this table (email), and is a statement about CAN-SPAM, not an
 * invitation to email anyone you like. Email still respects suppression,
 * still needs the postal address and opt-out, and still gets you a spam
 * complaint rate that ruins your sending domain if you abuse it.
 */
export const CHANNEL_CONSENT_BARS: Readonly<
  Record<Channel, Readonly<Record<MessageIntent, ReadonlySet<ConsentBasis>>>>
> = {
  // Artificial voice. One bar, the highest, regardless of intent — the FCC's
  // Feb 2024 ruling does not care why you are calling.
  ai_voice: {
    marketing: new Set<ConsentBasis>(['prior_express_written', 'inbound_call']),
    transactional: new Set<ConsentBasis>(['prior_express_written', 'inbound_call']),
    servicing: new Set<ConsentBasis>(['prior_express_written', 'inbound_call']),
  },

  // A licensed human dialling MANUALLY. TCPA §227(b) restricts automated
  // dialers and artificial voices — not a person pressing the buttons. So a
  // manual call needs no consent record at all; what it needs is a clean DNC
  // scrub, lawful calling hours, and a producer licensed in that state.
  //
  // These bases are still listed because a consent record, where one exists,
  // gets attached to the authorization as evidence. Their absence is not a
  // failure — see CONSENT_OPTIONAL_CHANNELS below. This is the rule that makes
  // the human queue worth anything: it is where every lead the AI cannot touch
  // still gets worked.
  human_voice: {
    marketing: new Set<ConsentBasis>([
      'prior_express_written',
      'prior_express',
      'inbound_call',
      'inbound_web_request',
      'established_business_relationship',
    ]),
    transactional: new Set<ConsentBasis>([
      'prior_express_written',
      'prior_express',
      'inbound_call',
      'inbound_web_request',
      'established_business_relationship',
    ]),
    servicing: new Set<ConsentBasis>([
      'prior_express_written',
      'prior_express',
      'inbound_call',
      'inbound_web_request',
      'established_business_relationship',
    ]),
  },

  // SMS. The split people get wrong: promotional texts need the same written
  // consent as an AI call. "We have their number" is not consent.
  sms: {
    marketing: new Set<ConsentBasis>(['prior_express_written', 'inbound_call']),
    transactional: new Set<ConsentBasis>([
      'prior_express_written',
      'prior_express',
      'inbound_call',
      'inbound_web_request',
    ]),
    servicing: new Set<ConsentBasis>([
      'prior_express_written',
      'prior_express',
      'inbound_call',
      'inbound_web_request',
      'established_business_relationship',
    ]),
  },

  // Email under CAN-SPAM: consent is not the gating question. Suppression is.
  email: {
    marketing: new Set<ConsentBasis>([]),
    transactional: new Set<ConsentBasis>([]),
    servicing: new Set<ConsentBasis>([]),
  },
};

/**
 * Channels that may proceed with NO consent record on file.
 *
 *  - `email`      — CAN-SPAM requires no prior consent. Suppression governs.
 *  - `human_voice`— TCPA 227(b) governs automated dialers and artificial
 *                   voices. A person dialling by hand is neither. DNC scrubbing,
 *                   calling hours, and licensing still apply in full.
 *
 * A consent record is still attached to the authorization when one exists —
 * absence simply is not disqualifying.
 */
export const CONSENT_OPTIONAL_CHANNELS: ReadonlySet<Channel> = new Set([
  'email',
  'human_voice',
]);

// ─────────────────────────────────────────────────────────────
// Suppression
// ─────────────────────────────────────────────────────────────

/**
 * Opting out of one channel does not opt you out of the others — legally.
 * A texted STOP suppresses SMS; it is not an email unsubscribe.
 *
 * We deliberately go further than the law in one direction: a **verbal
 * do-not-call** on a phone call suppresses BOTH voice and SMS, because both
 * ride the same number and the person plainly meant "stop contacting me on my
 * phone." Reading that request narrowly is the kind of clever that ends up in
 * a complaint.
 */
export const SUPPRESSION_SCOPE: Readonly<Record<Channel, readonly Channel[]>> = {
  ai_voice: ['ai_voice', 'human_voice', 'sms'],
  human_voice: ['ai_voice', 'human_voice', 'sms'],
  sms: ['sms'],
  email: ['email'],
};

export interface ChannelSuppression {
  readonly channel: Channel;
  readonly suppressedAt: Date;
  readonly reason: string;
  /** 'STOP', an unsubscribe click, a verbal request, a spam complaint. */
  readonly source: 'sms_stop' | 'email_unsubscribe' | 'verbal' | 'complaint' | 'manual';
}

// ─────────────────────────────────────────────────────────────
// Authorization
// ─────────────────────────────────────────────────────────────

/**
 * Branded like `DialAuthorization` and for the same reason: every send function
 * takes one of these, and only the channel gate can mint one. Sending without
 * checking is a compile error.
 */
export interface ChannelAuthorization {
  readonly __channelBrand: unique symbol;
  readonly channel: Channel;
  readonly intent: MessageIntent;
  readonly contactId: string;
  /** E.164 for voice/SMS, address for email. */
  readonly destination: string;
  readonly line: LineOfBusiness;
  readonly consentId: string | null;
  readonly consentBasis: ConsentBasis | null;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  /**
   * Text the channel MUST include — opt-out language for SMS, the CAN-SPAM
   * footer for email, the AI disclosure for voice. Composed by the runtime,
   * appended by the sender, never model-generated.
   */
  readonly requiredFooter: string;
}

export type ChannelGateResult =
  | { readonly ok: true; readonly authorization: ChannelAuthorization }
  | { readonly ok: false; readonly failures: readonly GateFailure[] };

// ─────────────────────────────────────────────────────────────
// Reachability
// ─────────────────────────────────────────────────────────────

/**
 * What a single contact can actually be reached by, right now.
 *
 * This is the object the orchestrator and the triage report both want: not
 * "is this lead good" but "which door is open." On a typical purchased list the
 * answer is `email: true, sms: false, ai_voice: false, human_voice: true` — and
 * knowing that per-lead is what turns a dead list into a working one.
 */
export interface Reachability {
  readonly contactId: string;
  readonly channels: Readonly<Record<Channel, { readonly allowed: boolean; readonly reason: string }>>;
  /** Cheapest open channel that can plausibly obtain written consent. */
  readonly bestConsentPath: Channel | null;
}
