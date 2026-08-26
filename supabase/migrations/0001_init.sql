-- ════════════════════════════════════════════════════════════════════════════
-- Danny — initial schema
--
-- Two design commitments drive everything below.
--
-- 1. The consent ledger is APPEND-ONLY. Consent is not a boolean on a contact
--    row that gets flipped; it is a sequence of events with provenance. When a
--    plaintiff's lawyer asks "what did you know on March 4th and how did you
--    know it," a mutable flag has no answer and a ledger does.
--
-- 2. The audit log records what the gate SAW, not what it decided. Decisions are
--    reproducible from evidence; evidence is not reproducible from decisions.
-- ════════════════════════════════════════════════════════════════════════════

create extension if not exists "pgcrypto";
create extension if not exists "citext";

-- ── Tenancy ─────────────────────────────────────────────────────────────────

create table agencies (
  id                uuid primary key default gen_random_uuid(),
  legal_name        text not null,
  npn               text,                    -- National Producer Number
  fein              text,
  created_at        timestamptz not null default now(),
  -- Global stop. Flipping this halts all dialing for the agency with no deploy.
  dialing_disabled_at timestamptz
);

create table producer_licenses (
  id                uuid primary key default gen_random_uuid(),
  agency_id         uuid not null references agencies(id) on delete cascade,
  producer_name     text not null,
  npn               text not null,
  state_code        char(2) not null,
  -- 'p_and_c' | 'life' | 'health'
  license_classes   text[] not null,
  license_number    text not null,
  issued_at         date not null,
  expires_at        date not null,
  -- Carrier appointments are separate from licensure; you need both to sell.
  appointed_carriers text[] not null default '{}',
  created_at        timestamptz not null default now()
);

create index on producer_licenses (agency_id, state_code, expires_at);

-- ── Contacts ────────────────────────────────────────────────────────────────

create type phone_line_type as enum ('mobile', 'landline', 'voip', 'unknown');

create table contacts (
  id                uuid primary key default gen_random_uuid(),
  agency_id         uuid not null references agencies(id) on delete cascade,
  phone_e164        text not null,
  line_type         phone_line_type not null default 'unknown',
  -- Carrier lookup result. Mobile vs landline changes the TCPA analysis, and
  -- the result is cached because the lookup costs money per query.
  line_type_checked_at timestamptz,
  first_name        text,
  last_name         text,
  email             citext,
  street            text,
  city              text,
  state_code        char(2),
  postal_code       text,
  -- IANA zone. Resolved from address, NOT from area code. Null blocks dialing.
  timezone          text,
  date_of_birth     date,
  is_existing_policyholder boolean not null default false,
  -- Where this contact came from. Cross-checked against NEVER_AI_DIALABLE_SOURCES.
  source_system     text not null,
  source_reference  text,
  internal_dnc_at   timestamptz,
  internal_dnc_reason text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint phone_is_e164 check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  unique (agency_id, phone_e164)
);

create index on contacts (agency_id, internal_dnc_at) where internal_dnc_at is not null;
create index on contacts (agency_id, state_code);

-- ── Consent ledger (append-only) ────────────────────────────────────────────

create type consent_basis as enum (
  'prior_express_written',
  'prior_express',
  'established_business_relationship',
  'inbound_call',
  'inbound_web_request',
  'none'
);

create table consents (
  id                uuid primary key default gen_random_uuid(),
  agency_id         uuid not null references agencies(id) on delete cascade,
  contact_id        uuid not null references contacts(id) on delete cascade,
  -- Denormalized deliberately: consent attaches to a NUMBER, not a person. If
  -- the contact record is later merged or the number reassigned, the consent
  -- evidence must still point at the number it was captured for.
  phone_e164        text not null,
  basis             consent_basis not null,
  -- The exact words the consumer agreed to. Retained for the life of the business.
  disclosure_text   text,
  -- Version of the disclosure language, so a bad revision is findable in bulk.
  disclosure_version text,
  source_uri        text,
  captured_at       timestamptz not null,
  expires_at        timestamptz,
  ip_address        inet,
  user_agent        text,
  -- Empty array = covers all lines.
  scoped_lines      text[] not null default '{}',
  -- Proof artifacts: form screenshot, TCPA-compliant checkbox state, call recording SID.
  evidence          jsonb not null default '{}'::jsonb,
  revoked_at        timestamptz,
  revoked_reason    text,
  created_at        timestamptz not null default now()
);

create index on consents (agency_id, phone_e164, captured_at desc);
create index on consents (contact_id) where revoked_at is null;

-- Append-only enforcement. Revocation is the ONLY permitted update, and it is
-- one-way. Everything else about a consent record is immutable once written.
create or replace function consents_append_only() returns trigger as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'consents is append-only; delete is prohibited';
  end if;

  if (new.id, new.contact_id, new.phone_e164, new.basis, new.disclosure_text,
      new.captured_at, new.source_uri)
     is distinct from
     (old.id, old.contact_id, old.phone_e164, old.basis, old.disclosure_text,
      old.captured_at, old.source_uri)
  then
    raise exception 'consent evidence is immutable; only revocation may be recorded';
  end if;

  if old.revoked_at is not null and new.revoked_at is null then
    raise exception 'consent revocation cannot be undone';
  end if;

  return new;
