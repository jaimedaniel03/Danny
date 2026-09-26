/**
 * The exact consent words shown beside each form's checkbox.
 *
 * The version id is derived from the text itself, so any edit — even a comma
 * — produces a new version, and every stored inquiry points at the words the
 * person actually saw. `where consent_version = '…'` finds every affected
 * record if a wording is ever found defective.
 *
 * The consent covers contact by a person. It deliberately does not cover
 * automated, prerecorded or artificial-voice calls: website leads never enter
 * the AI dialing pipeline that lives elsewhere in this repository.
 */

import { createHash } from 'node:crypto';
import { FACTS, sellerName } from '@/allset/content/facts';

export type InquiryKind = 'coverage' | 'team';

function versionOf(kind: InquiryKind, text: string): string {
  return `${kind}-v1-${createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 10)}`;
}

function coverageText(): string {
  return (
    `I agree that ${sellerName()} may contact me about this request only by the method I chose ` +
    'above, at the email address or phone number I entered. A person will reach out. This is not ' +
    'consent to automated or prerecorded calls. Message and data rates may apply to texts. I can ' +
    'reply STOP to any text, or ask at any time to stop being contacted. Agreeing is not a ' +
    'condition of buying anything.'
  );
}

function teamText(): string {
  return (
    `I agree that ${sellerName()} may contact me about joining the team only by the method I chose ` +
    'above, at the email address or phone number I entered. A person will reach out. This is not ' +
    'consent to automated or prerecorded calls. Message and data rates may apply to texts. I can ' +
    'reply STOP to any text, or ask at any time to stop being contacted. I understand this is an ' +
    'inquiry, not a job application or an offer of work.'
  );
}

export interface ConsentWording {
  readonly text: string;
  readonly version: string;
}

export function consentWording(kind: InquiryKind): ConsentWording {
  const text = kind === 'coverage' ? coverageText() : teamText();
  return { text, version: versionOf(kind, text) };
}

/**
 * Team inquiries also acknowledge the role information shown above the form.
 * Short sentences on purpose: this is the part a recruit most needs to read.
 * Versioned like the consent, and stored with every team inquiry.
 */
export interface Acknowledgment {
  readonly lead: string;
  readonly points: readonly string[];
  readonly version: string;
  /** Whether the page showed this team's verified terms or general information. */
  readonly termsShown: 'team-specific' | 'general';
}

function acknowledgment(): Acknowledgment {
  const termsShown = FACTS.teamRole ? 'team-specific' : 'general';
  const lead =
    termsShown === 'team-specific'
      ? 'I have read the role terms on this page. I understand that:'
      : 'I have read the information about this work on this page. I understand that:';
  const points = [
    'no income is guaranteed;',
    'I may have to pay for licensing and other business costs;',
    'commissions can be taken back (a chargeback) if a policy is cancelled early, and I could owe money.',
  ];
  const text = [lead, ...points].join(' ');
  return {
    lead,
    points,
    termsShown,
    version: `team-ack-v1-${createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 10)}`,
  };
}

export const TEAM_DISCLOSURE_ACK: Acknowledgment = acknowledgment();

export function acknowledgmentText(ack: Acknowledgment = TEAM_DISCLOSURE_ACK): string {
  return [ack.lead, ...ack.points].join(' ');
}
