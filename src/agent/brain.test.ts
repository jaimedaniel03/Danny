/**
 * Turn streaming and the guardrail cut-off.
 *
 * Two things here reach a live phone call directly.
 *
 * The **guardrail check runs before the yield**, which is what makes it a
 * control rather than a report: the caller synthesizes each chunk as it
 * arrives, so a sentence that clears the check is spoken and a sentence that
 * does not is never generated into audio at all. The stream is aborted on the
 * spot rather than drained.
 *
 * The **chunk boundaries** decide what the prospect actually hears. A splitter
 * that mis-tracks its own position emits a fragment of the previous sentence
 * glued to the next one, and nothing downstream can tell that apart from
 * something the model meant to say.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  GuardrailViolationError,
  SAFE_FALLBACK_LINE,
  generateTurn,
  streamTurn,
  type TurnContext,
} from './brain';

const CTX: TurnContext = {
  state: 'DISCOVERY',
  stateInstructions: 'Ask one question.',
  line: 'auto',
  agencyName: 'Ruiz Family Insurance LLC',
  producerName: 'Danny',
  contactSummary: 'Dana Ruiz, auto policyholder',
  discoverySoFar: '',
  missingFields: ['current_carrier'],
  history: [],
};

/** A client that streams `deltas` as text_delta events, then closes. */
function client(deltas: readonly string[]): { aborted: boolean; client: unknown } {
  const state = { aborted: false };
  return {
    get aborted() {
      return state.aborted;
    },
    client: {
      messages: {
        stream: () => ({
          abort: () => {
            state.aborted = true;
          },
          async *[Symbol.asyncIterator]() {
            for (const text of deltas) {
              await Promise.resolve();
              yield { type: 'content_block_delta', delta: { type: 'text_delta', text } };
            }
          },
        }),
      },
    },
  };
}

async function collect(deltas: readonly string[]): Promise<string[]> {
  const fake = client(deltas);
  const out: string[] = [];
  for await (const chunk of streamTurn(CTX, { client: fake.client as never })) {
    out.push(chunk.text);
  }
  return out;
}

describe('chunking', () => {
  it('emits each complete sentence exactly once, in order', async () => {
    const chunks = await collect([
      'A first sentence here. ',
      'A second sentence here. ',
      'A third one here.',
    ]);

    expect(chunks).toEqual([
      'A first sentence here.',
      'A second sentence here.',
      'A third one here.',
    ]);
  });

  it('does not glue a fragment of one sentence onto the next', async () => {
    // The regression this file was written for. The tail used to be found by
    // slicing the raw buffer by how many characters had been emitted — but the
    // chunker joins on a single space and trims, so a double space between
    // sentences shifted the offset and the last utterance came out as
    // "e.  A third one here." Spoken aloud, once per turn that ended that way.
    const chunks = await collect([
      'A first sentence here.  A second sentence here.  A third one here.',
    ]);

    expect(chunks).toEqual([
      'A first sentence here.',
      'A second sentence here.',
      'A third one here.',
    ]);
  });

  it('survives newlines between sentences, which models emit constantly', async () => {
    const chunks = await collect([
      'A first sentence here.\n\nA second sentence here.\n\nA third one here.',
    ]);

    expect(chunks.join(' ')).not.toContain('  ');
    expect(chunks[chunks.length - 1]).toBe('A third one here.');
  });

  it('emits a single-sentence turn, which is what most turns are', async () => {
    expect(await collect(['Do you have two minutes?'])).toEqual(['Do you have two minutes?']);
  });

  it('emits nothing for an empty turn rather than an empty utterance', async () => {
    expect(await collect([])).toEqual([]);
    expect(await collect(['   '])).toEqual([]);
  });

  it('does not split a decimal into two utterances', async () => {
    // "four hundred ninety two. Five a month" is how this sounds when it goes
    // wrong, and insurance calls are mostly numbers.
    const chunks = await collect(['Your premium is 492.50 a month right now.']);

    expect(chunks).toEqual(['Your premium is 492.50 a month right now.']);
  });

  it('reassembles a sentence delivered one token at a time', async () => {
    const chunks = await collect(['Do ', 'you ', 'have ', 'two ', 'minutes', '?']);

    expect(chunks).toEqual(['Do you have two minutes?']);
  });
});

