/**
 * The production DNC provider, and specifically the thing it does differently
 * from every other integration in the repo: it fails **closed**.
 *
 * The reflex when a dependency is unreachable is "no signal, carry on". Here
 * that reflex dials a number on the federal registry, at $500–$1,500 per call
 * with a private right of action. A failed scrub that blocks a legitimate call
 * costs one call. The asymmetry is not close.
 *
 * So these tests are almost entirely about failure: outages, timeouts, garbage
 * responses, unconfigured states. Every one of them must come back LISTED. The
 * single exception is the litigator scrub, which is not a legal requirement and
 * deliberately does not block a dial — that exception is tested too, because an
 * exception nobody wrote down becomes an exception someone copies.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDncProvider, loadDncConfig, resolveDncProvider } from './dnc-provider';
import type { DncProviderConfig } from './dnc-provider';

const CONFIG: DncProviderConfig = {
  federalSan: 'SAN123',
  federalOrgId: 'ORG456',
  litigatorApiKey: null,
  litigatorEndpoint: null,
  failClosed: true,
};

const PHONE = '+14155550123';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  vi.stubEnv('DNC_STATE_REGISTRIES_INTEGRATED', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('the federal scrub fails closed on every kind of failure', () => {
  it('reports LISTED on a vendor 500', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 500 })));

    const verdict = await createDncProvider(CONFIG).checkFederal(PHONE);

    expect(verdict.listed).toBe(true);
    expect(verdict.detail).toContain('SCRUB UNAVAILABLE');
    expect(verdict.detail).toContain('500');
  });

  it('reports LISTED on a 401 — expired credentials must not open the floodgate', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })));

    expect((await createDncProvider(CONFIG).checkFederal(PHONE)).listed).toBe(true);
  });

  it('reports LISTED on a timeout', async () => {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abort));

    const verdict = await createDncProvider(CONFIG).checkFederal(PHONE);

    expect(verdict.listed).toBe(true);
    expect(verdict.detail).toContain('timeout');
  });

  it('reports LISTED when the network is simply down', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

    expect((await createDncProvider(CONFIG).checkFederal(PHONE)).listed).toBe(true);
  });

  it('reports LISTED on a 200 whose body it cannot understand', async () => {
    // The dangerous case. A response with no recognizable field would read as
    // "not listed" under `payload.listed === true`, and a vendor changing a key
    // name would silently turn the scrub off.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ status: 'ok' })));

    const verdict = await createDncProvider(CONFIG).checkFederal(PHONE);

    expect(verdict.listed).toBe(true);
    expect(verdict.detail).toContain('unrecognized response shape');
  });

  it('reports LISTED on a 200 that is not JSON at all', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>maintenance</html>')));

    expect((await createDncProvider(CONFIG).checkFederal(PHONE)).listed).toBe(true);
  });
});

describe('the federal scrub reports what the registry actually said', () => {
  it('passes a clean number through', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ listed: false })));

    const verdict = await createDncProvider(CONFIG).checkFederal(PHONE);

    expect(verdict.listed).toBe(false);
    expect(verdict.list).toBe('federal');
    expect(verdict.detail).toBeUndefined();
  });

  it('blocks a listed number', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ listed: true })));

    expect((await createDncProvider(CONFIG).checkFederal(PHONE)).listed).toBe(true);
  });

  it('accepts either field name vendors use', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ onRegistry: true })));
    expect((await createDncProvider(CONFIG).checkFederal(PHONE)).listed).toBe(true);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ onRegistry: false })));
    expect((await createDncProvider(CONFIG).checkFederal(PHONE)).listed).toBe(false);
  });

  it('sends ten digits, not the E.164 string', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ listed: false }));
    vi.stubGlobal('fetch', fetchMock);

    await createDncProvider(CONFIG).checkFederal(PHONE);

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('phone=4155550123');
    expect(url).not.toContain('%2B');
  });
});

describe('the state scrub', () => {
  it('reports LISTED when the contact state is unknown', async () => {
    // An unknown state means an unknown registry, which means an unchecked one.
    const verdict = await createDncProvider(CONFIG).checkState(PHONE, null);

    expect(verdict.listed).toBe(true);
    expect(verdict.detail).toContain('state unknown');
  });

  it('passes a state that maintains no registry of its own', async () => {
    const verdict = await createDncProvider(CONFIG).checkState(PHONE, 'CA');

    expect(verdict.listed).toBe(false);
    expect(verdict.detail).toContain('no separate registry');
  });

  it('reports LISTED for a state that runs its own registry and is not integrated', async () => {
    for (const state of ['FL', 'TX', 'PA', 'OK']) {
      const verdict = await createDncProvider(CONFIG).checkState(PHONE, state);
      expect(verdict.listed, state).toBe(true);
      expect(verdict.detail, state).toContain('DNC_STATE_REGISTRIES_INTEGRATED');
    }
  });

  it('reports LISTED for a state merely *declared* integrated', async () => {
    // Adding a state to the env var does not implement its lookup. Declaring it
    // and having it silently pass would be the worst of both worlds.
    vi.stubEnv('DNC_STATE_REGISTRIES_INTEGRATED', 'FL');

    const verdict = await createDncProvider(CONFIG).checkState(PHONE, 'FL');

    expect(verdict.listed).toBe(true);
    expect(verdict.detail).toContain('unimplemented');
  });

  it('is case-insensitive about the state code', async () => {
    expect((await createDncProvider(CONFIG).checkState(PHONE, 'ca')).listed).toBe(false);
    expect((await createDncProvider(CONFIG).checkState(PHONE, 'fl')).listed).toBe(true);
  });
});

describe('the litigator scrub is the one check that does not block a dial', () => {
  it('passes, and says so, when none is configured', async () => {
    const verdict = await createDncProvider(CONFIG).checkLitigator(PHONE);

    expect(verdict.listed).toBe(false);
    // Recorded rather than silent: "we had no litigator scrub" is a fact you
    // want in the audit trail, not an absence someone infers two years later.
    expect(verdict.detail).toContain('No litigator scrub configured');
  });

  it('passes on a vendor outage rather than blocking every call', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })));

    const verdict = await createDncProvider({
      ...CONFIG,
      litigatorApiKey: 'key',
      litigatorEndpoint: 'https://scrub.example.com/check',
    }).checkLitigator(PHONE);

    expect(verdict.listed).toBe(false);
    expect(verdict.detail).toContain('503');
  });

  it('blocks a known serial plaintiff', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ listed: true })));

    const verdict = await createDncProvider({
      ...CONFIG,
      litigatorApiKey: 'key',
      litigatorEndpoint: 'https://scrub.example.com/check',
    }).checkLitigator(PHONE);

    expect(verdict.listed).toBe(true);
  });

  it('accepts either field name', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ match: true })));

    const verdict = await createDncProvider({
      ...CONFIG,
      litigatorApiKey: 'key',
      litigatorEndpoint: 'https://scrub.example.com/check',
    }).checkLitigator(PHONE);

    expect(verdict.listed).toBe(true);
  });
});

describe('failClosed: false exists only so the above can be proven', () => {
  it('flips every unavailable verdict, which is why it is never used in production', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 500 })));

    const verdict = await createDncProvider({ ...CONFIG, failClosed: false }).checkFederal(PHONE);

    expect(verdict.listed).toBe(false);
    expect(verdict.detail).toContain('reported as unlisted');
  });

  it('is always true in a config built from the environment', () => {
    vi.stubEnv('DNC_SAN', 'SAN123');
    vi.stubEnv('DNC_ORG_ID', 'ORG456');

    expect(loadDncConfig().failClosed).toBe(true);
  });
});

describe('credentials', () => {
  it('refuses to build a config without a SAN, with a message that says what to do', () => {
    vi.stubEnv('DNC_SAN', '');
    vi.stubEnv('DNC_ORG_ID', 'ORG456');

    expect(() => loadDncConfig()).toThrow(/DNC_SAN and DNC_ORG_ID are required/);
    // The subscription takes days to activate, so the error has to say so —
    // finding out at launch is a week of delay.
    expect(() => loadDncConfig()).toThrow(/takes days to activate/);
  });
});

describe('provider resolution never falls back to the permissive double on a live dial', () => {
  it('uses the test double in dry run', async () => {
    vi.stubEnv('DANNY_DRY_RUN', 'true');

    const provider = await resolveDncProvider();

    expect((await provider.checkFederal(PHONE)).listed).toBe(false);
  });

  it('throws outside dry run when credentials are missing', async () => {
    // The one thing that must never happen: a live dial silently scrubbed by a
    // provider that reports everything as clean.
    vi.stubEnv('DANNY_DRY_RUN', 'false');
    vi.stubEnv('DNC_SAN', '');
    vi.stubEnv('DNC_ORG_ID', '');

    await expect(resolveDncProvider()).rejects.toThrow(/DNC_SAN/);
  });
});
