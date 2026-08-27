/**
 * Lead normalization — turning a real-world CSV into gate-evaluable contacts.
 *
 * A lead list is where data quality goes to die: phones with dashes and
 * parentheses, zips as numbers with the leading zero eaten by Excel, state
 * columns containing "Calif.", and a consent column that nobody filled in.
 * Everything here is best-effort *and honest about it* — every inference is
 * labeled with its confidence, because the gate downstream fails closed and
 * the triage report needs to explain why.
 */

import type { ConsentBasis } from '@/types';

// ─────────────────────────────────────────────────────────────
// CSV
// ─────────────────────────────────────────────────────────────

/**
 * Minimal RFC-4180-ish parser. Handles quoted fields, escaped quotes, and
 * CRLF. Deliberately dependency-free: this repo's install size is not going
 * up by 200kB to parse a 300-row file.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      // Skip fully blank lines rather than emitting phantom rows.
      if (row.length > 1 || (row[0] ?? '').trim() !== '') rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (row.length > 1 || (row[0] ?? '').trim() !== '') rows.push(row);
  }
  return rows;
}

export function toCsvLine(fields: readonly (string | null)[]): string {
  return fields
    .map((f) => {
      const s = f ?? '';
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(',');
}

// ─────────────────────────────────────────────────────────────
// Phone
// ─────────────────────────────────────────────────────────────

/**
 * Normalize a US phone to E.164, or null if it cannot be one.
 * Accepts the usual formats: (415) 555-0123, 415.555.0123, 1-415-555-0123,
 * +14155550123. Rejects obvious junk: wrong length, N11 codes, leading 0/1
 * in the area code or exchange (invalid under NANP).
 */
export function normalizePhoneUS(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');

  let ten: string;
  if (digits.length === 10) {
    ten = digits;
  } else if (digits.length === 11 && digits.startsWith('1')) {
    ten = digits.slice(1);
  } else {
    return null;
  }

  const area = ten.slice(0, 3);
  const exchange = ten.slice(3, 6);

  // NANP: area code and exchange must start 2–9.
  const first = area[0] ?? '';
  const exFirst = exchange[0] ?? '';
  if (first < '2' || exFirst < '2') return null;
  // N11 service codes (411, 911, …) are not subscriber numbers.
  if (area[1] === '1' && area[2] === '1') return null;

  return `+1${ten}`;
}

// ─────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────

const STATE_NAMES: Readonly<Record<string, string>> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS',
  missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK',
  oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI',
  wyoming: 'WY', 'district of columbia': 'DC',
};

const VALID_STATES = new Set(Object.values(STATE_NAMES));

export function normalizeState(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const upper = trimmed.toUpperCase().replace(/\.$/, '');
  if (VALID_STATES.has(upper)) return upper;
  const byName = STATE_NAMES[trimmed.toLowerCase().replace(/\.$/, '')];
  return byName ?? null;
}

/**
 * ZIP prefix (first three digits) → state. USPS allocates prefixes in
 * contiguous ranges, so a compact range table covers the country. Approximate
 * at a handful of boundary prefixes; used only when the state column is empty,
 * and always labeled as inferred in the output.
 */
