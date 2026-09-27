-- ════════════════════════════════════════════════════════════════════════════
-- All Set Check — website inquiries and the private lead desk
--
-- Everything lives in its own schema, `allset`, for three reasons:
--
-- 1. Supabase exposes `public` through its REST API to anyone holding the anon
--    key. `allset` is never added to the exposed schemas, so inquiry data has
--    no REST surface at all — the only door is the application's own role.
-- 2. The application connects as `allset_app`, a role that can touch this
--    schema and nothing else. A bug in the site cannot read call recordings or
--    the consent ledger in `public`, and a leak of this role's password cannot
--    reach them either.
-- 3. Row-level security is enabled on every table with a single policy that
--    names `allset_app`. Any other role that somehow gains a grant still sees
--    zero rows. Defense in depth, not the primary control.
--
-- The role is created NOLOGIN here. Giving it a password is an operational
-- step (see docs/11-ALL-SET-CHECK.md) so no secret ever lands in a migration.
--
-- Retention is enforced by application code (src/allset/retention.ts) whose
-- constants also render the privacy policy, so the published promise and the
-- running job cannot drift apart.
-- ════════════════════════════════════════════════════════════════════════════

create schema if not exists allset;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'allset_app') then
    create role allset_app nologin;
  end if;
end
$$;

revoke all on schema allset from public;
do $$
begin
  -- Supabase's API roles. Absent on a plain Postgres, hence the guard.
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema allset from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on schema allset from authenticated';
  end if;
end
$$;

grant usage on schema allset to allset_app;

-- ── Staff ───────────────────────────────────────────────────────────────────

