/**
 * End-to-end dry run.
 *
 *   npm run call:dry -- --phone +14155550123 --line auto
 *
 * Drives a contact through the entire path — profile, gate, authorization,
 * dialer, registry — with the PSTN replaced by a sink. Nothing rings. Nothing
 * is charged. The point is to prove the wiring holds together and, more often,
 * to show exactly which check refuses a given contact and why.
 *
 * This is the command to reach for when "why won't it call this person?" needs
 * an answer, because the gate's refusals are specific and this prints all of
 * them rather than just the first.
 */

import { randomUUID } from 'node:crypto';
import { evaluateGate, routeFailures } from '../src/compliance/gate';
import { evaluateReachability } from '../src/channels/gate';
import { permissiveTestProvider } from '../src/compliance/dnc';
import { placeCall, loadTwilioConfig } from '../src/telephony/twilio';
import {
  registerPendingCall,
  claimPendingCall,
  claimedCallCount,
  pendingCallCount,
} from '../src/telephony/call-registry';
import { normalizePhoneUS, normalizeState, stateToTimezone } from '../src/leads/normalize';
import { loadProfile, licenseGrants, primaryProducer, disclosureContext } from '../src/config/agency';
import type { ConsentRecord, Contact, LineOfBusiness } from '../src/types';
import type { CallSessionDeps } from '../src/telephony/media-server';

const args = process.argv.slice(2);
function flag(name: string, fallback = ''): string {
  const i = args.indexOf(`--${name}`);
  const next = i >= 0 ? args[i + 1] : undefined;
  return next !== undefined && !next.startsWith('--') ? next : fallback;
}

const bold = (s: string): string => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
const red = (s: string): string => `\x1b[31m${s}\x1b[0m`;
const green = (s: string): string => `\x1b[32m${s}\x1b[0m`;
const amber = (s: string): string => `\x1b[33m${s}\x1b[0m`;