const ZIP_RANGES: readonly [start: number, end: number, state: string][] = [
  [5, 5, 'NY'], [6, 9, 'PR'],
  [10, 27, 'MA'], [28, 29, 'RI'], [30, 38, 'NH'], [39, 49, 'ME'],
  [50, 59, 'VT'], [60, 69, 'CT'], [70, 89, 'NJ'],
  [100, 149, 'NY'], [150, 196, 'PA'], [197, 199, 'DE'],
  [200, 200, 'DC'], [201, 201, 'VA'], [202, 205, 'DC'], [206, 219, 'MD'],
  [220, 246, 'VA'], [247, 268, 'WV'], [270, 289, 'NC'], [290, 299, 'SC'],
  [300, 319, 'GA'], [320, 349, 'FL'], [350, 369, 'AL'], [370, 385, 'TN'],
  [386, 397, 'MS'], [398, 399, 'GA'],
  [400, 427, 'KY'], [430, 459, 'OH'], [460, 479, 'IN'], [480, 499, 'MI'],
  [500, 528, 'IA'], [530, 549, 'WI'], [550, 567, 'MN'], [570, 577, 'SD'],
  [580, 588, 'ND'], [590, 599, 'MT'],
  [600, 629, 'IL'], [630, 658, 'MO'], [660, 679, 'KS'], [680, 693, 'NE'],
  [700, 714, 'LA'], [716, 729, 'AR'], [730, 732, 'OK'], [733, 733, 'TX'],
  [734, 749, 'OK'], [750, 799, 'TX'],
  [800, 816, 'CO'], [820, 831, 'WY'], [832, 838, 'ID'], [840, 847, 'UT'],
  [850, 865, 'AZ'], [870, 884, 'NM'], [885, 885, 'TX'], [889, 898, 'NV'],
  [900, 961, 'CA'], [967, 968, 'HI'], [970, 979, 'OR'], [980, 994, 'WA'],
  [995, 999, 'AK'],
];

