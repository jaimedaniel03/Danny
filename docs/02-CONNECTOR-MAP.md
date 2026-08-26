# 02 — Connector Map

Every connector available to this project, mapped to a role, with a verdict.
The machine-readable version is [`src/connectors/registry.ts`](../src/connectors/registry.ts);
this document is the reasoning behind it.

**Summary: 22 connectors. 6 CORE, 7 SUPPORTING, 5 MARGINAL, 2 CUT, 2 infrastructure.**

---

## First, the argument against "use every connector"

You asked for all of them, so here are all of them. It is worth stating plainly
why the answer to "which of these should we wire up" is not "yes."

Each integration is an OAuth token to rotate, a rate limit to respect, a schema
that changes without warning, a vendor whose outage becomes your outage, and —
for anything touching consumer insurance data — a row in the data-processing
inventory a carrier will ask to see before appointing you. Nine of these
connectors touch PII. Four could touch PHI.

A system with 22 live integrations and one engineer is not ambitious. It is a
system where nobody knows which vendor broke the thing at 2am.

So: **build the six CORE connectors. Add SUPPORTING when a design partner asks
by name. Leave MARGINAL behind a flag. Never build CUT.**

---

## CORE — the product does not function without these

### Supabase · data platform · Phase 1
System of record: contacts, the consent ledger, calls, transcripts, quotes, the
audit log. Row-level security is the multi-tenant boundary.

> **Caveat.** Consent and transcript tables hold PII and, on health lines, PHI.
> Signed BAA before a single Medicare or ACA call, encryption at rest, and a
> retention job that actually runs. Postgres will happily store a HIPAA
> violation for you forever.

### HubSpot · CRM · Phase 1
Where human producers live. Danny writes outcomes, transcripts, quotes, and
next-action tasks; reads back ownership so it never calls an account a human is
already working.

> **Caveat — and this one matters strategically.** HubSpot is not what agencies
> run on. They run on an AMS: Applied Epic, EZLynx, HawkSoft, Vertafore AMS360.
> HubSpot gets you to a demo. AMS integration gets you a renewal. Budget for two
> AMS connectors in Phase 4 and treat HubSpot as the design-partner path.

### Zapier · automation · Phase 2
The escape hatch. 9,000+ apps means every design partner's odd tool is reachable
on day one without a bespoke integration. This is how you say yes in a sales call
without committing an engineering month.

> **Caveat.** Latency and reliability are both "eventually." Never put a
> compliance check or a consent write behind a Zap. Outcomes and notifications only.

### Gmail · comms · Phase 2
The follow-up leg: quote summary, appointment confirmation, and — most valuable —
the written-consent capture link when a call surfaces a lead Danny is not yet
permitted to call back.

> **Caveat.** Email adds CAN-SPAM on top of TCPA: working unsubscribe, physical
> postal address, honest subject lines, opt-outs honoured in 10 days. Send from a
> dedicated domain with SPF, DKIM, and DMARC — volume from a personal Gmail
> torches your reputation on the first campaign.

### GitHub · infrastructure · Phase 1
Source of truth for code and for the compliance suite. CI runs
`compliance:selftest` on every PR and blocks merge on failure. The commit history
is itself an audit artifact: it shows when each control was introduced and that
none were removed.

> **Caveat.** Branch protection on `main` stops being optional the moment real
> numbers are dialed. A merged PR that weakens the gate is a compliance incident.

### Vercel · infrastructure · Phase 1
Hosts the dashboard, consent-capture forms, and Twilio webhook endpoints. Preview
deploys give each design partner a URL to poke at.

> **Caveat — the architectural trap.** Serverless functions are the wrong shape
> for a live media stream. The voice loop needs a persistent WebSocket process:
> Fly.io, Railway, or a container. Vercel hosts the control plane; something else
> hosts the call. Assuming Vercel does both is how this architecture fails at
> week six.

---

## SUPPORTING — real leverage, after CORE works end to end

### Apollo.io · lead supply · Phase 3
Commercial lines only. Finds owners and CFOs in a target NAICS and revenue band.
Its conversation-intelligence endpoints also give a useful second opinion
alongside our own tonality pipeline.

> **Read twice.** An Apollo contact has given you **no consent**. It is a B2B
> database, not a consent ledger. Human-dialable after DNC scrubbing; never
> AI-dialable. The gate enforces this and it will look like a bug to whoever
> bought the seats.

### Sprouts Data Intelligence · lead supply · Phase 3
Second-source enrichment and ICP scoring for commercial. Phone/email append,
account lookup, intent signals for ranking.

> **Caveat.** Same consent problem, plus an append-specific one: an appended
> phone number has no provenance you can show a court. Permanently
> AI-ineligible.

