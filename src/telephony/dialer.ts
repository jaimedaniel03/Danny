/**
 * The dialer — the one place a call is actually originated.
 *
 * Everything before this file decides *whether* to call. This is where that
 * decision becomes a ringing phone, and it exists so the sequence is written
 * once rather than reassembled at each call site:
 *
 *   profile → gate → authorization → audit row → Twilio → registry
 *
 * The ordering is load-bearing in one place: the audit row is written **before**
 * the dial, not after. If the process dies between them you have a recorded
 * authorization for a call that never happened, which is harmless. The other
 * order gives you a call with no record, which is the one thing the evidence
 * discipline exists to prevent.
 */

import { randomUUID } from 'node:crypto';
import { evaluateGate, type GateInput } from '@/compliance/gate';
import { loadTwilioConfig, placeCall, type TwilioConfig } from './twilio';
import { registerPendingCall } from './call-registry';
import { createDeepgramSession, endpointingForState } from '@/voice/stt';
import { createFishClient, DEFAULT_FISH_CONFIG } from '@/voice/tts-fish';
import {
  disclosureContext,
  licenseGrants,
  primaryProducer,
  type AgencyProfile,
} from '@/config/agency';
import type { VoiceModel, VoiceRelease } from '@/voice/clone';
import type { CallSessionDeps, SynthesisPort, TranscriptionSession } from './media-server';
import type { ConsentRecord, Contact, GateFailure, LineOfBusiness } from '@/types';
import type { DncProvider, EbrEvidence } from '@/compliance/dnc';

export interface DialRequest {
  readonly profile: AgencyProfile;
  readonly contact: Contact;
  readonly line: LineOfBusiness;
  readonly consents: readonly ConsentRecord[];
  readonly ebr: EbrEvidence;
  readonly attempts: { readonly today: number; readonly thisWeek: number; readonly last24h: number };
  readonly dncProvider: DncProvider;
  /** Voice governance. Checked on every synthesis, not once at enrollment. */
  readonly voice: { readonly release: VoiceRelease; readonly model: VoiceModel } | null;
  readonly medicare: GateInput['medicare'];
  readonly killSwitchEngaged: boolean;
  readonly config?: TwilioConfig;
  readonly at?: Date;
}

export type DialResult =
  | {
      readonly ok: true;
      readonly callRecordId: string;
      readonly providerSid: string;
      readonly dryRun: boolean;
    }
  | { readonly ok: false; readonly failures: readonly GateFailure[] };

/**
 * Build the transcription factory.
 *
 * Endpointing is not a constant — it varies by conversation state, because
 * people pause *inside* phone numbers and dollar amounts, which is most of what
 * an insurance call consists of. The session re-creates this per state; the
 * initial value is the discovery setting, which is the most forgiving.
 */
function transcriptionFactory(): () => TranscriptionSession {
  return () => createDeepgramSession({ endpointingMs: endpointingForState('DISCOVERY') });
}

function synthesisFactory(input: {
  readonly voice: { readonly release: VoiceRelease; readonly model: VoiceModel };
  readonly line: LineOfBusiness;
}): SynthesisPort {
  const apiKey = process.env['FISH_API_KEY'];
  if (!apiKey) throw new Error('FISH_API_KEY is required to synthesize speech.');

  const fish = createFishClient({
    ...DEFAULT_FISH_CONFIG,
    apiKey,
    modelId: input.voice.model.providerModelId,
  });

  return {
    synthesize(text: string): AsyncIterable<Uint8Array> {
      return fish.synthesizeStream(text, {
        release: input.voice.release,
        model: input.voice.model,
        line: input.line,
        use: 'outbound_call',
        // Evaluated per utterance so a release revoked mid-call stops synthesis
        // on the next sentence rather than at the next call.
        at: new Date(),
      });
    },
  };
}

/**
 * A synthesis port that refuses. Used in dry run, where there is no voice model
 * and no leg to speak into — reaching it means the wiring is wrong, so it says
 * so rather than emitting silence that looks like success.
 */
const refusingSynthesis: SynthesisPort = {
  synthesize(): AsyncIterable<Uint8Array> {
    // Not a generator: it never yields, and writing it as one only obscures
    // that the first `next()` throws.
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<Uint8Array> => ({
        next: () =>
          Promise.reject(
            new Error(
              'No voice model configured. Run `npm run voice:enroll`, or keep ' +
                'this call in dry run where nothing is spoken.',
            ),
          ),
      }),
    };
  },
};

export interface DialCallbacks {
  readonly onComplete: CallSessionDeps['onComplete'];
  readonly onDncRequested: CallSessionDeps['onDncRequested'];
  readonly onTransferRequested: CallSessionDeps['onTransferRequested'];
}

/** Callbacks that only log. The dry-run and smoke-test default. */
export function loggingCallbacks(): DialCallbacks {
  return {
    onComplete: (outcome) =>
      console.info(`[dial] complete: ${outcome.disposition} after ${outcome.durationMs}ms`),
    onDncRequested: (phone) => console.warn(`[dial] DNC requested by ${phone}`),
    onTransferRequested: () => console.info('[dial] transfer requested'),
  };
}

/**
 * Callbacks that write what happened.
 *
 * The production default. `loggingCallbacks` was the only implementation for a
 * while, which meant a real call's disposition went to stdout and nowhere else:
 * no history, no cost accounting, and — worse — a do-not-call request honoured
 * out loud on the call and never written to the suppression ledger, so the next
 * campaign would dial them again.
 *
 * Failures are logged rather than thrown. The call is already over by the time
 * these run; throwing cannot un-place it, and an exception escaping the media
 * server's `finish()` would take the socket down with it.
 */
