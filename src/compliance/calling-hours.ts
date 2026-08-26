/**
 * Calling-hours enforcement.
 *
 * Federal floor (47 CFR 64.1200(c)(1)): no telephone solicitation before 8:00am
 * or after 9:00pm **at the called party's local time**. "Local time" means the
 * consumer's actual location — not your office, and not the area code's nominal
 * zone. Area codes are a poor proxy after two decades of number portability, so
 * we prefer the address-derived timezone and fail closed when we have neither.
 *
 * Many states run tighter windows and some restrict Sundays or holidays. The
 * table below is the operating set for the states we expect to license into. It
 * is deliberately conservative: where sources conflict we take the narrower
 * window. Treat it as an engineering default, not as legal advice — have counsel
 * confirm each state before you enable it in LICENSED_STATES.
 */

export interface CallingWindow {
  /** Minutes after local midnight when calling may begin. */
  readonly startMinute: number;
  /** Minutes after local midnight when calling must stop. */
  readonly endMinute: number;
  /** Days of week (0=Sun) on which solicitation is prohibited entirely. */
  readonly prohibitedDays: readonly number[];
  readonly note?: string;
}

const H = (hour: number, minute = 0): number => hour * 60 + minute;

/** Federal baseline: 8:00am–9:00pm local, all seven days. */
export const FEDERAL_WINDOW: CallingWindow = {
  startMinute: H(8),
  endMinute: H(21),
  prohibitedDays: [],
};

/**
 * State overrides, narrower than federal. Absent states inherit FEDERAL_WINDOW.
 *
 * Sources to re-verify annually with counsel: each state's telemarketing statute
 * and its "mini-TCPA". Several states amended theirs between 2023 and 2025
 * (notably FL, OK, MD, WA), and more are pending.
 */
export const STATE_WINDOWS: Readonly<Record<string, CallingWindow>> = {
  // Florida Telephone Solicitation Act — 8am to 8pm, and no more than three
  // solicitation calls on the same subject within a 24-hour period.
  FL: { startMinute: H(8), endMinute: H(20), prohibitedDays: [], note: 'FTSA: 8a-8p; 3-call/24h cap' },
  // Oklahoma Telephone Solicitation Act of 2022 — mirrors FTSA.
  OK: { startMinute: H(8), endMinute: H(20), prohibitedDays: [], note: 'OTSA: 8a-8p' },
  // Washington — no commercial solicitation on Sundays or legal holidays.
  WA: { startMinute: H(8), endMinute: H(20), prohibitedDays: [0], note: 'No Sunday solicitation' },
  // Maryland — no Sunday solicitation.
  MD: { startMinute: H(8), endMinute: H(21), prohibitedDays: [0], note: 'No Sunday solicitation' },
  // Alabama, Louisiana, Mississippi — 8p cutoffs.
  AL: { startMinute: H(8), endMinute: H(20), prohibitedDays: [] },
  LA: { startMinute: H(8), endMinute: H(20), prohibitedDays: [] },
  MS: { startMinute: H(8), endMinute: H(20), prohibitedDays: [] },
  // Massachusetts — 8am to 8pm.
  MA: { startMinute: H(8), endMinute: H(20), prohibitedDays: [] },
  // Kentucky, Utah — 9am start.
  KY: { startMinute: H(9), endMinute: H(20), prohibitedDays: [] },
  UT: { startMinute: H(9), endMinute: H(21), prohibitedDays: [] },
  // Missouri, New Mexico — 9pm cutoff but 9am start in practice for solicitation.
  MO: { startMinute: H(9), endMinute: H(21), prohibitedDays: [] },
};

/**
 * Resolve the effective window: the intersection of federal and state rules.
 * We take the later start and the earlier end, so the result is never wider
 * than either input.
 */
export function effectiveWindow(stateCode: string | null): CallingWindow {
  if (!stateCode) return FEDERAL_WINDOW;
  const state = STATE_WINDOWS[stateCode.toUpperCase()];
  if (!state) return FEDERAL_WINDOW;
  return {
    startMinute: Math.max(FEDERAL_WINDOW.startMinute, state.startMinute),
    endMinute: Math.min(FEDERAL_WINDOW.endMinute, state.endMinute),
    prohibitedDays: state.prohibitedDays,
    ...(state.note === undefined ? {} : { note: state.note }),
  };
}

interface LocalClock {
  readonly minuteOfDay: number;
  readonly dayOfWeek: number;
}

/**
 * Convert an instant into wall-clock minutes and weekday in an IANA zone.
 * Uses Intl rather than a date library so we inherit the platform's tzdata and
 * get DST transitions right without shipping our own rules.
 */
export function localClock(at: Date, timezone: string): LocalClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(at);

  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';

  const hour = Number.parseInt(get('hour'), 10);
  const minute = Number.parseInt(get('minute'), 10);
  const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dayOfWeek = weekdayNames.indexOf(get('weekday'));

  if (Number.isNaN(hour) || Number.isNaN(minute) || dayOfWeek < 0) {
    throw new RangeError(`Unable to resolve local clock for timezone "${timezone}"`);
  }
  return { minuteOfDay: hour * 60 + minute, dayOfWeek };
}

export type HoursCheck =
  | { readonly allowed: true; readonly window: CallingWindow }
  | { readonly allowed: false; readonly reason: string; readonly nextOpenAt: Date | null };

/**
 * The check the gate calls. Fails closed on an unknown timezone: we would rather
 * not place a call than place one at 6am because we guessed from an area code.
 */
export function checkCallingHours(input: {
  readonly at: Date;
  readonly timezone: string | null;
  readonly stateCode: string | null;
}): HoursCheck {
  const { at, timezone, stateCode } = input;

  if (!timezone) {
    return {
      allowed: false,
      reason:
        'No timezone resolved for this contact. Federal rules key on the called ' +
        'party local time, and area code is not a lawful proxy after number portability.',
      nextOpenAt: null,
    };
  }

  const window = effectiveWindow(stateCode);
  let clock: LocalClock;
  try {
    clock = localClock(at, timezone);
  } catch {
    return { allowed: false, reason: `Invalid IANA timezone "${timezone}"`, nextOpenAt: null };
  }

  if (window.prohibitedDays.includes(clock.dayOfWeek)) {
    return {
      allowed: false,
      reason: `${stateCode} prohibits telephone solicitation on this day of the week.`,
      nextOpenAt: null,
    };
  }

  if (clock.minuteOfDay < window.startMinute || clock.minuteOfDay >= window.endMinute) {
    const fmt = (m: number): string =>
      `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    return {
      allowed: false,
      reason:
        `Local time ${fmt(clock.minuteOfDay)} in ${timezone} is outside the permitted ` +
        `window ${fmt(window.startMinute)}–${fmt(window.endMinute)}` +
        (window.note ? ` (${window.note})` : ''),
      nextOpenAt: null,
    };
  }

  return { allowed: true, window };
}