describe('the guardrail stops a sentence before it can be synthesized', () => {
  it('throws instead of yielding the offending sentence', async () => {
    const attempt = collect([
      'Good news about your policy. ',
      "You're covered as of today. ",
      'Let me get the details.',
    ]);

    await expect(attempt).rejects.toThrow(GuardrailViolationError);
  });

  it('aborts the stream rather than draining it', async () => {
    const fake = client([
      'Good news about your policy. ',
      "You're covered as of today. ",
      'Let me get the details.',
    ]);

    try {
      for await (const _ of streamTurn(CTX, { client: fake.client as never })) {
        // consume
      }
    } catch {
      // expected
    }

    // Tokens already paid for are sunk; tokens still being generated are not.
    expect(fake.aborted).toBe(true);
  });

  it('yields the clean sentences that preceded it', async () => {
    const out: string[] = [];
    const fake = client(['Good news about your policy. ', "You're covered as of today."]);

    try {
      for await (const chunk of streamTurn(CTX, { client: fake.client as never })) {
        out.push(chunk.text);
      }
    } catch {
      // expected
    }

    // The caller has already spoken these. Pretending otherwise would put the
    // conversation history out of step with what the prospect heard.
    expect(out).toEqual(['Good news about your policy.']);
  });

  it('catches a violation in the final sentence too, not just mid-stream', async () => {
    // The tail takes a different path through the function, and a guardrail
    // that only covered the mid-stream path would miss every single-sentence
    // turn — which is most of them.
    await expect(collect(['I guarantee a lower rate.'])).rejects.toThrow(GuardrailViolationError);
  });

  it('reports what matched and why', async () => {
    try {
      await collect(["I'm a licensed agent here in California."]);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GuardrailViolationError);
      const violations = (err as GuardrailViolationError).violations;
      expect(violations[0]?.why).toMatch(/disclosure/i);
    }
  });

  it('lets ordinary accurate sales language through untouched', async () => {
    const chunks = await collect([
      'Safeco came back at eighteen hundred a year. ',
      "That's subject to underwriting, and a licensed agent will confirm it.",
    ]);

    expect(chunks).toHaveLength(2);
  });
});

describe('generateTurn', () => {
  it('joins the whole turn for the states where nothing is spoken early', async () => {
    const fake = client(['A first sentence here. ', 'A second sentence here.']);
    const text = await generateTurn(CTX, { client: fake.client as never });

    expect(text).toBe('A first sentence here. A second sentence here.');
  });

  it('propagates a guardrail violation rather than returning partial text', async () => {
    const fake = client(['Good news. ', "You're covered as of today."]);

    await expect(generateTurn(CTX, { client: fake.client as never })).rejects.toThrow(
      GuardrailViolationError,
    );
  });
});

describe('the safe fallback', () => {
  it('is a hand-off, not a retry', () => {
    // Two failed generations on a live call is a signal to get a person on the
    // phone, not to roll the dice a third time.
    expect(SAFE_FALLBACK_LINE).toMatch(/someone who can help/i);
  });

  it('would itself pass the guardrails', async () => {
    const chunks = await collect([SAFE_FALLBACK_LINE]);
    expect(chunks.join(' ')).toContain('trouble on my end');
  });
});

describe('model selection', () => {
  it('honours DANNY_TURN_MODEL when set', async () => {
    vi.stubEnv('DANNY_TURN_MODEL', 'claude-sonnet-5');
    const seen: Record<string, unknown>[] = [];

    const fake = {
      messages: {
        stream: (args: Record<string, unknown>) => {
          seen.push(args);
          return {
            abort: () => undefined,
            async *[Symbol.asyncIterator]() {
              await Promise.resolve();
              yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello.' } };
            },
          };
        },
      },
    };

    for await (const _ of streamTurn(CTX, { client: fake as never })) {
      // consume
    }

    expect(seen[0]?.['model']).toBe('claude-sonnet-5');
    vi.unstubAllEnvs();
  });
});