create table allset.staff_users (
  id                    uuid primary key default gen_random_uuid(),
  email                 text not null check (char_length(email) between 3 and 254),
  display_name          text not null check (char_length(display_name) between 1 and 80),
  role                  text not null check (role in ('owner', 'staff')),
  -- Null until an invited person sets their own password.
  password_hash         text,
  -- One-time link for first sign-in or an owner-issued reset. Only the
  -- SHA-256 of the token is stored; the token itself is shown once.
  invite_token_hash     text unique,
  invite_expires_at     timestamptz,
  is_active             boolean not null default true,
  -- Two-step sign-in (TOTP). Secrets are encrypted with a key derived from
  -- APP_SECRET (AES-256-GCM): a database read alone never yields one, and
  -- rotating APP_SECRET means everyone re-enrolls.
  mfa_secret_enc        text,
  mfa_pending_secret_enc text,
  mfa_enabled_at        timestamptz,
  -- Last accepted TOTP time step, so a code can never be used twice.
  mfa_last_step         bigint,
  last_login_at         timestamptz,
  created_by            uuid references allset.staff_users (id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deactivated_at        timestamptz
);

create unique index staff_users_email_key on allset.staff_users (lower(email));

create table allset.staff_sessions (
  id                    uuid primary key default gen_random_uuid(),
  -- SHA-256 hex of the cookie token. A database read never yields a usable session.
  token_hash            text not null unique,
  staff_id              uuid not null references allset.staff_users (id) on delete cascade,
  created_at            timestamptz not null default now(),
  last_seen_at          timestamptz not null default now(),
  expires_at            timestamptz not null,
  ip_hash               text,
  user_agent            text check (user_agent is null or char_length(user_agent) <= 256),
  -- Null until the second step is done. Such a session can only reach the
  -- two-step setup page, never the lead desk.
  mfa_verified_at       timestamptz
);

create index staff_sessions_staff_idx on allset.staff_sessions (staff_id);
create index staff_sessions_expiry_idx on allset.staff_sessions (expires_at);

-- Browsers that completed a full sign-in. A remembered device keeps its own
-- attempt budget, so an attacker hammering an account from elsewhere cannot
-- lock its owner out.
create table allset.staff_devices (
  id                    uuid primary key default gen_random_uuid(),
  token_hash            text not null unique,
  staff_id              uuid not null references allset.staff_users (id) on delete cascade,
  created_at            timestamptz not null default now(),
  last_used_at          timestamptz not null default now(),
  expires_at            timestamptz not null
);

create index staff_devices_staff_idx on allset.staff_devices (staff_id);

-- Between a correct password and a correct second-step code. Short-lived,
-- single-use, and limited in attempts.
create table allset.staff_mfa_challenges (
  id                    uuid primary key default gen_random_uuid(),
  token_hash            text not null unique,
  staff_id              uuid not null references allset.staff_users (id) on delete cascade,
  device_id             uuid references allset.staff_devices (id) on delete set null,
  attempts              integer not null default 0,
  created_at            timestamptz not null default now(),
  expires_at            timestamptz not null
);

-- One-time codes for when the authenticator is lost. Hashes only.
create table allset.staff_recovery_codes (
  id                    uuid primary key default gen_random_uuid(),
  staff_id              uuid not null references allset.staff_users (id) on delete cascade,
  code_hash             text not null unique,
  created_at            timestamptz not null default now(),
  used_at               timestamptz
);

create index staff_recovery_codes_staff_idx on allset.staff_recovery_codes (staff_id);

-- ── Leads ───────────────────────────────────────────────────────────────────
--
-- A lead is a person we owe a follow-up. An inquiry is one form submission.
-- Several inquiries from the same address fold into one open lead, so a
-- family that submits twice gets one conversation, not two callers.

create table allset.leads (
  id                    uuid primary key default gen_random_uuid(),
  kind                  text not null check (kind in ('coverage', 'team')),
  full_name             text not null check (char_length(full_name) between 2 and 100),
  email                 text not null check (char_length(email) between 3 and 254),
  email_normalized      text not null check (char_length(email_normalized) between 3 and 254),
  zip                   text not null check (zip ~ '^[0-9]{5}$'),
  -- The state the person says they live in; eligibility is checked against it.
  state                 text not null check (state ~ '^[A-Z]{2}$'),
  contact_method        text not null check (contact_method in ('email', 'phone', 'text')),
  phone_e164            text check (phone_e164 is null or phone_e164 ~ '^\+1[2-9][0-9]{2}[2-9][0-9]{6}$'),
  coverage_interest     text check (coverage_interest in ('life', 'health', 'both', 'not_sure')),
  licensing_status      text check (licensing_status in ('licensed_life_health', 'licensed_other', 'studying', 'not_licensed')),
  status                text not null default 'new' check (status in (
                          'new', 'contacted', 'meeting_scheduled', 'following_up',
                          'closed_helped', 'closed_no_action', 'do_not_contact')),
  assigned_to           uuid references allset.staff_users (id) on delete set null,
  follow_up_on          date,
  submission_count      integer not null default 1 check (submission_count >= 1),
  -- A later submission arrived with different details. The lead keeps its
  -- original contact details (a stranger who knows someone's email must not
  -- be able to redirect our calls); staff compare and confirm.
  needs_review          boolean not null default false,
  -- The email or phone matches someone who asked not to be contacted.
  suppression_match     boolean not null default false,
  -- Made-up details entered on an access-protected preview. Never real people.
  is_synthetic          boolean not null default false,
  -- When the person withdrew consent (asked us to stop).
  consent_withdrawn_at  timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  last_submitted_at     timestamptz not null default now(),
  last_activity_at      timestamptz not null default now(),
  closed_at             timestamptz,

  -- Phone is collected only when the person chose to be called or texted.
  constraint phone_matches_method check (
    (contact_method = 'email') or (phone_e164 is not null)
  ),
  -- Each kind carries exactly its own qualifier.
  constraint qualifier_matches_kind check (
    (kind = 'coverage' and coverage_interest is not null and licensing_status is null) or
    (kind = 'team' and licensing_status is not null and coverage_interest is null)
  ),
  -- closed_at is set exactly when the status is terminal.
  constraint closed_at_matches_status check (
    (status in ('closed_helped', 'closed_no_action', 'do_not_contact')) = (closed_at is not null)
  )
);

-- At most one open lead per person per kind. The inquiry pipeline upserts
-- against this index, which is what makes duplicate submissions fold together.
create unique index leads_one_open_per_person
  on allset.leads (kind, email_normalized)
  where closed_at is null;

create index leads_status_idx on allset.leads (status, created_at desc);
create index leads_assigned_idx on allset.leads (assigned_to, status);
create index leads_follow_up_idx on allset.leads (follow_up_on) where follow_up_on is not null;
create index leads_activity_idx on allset.leads (last_activity_at);

create table allset.inquiries (
  id                    uuid primary key default gen_random_uuid(),
  -- What the person is shown on success, e.g. ASC-7K4M-2QXP.
  reference             text not null unique check (reference ~ '^ASC-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$'),
  -- Generated per form render. A retry or double-submit reuses it and gets
  -- the original reference back instead of a second row.
  idempotency_key       uuid not null unique,
  lead_id               uuid not null references allset.leads (id) on delete cascade,
  kind                  text not null check (kind in ('coverage', 'team')),
  -- Normalized snapshot of exactly what was submitted.
  payload               jsonb not null,
  -- Consent evidence: the exact words shown, their version, and when.
  consent_text          text not null,
  consent_version       text not null,
  consented_at          timestamptz not null,
  -- The channels the person agreed to be contacted on: the method they chose.
  consent_channels      text[] not null check (
                          cardinality(consent_channels) between 1 and 3
                          and consent_channels <@ array['email', 'phone', 'text']::text[]),
  source_path           text not null check (char_length(source_path) <= 200),
  ip_hash               text,
  user_agent            text check (user_agent is null or char_length(user_agent) <= 256),
  created_at            timestamptz not null default now()
);

create index inquiries_lead_idx on allset.inquiries (lead_id, created_at desc);

-- Consent evidence is immutable. It is removed only when its lead is deleted
-- (a person's deletion request, or retention), never edited.
create or replace function allset.reject_update() returns trigger
language plpgsql as $$
begin
  raise exception '% rows are immutable; % is not permitted', tg_table_name, tg_op;
end;
$$;

create trigger inquiries_no_update
  before update on allset.inquiries
  for each row execute function allset.reject_update();

create table allset.lead_notes (
  id                    uuid primary key default gen_random_uuid(),
  lead_id               uuid not null references allset.leads (id) on delete cascade,
  -- Staff accounts are anonymized, never deleted (see retention), so this
  -- reference never needs to change on an immutable row.
  author_id             uuid references allset.staff_users (id) on delete restrict,
  body                  text not null check (char_length(body) between 1 and 4000),
  created_at            timestamptz not null default now()
);

create index lead_notes_lead_idx on allset.lead_notes (lead_id, created_at desc);

-- Notes are a record of what was said and done. Append-only.
create trigger lead_notes_no_update
  before update on allset.lead_notes
  for each row execute function allset.reject_update();

-- ── Audit ───────────────────────────────────────────────────────────────────
--
-- Every staff action and account change. `details` carries identifiers and
-- field transitions, never a person's name, email, or phone.

create table allset.audit_events (
  id                    bigint generated always as identity primary key,
  occurred_at           timestamptz not null default now(),
  actor_id              uuid references allset.staff_users (id) on delete restrict,
  -- Snapshot, so the trail reads correctly after an account is anonymized.
  actor_label           text,
  action                text not null check (char_length(action) <= 64),
  entity_type           text check (entity_type is null or char_length(entity_type) <= 32),
  entity_id             uuid,
  entity_ref            text check (entity_ref is null or char_length(entity_ref) <= 32),
  details               jsonb not null default '{}'::jsonb
);

create index audit_events_time_idx on allset.audit_events (occurred_at desc);
create index audit_events_entity_idx on allset.audit_events (entity_type, entity_id, occurred_at desc);

create or replace function allset.audit_append_only() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'audit_events is append-only';
  end if;
  -- Deletion is permitted only for rows past the retention horizon.
  if old.occurred_at > now() - interval '3 years' then
    raise exception 'audit events younger than 3 years cannot be deleted';
  end if;
  return old;
end;
$$;

create trigger audit_events_append_only
  before update or delete on allset.audit_events
  for each row execute function allset.audit_append_only();

-- ── Do-not-contact list ─────────────────────────────────────────────────────
--
-- When someone asks us to stop, keyed hashes of their email and phone go here
-- and outlive the lead itself (retention purges, deletion requests), so a
-- later submission in their name is flagged before anyone reaches out.
-- Hashes only: the list cannot be read back into contact details.

create table allset.contact_suppressions (
  value_hash            text primary key check (char_length(value_hash) <= 128),
  kind                  text not null check (kind in ('email', 'phone')),
  -- Why the entry exists. Only an explicit request to stop creates one; a
  -- documented, counsel-approved retention basis is the only other reason.
  basis                 text not null check (basis in ('explicit_opt_out', 'counsel_approved_retention')),
  created_at            timestamptz not null default now(),
  created_by            uuid references allset.staff_users (id) on delete set null
);

create index contact_suppressions_created_idx on allset.contact_suppressions (created_at);

-- ── Abuse controls ──────────────────────────────────────────────────────────
--
-- Fixed-window counters. Serverless instances share nothing in memory, so the
-- count has to live somewhere every instance can see. Keys are HMACs, never
-- raw IPs or emails.

create table allset.rate_limits (
  bucket                text not null check (char_length(bucket) <= 64),
  key_hash              text not null check (char_length(key_hash) <= 128),
  window_start          timestamptz not null,
  hits                  integer not null default 1,
  primary key (bucket, key_hash, window_start)
);

create index rate_limits_window_idx on allset.rate_limits (window_start);

-- ── Notifications ───────────────────────────────────────────────────────────

create table allset.notification_recipients (
  id                    uuid primary key default gen_random_uuid(),
  email                 text not null check (char_length(email) between 3 and 254),
  -- A recipient receives lead alerts only after clicking the confirmation link.
  confirmed_at          timestamptz,
  confirm_token_hash    text unique,
  confirm_expires_at    timestamptz,
  added_by              uuid references allset.staff_users (id) on delete set null,
  created_at            timestamptz not null default now(),
  disabled_at           timestamptz
);

create unique index notification_recipients_email_key
  on allset.notification_recipients (lower(email));

create table allset.notifications (
  id                    uuid primary key default gen_random_uuid(),
  kind                  text not null check (kind in ('lead_received', 'recipient_confirmation', 'test_alert')),
  lead_id               uuid references allset.leads (id) on delete set null,
  recipient_id          uuid not null references allset.notification_recipients (id) on delete cascade,
  -- pending (queued) → sending → sent (the provider accepted it; that is not
  -- delivery) → delayed → delivered | bounced
  --                     ↘ pending again (retryable, with backoff)
  --                     ↘ failed (gave up, or the provider refused it)
  -- canceled: withdrawn before sending (the person opted out, or the lead
  -- was deleted).
  status                text not null default 'pending' check (status in (
                          'pending', 'sending', 'sent', 'delayed', 'delivered', 'bounced', 'failed', 'canceled')),
  attempts              integer not null default 0,
  next_attempt_at       timestamptz not null default now(),
  -- Sanitized reason. Never contains lead data.
  last_error            text check (last_error is null or char_length(last_error) <= 300),
  provider_message_id   text unique,
  -- A snapshot so the outbox can render the message without re-reading the
  -- lead. Only the reference and kind — no personal data.
  subject_ref           text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  sent_at               timestamptz,
  delayed_at            timestamptz,
  delivered_at          timestamptz
);

create index notifications_due_idx on allset.notifications (status, next_attempt_at);
create index notifications_created_idx on allset.notifications (created_at desc);
create index notifications_lead_idx on allset.notifications (lead_id) where lead_id is not null;

-- Delivery webhooks already processed, by the provider's event id. Webhooks
-- are retried and can arrive twice or out of order; each is applied once.
create table allset.webhook_events (
  event_id              text primary key check (char_length(event_id) <= 100),
  event_type            text not null check (char_length(event_type) <= 64),
  received_at           timestamptz not null default now()
);

create index webhook_events_received_idx on allset.webhook_events (received_at);

-- ── Grants and row-level security ───────────────────────────────────────────

-- Default privileges elsewhere in the cluster (Supabase grants its API roles
-- rights on new tables in some setups) must not reach these tables, so every
-- table and sequence starts from nothing before the one grant below.
revoke all on all tables in schema allset from public;
revoke all on all sequences in schema allset from public;
-- Trigger functions run when their trigger fires, whoever holds EXECUTE; nobody needs to call them.
revoke all on all functions in schema allset from public;
do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema allset from %I', r);
      execute format('revoke all on all sequences in schema allset from %I', r);
      execute format('revoke all on all functions in schema allset from %I', r);
    end if;
  end loop;
end
$$;

grant select, insert, update, delete on all tables in schema allset to allset_app;
grant usage, select on all sequences in schema allset to allset_app;

do $$
declare
  t text;
begin
  foreach t in array array[
    'staff_users', 'staff_sessions', 'staff_devices', 'staff_mfa_challenges',
    'staff_recovery_codes', 'leads', 'inquiries', 'lead_notes', 'audit_events',
    'rate_limits', 'notification_recipients', 'notifications', 'webhook_events',
    'contact_suppressions'
  ]
  loop
    execute format('alter table allset.%I enable row level security', t);
    execute format('alter table allset.%I force row level security', t);
    execute format(
      'create policy allset_app_only on allset.%I to allset_app using (true) with check (true)', t);
  end loop;
end
$$;