async function main(): Promise<void> {
  // Dry run is forced, not merely defaulted. This script must never be the
  // thing that places a real call because someone had DANNY_DRY_RUN=false set
  // in their shell from an earlier session.
  process.env['DANNY_DRY_RUN'] = 'true';

  const profile = loadProfile();
  const producer = primaryProducer(profile);

  const phoneRaw = flag('phone', '+14155550123');
  const phoneE164 = normalizePhoneUS(phoneRaw);
  if (!phoneE164) {
    console.error(red(`"${phoneRaw}" is not a usable US phone number.`));
    process.exit(1);
  }

  const line = (flag('line', profile.lines[0] ?? 'auto') as LineOfBusiness);
  const stateCode = normalizeState(flag('state', profile.licenses[0]?.stateCode ?? 'CA'));
  const timezone = stateToTimezone(stateCode)?.timezone ?? null;
  const consentBasis = flag('consent', 'prior_express_written') as ConsentRecord['basis'];

  console.log(`
${bold('Dry call')} — ${profile.legalName}
${dim('Nothing reaches the PSTN. Nothing is charged.')}

  To            ${phoneE164}
  Line          ${line}
  State         ${stateCode ?? dim('unknown')}   Timezone ${timezone ?? dim('unresolved')}
  Consent       ${consentBasis}
  Producer      ${producer.displayName} → ${producer.transferPhoneE164}
`);

  const contact: Contact = {
    id: `dry_${randomUUID().slice(0, 8)}`,
    phoneE164,
    lineType: 'mobile',
    firstName: 'Test',
    lastName: 'Contact',
    email: 'test@example.com',
    stateCode,
    postalCode: null,
    timezone,
    dateOfBirth: null,
    isExistingPolicyholder: false,
    internalDncAt: null,
    leadSource: 'quote_form',
  };

  const consents: ConsentRecord[] =
    consentBasis === 'none'
      ? []
      : [
          {
            id: 'dry_consent',
            contactId: contact.id,
            phoneE164,
            basis: consentBasis,
            disclosureText: 'Dry-run consent record.',
            sourceUri: 'dry-run',
            capturedAt: new Date(Date.now() - 86_400_000),
            expiresAt: null,
            ipAddress: null,
            userAgent: null,
            scopedLines: [],
            revokedAt: null,
          },
        ];

  const licenses = licenseGrants(profile);
  const disclosure = disclosureContext(profile);
  const now = new Date();

  // ── Reachability across all four channels ───────────────────────────────
  console.log(bold('  Channels'));
  const reachability = await evaluateReachability({
    line,
    contact,
    emailAddress: contact.email,
    consents,
    licenses,
    suppressions: [],
    ebr: { lastTransactionAt: null, lastInquiryAt: null },
    attempts: { today: 0, thisWeek: 0, last24h: 0 },
    dncProvider: permissiveTestProvider,
    disclosure,
    at: now,
    killSwitchEngaged: false,
  });

  for (const [channel, state] of Object.entries(reachability.channels)) {
    const mark = state.allowed ? green('open  ') : red('closed');
    console.log(`    ${mark} ${channel.padEnd(13)} ${state.allowed ? '' : dim(state.reason)}`);
  }
  console.log(`    ${dim(`best consent path: ${reachability.bestConsentPath ?? 'none'}`)}\n`);

  // ── The voice gate ──────────────────────────────────────────────────────
  console.log(bold('  Gate'));
  const result = await evaluateGate({
    contact,
    line,
    consents,
    licenses,
    ebr: { lastTransactionAt: null, lastInquiryAt: null },
    medicare: null,
    attempts: { today: 0, thisWeek: 0, last24h: 0 },
    disclosure: {
      agentDisplayName: disclosure.agentDisplayName,
      agencyLegalName: disclosure.agencyLegalName,
      agencyNpn: disclosure.agencyNpn,
      medicarePlanCount: disclosure.medicarePlanCount,
    },
    dncProvider: permissiveTestProvider,
    at: now,
    killSwitchEngaged: false,
  });

  if (!result.ok) {
    console.log(red('    REFUSED\n'));
    for (const failure of result.failures) {
      console.log(`    ${red('✗')} ${bold(failure.code)}`);
      console.log(`      ${dim(failure.detail)}`);
    }

    const routed = routeFailures(result.failures);
    console.log(
      routed.dead.length > 0
        ? `\n  ${red('Nobody may call this contact.')}`
        : `\n  ${amber('A licensed human may still call after a DNC scrub.')}`,
    );
    console.log(
      `  ${dim('Email is usually still open — see the channel table above.')}\n`,
    );
    process.exit(0);
  }

  console.log(green('    AUTHORIZED\n'));
  const auth = result.authorization;
  console.log(`    Basis     ${auth.consentBasis}`);
  console.log(`    Expires   ${auth.expiresAt.toISOString()} ${dim('(60s — short by design)')}`);
  console.log(`\n${bold('  Disclosure')} ${dim('(spoken by the runtime before the model gets a turn)')}`);
  for (const sentence of auth.requiredDisclosure.split(/(?<=\.)\s+/)) {
    console.log(`    ${sentence}`);
  }

  // ── Dial into the sink ──────────────────────────────────────────────────
  console.log(`\n${bold('  Dial')}`);
  const config = loadTwilioConfig();
  const callRecordId = randomUUID();

  const placed = await placeCall({ authorization: auth, config, callRecordId });
  console.log(`    ${green('placed')} ${placed.providerSid} ${dim(placed.dryRun ? '(sink)' : '')}`);

  // ── Registry round trip ─────────────────────────────────────────────────
  const deps: CallSessionDeps = {
    authorization: auth,
    line,
    agencyName: profile.legalName,
    producerName: producer.displayName,
    contactSummary: `${contact.firstName} ${contact.lastName}, ${stateCode}`,
    createTranscription: () => {
      throw new Error('dry run: no transcription');
    },
    synthesis: {
      // eslint-disable-next-line require-yield
      synthesize: async function* () {
        throw new Error('dry run: no synthesis');
      },
    },
    onComplete: () => undefined,
    onDncRequested: () => undefined,
    onTransferRequested: () => undefined,
  };

  registerPendingCall(callRecordId, deps);
  const claimed = claimPendingCall(callRecordId);
  const reclaimed = claimPendingCall(callRecordId);

  console.log(`    ${claimed ? green('registered → claimed') : red('claim failed')}`);
  console.log(
    `    ${reclaimed === null ? green('second claim refused') : red('DUPLICATE CLAIM ALLOWED')} ` +
      dim('(one authorization must not start two sessions)'),
  );
  console.log(
    `    ${dim(`registry: ${pendingCallCount()} pending, ${claimedCallCount()} claimed (kept until TTL)`)}`,
  );

  console.log(`
${green('  Wiring holds.')} Profile → gate → authorization → dialer → registry.

  ${dim('Not exercised here (they need live credentials and a real leg):')}
  ${dim('media stream, Deepgram transcription, Fish synthesis, the turn loop.')}
`);
}

main().catch((err: unknown) => {
  console.error(red(`\nDry call failed: ${String(err)}`));
  process.exit(1);
});
