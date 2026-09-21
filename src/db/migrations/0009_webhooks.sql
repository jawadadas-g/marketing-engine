-- 0009_webhooks: how a client hears about anything, and how the marketplace
-- provisions a tenant.

-- The marketplace's own id for the organisation a tenant represents, so
-- provisioning is idempotent: asking twice gets the same tenant.
alter table marketing.tenants add column if not exists external_ref text null;
create unique index if not exists tenants_external_ref_idx
  on marketing.tenants (external_ref) where external_ref is not null;

-- ---------------------------------------------------------------------------
-- webhook_endpoints
-- ---------------------------------------------------------------------------
-- tenant_id null is the platform endpoint: it hears every tenant's events, is
-- created only through the internal route, and is visible to no tenant.
create table if not exists marketing.webhook_endpoints (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid null references marketing.tenants (id),
  url         text not null,
  -- The HMAC key deliveries are signed with. Returned once on creation; there
  -- is no way to hold a signing key without holding it.
  secret      text not null,
  -- Empty means every event type.
  event_types text[] not null default '{}',
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create index if not exists webhook_endpoints_tenant_idx
  on marketing.webhook_endpoints (tenant_id) where active;

alter table marketing.webhook_endpoints enable row level security;

drop policy if exists webhook_endpoints_isolation on marketing.webhook_endpoints;
create policy webhook_endpoints_isolation on marketing.webhook_endpoints
  for all to marketing_app
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

grant select, insert, update, delete on marketing.webhook_endpoints to marketing_app;

-- ---------------------------------------------------------------------------
-- webhook_deliveries
-- ---------------------------------------------------------------------------
create table if not exists marketing.webhook_deliveries (
  id               bigserial primary key,
  endpoint_id      uuid not null references marketing.webhook_endpoints (id) on delete cascade,
  event_id         bigint not null references marketing.events (id),
  attempt          int not null default 0,
  status           text not null check (status in ('pending', 'delivered', 'failed')),
  last_status_code int null,
  last_error       text null,
  next_attempt_at  timestamptz null,
  delivered_at     timestamptz null,
  created_at       timestamptz not null default now(),
  unique (endpoint_id, event_id)
);

create index if not exists webhook_deliveries_status_idx
  on marketing.webhook_deliveries (status, next_attempt_at);

alter table marketing.webhook_deliveries enable row level security;

-- A delivery belongs to whoever owns its endpoint. Writes are the worker's.
drop policy if exists webhook_deliveries_read on marketing.webhook_deliveries;
create policy webhook_deliveries_read on marketing.webhook_deliveries
  for select to marketing_app
  using (
    exists (
      select 1 from marketing.webhook_endpoints e
      where e.id = webhook_deliveries.endpoint_id
        and e.tenant_id = current_setting('app.tenant_id', true)::uuid
    )
  );

grant select on marketing.webhook_deliveries to marketing_app;
