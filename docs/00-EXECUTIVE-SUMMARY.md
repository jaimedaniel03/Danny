# 00 — Executive Summary

---

## What was asked for

An AI calling agent for home, auto, business, health, and life insurance. Every
connector wired in. Voice cloning via Fish Audio. A full blueprint, a Bay Area VC
and CEO critical breakdown, a foundation, and a timeframe.

## What is here

All of it, plus one substantive disagreement with the default shape of the idea —
stated up front rather than buried, because the disagreement is the most useful
thing in the package.

---

## The three findings that reorganized the design

### 1. The legal constraint is not a footnote. It is the architecture.

An AI voice is an **artificial voice** under TCPA §227(b) — the FCC said so
explicitly in February 2024. Artificial voice to a wireless number requires
**prior express written consent**. Statutory damages are $500 per call, $1,500
for willful violations, uncapped, with a private right of action and a mature
plaintiff's bar.

10,000 dials with defective consent is a **$5M–$15M** exposure.

So the compliance gate is not a hardening pass scheduled for later. It is the
first module in the repo, it has no override flag, and CI blocks any merge that
weakens it. `src/compliance/gate.ts`, 40 self-tests, all green.

### 2. The economics say the opposite of what the demo says

**A cold auto policy costs roughly $3,000 to acquire and pays roughly $230.**

Not because AI calling is expensive — the AI is $15 of that $3,000. Because
**leads** are 99.5% of the cost, and an AI dialer applied to a purchased-lead
funnel does not fix the economics. It burns your lead supply ten times faster at
the same loss rate.

The product therefore cannot be "call more." It has to be "call the leads that
cost nothing": your existing book, your own web forms, your inbound calls, and
referrals.

### 3. Those are the same leads where consent is clean

This is the finding that makes the whole thing work. The compliance-safe path and
the profitable path are **the same path**. The gate is not a tax on the product;
it is a map of where the product works.

Own-book cross-sell: $0 lead cost, 25–40% contact rate, ~40x return on variable
cost, and written consent obtainable at policy issue and renewal.

Cold purchased leads: illegal without written consent, unprofitable with it.

---

## What to build

**An AI producer that works an agency's existing book and its own inbound leads**,
under a consent architecture that is a genuine competitive asset, sold to
agencies as software while the productivity multiple is proven on the founder's
own P&L.

Five lines, ranked by whether an AI call pays for itself:

| Motion | Verdict |
|---|---|
| Own-book cross-sell & renewal retention | **Build first.** Profitable day one, zero lead cost |
| Speed-to-lead on owned forms | **Build.** Latency — 11 seconds, 2am, Sunday — is the real advantage |
| Medicare | Strong LTV (~$1,600). Only with licensing, appointments, and counsel |
| Final expense | Good ratio. High reputational exposure with a senior audience |
| Commercial | Appointment-setting only. Humans close |
| Cold purchased leads | **Don't** |

---

## Connectors

22 mapped. **6 CORE, 7 SUPPORTING, 5 MARGINAL, 2 CUT.**

Build the six core ones. Add supporting when a design partner asks by name. Leave
marginal behind a flag. Never build Indeed or Otto Travel.

The argument against wiring all 22: each is a token to rotate, a schema that
changes, a vendor outage that becomes yours, and a row in the data-processing
inventory a carrier will inspect before appointing you. Nine touch PII, four
could touch PHI. Twenty-two live integrations and one engineer is not ambition.

Full reasoning in [`02-CONNECTOR-MAP.md`](02-CONNECTOR-MAP.md).

---

## Timeframe

| Phase | Window | Exit gate |
|---|---|---|
| **0 — Foundation** | Weeks 1–2 | Counsel, DNC SAN, E&O with TCPA coverage, licenses, voice release, gate green in CI. **Nothing dials.** |
| **1 — Speed-to-lead** | Weeks 3–6 | 100 calls, one line, your own book, zero incidents, >30% contact |
| **2 — Own-book cross-sell** | Weeks 7–12 | "Danny bound N policies last month at $X each" from your own P&L |
| **3 — Design partners** | Months 4–6 | 10 agencies, 3 renew unprompted |
| **4 — AMS integrations** | Months 7–9 | 2 AMS connectors shipped, 20–30 agencies |
| **5 — Choose the shape** | Months 10–12 | SaaS, enterprise, or agency rollup |

Twelve-month target: **zero compliance incidents**, 20–30 agencies, $200k–400k
ARR, cost per bound policy under $150, 13-month persistency above 85%.

**May slip:** dashboard, extra lines, extra connectors, design polish.
**May not slip:** the gate, the consent ledger, the audit trail, retention jobs,
the kill switch.

---

## The VC verdict, compressed

The default version of this idea — an AI cold-calling purchased insurance leads
in a cloned voice — is illegal without written consent, unprofitable with it,
undifferentiated against a dozen funded competitors (Vapi, Retell, Bland,
Synthflow, Air.ai), sold to the hardest SMB segment in America, in a category
public markets just repriced by 90%.

The version worth building is narrower and much better, and there are three
shapes it can take:

- **A — Vertical SaaS to agencies.** Right starting shape, ~$10M ARR ceiling.
- **B — Sell to carriers and MGAs.** Venture-scale ACV, 12–18 month cycles, needs a logo first.
- **C — AI-native agency rollup.** Don't sell the software — buy books at 6–10× EBITDA and run them at the productivity multiple. Highest ceiling, hardest execution, and the most interesting version if the founder is already a licensed producer.

