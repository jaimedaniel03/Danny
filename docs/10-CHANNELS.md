# 10 — Text, Email, and Call

Three channels, and the single most useful thing to know about them is that
they are **not** three ways of doing the same thing. They sit under three
different statutes with three different consent bars, and the gap between them
is where the strategy lives.

---

## The bars

| | Statute | Consent needed | Practical bar |
|---|---|---|---|
| **AI voice** | TCPA §227(b) | Prior express **written** | Highest. $500–$1,500/call, uncapped |
| **SMS — promotional** | TCPA §227(b) | Prior express **written** | Same as an AI call |
| **SMS — transactional** | TCPA §227(b) | Prior express, unwritten | Moderate |
| **Human voice (manual dial)** | DNC rules | **None** | DNC scrub + hours + licensing |
| **Email** | CAN-SPAM | **None** | Truthful headers, postal address, working opt-out |

Two rows surprise people.

**A text is a "call."** A promotional SMS to a wireless number carries the exact
same written-consent requirement as an AI voice call. Texting *feels* casual;
the statute does not agree. Having someone's number is not consent.

**A manually dialled call needs no consent.** §227(b) restricts automated
dialers and artificial voices — not a person pressing buttons. Scrub against
DNC, call inside local hours, hold the license, and a human may cold-call. This
is what makes the human queue worth anything.

---

## What follows for a lead list

For a typical purchased or aged list, per lead:

```
email        ██████████  open
human call   ██████████  open   (after DNC scrub)
SMS          ░░░░░░░░░░  closed (no written consent)
AI call      ░░░░░░░░░░  closed (no written consent)
```

**Email is the cheapest legal path to the consent that opens the other two.**
So the consent link goes in an email, not a text — same message, same
conversion, a fraction of the exposure. `evaluateReachability()` returns
`bestConsentPath` for exactly this decision.

---

## The ladders

`src/channels/orchestrator.ts`. Which one runs depends on what consent exists.

**No written consent** — five touches over eleven days, email-led:

| # | Channel | Goal | Delay |
|---|---|---|---|
| 1 | Email | Capture consent | — |
| 2 | Human call | Capture consent | +24h |
| 3 | Email | Capture consent | +72h |
| 4 | Human call | Book appointment | +96h |
| 5 | Email | Break-up | +168h |

No promotional SMS appears anywhere in it, and a test asserts that.

**Written consent on file** — the AI leads, because it is now both permitted
and the cheapest way to have a real conversation (~$0.15):

| # | Channel | Goal | Delay |
|---|---|---|---|
| 1 | AI call | Book appointment | — |
| 2 | SMS | Recap + booking link | +2h |
| 3 | Email | Quote in writing | +24h |
| 4 | AI call | Second attempt | +72h |

**Inbound lead** — the form submission is both the consent and the trigger.
Contact rate is 40–50% under one minute and 5–10% after thirty, so this ladder
is measured in minutes.

---

## What is enforced in code

**Every channel:** suppression (no exemptions, ever), producer licensing —
soliciting insurance in an unlicensed state is a different statute that does
not care about the medium — and frequency caps.

**Phone channels only:** DNC scrub ×4, calling hours with state overrides.
There is no quiet hour for an inbox.

**SMS:** STOP/HELP/START answered on inbound; opt-out footer appended by the
runtime on every message, not just the first. Segment analysis, because a
single curly apostrophe flips a message to UCS-2 and more than doubles the
per-message cost — `normalizeForGsm7` fixes it automatically.

**Email:** CAN-SPAM validation refuses to send without a postal address or an
opt-out, and rejects deceptive subject lines (`Re:` on a message that is not a
reply, false urgency, implied government affiliation). Signed unsubscribe
tokens — a guessable `?id=1041` link lets anyone walk the range and unsubscribe
your whole list silently. RFC 8058 one-click is honoured, because Gmail and
Yahoo throttle bulk senders who ignore it.

---

## A2P 10DLC — the failure that is invisible

Independent of the law, US carriers require every business SMS sender to
register a Brand and a Campaign. **Unregistered traffic is silently filtered**:
your messages appear sent, the delivery receipt says delivered, and nothing
arrives.

That failure mode costs more projects than the TCPA does, precisely because it
produces no error. `sendSms` throws `NotRegisteredError` rather than letting you
discover it three weeks into a campaign.

Set `TWILIO_MESSAGING_SERVICE_SID` to a Messaging Service attached to a
registered Brand and Campaign. Registration takes days, so start it early.
