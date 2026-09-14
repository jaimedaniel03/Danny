/**
 * The conversation state machine.
 *
 * This is the module that decides when the agent must stop talking, and that is
 * a compliance question before it is a UX one. Two properties matter more than
 * the rest of the file put together:
 *
 *   1. A DNC request and a request for a human are honoured *immediately* and
 *      unconditionally — from any state, at any point, with no "let me just
 *      finish this thought". The whole credibility of the AI disclosure rests
 *      on that promise being kept the instant it is invoked.
 *   2. Nothing the model generates can route around them. Interrupts are
 *      detected on the raw transcript before the model is ever invoked.
 *
 * Most of what follows tests the *phrasings real people use*, because that is
 * where this kind of detector fails. Nobody says "I would like to be placed on
 * your do-not-call list."
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_CALL_SECONDS,
  SILENCE_TIMEOUT_SECONDS,
  TERMINAL_STATES,
  checkGuardrails,
  detectInterrupt,
  dispositionFor,
  interruptTransition,
  transition,
  InvalidTransitionError,
  REQUIRED_DISCOVERY,
  type ConversationState,
  type Signal,
} from './state-machine';
import { LINES_OF_BUSINESS } from '@/types';

function utterance(text: string, over: { elapsed?: number; silent?: number } = {}) {
  return {
    utterance: text,
    elapsedSeconds: over.elapsed ?? 30,
    silentSeconds: over.silent ?? 0,
  };
}

describe('a do-not-call request is recognized the way people actually say it', () => {
  const phrasings = [
    'take me off your list',
    'take me off your fucking list',
    'put me on your do not call list',
    'do not call me again',
    "don't call me again",
    "please don't call me again",
    'stop calling me',
    'stop calling this number',
    'remove me from your list',
    'never call here again',
    'quit calling',
    'lose my number',
    'I want to be on your do not call list',
  ];

  it.each(phrasings)('detects %j', (text) => {
    expect(detectInterrupt(utterance(text))?.kind).toBe('DNC_REQUESTED');
  });

  it('survives the punctuation and casing a transcriber produces', () => {
    for (const text of [
      'TAKE ME OFF YOUR LIST!',
      'Take me off your list.',
      "Please — don't call me again, okay?",
      'stop  calling   me',
    ]) {
      expect(detectInterrupt(utterance(text))?.kind, text).toBe('DNC_REQUESTED');
    }
  });

  it('does not fire on an utterance that merely mentions calling', () => {
    for (const text of [
      'can you call me back tomorrow',
      'I called you last week',
      'my wife handles the calls',
      'what number are you calling from',
    ]) {
      expect(detectInterrupt(utterance(text))?.kind, text).not.toBe('DNC_REQUESTED');
    }
  });
});

describe('a request for a human is recognized, including the ones aimed at the AI', () => {
  const phrasings = [
    'let me talk to a human',
    'I want to speak to a person',
    'can I talk to a real person',
    'put me through to an agent',
    'transfer me to someone',
    'am I talking to a robot',
    'are you a robot',
    'is this a machine',
    'am I talking to a machine',
    'are you a real person',
  ];

  it.each(phrasings)('detects %j', (text) => {
    expect(detectInterrupt(utterance(text))?.kind).toBe('HUMAN_REQUESTED');
  });

  it('errs toward transferring, and that is the right direction to err in', () => {
    // "I already talked to an agent about this" is not strictly a request, and
    // it matches. The cost of the false positive is a producer picking up a
    // call that was going nowhere. The cost of the false negative is an AI
    // continuing to sell to someone who asked for a person, which is the exact
    // conduct the disclosure promises will not happen.
    expect(detectInterrupt(utterance('I already talked to an agent about this'))?.kind).toBe(
      'HUMAN_REQUESTED',
    );
  });

  it('still leaves ordinary conversation alone', () => {
    for (const text of [
      'yeah that sounds about right',
      'my premium went up about two hundred dollars',
      'I have State Farm right now',
      'can you send me something in writing',
      'what was your name again',
    ]) {
      expect(detectInterrupt(utterance(text))?.kind, text).not.toBe('HUMAN_REQUESTED');
    }
  });

  it('routes to a transfer, not to a goodbye', () => {
    const interrupt = detectInterrupt(utterance('let me talk to a human'));
    expect(interrupt).not.toBeNull();
    if (!interrupt) return;
    expect(interruptTransition(interrupt)).toBe('TRANSFERRING');
  });
});

describe('interrupt priority', () => {
  it('puts a DNC request ahead of a request for a human', () => {
    // "Take me off the list, I want to talk to a person" is a removal request
    // with a transfer attached, not the other way round. Getting this backwards
    // means transferring someone who asked to never be contacted again.
    const interrupt = detectInterrupt(utterance('take me off your list, let me talk to a human'));
    expect(interrupt?.kind).toBe('DNC_REQUESTED');
  });

  it('puts both ahead of the duration and silence timeouts', () => {
    const interrupt = detectInterrupt(
      utterance('stop calling me', { elapsed: MAX_CALL_SECONDS + 100, silent: 60 }),
    );
    expect(interrupt?.kind).toBe('DNC_REQUESTED');
  });
});

describe('wrong party', () => {
  it.each([
    'you have the wrong number',
    'wrong number',
    'nobody by that name here',
    'no one here by that name',
    'they dont live here anymore',
    "they don't live here anymore",
    'she passed away last year',
  ])('detects %j', (text) => {
    expect(detectInterrupt(utterance(text))?.kind).toBe('WRONG_PARTY');
  });

  it('closes out rather than transferring — there is nobody to transfer to', () => {
    const interrupt = detectInterrupt(utterance('wrong number'));
    expect(interrupt).not.toBeNull();
    if (!interrupt) return;
    expect(interruptTransition(interrupt)).toBe('CLOSING_OUT');
  });
});

describe('timeouts', () => {
  it('ends a call that has run past the maximum', () => {
    const interrupt = detectInterrupt(utterance('okay', { elapsed: MAX_CALL_SECONDS }));
    expect(interrupt?.kind).toBe('MAX_DURATION');
  });

  it('does not end one a second short of it', () => {
    expect(detectInterrupt(utterance('okay', { elapsed: MAX_CALL_SECONDS - 1 }))).toBeNull();
  });

  it('treats a silent line as dead at the threshold, not past it', () => {
    expect(detectInterrupt(utterance('', { silent: SILENCE_TIMEOUT_SECONDS }))?.kind).toBe(
      'SILENCE_TIMEOUT',
    );
    expect(detectInterrupt(utterance('', { silent: SILENCE_TIMEOUT_SECONDS - 1 }))).toBeNull();
  });
});

describe('every interrupt lands somewhere the agent stops selling', () => {
  it('never returns a state that continues the pitch', () => {
    const selling: ConversationState[] = [
      'DISCOVERY',
      'PRESENTING_QUOTE',
      'CLOSING',
      'HANDLING_OBJECTION',
      'STATING_PURPOSE',
    ];

    const interrupts = [
      { kind: 'DNC_REQUESTED', utterance: 'x' },
      { kind: 'HUMAN_REQUESTED', utterance: 'x' },
      { kind: 'WRONG_PARTY', utterance: 'x' },
      { kind: 'MAX_DURATION', seconds: 700 },
      { kind: 'SILENCE_TIMEOUT', seconds: 12 },
    ] as const;

    for (const interrupt of interrupts) {
      expect(selling).not.toContain(interruptTransition(interrupt));
    }
  });
});

describe('normal transitions', () => {
  it('walks the happy path from disclosure to a booked appointment', () => {
    let state: ConversationState = 'DISCLOSING';
    const path: readonly Signal[] = [
      'DISCLOSURE_SPOKEN',
      'IDENTITY_CONFIRMED',
      'PERMISSION_GRANTED',
      'DISCOVERY_COMPLETE',
      'QUOTE_READY',
      'APPOINTMENT_BOOKED',
    ];

    for (const signal of path) state = transition(state, signal);
    expect(state).toBe('CLOSING_OUT');
  });

  it('treats an unavailable quote as a reason to involve a human, not a dead end', () => {
    // This is the path that runs whenever no carrier adapter is wired, which is
    // every path today. It must not strand the call.
    expect(transition('PRESENTING_QUOTE', 'QUOTE_UNAVAILABLE')).toBe('CLOSING');
  });

  it('accepts a hangup from every non-terminal state', () => {
    const states: ConversationState[] = [
      'DISCLOSING',
      'VERIFYING_IDENTITY',
      'STATING_PURPOSE',
      'DISCOVERY',
      'PRESENTING_QUOTE',
      'HANDLING_OBJECTION',
      'CLOSING',
      'TRANSFERRING',
      'CLOSING_OUT',
      'HONORING_DNC',
    ];

    for (const state of states) {
      expect(transition(state, 'HANGUP'), state).toBe('ENDED');
    }
  });

  it('refuses a signal the current state has no transition for', () => {
    // Throwing beats silently staying put: a state machine that ignores a
    // signal looks like it is working while the call goes nowhere.
    expect(() => transition('DISCLOSING', 'QUOTE_READY')).toThrow(InvalidTransitionError);
    expect(() => transition('ENDED', 'HANGUP')).toThrow(InvalidTransitionError);
  });

  it('lets nothing out of a terminal state except the end of the call', () => {
    for (const state of TERMINAL_STATES) {
      const signals: Signal[] = ['QUOTE_READY', 'INTEREST_CONFIRMED', 'PERMISSION_GRANTED'];
      for (const signal of signals) {
        expect(() => transition(state, signal), `${state} + ${signal}`).toThrow();
      }
    }
  });

  it('cannot reach a selling state from HONORING_DNC', () => {
    // Belt and braces on the property that matters most: once someone has asked
    // to be removed, there is no signal that resumes the pitch.
    const allSignals: Signal[] = [
      'DISCLOSURE_SPOKEN',
      'IDENTITY_CONFIRMED',
      'IDENTITY_DENIED',
      'PERMISSION_GRANTED',
      'PERMISSION_DECLINED',
      'DISCOVERY_COMPLETE',
      'QUOTE_READY',
      'QUOTE_UNAVAILABLE',
      'OBJECTION_RAISED',
      'OBJECTION_RESOLVED',
      'OBJECTION_UNRESOLVED',
      'INTEREST_CONFIRMED',
      'APPOINTMENT_BOOKED',
      'CALLBACK_REQUESTED',
      'TRANSFER_ACCEPTED',
      'TRANSFER_FAILED',
      'HANGUP',
    ];

    for (const signal of allSignals) {
      let next: ConversationState | null = null;
      try {
        next = transition('HONORING_DNC', signal);
      } catch {
        continue;
      }
      expect(next, signal).toBe('ENDED');
    }
  });
});

describe('guardrails catch the sentences that create liability', () => {
  it.each([
    ["You're covered as of today.", 'bind'],
    ['You are now insured under that policy.', 'bind'],
    ["I'm a licensed agent here in California.", 'disclosure'],
    ["I'm a human, I promise.", 'disclosure'],
    ["I'm not an AI.", 'disclosure'],
    ['I guarantee a lower rate.', 'guarantee'],
    ['This will definitely save you money.', 'savings'],
    ['We will save you four hundred dollars.', 'savings'],
    ['Medicare sent me to review your plan.', 'government'],
    ['Your policy is expiring at the end of the month.', 'urgency'],
  ])('flags %j', (line) => {
    expect(checkGuardrails(line).length).toBeGreaterThan(0);
  });

  it('reports why, not just that — the log is read by a compliance officer', () => {
    const violations = checkGuardrails("I'm a licensed agent.");
    expect(violations[0]?.why).toMatch(/disclosure/i);
    expect(violations[0]?.matched).toBeTruthy();
  });

  it('leaves ordinary, accurate sales language alone', () => {
    for (const line of [
      'Based on what you told me, Safeco came back at eighteen hundred a year.',
      "That's subject to underwriting, and a licensed agent will confirm it.",
      'I can have someone call you back this afternoon.',
      'Bundling your home and auto usually brings the auto premium down.',
      'I am an AI assistant calling on behalf of the agency.',
    ]) {
      expect(checkGuardrails(line), line).toEqual([]);
    }
  });
});

describe('disposition reflects what actually happened', () => {
  it('reports a DNC request above everything else that happened on the call', () => {
    // Someone can ask to be removed after booking. The removal is the outcome
    // that governs, and the one the audit trail must show.
    expect(dispositionFor('HONORING_DNC', ['APPOINTMENT_BOOKED', 'QUOTE_READY'])).toBe(
      'do_not_call_requested',
    );
  });

  it.each([
    [['APPOINTMENT_BOOKED'], 'appointment_set'],
    [['TRANSFER_ACCEPTED'], 'transferred_to_human'],
    [['QUOTE_READY'], 'quoted'],
    [['CALLBACK_REQUESTED'], 'callback_requested'],
    [['IDENTITY_DENIED'], 'wrong_number'],
    [['PERMISSION_DECLINED'], 'not_interested'],
    [['OBJECTION_UNRESOLVED'], 'not_interested'],
  ])('maps %j to %s', (history, expected) => {
    expect(dispositionFor('CLOSING_OUT', history as Signal[])).toBe(expected);
  });

  it('does not flatter a call that achieved nothing', () => {
    expect(dispositionFor('CLOSING_OUT', [])).toBe('abandoned_by_agent');
    expect(dispositionFor('ENDED', ['DISCLOSURE_SPOKEN'])).toBe('abandoned_by_agent');
  });
});

describe('discovery requirements', () => {
  it('covers every line of business', () => {
    // A line with no entry would let the machine leave DISCOVERY having asked
    // nothing, and quote against an empty application.
    for (const line of LINES_OF_BUSINESS) {
      expect(REQUIRED_DISCOVERY[line], line).toBeDefined();
      expect(REQUIRED_DISCOVERY[line]?.length, line).toBeGreaterThan(0);
    }
  });
});