end;
$$ language plpgsql;

create trigger consents_immutable
  before update or delete on consents
  for each row execute function consents_append_only();

-- ── Voice governance ────────────────────────────────────────────────────────

create table voice_releases (
  id                uuid primary key default gen_random_uuid(),
  agency_id         uuid not null references agencies(id) on delete cascade,
  subject_legal_name text not null,
  subject_email     citext not null,
  signed_document_uri text not null,
  signed_at         timestamptz not null,
  permitted_uses    text[] not null,
  permitted_lines   text[] not null default '{}',
  reference_audio_uris text[] not null,
  reference_duration_seconds int not null,
  expires_at        timestamptz,
  revoked_at        timestamptz,
  created_at        timestamptz not null default now()
);

create table voice_models (
  id                uuid primary key default gen_random_uuid(),
  agency_id         uuid not null references agencies(id) on delete cascade,
  release_id        uuid not null references voice_releases(id),
  provider          text not null,          -- 'fish' | 'elevenlabs' | 'cartesia'
  provider_model_id text not null,
  display_name      text not null,
  -- Audition result over a real PSTN leg. A model that has not been auditioned
  -- through the 8kHz codec has not been tested.
  pstn_auditioned_at timestamptz,
  created_at        timestamptz not null default now(),
  disabled_at       timestamptz
);

-- A voice model cannot outlive its release. Revoking the release kills the model.
create or replace function cascade_release_revocation() returns trigger as $$
begin
  if new.revoked_at is not null and old.revoked_at is null then
    update voice_models set disabled_at = new.revoked_at
     where release_id = new.id and disabled_at is null;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger voice_release_revocation_cascades
  after update on voice_releases
  for each row execute function cascade_release_revocation();

-- ── Dial authorizations & audit ─────────────────────────────────────────────

create table dial_authorizations (
  id                uuid primary key default gen_random_uuid(),
  agency_id         uuid not null references agencies(id) on delete cascade,
  contact_id        uuid not null references contacts(id),
  consent_id        uuid references consents(id),
  line_of_business  text not null,
  granted           boolean not null,
  -- Failure codes when granted = false. The near-misses matter as much as the passes.
  failure_codes     text[] not null default '{}',
  -- Frozen snapshot of everything the gate saw. This is the exhibit.
  evidence          jsonb not null,
  gate_version      text not null,
  issued_at         timestamptz not null,
  expires_at        timestamptz not null,
  required_disclosure text,
  created_at        timestamptz not null default now()
);

create index on dial_authorizations (agency_id, contact_id, issued_at desc);
create index on dial_authorizations (agency_id, granted, issued_at desc);

-- Authorizations are evidence. Never mutable, never deletable.
create or replace function authorizations_immutable() returns trigger as $$
begin
  raise exception 'dial_authorizations is an audit table; % is prohibited', tg_op;
end;
$$ language plpgsql;

create trigger dial_authorizations_immutable
  before update or delete on dial_authorizations
  for each row execute function authorizations_immutable();

-- ── Calls ───────────────────────────────────────────────────────────────────

create type call_direction as enum ('outbound', 'inbound');

create type call_disposition as enum (
  'quoted', 'appointment_set', 'transferred_to_human', 'callback_requested',
  'not_interested', 'do_not_call_requested', 'wrong_number', 'voicemail',
  'no_answer', 'busy', 'failed', 'abandoned_by_agent', 'human_takeover'
);

create table calls (
  id                uuid primary key default gen_random_uuid(),
  agency_id         uuid not null references agencies(id) on delete cascade,
  contact_id        uuid not null references contacts(id),
  authorization_id  uuid references dial_authorizations(id),
  provider_sid      text not null unique,
  direction         call_direction not null,
  line_of_business  text not null,
  voice_model_id    uuid references voice_models(id),
  started_at        timestamptz not null,
  ended_at          timestamptz,
  duration_seconds  int,
  disposition       call_disposition,
  final_state       text,
  recording_uri     text,
  -- Proof the disclosures were actually spoken, not merely configured.
  ai_disclosed_at   timestamptz,
  recording_disclosed_at timestamptz,
  -- Cost accounting, per docs/05-UNIT-ECONOMICS.md
  telephony_cost_cents int,
  stt_cost_cents    int,
  llm_cost_cents    int,
  tts_cost_cents    int,
  created_at        timestamptz not null default now(),

  -- An outbound call without an authorization is the thing this whole system
  -- exists to prevent. Enforce it at the storage layer too, so a bug in the
  -- application cannot produce an unaudited dial.
  constraint outbound_requires_authorization
    check (direction <> 'outbound' or authorization_id is not null)
);

