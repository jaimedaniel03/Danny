# 04 — Compliance Foundation

> This is not the legal-review chapter at the back. It is the foundation the rest
> of the system is built on, and it is chapter four because you should read the
> economics first and then find out that the profitable path and the legal path
> are the same path.
>
> **Nothing here is legal advice.** It is an engineering brief describing what
> the code enforces and why. Retain counsel who specializes in TCPA and insurance
> marketing before dialing a single live number.

---

## The rule that determines the architecture

An **AI voice is an artificial voice** under 47 U.S.C. §227(b)(1)(A)(iii). The
FCC stated this explicitly in its **February 2024 Declaratory Ruling**, in
response to the New Hampshire primary robocall.

Artificial or prerecorded voice to a wireless number requires **prior express
written consent**:

- **Written** — signed or e-signed under E-SIGN. A checkbox with retained
  evidence qualifies; a checkbox with no retained evidence does not.
- **Express** — it must actually say calls may use automated technology or an
  artificial/prerecorded voice.
- **Naming the seller** — consent to "our partners" is not consent to you.
- **Per number** — it attaches to the phone number, not the person.

### What this rules out, permanently

| Basis | Human may dial | Danny may dial |
|---|---|---|
| Signed written consent naming us | ✅ | ✅ |
| They called us (inbound) | ✅ | ✅ |
| Web quote form, no consent language | ✅ | ❌ |
| Current policyholder (EBR) | ✅ | ❌ |
| Purchased "TCPA-compliant" lead | ⚠️ depends on the trail | ❌ unless the trail names you |
| Apollo / Sprouts / Vibe B2B contact | ⚠️ after DNC scrub | ❌ never |

The last two rows are where companies die. A vendor's claim that leads are
"TCPA-compliant" is a marketing statement. What matters is whether *you* can
produce, in discovery, the exact disclosure text that consumer saw, when, from
what IP, naming your agency. If you cannot, you have no consent.

**Enforcement in code:** `AI_DIALABLE_BASES` in `src/types/index.ts` contains
exactly two values. `selectConsent()` in the gate rejects everything else — and
crucially, flags it `humanMayDial: true` so the lead is routed to a human queue
rather than thrown away. That routing is worth real money and is easy to miss.

### The numbers that make this existential

$500 per call. $1,500 for willful or knowing violations. **No cap.** Private
right of action. Class certification is routine because the violation is
identical across the class.

10,000 dials with defective consent = **$5M–$15M**. There is no version of this
business that survives that, which is why the gate has no override flag.

---

## Do-not-call

Four lists, all checked before every dial (`src/compliance/dnc.ts`):

1. **Internal DNC.** Someone told *you* to stop. No exemption exists, ever — not
   EBR, not written consent, not a new relationship. Cheapest check, highest
   liability, most often missed because it lives in your own database.
2. **National DNC Registry.** Requires a paid SAN. Data must be refreshed at
   least every 31 days; we use 7.
3. **State registries.** A shrinking set still maintains their own.
4. **Litigator lists.** Commercial, optional, and worth every dollar. A few
   hundred serial plaintiffs file a large share of TCPA suits and they salt lead
   forms on purpose.

**The EBR trap.** An established business relationship exempts you from the
*registry* — 18 months after a transaction, 3 months after an inquiry. It does
**not** exempt you from §227(b). A current policyholder on the DNC list may be
called by a human and may not be called by Danny. `hasRegistryExemptingEbr()` is
deliberately named to make that scope obvious at the call site.

**In-call DNC requests** are honoured in-turn, not within the 10 business days
the law allows. `detectDncRequest()` fires before the model gets a turn, the
machine transitions to `HONORING_DNC`, and the call ends after one sentence.

---

## Calling hours

Federal floor: **8:00am–9:00pm at the called party's local time.** Local means
where the consumer is, not where you are, and **not what their area code implies** —
number portability killed that inference two decades ago.

State overrides are narrower and are encoded in `STATE_WINDOWS`. Florida and
Oklahoma run 8am–8pm; Washington and Maryland prohibit Sunday solicitation;
Kentucky and Utah start at 9am. Where sources conflict, the table takes the
narrower window.

**Unknown timezone fails closed.** `UNKNOWN_TIMEZONE` blocks the dial rather than
guessing. A 6am call because you inferred from an area code is a violation you
chose.

---

## AI disclosure

Three distinct obligations that people routinely collapse into one:

**Identity.** California B&P §17941 prohibits using a bot to incentivize a sale
without disclosure. Utah's AI Policy Act requires regulated occupations —
insurance producers included — to disclose proactively rather than only on
request. Colorado's AI Act (SB 24-205) reaches consequential decisions in
insurance and takes effect June 2026. More states land every session.

**Recording.** Roughly a dozen states require all-party consent (CA, CT, DE, FL,
IL, MD, MA, MI, MT, NV, NH, OR, PA, WA). Because you cannot reliably know where
the other party physically is, disclose on every call and treat all-party as the
floor.

**Medicare TPMO.** CMS requires a prescribed disclaimer within the first minute,
verbatim, plus the agency name and a truthful count of carriers and plans
represented. Do not paraphrase it.

### Why the disclosure is a string concat and not a prompt instruction

`buildOpeningDisclosure()` is spoken by the runtime **before the model is
invoked at all.** A system prompt saying "always disclose first" is a request,
and a sufficiently determined caller can talk a model out of a request. A string
the TTS speaks before the model exists in the conversation cannot be
jailbroken.

