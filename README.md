# Danny

**An AI producer for insurance agencies.** Danny calls, qualifies, quotes, and books
appointments across Home, Auto, Business, Health, and Life — in a cloned human voice,
under a compliance gate that refuses to dial anything it cannot legally dial.

---

## The one-paragraph version

Most insurance agencies sit on a book of 500–5,000 policies and never call it. Renewals
lapse, auto-only households never get a home bundle, and nobody ever attaches a term life
policy to the 34-year-old who just insured a minivan. Danny works that book: it dials
consented contacts, holds a real conversation in the agency principal's own cloned voice,
pulls a quote, and hands a warm, licensed-ready prospect to a human. Cold outbound is
supported but **gated**, because on a $180/year auto commission cold AI dialing is both
illegal without written consent and unprofitable with it. See
[`docs/05-UNIT-ECONOMICS.md`](docs/05-UNIT-ECONOMICS.md) — that math drives the entire product.

---

## Read these in order

| # | Document | What it settles |
|---|---|---|
| 00 | [Executive Summary](docs/00-EXECUTIVE-SUMMARY.md) | What we're building and why this shape |
| 01 | [System Blueprint](docs/01-BLUEPRINT.md) | Full architecture, every subsystem, data flow |
| 02 | [Connector Map](docs/02-CONNECTOR-MAP.md) | All 21 connectors — role, verdict, integration point |
| 03 | [Voice Pipeline](docs/03-VOICE-PIPELINE.md) | Fish Audio cloning, STT, barge-in, latency budget |
| 04 | [Compliance Foundation](docs/04-COMPLIANCE.md) | TCPA, DNC, AI disclosure, recording, licensing, CMS |
| 05 | [Unit Economics](docs/05-UNIT-ECONOMICS.md) | Cost per call → cost per bound policy, by line |
| 06 | [VC & CEO Teardown](docs/06-VC-TEARDOWN.md) | The critical breakdown. Read this one twice. |
| 07 | [Roadmap & Timeframe](docs/07-ROADMAP.md) | Week-by-week to revenue, then to a seed round |
| 08 | [Data Model](docs/08-DATA-MODEL.md) | Schema, retention, RLS, audit trail |

---

## Architecture at a glance

```
                    ┌─────────────────────────────────────────┐
   Lead sources ───►│  INGEST  Apollo · Vibe · Sprouts · Forms │
                    └────────────────────┬────────────────────┘
                                         ▼
                    ┌─────────────────────────────────────────┐
                    │  COMPLIANCE GATE  (hard stop, no bypass) │
                    │  consent · DNC · hours · state · license │
                    └────────────────────┬────────────────────┘
                                    PASS │ FAIL ──► quarantine + audit
                                         ▼
   ┌──────────┐     ┌─────────────────────────────────────────┐
   │ Twilio   │◄───►│  VOICE LOOP                              │
   │ +1 num   │     │  Deepgram STT → Claude brain → Fish TTS   │
   └──────────┘     │  barge-in · <800ms turn · disclosure 1st  │
                    └────────────────────┬────────────────────┘
                                         ▼
                    ┌─────────────────────────────────────────┐
                    │  OUTCOMES  quote · appt · transfer · DNC  │
                    └────────────────────┬────────────────────┘
                                         ▼
      HubSpot CRM · Supabase · Gmail · Recording+transcript vault
                                         ▼
                    ┌─────────────────────────────────────────┐
                    │  COACH LOOP  tonality tags → weekly diff  │
                    └─────────────────────────────────────────┘
```

---

## Quickstart

```bash
cp .env.example .env.local     # fill in Twilio, Fish, Deepgram, Supabase, Anthropic
npm install
npm run db:migrate             # applies supabase/migrations
npm run compliance:selftest    # MUST pass before any dial
npm run dev
```

`npm run compliance:selftest` is not optional ceremony. It asserts that the gate rejects
every known-bad fixture (no consent, DNC hit, out-of-hours, unlicensed state, missing
disclosure). CI fails the build if any fixture dials.

---

## Non-negotiables

These are enforced in code, not in policy documents:

1. **No consent record → no dial.** `src/compliance/gate.ts` throws. There is no override flag.
2. **AI disclosure is the first sentence.** Injected by the runtime, not by the prompt. A
   prompt can be jailbroken; a string concat cannot.
3. **Every call is recorded, transcribed, and retained** with an immutable consent snapshot.
4. **The voice clone belongs to a real person who signed a release**, stored in `voice_consents`.
5. **A human licensed producer closes.** Danny qualifies and quotes; it does not bind.

---

## Status

Blueprint + foundation scaffold. Nothing here has dialed a live number. See
[`docs/07-ROADMAP.md`](docs/07-ROADMAP.md) for what is real, what is stubbed, and when.
