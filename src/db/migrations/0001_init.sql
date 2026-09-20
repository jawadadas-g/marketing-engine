-- 0001_init: the marketing schema, tenants, the events spine, idempotency keys,
-- and the application role every request runs as so row-level security is
-- actually enforced.
--
-- Everything the engine owns lives in the `marketing` schema, so the engine can
-- be dropped into a shared database without colliding with anything already
-- there. pg-boss keeps its own `pgboss` schema. The client sets search_path, so
-- no query outside this file names the schema.

create schema if not exists marketing;

-- ---------------------------------------------------------------------------
-- Application role
-- ---------------------------------------------------------------------------
-- Migrations, pg-boss and the cleanup cron run as the connection's own (owning)
-- role, which bypasses RLS. Request handlers `SET LOCAL ROLE marketing_app`
-- inside withTenant(), so for them the policies below decide what is visible.
-- Without a separate role the owner would bypass RLS and tenant isolation would
-- be application filtering only. The policies are therefore granted TO
-- marketing_app, and the table owner is deliberately left unrestricted.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'marketing_app') then
    create role marketing_app nologin;
  end if;
end
$$;

do $$
begin
  execute format('grant marketing_app to %I', current_user);
exception
  when duplicate_object then null;
  when others then null; -- already a member, or membership is inherited
end
$$;

grant usage on schema marketing to marketing_app;

-- ---------------------------------------------------------------------------
-- tenants
-- ---------------------------------------------------------------------------
create table if not exists marketing.tenants (
  id         uuid primary key,
  name       text not null,
  created_at timestamptz not null default now()
);

alter table marketing.tenants enable row level security;

drop policy if exists tenants_self on marketing.tenants;
create policy tenants_self on marketing.tenants
  for all
  to marketing_app
  using (id = current_setting('app.tenant_id', true)::uuid)
  with check (id = current_setting('app.tenant_id', true)::uuid);

grant select on marketing.tenants to marketing_app;

-- ---------------------------------------------------------------------------
-- events (append-only)
-- ---------------------------------------------------------------------------
create table if not exists marketing.events (
  id           bigserial primary key,
  tenant_id    uuid not null references marketing.tenants (id),
  type         text not null,
  subject_type text,
  subject_id   text,
  payload      jsonb not null default '{}'::jsonb,
  occurred_at  timestamptz not null default now()
);

create index if not exists events_tenant_occurred_at_idx
  on marketing.events (tenant_id, occurred_at desc);
create index if not exists events_tenant_type_idx
  on marketing.events (tenant_id, type);

alter table marketing.events enable row level security;

drop policy if exists events_tenant_isolation on marketing.events;
create policy events_tenant_isolation on marketing.events
  for all
  to marketing_app
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Append-only: select and insert, never update or delete.
grant select, insert on marketing.events to marketing_app;
grant usage on sequence marketing.events_id_seq to marketing_app;

-- ---------------------------------------------------------------------------
-- idempotency_keys
-- ---------------------------------------------------------------------------
create table if not exists marketing.idempotency_keys (
  tenant_id     uuid not null references marketing.tenants (id),
  key           text not null,
  response_hash text not null,
  response_body text not null,
  status        int  not null,
  created_at    timestamptz not null default now(),
  primary key (tenant_id, key)
);

create index if not exists idempotency_keys_created_at_idx
  on marketing.idempotency_keys (created_at);

alter table marketing.idempotency_keys enable row level security;

drop policy if exists idempotency_keys_tenant_isolation on marketing.idempotency_keys;
create policy idempotency_keys_tenant_isolation on marketing.idempotency_keys
  for all
  to marketing_app
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- The 24h cleanup cron runs as the owning role, so marketing_app needs no delete.
grant select, insert on marketing.idempotency_keys to marketing_app;
