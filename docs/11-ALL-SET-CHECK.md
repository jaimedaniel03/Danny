# 11 — All Set Check: website and lead desk

All Set Check is the public website and private lead desk for a life and health
insurance practice serving low- and middle-income families. It lives in this
repository next to the Danny voice system and shares its stack (Next.js 15,
TypeScript, Postgres/Supabase) but not its data: everything the site stores is
in the `allset` schema, reached only through the `allset_app` role.

**Website inquiries never enter the AI dialing pipeline.** The consent people
give on these forms covers contact by a person. It is not the prior express
written consent the Danny gate requires, and nothing moves these leads into
`public.contacts` or `public.consents`.

---

## What it does

| Area | Where | Notes |
|---|---|---|
| Public pages | `src/app/(site)/` | Home, coverage, story, team, contact, privacy, terms |
| Inquiry forms | `src/allset/inquiries/`, `src/components/forms/` | Coverage and team, separate forms and flows |
| Lead desk | `src/app/admin/` | Owner/staff sign-in, leads, notes, statuses, follow-ups, export, audit |
| Alerts | `src/allset/notifications/` | Confirmed recipients, outbox, delivery webhooks |
| Business facts | `src/allset/content/facts.ts` | Verified facts only; drives the launch checklist |
| Retention | `src/allset/retention.ts` | Constants render the privacy policy and drive the purge job |
| Schema | `supabase/migrations/0003_allset_site.sql` | RLS on every table, app-role-only policy |

---

## Content rules (non-negotiable)

These apply to every word on the public site.

1. **No invented facts.** Legal entity, license numbers, service area,
   carriers, compensation, contact details, founder biography, testimonials,
   statistics and results render only from `FACTS` in
   `src/allset/content/facts.ts`, and only when verified (who, when, source).
   Unverified → the element is hidden, never filled with a placeholder.
2. **No statistics** unless a verified `proofPoints` entry backs them. General
   education ("a deductible is…") is fine; "most families…" figures are not.
3. **Never describe insurance as** an investment, a savings plan, a way to build
   wealth, guaranteed income, or a way out of debt. Cash value is described
   with its costs and limits.
4. **No guarantees** of approval, price, savings, response time or income.
5. **Financial freedom is the founders' own ambition** — say so only as theirs,
   never as a promise to clients or recruits.
6. **Don't imply licensing** ("our licensed agents") until licenses are
   verified. Say "a person on our team."
7. **Team page:** before any signup, disclose the role, licensing, training,
   pay, expenses and chargebacks. No guaranteed earnings, no "be your own boss"
   income claims, no implied job offer. General industry facts are allowed and
   labeled as general; this team's specific terms come from `FACTS.teamRole`.
8. **Plain language.** Short sentences, everyday words, define every insurance
   term the first time it appears. Aim for an 8th-grade reading level.
9. **Point to free public help** (HealthCare.gov, Medicaid/CHIP, Medicare.gov)
   where it genuinely fits. Trust is built by not selling what isn't needed.
10. **Photos** are licensed Adobe Stock images of models. Alt text describes the
    scene; captions never present a model as a client, founder or team member.

---

## Design system

Tokens: `src/styles/tokens.css`. Shared components and states: `src/styles/base.css`.

- **Color.** Ink `#17323A` carries text and primary buttons. Paper `#F8FAFA` is
  the page. Coral `#EC6D50` is the brand accent — the check, rules,
  highlights — and is **never** body-size text on a light surface (2.92:1).
  Use `--coral-text` (`#B2442A`, 5.34:1) for coral-colored text on light
  surfaces, `--coral-soft` on ink.
- **Type.** Newsreader (serif, headlines, `--font-serif`), Public Sans (body
  and UI, `--font-sans`). Fluid scale `--step-0` … `--step-5`; nothing is ever
  smaller than 16px (`--step-sm`).
- **Space.** `--space-1` … `--space-10` on a 4px base; `--section` for vertical
  section rhythm; `--gutter` for page edges; `.container` for the page width.
- **Controls.** `.btn .btn--primary | --secondary | --light | --outline-light |
  --quiet | --danger`, `.input`, `.select`, `.choice` (radio/checkbox row),
  `.field`, `.field__label | __hint | __error`, `.notice(--error|--success|--warning)`.
  Every interactive target is at least 44×44px (`--target`); primary actions 48px.
- **States.** Hover/focus transitions 150–250ms (`--dur-fast`, `--dur`,
  `--dur-slow`). `:focus-visible` draws a 3px outline in `--focus` (switches to
  coral-soft inside `.section--ink`). Errors: `aria-invalid` + `.field__error`.
- **Sections.** `.section`, `.section--tint`, `.section--ink`. Avoid repeating
  card grids; prefer editorial rows, lists, numbered steps and tables.
- **Motion.** Add `data-reveal` to a block to fade it in once as it scrolls
  into view. Hidden only by script, only below the fold, never under reduced
  motion — content is always present without JavaScript.
- **Photos.** `<Photo slug alt sizes priority? />` (`src/components/site/Photo.tsx`)
  renders AVIF/WebP `srcset`s with reserved dimensions; lazy unless `priority`.
  Slugs are in `src/allset/content/images.generated.ts`.
