/**
 * Telephony configuration and webhook authentication.
 *
 * Two things are worth locking down here, and neither is about Twilio's API.
 *
 * The first is which way the dry-run default falls. `loadTwilioConfig` reads a
 * single env var to decide whether calls reach real people, and a bug in that
 * one line is the difference between "placed no calls" and "placed calls it
 * should not have". So the tests below are mostly about what happens when the
 * environment is *wrong* — empty, misspelled, half-configured.
 *
 * The second is the shared-secret comparison. It is the only thing standing
 * between the internet and a live call, and a correct-looking `!==` would pass
 * every functional test while leaking the secret through timing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadTwilioConfig,
  secretMatches,
  validateWebhook,
  shouldContinueAfterAmd,
  buildStreamTwiml,
  buildTransferTwiml,
  buildHangupTwiml,
  type AmdResult,
} from './twilio';

const KEYS = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_CALLER_ID',
  'PUBLIC_BASE_URL',
  'TWILIO_WEBHOOK_SECRET',
  'DANNY_DRY_RUN',
] as const;

/** Every test starts from an environment with none of these set. */
beforeEach(() => {
  for (const key of KEYS) vi.stubEnv(key, '');
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function setLiveCredentials(): void {
  vi.stubEnv('TWILIO_ACCOUNT_SID', 'ACreal');
  vi.stubEnv('TWILIO_AUTH_TOKEN', 'token-real');
  vi.stubEnv('TWILIO_CALLER_ID', '+15105550100');
  vi.stubEnv('PUBLIC_BASE_URL', 'https://danny.example.com');
  vi.stubEnv('TWILIO_WEBHOOK_SECRET', 's3cret');
}

describe('dry run is the default, and the default is the safe one', () => {
  it('stays in dry run when DANNY_DRY_RUN is unset', () => {
    expect(loadTwilioConfig().dryRun).toBe(true);
  });

  it('stays in dry run for every value except the literal "false"', () => {
    // A typo must not be the thing that starts dialing strangers.
    for (const value of ['true', 'TRUE', 'False', 'FALSE', '0', '1', 'no', 'yes', ' false']) {
      vi.stubEnv('DANNY_DRY_RUN', value);
      expect(loadTwilioConfig().dryRun, `DANNY_DRY_RUN=${value}`).toBe(true);
    }
  });

  it('goes live only on exactly "false"', () => {
    setLiveCredentials();
    vi.stubEnv('DANNY_DRY_RUN', 'false');
    expect(loadTwilioConfig().dryRun).toBe(false);
  });
});

describe('credentials are required to dial and optional to pretend', () => {
  it('substitutes obvious placeholders in dry run rather than refusing to start', () => {
    const config = loadTwilioConfig();

    expect(config.dryRun).toBe(true);
    expect(config.accountSid).toBe('DRYRUN_TWILIO_ACCOUNT_SID');
    expect(config.webhookSecret).toBe('DRYRUN_TWILIO_WEBHOOK_SECRET');
  });

  it('says out loud which values it made up', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    loadTwilioConfig();

    const message = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(message).toContain('DRY RUN');
    expect(message).toContain('TWILIO_ACCOUNT_SID');
    // A placeholder nobody notices is how you ship a system that silently
    // places no calls for a week.
    expect(message).toContain('No call will reach the PSTN');
  });

  it('keeps real values when they are present, even in dry run', () => {
    setLiveCredentials();
    const config = loadTwilioConfig();

    expect(config.dryRun).toBe(true);
    expect(config.accountSid).toBe('ACreal');
    expect(config.callerId).toBe('+15105550100');
  });

  it('refuses to load live without every credential', () => {
    vi.stubEnv('DANNY_DRY_RUN', 'false');
    vi.stubEnv('TWILIO_ACCOUNT_SID', 'ACreal');

    expect(() => loadTwilioConfig()).toThrow(/TWILIO_AUTH_TOKEN is required/);
  });

  it('names the first missing credential, not a generic failure', () => {
    setLiveCredentials();
    vi.stubEnv('DANNY_DRY_RUN', 'false');
    vi.stubEnv('TWILIO_WEBHOOK_SECRET', '');

    expect(() => loadTwilioConfig()).toThrow(/TWILIO_WEBHOOK_SECRET/);
  });
});

describe('the shared secret is compared in constant time', () => {
  it('accepts an exact match', () => {
    expect(secretMatches('s3cret', 's3cret')).toBe(true);
  });

  it('rejects a near miss, a prefix, and an extension', () => {
    expect(secretMatches('s3crea', 's3cret')).toBe(false);
    expect(secretMatches('s3cre', 's3cret')).toBe(false);
    expect(secretMatches('s3cret0', 's3cret')).toBe(false);
  });

  it('rejects a missing parameter without throwing', () => {
    // `new URL(...).searchParams.get()` returns null, and timingSafeEqual
    // throws on a length mismatch — so the null has to be handled before it.
    expect(secretMatches(null, 's3cret')).toBe(false);
    expect(secretMatches('', 's3cret')).toBe(false);
  });

  it('rejects an unconfigured secret rather than accepting anything', () => {
    expect(secretMatches('anything', '')).toBe(false);
    // The dangerous case: two empty buffers compare equal, so an unconfigured
    // secret would otherwise authenticate a request that simply omits it.
    expect(secretMatches('', '')).toBe(false);
    expect(secretMatches(null, '')).toBe(false);
  });

  it('handles non-ASCII without a length-in-bytes mismatch crash', () => {
    expect(secretMatches('café', 'café')).toBe(true);
    expect(secretMatches('café', 'cafe')).toBe(false);
  });
});

describe('webhook validation needs both factors', () => {
  const config = {
    accountSid: 'ACtest',
    authToken: 'token',
    callerId: '+15105550100',
    publicBaseUrl: 'https://danny.test',
    webhookSecret: 's3cret',
    dryRun: true,
  } as const;

  it('rejects a wrong shared secret before it ever checks the signature', () => {
    const verdict = validateWebhook({
      signature: 'anything',
      url: 'https://danny.test/api/twilio/status?s=wrong',
      params: {},
      config,
    });

    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toBe('shared secret mismatch');
  });

  it('rejects a missing secret', () => {
    const verdict = validateWebhook({
      signature: 'anything',
      url: 'https://danny.test/api/twilio/status',
      params: {},
      config,
    });

    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toBe('shared secret mismatch');
  });

  it('rejects a correct secret with no signature — a leaked URL is not enough', () => {
    const verdict = validateWebhook({
      signature: null,
      url: 'https://danny.test/api/twilio/status?s=s3cret',
      params: {},
      config,
    });

    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toBe('missing X-Twilio-Signature');
  });

  it('rejects a correct secret with a forged signature', () => {
    const verdict = validateWebhook({
      signature: 'not-a-real-signature',
      url: 'https://danny.test/api/twilio/status?s=s3cret',
      params: { CallSid: 'CA1' },
      config,
    });

    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toBe('signature mismatch');
  });
});

describe('the stream TwiML is the bidirectional form', () => {
  const config = {
    accountSid: 'ACtest',
    authToken: 'token',
    callerId: '+15105550100',
    publicBaseUrl: 'https://danny.test/',
    webhookSecret: 's3cret',
    dryRun: true,
  } as const;

  it('uses <Connect>, not <Start> — <Start> forks audio with no way to speak back', () => {
    const twiml = buildStreamTwiml({ callRecordId: 'call_1', config });

    expect(twiml).toContain('<Connect>');
    expect(twiml).not.toContain('<Start>');
  });

  it('upgrades the scheme to wss and does not double the slash', () => {
    const twiml = buildStreamTwiml({ callRecordId: 'call_1', config });

    expect(twiml).toContain('wss://danny.test/media');
    expect(twiml).not.toContain('danny.test//media');
    expect(twiml).not.toContain('https://danny.test/media');
  });

  it('carries the call id both in the query and as a stream parameter', () => {
    const twiml = buildStreamTwiml({ callRecordId: 'call_1', config });

    expect(twiml).toContain('call=call_1');
    expect(twiml).toContain('callRecordId');
  });
});

describe('transfer and hangup', () => {
  it('dials the producer from the original caller id, so their phone shows the prospect', () => {
    const twiml = buildTransferTwiml({
      producerPhoneE164: '+15105550111',
      callerId: '+14155550123',
    });

    expect(twiml).toContain('callerId="+14155550123"');
    expect(twiml).toContain('+15105550111');
    // Silence on a transfer reads as a dropped call.
    expect(twiml).toContain('<Say');
  });

  it('hangs up with nothing else attached', () => {
    expect(buildHangupTwiml()).toContain('<Hangup');
  });
});

describe('answering-machine detection continues only for a human', () => {
  it('continues for a human', () => {
    expect(shouldContinueAfterAmd('human')).toBe(true);
  });

  it('hangs up on every machine outcome, on a fax, and on unknown', () => {
    const rest: AmdResult[] = [
      'machine_start',
      'machine_end_beep',
      'machine_end_silence',
      'machine_end_other',
      'fax',
      'unknown',
    ];

    // Leaving an AI voicemail is a separate legal question, and "unknown"
    // failing open would answer it by accident.
    for (const result of rest) {
      expect(shouldContinueAfterAmd(result), result).toBe(false);
    }
  });
});
