/**
 * The quoting port.
 *
 * There is no implementation to test, and that is the thing being tested. The
 * default adapter refuses, because the one thing the agent must never do is
 * speak a premium that did not come from a carrier — and a stub returning
 * plausible numbers is worse than no stub at all, since a fabricated figure that
 * sounds right is harder to catch than one that obviously isn't.
 *
 * So these assert the refusal, the appointment filter, and that one carrier's
 * outage does not lose the other three.
 */

import { describe, expect, it } from 'vitest';
import {
  QuotingUnavailableError,
  quoteAll,
  selectAdapters,
  unavailableQuotingAdapter,
  type QuoteRequest,
  type QuoteResult,
  type QuotingAdapter,
} from './port';

const REQUEST: QuoteRequest = {
  line: 'auto',
  contactId: 'contact_1',
  stateCode: 'CA',
  payload: { vehicle: '2019 Civic' },
  appointedCarriers: ['Safeco', 'Travelers'],
};

function adapter(
  carrier: string,
  result: QuoteResult | Error,
  lines: QuotingAdapter['supportedLines'] = ['auto'],
): QuotingAdapter {
  return {
    carrier,
    supportedLines: lines,
    quote: () => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)),
  };
}

function option(carrier: string, annualPremiumCents: number) {
  return {
    carrier,
    annualPremiumCents,
    estimatedCommissionCents: Math.round(annualPremiumCents * 0.12),
    coverageSummary: { liability: '100/300/100' },
    bindable: true,
    expiresAt: new Date('2026-12-31'),
    rawResponse: { raw: true },
  };
}

function result(...options: ReturnType<typeof option>[]): QuoteResult {
  return { quotedAt: new Date(), options, declines: [] };
}

describe('the default adapter refuses rather than inventing a number', () => {
  it('rejects', async () => {
    await expect(unavailableQuotingAdapter.quote(REQUEST)).rejects.toThrow(
      QuotingUnavailableError,
    );
  });

  it('explains what to do instead, because this is the expected state', async () => {
    await expect(unavailableQuotingAdapter.quote(REQUEST)).rejects.toThrow(
      /Route the\s+contact to a licensed producer/,
    );
  });

  it('names the line, so the message is actionable', async () => {
    await expect(unavailableQuotingAdapter.quote({ ...REQUEST, line: 'home' })).rejects.toThrow(
      /"home"/,
    );
  });
});

describe('the appointment filter', () => {
  it('drops a carrier the agency is not appointed with', () => {
    const selected = selectAdapters(
      [adapter('Safeco', result()), adapter('Progressive', result())],
      REQUEST,
    );

    // Quoting a carrier you cannot bind produces a number you cannot honour,
    // and discovering that after the customer says yes is the worst moment.
    expect(selected.map((a) => a.carrier)).toEqual(['Safeco']);
  });

  it('drops a carrier that does not write this line', () => {
    const selected = selectAdapters(
      [adapter('Safeco', result(), ['home']), adapter('Travelers', result(), ['auto'])],
      REQUEST,
    );

    expect(selected.map((a) => a.carrier)).toEqual(['Travelers']);
  });
});

describe('quoting across carriers', () => {
  it('refuses when nothing is eligible', async () => {
    await expect(quoteAll([], REQUEST)).rejects.toThrow(QuotingUnavailableError);
    await expect(quoteAll([adapter('Progressive', result())], REQUEST)).rejects.toThrow(
      QuotingUnavailableError,
    );
  });

  it('keeps the carriers that answered when one fails', async () => {
    const quotes = await quoteAll(
      [
        adapter('Safeco', new Error('gateway timeout')),
        adapter('Travelers', result(option('Travelers', 180_000))),
      ],
      REQUEST,
    );

    // One vendor's outage must not lose the other three.
    expect(quotes.options.map((o) => o.carrier)).toEqual(['Travelers']);
    expect(quotes.declines.map((d) => d.carrier)).toEqual(['Safeco']);
    expect(quotes.declines[0]?.reason).toContain('gateway timeout');
  });

  it('sorts cheapest first', async () => {
    const quotes = await quoteAll(
      [
        adapter('Safeco', result(option('Safeco', 240_000))),
        adapter('Travelers', result(option('Travelers', 180_000))),
      ],
      REQUEST,
    );

    // The agent reads at most three — past three, people stop choosing.
    expect(quotes.options.map((o) => o.annualPremiumCents)).toEqual([180_000, 240_000]);
  });

  it('carries a carrier’s own declines through alongside the failures', async () => {
    const declined: QuoteResult = {
      quotedAt: new Date(),
      options: [],
      declines: [{ carrier: 'Safeco', reason: 'underwriting: prior lapse' }],
    };

    const quotes = await quoteAll([adapter('Safeco', declined)], REQUEST);

    // A decline for cause and a vendor outage are different facts, and the
    // producer wants both.
    expect(quotes.declines).toEqual([{ carrier: 'Safeco', reason: 'underwriting: prior lapse' }]);
  });
});
