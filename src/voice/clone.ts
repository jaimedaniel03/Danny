/**
 * Voice cloning — enrollment and governance.
 *
 * Cloning a voice is trivially easy and legally loaded. The engineering here is
 * mostly bookkeeping, and the bookkeeping is the point.
 *
 * What actually binds you:
 *  - **FTC**, Feb 2024: impersonating an individual via AI voice is an unfair or
 *    deceptive practice. The Commission has an active rule on government and
 *    business impersonation and has proposed extending it to individuals.
 *  - **Right of publicity / digital replica statutes.** Tennessee's ELVIS Act
 *    (2024) and California AB 1836 / AB 2602 (2024) create private rights of
 *    action over unauthorized voice replicas. Damages are real and they are not
 *    capped by a per-call schedule.
 *  - **The FCC's enforcement pattern.** The 2024 New Hampshire primary robocall
 *    produced a $6M forfeiture against the transmitting carrier and a $6M
 *    proposed forfeiture against the individual — for a cloned voice used
 *    without disclosure. Cloned voice plus undisclosed AI is the exact fact
 *    pattern regulators have already punished.
 *
 * Our rule: you may clone exactly one category of voice — a consenting adult who
 * has signed a written release naming this system, this agency, and this use.
 * In practice that means the agency principal. Every synthesis call carries the
 * release id, and a revoked release disables the model in-flight.
 */

import type { LineOfBusiness } from '@/types';

export interface VoiceRelease {
  readonly id: string;
  /** The human whose voice this is. */
  readonly subjectLegalName: string;
  readonly subjectEmail: string;
  /** Signed release document — object storage URI, retained for the life of the model + 7y. */
  readonly signedDocumentUri: string;
  readonly signedAt: Date;
  /** What the subject agreed the clone may be used for. Enforced, not decorative. */
  readonly permittedUses: readonly ('outbound_call' | 'inbound_call' | 'voicemail' | 'marketing')[];
  readonly permittedLines: readonly LineOfBusiness[];
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
  /** Reference audio used for enrollment. Never deleted while the model lives. */
  readonly referenceAudioUris: readonly string[];
  readonly referenceDurationSeconds: number;
}

export interface VoiceModel {
  readonly id: string;
  /** Provider-side identifier — Fish Audio model id. */
  readonly providerModelId: string;
  readonly provider: 'fish' | 'elevenlabs' | 'cartesia';
  readonly releaseId: string;
  readonly displayName: string;
  readonly createdAt: Date;
  readonly disabledAt: Date | null;
}

export class VoiceReleaseError extends Error {
  constructor(
    message: string,
    readonly releaseId: string,
  ) {
    super(message);
    this.name = 'VoiceReleaseError';
  }
}

/**
 * Called before every synthesis. Cheap, and it is the difference between "we
 * had a policy" and "the system could not have done that."
 */
export function assertReleaseValid(input: {
  readonly release: VoiceRelease;
  readonly model: VoiceModel;
  readonly use: 'outbound_call' | 'inbound_call' | 'voicemail' | 'marketing';
  readonly line: LineOfBusiness;
  readonly at: Date;
}): void {
  const { release, model, use, line, at } = input;

  if (model.disabledAt !== null) {
    throw new VoiceReleaseError(`Voice model ${model.id} is disabled.`, release.id);
  }
  if (release.revokedAt !== null && release.revokedAt <= at) {
    throw new VoiceReleaseError(
      `Voice release revoked at ${release.revokedAt.toISOString()}. Synthesis is prohibited.`,
      release.id,
    );
  }
  if (release.expiresAt !== null && release.expiresAt <= at) {
    throw new VoiceReleaseError(
      `Voice release expired at ${release.expiresAt.toISOString()}.`,
      release.id,
    );
  }
  if (!release.permittedUses.includes(use)) {
    throw new VoiceReleaseError(
      `Release permits [${release.permittedUses.join(', ')}] but not "${use}".`,
      release.id,
    );
  }
  if (release.permittedLines.length > 0 && !release.permittedLines.includes(line)) {
    throw new VoiceReleaseError(
      `Release does not cover line of business "${line}".`,
      release.id,
    );
  }
}

/**
 * Enrollment guidance, encoded so it does not live only in someone's head.
 *
 * Fish Audio's few-shot cloning wants clean reference audio. What actually moves
 * quality, in order:
 *  1. **Recording condition consistency** beats duration. 30 seconds from one
 *     good mic in one room outperforms 10 minutes stitched from three sources.
 *  2. **Prosodic range.** The reference should contain a question, a statement,
 *     and a number read aloud. Insurance calls are full of numbers, and a clone
 *     enrolled only on flat declaratives reads "four ninety-two a month" like a
 *     hostage.
 *  3. **Match the target channel.** You are synthesizing into an 8kHz μ-law
 *     phone codec. A pristine 48kHz studio reference clones a voice the codec
 *     then destroys. Record the reference through a phone call, or at minimum
 *     audition every candidate model over a real PSTN leg before shipping it.
 */
export const ENROLLMENT_SPEC = {
  minDurationSeconds: 30,
  recommendedDurationSeconds: 120,
  maxDurationSeconds: 600,
  sampleRateHz: 44_100,
  /** Read these during enrollment. They cover the prosody insurance calls need. */
  referenceScript: [
    "Hi, this is a quick call about your auto policy — do you have two minutes?",
    "Your current premium is four hundred ninety-two dollars a month, and I think we can do better than that.",
    "Can I ask — when you bundled the home and the auto, did anyone walk you through the deductible?",
    "That's a great question, and honestly, the answer depends on the carrier.",
    "No problem at all. I'll take you off the list right now. Have a good one.",
  ],
  /** Reject enrollment audio noisier than this; the clone inherits the noise floor. */
  maxNoiseFloorDbfs: -45,
} as const;

/**
 * Deliberately not implemented as a generic "clone any audio" helper.
 * Enrollment goes through `scripts/enroll-voice.ts`, which requires a release id
 * on the command line and writes the release row before it ever calls a provider.
 */
export function enrollmentPreflight(input: {
  readonly durationSeconds: number;
  readonly noiseFloorDbfs: number;
  readonly releaseId: string | null;
}): { readonly ok: boolean; readonly problems: readonly string[] } {
  const problems: string[] = [];

  if (!input.releaseId) {
    problems.push(
      'No signed voice release on file. Enrollment is blocked until a release ' +
        'naming this system and this agency is countersigned and stored.',
    );
  }
  if (input.durationSeconds < ENROLLMENT_SPEC.minDurationSeconds) {
    problems.push(
      `Reference audio is ${input.durationSeconds}s; minimum is ${ENROLLMENT_SPEC.minDurationSeconds}s.`,
    );
  }
  if (input.durationSeconds > ENROLLMENT_SPEC.maxDurationSeconds) {
    problems.push(
      `Reference audio is ${input.durationSeconds}s; longer references add drift, not fidelity.`,
    );
  }
  if (input.noiseFloorDbfs > ENROLLMENT_SPEC.maxNoiseFloorDbfs) {
    problems.push(
      `Noise floor ${input.noiseFloorDbfs} dBFS exceeds ${ENROLLMENT_SPEC.maxNoiseFloorDbfs} dBFS. ` +
        'The clone will reproduce the room, not just the voice.',
    );
  }

  return { ok: problems.length === 0, problems };
}
