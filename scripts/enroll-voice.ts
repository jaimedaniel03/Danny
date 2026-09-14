/**
 * Voice clone enrollment.
 *
 *   npm run voice:enroll -- --release <release-id> --audio voice-refs/danny.wav
 *
 * Deliberately NOT a generic "clone any audio" helper. It requires a signed
 * release id on the command line and refuses to call a provider without one,
 * because the difference between a legitimate voice clone and the fact pattern
 * the FCC has already fined is entirely a paperwork difference:
 *
 *   - FTC, Feb 2024: AI voice impersonation is an unfair or deceptive practice.
 *   - Tennessee's ELVIS Act and California AB 1836 / AB 2602 create private
 *     rights of action over unauthorized voice replicas.
 *   - The 2024 New Hampshire robocall produced a $6M forfeiture against the
 *     carrier and a $6M proposed forfeiture against the individual — for a
 *     cloned voice used without disclosure.
 *
 * So: one category of voice may be cloned here, a consenting adult who signed a
 * release naming this system, this agency, and this use. In practice, you.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { ENROLLMENT_SPEC, enrollmentPreflight } from '../src/voice/clone';
import { loadProfile, voiceSubject } from '../src/config/agency';

const args = process.argv.slice(2);
function flag(name: string): string | null {
  const i = args.indexOf(`--${name}`);
  const next = i >= 0 ? args[i + 1] : undefined;
  return next !== undefined && !next.startsWith('--') ? next : null;
}

const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
const red = (s: string): string => `\x1b[31m${s}\x1b[0m`;
const green = (s: string): string => `\x1b[32m${s}\x1b[0m`;
const amber = (s: string): string => `\x1b[33m${s}\x1b[0m`;

/**
 * WAV duration from the header. Enough for a preflight check without pulling in
 * an audio library — and if the header is unreadable that is itself a reason to
 * reject the file.
 */
function wavDurationSeconds(path: string): number | null {
  const buf = readFileSync(path);
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (buf.toString('ascii', 8, 12) !== 'WAVE') return null;

  // Walk the chunk list rather than assuming canonical 44-byte layout — plenty
  // of recorders insert LIST/INFO chunks before the data.
  let offset = 12;
  let byteRate = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ') byteRate = buf.readUInt32LE(offset + 16);
    if (id === 'data' && byteRate > 0) return size / byteRate;
    offset += 8 + size + (size % 2);
  }
  return null;
}

/** Peak-based noise-floor estimate over the quietest decile of 20ms windows. */
function noiseFloorDbfs(path: string): number | null {
  const buf = readFileSync(path);
  if (buf.length < 44) return null;

  let offset = 12;
  let dataStart = -1;
  let dataSize = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'data') {
      dataStart = offset + 8;
      dataSize = Math.min(size, buf.length - dataStart);
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (dataStart < 0 || dataSize < 2) return null;

  const windowSamples = 882; // ~20ms at 44.1kHz
  const rms: number[] = [];
  for (let i = dataStart; i + windowSamples * 2 <= dataStart + dataSize; i += windowSamples * 2) {
    let sum = 0;
    for (let j = 0; j < windowSamples; j++) {
      const sample = buf.readInt16LE(i + j * 2);
      sum += sample * sample;
    }
    rms.push(Math.sqrt(sum / windowSamples));
  }
  if (rms.length === 0) return null;

  rms.sort((a, b) => a - b);
  const quietest = rms[Math.floor(rms.length * 0.1)] ?? rms[0] ?? 1;
  return 20 * Math.log10(Math.max(quietest, 1) / 32768);
}

