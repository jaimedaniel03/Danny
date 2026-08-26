# 07 — Roadmap & Timeframe

Twelve months, six phases. Dates assume one technical founder full-time plus a
part-time licensed producer.

The ordering principle: **legal clarity, then one motion proven on your own book,
then everything else.** Every phase has an exit gate. Do not start the next phase
because the calendar says so — start it because the gate is met.

---

## Phase 0 — Foundation · Weeks 1–2

**Nothing dials. Not one test call to a real number.**

This phase is unglamorous, has no demo, and is the single highest-leverage two
weeks in the plan. Skipping it is how this becomes a lawsuit instead of a company.

| Workstream | Deliverable |
|---|---|
| Legal | TCPA-specialist counsel retained. Consent disclosure language drafted and version-stamped. |
| Insurance | E&O + cyber bound, **TCPA coverage confirmed in writing** — many policies exclude it |
| Telecom | DNC SAN active. Litigator scrubbing contracted. Twilio numbers with STIR/SHAKEN. |
| Licensing | Producer licenses verified. `LICENSED_STATES` matches reality exactly. Carrier appointments confirmed. |
| Voice | Voice release signed and countersigned. Reference audio recorded per `ENROLLMENT_SPEC`. |
| Engineering | Gate + self-test green in CI, blocking merge. Supabase schema applied. Kill switch tested. |

