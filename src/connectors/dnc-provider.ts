/**
 * Production DNC provider.
 *
 * The counterpart to `permissiveTestProvider` in `src/compliance/dnc.ts`, which
 * reports every number as unlisted and exists only so tests and dry runs can
 * exercise the gate without credentials.
 *
 * ── The one rule that governs this file ─────────────────────────────────────
 * **Fail closed.** If a scrub cannot be completed — no credentials, network
 * down, vendor 500, timeout — this provider reports the number as LISTED.
 *
 * That is deliberately the opposite of what most integrations do. The reflex is
 * to treat an unreachable dependency as "no signal, carry on", and here that
 * reflex dials a number on the federal registry and costs $500 to $1,500. A
 * failed scrub that blocks a legitimate call costs one call. The asymmetry is
 * not close, so the failure mode is chosen rather than inherited.
 *
 * `NEVER_AI_DIALABLE_SOURCES` in `registry.ts` is a separate control and this
 * one does not replace it: a scrub tells you whether a number is listed, not
 * whether you have consent to use an artificial voice on it.
 */

import type { DncProvider, ScrubVerdict } from '@/compliance/dnc';

const FEDERAL_ENDPOINT = 'https://telemarketing.donotcall.gov/api/v1/check';
const SCRUB_TIMEOUT_MS = 4_000;

export interface DncProviderConfig {
  /** Subscription Account Number from the National DNC Registry. */
  readonly federalSan: string;
  readonly federalOrgId: string;
  /** Commercial serial-plaintiff list. Optional but strongly advised. */
  readonly litigatorApiKey: string | null;
  readonly litigatorEndpoint: string | null;
  /**
   * When true, a scrub that cannot be completed reports LISTED rather than
   * throwing. Always true in production; the flag exists so a test can assert
   * the fail-closed behaviour rather than assuming it.
   */
  readonly failClosed: boolean;
}

export function loadDncConfig(): DncProviderConfig {
  const federalSan = process.env['DNC_SAN'];
  const federalOrgId = process.env['DNC_ORG_ID'];

  if (!federalSan || !federalOrgId) {
    throw new Error(
      'DNC_SAN and DNC_ORG_ID are required to dial. Subscribe to the National ' +
        'Do Not Call Registry at telemarketing.donotcall.gov — it is a paid ' +
        'subscription and takes days to activate, so start it before you need it. ' +
        'For local development set DANNY_DRY_RUN=true and the test provider is used.',
    );
  }

  return {
    federalSan,
    federalOrgId,
    litigatorApiKey: process.env['LITIGATOR_SCRUB_API_KEY'] ?? null,
    litigatorEndpoint: process.env['LITIGATOR_SCRUB_PROVIDER'] ?? null,
    failClosed: true,
  };
}

