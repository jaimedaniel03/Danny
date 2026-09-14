# 05 — Unit Economics

> Read this before the blueprint. The architecture is downstream of this math,
> and the math says something uncomfortable that most AI-dialer projects
> discover eleven months in.

---

## The one number that reorganizes the whole product

**A cold auto policy costs roughly $3,000 to acquire and pays roughly $230.**

Not because AI calling is expensive. Because AI calling was never the expensive
part.

Here is the chain, using contact and conversion rates that are on the
optimistic side of what agencies actually see:

| Step | Rate | Dials needed per bound policy |
|---|---|---|
| Dial → live contact | 6.7% | 15 |
| Contact → agreed to quote | 25% | 60 |
| Quote → competitive quote | 40% | 150 |
| Competitive quote → bind | 20% | **~750** |

Round it generously down to 300 dials per bound auto policy on a warm-ish list.

Now price those 300 dials two ways:

| | Cost per dial | 300 dials | Revenue (1st-yr commission) | Result |
|---|---|---|---|---|
| **AI compute + telephony** | $0.05 | **$15** | $230 | **+$215** |
| **Purchased shared auto leads** | $10.00 | **$3,000** | $230 | **−$2,770** |

The AI is 0.5% of the cost structure. The leads are 99.5%.

### What follows from that

An AI dialer applied to a purchased-lead funnel does not fix the economics. It
**burns your lead supply faster at the same loss rate.** Ten times the calling
capacity against a fixed consented lead supply is ten times the speed to the
bottom of the barrel — and then you are paying for leads again.

So the product cannot be "call more." It has to be **"call the leads that cost
nothing."** There are exactly four of those:

1. **Your existing book.** You already own the relationship. Lead cost: $0.
2. **Your own inbound web forms.** You already paid for the click. Marginal cost of
   the *call*: $0.
3. **Inbound phone calls.** They dialed you.
4. **Referrals from the book.** Free and the highest-converting leads that exist.

Every one of those is also, not coincidentally, where clean written consent is
obtainable. The compliance-safe path and the profitable path are the same path.
That is the single most important fact in this document, and it is why the gate
in `src/compliance/gate.ts` is not a tax on the product — it is a map of where
the product works.

---

## Cost per call, built up

At 3.5 minutes of talk time on a connected call:

| Component | Rate | Per connect |
|---|---|---|
| Twilio outbound PSTN | $0.014/min | $0.049 |
| Deepgram Nova streaming STT | ~$0.0077/min | $0.027 |
| LLM turns (~15 turns, cached system prompt) | — | $0.040 |
| Fish Audio TTS (~1,200 chars spoken) | ~$0.015/1k chars | $0.018 |
| Recording storage + transcription | — | $0.010 |
| **Total per connected call** | | **~$0.145** |
| Non-connected dial (ring, no answer) | | ~$0.010 |

**Blended cost per dial at a 30% contact rate:** `(0.30 × 0.145) + (0.70 × 0.010)` ≈ **$0.05**

Two things this table does *not* include, and both are larger than everything in it:

- **Compliance infrastructure.** DNC SAN subscription, litigator scrubbing,
  carrier lookups, and counsel. Budget $1,500–4,000/month fixed regardless of volume.
- **The human producer.** Danny qualifies; a licensed human closes. That human
  costs $50k–90k base or a 30–50% commission split. This is not an AI-replaces-
  humans product and pitching it as one is how you lose a carrier appointment.

---

## By line of business

Ranked by whether an AI call actually pays for itself. Commission figures are
first-year, typical for an independent agency, and vary meaningfully by carrier
and state.

### 1. Own-book cross-sell and retention — **build this first**

| | |
|---|---|
| Lead cost | **$0** |
| Contact rate | 25–40% (they know the agency) |
| Typical play | Auto-only household → home bundle; P&C household → term life |
| Home commission (new) | ~12% of ~$1,800 premium ≈ **$216/yr**, renewing |
| Consent path | Clean — capture written consent at policy issue and renewal |

**1,000 dials against the book:** ~$50 in compute, ~300 conversations,
~10 bound home policies ≈ **$2,160 first-year commission, renewing.**

This is a 40x return on variable cost and it is available to every agency on day
one without buying a single lead. It is also the least glamorous thing in the
product, which is why nobody builds it.

**Retention is the other half.** A 5-point improvement in renewal retention on a
1,500-policy book is worth more than every new sale the agent makes that year,
and it is a call an AI can make well: "your renewal came back $40 higher, here's
why, do you want me to re-shop it."

### 2. Medicare — highest LTV, heaviest regulation