async function main(): Promise<void> {
  const profile = loadProfile();
  const subject = voiceSubject(profile);

  console.log(`\n${bold('Voice enrollment')} — ${profile.legalName}\n`);

  if (!subject) {
    console.error(
      red('No producer in agency.config.json is marked as the voice subject.\n') +
        'Set isVoiceSubject on exactly one producer, or re-run `npm run setup`.',
    );
    process.exit(1);
  }

  console.log(`  Subject: ${bold(subject.legalName)} (${subject.email})\n`);

  const releaseId = flag('release');
  const audioPath = flag('audio');

  if (!audioPath) {
    console.error(
      red('--audio is required.\n\n') +
        `Record ${ENROLLMENT_SPEC.recommendedDurationSeconds}s reading these lines:\n\n` +
        ENROLLMENT_SPEC.referenceScript.map((l, i) => `  ${i + 1}. ${l}`).join('\n') +
        `\n\n${dim('These cover the prosody insurance calls need: a question, a statement,')}\n` +
        `${dim('and numbers read aloud. A clone enrolled only on flat declaratives reads')}\n` +
        `${dim('"four ninety-two a month" like a hostage.')}\n`,
    );
    process.exit(1);
  }

  if (!existsSync(audioPath)) {
    console.error(red(`No file at ${audioPath}`));
    process.exit(1);
  }

  const duration = wavDurationSeconds(audioPath);
  const noiseFloor = noiseFloorDbfs(audioPath);

  if (duration === null || noiseFloor === null) {
    console.error(
      red(`Could not read ${audioPath} as WAV.\n`) +
        'Enrollment needs uncompressed 16-bit PCM WAV — an MP3 has already discarded\n' +
        'detail the clone would otherwise have used.',
    );
    process.exit(1);
  }

  console.log(`  ${statSync(audioPath).size.toLocaleString()} bytes`);
  console.log(`  ${duration.toFixed(1)}s, noise floor ${noiseFloor.toFixed(1)} dBFS\n`);

  const preflight = enrollmentPreflight({
    durationSeconds: Math.round(duration),
    noiseFloorDbfs: Math.round(noiseFloor),
    releaseId,
  });

  if (!preflight.ok) {
    console.error(red('Enrollment blocked:\n'));
    for (const problem of preflight.problems) console.error(red(`  ✗ ${problem}`));
    if (!releaseId) {
      console.error(
        `\n${dim('The release is a signed document naming this system, this agency, and')}\n` +
          `${dim('this use, countersigned by the voice subject. Store it, then pass its id:')}\n\n` +
          `  npm run voice:enroll -- --release <id> --audio ${audioPath}\n`,
      );
    }
    process.exit(1);
  }

  // Confirm out loud. Enrollment is cheap to do and awkward to undo — the model
  // lives at the provider until someone deletes it.
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(
    `${amber('This clones ' + subject.legalName + "'s voice under release " + releaseId + '.')}\n` +
      `Type the subject's legal name to confirm: `,
  );
  rl.close();

  if (answer.trim().toLowerCase() !== subject.legalName.toLowerCase()) {
    console.error(red('\nName did not match. Nothing enrolled.'));
    process.exit(1);
  }

  const apiKey = process.env['FISH_API_KEY'];
  if (!apiKey) {
    console.error(red('\nFISH_API_KEY is not set.'));
    process.exit(1);
  }

  console.log('\n  Uploading to Fish Audio…');

  const form = new FormData();
  form.append('title', `${profile.legalName} — ${subject.displayName}`);
  form.append('type', 'tts');
  form.append('train_mode', 'fast');
  form.append(
    'voices',
    new Blob([new Uint8Array(readFileSync(audioPath))], { type: 'audio/wav' }),
    audioPath.split('/').pop() ?? 'reference.wav',
  );

  const response = await fetch(`${process.env['FISH_API_BASE'] ?? 'https://api.fish.audio'}/model`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!response.ok) {
    console.error(red(`\nEnrollment failed: ${response.status} ${await response.text()}`));
    process.exit(1);
  }

  const payload = (await response.json()) as { _id?: string; id?: string };
  const modelId = payload._id ?? payload.id;

  console.log(green(`\n  ✓ Voice model ${modelId}\n`));
  console.log(`${bold('Next:')}
  1. Put it in .env.local:  ${dim(`FISH_VOICE_MODEL_ID=${modelId}`)}
  2. ${amber('Audition it over a real phone call before shipping.')}
     ${dim('A clone that sounds perfect in headphones can sound wrong through the')}
     ${dim('8kHz codec, and finding that out in production costs a re-enrollment.')}
  3. Record the release id against the model in voice_models.
`);
}

main().catch((err: unknown) => {
  console.error(red(`\nEnrollment failed: ${String(err)}`));
  process.exit(1);
});