**Exit gate:** every box in the [compliance checklist](04-COMPLIANCE.md#pre-flight-checklist)
ticked, `npm run compliance:selftest` green in CI, and counsel has read the
disclosure strings.

---

## Phase 1 — Speed-to-lead, one line, your own book · Weeks 3–6

The narrowest possible thing that works. **Auto only. Your own agency. Your own
web form. Inbound-triggered outbound within 60 seconds.**

Written consent is captured in the same form submission that creates the lead,
so the consent problem is solved by construction rather than by campaign.

**Build:**
- Consent-capture form (Next.js on Vercel) with counsel-approved language
- Twilio inbound + outbound, media streams on a persistent process
- Voice loop: Deepgram → Claude → Fish, under the latency budget
- State machine through `CLOSING`, human transfer on every qualified lead
- Fish voice enrolled and **auditioned over a real PSTN leg** before shipping

**Do not build:** multi-tenancy, a dashboard, other lines, other agencies.

| Target | Value |
|---|---|
| Calls | 100 |
| Compliance incidents | 0 |
| Time to first dial after form submit | < 60s |
| Contact rate | > 30% |
| Turn latency p50 | < 900ms |

**Exit gate:** 100 calls, zero incidents, and you believe the contact rate.

---

## Phase 2 — Own-book cross-sell · Weeks 7–12

The profitable motion. Auto-only households → home bundle, then P&C households →
term life.

Requires the **written-consent campaign** to run in parallel — capture consent at
policy issue, at renewal, and in the service portal. This started informally in
Phase 0 and becomes a tracked workstream here, because it is the constraint on
everything downstream and it compounds over a renewal cycle.

**Build:**
- Home and term-life discovery flows
- Carrier quote integration (start with one carrier's API; the rest is a slog)
- HubSpot bidirectional sync
- Gmail follow-up with quote PDF
- Tonality pipeline live: Prompt 01 on every call, Prompt 02 weekly
- `v_unit_economics` populated with real cost data

| Target | Value |
|---|---|
| Dials against the book | 1,000 |
| Bound policies | 8–12 |
| Cost per bound policy | < $150 |
| Compliance incidents | 0 |

**Exit gate:** you can say "Danny bound N policies last month at $X each" from
your own P&L. This sentence is the entire asset. Nothing before it convinces
anyone; nothing after it needs to.

---

## Phase 3 — First external design partners · Months 4–6

Ten agencies. Not fifty. Chosen for proximity and patience, not for logo value.

**Build:**
- Multi-tenancy: RLS enforced, per-agency voice models, per-agency licensing
- Producer dashboard: call review, transcript search, disposition queue
- Commercial line (appointment-setting only) with Apollo / Sprouts / Vibe
  prospecting — **human-dialable only**, enforced by `NEVER_AI_DIALABLE_SOURCES`
- MyChatBot widget as a consent front door
- Google Drive document custody for licenses, releases, evidence packs
- Onboarding runbook: a new agency live in under five business days

| Target | Value |
|---|---|
| Agencies live | 10 |
| ARR | $60k–120k |
| Logo churn | < 1 in 10 |
| Compliance incidents | 0 |

**Exit gate:** three agencies renew without being asked, and at least one refers
another. Renewal is the only signal that means anything at this stage.

---

## Phase 4 — The real integration work · Months 7–9

The phase where the moat gets built, and it is not exciting.

**Agency Management System integrations.** Insurance agencies run on Applied
Epic, EZLynx, HawkSoft, and Vertafore AMS360 — not HubSpot. HubSpot got you the
demo; AMS write-access gets you the renewal, and it is genuinely hard, which is
exactly why it is defensible. Budget the entire phase for two of them.

**Also:**
- Coupler + Supermetrics: cost-per-bound-policy reporting agencies actually read
- Medicare line, **only if** licensed, appointed, and counsel-cleared —
  timed to land before AEP (Oct 15)
- Zapier for every stack you refuse to integrate with directly
- Reputation monitoring on the DID pool: contact-rate decay is the silent killer

| Target | Value |
|---|---|
| Agencies live | 20–30 |
| ARR | $200k–350k |
| AMS integrations shipped | 2 |
| 13-month persistency | > 85% |

---

## Phase 5 — Decide what this is · Months 10–12

By now you have twelve months of your own P&L and twenty-plus agencies of
evidence. That is enough to choose between the three shapes in the
[teardown](06-VC-TEARDOWN.md), and not before.

**Shape A — Vertical SaaS.** Hire sales, push toward $1M ARR. Capital-efficient,
probably not a Series B story.

**Shape B — Carriers and MGAs.** Raise $3–5M, eighteen months of runway, one
enterprise logo. Only viable with Phase 3–4 references.

**Shape C — AI-native agency rollup.** Stop selling software. Buy books at 6–10×
EBITDA and run them at the productivity multiple you have now proven. Highest
ceiling. Different investor, different founder profile, needs debt and M&A
capability.

The Phase 2 exit sentence is what makes any of these arguable. Guard it.

---

## The twelve-month scorecard

| Metric | Target | Why this one |
|---|---|---|
| **Compliance incidents** | **0** | The only metric that can end the company |
| Contact rate (own book) | > 25% | Everything else is downstream |
| Cost per bound policy | < $150 | vs. $216+ first-year home commission |
| 13-month persistency | > 85% | Chargebacks reverse revenue you already booked |
| Agencies live | 20–30 | Enough for a pattern, few enough to service |
| ARR | $200k–400k | Modest, real, honest |

---

## What is allowed to slip, and what is not

**May slip:** the dashboard, additional lines, additional connectors, design
polish, the second AMS integration, anything on the marketing site.

**May not slip:** the gate, the consent ledger, the audit trail, retention jobs,
the kill switch, `compliance:selftest` green in CI.

If you are behind, cut features. Never cut controls. A late product is a
problem; an unaudited dial is an extinction event.

---

## The four things most likely to blow the schedule

1. **Carrier quote APIs.** Every carrier is different, documentation is poor,
   and access requires an appointment plus a technical review. Budget 3× your
   estimate. Start the access conversations in Phase 1, months before you need them.
2. **Voice quality over the 8kHz codec.** A clone that sounds perfect in your
   headphones can sound wrong on a phone. Audition over a real PSTN leg early —
   discovering this in Phase 3 costs a re-enrollment and a month.
3. **The written-consent campaign.** Non-engineering, unglamorous, gates
   everything in Phase 2, and takes a renewal cycle to compound. Start it in
   Phase 0.
4. **Counsel turnaround.** Two weeks for a disclosure review is normal. Queue
   legal work before you need it, always.
