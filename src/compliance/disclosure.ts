/**
 * Disclosure strings.
 *
 * These are composed by the runtime and spoken as the first utterance of every
 * call, before the model gets a turn. That placement is deliberate: a system
 * prompt telling a model "always disclose first" is a request, and requests can
 * be talked out of. A string the TTS speaks before the model is even invoked is
 * a guarantee.
 *
 * Three separate obligations stack here and people routinely conflate them:
 *
 *  1. **AI identity.** California B&P 17941 makes it unlawful to use a bot to
 *     incentivize a sale without disclosing it. Utah's AI Policy Act requires a
 *     regulated occupation — insurance producers included — to disclose
 *     proactively. Colorado's AI Act (SB 24-205) reaches consequential decisions
 *     in insurance. More states land every session.
 *  2. **Recording.** Roughly a dozen states require all-party consent. Because a
 *     national dialer cannot reliably know where the other person physically is,
 *     we disclose on every call and treat the two-party states as the floor.
 *  3. **Medicare TPMO.** CMS requires a specific disclaimer, verbatim, within the
 *     first minute — plus the agency name and the number of plans represented.
 *
 * Do not paraphrase the CMS string. It is prescribed text.
 */

import type { LineOfBusiness } from '@/types';
import { MEDICARE_LINES } from '@/types';

/** All-party ("two-party") recording consent states. Conservative superset. */
export const ALL_PARTY_CONSENT_STATES: ReadonlySet<string> = new Set([
  'CA', 'CT', 'DE', 'FL', 'IL', 'MD', 'MA', 'MI', 'MT', 'NV', 'NH', 'OR', 'PA', 'WA',
]);

export interface DisclosureContext {
  readonly agentDisplayName: string;
  readonly agencyLegalName: string;
  readonly line: LineOfBusiness;
  readonly contactStateCode: string | null;
  /** Required on Medicare calls. The agency's National Producer Number. */
  readonly agencyNpn: string | null;
  /**
   * Medicare TPMO disclaimer requires a truthful count. If you represent every
   * carrier in the service area you may say so instead; if you do not, you must
   * read the "we do not offer every plan" language.
   */
  readonly medicarePlanCount: { readonly carriers: number; readonly plans: number } | null;
}

/**
 * The AI identity sentence. Plain, front-loaded, and not hedged — a disclosure
 * the listener has to decode is not a disclosure.
 */
export function aiDisclosure(ctx: DisclosureContext): string {
  return (
    `Hi, this is ${ctx.agentDisplayName}, an AI assistant calling on behalf of ` +
    `${ctx.agencyLegalName}. I'm not a human — I want to be upfront about that. ` +
    `You can ask for a licensed agent at any time and I'll connect you.`
  );
}

/** The recording sentence. Spoken on every call regardless of state. */
export function recordingDisclosure(): string {
  return `This call is recorded for quality and compliance.`;
}

/**
 * CMS-prescribed Third Party Marketing Organization disclaimer. Must be read
 * within the first minute of a Medicare-related call, verbatim, at the same
 * cadence as the rest of the call — no speed-reading.
 */
export function medicareTpmoDisclaimer(ctx: DisclosureContext): string {
  const count = ctx.medicarePlanCount;
  const scope =
    count === null
      ? `We do not offer every plan available in your area.`
      : `We do not offer every plan available in your area. Currently we represent ` +
        `${count.carriers} organization${count.carriers === 1 ? '' : 's'} which offer ` +
        `${count.plans} product${count.plans === 1 ? '' : 's'} in your area.`;

  return (
    `${scope} Please contact Medicare dot gov, or 1-800-MEDICARE, or your local State ` +
    `Health Insurance Program to get information on all of your options.`
  );
}

/**
 * The complete opening the runtime speaks before handing control to the model.
 * Order matters: AI identity first, because everything the listener hears after
 * it is coloured by whether they know they are talking to a machine.
 */
export function buildOpeningDisclosure(ctx: DisclosureContext): string {
  const parts: string[] = [aiDisclosure(ctx), recordingDisclosure()];

  if (MEDICARE_LINES.has(ctx.line)) {
    if (!ctx.agencyNpn) {
      throw new Error(
        'Medicare calls require the agency NPN in the disclosure. Set "npn" in agency.config.json.',
      );
    }
    parts.push(medicareTpmoDisclaimer(ctx));
  }

  return parts.join(' ');
}

/**
 * Whether the contact's state requires all-party recording consent. Used to
 * decide whether an explicit verbal acknowledgement must be captured before the
 * substantive conversation begins, or whether announcement alone suffices.
 */
export function requiresRecordingAcknowledgement(stateCode: string | null): boolean {
  // Fail conservative: unknown state is treated as all-party.
  if (!stateCode) return true;
  return ALL_PARTY_CONSENT_STATES.has(stateCode.toUpperCase());
}

/**
 * Normalize an utterance for phrase matching.
 *
 * Apostrophes are *elided*, not replaced with whitespace. This matters more than
 * it looks: replacing them turns "don't call" into "don t call", which silently
 * fails to match any contraction in the trigger list. A do-not-call detector
 * that misses "please don't call me again" is not a cosmetic bug — it is the
 * exact utterance that becomes an exhibit. Phrase constants are run through this
 * same function so the two representations cannot drift apart.
 */
function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/['‘’ʼ]/g, '') // elide straight and curly apostrophes
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Phrases that constitute a do-not-call request. When any of these is detected
 * in a prospect utterance the runtime must immediately: honour it, write an
 * internal DNC entry, confirm verbally, and end the call. Federal rules give you
 * a maximum of 10 business days to process the request; we do it in-turn.
 *
 * Written with contractions intact for readability; matched post-normalization.
 * When in doubt, add the phrase. A false positive costs one lead. A false
 * negative costs $500 to $1,500 per subsequent call.
 */
export const DNC_TRIGGER_PHRASES: readonly string[] = [
  'do not call',
  "don't call",
  "dont call",
  'stop calling',
  'take me off',
  'remove me from your list',
  'remove my number',
  'quit calling',
  'never call',
  'lose my number',
  'put me on your do not call',
  'not interested stop',
  'unsubscribe',
];

const NORMALIZED_DNC_PHRASES: readonly string[] = DNC_TRIGGER_PHRASES.map(normalizeForMatch);

export function detectDncRequest(utterance: string): boolean {
  const normalized = normalizeForMatch(utterance);
  return NORMALIZED_DNC_PHRASES.some((phrase) => normalized.includes(phrase));
}

/**
 * Phrases requesting a human. Under our own policy these are honoured
 * immediately and unconditionally — the AI disclosure promises it, so the
 * runtime has to deliver it or the disclosure was a lie.
 */
export const HUMAN_REQUEST_PHRASES: readonly string[] = [
  'real person',
  'a human',
  'speak to a person',
  'talk to a person',
  'talk to someone',
  'licensed agent',
  'real agent',
  'is this a robot',
  'are you a robot',
  'are you a real',
  // "Am I talking to a robot?" is the most common phrasing of the question and
  // was missed by the "are you a…" forms alone. Cover the object, not the subject.
  'talking to a robot',
  'talking to a machine',
  'talking to a computer',
  'talking to an ai',
  'talking to a bot',
  'this a recording',
  'get me a person',
  'transfer me',
];

const NORMALIZED_HUMAN_PHRASES: readonly string[] =
  HUMAN_REQUEST_PHRASES.map(normalizeForMatch);

export function detectHumanRequest(utterance: string): boolean {
  const normalized = normalizeForMatch(utterance);
  return NORMALIZED_HUMAN_PHRASES.some((phrase) => normalized.includes(phrase));
}
