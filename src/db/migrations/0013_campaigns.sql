-- 0013_campaigns: the campaigns module's own tables. Stored contacts, named
-- audiences, and campaigns that send to an audience later through the same
-- messaging.send() as everything else.
--
-- Two deliberate additions to the brief's shapes: campaign_runs and
-- campaign_recipients carry tenant_id, because every tenant-owned table does
-- (CLAUDE.md rule 3); and campaigns carry next_run_at, so "when does this run
-- next" is a column the API returns rather than something a screen works out.

-- ---------------------------------------------------------------------------
-- contacts
-- ---------------------------------------------------------------------------
-- Addresses are stored normalised (E.164, lower-cased email), so the partial
-- unique indexes below are what stop the same person landing twice.
create table if not exists marketing.contacts (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references marketing.tenants (id),
  phone      text null,
  email      text null,
  telegram   text null,
  company_id uuid null references marketing.companies (id),
  name       text null,
  locale     text null,
  attributes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (phone is not null or email is not null or telegram is not null)
);

create unique index if not exists contacts_tenant_phone_idx
  on marketing.contacts (tenant_id, phone) where phone is not null;
create unique index if not exists contacts_tenant_email_idx
  on marketing.contacts (tenant_id, email) where email is not null;
create unique index if not exists contacts_tenant_telegram_idx
  on marketing.contacts (tenant_id, telegram) where telegram is not null;
create index if not exists contacts_tenant_company_idx
  on marketing.contacts (tenant_id, company_id) where company_id is not null;

alter table marketing.contacts enable row level security;

drop policy if exists contacts_isolation on marketing.contacts;
create policy contacts_isolation on marketing.contacts
  for all to marketing_app
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

grant select, insert, update on marketing.contacts to marketing_app;

-- ---------------------------------------------------------------------------
-- audiences
-- ---------------------------------------------------------------------------
create table if not exists marketing.audiences (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references marketing.tenants (id),
  name       text not null,
  kind       text not null check (kind in ('static', 'search')),
  definition jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);

alter table marketing.audiences enable row level security;

drop policy if exists audiences_isolation on marketing.audiences;
create policy audiences_isolation on marketing.audiences
  for all to marketing_app
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

grant select, insert, update, delete on marketing.audiences to marketing_app;

-- Members of a static audience. Scoped through the audience: a member row is
-- visible exactly when its audience is.
create table if not exists marketing.audience_members (
  audience_id uuid not null references marketing.audiences (id) on delete cascade,
  contact_id  uuid not null references marketing.contacts (id),
  added_at    timestamptz not null default now(),
  primary key (audience_id, contact_id)
);

alter table marketing.audience_members enable row level security;

drop policy if exists audience_members_isolation on marketing.audience_members;
create policy audience_members_isolation on marketing.audience_members
  for all to marketing_app
  using (exists (select 1 from marketing.audiences a where a.id = audience_id))
  with check (exists (select 1 from marketing.audiences a where a.id = audience_id));

grant select, insert, delete on marketing.audience_members to marketing_app;

-- ---------------------------------------------------------------------------
-- campaigns
-- ---------------------------------------------------------------------------
create table if not exists marketing.campaigns (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references marketing.tenants (id),
  name                text not null,
  audience_id         uuid not null references marketing.audiences (id),
  template            text not null,
  channel             text null,
  purpose             text not null,
  variables           jsonb not null default '{}'::jsonb,
  scheduled_at        timestamptz null,
  recurrence          jsonb null,
  timezone            text not null default 'Asia/Riyadh',
  throttle_per_minute int not null default 60
    check (throttle_per_minute between 1 and 600),
  status              text not null
    check (status in ('draft', 'scheduled', 'running', 'paused', 'done', 'cancelled', 'failed')),
  next_run_at         timestamptz null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists campaigns_tenant_status_idx
  on marketing.campaigns (tenant_id, status);

alter table marketing.campaigns enable row level security;

drop policy if exists campaigns_isolation on marketing.campaigns;
create policy campaigns_isolation on marketing.campaigns
  for all to marketing_app
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

grant select, insert, update on marketing.campaigns to marketing_app;

-- ---------------------------------------------------------------------------
-- campaign_runs
-- ---------------------------------------------------------------------------
-- skipped is counted alongside queued and blocked, so a run's counts always
-- add up to its audience once it is done.
create table if not exists marketing.campaign_runs (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references marketing.tenants (id),
  campaign_id   uuid not null references marketing.campaigns (id),
  run_no        int not null,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz null,
  status        text not null
    check (status in ('expanding', 'sending', 'done', 'cancelled', 'failed')),
  audience_size int null,
  queued        int not null default 0,
  blocked       int not null default 0,
  skipped       int not null default 0,
  error         text null,
  unique (campaign_id, run_no)
);

alter table marketing.campaign_runs enable row level security;

drop policy if exists campaign_runs_isolation on marketing.campaign_runs;
create policy campaign_runs_isolation on marketing.campaign_runs
  for all to marketing_app
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

grant select, insert, update on marketing.campaign_runs to marketing_app;

-- ---------------------------------------------------------------------------
-- campaign_recipients
-- ---------------------------------------------------------------------------
-- The audience snapshot, taken once when a run expands. Recipients are the
-- retry unit: a batch that dies leaves its unsent recipients pending.
create table if not exists marketing.campaign_recipients (
  run_id     uuid not null references marketing.campaign_runs (id),
  tenant_id  uuid not null references marketing.tenants (id),
  contact_id uuid not null references marketing.contacts (id),
  message_id uuid null references marketing.messages (id),
  state      text not null check (state in ('pending', 'queued', 'blocked', 'skipped')),
  reason     text null,
  primary key (run_id, contact_id)
);

create index if not exists campaign_recipients_pending_idx
  on marketing.campaign_recipients (run_id, contact_id) where state = 'pending';

alter table marketing.campaign_recipients enable row level security;

drop policy if exists campaign_recipients_isolation on marketing.campaign_recipients;
create policy campaign_recipients_isolation on marketing.campaign_recipients
  for all to marketing_app
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

grant select, insert, update on marketing.campaign_recipients to marketing_app;

-- ---------------------------------------------------------------------------
-- messages: the reverse link
-- ---------------------------------------------------------------------------
-- No foreign key: messaging must not depend on the campaigns module's tables.
alter table marketing.messages add column if not exists campaign_run_id uuid null;

create index if not exists messages_campaign_run_idx
  on marketing.messages (campaign_run_id) where campaign_run_id is not null;
