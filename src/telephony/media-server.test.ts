/**
 * The live call loop.
 *
 * This drives a real `CallSession` through a fake WebSocket. Nothing here
 * reaches Twilio, Deepgram, Fish, or the model — the ports are stubs — but the
 * session's own bookkeeping is the real thing, and that bookkeeping is where the
 * bugs live:
 *
 *   - **Frame decoding.** `ws` hands back `Buffer[]` for a fragmented message.
 *     Twilio fragments under load, and the naive decode silently drops media
 *     events at exactly the busy moments.
 *   - **The interrupt latch.** The silence timeout is evaluated on every inbound
 *     frame — fifty a second — and each handler awaits a synthesis before it
 *     finishes. Without a latch the prospect hears the goodbye line overlapping
 *     itself and `onDncRequested` fires dozens of times.
 *   - **Honouring a removal request.** The single most consequential path in the
 *     product, and the one the AI disclosure makes a promise about.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { CallSession, type CallOutcome, type CallSessionDeps } from './media-server';
import { SAFE_FALLBACK_LINE } from '@/agent/brain';
import { mulawToPcm16, pcm16ToMulaw, BYTES_PER_MULAW_FRAME } from '@/voice/audio';
import type { DialAuthorization } from '@/types';

// ── Fakes ────────────────────────────────────────────────────────────────────

/**
 * A WebSocket that records what was written to it.
 *
 * `ws` is an EventEmitter with `send`/`close`/`readyState`, so an EventEmitter
 * with those three is indistinguishable from the session's point of view.
 */
class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: Record<string, unknown>[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  /** Deliver a frame the way `ws` would — as a Buffer. */
  deliver(event: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(event), 'utf-8'));
  }

  /** Deliver the same frame FRAGMENTED, the way `ws` does under load. */
  deliverFragmented(event: unknown, pieces = 3): void {
    const whole = Buffer.from(JSON.stringify(event), 'utf-8');
    const size = Math.ceil(whole.length / pieces);
    const chunks: Buffer[] = [];
    for (let i = 0; i < whole.length; i += size) chunks.push(whole.subarray(i, i + size));
    this.emit('message', chunks);
  }

  playedMarks(): string[] {
    return this.sent
      .filter((m) => m['event'] === 'mark')
      .map((m) => (m['mark'] as { name: string }).name);
  }
}

const AUTHORIZATION = {
  phoneE164: '+14155550123',
  contactId: 'contact_1',
  line: 'auto',
  basis: 'prior_express_written',
  requiredDisclosure: 'Hi, this is Danny, an AI assistant. I am not a human.',
  expiresAt: new Date(Date.now() + 60_000),
  issuedAt: new Date(),
  gateVersion: 'test',
} as unknown as DialAuthorization;

/**
 * A model client that streams one scripted line.
 *
 * Needed because the session treats a model failure as a reason to hand off to
 * a human and end the call — correct behaviour, and it means a test that let
 * the real SDK fail would be testing the outage path every time. Shaped like
 * what `streamTurn` consumes: async-iterable, with `abort()`.
 */
const AGENT_LINE = 'Is this a good time for two quick questions?';

function fakeAnthropic(line = AGENT_LINE): unknown {
  return {
    messages: {
      stream: () => ({
        abort: () => undefined,
        // eslint-disable-next-line @typescript-eslint/require-await -- async generator
        async *[Symbol.asyncIterator]() {
          yield { type: 'content_block_delta', delta: { type: 'text_delta', text: line } };
        },
      }),
    },
  };
}

interface Harness {
  readonly ws: FakeSocket;
  readonly session: CallSession;
  readonly outcomes: CallOutcome[];
  readonly dncCalls: string[];
  readonly transfers: number[];
  readonly synthesized: string[];
  emitFinal: (text: string) => void;
}

