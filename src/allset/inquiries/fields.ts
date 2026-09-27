/**
 * Inquiry field definitions and server-side validation.
 *
 * This is the authority. The browser form carries labels and autocomplete
 * hints but no validation of its own; every rule and every message lives
 * here, runs on the server, and comes back to the form field by field.
 *
 * Deliberately absent: date of birth, SSN, medical history, income, payment
 * details, free-text messages. The forms collect what a person needs to be
 * called back and nothing that invites sensitive detail.
 */

import type { InquiryKind } from './consent';
import { isStateCode, type StateCode } from '@/allset/content/states';

export const CONTACT_METHODS = ['email', 'phone', 'text'] as const;
export type ContactMethod = (typeof CONTACT_METHODS)[number];

export const COVERAGE_INTERESTS = ['life', 'health', 'both', 'not_sure'] as const;
export type CoverageInterest = (typeof COVERAGE_INTERESTS)[number];

export const LICENSING_STATUSES = ['licensed_life_health', 'licensed_other', 'studying', 'not_licensed'] as const;
export type LicensingStatus = (typeof LICENSING_STATUSES)[number];

export const COVERAGE_INTEREST_LABELS: Record<CoverageInterest, string> = {
  life: 'Life insurance',
  health: 'Health insurance',
  both: 'Both life and health',
  not_sure: 'Not sure yet',
};

export const LICENSING_STATUS_LABELS: Record<LicensingStatus, string> = {
  licensed_life_health: 'I have a life or health insurance license (or both)',
  licensed_other: 'I hold a different insurance license (for example, property)',
  studying: "I'm studying for the licensing exam",
  not_licensed: "I'm not licensed yet",
};

export const CONTACT_METHOD_LABELS: Record<ContactMethod, string> = {
  email: 'Email',
  phone: 'Phone call',
  text: 'Text message',
};

export const LIMITS = {
  fullName: 100,
  email: 254,
} as const;

/** Every field the forms submit, as strings, exactly as typed. */
export interface InquiryValues {
  readonly fullName: string;
  readonly email: string;
  readonly zip: string;
  readonly state: string;
  readonly contactMethod: string;
  readonly phone: string;
  readonly coverageInterest: string;
  readonly licensingStatus: string;
  readonly consent: boolean;
  readonly disclosureAck: boolean;
}

export type FieldName = keyof InquiryValues;
export type FieldErrors = Partial<Record<FieldName, string>>;

export interface ValidInquiry {
  readonly kind: InquiryKind;
  readonly fullName: string;
  readonly email: string;
  readonly emailNormalized: string;
  readonly zip: string;
  readonly state: StateCode;
  readonly contactMethod: ContactMethod;
  readonly phoneE164: string | null;
  readonly coverageInterest: CoverageInterest | null;
  readonly licensingStatus: LicensingStatus | null;
  readonly disclosureAck: boolean;
}

export const EMPTY_VALUES: InquiryValues = {
  fullName: '',
  email: '',
  zip: '',
  state: '',
  contactMethod: '',
  phone: '',
  coverageInterest: '',
  licensingStatus: '',
  consent: false,
  disclosureAck: false,
};

function text(form: FormData, name: string, max = 400): string {
  const value = form.get(name);
  // Cap before any processing, so an oversized post costs nothing downstream.
  return typeof value === 'string' ? value.slice(0, max) : '';
}

export function readValues(form: FormData): InquiryValues {
  return {
    fullName: text(form, 'fullName'),
    email: text(form, 'email'),
    zip: text(form, 'zip', 20),
    state: text(form, 'state', 4).toUpperCase(),
    contactMethod: text(form, 'contactMethod', 20),
    phone: text(form, 'phone', 40),
    coverageInterest: text(form, 'coverageInterest', 40),
    licensingStatus: text(form, 'licensingStatus', 40),
    consent: form.get('consent') === 'yes',
    disclosureAck: form.get('disclosureAck') === 'yes',
  };
}

// Includes the typographic apostrophe (’) phones insert automatically: O’Neil.
const NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M}'’ .,-]*$/u;
// Pragmatic, not RFC 5322: one @, a dot in the domain, no spaces.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const SSN_PATTERN = /\b\d{3}-?\d{2}-?\d{4}\b/;

