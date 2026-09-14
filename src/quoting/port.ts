/**
 * Carrier quoting — the port, not an implementation.
 *
 * ── Why there is no implementation here ─────────────────────────────────────
 * Every carrier's rating API is different, most are SOAP, several are only
 * reachable through a comparative rater (EZLynx, PL Rating, Turborater), and
 * access requires an appointment plus a technical review that takes weeks. There
 * is no generic version of this to write, and a plausible-looking stub is worse
 * than nothing: the one thing the agent must never do is speak a number that did
 * not come from a carrier.
 *
 * So this file defines the shape and `UnavailableQuotingAdapter` refuses loudly.
 * Wire a real adapter per carrier as each appointment lands.
 *
 * ── The invariant this exists to protect ────────────────────────────────────
 * `QuoteResult.carrier` and `.quotedAt` are required, and the state machine
 * only enters `PRESENTING_QUOTE` with a result in hand. That is what makes
 * "never quote a number that did not come from a carrier API in this call"
 * enforceable rather than aspirational — see `QUOTE_GUARDRAILS`.
 */

import type { LineOfBusiness } from '@/types';

export interface QuoteRequest {
  readonly line: LineOfBusiness;
  readonly contactId: string;
  readonly stateCode: string;
  /** Underwriting answers gathered in DISCOVERY. Shape is line-specific. */
  readonly payload: Readonly<Record<string, unknown>>;
  /** Only carriers the agency is appointed with. You cannot sell what you cannot bind. */
  readonly appointedCarriers: readonly string[];
}

export interface QuoteOption {
  readonly carrier: string;
  readonly annualPremiumCents: number;
  readonly estimatedCommissionCents: number;
  /** Deductibles, limits — whatever the agent may read back. */
  readonly coverageSummary: Readonly<Record<string, string>>;
  /** False when the carrier returned an indication rather than a bindable quote. */
  readonly bindable: boolean;
  readonly expiresAt: Date;
  /** Verbatim carrier response. Never reconstruct a quote from parsed fields. */
  readonly rawResponse: Readonly<Record<string, unknown>>;
}

export interface QuoteResult {
  readonly quotedAt: Date;
  readonly options: readonly QuoteOption[];
  /** Carriers that declined, and why — useful to the producer, not to the agent. */
  readonly declines: readonly { readonly carrier: string; readonly reason: string }[];
}

export interface QuotingAdapter {
  readonly carrier: string;
  readonly supportedLines: readonly LineOfBusiness[];
  quote(request: QuoteRequest): Promise<QuoteResult>;
}

export class QuotingUnavailableError extends Error {
  constructor(line: LineOfBusiness) {
    super(
      `No quoting adapter is configured for "${line}".\n\n` +
        `This is expected: carrier rating APIs require an appointment and a\n` +
        `per-carrier integration, so there is nothing generic to ship.\n\n` +
        `Until one is wired, the agent must NOT present a premium. Route the\n` +
        `contact to a licensed producer, who quotes in the comparative rater and\n` +
        `calls back. The agent may still qualify, schedule, and collect\n` +
        `underwriting answers — which is most of the value on a first call.`,
    );
    this.name = 'QuotingUnavailableError';
  }
}

/**
 * The default adapter. Refuses.
 *
 * Deliberately not a stub returning plausible numbers. A fabricated premium
 * spoken out loud is a misrepresentation, and one that sounds right is worse
 * than one that obviously isn't.
 */
export const unavailableQuotingAdapter: QuotingAdapter = {
  carrier: 'none',
  supportedLines: [],
  quote(request: QuoteRequest): Promise<QuoteResult> {
    return Promise.reject(new QuotingUnavailableError(request.line));
  },
};

/**
 * Route a request to the adapter for its line, filtered to appointed carriers.
 *
 * The appointment filter is not a nicety: quoting a carrier you are not
 * appointed with produces a number you cannot bind, and discovering that after
 * the customer says yes is the worst possible moment.
 */
export function selectAdapters(
  adapters: readonly QuotingAdapter[],
  request: QuoteRequest,
): readonly QuotingAdapter[] {
  return adapters.filter(
    (a) =>
      a.supportedLines.includes(request.line) &&
      request.appointedCarriers.includes(a.carrier),
  );
}

/**
 * Quote across every eligible carrier, tolerating individual failures.
 *
 * One carrier's outage must not lose the other three. A carrier that throws is
 * recorded as a decline with its reason rather than failing the whole call —
 * the producer wants to know a carrier was unreachable, and the prospect only
 * needs the options that came back.
 */
export async function quoteAll(
  adapters: readonly QuotingAdapter[],
  request: QuoteRequest,
): Promise<QuoteResult> {
  const eligible = selectAdapters(adapters, request);
  if (eligible.length === 0) throw new QuotingUnavailableError(request.line);

  const settled = await Promise.allSettled(eligible.map((a) => a.quote(request)));

  const options: QuoteOption[] = [];
  const declines: { carrier: string; reason: string }[] = [];

  settled.forEach((result, i) => {
    const carrier = eligible[i]?.carrier ?? 'unknown';
    if (result.status === 'fulfilled') {
      options.push(...result.value.options);
      declines.push(...result.value.declines);
    } else {
      declines.push({ carrier, reason: String(result.reason) });
    }
  });

  return {
    quotedAt: new Date(),
    // Cheapest first. The agent reads at most three — past three, people stop
    // choosing.
    options: options.sort((a, b) => a.annualPremiumCents - b.annualPremiumCents),
    declines,
  };
}