function harness(over: Partial<CallSessionDeps> = {}): Harness {
  const ws = new FakeSocket();
  const outcomes: CallOutcome[] = [];
  const dncCalls: string[] = [];
  const transfers: number[] = [];
  const synthesized: string[] = [];
  let finalHandler: (text: string) => void = () => undefined;

  const deps: CallSessionDeps = {
    anthropic: fakeAnthropic() as never,
    authorization: AUTHORIZATION,
    line: 'auto',
    agencyName: 'Ruiz Family Insurance LLC',
    producerName: 'Danny',
    contactSummary: 'Dana Ruiz, auto policyholder',
    createTranscription: () => ({
      send: () => undefined,
      onFinal: (h) => {
        finalHandler = h;
      },
      onInterim: () => undefined,
      close: () => undefined,
    }),
    synthesis: {
      // eslint-disable-next-line @typescript-eslint/require-await -- async generator
      synthesize: async function* (text: string) {
        synthesized.push(text);
        // One frame of silence is enough; the audio path is tested elsewhere.
        yield new Uint8Array(BYTES_PER_MULAW_FRAME * 2);
      },
    },
    onComplete: (outcome) => {
      outcomes.push(outcome);
    },
    onDncRequested: (phone) => {
      dncCalls.push(phone);
    },
    onTransferRequested: () => {
      transfers.push(Date.now());
    },
    ...over,
  };

  const session = new CallSession(ws as never, deps);
  session.attach();

  return {
    ws,
    session,
    outcomes,
    dncCalls,
    transfers,
    synthesized,
    emitFinal: (text) => finalHandler(text),
  };
}

