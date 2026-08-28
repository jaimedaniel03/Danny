/**
 * Consent disclosure language — versioned.
 *
 * This file is the single most legally consequential thing in the repo. Every
 * string here is what a consumer reads and agrees to, and it is the exact text
 * that gets quoted back in a deposition. Three rules govern it:
 *
 *  1. **Counsel writes the final text.** What is below is a drafting starting
 *     point built from the elements the FCC's rules require. It is not legal
 *     advice and it has not been reviewed. Replace it before you capture a
 *     single real signature.
 *  2. **Versions are immutable.** Never edit a published version in place. Add
 *     a new one. Consent records store the version id, so a defective revision
 *     is findable in bulk — `select * from consents where disclosure_version =
 *     'v1'` is the query you will be glad exists.
 *  3. **The seller must be named.** Consent to "our partners" is not consent to
 *     you. `{{AGENCY_LEGAL_NAME}}` is interpolated at render and stored
 *     resolved, not as a template.
 *
 * ── What prior express written consent actually requires ─────────────────────
 * Under 47 CFR 64.1200(f)(9) the writing must:
 *   - clearly authorize the seller to deliver advertisements or telemarketing
 *     messages using an automatic telephone dialing system or an artificial or
 *     prerecorded voice;
 *   - specify the telephone number the calls are authorized to be made to;
 *   - include a clear and conspicuous disclosure that (a) the consumer
 *     authorizes such calls and (b) consent is not a condition of purchase;
 *   - bear the consumer's signature (E-SIGN electronic signatures qualify).
 *
 * The "not a condition of purchase" line is the one people forget, and its
 * absence alone can void the consent.
 */

export interface DisclosureVersion {
  readonly id: string;
  readonly effectiveFrom: string;
  /** Counsel sign-off. Null means DRAFT — the API refuses to publish it. */
  readonly reviewedBy: string | null;
  readonly reviewedAt: string | null;
  /** The checkbox label. Must be affirmative, unchecked by default. */
  readonly checkboxLabel: string;
  /** Full body, shown adjacent to the checkbox — never behind a link. */
  readonly body: string;
  /** Shown under the submit button. */
  readonly footer: string;
}

const AGENCY = '{{AGENCY_LEGAL_NAME}}';
const PHONE = '{{PHONE_DISPLAY}}';

export const DISCLOSURE_VERSIONS: Readonly<Record<string, DisclosureVersion>> = {
  'draft-v1': {
    id: 'draft-v1',
    effectiveFrom: '2026-01-01',
    reviewedBy: null,
    reviewedAt: null,
    checkboxLabel:
      `I agree to be contacted at ${PHONE} by ${AGENCY}, including by ` +
      `automated technology and an artificial or prerecorded voice.`,
    body:
      `By checking the box above and clicking Submit, I authorize ${AGENCY} to ` +
      `contact me at ${PHONE} about insurance products and my existing policies. ` +
      `I understand these calls and text messages may be made using an automatic ` +
      `telephone dialing system, an artificial voice, or a prerecorded voice, and ` +
      `that some calls may be handled by an AI assistant that will identify itself ` +
      `as such. I understand calls may be recorded. ` +
      `\n\n` +
      `I understand that my consent is not a condition of purchasing any goods or ` +
      `services. I can revoke this consent at any time by telling any representative ` +
      `to stop calling, by replying STOP to a text message, or by contacting ` +
      `${AGENCY} directly. Message and data rates may apply.`,
    footer:
      `Your signature is recorded with the date, time, and IP address of this ` +
      `submission. You will receive a copy by email.`,
  },
};

export const CURRENT_DISCLOSURE_VERSION = 'draft-v1';

export class DisclosureNotReviewedError extends Error {
  constructor(versionId: string) {
    super(
      `Disclosure version "${versionId}" has no counsel review on file. ` +
        `Consent captured under unreviewed language may be void, which would ` +
        `retroactively invalidate every call made in reliance on it. Set ` +
        `reviewedBy/reviewedAt in src/consent/disclosure-text.ts after review, ` +
        `or set DANNY_ALLOW_DRAFT_DISCLOSURE=true for local development only.`,
    );
    this.name = 'DisclosureNotReviewedError';
  }
}

export interface RenderedDisclosure {
  readonly versionId: string;
  readonly checkboxLabel: string;
  readonly body: string;
  readonly footer: string;
  /**
   * The exact concatenated text the consumer saw. This — not the template —
   * is what gets written to `consents.disclosure_text`.
   */
  readonly verbatim: string;
}

/**
 * Render a version with the agency and phone resolved. Refuses to render an
 * unreviewed version outside development, because the failure mode is silent:
 * you collect 500 signatures and find out later none of them count.
 */
export function renderDisclosure(input: {
  readonly versionId?: string;
  readonly agencyLegalName: string;
  readonly phoneDisplay: string;
  readonly allowDraft?: boolean;
}): RenderedDisclosure {
  const versionId = input.versionId ?? CURRENT_DISCLOSURE_VERSION;
  const version = DISCLOSURE_VERSIONS[versionId];
  if (!version) {
    throw new Error(`Unknown disclosure version "${versionId}".`);
  }

  const allowDraft =
    input.allowDraft ?? process.env['DANNY_ALLOW_DRAFT_DISCLOSURE'] === 'true';
  if (version.reviewedBy === null && !allowDraft) {
    throw new DisclosureNotReviewedError(versionId);
  }

  const fill = (s: string): string =>
    s.replaceAll(AGENCY, input.agencyLegalName).replaceAll(PHONE, input.phoneDisplay);

  const checkboxLabel = fill(version.checkboxLabel);
  const body = fill(version.body);
  const footer = fill(version.footer);

  return {
    versionId,
    checkboxLabel,
    body,
    footer,
    verbatim: `${checkboxLabel}\n\n${body}\n\n${footer}`,
  };
}
