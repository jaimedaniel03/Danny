# Prompt 01 — Tonality transcript

**Runs on:** one call recording (`.mp3` pulled from the dialer)
**Model:** a model with native audio input. Tone is in the waveform, not the text —
running this on an existing text transcript produces confident fiction.
**Output:** a tone-tagged verbatim transcript, stored in `transcripts.utterances`

---

## Why this exists

Text transcripts tell you what was said. Roughly none of why a call died is in
the words. A rep who says "so what I'd love to do is just get you a quick quote"
with a rising terminal pitch and a hedge stack has asked permission to be told
no, and no amount of rereading the sentence shows you that.

This is the input to [Prompt 02](02-tonality-coach.md), which is where the
actual coaching happens. Prompt 01 does not analyze. It observes and tags.

---

## The prompt

```
You are analyzing a recorded sales call. Work from the audio itself, not from
any text you may have seen.

1. Label each speaker [REP] and [PROSPECT] and timestamp every turn as [mm:ss].

2. After each line add a tonality tag covering:
   - terminal pitch direction (rising / falling / flat)
   - pace against that speaker's own baseline for this call, as a percentage
   - energy against the other speaker's running level, in relative terms
   - hedge words quoted exactly as spoken
   - any pause longer than one second, with its duration

3. Mark every moment the rep's tone changes mid-sentence, and say what changed.

4. Flag the timestamp where the prospect's tone first turns, and quote the rep
   line immediately before it.

5. Do not paraphrase. Do not fix grammar. Do not clean up filler words. Keep
   "um", "uh", false starts, and self-interruptions exactly as spoken. Verbatim
   means verbatim.

6. End with three lines: rep average energy, prospect average energy, and the gap.
```

---

## Insurance-specific additions

Append these to the prompt above. They target the four places insurance calls
actually break, which are not the same places generic sales calls break.

```
7. Flag every price delivery separately. For each moment a number is spoken,
   note the pitch contour across the number itself and the length of silence
   immediately after it. Mark whether the rep held the silence or filled it.

8. Flag every compliance utterance — the AI disclosure, the recording notice,
   and on Medicare calls the CMS disclaimer. For each, note whether pace
   increased relative to the surrounding speech. A disclosure read faster than
   the sales copy around it is a disclosure the listener did not absorb, and
   regulators treat delivery as part of adequacy.

9. Flag every moment the rep introduces a coverage term (deductible, limit,
   rider, elimination period, coinsurance). Note whether the prospect's next
   turn shows comprehension or confusion — pace drop, rising pitch, a hedge, or
   a clarifying question.

10. Note every instance of the rep speaking over the prospect, with timestamp
    and who yielded.
```

---

## Why the "hold the silence" tag matters most

Across insurance call libraries, one behaviour separates reps who close from
reps who don't more cleanly than any other single variable: what happens in the
two seconds after the premium is spoken.

The rep who says "four ninety-two a month" and stops has made an offer. The rep
who says "four ninety-two a month, but I mean that's before we look at the
bundling discount and honestly there's a few other things we could do" has
apologized for their own price before the prospect has reacted to it — and has
told the prospect the number is negotiable, which means it will now be
negotiated.

Tag it, count it, and it becomes coachable. That is the entire point of
building this pipeline rather than buying a call-scoring product that returns
a number between 1 and 10.