### Vibe Prospecting · lead supply · Phase 3
Local-business discovery with event triggers. The valuable signal is *timing* — a
new business license, a new location, a hiring spike. Commercial insurance is
bought at moments, not on Tuesdays.

> **Caveat.** Same consent status. Also verify freshness: a "new business" signal
> nine months stale is worse than no signal.

### Coupler.io · analytics · Phase 4
Pipes outcomes, spend, and conversion into a warehouse and out to whatever BI the
agency already uses. Answers the only question a principal asks: what did this
cost per bound policy, by line, this month?

> **Caveat.** Export the aggregate view, never raw transcripts. Call content in a
> general-purpose BI tool is outside your retention controls and inside
> somebody's spreadsheet.

### Supermetrics · analytics · Phase 4
Closes the loop between ad spend and bound policies — which lead source produces
consent records that actually convert.

> **Caveat.** Earns its place only once there is paid acquisition to attribute.

### Google Drive · documents · Phase 3
Document custody: signed voice releases, license certificates, carrier
appointment letters, ACORD forms, quarterly compliance evidence packs.

> **Caveat.** Drive sharing defaults are a breach generator. Restricted shared
> drive with explicit membership. Never "anyone with the link."

### MyChatBot · conversational · Phase 3
**Underrated, and worth a second look.** A website widget or WhatsApp thread
where a prospect asks about a quote is an *inbound* interaction — which is
exactly where you legitimately capture the written consent that makes Danny able
to call them. It manufactures the input the rest of the system is starved of.

> **Caveat.** The widget's consent language must be counsel-reviewed and
> version-stamped. Capturing the wrong disclosure text at scale means
> discovering later that none of your consent is good.

---

## MARGINAL — behind a flag, or design-time only

| Connector | Role | Why it stays marginal |
|---|---|---|
| **Canva** | Quote comparison PDF from a brand template | A templated HTML-to-PDF renderer does this with no vendor dependency and no round trip. Use only if a partner insists their brand kit lives there. |
| **Adobe** | `media_enhance_speech` for cleaning voice reference audio; document merge for policy-review mailers | Enhancement changes timbre — a clone enrolled on enhanced audio can sound subtly unlike the person. Re-record where you can. |
| **Figma** | Design system for the dashboard and consent forms | Zero product surface. Real value to whoever designs the UI, invisible to the running system. |
| **MindMap AI** | Objection-tree visualization for producer training | A useful thinking tool, not a system component. |
| **Refine.ink** | Proofreads long-form compliance documentation | It is an academic proofreader. A well-proofread wrong disclosure is still wrong. |
| **OutlierKit** | YouTube research, if the agency runs a content channel | Unrelated to the calling product. Do not let it into the roadmap on the grounds that it is technically a connector. |

---

## CUT — no defensible role

### Indeed
Job-posting velocity is a genuine commercial-lines buying signal, and hiring
producers is a genuine need. Neither justifies an integration.

> **The real reason it is cut:** scraping employment data to infer business
> characteristics, then prioritizing insurance outreach off it, walks toward the
> algorithmic-discrimination provisions of Colorado SB 21-169 and the NAIC AI
> model bulletin. Not worth the exposure for a weak signal.

### Otto Travel
Books flights, hotels, and rental cars. No relationship to insurance outreach.
Listed because the brief said every connector, and the honest answer for this one
is no.

---

## Non-connector dependencies that matter more than most of the above

These are not in the connector list and are load-bearing:

| Dependency | Role | Phase |
|---|---|---|
| **Twilio** | PSTN, media streams, STIR/SHAKEN, recording | 1 |
| **Fish Audio** | Cloned-voice TTS | 1 |
| **Deepgram** | Streaming STT tuned for 8kHz phone audio | 1 |
| **Anthropic** | Turn reasoning and post-call analysis | 1 |
| **National DNC Registry** | Federal scrub (requires a paid SAN) | 0 |
| **Litigator scrub vendor** | Serial-plaintiff suppression | 0 |
| **Carrier rating APIs** | Actual quotes | 2 |
| **AMS (Epic / EZLynx / HawkSoft / AMS360)** | Where agencies actually work | 4 |

That last row is the one that decides whether this is a product or a demo.

---

## Build order

```
Phase 0  DNC SAN · litigator scrub                    (compliance, pre-dial)
Phase 1  Supabase · GitHub · Vercel · Twilio · Fish · Deepgram · Anthropic
Phase 2  HubSpot · Gmail · Zapier · first carrier API
Phase 3  Apollo · Sprouts · Vibe · MyChatBot · Google Drive
Phase 4  Coupler · Supermetrics · Figma · AMS ×2
Phase 5  Canva · Adobe · MindMap · Refine        (only if someone asks)
Never    Indeed · Otto Travel
```