/** US numbers only: 10 digits, optional leading 1, valid NANP area/exchange. */
export function normalizeUsPhone(raw: string): string | null {
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return null;
  return `+1${digits}`;
}

export function normalizeZip(raw: string): string | null {
  const match = raw.trim().match(/^(\d{5})(?:-?\d{4})?$/);
  if (!match || match[1] === '00000') return null;
  return match[1]!;
}

function collapse(value: string): string {
  return value.normalize('NFC').replace(/\s+/g, ' ').trim();
}

export type ValidationResult =
  | { readonly ok: true; readonly inquiry: ValidInquiry }
  | { readonly ok: false; readonly errors: FieldErrors };

export function validateInquiry(kind: InquiryKind, values: InquiryValues): ValidationResult {
  const errors: FieldErrors = {};

  const fullName = collapse(values.fullName);
  if (!fullName) errors.fullName = 'Enter your name.';
  else if (fullName.length < 2) errors.fullName = 'Enter your full name.';
  else if (fullName.length > LIMITS.fullName) errors.fullName = `Use ${LIMITS.fullName} characters or fewer.`;
  else if (SSN_PATTERN.test(fullName)) errors.fullName = 'Please don’t include numbers like a Social Security number.';
  else if (!NAME_PATTERN.test(fullName)) errors.fullName = 'Use letters, spaces, hyphens, apostrophes, periods and commas only.';

  const email = values.email.trim();
  if (!email) errors.email = 'Enter your email address.';
  else if (email.length > LIMITS.email) errors.email = `Use ${LIMITS.email} characters or fewer.`;
  else if (!EMAIL_PATTERN.test(email)) errors.email = 'Enter an email address like name@example.com.';

  const zip = normalizeZip(values.zip);
  if (!values.zip.trim()) errors.zip = 'Enter your ZIP code.';
  else if (!zip) errors.zip = 'Enter a 5-digit ZIP code, like 60601.';

  const state = isStateCode(values.state) ? values.state : null;
  if (!state) errors.state = 'Choose the state you live in.';

  const method = (CONTACT_METHODS as readonly string[]).includes(values.contactMethod)
    ? (values.contactMethod as ContactMethod)
    : null;
  if (!method) errors.contactMethod = 'Choose how you’d like us to reach you.';

  let phoneE164: string | null = null;
  if (method === 'phone' || method === 'text') {
    if (!values.phone.trim()) {
      errors.phone = method === 'text' ? 'Enter a mobile number so we can text you.' : 'Enter a phone number so we can call you.';
    } else {
      phoneE164 = normalizeUsPhone(values.phone);
      if (!phoneE164) errors.phone = 'Enter a 10-digit US phone number, like (312) 555-0142.';
    }
  }

  let coverageInterest: CoverageInterest | null = null;
  let licensingStatus: LicensingStatus | null = null;
  if (kind === 'coverage') {
    coverageInterest = (COVERAGE_INTERESTS as readonly string[]).includes(values.coverageInterest)
      ? (values.coverageInterest as CoverageInterest)
      : null;
    if (!coverageInterest) errors.coverageInterest = 'Choose what you’d like help with.';
  } else {
    licensingStatus = (LICENSING_STATUSES as readonly string[]).includes(values.licensingStatus)
      ? (values.licensingStatus as LicensingStatus)
      : null;
    if (!licensingStatus) errors.licensingStatus = 'Choose the option that describes your license status.';
    if (!values.disclosureAck) errors.disclosureAck = 'Confirm that you’ve read the information about this work above.';
  }

  if (!values.consent) errors.consent = 'Check the box so we’re allowed to contact you. We can’t follow up without it.';

  if (Object.keys(errors).length > 0 || !zip || !state || !method) return { ok: false, errors };

  return {
    ok: true,
    inquiry: {
      kind,
      fullName,
      email,
      emailNormalized: email.toLowerCase(),
      zip,
      state,
      contactMethod: method,
      phoneE164,
      coverageInterest,
      licensingStatus,
      disclosureAck: kind === 'team' ? values.disclosureAck : false,
    },
  };
}

/** Order the error summary lists fields in: the order they appear on the form. */
export const FIELD_ORDER: readonly FieldName[] = [
  'fullName',
  'email',
  'zip',
  'state',
  'coverageInterest',
  'licensingStatus',
  'contactMethod',
  'phone',
  'disclosureAck',
  'consent',
];
