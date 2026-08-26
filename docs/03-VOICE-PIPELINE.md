# 03 — Voice Pipeline

Fish Audio voice cloning, streaming STT, and the latency budget that decides
whether this sounds like a person or like a robot.

---

## The latency budget

Human turn-taking tolerates roughly **500–800ms** of silence before the other
party feels something is wrong. Past ~1200ms they say "hello?" and the call is
damaged — not failed, damaged, because they now know.

Measured from the prospect's last phoneme to our first audio byte reaching the
carrier:

| Stage | Budget | Notes |
|---|---|---|
| VAD endpointing | ~200ms | **The biggest lever.** Also the most dangerous to tune. |
| Deepgram final transcript | ~80ms | Streaming; interim results arrive much earlier |
| Claude time-to-first-token | 250–400ms | Prompt caching matters more than model size here |
| Fish TTS time-to-first-audio | 150–300ms | Streaming mode, `latency: balanced` |
| Network + jitter + PSTN | ~120ms | Largely fixed |
| **Total** | **800ms–1.1s** | Already at the edge |

### Endpointing is a tradeoff, not a setting

Drop endpointing to 100ms and you interrupt people mid-thought — specifically
mid-*number*, because people pause inside phone numbers and addresses and dollar
amounts, which is most of what an insurance call consists of. Raise it to 400ms
and every turn feels sluggish.

The right answer is context-dependent and is why endpointing lives in the state
machine rather than in a config file:

| State | Endpointing | Reason |
|---|---|---|
| `DISCOVERY` collecting a number | 500ms | People pause inside numbers |
| `DISCOVERY` general | 250ms | Normal conversation |
| `PRESENTING_QUOTE` after the price | 900ms | Deliberate silence — let them react |
| `HANDLING_OBJECTION` | 350ms | Let them finish; interrupting an objection is fatal |

---

## The two techniques that buy back the budget

### 1. Sentence-level pipelining

Do not wait for the LLM to finish the turn. Cut the token stream at the first
sentence boundary and start synthesizing while the model is still writing.

Saves **300–600ms** on a typical turn. Usually the difference between "natural"
and "laggy."

`splitIntoSpeakableChunks()` handles the trap this introduces: abbreviations and
decimals. "Mr." and "$1,250.00" and "St." all contain periods that are not
sentence ends, and splitting on them produces an audible mid-number pause — the
single most common tell that a voice agent is a voice agent.

### 2. Pre-warmed openers

The disclosure and the top handful of responses are synthesized once and cached
as audio. `PREWARM_PHRASES` covers the ~8 utterances that appear in more than 5%
of calls.

The first thing the prospect hears has **zero** generation latency, which sets
their expectation for the whole call. Cache hits cost nothing.

---

## The codec trap

PSTN audio is **8kHz μ-law**. Synthesizing at 44.1kHz and downsampling at the
edge wastes bytes and introduces resampling artifacts on exactly the sibilants
that make a clone sound human.

**Request 8kHz PCM from Fish and hand it to Twilio's media stream directly.**

The corollary, and it costs people a month: **a clone that sounds perfect in your
headphones can sound wrong on a phone.** Audition every candidate model over a
real PSTN leg before shipping it. `voice_models.pstn_auditioned_at` exists to
make skipping this visible.

---

## Voice cloning with Fish Audio

### What moves quality, in order

1. **Recording condition consistency beats duration.** 30 seconds from one good
   mic in one room outperforms 10 minutes stitched from three sources.
2. **Prosodic range.** The reference must contain a question, a statement, and a
   number read aloud. A clone enrolled only on flat declaratives reads "four
   ninety-two a month" like a hostage.
3. **Match the target channel.** Record the reference through a phone call if you
   can, or at minimum audition through one.

`ENROLLMENT_SPEC.referenceScript` in [`src/voice/clone.ts`](../src/voice/clone.ts)
contains five lines covering exactly this prosodic range, written in insurance
vocabulary.

### Enrollment is gated

`enrollmentPreflight()` refuses without a signed release id, refuses audio under
30 seconds or over 10 minutes, and refuses a noise floor above −45 dBFS (the
clone reproduces the room, not just the voice).

`assertReleaseValid()` runs before **every** synthesis, not once at enrollment.
A revoked release stops synthesis mid-call, and the DB trigger disables every
model built from it.

See [`04-COMPLIANCE.md`](04-COMPLIANCE.md#voice-cloning) for why this is
architectural rather than procedural. Short version: the FTC, state
digital-replica statutes, and a $6M FCC forfeiture involving a cloned voice used
without disclosure.

---

## Numbers, which are most of the call

TTS models read `$1,250.00/mo` as "dollar one comma two five zero point zero zero
slash m o" often enough that you cannot ship without a normalizer.
`speakableNumber()` renders "one thousand two hundred fifty dollars a month."

This function does more for perceived quality than the choice of voice model
does, because insurance conversations are almost entirely numbers.

Set `normalize: false` on the Fish request — its own normalizer "helpfully"
rewrites currency and dates in ways that fight this.

---

## Barge-in

The prospect must be able to interrupt. Two behaviours:

**Stop speaking immediately** on detected speech energy above threshold — flush
the audio buffer, do not finish the sentence. An agent that talks over an
interruption is worse than one that pauses awkwardly.

**Keep what was already said.** The prospect heard the first half of your
sentence. The conversation state must reflect what they *heard*, not what you
*intended to say*, or the next turn will be incoherent. Track spoken-so-far by
byte offset against the synthesis buffer, not by what the model generated.

The second one is routinely missed and produces agents that repeat themselves
after every interruption.

---

## Failover

`TTS_FIRST_BYTE_BUDGET_MS` is 400ms. Exceeding it raises `TtsTimeoutError` rather
than being swallowed, and the orchestrator decides whether to switch providers
**for the remainder of that call**.

Switching mid-call means the voice changes, which is jarring. The tradeoff is
deliberate: a voice that changes is survivable, dead air is not. Log every
failover — sustained failover means the primary vendor is degraded and someone
should know before the daily call block.

| Provider | Role | Approx. TTFB |
|---|---|---|
| Fish Audio | Primary — cloning, cost | 150–300ms |
| ElevenLabs Flash v2.5 | Fallback — fastest available | ~75ms |
| Cartesia Sonic | Second fallback | ~90ms |

Keep a cloned voice enrolled with the fallback too. Failing over to a stock voice
mid-call is a worse experience than the latency you were avoiding.

---

## What is not in the pipeline, deliberately

- **No emotion-detection routing.** Inferring emotional state from voice and
  changing the sales approach based on it is a product decision that would need
  disparate-impact analysis under the NAIC AI bulletin, and the accuracy claims
  in this space do not survive scrutiny.
- **No voice-based identity verification.** Voice biometrics for authenticating a
  policyholder is a separate regulated product with its own consent regime.
- **No ringless voicemail.** Courts have treated RVM as a call subject to the
  TCPA — same written-consent requirement, none of the conversational upside.
- **No accent or gender switching per prospect.** Matching a synthetic voice to
  inferred demographics is discriminatory targeting with a technical veneer.
  One agency, one released voice.
