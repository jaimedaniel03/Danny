# 09 — Lead Triage: what to do with a list of ~300 leads

You have a lead list. Before anything dials, the list gets sorted by what is
legally and economically possible with each row — because on a 300-lead list
the answer is different for nearly every lead, and treating them uniformly is
how both money and law get burned.

---

## Run it

```bash
cp leads/TEMPLATE.csv leads/leads.csv   # then replace with your real rows
npm run leads:triage -- leads/leads.csv --states CA
```

`--states` is the comma-separated list of states you actually hold producer
licenses in. `leads/` and `out/` are gitignored — real lead data never gets
committed.

The only required column is `phone`. Everything else improves the sort:
`state` or `zip` (licensing + calling hours), `consent_basis` and
`consent_proof_url` (the whole ballgame), `email` (the recovery path for the
human queue).

## The four queues

| Queue | Meaning | What happens next |
|---|---|---|
| `ai_ready` | Written consent with proof, licensed state, resolvable timezone | Danny dials — **after** Phase 0 and a live DNC scrub |
| `human_queue` | A licensed human may call; Danny may not | Your biggest queue, almost certainly. Worked by a person after a real DNC scrub |
| `needs_review` | Fixable data problem | Usually minutes of work; fix and re-run |
| `out_of_scope` | Invalid phone, DNC hit, or a state you're not licensed in | Nobody calls. Unlicensed-state rows become a licensing to-do, not a dial |

Three rules the triage applies that are worth knowing about, because they will
look strict:

- **"Written consent" without a proof URL is downgraded to human-only.**
  Written consent you cannot produce in discovery is not written consent in the
  only venue where the distinction matters. If you have the proof somewhere,
  add the link and re-run — the lead comes back.
- **A referral is not consent.** Your customer agreed to things; the person
  they referred agreed to nothing. Referrals are gold — worked by a human.
- **Purchased / unknown provenance = no consent**, whatever the vendor's
  invoice said. Human queue at best.

## What 300 leads is actually worth

Be honest about the arithmetic before spending the list. Assume a realistic
split — most lists that haven't been consent-engineered land roughly here:

| | Share | Count | Realistic outcome |
|---|---|---|---|
| `ai_ready` | ~10% | ~30 | 30 dials ≈ 8–10 conversations ≈ 1–2 appointments |
| `human_queue` | ~70% | ~210 | The real asset. At 15–25% contact: 30–50 conversations |
| `needs_review` | ~15% | ~45 | Half recoverable with 20 minutes of cleanup |
| `out_of_scope` | ~5% | ~15 | Gone. Fine. |

Two conclusions fall out of that table:

**1. Do not spend engineering weeks so an AI can dial 30 numbers.** Thirty
dials is one human afternoon. The AI's value on a 300-lead list is not the 30
it can call — it is the *system* around all 300: instant triage, consent
tracking, the human queue ordered and scrubbed, follow-up email on every
conversation, and speed-to-lead on every *new* lead that arrives with consent
captured properly from day one.

**2. The 210-lead human queue is convertible.** Every human call that goes
anywhere ends with one sentence: *"Want me to have my assistant follow up with
you by phone? I'll text you a link to okay it."* That link is your
consent-capture form. Each signature moves a lead from `human_queue` to
`ai_ready` — permanently, for renewals, cross-sell, and every future campaign.
This is how a 300-lead list becomes an AI-dialable book over a quarter instead
of a spreadsheet that goes stale.

## The order of operations

1. **Triage** (5 minutes) — run the script, read the report.
2. **Fix `needs_review`** (an evening) — mostly missing states and ambiguous
   consent labels.
3. **Scrub `human_queue` against the real DNC registry** before any human
   dials. The script cannot do this without a SAN; see
   [`04-COMPLIANCE.md`](04-COMPLIANCE.md#do-not-call). Human cold calls are
   legal *only* scrubbed.
4. **A licensed human works the queue**, capturing written consent as they go.
5. **Danny dials `ai_ready`** — only after the
   [Phase 0 checklist](04-COMPLIANCE.md#pre-flight-checklist) is complete.
   Thirty leads is also, conveniently, the perfect size for the first
   supervised calling block in [Phase 1](07-ROADMAP.md).

## What the triage deliberately does not do

- **It does not scrub DNC.** It has no SAN. It says so in red on every run.
- **It does not upgrade consent.** No enrichment, no vendor attestation, no
  "the list said TCPA-compliant" makes a row AI-dialable. Only a proof URL does.
- **It does not resolve split-state timezones.** Texas and Florida rows get
  the dominant zone and a review flag; confirm before dialing near the 8am/9pm
  window edges.