**Recommendation: A as the wedge, C as the stated destination.** Prove it on your
own book first — that costs nothing and is the only evidence anyone believes.

Full teardown, including the six questions you will be asked and what a bad
answer sounds like: [`06-VC-TEARDOWN.md`](06-VC-TEARDOWN.md).

---

## Status, honestly

**Built and verified** — 450 tests passing, typecheck and lint clean
(`npm run verify`):

*Compliance*
- Gate: consent basis, DNC ×4, calling hours with state overrides and DST,
  licensing by state and class, Medicare permission-to-contact, attempt caps,
  kill switch. Failures carry `humanMayDial` so leads route to a human queue.
- Disclosure composition spoken by the runtime before the model is invoked:
  AI identity, recording, and — in all-party states — an explicit ask for
  recording consent, which a clear "no" ends the call rather than overriding.
- In-call detection of DNC requests, requests for a human, recording refusals,
  and wrong-party answers, all evaluated on the raw transcript before the model
  is invoked at all.
- Lead provenance: contacts from prospecting databases can never be AI-dialed,
  enforced in the gate ahead of consent and routed to the human queue.

*Lead intake*
- Triage CLI: raw CSV → four queues, every lead run through the real gate.
  US phone normalization, ZIP→state inference, split-timezone flagging.
- Consent-link generator: signed, expiring links for the human queue.

*Consent capture*
- HMAC-signed tokens with the phone number **inside the signed payload**, so
  the form cannot change what is being consented to.
- Versioned disclosure language that refuses to render unreviewed text in
  production.
- Capture page + API writing an append-only ledger row with resolved verbatim
  text, IP, user-agent, and E-SIGN signature.

*Channels — text, email, call*
- Channel gate: three statutes, three consent bars, enforced separately. Email
  and manual calls need no consent; promotional SMS needs the same written
  consent as an AI call.
- `evaluateReachability()` reports which doors are open per contact and names
  the cheapest path to consent — usually email.
- SMS: STOP/HELP/START, runtime-appended opt-out footer, GSM-7 segment
  analysis, 10DLC registration enforced.
- Email: CAN-SPAM validation, signed unsubscribe tokens, RFC 8058 one-click.
- Outreach ladders that lead with email when consent is absent and with the AI
  call once it exists.

*Voice loop*
- Twilio layer where `placeCall` accepts only a `DialAuthorization` — dialing
  without the gate is a compile error, not a review comment.
- Media-stream server: μ-law codec, 20ms framing, barge-in with mark-based
  tracking of what the prospect *actually heard*.
- Brain: streaming turns with per-sentence guardrail checks before synthesis,
  prompt caching on the stable system block, `effort: low` for turn latency.
- Deepgram STT with state-dependent endpointing.
- Dialer: the seam that runs profile → gate → audit row → dial → registry, with
  the audit row written *before* the dial, never after.
- Single-use call registry, so one authorization cannot start two sessions.
- Call ledger: the record is opened when Twilio accepts the origination and
  finalized from the media server's own view, so the disposition, cost, and
  retention date all land on a row that exists. A do-not-call request reaches
  the suppression ledger in-turn, not within the ten business days the law
  allows.
- Five Twilio webhook routes (voice, status, AMD, recording, SMS status) behind
  one shared verification path — signature plus shared secret, compared in
  constant time. SMS status detects carrier filtering, which otherwise looks
  exactly like successful delivery.
- `npm run media` and `npm run call:dry` both run end-to-end without a Twilio
  account: dry run is the default and substitutes labelled placeholders.

*Own book*
- Retention-weighted opportunity ranking: monoline 0.80 → bundled 0.94 →
  with life 0.97, so a home bundle on an auto-only household is scored as the
  retention play it is rather than as first-year commission.
- EBR evidence dates computed from renewal history, driving the DNC-registry
  exemption.

*Coaching*
- The two tonality prompts as code, with the specific checks — held the silence
  after price, rushed the disclosure — run against transcripts.

**Deliberately not implemented:** carrier quoting. `src/quoting/port.ts` defines
the shape and its default adapter *refuses*. Every rating API is per-carrier and
gated behind an appointment, and a stub returning plausible premiums is worse
than nothing — a fabricated number spoken out loud is a misrepresentation, and
one that sounds right is worse than one that obviously isn't.

**Not built:** producer dashboard, AMS integrations, multi-tenant admin beyond
the schema.

**External, and not ours to finish:** live credentials (Twilio, Fish, Deepgram,
Anthropic), a DNC SAN for real scrubbing, A2P 10DLC registration, and counsel's
review of the disclosure language. The code refuses rather than pretends in all
four cases — the DNC provider reports *listed* when a scrub is unavailable, and
consent will not render under unreviewed text in production.

**Not dialed:** nothing in this repo has called a live number, and nothing
should until Phase 0's checklist is complete.

## One thing needed from you

Your phone number was mentioned but not provided. It goes in `TWILIO_CALLER_ID`
in `.env.local` — and before it dials anything it needs STIR/SHAKEN attestation
and registration with the Free Caller Registry, or carrier analytics will
spam-flag it within weeks and take your contact rate to near zero.

That failure mode is slow, quiet, and gets blamed on the product. Worth doing
first.