- **Layout.** No horizontal scrolling from 320px up, including at 200% zoom
  (a 1280px window at 200% is a 640px layout). Test at 360px and 640px.

---

## Security model

- Staff sign in with email + password (scrypt). Sessions are random 256-bit
  tokens in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie; only their SHA-256
  is stored. Sessions expire after 12 hours, or 2 hours idle.
- Roles are `owner` and `staff`, enforced on the server in every page, action
  and route (`src/allset/auth/`). Staff see only leads assigned to them or
  unassigned; only owners delete, export, manage staff, alerts and the audit log.
- Every query is a postgres.js tagged template (bind parameters). `sql.unsafe`
  appears only in test setup.
- Secrets live in server-only modules (`src/allset/env.ts`, `import 'server-only'`).
- Logs carry no personal data (`src/allset/log.ts` withholds PII-named fields
  and never logs error messages that can quote values).
- Admin pages send `noindex`, `no-store`, and a nonce-based CSP. `/contact`
  and `/team` (the pages that collect personal data) get the same per-request
  nonce policy; other public pages use a static baseline policy.
- Sign-in: per-connection and per-account rate limits run before any password
  work; the account's failure counter is claimed atomically, so a parallel
  burst can't slip past the lock (5 failures → 15-minute lock). Real and
  unknown accounts answer identically through the lockout. Trade-off: anyone
  who knows a staff email can keep that account locked; an owner can still
  issue a reset link.
- One-time links (invites, password resets, alert-recipient confirmation)
  carry the token in the URL fragment (`#token=…`), which browsers never send
  to a server, a log or a `Referer` header. The page reads it, then strips it
  from the address bar.
- Lead search text travels in a short-lived `HttpOnly`, `SameSite=Strict`
  cookie (cleared at sign-out), never the URL, so names and emails stay out of
  request logs.
- A repeat submission never overwrites a lead's contact details (someone who
  knows only an email address must not redirect our calls). The new details
  are stored on the new inquiry, the lead is flagged "needs review", and staff
  either keep the originals or apply the new ones after confirming with the
  person.
- Do-not-contact list (`allset.contact_suppressions`): keyed HMACs of the
  email and phone of anyone marked "Do not contact", or deleted with "they
  also asked us not to contact them". A later submission matching it is still
  saved but flagged on the lead. Keyed by `APP_SECRET`: rotating that secret
  orphans the list.
- New-inquiry alert emails stop at 60 per hour (leads still save; the audit
  log records `alerts.throttled`).

---

## Operations

### Environment

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Postgres URL for the `allset_app` role (Supabase: transaction pooler, port 6543) |
| `APP_SECRET` | yes | ≥32 chars; keys HMACs (IP hashes, rate limits, form tokens) |
| `PUBLIC_BASE_URL` | yes | Absolute origin for emailed links and metadata |
| `ADMIN_SETUP_TOKEN` | first run | ≥32 chars; enables `/admin/setup` until an owner exists. Remove afterwards |
| `CRON_SECRET` | yes | Bearer token for `/api/cron/*` |
| `RESEND_API_KEY`, `NOTIFY_FROM` | for alerts | Without them, alerts fail visibly in the admin |
| `RESEND_WEBHOOK_SECRET` | for delivery tracking | Svix signing secret from Resend |
| `SITE_INDEXABLE` | launch | `true` allows indexing — but only once every launch-required fact is verified |
| `ALLOW_PRELAUNCH_INQUIRIES` | preview only | `true` opens the forms before launch, for a private, access-protected preview. Without it, forms stay closed (enforced in the server action) until every launch-required fact is verified. Never set it on a public deployment before launch |
| `BUSINESS_TIMEZONE` | no | IANA zone for "due today" (default `America/Chicago`) |

### Database

1. Apply `supabase/migrations/0003_allset_site.sql` (as `postgres`).
2. Give the app role a password, out of band:
   `alter role allset_app login password '<generated>';`
3. `DATABASE_URL=postgres://allset_app.<project-ref>:<password>@<pooler-host>:6543/postgres?sslmode=require`

### First owner

Set `ADMIN_SETUP_TOKEN`, open `/admin/setup`, enter the token, and create the
owner account. The page refuses once an active owner exists. Remove the
variable afterwards.

### Scheduled jobs

`vercel.json` runs `/api/cron/notifications` (retry pending alerts) and
`/api/cron/retention` (purge per the retention policy) daily. Both require
`Authorization: Bearer $CRON_SECRET`.

Retention (`src/allset/retention.ts`, rendered into the privacy policy):
leads, inquiries and consent records 60 months after last activity;
do-not-contact hashes 5 years; audit events 3 years; alert records 12 months;
rate-limit counters 2 days; deactivated staff accounts anonymized after 3
years. These periods are a starting point for counsel to confirm against the
record-keeping rules that apply to the business (state insurance
record-retention rules and TCPA consent evidence among them).

### Photos

Masters are full-resolution Adobe Stock downloads and are **not** committed.
To regenerate the web exports: `ASSET_MASTERS_DIR=… npm run images:build`.

### Brand assets

`npm run brand:build` regenerates the mark, lockups, favicon, app icons and
Open Graph image from `scripts/brand-assets.ts`.
