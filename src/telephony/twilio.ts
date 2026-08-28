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
import { isAuthorizationFresh } from '@/compliance/gate';
import type { DialAuthorization } from '@/types';

export interface TwilioConfig {
  readonly accountSid: string;
  readonly authToken: string;
  readonly callerId: string;
  readonly publicBaseUrl: string;
  readonly webhookSecret: string;
  /** When true, no call reaches the PSTN. CI and local dev run this way. */
  readonly dryRun: boolean;
}

export function loadTwilioConfig(): TwilioConfig {
  const required = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required for telephony.`);
    return value;
  };

  return {
    accountSid: required('TWILIO_ACCOUNT_SID'),
    authToken: required('TWILIO_AUTH_TOKEN'),
    callerId: required('TWILIO_CALLER_ID'),
    publicBaseUrl: required('PUBLIC_BASE_URL'),
    webhookSecret: required('TWILIO_WEBHOOK_SECRET'),
    // Fail *safe*: anything other than an explicit "false" keeps dry run on.
    // A missing env var must not be the thing that starts dialing strangers.
    dryRun: process.env['DANNY_DRY_RUN'] !== 'false',
  };
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
  if (providedSecret !== config.webhookSecret) {
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