beforeEach(() => {
  // Every session here runs without an API key, so the model path logs its
  // fallback. That is the behaviour under test, not a problem to read about.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

function startEvent() {
  return { event: 'start', start: { streamSid: 'MZ123', callSid: 'CA123' } };
}

/** Wait until the disclosure and the first model turn have both been spoken. */
async function settle(h: Harness): Promise<void> {
  await vi.waitFor(() => expect(h.synthesized).toContain(AGENT_LINE));
}

/** `count` frames of pure silence, base64 μ-law, as Twilio sends them. */
function silenceFrame(): { event: string; media: { payload: string } } {
  return {
    event: 'media',
    media: { payload: pcm16ToMulaw(Buffer.alloc(BYTES_PER_MULAW_FRAME * 2)).toString('base64') },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('frame decoding', () => {
  it('reads a fragmented message, which is what Twilio sends under load', async () => {
    const h = harness();
    h.ws.deliverFragmented(startEvent());
    await vi.waitFor(() => expect(h.synthesized.length).toBeGreaterThan(0));

    // The disclosure being spoken proves the `start` event survived arriving as
    // Buffer[]. Before the fix this JSON.parse'd to garbage and was dropped.
    expect(h.synthesized[0]).toContain('not a human');
  });

  it('ignores a frame that is not JSON rather than tearing down the call', async () => {
    const h = harness();
    h.ws.emit('message', Buffer.from('<html>proxy error</html>', 'utf-8'));
    await Promise.resolve();

    expect(h.outcomes).toHaveLength(0);
    expect(h.ws.closed).toBe(false);
  });

  it('ignores an event kind it does not know', async () => {
    const h = harness();
    h.ws.deliver({ event: 'connected', protocol: 'Call', version: '1.0.0' });
    await Promise.resolve();

    expect(h.outcomes).toHaveLength(0);
  });
});

describe('the disclosure is spoken before the model gets a turn', () => {
  it('speaks the authorization’s disclosure text verbatim, first', async () => {
    const h = harness();
    h.ws.deliver(startEvent());
    await vi.waitFor(() => expect(h.synthesized.length).toBeGreaterThan(0));

    expect(h.synthesized[0]).toBe(AUTHORIZATION.requiredDisclosure);
  });

  it('records when it was disclosed, for the audit trail', async () => {
    const h = harness();
    h.ws.deliver(startEvent());
    await settle(h);

    h.ws.deliver({ event: 'stop' });
    await vi.waitFor(() => expect(h.outcomes).toHaveLength(1));

    expect(h.outcomes[0]?.aiDisclosedAt).toBeInstanceOf(Date);
  });

  it('records nothing when the call ends before the disclosure finished', async () => {
    const h = harness();
    h.ws.deliver(startEvent());
    // Ends while the disclosure is still being synthesized.
    h.ws.deliver({ event: 'stop' });
    await vi.waitFor(() => expect(h.outcomes).toHaveLength(1));

    // A timestamp here would assert that someone heard a disclosure they did
    // not hear. The audit record is only worth having if it is true, and "we
    // do not know that they heard it" is the honest answer.
    expect(h.outcomes[0]?.aiDisclosedAt).toBeNull();
  });
});

describe('a removal request is honoured in-turn', () => {
  it('calls onDncRequested with the number and ends the call', async () => {
    const h = harness();
    h.ws.deliver(startEvent());
    await vi.waitFor(() => expect(h.synthesized.length).toBeGreaterThan(0));

    h.emitFinal('take me off your list');
    await vi.waitFor(() => expect(h.outcomes).toHaveLength(1));

    expect(h.dncCalls).toEqual(['+14155550123']);
    expect(h.outcomes[0]?.disposition).toBe('do_not_call_requested');
    expect(h.outcomes[0]?.finalState).toBe('HONORING_DNC');
  });

  it('does not hand the utterance to the model first', async () => {
    // The interrupt runs on the raw transcript. If the model were consulted,
    // the anthropic stub below would have been reached and thrown.
    const h = harness({
      anthropic: {
        messages: {
          stream: () => {
            throw new Error('the model must not be invoked on a DNC request');
          },
        },
      } as never,
    });
    h.ws.deliver(startEvent());
    await vi.waitFor(() => expect(h.synthesized.length).toBeGreaterThan(0));

    h.emitFinal('stop calling me');
    await vi.waitFor(() => expect(h.outcomes).toHaveLength(1));

    expect(h.dncCalls).toHaveLength(1);
  });
});

describe('a request for a human transfers', () => {
  it('calls onTransferRequested and ends', async () => {
    const h = harness();
    h.ws.deliver(startEvent());
    await vi.waitFor(() => expect(h.synthesized.length).toBeGreaterThan(0));

    h.emitFinal('can I talk to a real person');
    await vi.waitFor(() => expect(h.outcomes).toHaveLength(1));

    expect(h.transfers).toHaveLength(1);
    expect(h.dncCalls).toHaveLength(0);
    expect(h.outcomes[0]?.finalState).toBe('TRANSFERRING');
  });
});

describe('the interrupt latch', () => {
  it('handles the silence timeout once, not once per frame', async () => {
    const h = harness();
    h.ws.deliver(startEvent());
    await settle(h);

    const before = h.synthesized.length;

    // 12 seconds of silence is 600 frames at 20ms. Feed 900 — well past the
    // threshold — the way a dead line actually arrives.
    for (let i = 0; i < 900; i += 1) h.ws.deliver(silenceFrame());
    await vi.waitFor(() => expect(h.outcomes.length).toBeGreaterThan(0));

    // Exactly one goodbye, not one per frame past the threshold.
    const goodbyes = h.synthesized.slice(before).filter((s) => s.includes('disconnected'));
    expect(goodbyes).toHaveLength(1);
    expect(h.outcomes).toHaveLength(1);
  });

  it('does not hang up on someone who waited politely through a long turn', async () => {
    const h = harness();
    h.ws.deliver(startEvent());
    await settle(h);

    // Silence accumulated while the agent was speaking is not the prospect
    // failing to answer — they cannot answer over us. If it counted, a turn
    // longer than the threshold would hang up on the first frame after we
    // stopped talking, which is the moment they are about to reply.
    for (let i = 0; i < 400; i += 1) h.ws.deliver(silenceFrame());
    expect(h.outcomes).toHaveLength(0);

    h.emitFinal('yeah I am still here');
    for (let i = 0; i < 100; i += 1) h.ws.deliver(silenceFrame());

    expect(h.outcomes).toHaveLength(0);
  });

  it('fires onDncRequested exactly once even if more utterances arrive', async () => {
    const h = harness();
    h.ws.deliver(startEvent());
    await vi.waitFor(() => expect(h.synthesized.length).toBeGreaterThan(0));

    h.emitFinal('take me off your list');
    h.emitFinal('I said take me off your list');
    h.emitFinal('stop calling me');
    await vi.waitFor(() => expect(h.outcomes).toHaveLength(1));

    // A duplicate write to the suppression ledger is not harmless: it is a
    // second audit row claiming a second request that never happened.
    expect(h.dncCalls).toHaveLength(1);
  });
});

describe('a model outage hands off rather than retrying', () => {
  it('speaks the safe line, gets a human, and ends', async () => {
    const h = harness({
      anthropic: {
        messages: {
          stream: () => {
            throw new Error('503 from the model');
          },
        },
      } as never,
    });
    h.ws.deliver(startEvent());
    await vi.waitFor(() => expect(h.outcomes).toHaveLength(1));

    // Two failed generations on a live call is a signal to get a person on the
    // phone, not to roll the dice a third time.
    expect(h.synthesized).toContain(SAFE_FALLBACK_LINE);
    expect(h.transfers).toHaveLength(1);
  });
});

describe('finish is idempotent', () => {
  it('reports the outcome once no matter how the call ends', async () => {
    const h = harness();
    h.ws.deliver(startEvent());
    await vi.waitFor(() => expect(h.synthesized.length).toBeGreaterThan(0));

    h.ws.deliver({ event: 'stop' });
    h.ws.emit('close');
    h.ws.emit('error', new Error('socket reset'));
    await vi.waitFor(() => expect(h.outcomes).toHaveLength(1));

    expect(h.outcomes).toHaveLength(1);
  });

  it('closes the socket and reports a duration', async () => {
    const h = harness();
    h.ws.deliver(startEvent());
    await vi.waitFor(() => expect(h.synthesized.length).toBeGreaterThan(0));

    h.ws.deliver({ event: 'stop' });
    await vi.waitFor(() => expect(h.outcomes).toHaveLength(1));

    expect(h.ws.closed).toBe(true);
    expect(h.outcomes[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('what the prospect actually heard', () => {
  it('records a sentence only once Twilio confirms its mark played', async () => {
    const h = harness();
    h.ws.deliver(startEvent());
    await vi.waitFor(() => expect(h.ws.playedMarks().length).toBeGreaterThan(0));

    // Before the mark comes back, nothing is in the transcript as spoken.
    h.ws.deliver({ event: 'stop' });
    await vi.waitFor(() => expect(h.outcomes).toHaveLength(1));

    const rep = h.outcomes[0]?.transcript.filter((t) => t.speaker === 'REP') ?? [];
    expect(rep).toHaveLength(0);
  });

  it('promotes it to the transcript when the mark is echoed', async () => {
    const h = harness();
    h.ws.deliver(startEvent());
    await vi.waitFor(() => expect(h.ws.playedMarks().length).toBeGreaterThan(0));

    const mark = h.ws.playedMarks()[0];
    expect(mark).toBeDefined();
    h.ws.deliver({ event: 'mark', mark: { name: mark } });

    h.ws.deliver({ event: 'stop' });
    await vi.waitFor(() => expect(h.outcomes).toHaveLength(1));

    const rep = h.outcomes[0]?.transcript.filter((t) => t.speaker === 'REP') ?? [];
    expect(rep.map((t) => t.text)).toContain(AUTHORIZATION.requiredDisclosure);
  });

  it('ignores a mark it never sent', async () => {
    const h = harness();
    h.ws.deliver(startEvent());
    await vi.waitFor(() => expect(h.ws.playedMarks().length).toBeGreaterThan(0));

    h.ws.deliver({ event: 'mark', mark: { name: 'not-ours' } });
    h.ws.deliver({ event: 'stop' });
    await vi.waitFor(() => expect(h.outcomes).toHaveLength(1));

    const rep = h.outcomes[0]?.transcript.filter((t) => t.speaker === 'REP') ?? [];
    expect(rep).toHaveLength(0);
  });
});

describe('audio actually sent to Twilio', () => {
  it('is base64 μ-law carrying the stream sid', async () => {
    const h = harness();
    h.ws.deliver(startEvent());
    await vi.waitFor(() => expect(h.ws.sent.some((m) => m['event'] === 'media')).toBe(true));

    const media = h.ws.sent.find((m) => m['event'] === 'media');
    expect(media?.['streamSid']).toBe('MZ123');

    const payload = (media?.['media'] as { payload: string }).payload;
    const decoded = Buffer.from(payload, 'base64');
    // μ-law is one byte per sample; round-tripping must not change the length.
    expect(mulawToPcm16(decoded).length).toBe(decoded.length * 2);
  });
});
