/**
 * Twilio telephony.
 *
 * The load-bearing line in this file is the signature of `placeCall`: it takes a
 * `DialAuthorization` and there is no other way to originate a call. Because
 * `DialAuthorization` carries a `unique symbol` brand, it cannot be constructed
 * anywhere except `evaluateGate()`. "Dial without checking" is therefore a
 * compile error rather than a code-review comment — which is the whole point of
 * the branded type in `src/types/index.ts`.
 *
 * Everything else here is the boring, necessary telephony:
 *   - webhook signature validation (an unvalidated webhook lets anyone drive
 *     your dialer),
 *   - TwiML that opens a bidirectional media stream,
 *   - answering-machine detection, because leaving an AI voicemail is a
 *     separate legal question we have not answered yes to,
 *   - a dry-run sink so nothing reaches the PSTN in dev or CI.
 */

import twilio from 'twilio';
import { timingSafeEqual } from 'node:crypto';
import { isAuthorizationFresh } from '@/compliance/gate';
import type { DialAuthorization } from '@/types';

/**
 * Compare a presented secret against the expected one without leaking its
 * contents through timing.
 *
 * `a !== b` on strings returns at the first differing byte, so how long a
 * rejection takes is a function of how many leading bytes were right. Over a
 * network that signal is noisy, but it is recoverable with enough samples, and
 * what it buys an attacker is the ability to drive the dialer or to open a
 * media stream on a live call — to hear one side of it and inject audio into
 * the other. The correct comparison costs one line.
 *
 * The length check is not itself a leak: the secret's length is not the secret,
 * and `timingSafeEqual` throws outright on mismatched buffer lengths.
 */