create index on calls (agency_id, started_at desc);
create index on calls (contact_id, started_at desc);
create index on calls (agency_id, disposition, started_at desc);

-- ── Transcripts & tonality ──────────────────────────────────────────────────

create table transcripts (
  id                uuid primary key default gen_random_uuid(),
  agency_id         uuid not null references agencies(id) on delete cascade,
  call_id           uuid not null references calls(id) on delete cascade,
  -- Verbatim, speaker-labeled, timestamped, tonality-tagged.
  utterances        jsonb not null,
  rep_average_energy       numeric(6,3),
  prospect_average_energy  numeric(6,3),
  energy_gap        numeric(6,3),
  prospect_turn_ms  int,
  model_version     text not null,
  created_at        timestamptz not null default now(),
  -- Retention clock. Medicare calls: 10 years per CMS. Others: policy-defined.
  purge_after       timestamptz not null
);

create index on transcripts (agency_id, call_id);
create index on transcripts (purge_after);

-- ── Quotes ──────────────────────────────────────────────────────────────────

create table quotes (
  id                uuid primary key default gen_random_uuid(),
  agency_id         uuid not null references agencies(id) on delete cascade,
  contact_id        uuid not null references contacts(id),
  call_id           uuid references calls(id),
  line_of_business  text not null,
  carrier           text not null,
  annual_premium_cents  bigint not null,
  estimated_commission_cents bigint,
  bindable          boolean not null default false,
  -- Whatever the carrier API actually returned. Never reconstruct a quote.
  raw_response      jsonb not null,
  quoted_at         timestamptz not null default now(),
  expires_at        timestamptz not null,
  bound_at          timestamptz,
  policy_number     text
);

create index on quotes (agency_id, contact_id, quoted_at desc);

-- ── Suppression ─────────────────────────────────────────────────────────────

create table dnc_scrub_cache (
  phone_e164        text not null,
  list_name         text not null,          -- 'federal' | 'state' | 'litigator'
  listed            boolean not null,
  checked_at        timestamptz not null default now(),
  primary key (phone_e164, list_name)
);

-- Federal registry data must be refreshed at least every 31 days. We use 7.
create index on dnc_scrub_cache (checked_at);

-- ── Metrics view ────────────────────────────────────────────────────────────

-- The only report a principal actually reads.
create view v_unit_economics as
select
  c.agency_id,
  date_trunc('month', c.started_at) as month,
  c.line_of_business,
  count(*)                                                as attempts,
  count(*) filter (where c.duration_seconds > 20)         as connects,
  count(*) filter (where c.disposition = 'quoted')        as quoted,
  count(*) filter (where c.disposition = 'appointment_set') as appointments,
  count(q.bound_at)                                       as bound,
  sum(coalesce(c.telephony_cost_cents,0) + coalesce(c.stt_cost_cents,0)
    + coalesce(c.llm_cost_cents,0)      + coalesce(c.tts_cost_cents,0)) as spend_cents,
  sum(q.estimated_commission_cents) filter (where q.bound_at is not null) as commission_cents
from calls c
left join quotes q on q.call_id = c.id
group by 1, 2, 3;

-- ── Row-level security ──────────────────────────────────────────────────────
-- Multi-tenant boundary. Enabled from day one: retrofitting RLS onto a live
-- multi-tenant table is a migration nobody enjoys, and a cross-tenant leak of
-- call recordings is an extinction-level event for a business like this.

alter table agencies            enable row level security;
alter table producer_licenses   enable row level security;
alter table contacts            enable row level security;
alter table consents            enable row level security;
alter table voice_releases      enable row level security;
alter table voice_models        enable row level security;
alter table dial_authorizations enable row level security;
alter table calls               enable row level security;
alter table transcripts         enable row level security;
alter table quotes              enable row level security;

-- Applied per table; shown once here for brevity. The claim is set by the API
-- layer from the authenticated session, never from a client-supplied value.
create policy tenant_isolation on contacts
  using (agency_id = (auth.jwt() ->> 'agency_id')::uuid);
create policy tenant_isolation on consents
  using (agency_id = (auth.jwt() ->> 'agency_id')::uuid);
create policy tenant_isolation on calls
  using (agency_id = (auth.jwt() ->> 'agency_id')::uuid);
create policy tenant_isolation on transcripts
  using (agency_id = (auth.jwt() ->> 'agency_id')::uuid);
create policy tenant_isolation on quotes
  using (agency_id = (auth.jwt() ->> 'agency_id')::uuid);
create policy tenant_isolation on dial_authorizations
  using (agency_id = (auth.jwt() ->> 'agency_id')::uuid);
create policy tenant_isolation on voice_releases
  using (agency_id = (auth.jwt() ->> 'agency_id')::uuid);
create policy tenant_isolation on voice_models
  using (agency_id = (auth.jwt() ->> 'agency_id')::uuid);
create policy tenant_isolation on producer_licenses
  using (agency_id = (auth.jwt() ->> 'agency_id')::uuid);