export function persistingCallbacks(input: {
  readonly callRecordId: string;
  readonly contactId: string;
}): DialCallbacks {
  return {
    onComplete: async (outcome) => {
      try {
        const { recordCallOutcomeById } = await import('@/db/calls');
        await recordCallOutcomeById({
          callRecordId: input.callRecordId,
          disposition: outcome.disposition,
          finalState: outcome.finalState,
          durationSeconds: Math.round(outcome.durationMs / 1000),
          aiDisclosedAt: outcome.aiDisclosedAt,
        });
      } catch (err) {
        console.error('[dial] outcome write failed', err);
      }
    },

    onDncRequested: async (phoneE164) => {
      try {
        // Written in-turn, not within the ten business days the law allows —
        // and this is the write that makes the promise the agent just spoke
        // out loud actually true.
        const { suppressNumber } = await import('@/db/consents');
        await suppressNumber({
          phoneE164,
          reason: `Requested on call ${input.callRecordId}`,
        });
      } catch (err) {
        // The one failure here worth shouting about: the prospect was told they
        // were removed and they were not.
        console.error(
          `[dial] SUPPRESSION WRITE FAILED for ${phoneE164} — this number was ` +
            `promised removal and is NOT suppressed. Fix by hand.`,
          err,
        );
      }
    },

    onTransferRequested: () =>
      console.info(`[dial] transfer requested on ${input.callRecordId}`),
  };
}

/**
 * Originate one call.
 *
 * Returns the gate's refusals rather than throwing on them: a refusal is an
 * ordinary, expected outcome — most contacts on most lists are not AI-dialable —
 * and the caller routes those to a human queue rather than treating them as
 * errors.
 */
export async function dial(
  request: DialRequest,
  callbacks: DialCallbacks = loggingCallbacks(),
): Promise<DialResult> {
  const { profile, contact, line } = request;
  const at = request.at ?? new Date();
  const config = request.config ?? loadTwilioConfig();
  const producer = primaryProducer(profile);
  const disclosure = disclosureContext(profile);

  const gate = await evaluateGate({
    contact,
    line,
    consents: request.consents,
    licenses: licenseGrants(profile),
    ebr: request.ebr,
    medicare: request.medicare,
    attempts: request.attempts,
    disclosure: {
      agentDisplayName: disclosure.agentDisplayName,
      agencyLegalName: disclosure.agencyLegalName,
      agencyNpn: disclosure.agencyNpn,
      medicarePlanCount: disclosure.medicarePlanCount,
    },
    dncProvider: request.dncProvider,
    at,
    killSwitchEngaged: request.killSwitchEngaged,
  });

  if (!gate.ok) return { ok: false, failures: gate.failures };

  const authorization = gate.authorization;
  const callRecordId = randomUUID();

  // Evidence first. A recorded authorization with no call is harmless; a call
  // with no record is the failure this whole discipline exists to prevent.
  try {
    const { recordDialAuthorization } = await import('@/db/authorizations');
    await recordDialAuthorization({
      callRecordId,
      agencyId: profile.agencyId,
      contactId: contact.id,
      consentId: authorization.consentId,
      line,
      granted: true,
      failureCodes: [],
      evidence: authorization.evidence,
      issuedAt: authorization.issuedAt,
      expiresAt: authorization.expiresAt,
      requiredDisclosure: authorization.requiredDisclosure,
    });
  } catch (err) {
    // No database in dry run is expected. Outside it, an unwritable audit row
    // means we must not dial — that is the whole point of writing it first.
    if (!config.dryRun) throw err;
    console.warn('[dial] audit row not written (dry run)');
  }

  const deps: CallSessionDeps = {
    authorization,
    line,
    agencyName: profile.legalName,
    producerName: producer.displayName,
    contactSummary:
      [contact.firstName, contact.lastName].filter(Boolean).join(' ') +
      (contact.stateCode ? ` in ${contact.stateCode}` : ''),
    createTranscription: config.dryRun
      ? () => {
          throw new Error('dry run: no transcription');
        }
      : transcriptionFactory(),
    synthesis: request.voice ? synthesisFactory({ voice: request.voice, line }) : refusingSynthesis,
    ...callbacks,
  };

  // Register before dialing. Twilio can connect the media stream within
  // milliseconds of the answer, and a stream that arrives before the registry
  // entry is refused — which would drop a call that was perfectly authorized.
  registerPendingCall(callRecordId, deps);

  const placed = await placeCall({ authorization, config, callRecordId });

  // Open the call record now that Twilio has assigned a SID. Every later write
  // — status, recording, retention date, outcome — is an UPDATE against this
  // row, and an UPDATE that matches nothing succeeds silently, so without this
  // insert the entire call ledger stays empty and says nothing about it.
  if (!placed.dryRun) {
    try {
      const { recordCallStarted } = await import('@/db/calls');
      await recordCallStarted({
        callRecordId,
        agencyId: profile.agencyId,
        contactId: contact.id,
        providerSid: placed.providerSid,
        line,
        startedAt: at,
      });
    } catch (err) {
      // The call is already ringing; there is nothing to undo. Losing the
      // ledger row is bad, dropping a live authorized call over it is worse.
      console.error('[dial] call record insert failed — call is live but unrecorded', err);
    }
  }

  return {
    ok: true,
    callRecordId,
    providerSid: placed.providerSid,
    dryRun: placed.dryRun,
  };
}
