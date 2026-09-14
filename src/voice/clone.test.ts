/**
 * Voice release governance.
 *
 * `assertReleaseValid` runs before every synthesis — not once at enrollment —
 * because the thing it protects is a person's voice, and the only version of
 * that protection worth having is one that stops mid-call. A release revoked at
 * 2:04 must stop the next sentence, not the next campaign.
 *
 * The failure mode these guard against is not a crash. It is a recording, in
 * someone's cloned voice, saying something they never agreed to say, for a
 * purpose they never agreed to — which is a right-of-publicity claim and, if the
 * subject is the agency's own producer, an employment one.
 */

import { describe, expect, it } from 'vitest';
import {
  ENROLLMENT_SPEC,
  VoiceReleaseError,
  assertReleaseValid,
  enrollmentPreflight,
  type VoiceModel,
  type VoiceRelease,
} from './clone';

const NOW = new Date('2026-09-14T19:00:00Z');

const RELEASE: VoiceRelease = {
  id: 'release_1',
  subjectLegalName: 'Daniel Ruiz',
  subjectEmail: 'danny@ruizinsurance.com',
  signedDocumentUri: 's3://releases/release_1.pdf',
  signedAt: new Date('2026-08-01'),
  permittedUses: ['outbound_call', 'inbound_call'],
  permittedLines: [],
  expiresAt: null,
  revokedAt: null,
  referenceAudioUris: ['s3://voice-refs/danny.wav'],
  referenceDurationSeconds: 120,
};

const MODEL: VoiceModel = {
  id: 'model_1',
  providerModelId: 'fish_abc123',
  provider: 'fish',
  releaseId: 'release_1',
  displayName: 'Danny',
  createdAt: new Date('2026-08-02'),
  disabledAt: null,
};

function assert(over: Partial<Parameters<typeof assertReleaseValid>[0]> = {}): void {
  assertReleaseValid({
    release: RELEASE,
    model: MODEL,
    use: 'outbound_call',
    line: 'auto',
    at: NOW,
    ...over,
  });
}

describe('the release has to be this model’s release', () => {
  it('refuses a valid release presented for a different voice', () => {
    // The caller passes the two independently, so nothing else catches this.
    // A live, permissive release for one person would otherwise authorize
    // synthesis of somebody else's cloned voice — the one failure here that
    // produces a recording of a person who never agreed to be cloned.
    const otherVoice: VoiceModel = { ...MODEL, id: 'model_2', releaseId: 'release_2' };

    expect(() => assert({ model: otherVoice })).toThrow(VoiceReleaseError);
    expect(() => assert({ model: otherVoice })).toThrow(/authorizes one voice, not any voice/);
  });

  it('allows the matching pair', () => {
    expect(() => assert()).not.toThrow();
  });
});

describe('revocation stops synthesis', () => {
  it('refuses once the release is revoked', () => {
    const revoked: VoiceRelease = { ...RELEASE, revokedAt: new Date('2026-09-01') };

    expect(() => assert({ release: revoked })).toThrow(/revoked/);
  });

  it('is still valid a moment before revocation takes effect', () => {
    // Checked per utterance rather than per call, so a release revoked at 2:04
    // stops the 2:04 sentence and not the 2:03 one.
    const revoked: VoiceRelease = { ...RELEASE, revokedAt: new Date('2026-09-14T19:00:01Z') };

    expect(() => assert({ release: revoked, at: NOW })).not.toThrow();
    expect(() => assert({ release: revoked, at: new Date('2026-09-14T19:00:01Z') })).toThrow(
      /revoked/,
    );
  });

  it('refuses a disabled model even with a live release', () => {
    const disabled: VoiceModel = { ...MODEL, disabledAt: new Date('2026-09-01') };

    // The kill switch for one voice. It must not require finding and revoking
    // the paper release to take effect.
    expect(() => assert({ model: disabled })).toThrow(/disabled/);
  });
});

describe('expiry', () => {
  it('refuses an expired release', () => {
    const expired: VoiceRelease = { ...RELEASE, expiresAt: new Date('2026-09-01') };

    expect(() => assert({ release: expired })).toThrow(/expired/);
  });

  it('treats a null expiry as open-ended, not as expired', () => {
    expect(() => assert({ release: { ...RELEASE, expiresAt: null } })).not.toThrow();
  });

  it('refuses at exactly the expiry instant', () => {
    const expired: VoiceRelease = { ...RELEASE, expiresAt: NOW };

    expect(() => assert({ release: expired, at: NOW })).toThrow(/expired/);
  });
});

