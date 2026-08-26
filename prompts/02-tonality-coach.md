# Prompt 02 — Tonality coach

**Runs on:** every tone-tagged transcript from [Prompt 01](01-tonality-transcript.md)
**Model:** `DANNY_ANALYSIS_MODEL` — quality matters more than latency here
**Cadence:** weekly, on the trailing 50 calls
**Output:** three ranked mistakes with rewritten lines, delivered before the next
call block

---

## The prompt

```
You are reviewing my last 50 tone-tagged sales call transcripts.

1. Rank my three most repeated tonality mistakes by how often they appear in the
   sixty seconds before a hang-up.

2. For each one, quote three real lines from my transcripts, with timestamps.

3. Rewrite each line the way I should have said it. Same words, different
   delivery.

4. Describe that delivery in one sentence I can actually execute: pitch, pace,
   pause, volume.

5. Find the single line across all 50 calls where my tone worked best, and say
   why.

6. Name one drill I can run in ten minutes before tomorrow's block. No
   compliments, no summary.
```

---

## Why "same words, different delivery" is the constraint that makes this work

Most call coaching rewrites the script. That fails for a specific, boring
reason: the rep already believes their script is fine, and being handed new
words reads as being told they were stupid. They revert within a week.

Holding the words fixed and changing only the delivery does two things. It makes
the feedback non-threatening — you weren't wrong, you were quiet in the wrong
place. And it makes the change executable in a single rehearsal, because the rep
does not have to memorize anything new. Adoption is the whole game with coaching
tooling, and this constraint is the reason this prompt gets used past week two.

---

## Feeding it back into the agent

The coaching loop has a second consumer that a human coaching program doesn't:
**Danny itself.**

When Prompt 02 surfaces a repeated failure — say, energy collapsing right before
a price is delivered — the fix for a human is a drill. The fix for the agent is a
config change:

| Finding | Human fix | Agent fix |
|---|---|---|
| Energy drops before price | Drill: say the number, then stop | Insert a 900ms silence after price synthesis; raise TTS energy on the price token |
| Terminal pitch rises on the close | Drill: land the last word down | Post-process the closing utterance's pitch contour |
| Hedge stack before the ask | Drill: cut the preamble | Add hedge patterns to the guardrail filter; regenerate on match |
| Disclosure read fast | Drill: read it at conversation pace | Force a fixed speaking rate on disclosure audio; it is pre-synthesized anyway |
| Talking over the prospect | Drill: wait a beat | Raise the VAD endpointing threshold by 100ms |

This is the part of the system that compounds. Every call produces a transcript,
every transcript feeds the coach, and the coach's findings become configuration
that makes the next thousand calls slightly better. A competitor can buy the
same TTS vendor and the same LLM. They cannot buy your call library.

Which is also the honest answer to the "what's the moat" question in
[the VC teardown](../docs/06-VC-TEARDOWN.md) — and the honest caveat is that
this moat takes about 20,000 calls to become real, which is nine to twelve
months of a single agency's volume.

---

## Guard against the obvious failure

Do not let the coach optimize toward "prospect stayed on the phone longer."
Optimize toward **bound policies per hundred dials**, joined through
`v_unit_economics`. A tone that keeps people talking and never closes is worse
than a tone that gets to no in ninety seconds — the second one is cheaper.
