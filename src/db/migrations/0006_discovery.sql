-- 0006_discovery: profiles to search on, invites to bring a company in, and a
-- log of every search so whoever picks the real algorithm has evidence.

-- ---------------------------------------------------------------------------
-- company_profiles
-- ---------------------------------------------------------------------------
-- Shared like companies: one profile per company in the pool, whoever filled
-- it in. buys and sells hold category codes as plain strings; the engine does
-- not own a catalogue and does not validate them.
create table if not exists marketing.company_profiles (
  company_id uuid primary key references marketing.companies (id),
  buys       text[] not null default '{}',
  sells      text[] not null default '{}',
  sector     text null,
  city       text null,
  size       text null,
  updated_at timestamptz not null default now()
);

create index if not exists company_profiles_buys_idx
  on marketing.company_profiles using gin (buys);
create index if not exists company_profiles_sells_idx
  on marketing.company_profiles using gin (sells);

alter table marketing.company_profiles enable row level security;

drop policy if exists company_profiles_shared on marketing.company_profiles;
create policy company_profiles_shared on marketing.company_profiles
  for all to marketing_app using (true) with check (true);

grant select, insert, update on marketing.company_profiles to marketing_app;

-- ---------------------------------------------------------------------------
-- invites
-- ---------------------------------------------------------------------------
-- An invite is a message with a token attached. The token is the whole secret:
-- whoever holds it is the company being invited.
create table if not exists marketing.invites (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references marketing.tenants (id),
  company_id   uuid not null references marketing.companies (id),
  message_id   uuid null references marketing.messages (id),
  token        text not null unique,
  status       text not null check (status in ('sent', 'accepted', 'expired')),
  accepted_ref text null,
  created_at   timestamptz not null default now(),
  accepted_at  timestamptz null,
  expires_at   timestamptz not null
);

create index if not exists invites_company_idx on marketing.invites (company_id);

alter table marketing.invites enable row level security;

drop policy if exists invites_isolation on marketing.invites;
create policy invites_isolation on marketing.invites
  for all to marketing_app
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Accepting and expiring are done by the owning role: the marketplace's
-- callback carries no tenant.
grant select, insert on marketing.invites to marketing_app;

-- ---------------------------------------------------------------------------
-- finder_runs
-- ---------------------------------------------------------------------------
-- Every search, with what was asked and what came back. The matching algorithm
-- in v1 is a placeholder; this is the evidence the real one gets chosen on.
create table if not exists marketing.finder_runs (
  id           bigserial primary key,
  tenant_id    uuid not null references marketing.tenants (id),
  finder       text not null,
  query        jsonb not null,
  result_count int not null,
  duration_ms  int not null,
  created_at   timestamptz not null default now()
);

create index if not exists finder_runs_tenant_idx
  on marketing.finder_runs (tenant_id, created_at desc);

alter table marketing.finder_runs enable row level security;

drop policy if exists finder_runs_isolation on marketing.finder_runs;
create policy finder_runs_isolation on marketing.finder_runs
  for all to marketing_app
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

grant select, insert on marketing.finder_runs to marketing_app;
grant usage on sequence marketing.finder_runs_id_seq to marketing_app;
