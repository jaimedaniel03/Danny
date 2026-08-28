/**
 * The channel gate.
 *
 * Wraps the voice gate and generalizes it: same evidence discipline, same
 * branded authorization, but the consent bar and the applicable checks vary by
 * channel. Every send function in `src/channels/` takes a `ChannelAuthorization`
 * and only this module can mint one.
 *
 * ── Which checks apply where ────────────────────────────────────────────────
 *
 *                        ai_voice  human_voice  sms    email
 *   written consent        ✓          –         ✓*     –
 *   DNC registry           ✓          ✓         ✓†     –
 *   calling hours          ✓          ✓         ✓      –
 *   producer licensing     ✓          ✓         ✓      ✓
 *   channel suppression    ✓          ✓         ✓      ✓
 *   attempt caps           ✓          ✓         ✓      ✓
 *
 *   * marketing intent only; transactional SMS takes a lower bar
 *   † the registry governs telemarketing "calls", and a text is a call
 *
 * Email's row is nearly empty and that is not an oversight — under CAN-SPAM the
 * gating question is suppression, not consent. The licensing check stays,
 * because soliciting insurance in a state you are not licensed in is a
 * different statute that does not care what medium you used.
 */

import { evaluateGate, type GateInput, type LicenseGrant } from '@/compliance/gate';
import { checkCallingHours } from '@/compliance/calling-hours';
import { scrub, type DncProvider, type EbrEvidence } from '@/compliance/dnc';
import { LINE_LICENSE } from '@/types';
import type { ConsentRecord, Contact, GateFailure, LineOfBusiness } from '@/types';
import {
  CHANNEL_CONSENT_BARS,
  CONSENT_OPTIONAL_CHANNELS,
  type Channel,
  type ChannelAuthorization,
  type ChannelGateResult,
  type ChannelSuppression,
  type MessageIntent,
  type Reachability,
} from './types';

const AUTHORIZATION_TTL_MS = 60_000;

/**
 * Per-channel attempt caps. Deliberately tighter than the law requires.
 *
 * The legal ceiling is not the useful number here — the useful number is the
 * one that keeps complaint rates low, and complaint rate is what determines
 * whether your DIDs get spam-flagged and your sending domain gets throttled.
 * Both of those kill the funnel far faster than a regulator would.
 */
export const CHANNEL_CAPS: Readonly<
  Record<Channel, { readonly perDay: number; readonly perWeek: number }>
> = {
  ai_voice: { perDay: 2, perWeek: 5 },
  human_voice: { perDay: 2, perWeek: 5 },
  // Texts feel more intrusive per unit than calls. One a day, three a week.
  sms: { perDay: 1, perWeek: 3 },
  email: { perDay: 1, perWeek: 4 },
};