describe('permitted uses are enforced, not decorative', () => {
  it('refuses a use the subject did not agree to', () => {
    // Someone who agreed to have their voice answer calls has not thereby
    // agreed to have it left on voicemails or used in marketing.
    expect(() => assert({ use: 'voicemail' })).toThrow(/but not "voicemail"/);
    expect(() => assert({ use: 'marketing' })).toThrow(/but not "marketing"/);
  });

  it('allows the uses on the release', () => {
    expect(() => assert({ use: 'outbound_call' })).not.toThrow();
    expect(() => assert({ use: 'inbound_call' })).not.toThrow();
  });

  it('names what the release does permit, so the error is actionable', () => {
    expect(() => assert({ use: 'marketing' })).toThrow(/outbound_call, inbound_call/);
  });
});

describe('permitted lines', () => {
  it('treats an empty list as every line', () => {
    for (const line of ['auto', 'home', 'health_medicare', 'life_term'] as const) {
      expect(() => assert({ line }), line).not.toThrow();
    }
  });

  it('refuses a line outside a scoped release', () => {
    const scoped: VoiceRelease = { ...RELEASE, permittedLines: ['auto', 'home'] };

    expect(() => assert({ release: scoped, line: 'auto' })).not.toThrow();
    expect(() => assert({ release: scoped, line: 'health_medicare' })).toThrow(
      /does not cover line of business/,
    );
  });
});

describe('the error carries the release id', () => {
  it('names which release refused, for the audit line', () => {
    try {
      assert({ use: 'marketing' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(VoiceReleaseError);
      expect((err as VoiceReleaseError).releaseId).toBe('release_1');
    }
  });
});

describe('enrollment preflight', () => {
  const good = { durationSeconds: 120, noiseFloorDbfs: -60, releaseId: 'release_1' };

  it('passes clean reference audio with a release on file', () => {
    expect(enrollmentPreflight(good)).toEqual({ ok: true, problems: [] });
  });

  it('blocks enrollment with no signed release, whatever the audio is like', () => {
    const verdict = enrollmentPreflight({ ...good, releaseId: null });

    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(' ')).toContain('No signed voice release');
  });

  it('rejects audio shorter than the minimum', () => {
    const verdict = enrollmentPreflight({
      ...good,
      durationSeconds: ENROLLMENT_SPEC.minDurationSeconds - 1,
    });

    expect(verdict.ok).toBe(false);
  });

  it('rejects audio longer than the maximum — drift, not fidelity', () => {
    const verdict = enrollmentPreflight({
      ...good,
      durationSeconds: ENROLLMENT_SPEC.maxDurationSeconds + 1,
    });

    expect(verdict.ok).toBe(false);
  });

  it('rejects a noisy room, because the clone inherits it', () => {
    const verdict = enrollmentPreflight({
      ...good,
      noiseFloorDbfs: ENROLLMENT_SPEC.maxNoiseFloorDbfs + 10,
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(' ')).toContain('reproduce the room');
  });

  it('reports every problem at once rather than one per run', () => {
    const verdict = enrollmentPreflight({
      durationSeconds: 5,
      noiseFloorDbfs: -20,
      releaseId: null,
    });

    // Three round trips to fix three problems is how people give up on a
    // preflight and skip it.
    expect(verdict.problems.length).toBe(3);
  });
});

describe('the enrollment script covers the prosody insurance calls need', () => {
  it('includes a question, a number read aloud, and the removal line', () => {
    const script = ENROLLMENT_SPEC.referenceScript.join(' ');

    // A clone enrolled only on flat declaratives reads "four ninety-two a
    // month" like a hostage.
    expect(script).toMatch(/\?/);
    expect(script).toMatch(/four hundred ninety-two/);
    expect(script).toMatch(/off the list/);
  });

  it('recommends more than the minimum and less than the maximum', () => {
    expect(ENROLLMENT_SPEC.recommendedDurationSeconds).toBeGreaterThan(
      ENROLLMENT_SPEC.minDurationSeconds,
    );
    expect(ENROLLMENT_SPEC.recommendedDurationSeconds).toBeLessThan(
      ENROLLMENT_SPEC.maxDurationSeconds,
    );
  });
});
