/**
 * Channel orchestration — what to send, on which channel, in what order.
 *
 * ── The sequence, and why it runs this way ──────────────────────────────────
 * The naive sequence is call → text → email, because that is the order of
 * perceived directness. It is exactly backwards for a cold-ish list, on both
 * legal and economic grounds:
 *
 *   1. EMAIL FIRST. It is the only channel open without prior consent, it
 *      costs ~$0.0004 a message, and a tappable consent link converts better
 *      in an inbox than a URL read aloud on a call.
 *   2. HUMAN CALL SECOND, for leads worth a person's time. A licensed human
 *      may dial on a far wider consent basis than Danny can, and the call ends
 *      by asking permission to follow up — which is the consent capture.
 *   3. SMS THIRD, and only after written consent exists. A promotional text
 *      carries the same TCPA bar as an AI call with none of the conversational
 *      upside.
 *   4. AI VOICE LAST — not because it is least valuable, but because it is the
 *      only channel that *requires* the consent the first three exist to
 *      collect. Once consent is in hand it becomes the cheapest channel per
 *      conversation, and the sequence flips permanently for that contact.
 *
 * Every step's real job is to move a contact one rung up the consent ladder.
 * The ladder is the product.
 */

import type { Channel, ChannelAuthorization, MessageIntent, Reachability } from './types';
import type { LineOfBusiness } from '@/types';

export type OutreachGoal =
  /** Collect written consent so the AI channels open. */
  | 'capture_consent'
  /** Book time with a licensed producer. */
  | 'book_appointment'
  /** Service an existing policy — renewal, review, document. */
  | 'service'
  /** Follow up on something already in flight. */
  | 'follow_up';

export interface OutreachStep {
  readonly channel: Channel;
  readonly intent: MessageIntent;
  readonly goal: OutreachGoal;
  /** Hours to wait after the previous step before attempting this one. */
  readonly delayHours: number;
  readonly rationale: string;
}

/**
 * The default cadence for a lead with no written consent — which is most of a
 * purchased or aged list.
 *
 * Deliberately short: five touches over eleven days. Longer sequences do not
 * convert better on insurance leads, they just accumulate complaints, and
 * complaint rate is what gets your DIDs flagged and your domain throttled.
 */
export const CONSENT_LADDER: readonly OutreachStep[] = [
  {
    channel: 'email',
    intent: 'marketing',
    goal: 'capture_consent',
    delayHours: 0,
    rationale:
      'Only channel open without prior consent. Carries the consent link at ' +
      'effectively zero marginal cost.',
  },
  {
    channel: 'human_voice',
    intent: 'marketing',
    goal: 'capture_consent',
    delayHours: 24,
    rationale:
      'A licensed human may dial on a far wider consent basis than the AI. The ' +
      'call ends by asking permission to follow up — that ask is the capture.',
  },
  {
    channel: 'email',
    intent: 'marketing',
    goal: 'capture_consent',
    delayHours: 72,
    rationale: 'Second touch. Different angle, same link. Most consent arrives here.',
  },
  {
    channel: 'human_voice',
    intent: 'marketing',
    goal: 'book_appointment',
    delayHours: 96,
    rationale: 'Final human attempt before the lead rests.',
  },
  {
    channel: 'email',
    intent: 'marketing',
    goal: 'follow_up',
    delayHours: 168,
    rationale: 'Break-up email. Highest reply rate of the sequence, and it ends the cadence cleanly.',
  },
];

/**
 * The cadence once written consent exists. Completely different shape: the AI
 * leads, because it is now both permitted and by far the cheapest way to have
 * an actual conversation.
 */
export const CONSENTED_LADDER: readonly OutreachStep[] = [
  {
    channel: 'ai_voice',
    intent: 'marketing',
    goal: 'book_appointment',
    delayHours: 0,
    rationale: 'Written consent is on file. ~$0.15 per conversation, 24/7, no queue.',
  },
  {
    channel: 'sms',
    intent: 'transactional',
    goal: 'follow_up',
    delayHours: 2,
    rationale: 'Recap and a booking link, sent right after the call while it is fresh.',
  },
  {
    channel: 'email',
    intent: 'transactional',
    goal: 'follow_up',
    delayHours: 24,
    rationale: 'The quote in writing. Also the artifact they forward to a spouse.',
  },
  {
    channel: 'ai_voice',
    intent: 'marketing',
    goal: 'book_appointment',
    delayHours: 72,
    rationale: 'Second attempt if the first did not connect.',
  },
];

/** Speed-to-lead: minutes matter, so this one is measured in minutes. */
export const SPEED_TO_LEAD_LADDER: readonly OutreachStep[] = [
  {
    channel: 'ai_voice',
    intent: 'transactional',
    goal: 'book_appointment',
    delayHours: 0,
    rationale:
      'Their form submission is the consent AND the trigger. Contact rate is ' +
      '40–50% under one minute and 5–10% after thirty. Dial in seconds.',
  },
  {
    channel: 'sms',
    intent: 'transactional',
    goal: 'follow_up',
    delayHours: 0.1,
    rationale: 'Six minutes later if the call did not connect. They just asked; this is expected.',
  },
  {
    channel: 'email',
    intent: 'transactional',
    goal: 'follow_up',
    delayHours: 1,
    rationale: 'The quote in writing, an hour out.',
  },
];

export function selectLadder(input: {
  readonly hasWrittenConsent: boolean;
  readonly isInboundLead: boolean;
}): readonly OutreachStep[] {
  if (input.isInboundLead) return SPEED_TO_LEAD_LADDER;
  return input.hasWrittenConsent ? CONSENTED_LADDER : CONSENT_LADDER;
}

