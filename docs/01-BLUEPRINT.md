# 01 — System Blueprint

Full architecture. Read [`05-UNIT-ECONOMICS.md`](05-UNIT-ECONOMICS.md) and
[`04-COMPLIANCE.md`](04-COMPLIANCE.md) first — this document is downstream of both.

---

## Five subsystems

```
┌──────────────────────────────────────────────────────────────────────────┐
│  1. INGEST            Where contacts and consent come from               │
├──────────────────────────────────────────────────────────────────────────┤
│  2. COMPLIANCE GATE   The only path to a dial. No override.              │
├──────────────────────────────────────────────────────────────────────────┤
│  3. VOICE LOOP        Realtime. STT → brain → cloned TTS, under 800ms.   │
├──────────────────────────────────────────────────────────────────────────┤
│  4. OUTCOME           Quote, book, transfer, suppress. Write everywhere. │
├──────────────────────────────────────────────────────────────────────────┤
│  5. COACH             Tonality analysis → config change → better calls.  │
└──────────────────────────────────────────────────────────────────────────┘
```

The important structural property: **1 → 2 → 3 is strictly ordered and
one-directional.** No component in subsystem 3 can reach back and cause a dial.
The dialer's signature accepts a `DialAuthorization`, and the branded type means
only the gate can produce one.

---

## 1. Ingest

Four sources, in descending order of both value and legal cleanliness. That
ordering is not a coincidence — see the economics doc.

| Source | Consent basis | AI-dialable |
|---|---|---|
| Inbound phone call | `inbound_call` | ✅ |
| Own web form with consent language | `prior_express_written` | ✅ |
| Own book of business | `established_business_relationship` | ❌ until written consent is re-captured |
| Purchased / B2B database | varies, usually nothing usable | ❌ |

**The own-book conversion.** Your existing policyholders are the best economics
in the product and are *not* AI-dialable on EBR alone. The fix is a campaign, not
a code change: capture written consent at policy issue, at renewal, and in the
service portal. Every consent captured turns a $0-lead-cost contact into an
AI-dialable one. This is the highest-ROI non-engineering work in the plan and it
should start on day one because it takes a renewal cycle to compound.

**Timezone resolution** happens at ingest, from the mailing address, never from
the area code. Contacts without a resolvable timezone are blocked at the gate,
so resolving them is an ingest-time problem worth solving properly.

## 2. Compliance gate

Single function, `evaluateGate()`. Ten check families:

```
kill switch → E.164 → consent → DNC ×4 → hours → licensing → Medicare → caps
```

Design properties, each deliberate:

- **Every check runs**, even after the first failure. The audit record is the
  product.
- **Failures carry `humanMayDial`.** This routes leads to a human producer queue
  instead of the bin. It is a compliance flag doing revenue work.
- **Authorizations expire in 60 seconds.** A stale authorization forces
  re-evaluation, not a retry — because DNC status and local time both move.
- **Evidence is frozen and stamped with `GATE_VERSION`**, then written to an
  immutable table *before* the dial.
- **No override flag exists.** Not `force: true`, not an admin bypass, not an
  env var. Adding one is the change that ends the company.

## 3. Voice loop

```
   PSTN ──► Twilio Media Stream (8kHz μ-law, WebSocket)
                    │
                    ▼
            ┌───────────────┐
            │  VAD +        │  endpointing ~200ms — the biggest latency lever
            │  Deepgram STT │
            └───────┬───────┘
                    │ final transcript
                    ▼
            ┌───────────────┐
            │  INTERRUPTS   │  ◄── runs BEFORE the model. Cannot be overridden.
            │  DNC? human?  │
            └───────┬───────┘
                    │ no interrupt
                    ▼
            ┌───────────────┐
            │  STATE MACHINE│  decides which state; model decides words
            └───────┬───────┘
                    ▼
            ┌───────────────┐
            │  Claude turn  │  streaming, cut at first sentence boundary
            └───────┬───────┘
                    ▼
            ┌───────────────┐
            │  GUARDRAILS   │  regex filter; regenerate on violation
            └───────┬───────┘
                    ▼
            ┌───────────────┐
            │  Fish TTS     │  cloned voice, 8kHz PCM, streaming
            └───────┬───────┘
                    ▼
              back to Twilio
```