/** A scrub that could not be completed. Carries why, for the audit record. */
function unavailable(list: ScrubVerdict['list'], reason: string, failClosed: boolean): ScrubVerdict {
  return {
    list,
    // Fail closed: unreachable means listed.
    listed: failClosed,
    checkedAt: new Date(),
    detail: `SCRUB UNAVAILABLE (${reason}) — reported as ${failClosed ? 'LISTED' : 'unlisted'}`,
  };
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCRUB_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * State registries.
 *
 * Most states retired their own list once the federal registry absorbed them.
 * The handful below still maintain one, and each has its own access process —
 * there is no unified API, so this is a per-state integration you complete as
 * you license into that state.
 *
 * Until a state is wired, dialing into it fails closed rather than silently
 * skipping its registry.
 */
const STATES_WITH_OWN_REGISTRY: ReadonlySet<string> = new Set([
  'CO', 'FL', 'IN', 'LA', 'MO', 'MS', 'OK', 'PA', 'TN', 'TX', 'WY',
]);

/** States whose registry this deployment has actually integrated. */
function integratedStates(): ReadonlySet<string> {
  return new Set(
    (process.env['DNC_STATE_REGISTRIES_INTEGRATED'] ?? '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  );
}

export function createDncProvider(config: DncProviderConfig): DncProvider {
  return {
    async checkFederal(phoneE164: string): Promise<ScrubVerdict> {
      const digits = phoneE164.replace(/\D/g, '').replace(/^1/, '');
      try {
        const response = await fetchWithTimeout(
          `${FEDERAL_ENDPOINT}?san=${encodeURIComponent(config.federalSan)}` +
            `&org=${encodeURIComponent(config.federalOrgId)}&phone=${digits}`,
          { headers: { Accept: 'application/json' } },
        );

        if (!response.ok) {
          return unavailable('federal', `HTTP ${response.status}`, config.failClosed);
        }

        const payload = (await response.json()) as { listed?: boolean; onRegistry?: boolean };
        // Vendors disagree on the field name; accept either, and treat a
        // response carrying neither as unusable rather than as "not listed".
        const listed = payload.listed ?? payload.onRegistry;
        if (typeof listed !== 'boolean') {
          return unavailable('federal', 'unrecognized response shape', config.failClosed);
        }

        return { list: 'federal', listed, checkedAt: new Date() };
      } catch (err) {
        const reason = err instanceof Error && err.name === 'AbortError' ? 'timeout' : String(err);
        return unavailable('federal', reason, config.failClosed);
      }
    },

    async checkState(_phoneE164: string, stateCode: string | null): Promise<ScrubVerdict> {
      if (!stateCode) {
        return unavailable('state', 'contact state unknown', config.failClosed);
      }

      const state = stateCode.toUpperCase();
      if (!STATES_WITH_OWN_REGISTRY.has(state)) {
        // No separate registry to check — the federal scrub covers this state.
        return {
          list: 'state',
          listed: false,
          checkedAt: new Date(),
          detail: `${state} maintains no separate registry; federal scrub governs.`,
        };
      }

      if (!integratedStates().has(state)) {
        return unavailable(
          'state',
          `${state} runs its own registry and this deployment has not integrated it. ` +
            `Complete that integration, then add ${state} to DNC_STATE_REGISTRIES_INTEGRATED`,
          config.failClosed,
        );
      }

      // Each integrated state's lookup goes here as it is completed. Reaching
      // this line means a state was declared integrated but has no implementation.
      return unavailable('state', `${state} declared integrated but unimplemented`, config.failClosed);
    },

    async checkLitigator(phoneE164: string): Promise<ScrubVerdict> {
      if (!config.litigatorApiKey || !config.litigatorEndpoint) {
        // Not a legal requirement, so its absence does not block a dial — but
        // it is recorded, because "we had no litigator scrub" is a fact you
        // want in the audit trail rather than an absence you infer later.
        return {
          list: 'litigator',
          listed: false,
          checkedAt: new Date(),
          detail: 'No litigator scrub configured. Optional, and strongly advised.',
        };
      }

      try {
        const response = await fetchWithTimeout(config.litigatorEndpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.litigatorApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ phone: phoneE164 }),
        });

        if (!response.ok) {
          // A vendor outage on an optional check must not block every call, so
          // this one alone does not fail closed. It is still recorded.
          return {
            list: 'litigator',
            listed: false,
            checkedAt: new Date(),
            detail: `Litigator scrub unavailable (HTTP ${response.status}); optional check skipped.`,
          };
        }

        const payload = (await response.json()) as { listed?: boolean; match?: boolean };
        return {
          list: 'litigator',
          listed: payload.listed ?? payload.match ?? false,
          checkedAt: new Date(),
        };
      } catch (err) {
        return {
          list: 'litigator',
          listed: false,
          checkedAt: new Date(),
          detail: `Litigator scrub error (${String(err)}); optional check skipped.`,
        };
      }
    },
  };
}

/**
 * Pick the right provider for the environment.
 *
 * In dry run there are no credentials and nothing reaches the PSTN, so the test
 * double is correct. Outside dry run, missing credentials throw — the one thing
 * that must never happen is quietly falling back to the permissive provider on
 * a live dial.
 */
export async function resolveDncProvider(): Promise<DncProvider> {
  if (process.env['DANNY_DRY_RUN'] !== 'false') {
    const { permissiveTestProvider } = await import('@/compliance/dnc');
    return permissiveTestProvider;
  }
  return createDncProvider(loadDncConfig());
}