export function secretMatches(presented: string | null, expected: string): boolean {
  // An empty expected secret means "unconfigured", and two empty buffers compare
  // equal — so without this line, a blank `TWILIO_WEBHOOK_SECRET` would
  // authenticate any request that simply omits the value. `loadTwilioConfig`
  // already refuses to produce one, but `startMediaServer` takes the secret
  // directly and this is the wrong place to rely on a caller.
  if (expected === '') return false;
  if (presented === null) return false;
  const a = Buffer.from(presented, 'utf-8');
  const b = Buffer.from(expected, 'utf-8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface TwilioConfig {
  readonly accountSid: string;
  readonly authToken: string;
  readonly callerId: string;
  readonly publicBaseUrl: string;
  readonly webhookSecret: string;
  /** When true, no call reaches the PSTN. CI and local dev run this way. */
  readonly dryRun: boolean;
}

/**
 * Read telephony credentials from the environment.
 *
 * Two modes, and the asymmetry between them is deliberate:
 *
 *  - **Live** (`DANNY_DRY_RUN=false`) — every value is required. A call that
 *    reaches a real person must be signed by a real account, from a real caller
 *    id, with a real webhook secret.
 *  - **Dry run** (anything else, including unset) — missing values are filled
 *    with obvious placeholders and the substitution is logged. Nothing reaches
 *    the PSTN in this mode, so requiring a Twilio account to run the media
 *    server locally or in CI buys no safety and costs everyone a signup.
 *
 * Note which way the default falls. Dry run is on unless explicitly turned off,
 * so the failure mode of a forgotten env var is "placed no calls", never
 * "placed calls with a placeholder". Production must say `false` out loud.
 */
export function loadTwilioConfig(): TwilioConfig {
  // Fail *safe*: anything other than an explicit "false" keeps dry run on.
  // A missing env var must not be the thing that starts dialing strangers.
  const dryRun = process.env['DANNY_DRY_RUN'] !== 'false';
  const substituted: string[] = [];

  const required = (name: string): string => {
    const value = process.env[name];
    if (value) return value;
    if (!dryRun) throw new Error(`${name} is required for telephony.`);
    substituted.push(name);
    return `DRYRUN_${name}`;
  };

  const config: TwilioConfig = {
    accountSid: required('TWILIO_ACCOUNT_SID'),
    authToken: required('TWILIO_AUTH_TOKEN'),
    callerId: required('TWILIO_CALLER_ID'),
    publicBaseUrl: required('PUBLIC_BASE_URL'),
    webhookSecret: required('TWILIO_WEBHOOK_SECRET'),
    dryRun,
  };

  if (substituted.length > 0) {
    console.warn(
      `[twilio] DRY RUN — placeholder values for ${substituted.join(', ')}. ` +
        `No call will reach the PSTN. Set DANNY_DRY_RUN=false with real ` +
        `credentials to dial.`,
    );
  }

  return config;
}

export class AuthorizationStaleError extends Error {
  constructor(auth: DialAuthorization) {
    super(
      `Dial authorization for ${auth.phoneE164} expired at ` +
        `${auth.expiresAt.toISOString()}. Re-evaluate the gate — do not retry. ` +
        `DNC status and local calling hours both move.`,
    );
    this.name = 'AuthorizationStaleError';
  }
}

export interface PlacedCall {
  readonly providerSid: string;
  readonly dryRun: boolean;
}

/**
 * Originate an outbound call.
 *
 * The only way to call this is to hold a `DialAuthorization`, and the only way
 * to hold one is to have passed `evaluateGate()` within the last 60 seconds.
 */
export async function placeCall(input: {
  readonly authorization: DialAuthorization;
  readonly config: TwilioConfig;
  readonly callRecordId: string;
  readonly now?: Date;
}): Promise<PlacedCall> {
  const { authorization, config, callRecordId } = input;
  const now = input.now ?? new Date();

  // Freshness is re-checked here and not only at the call site: an
  // authorization that sat in a queue for ten minutes is not an authorization.
  if (!isAuthorizationFresh(authorization, now)) {
    throw new AuthorizationStaleError(authorization);
  }

  if (config.dryRun) {
    return { providerSid: `DRYRUN_${callRecordId}`, dryRun: true };
  }

  const client = twilio(config.accountSid, config.authToken);
  const base = config.publicBaseUrl.replace(/\/+$/, '');

  const call = await client.calls.create({
    to: authorization.phoneE164,
    from: config.callerId,
    url: `${base}/api/twilio/voice?call=${callRecordId}&s=${config.webhookSecret}`,
    statusCallback: `${base}/api/twilio/status?call=${callRecordId}&s=${config.webhookSecret}`,
    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    // Answering-machine detection. We do NOT leave an AI voicemail: a
    // prerecorded artificial-voice message to a wireless number is squarely
    // within 227(b) and the consent analysis for a voicemail drop is different
    // from the one for a live conversation. On machine detection we hang up.
    machineDetection: 'DetectMessageEnd',
    machineDetectionTimeout: 5,
    asyncAmd: 'true',
    asyncAmdStatusCallback: `${base}/api/twilio/amd?call=${callRecordId}&s=${config.webhookSecret}`,
    // Do not let a call ring forever; an unanswered dial should free the slot.
    timeout: 25,
    record: true,
    recordingStatusCallback: `${base}/api/twilio/recording?call=${callRecordId}&s=${config.webhookSecret}`,
  });

  return { providerSid: call.sid, dryRun: false };
}

/**
 * Validate an inbound Twilio webhook.
 *
 * Two independent checks, because each covers a different failure. The
 * signature proves Twilio sent it. The shared secret in the query string means
 * a leaked URL from a log or a bug report is not by itself replayable against a
 * different account. Both must pass.
 */
export function validateWebhook(input: {
  readonly signature: string | null;
  readonly url: string;
  readonly params: Record<string, string>;
  readonly config: TwilioConfig;
}): { readonly valid: boolean; readonly reason?: string } {
  const { signature, url, params, config } = input;

  const providedSecret = new URL(url).searchParams.get('s');
  if (!secretMatches(providedSecret, config.webhookSecret)) {
    return { valid: false, reason: 'shared secret mismatch' };
  }

  if (!signature) {
    return { valid: false, reason: 'missing X-Twilio-Signature' };
  }

  const ok = twilio.validateRequest(config.authToken, signature, url, params);
  return ok ? { valid: true } : { valid: false, reason: 'signature mismatch' };
}

/**
 * TwiML that opens a bidirectional media stream to our WebSocket server.
 *
 * `<Connect><Stream>` is the bidirectional form — `<Start><Stream>` only forks
 * audio to you and gives no way to speak back, which is a subtle and
 * frustrating thing to discover after wiring the whole loop.
 */
export function buildStreamTwiml(input: {
  readonly callRecordId: string;
  readonly config: TwilioConfig;
}): string {
  const wsBase = input.config.publicBaseUrl
    .replace(/^https:/, 'wss:')
    .replace(/^http:/, 'ws:')
    .replace(/\/+$/, '');

  const response = new twilio.twiml.VoiceResponse();
  const connect = response.connect();
  const stream = connect.stream({
    url: `${wsBase}/media?call=${input.callRecordId}&s=${input.config.webhookSecret}`,
  });
  // Custom parameters ride along in the WebSocket "start" event, so the media
  // server knows which call it is handling without a database round trip
  // before the first packet.
  stream.parameter({ name: 'callRecordId', value: input.callRecordId });

  return response.toString();
}

/** Hang up politely. Used on answering-machine detection and on DNC requests. */
export function buildHangupTwiml(): string {
  const response = new twilio.twiml.VoiceResponse();
  response.hangup();
  return response.toString();
}

/**
 * Warm transfer to a licensed human.
 *
 * `<Dial>` with the original caller ID so the producer's phone shows the
 * prospect, not our DID. The prospect hears a brief hold message rather than
 * silence, because silence on a transfer reads as a dropped call.
 */
export function buildTransferTwiml(input: {
  readonly producerPhoneE164: string;
  readonly callerId: string;
}): string {
  const response = new twilio.twiml.VoiceResponse();
  response.say(
    { voice: 'Polly.Joanna' },
    'Connecting you now. One moment.',
  );
  const dial = response.dial({
    callerId: input.callerId,
    timeout: 25,
    answerOnBridge: true,
  });
  dial.number(input.producerPhoneE164);
  return response.toString();
}

/**
 * End a call in progress.
 *
 * Used on answering-machine detection, where continuing would leave an AI
 * voicemail, and as the backstop when the media server needs the leg torn down
 * from outside its own socket.
 */
export async function hangUpCall(input: {
  readonly providerSid: string;
  readonly config: TwilioConfig;
}): Promise<void> {
  if (input.config.dryRun || input.providerSid.startsWith('DRYRUN_')) return;

  const client = twilio(input.config.accountSid, input.config.authToken);
  await client.calls(input.providerSid).update({ status: 'completed' });
}

/**
 * Twilio's answering-machine detection outcomes. `human` is the only one that
 * continues; everything else hangs up.
 */
export type AmdResult =
  | 'human'
  | 'machine_start'
  | 'machine_end_beep'
  | 'machine_end_silence'
  | 'machine_end_other'
  | 'fax'
  | 'unknown';

export function shouldContinueAfterAmd(result: AmdResult): boolean {
  return result === 'human';
}
