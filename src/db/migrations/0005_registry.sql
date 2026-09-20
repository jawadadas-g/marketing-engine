-- 0005_registry: the prospect pool. Companies that are NOT on the marketplace,
-- arriving through imports, RFQ counterparties, API calls and lookups.
--
-- companies and company_identifiers are deliberately NOT tenant-scoped. Every
-- supplier searches the same pool, so one real company is one row whoever
-- contributed it, and both tables are readable by every tenant and written only
-- through registry.upsert. What a tenant says *about* a company — relationship,
-- tags, notes, and which sources it contributed — is tenant-scoped as usual, in
-- tenant_company and company_sources.

create extension if not exists pg_trgm;

-- ---------------------------------------------------------------------------
-- companies
-- ---------------------------------------------------------------------------
create table if not exists marketing.companies (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  -- Lower-cased, de-diacriticked, legal-form words removed. For matching only;
  -- `name` stays exactly as the contributor gave it.
  name_normalized text not null,
  country         text null,
  -- Set by step 6 when an invited company signs up. The row stays in the pool;
  -- discovery excludes it.
  on_platform_ref text null,
  on_platform_at  timestamptz null,
  -- A merged-away company keeps its row and points at the survivor, so a merge
  -- can be read back and undone by hand.
  merged_into     uuid null references marketing.companies (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists companies_name_trgm_idx
  on marketing.companies using gin (name_normalized gin_trgm_ops);
create index if not exists companies_merged_into_idx
  on marketing.companies (merged_into) where merged_into is not null;

alter table marketing.companies enable row level security;

drop policy if exists companies_shared on marketing.companies;
create policy companies_shared on marketing.companies
  for all to marketing_app using (true) with check (true);

grant select, insert, update on marketing.companies to marketing_app;

-- ---------------------------------------------------------------------------
-- company_identifiers
-- ---------------------------------------------------------------------------
-- cr, vat and domain are strong: unique to one company, and two companies
-- sharing one are the same company. phone and email are weak: they link, but a
-- number or a shared mailbox moves between companies over time.
create table if not exists marketing.company_identifiers (
  id         bigserial primary key,
  company_id uuid not null references marketing.companies (id),
  type       text not null check (type in ('cr', 'vat', 'domain', 'phone', 'email')),
  value      text not null,
  created_at timestamptz not null default now(),
  unique (type, value)
);

create index if not exists company_identifiers_company_idx
  on marketing.company_identifiers (company_id);

alter table marketing.company_identifiers enable row level security;

drop policy if exists company_identifiers_shared on marketing.company_identifiers;
create policy company_identifiers_shared on marketing.company_identifiers
  for all to marketing_app using (true) with check (true);

grant select, insert, update on marketing.company_identifiers to marketing_app;
grant usage on sequence marketing.company_identifiers_id_seq to marketing_app;

-- ---------------------------------------------------------------------------
-- company_sources
-- ---------------------------------------------------------------------------
-- Where each fact came from. Provenance belongs to the contributing tenant:
-- another tenant sees the company, not who told us about it.
create table if not exists marketing.company_sources (
  id          bigserial primary key,
  company_id  uuid not null references marketing.companies (id),
  tenant_id   uuid null references marketing.tenants (id),
  source_type text not null check (source_type in ('rfq', 'import', 'api', 'lookup')),
  source_ref  text null,
  data        jsonb not null default '{}'::jsonb,
  recorded_at timestamptz not null default now()
);

create index if not exists company_sources_company_idx
  on marketing.company_sources (company_id);

alter table marketing.company_sources enable row level security;

drop policy if exists company_sources_read on marketing.company_sources;
create policy company_sources_read on marketing.company_sources
  for select to marketing_app
  using (
    tenant_id is null
    or tenant_id = current_setting('app.tenant_id', true)::uuid
  );

drop policy if exists company_sources_write on marketing.company_sources;
create policy company_sources_write on marketing.company_sources
  for insert to marketing_app
  with check (
    tenant_id is null
    or tenant_id = current_setting('app.tenant_id', true)::uuid
  );

grant select, insert on marketing.company_sources to marketing_app;
grant usage on sequence marketing.company_sources_id_seq to marketing_app;

-- ---------------------------------------------------------------------------
-- tenant_company
-- ---------------------------------------------------------------------------
-- What one tenant says about one company. Private to that tenant.
create table if not exists marketing.tenant_company (
  tenant_id    uuid not null references marketing.tenants (id),
  company_id   uuid not null references marketing.companies (id),
  relationship text null check (relationship in ('customer', 'supplier', 'prospect', 'other')),
  tags         text[] not null default '{}',
  notes        text null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (tenant_id, company_id)
);

alter table marketing.tenant_company enable row level security;

drop policy if exists tenant_company_isolation on marketing.tenant_company;
create policy tenant_company_isolation on marketing.tenant_company
  for all to marketing_app
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

grant select, insert, update, delete on marketing.tenant_company to marketing_app;

-- ---------------------------------------------------------------------------
-- messages learn who they went to
-- ---------------------------------------------------------------------------
alter table marketing.messages
  add column if not exists company_id uuid null references marketing.companies (id);

create index if not exists messages_tenant_company_idx
  on marketing.messages (tenant_id, company_id);