This is the single highest-leverage design decision in the codebase, and it
costs nothing.

---

## Voice cloning

Cloning is easy. The governance is the work.

- **FTC**, Feb 2024: AI voice impersonation is an unfair or deceptive practice.
- **State digital-replica statutes**: Tennessee's ELVIS Act, California AB 1836
  and AB 2602 (all 2024) create private rights of action over unauthorized voice
  replicas. Damages are not capped by a per-call schedule.
- **Enforcement precedent**: the 2024 New Hampshire robocall produced a $6M
  forfeiture against the transmitting carrier and a $6M proposed forfeiture
  against the individual. Cloned voice + undisclosed AI is a fact pattern
  regulators have already punished.

**The rule:** you may clone exactly one category of voice — a consenting adult
who signed a written release naming this system, this agency, and this use. In
practice, the agency principal.

`assertReleaseValid()` runs before **every** synthesis, not once at enrollment.
A revoked release stops synthesis mid-call, and the database trigger
`voice_release_revocation_cascades` disables every model built from it.

---

## Licensing

You must hold an active producer license in the state where the consumer
resides, in the correct class, and hold a carrier appointment to sell that
carrier's products.

`checkLicensing()` enforces state and class. Appointments are tracked in
`producer_licenses.appointed_carriers` but are a business process, not a
technical control — you cannot quote a carrier you are not appointed with, and
finding that out mid-call is embarrassing.

The `licenses` block in `agency.config.json` should list exactly the states and
classes you hold. Not the states you plan to be in, and not "all classes" because
it was easier to type. The gate is not the place for optimism, and it is the same
file `npm run leads:triage` sorts against — so an optimistic profile produces an
optimistic queue you then work by hand.

---

## Medicare, specifically

CMS marketing rules are stricter than everything above and apply on top of it:

- **No unsolicited contact.** A documented, scoped **permission to contact** is
  required before any outbound call. Enforced as `MEDICARE_PTC_MISSING`.
- **TPMO disclaimer**, verbatim, within the first minute.
- **All calls recorded and retained for 10 years.** Ten. Set
  `transcripts.purge_after` accordingly and do not let a generic retention job
  delete them.
- **No plan comparison or recommendation from anyone unlicensed.** This is the
  line between qualifying and unlicensed advice, and it is why the system prompt
  routes every "which plan is better" question to a human.
- **Scope of Appointment** requirements for what may be discussed.
- **AEP is Oct 15 – Dec 7.** Most of the year happens in eight weeks.

Do not enable Medicare unless the founder is licensed, appointed, and has counsel
who has done this before.

---

## Health data

ACA and Medicare conversations produce **PHI**. That means a signed BAA with
every subprocessor that touches call content — Twilio, the STT vendor, the LLM
provider, Supabase — before the first health call. Encryption at rest, access
logging, and a minimum-necessary policy on who can read transcripts.

An unsigned BAA with your transcription vendor is a HIPAA violation that exists
from the first call and is discovered during a breach.

---

## Model governance

The **NAIC Model Bulletin on the Use of AI by Insurers** (adopted Dec 2023, since
adopted by a majority of states) expects a documented AI systems program:
governance, risk management, testing for unfair discrimination, third-party
vendor oversight.

**Colorado SB 21-169** goes further for insurance specifically: quantitative
testing of external data and algorithms for disparate impact on protected classes.

Danny does not underwrite or price, which keeps it out of the sharpest part of
this. It does decide **who gets called**, and a call-prioritization model trained
on historical conversion can encode redlining without anyone intending it. If
you ever rank a call list by a learned model rather than by explicit business
rules, that model needs disparate-impact testing and documentation.

This is also why `Indeed` is CUT in the connector registry — inferring business
characteristics to prioritize outreach walks toward exactly this problem for a
weak signal.

---

## The evidence discipline

The gate runs **every** check even after the first failure, and freezes what it
saw into `dial_authorizations.evidence`. That table has an immutability trigger:
no updates, no deletes.

When a plaintiff's lawyer asks what you knew on March 4th and how, "our policy
was to check" and "here is the frozen evidence blob from 400ms before the dial,
with the gate version that produced it" are different conversations with
different outcomes.

The `consents` table is append-only under the same reasoning: consent is a
sequence of events with provenance, not a boolean someone flipped.

---

## Pre-flight checklist

Every box before the first live dial. No exceptions, including for testing.

- [ ] TCPA-specialist counsel retained (not your general business attorney)
- [ ] Consent disclosure language drafted by counsel, version-stamped in the DB
- [ ] National DNC SAN active
- [ ] Litigator scrubbing contracted
- [ ] E&O and cyber bound, **TCPA coverage confirmed in writing** — many policies exclude it
- [ ] Producer licenses verified; `agency.config.json` licenses match reality exactly
- [ ] Carrier appointments confirmed for every carrier you will quote
- [ ] Voice release signed, countersigned, stored
- [ ] BAAs executed with every subprocessor (health lines only)
- [ ] STIR/SHAKEN attestation on outbound numbers
- [ ] `npm run compliance:selftest` green in CI, blocking merge
- [ ] Kill switch tested end to end
- [ ] Retention jobs written and scheduled (10 years for Medicare)
- [ ] Complaint intake process with a named owner
