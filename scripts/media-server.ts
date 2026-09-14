/**
 * Media server entrypoint.
 *
 *   npm run media
 *
 * Holds a WebSocket open for the duration of every call, which is precisely why
 * it cannot live on Vercel. Deploy it on Fly.io, Railway, or a container; the
 * Next.js control plane points Twilio at it through the `<Connect><Stream>`
 * TwiML that `buildStreamTwiml` emits.
 *
 * Deliberately thin. All it does is wire the ports — Fish for synthesis,
 * Deepgram for transcription, the registry for call lookup — and hand them to
 * `startMediaServer`. Anything cleverer belongs in a module that can be tested
 * without opening a socket.
 */

import { startMediaServer } from '../src/telephony/media-server';
import { claimPendingCall } from '../src/telephony/call-registry';
import { loadTwilioConfig } from '../src/telephony/twilio';
import { loadProfile } from '../src/config/agency';

const port = Number.parseInt(process.env['MEDIA_SERVER_PORT'] ?? '8080', 10);

// Fail fast and loudly rather than accepting a connection we cannot serve. A
// media server that starts without credentials answers the call and then sits
// in silence, which is worse than never answering.
//
// Loudly, though, means a sentence someone can act on. An uncaught throw here
// prints a stack trace whose first useful line is thirty frames deep, and this
// is the one command an operator runs before anything else works.
function orExit<T>(load: () => T, hint: string): T {
  try {
    return load();
  } catch (err) {
    console.error(`\n[media] cannot start: ${err instanceof Error ? err.message : String(err)}\n`);
    console.error(`${hint}\n`);
    process.exit(1);
  }
}

const config = orExit(
  loadTwilioConfig,
  'You have set DANNY_DRY_RUN=false, so every credential is required:\n' +
    'TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_CALLER_ID, PUBLIC_BASE_URL and\n' +
    'TWILIO_WEBHOOK_SECRET, in .env.local. Unset DANNY_DRY_RUN to run the server\n' +
    'against placeholders instead — nothing reaches the PSTN in that mode.',
);

const profile = orExit(
  loadProfile,
  'Run `npm run setup` to write agency.config.json. The server names the agency on\n' +
    'every connection it logs, and a profile that fails validation would have failed\n' +
    'mid-call instead.',
);

const fishApiKey = process.env['FISH_API_KEY'];
const fishModelId = process.env['FISH_VOICE_MODEL_ID'];
if (!config.dryRun && (!fishApiKey || !fishModelId)) {
  console.error(
    'FISH_API_KEY and FISH_VOICE_MODEL_ID are required outside dry run.\n' +
      'Run `npm run voice:enroll` to create a voice model, or set DANNY_DRY_RUN=true.',
  );
  process.exit(1);
}

/**
 * Note what this file does NOT do: build the synthesis and transcription ports.
 *
 * Those are wired by `src/telephony/dialer.ts` and travel with the registered
 * call, because they carry per-call state the server cannot know — which voice
 * release authorizes this utterance, which line of business it covers. A server
 * that constructed them here would have to guess, and the guess it would make
 * is "the default voice", which is exactly the check the release exists to
 * enforce.
 */
const server = startMediaServer({
  port,
  webhookSecret: config.webhookSecret,

  async resolveCall(callRecordId) {
    // The dialer registered these when it placed the call. A miss means the
    // call was never placed through the gate, already claimed, or timed out —
    // all of which should refuse the connection rather than improvise one.
    const deps = claimPendingCall(callRecordId);
    if (!deps) {
      console.warn(`[media] no pending call for ${callRecordId} — refusing stream`);
      return null;
    }
    return deps;
  },
});

console.log(
  `[media] ${profile.legalName} — listening on :${port}/media` +
    (config.dryRun ? ' (DRY RUN: nothing reaches the PSTN)' : ''),
);

/**
 * Graceful shutdown.
 *
 * Calls in flight are real conversations with real people. Dropping them mid
 * sentence on a deploy is both rude and a support ticket, so stop accepting new
 * connections and let the existing ones finish.
 */
function shutdown(signal: string): void {
  console.log(`[media] ${signal} — no new calls; finishing those in flight`);
  server.close(() => {
    console.log('[media] all calls complete, exiting');
    process.exit(0);
  });

  // A call that will not end within the grace period is likelier hung than busy.
  setTimeout(() => {
    console.warn('[media] grace period elapsed, forcing exit');
    process.exit(1);
  }, 90_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