// ─────────────────────────────────────────────────────────────
// Planning
// ─────────────────────────────────────────────────────────────

export interface PlannedStep extends OutreachStep {
  readonly scheduledFor: Date;
  readonly viable: boolean;
  readonly blockedReason: string | null;
}

/**
 * Turn a ladder into a dated plan, marking steps the gate would currently
 * refuse.
 *
 * Blocked steps are kept in the plan rather than filtered out, deliberately.
 * A plan that silently omits the AI call is indistinguishable from one where
 * the AI call was never considered, and "why didn't it call them?" is the
 * question this is meant to answer at a glance.
 */
export function planOutreach(input: {
  readonly reachability: Reachability;
  readonly ladder: readonly OutreachStep[];
  readonly startAt: Date;
}): readonly PlannedStep[] {
  return input.ladder.map((step) => {
    const channelState = input.reachability.channels[step.channel];
    const scheduledFor = new Date(input.startAt.getTime() + step.delayHours * 3_600_000);

    return {
      ...step,
      scheduledFor,
      viable: channelState.allowed,
      blockedReason: channelState.allowed ? null : channelState.reason,
    };
  });
}

// ─────────────────────────────────────────────────────────────
// Message templates
// ─────────────────────────────────────────────────────────────

/**
 * Templates by goal. Short, plain, and written to be from a person.
 *
 * The consent-capture email is the highest-leverage copy in the product — it
 * is what converts a locked lead into a callable one — so it says exactly what
 * the link does. "Confirm your details" would convert better and would also be
 * a deceptive subject line under CAN-SPAM item 2.
 */
export interface MessageTemplate {
  readonly subject?: string;
  readonly body: string;
}

export function renderTemplate(input: {
  readonly goal: OutreachGoal;
  readonly channel: Channel;
  readonly firstName: string | null;
  readonly line: LineOfBusiness;
  readonly agencyName: string;
  readonly producerName: string;
  readonly consentUrl?: string;
  readonly bookingUrl?: string;
}): MessageTemplate {
  const hi = input.firstName ? `Hi ${input.firstName},` : 'Hi,';
  const lineWord = LINE_WORDS[input.line] ?? 'insurance';

  if (input.goal === 'capture_consent' && input.channel === 'email') {
    return {
      subject: `${lineWord} quote from ${input.agencyName}`,
      body:
        `${hi}\n\n` +
        `I'm ${input.producerName} with ${input.agencyName}. You came through as ` +
        `interested in a ${lineWord} quote, and I'd like to get you one.\n\n` +
        `Quickest way is a short call. If that works, tap here to okay it and ` +
        `I'll have my assistant reach out:\n${input.consentUrl ?? ''}\n\n` +
        `If you'd rather just reply to this email with what you're paying now, ` +
        `that works too.\n\n` +
        `${input.producerName}`,
    };
  }

  if (input.goal === 'capture_consent' && input.channel === 'sms') {
    return {
      body:
        `${hi} ${input.producerName} from ${input.agencyName}. Here's the link to ` +
        `okay a follow-up call about your ${lineWord} quote: ${input.consentUrl ?? ''}`,
    };
  }

  if (input.goal === 'book_appointment') {
    return {
      subject: `Your ${lineWord} quote — ${input.agencyName}`,
      body:
        `${hi}\n\n` +
        `I've got your ${lineWord} numbers ready. Pick a time that works and I'll ` +
        `walk you through them:\n${input.bookingUrl ?? ''}\n\n` +
        `${input.producerName}\n${input.agencyName}`,
    };
  }

  if (input.goal === 'service') {
    return {
      subject: `Your ${lineWord} policy — annual review`,
      body:
        `${hi}\n\n` +
        `Your ${lineWord} policy is coming up for renewal. I'd like to re-shop it ` +
        `and make sure you're still getting the right rate.\n\n` +
        `Reply here or grab a time: ${input.bookingUrl ?? ''}\n\n` +
        `${input.producerName}`,
    };
  }

  // follow_up — the break-up. Short, no guilt, easy to answer.
  return {
    subject: `Should I close this out?`,
    body:
      `${hi}\n\n` +
      `I haven't heard back, so I'll assume the timing isn't right and stop ` +
      `reaching out.\n\n` +
      `If that's wrong, just reply and I'll pick it back up.\n\n` +
      `${input.producerName}\n${input.agencyName}`,
  };
}

const LINE_WORDS: Readonly<Record<LineOfBusiness, string>> = {
  auto: 'auto insurance',
  home: 'home insurance',
  commercial: 'business insurance',
  health_uh65: 'health insurance',
  health_medicare: 'Medicare',
  life_term: 'term life',
  life_permanent: 'life insurance',
  life_final_expense: 'final expense',
};

/**
 * Guard against a whole-ladder mistake: if every step in a plan is blocked, the
 * contact is unreachable and should be reported as such rather than quietly
 * sitting in a queue producing nothing.
 */
export function isUnreachable(plan: readonly PlannedStep[]): boolean {
  return plan.length > 0 && plan.every((s) => !s.viable);
}

export interface ChannelSendResult {
  readonly channel: Channel;
  readonly sent: boolean;
  readonly providerId: string | null;
  readonly reason: string | null;
}

/** Narrow a `ChannelAuthorization` to a specific channel at a call site. */
export function assertChannel(
  auth: ChannelAuthorization,
  channel: Channel,
): ChannelAuthorization {
  if (auth.channel !== channel) {
    throw new Error(`Authorization is for "${auth.channel}", not "${channel}".`);
  }
  return auth;
}
