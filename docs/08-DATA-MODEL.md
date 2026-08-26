# 08 — Data Model

Schema: [`supabase/migrations/0001_init.sql`](../supabase/migrations/0001_init.sql)

---

## Two commitments that shape everything

### 1. The consent ledger is append-only

Consent is **not** a boolean on a contact row that gets flipped. It is a sequence
of events with provenance.

When a plaintiff's lawyer asks "what did you know on March 4th, and how did you
know it," a mutable flag has no answer. A ledger does.

The `consents_immutable` trigger permits exactly one mutation: recording a
revocation, one-way. Every other field — basis, disclosure text, capture time,
source URI — is frozen at write. Deletes are prohibited outright.

### 2. The audit log records what the gate *saw*, not what it *decided*

Decisions are reproducible from evidence. Evidence is not reproducible from
decisions.

`dial_authorizations.evidence` holds a frozen JSON snapshot of every input the
gate considered — the consent record, all four scrub verdicts with timestamps,
the resolved calling window, attempt counts, EBR dates — stamped with
`gate_version`. The whole table is immutable: no updates, no deletes.

This is why the gate runs every check even after the first failure. A partial
audit record is worth much less than a complete one, and the checks are cheap
relative to a phone call.

---

## Core tables

```
agencies
  ├── producer_licenses        state + class + carrier appointments
  ├── contacts                 phone is the natural key, not the person
  │     └── consents           APPEND-ONLY ledger, keyed to the NUMBER
  ├── voice_releases           signed release; revocation cascades
  │     └── voice_models       disabled automatically when release is revoked
  ├── dial_authorizations      IMMUTABLE evidence, one row per gate evaluation
  │     └── calls              outbound REQUIRES an authorization (CHECK)
  │           ├── transcripts  tone-tagged utterances + retention clock
  │           └── quotes       carrier response, never reconstructed
  └── dnc_scrub_cache          7-day TTL (federal requires ≤31 days)
```

---

## Decisions worth explaining

**`consents.phone_e164` is denormalized on purpose.** Consent attaches to a
*number*, not a person. If the contact record is later merged, or the number
reassigned to someone else, the consent evidence must still point at the number
it was captured for. Joining through `contact_id` alone would silently rewrite
history during a merge.

**`calls.direction = 'outbound'` requires `authorization_id`,** enforced as a
`CHECK` constraint. An unaudited outbound dial is the thing this entire system
exists to prevent, so the storage layer enforces it too — a bug in the
application cannot produce one.

**`contacts.timezone` is nullable and null blocks dialing.** Resolved from the
mailing address, never from the area code. Number portability killed that
inference two decades ago and the gate returns `UNKNOWN_TIMEZONE` rather than
guessing.

**`contacts.line_type_checked_at`** caches carrier lookups, which cost money per
query. Mobile vs. landline changes the TCPA analysis, so the answer matters and
re-asking it constantly is expensive.

**`transcripts.purge_after` is set at write, not computed at read.** Retention
varies by line — CMS requires **ten years** for Medicare calls — and a generic
"delete after 2 years" job that eats Medicare recordings is a compliance
incident you discover during an audit.

**`quotes.raw_response`** holds whatever the carrier API actually returned.
Never reconstruct a quote from parsed fields; when a customer disputes a number,
the carrier's original response is the only thing that settles it.

**`voice_release_revocation_cascades`** disables every model built from a release
the moment that release is revoked. Revocation that requires a human to
remember to also disable the model is not revocation.

---

## Row-level security

Enabled on every tenant table from day one.

Retrofitting RLS onto a live multi-tenant schema is a migration nobody enjoys,
and a cross-tenant leak of call recordings — containing PII, and on health lines
PHI — is an extinction-level event for a business like this. The cost of enabling
it now is one line per table.

The `agency_id` claim is set by the API layer from the authenticated session,
**never** from a client-supplied value.

---

## Retention

| Data | Retention | Driver |
|---|---|---|
| Consent records | Indefinite | Statute of limitations runs from the last call; you may need this in ten years |
| Dial authorizations | Indefinite | Audit evidence |
| Medicare call recordings + transcripts | **10 years** | CMS marketing requirements |
| Other call recordings | 2 years default | Policy; TCPA SOL is 4 years — consider matching it |
| Transcripts (non-Medicare) | 2 years | Policy |
| Quotes | 7 years | Ordinary business records |
| DNC scrub cache | 7 days | Federal registry requires ≤31 days |

Two failure modes to guard: purging something a regulator required you to keep,
and keeping PHI past its stated retention because the job silently failed.
`transcripts.purge_after` is indexed so the job is cheap and its coverage is
verifiable.

---

## The one view anyone reads

`v_unit_economics` — attempts, connects, quotes, appointments, binds, spend, and
commission, grouped by agency, month, and line of business.

This is the report a principal actually opens, and it is the number the roadmap's
exit gates are measured against. Everything else in the schema exists to make
this view honest.

Note that it joins spend from four separate cost columns on `calls`
(`telephony_`, `stt_`, `llm_`, `tts_cost_cents`). Recording per-call cost at
write time rather than estimating it monthly is what makes "cost per bound
policy" a real number instead of a guess — and that number is the entire
argument in [`05-UNIT-ECONOMICS.md`](05-UNIT-ECONOMICS.md).

---

## What is deliberately absent

- **No `contacts.consent_status` column.** The ledger is the answer. A cached
  boolean would drift from it and the drift would be invisible.
- **No soft-delete on consents or authorizations.** Audit tables do not have a
  deleted state.
- **No PII in `dial_authorizations.evidence` beyond the phone number and state.**
  The evidence blob is queried and exported more than any other artifact; keep it
  minimal.
- **No transcript text in any analytics export.** Aggregate views only. Call
  content in a general-purpose BI tool is outside your retention controls.