| | |
|---|---|
| MA first-year commission (2025 CMS cap, national) | ~$626 |
| Renewal | ~$313/yr |
| Realistic LTV at ~85% persistency | **~$1,600** |
| Lead cost (inbound call, shared) | $25–60 |
| Seasonality | AEP is **Oct 15 – Dec 7**. Most of the year happens in eight weeks. |

The LTV supports real acquisition spend, which is why every Medicare FMO is
already buying AI dialers. The cost of entry is CMS marketing rules: permission
to contact before any outbound, the verbatim TPMO disclaimer, **all calls
recorded and retained ten years**, and no plan-comparison advice from anyone
unlicensed. `MEDICARE_PTC_MISSING` in the gate is the enforcement point.

Do not enter Medicare in year one unless the founder is already licensed and
appointed. The seasonality alone means a mistake costs you a full year.

### 3. Final expense — good ratio, hard audience

First-year commission runs 100–120% of an annual premium of roughly $720, so
about **$800 per policy** against a $30–50 lead. The ratio is excellent.

The caveat is who answers: the target demographic is 55–80, and an AI voice
calling seniors about death benefits is the single most reputationally exposed
thing in this entire product. Regulators are already looking here. If you build
it, over-disclose and route to a human early.

### 4. Speed-to-lead on your own forms — the highest-leverage call in insurance

Contact rates on a web-form lead collapse with time:

| Response time | Contact rate |
|---|---|
| Under 1 minute | 40–50% |
| Under 5 minutes | 30–40% |
| Over 30 minutes | 5–10% |
| Over 24 hours | 1–3% |

An AI that dials in **eleven seconds**, at 2am, on a Sunday, is worth more than
one that talks well. This is where the technology's actual advantage lives —
not persuasion, *latency*. And because it is your own form, the written consent
is captured in the same submission that creates the lead.

If you build one thing, build this.

### 5. Commercial lines — AI schedules, humans sell

Commission is 12–15% on premiums of $1,200–$3,000, so $150–450 per policy — but
sales cycles run weeks, decisions involve multiple people, and the underwriting
conversation is beyond what an agent should attempt. Danny's role here is
appointment-setting only.

Note the consent problem: Apollo, Sprouts, and Vibe supply *business* contacts
with **no consent whatsoever**. Those numbers are human-dialable after DNC
scrubbing and never AI-dialable.

This is enforced, not merely stated. `Contact.leadSource` is checked against
`NEVER_AI_DIALABLE_SOURCES` in the gate, before consent is even considered, and
the refusal carries `humanMayDial: true` so the lead routes to the human queue
rather than being discarded. A consent record attached to such a contact by an
enrichment step does not override it — buying a record cannot produce written
consent from the person in it, so a consent row on one is a data-quality problem
rather than evidence.

### 6. Cold auto and home from purchased leads — **do not build for this**

The opening table. Negative by roughly $2,770 per policy. Every competitor demo
you will see is built on this motion, which should tell you something about how
long those companies have been measuring outcomes.

---

## Where the whole model breaks

Three sensitivities, in order of how much they matter:

**Contact rate.** Every input is downstream of it. At 30% the model works; at 8%
nothing does. This is why owned-book and speed-to-lead beat everything — they
are the only motions where 30% is achievable. Guard it: rotate DIDs, register
with STIR/SHAKEN, monitor spam-labeling on your numbers weekly. A flagged
caller ID takes contact rate to near zero overnight and no amount of AI quality
compensates.

**Bind rate.** Sensitive to carrier appointments, not to conversation quality. An
agency with four carriers loses to one with fifteen regardless of who calls
better. This is worth saying to a prospective design partner before they blame
the product.

**Persistency.** On life and Medicare, commissions are charged back if a policy
lapses early — typically within 12 months. An AI that is *good at getting yes*
from people who should not have said yes generates chargebacks, and chargebacks
turn a profitable book into a negative one. Optimize the coach loop for **bound
and persisting**, never for conversation length or close rate. See the guard note
at the end of [`prompts/02-tonality-coach.md`](../prompts/02-tonality-coach.md).

---

## The honest summary

| Motion | Verdict |
|---|---|
| Own-book cross-sell & renewal | **Build. Profitable day one, zero lead cost, clean consent.** |
| Speed-to-lead on owned forms | **Build. Latency is the real product advantage.** |
| Medicare AEP | Strong LTV. Enter only with licensing, appointments, and counsel. |
| Final expense | Good ratio. High reputational exposure. |
| Commercial | Appointment-setting only. Human closes. |
| Cold purchased leads | **Don't.** Illegal without written consent, unprofitable with it. |