export interface ChannelGateInput {
  readonly channel: Channel;
  readonly intent: MessageIntent;
  readonly line: LineOfBusiness;
  readonly contact: Contact;
  /** Required for email; ignored otherwise. */
  readonly emailAddress?: string | null;
  readonly consents: readonly ConsentRecord[];
  readonly licenses: readonly LicenseGrant[];
  readonly suppressions: readonly ChannelSuppression[];
  readonly ebr: EbrEvidence;
  readonly attempts: { readonly today: number; readonly thisWeek: number; readonly last24h: number };
  readonly dncProvider: DncProvider;
  readonly disclosure: {
    readonly agencyLegalName: string;
    readonly agencyPostalAddress: string;
    readonly agentDisplayName: string;
    readonly agencyNpn: string | null;
    readonly medicarePlanCount: { readonly carriers: number; readonly plans: number } | null;
  };
  readonly unsubscribeUrl?: string;
  readonly at: Date;
  readonly killSwitchEngaged: boolean;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Suppression is the one check every channel shares, and the one with no exemptions. */
function checkSuppression(
  suppressions: readonly ChannelSuppression[],
  channel: Channel,
): GateFailure[] {
  const hit = suppressions.find((s) => s.channel === channel);
  if (!hit) return [];
  return [
    {
      code: 'INTERNAL_DNC',
      detail:
        `Contact opted out of ${channel} on ${hit.suppressedAt.toISOString()} ` +
        `via ${hit.source}. No exemption applies to an opt-out.`,
      humanMayDial: false,
    },
  ];
}

function checkChannelConsent(
  channel: Channel,
  intent: MessageIntent,
  consents: readonly ConsentRecord[],
  line: LineOfBusiness,
  at: Date,
): { readonly chosen: ConsentRecord | null; readonly failures: GateFailure[] } {
  const bar = CHANNEL_CONSENT_BARS[channel][intent];
  const optional = CONSENT_OPTIONAL_CHANNELS.has(channel);

  const usable = consents.filter((c) => {
    if (c.revokedAt !== null && c.revokedAt <= at) return false;
    if (c.expiresAt !== null && c.expiresAt <= at) return false;
    if (c.scopedLines.length > 0 && !c.scopedLines.includes(line)) return false;
    return bar.has(c.basis);
  });

  if (usable.length > 0) return { chosen: usable[0] ?? null, failures: [] };

  // Consent-optional channels proceed without a record. A manual call and a
  // CAN-SPAM email are both lawful with nothing on file; what stops them is
  // suppression, DNC, hours, and licensing — all checked separately.
  if (optional) return { chosen: null, failures: [] };

  // Nothing cleared the bar. Say specifically what would have.
  const needsWritten = bar.has('prior_express_written') && bar.size <= 2;
  const detail =
    channel === 'sms' && intent === 'marketing'
      ? 'A promotional text to a wireless number is a "call" under TCPA 227(b) ' +
        'and requires prior express written consent — the same bar as an AI voice ' +
        'call. Having the number is not consent. This contact may still be emailed.'
      : needsWritten
        ? `Channel "${channel}" with intent "${intent}" requires prior express ` +
          `written consent. This contact may still be emailed.`
        : `No consent basis on file satisfies ${channel}/${intent}.`;

  return {
    chosen: null,
    failures: [
      {
        code: consents.length === 0 ? 'NO_CONSENT_RECORD' : 'CONSENT_BASIS_INSUFFICIENT_FOR_AI',
        detail,
        // True in the sense that matters operationally: another route exists.
        humanMayDial: true,
      },
    ],
  };
}

function checkLicensing(
  licenses: readonly LicenseGrant[],
  contact: Contact,
  line: LineOfBusiness,
  at: Date,
): GateFailure[] {
  const state = contact.stateCode?.toUpperCase();
  if (!state) {
    return [
      {
        code: 'STATE_NOT_LICENSED',
        detail: 'Contact state unknown; cannot verify producer licensing.',
        humanMayDial: false,
      },
    ];
  }

  const grant = licenses.find((l) => l.stateCode.toUpperCase() === state && l.expiresAt > at);
  if (!grant) {
    return [
      {
        code: 'STATE_NOT_LICENSED',
        detail:
          `No active producer license in ${state}. Soliciting insurance in an ` +
          `unlicensed state is an unauthorized-practice problem in every medium, ` +
          `including email.`,
        humanMayDial: false,
      },
    ];
  }

  const required = LINE_LICENSE[line];
  const held = new Set(grant.classes);
  const satisfied =
    required === 'life_and_health' ? held.has('life') && held.has('health') : held.has(required);

  return satisfied
    ? []
    : [
        {
          code: 'LICENSE_CLASS_MISSING',
          detail: `${state} license lacks the "${required}" class required for ${line}.`,
          humanMayDial: false,
        },
      ];
}

/** Mandatory trailing text per channel. Appended by the sender, never generated. */
function buildFooter(input: ChannelGateInput): string {
  switch (input.channel) {
    case 'sms':
      // Carrier requirement and CTIA best practice. Present on every message —
      // not just the first — because "we only had to say it once" is an argument
      // you make after a complaint, not before.
      return `Reply STOP to opt out, HELP for help. Msg&data rates may apply.`;

    case 'email': {
      // CAN-SPAM: physical postal address + clear, working opt-out.
      const unsub = input.unsubscribeUrl ?? '{{UNSUBSCRIBE_URL}}';
      return (
        `${input.disclosure.agencyLegalName}\n` +
        `${input.disclosure.agencyPostalAddress}\n\n` +
        `Don't want these emails? Unsubscribe: ${unsub}`
      );
    }

    case 'ai_voice':
    case 'human_voice':
      // Voice disclosure is composed by the compliance gate and carried on the
      // DialAuthorization; there is no separate footer.
      return '';
  }
}

/**
 * Evaluate whether one message may be sent on one channel, right now.
 *
 * For `ai_voice` this delegates to `evaluateGate` so the two paths cannot drift
 * — the voice rules live in exactly one place.
 */
export async function evaluateChannelGate(
  input: ChannelGateInput,
): Promise<ChannelGateResult> {
  const { channel, intent, contact, line, at } = input;

  if (input.killSwitchEngaged) {
    return {
      ok: false,
      failures: [
        { code: 'KILL_SWITCH_ENGAGED', detail: 'Global outreach kill switch engaged.', humanMayDial: false },
      ],
    };
  }

  // ── AI voice delegates entirely to the voice gate ─────────────────────────
  if (channel === 'ai_voice') {
    const voiceInput: GateInput = {
      contact,
      line,
      consents: input.consents,
      licenses: input.licenses,
      ebr: input.ebr,
      medicare: null,
      attempts: input.attempts,
      disclosure: {
        agentDisplayName: input.disclosure.agentDisplayName,
        agencyLegalName: input.disclosure.agencyLegalName,
        agencyNpn: input.disclosure.agencyNpn,
        medicarePlanCount: input.disclosure.medicarePlanCount,
      },
      dncProvider: input.dncProvider,
      at,
      killSwitchEngaged: false,
    };

    const suppression = checkSuppression(input.suppressions, 'ai_voice');
    const voice = await evaluateGate(voiceInput);

    if (!voice.ok || suppression.length > 0) {
      return {
        ok: false,
        failures: [...suppression, ...(voice.ok ? [] : voice.failures)],
      };
    }

    return {
      ok: true,
      authorization: Object.freeze({
        channel,
        intent,
        contactId: contact.id,
        destination: contact.phoneE164,
        line,
        consentId: voice.authorization.consentId,
        consentBasis: voice.authorization.consentBasis,
        evidence: voice.authorization.evidence,
        issuedAt: voice.authorization.issuedAt,
        expiresAt: voice.authorization.expiresAt,
        requiredFooter: voice.authorization.requiredDisclosure,
      }) as unknown as ChannelAuthorization,
    };
  }

  // ── Every other channel ───────────────────────────────────────────────────
  const failures: GateFailure[] = [];

  const destination = channel === 'email' ? (input.emailAddress ?? '') : contact.phoneE164;
  if (channel === 'email' && !EMAIL_RE.test(destination)) {
    return {
      ok: false,
      failures: [
        { code: 'INVALID_PHONE', detail: `"${destination}" is not a usable email address.`, humanMayDial: false },
      ],
    };
  }

  failures.push(...checkSuppression(input.suppressions, channel));
  failures.push(...checkLicensing(input.licenses, contact, line, at));

  const { chosen: consent, failures: consentFailures } = checkChannelConsent(
    channel,
    intent,
    input.consents,
    line,
    at,
  );
  failures.push(...consentFailures);

  const caps = CHANNEL_CAPS[channel];
  if (input.attempts.today >= caps.perDay) {
    failures.push({
      code: 'ATTEMPT_CAP_EXCEEDED',
      detail: `${input.attempts.today} ${channel} attempts today (cap ${caps.perDay}).`,
      humanMayDial: false,
    });
  }
  if (input.attempts.thisWeek >= caps.perWeek) {
    failures.push({
      code: 'ATTEMPT_CAP_EXCEEDED',
      detail: `${input.attempts.thisWeek} ${channel} attempts this week (cap ${caps.perWeek}).`,
      humanMayDial: false,
    });
  }

  // Phone-based channels also carry DNC and quiet hours. Email carries neither:
  // there is no quiet hour for an inbox, and the registry governs calls.
  const scrubVerdicts: unknown[] = [];
  if (channel !== 'email') {
    const scrubbed = await scrub({ contact, at, ebr: input.ebr, provider: input.dncProvider });
    failures.push(...scrubbed.failures);
    scrubVerdicts.push(...scrubbed.verdicts);

    const hours = checkCallingHours({ at, timezone: contact.timezone, stateCode: contact.stateCode });
    if (!hours.allowed) {
      failures.push({
        code: contact.timezone ? 'OUTSIDE_CALLING_HOURS' : 'UNKNOWN_TIMEZONE',
        detail: hours.reason,
        humanMayDial: false,
      });
    }
  }

  if (failures.length > 0) return { ok: false, failures };

  const evidence = Object.freeze({
    channel,
    intent,
    evaluatedAt: at.toISOString(),
    destination,
    stateCode: contact.stateCode,
    consent: consent
      ? { id: consent.id, basis: consent.basis, capturedAt: consent.capturedAt.toISOString() }
      : {
          basis: null,
          note:
            channel === 'email'
              ? 'CAN-SPAM: no prior consent required. Suppression checked.'
              : 'Manual dial: TCPA 227(b) governs automated dialers and artificial ' +
                'voices, not hand-dialled calls. DNC, hours, and licensing checked.',
        },
    suppressionsChecked: input.suppressions.map((s) => s.channel),
    scrub: scrubVerdicts,
    attempts: input.attempts,
  });

  return {
    ok: true,
    authorization: Object.freeze({
      channel,
      intent,
      contactId: contact.id,
      destination,
      line,
      consentId: consent?.id ?? null,
      consentBasis: consent?.basis ?? null,
      evidence,
      issuedAt: at,
      expiresAt: new Date(at.getTime() + AUTHORIZATION_TTL_MS),
      requiredFooter: buildFooter(input),
    }) as unknown as ChannelAuthorization,
  };
}

/**
 * Evaluate every channel at once and report which doors are open.
 *
 * This is the function the triage report and the orchestrator both want. On a
 * typical purchased list it comes back `email: open, everything else: closed`,
 * and `bestConsentPath: 'email'` — which is the whole play.
 */
export async function evaluateReachability(
  input: Omit<ChannelGateInput, 'channel' | 'intent'> & { readonly intent?: MessageIntent },
): Promise<Reachability> {
  const intent = input.intent ?? 'marketing';
  const channels: Channel[] = ['ai_voice', 'human_voice', 'sms', 'email'];

  const entries = await Promise.all(
    channels.map(async (channel) => {
      const result = await evaluateChannelGate({ ...input, channel, intent });
      return [
        channel,
        result.ok
          ? { allowed: true, reason: 'gate passed' }
          : { allowed: false, reason: result.failures.map((f) => f.code).join(', ') },
      ] as const;
    }),
  );

  const map = Object.fromEntries(entries) as Reachability['channels'];

  // Cheapest open channel that can plausibly carry a consent-capture link.
  // Email first: lowest legal bar, no per-message cost worth counting, and a
  // link is more tappable in an inbox than read aloud on a call.
  const bestConsentPath: Channel | null = map.email.allowed
    ? 'email'
    : map.human_voice.allowed
      ? 'human_voice'
      : map.sms.allowed
        ? 'sms'
        : null;

  return { contactId: input.contact.id, channels: map, bestConsentPath };
}
