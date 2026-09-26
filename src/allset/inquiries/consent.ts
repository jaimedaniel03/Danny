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
import { businessName } from '@/allset/content/facts';

export type InquiryKind = 'coverage' | 'team';

function versionOf(kind: InquiryKind, text: string): string {
  return `${kind}-v1-${createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 10)}`;
}

function coverageText(): string {
  return (
    `I agree that ${businessName()} may contact me about this request by the method I chose ` +
    'above: email, phone call, or text message. A person on the team will reach out; this is ' +
    'not consent to automated or prerecorded calls. Message and data rates may apply to texts. ' +
    'I can reply STOP to texts, or ask at any time that you stop contacting me. Agreeing is not ' +
    'a condition of buying anything.'
  );
}

function teamText(): string {
  return (
    `I agree that ${businessName()} may contact me about joining the team by the method I chose ` +
    'above: email, phone call, or text message. A person on the team will reach out; this is not ' +
    'consent to automated or prerecorded calls. Message and data rates may apply to texts. I can ' +
    'reply STOP to texts, or ask at any time that you stop contacting me. I understand this is an ' +
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

/** Team inquiries also acknowledge the role disclosures shown above the form. */
export const TEAM_DISCLOSURE_ACK =
  'I have read the role disclosures on this page, including that income is not guaranteed, that ' +
  'licensing and other business costs may be mine to pay, and that commissions can be taken back ' +
  '(charged back) if a policy is cancelled early.';