**The latency budget** (target: under 800ms from their last phoneme to our first
audio) is detailed in [`03-VOICE-PIPELINE.md`](03-VOICE-PIPELINE.md). Two
techniques buy most of it back: sentence-level pipelining (start synthesizing
before the model finishes) and pre-warmed opener audio (zero generation latency
on the first thing they hear).

**Where this runs matters.** The media stream needs a persistent WebSocket
process — Fly.io, Railway, or a container. Vercel hosts the control plane and
cannot host the call. Designing as though it can is the most common way this
architecture fails around week six.

## 4. Outcome

Every call terminates in exactly one disposition, and each fans out:

| Disposition | Writes |
|---|---|
| `quoted` | quote row → HubSpot → quote PDF → Gmail follow-up |
| `appointment_set` | calendar → HubSpot task → confirmation email |
| `transferred_to_human` | warm transfer, producer gets live transcript |
| `do_not_call_requested` | **internal DNC immediately**, contact suppressed, confirmation spoken |
| `callback_requested` | scheduled re-dial, re-evaluated through the gate |
| `not_interested` | suppression window, HubSpot stage update |

`do_not_call_requested` is the only one that writes synchronously before the
call ends. Everything else can be eventually consistent.

## 5. Coach

The loop that compounds:

```
recording → Prompt 01 (tonality tags) → transcripts table
                                              │
                                              ▼
                          Prompt 02 (weekly, trailing 50 calls)
                                              │
                            ┌─────────────────┴─────────────────┐
                            ▼                                   ▼
                   human producer drills              agent config changes
                                                (VAD thresholds, TTS prosody,
                                                 guardrail patterns, pacing)
```

This is the only part of the system a competitor cannot buy, and the honest
caveat is that it takes roughly 20,000 calls to become a real advantage — nine
to twelve months of a single agency's volume. Instrument it from call one
anyway, because the data is not reconstructable later.

---

## Data flow, end to end

```
Web form submit
  └─► consent row (append-only, disclosure text + version + IP + UA)
       └─► contact row (timezone resolved from address)
            └─► gate evaluation ──► dial_authorizations row (immutable evidence)
                 └─► Twilio outbound
                      ├─► runtime speaks buildOpeningDisclosure()  ◄── before the model
                      ├─► media stream ⇄ voice loop
                      └─► recording → transcript → tonality tags
                           └─► disposition
                                ├─► quotes / calendar / DNC
                                ├─► HubSpot sync
                                └─► v_unit_economics
```

---

## Technology choices, and the honest reason for each

| Layer | Choice | Why | What would change it |
|---|---|---|---|
| Telephony | Twilio | Media Streams, STIR/SHAKEN, mature | Telnyx is cheaper at volume; revisit past 100k min/mo |
| STT | Deepgram Nova | Best latency/accuracy on 8kHz phone audio | — |
| Brain | Claude Sonnet (turns), Opus (analysis) | Turn latency vs. analysis quality are different jobs | — |
| TTS | Fish Audio | Voice cloning, streaming, cost | ElevenLabs Flash is faster; Cartesia Sonic lower latency. Fish wins on cost-per-clone. Keep the fallback wired. |
| DB | Supabase Postgres | RLS as the tenant boundary, triggers for immutability | — |
| Control plane | Next.js on Vercel | Forms, dashboard, webhooks | — |
| Media plane | Persistent Node process | Vercel cannot hold a WebSocket for a call | — |

---

## What is deliberately not built

- **No autonomous binding.** Danny never binds coverage. A licensed human does.
- **No plan recommendations on health lines.** That is unlicensed advice.
- **No learned call prioritization** in v1. Explicit business rules only —
  a learned ranker needs disparate-impact testing under Colorado SB 21-169 and
  the NAIC bulletin. Earn it later, with documentation.
- **No cold outbound to purchased lists.** Illegal without written consent,
  unprofitable with it. The gate makes this structural rather than a policy
  everyone agrees to and then quietly relaxes.
- **No ringless voicemail.** Courts have treated RVM as a call subject to the
  TCPA, which means the same written-consent requirement applies with none of
  the conversational upside. The tools in the reference screenshots are a
  liability, not a shortcut.