export function zipToState(zipRaw: string): string | null {
  const zip = zipRaw.trim().replace(/-.*$/, '');
  // Restore the leading zero Excel ate: a 3-4 digit "zip" is a NE-US zip.
  const padded = /^\d{3,5}$/.test(zip) ? zip.padStart(5, '0') : null;
  if (!padded) return null;
  const prefix = Number.parseInt(padded.slice(0, 3), 10);
  for (const [start, end, state] of ZIP_RANGES) {
    if (prefix >= start && prefix <= end) return state;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// Timezone
// ─────────────────────────────────────────────────────────────

export interface TimezoneGuess {
  readonly timezone: string;
  /**
   * 'single' — the state has one zone; safe.
   * 'split'  — the state spans zones; this is the dominant one and the row
   *            needs a human eyeball before dialing near the window edges.
   */
  readonly confidence: 'single' | 'split';
}

const STATE_TZ: Readonly<Record<string, TimezoneGuess>> = {
  // Eastern, single-zone
  CT: { timezone: 'America/New_York', confidence: 'single' },
  DE: { timezone: 'America/New_York', confidence: 'single' },
  DC: { timezone: 'America/New_York', confidence: 'single' },
  GA: { timezone: 'America/New_York', confidence: 'single' },
  ME: { timezone: 'America/New_York', confidence: 'single' },
  MD: { timezone: 'America/New_York', confidence: 'single' },
  MA: { timezone: 'America/New_York', confidence: 'single' },
  NH: { timezone: 'America/New_York', confidence: 'single' },
  NJ: { timezone: 'America/New_York', confidence: 'single' },
  NY: { timezone: 'America/New_York', confidence: 'single' },
  NC: { timezone: 'America/New_York', confidence: 'single' },
  OH: { timezone: 'America/New_York', confidence: 'single' },
  PA: { timezone: 'America/New_York', confidence: 'single' },
  RI: { timezone: 'America/New_York', confidence: 'single' },
  SC: { timezone: 'America/New_York', confidence: 'single' },
  VT: { timezone: 'America/New_York', confidence: 'single' },
  VA: { timezone: 'America/New_York', confidence: 'single' },
  WV: { timezone: 'America/New_York', confidence: 'single' },
  // Eastern-dominant splits
  FL: { timezone: 'America/New_York', confidence: 'split' }, // panhandle is Central
  MI: { timezone: 'America/Detroit', confidence: 'split' },  // western UP is Central
  IN: { timezone: 'America/Indiana/Indianapolis', confidence: 'split' },
  KY: { timezone: 'America/New_York', confidence: 'split' }, // west KY is Central
  // Central, single-zone
  AL: { timezone: 'America/Chicago', confidence: 'single' },
  AR: { timezone: 'America/Chicago', confidence: 'single' },
  IL: { timezone: 'America/Chicago', confidence: 'single' },
  IA: { timezone: 'America/Chicago', confidence: 'single' },
  LA: { timezone: 'America/Chicago', confidence: 'single' },
  MN: { timezone: 'America/Chicago', confidence: 'single' },
  MS: { timezone: 'America/Chicago', confidence: 'single' },
  MO: { timezone: 'America/Chicago', confidence: 'single' },
  OK: { timezone: 'America/Chicago', confidence: 'single' },
  WI: { timezone: 'America/Chicago', confidence: 'single' },
  // Central-dominant splits
  TN: { timezone: 'America/Chicago', confidence: 'split' }, // east TN is Eastern
  TX: { timezone: 'America/Chicago', confidence: 'split' }, // El Paso is Mountain
  KS: { timezone: 'America/Chicago', confidence: 'split' },
  NE: { timezone: 'America/Chicago', confidence: 'split' },
  ND: { timezone: 'America/Chicago', confidence: 'split' },
  SD: { timezone: 'America/Chicago', confidence: 'split' },
  // Mountain
  CO: { timezone: 'America/Denver', confidence: 'single' },
  MT: { timezone: 'America/Denver', confidence: 'single' },
  NM: { timezone: 'America/Denver', confidence: 'single' },
  UT: { timezone: 'America/Denver', confidence: 'single' },
  WY: { timezone: 'America/Denver', confidence: 'single' },
  AZ: { timezone: 'America/Phoenix', confidence: 'single' }, // no DST
  ID: { timezone: 'America/Boise', confidence: 'split' },    // north ID is Pacific
  // Pacific
  CA: { timezone: 'America/Los_Angeles', confidence: 'single' },
  NV: { timezone: 'America/Los_Angeles', confidence: 'single' },
  WA: { timezone: 'America/Los_Angeles', confidence: 'single' },
  OR: { timezone: 'America/Los_Angeles', confidence: 'split' }, // Malheur Co. is Mountain
  // Off-mainland
  AK: { timezone: 'America/Anchorage', confidence: 'split' },
  HI: { timezone: 'Pacific/Honolulu', confidence: 'single' },
};

export function stateToTimezone(stateCode: string | null): TimezoneGuess | null {
  if (!stateCode) return null;
  return STATE_TZ[stateCode.toUpperCase()] ?? null;
}

// ─────────────────────────────────────────────────────────────
// Consent basis
// ─────────────────────────────────────────────────────────────

/**
 * Map a free-text consent/source column onto a ConsentBasis. Unknown and
 * empty both resolve to 'none' — a lead whose provenance nobody recorded is
 * a lead with no consent, whatever the vendor's invoice said.
 */
const BASIS_ALIASES: Readonly<Record<string, ConsentBasis>> = {
  prior_express_written: 'prior_express_written',
  written: 'prior_express_written',
  signed: 'prior_express_written',
  tcpa_written: 'prior_express_written',
  inbound_call: 'inbound_call',
  inbound: 'inbound_call',
  called_us: 'inbound_call',
  inbound_web_request: 'inbound_web_request',
  web: 'inbound_web_request',
  web_form: 'inbound_web_request',
  quote_form: 'inbound_web_request',
  prior_express: 'prior_express',
  verbal: 'prior_express',
  established_business_relationship: 'established_business_relationship',
  ebr: 'established_business_relationship',
  policyholder: 'established_business_relationship',
  existing_customer: 'established_business_relationship',
  none: 'none',
  purchased: 'none',
  bought: 'none',
  list: 'none',
  referral: 'none', // a referral is a warm intro, not the referee's consent
};

export function inferConsentBasis(raw: string): {
  readonly basis: ConsentBasis;
  readonly recognized: boolean;
} {
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!key) return { basis: 'none', recognized: true };
  const mapped = BASIS_ALIASES[key];
  return mapped ? { basis: mapped, recognized: true } : { basis: 'none', recognized: false };
}
