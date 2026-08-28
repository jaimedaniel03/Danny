-- ════════════════════════════════════════════════════════════════════════════
-- Danny — multi-channel outreach (text, email, call)
--
-- One commitment shapes this migration: suppression is keyed to the
-- DESTINATION, not to the contact.
--
-- The same phone number or email address can appear on several contact rows —
-- a household, a duplicate import, a person who moved between agencies. If
-- suppression hung off contact_id, unsubscribing one row would leave the others
-- happily sending to the same inbox. That is precisely how a single annoyed
-- person becomes a complaint, and then a plaintiff.
-- ════════════════════════════════════════════════════════════════════════════

create type outreach_channel as enum ('ai_voice', 'human_voice', 'sms', 'email');

create type suppression_source as enum (
  'sms_stop', 'email_unsubscribe', 'verbal', 'complaint', 'manual'
);

-- ── Suppression ─────────────────────────────────────────────────────────────

create table channel_suppressions (
  id                uuid primary key default gen_random_uuid(),
  agency_id         uuid references agencies(id) on delete cascade,
  contact_id        uuid references contacts(id) on delete set null,

  -- Exactly one of these is set, depending on the channel.
  phone_e164        text,
  email_address     citext,

  channel           outreach_channel not null,
  suppressed_at     timestamptz not null default now(),
  reason            text not null,
  source            suppression_source not null,
  created_at        timestamptz not null default now(),

  constraint destination_present check (
    (phone_e164 is not null) <> (email_address is not null)
  ),
  constraint phone_channel_match check (
    email_address is null or channel = 'email'
  )
);

-- Upsert targets. Partial uniques because only one destination column is set.
create unique index channel_suppressions_phone_uniq
  on channel_suppressions (phone_e164, channel) where phone_e164 is not null;
create unique index channel_suppressions_email_uniq
  on channel_suppressions (email_address, channel) where email_address is not null;

create index on channel_suppressions (agency_id, channel);

-- Suppression may be reversed only by a deliberate re-subscribe (a texted
-- START), which deletes the row. Updating one in place would let a bug quietly
-- turn "opted out" into "opted in", so block updates entirely.
create or replace function suppressions_no_update() returns trigger as $$
begin
  raise exception 'channel_suppressions rows are immutable; delete to re-subscribe';
end;
$$ language plpgsql;

create trigger channel_suppressions_immutable
  before update on channel_suppressions
  for each row execute function suppressions_no_update();

-- ── Messages ────────────────────────────────────────────────────────────────

create type message_direction as enum ('outbound', 'inbound');

create type message_intent as enum ('marketing', 'transactional', 'servicing');

create table messages (
  id                uuid primary key default gen_random_uuid(),
  agency_id         uuid references agencies(id) on delete cascade,
  contact_id        uuid references contacts(id) on delete set null,

  channel           outreach_channel not null,
  direction         message_direction not null,
  intent            message_intent,

  -- E.164 or email address, depending on channel.
  destination       text not null,
  provider_id       text,

  subject           text,
  body              text not null,
  -- The footer actually appended: STOP language, or the CAN-SPAM block. Stored
  -- separately so you can prove what shipped, not what the template said.
  footer            text,

  -- Links to the authorization that permitted this send. Null for inbound.
  authorization_evidence jsonb,

  -- SMS cost accounting. A curly apostrophe flips a message to UCS-2 and more
  -- than doubles segment count, so segments are recorded, not inferred.
  segments          int,
  encoding          text,
  cost_cents        int,

  sent_at           timestamptz,
  delivered_at      timestamptz,
  failed_at         timestamptz,
  failure_reason    text,
  created_at        timestamptz not null default now(),

  constraint outbound_requires_evidence check (
    direction <> 'outbound' or authorization_evidence is not null
  )
);

create index on messages (agency_id, channel, created_at desc);
create index on messages (contact_id, created_at desc);
create index on messages (destination, created_at desc);

-- ── Attempt counting ────────────────────────────────────────────────────────

-- The gate's per-channel frequency caps read from here. A view rather than a
-- counter column: counters drift, and a drifted counter silently permits
-- over-contacting, which is the failure this cap exists to prevent.
create view v_channel_attempts as
select
  destination,
  channel,
  count(*) filter (where created_at >= now() - interval '24 hours') as attempts_24h,
  count(*) filter (where created_at >= date_trunc('day', now()))    as attempts_today,
  count(*) filter (where created_at >= now() - interval '7 days')   as attempts_week
from messages
where direction = 'outbound'
group by destination, channel;

-- ── Reachability ────────────────────────────────────────────────────────────

-- Which doors are open per contact. The answer on a typical purchased list is
-- "email only", and that is the finding that makes such a list workable at all.
create view v_reachability as
select
  c.id as contact_id,
  c.agency_id,
  c.phone_e164,
  c.email,
  -- Written consent is what unlocks the AI and promotional SMS.
  exists (
    select 1 from consents k
    where k.phone_e164 = c.phone_e164
      and k.basis in ('prior_express_written', 'inbound_call')
      and k.revoked_at is null
      and (k.expires_at is null or k.expires_at > now())
  ) as has_written_consent,
  not exists (
    select 1 from channel_suppressions s
    where s.phone_e164 = c.phone_e164 and s.channel in ('ai_voice', 'human_voice')
  ) and c.internal_dnc_at is null as voice_open,
  not exists (
    select 1 from channel_suppressions s
    where s.phone_e164 = c.phone_e164 and s.channel = 'sms'
  ) and c.internal_dnc_at is null as sms_open,
  c.email is not null and not exists (
    select 1 from channel_suppressions s
    where s.email_address = c.email and s.channel = 'email'
  ) as email_open
from contacts c;

-- ── RLS ─────────────────────────────────────────────────────────────────────

alter table channel_suppressions enable row level security;
alter table messages             enable row level security;

create policy tenant_isolation on channel_suppressions
  using (agency_id = (auth.jwt() ->> 'agency_id')::uuid);
create policy tenant_isolation on messages
  using (agency_id = (auth.jwt() ->> 'agency_id')::uuid);
