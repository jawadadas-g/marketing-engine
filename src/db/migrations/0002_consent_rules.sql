-- 0002_consent_rules: the consent spine. Who may be messaged, who is blocked,
-- and the region-scoped rules that decide the rest. Nothing here sends.

-- ---------------------------------------------------------------------------
-- consent
-- ---------------------------------------------------------------------------
-- Append-only: a grant and a later revoke are two rows, and the latest row for
-- a (tenant, channel, address, purpose) wins.
create table if not exists marketing.consent (
  id          bigserial primary key,
  tenant_id   uuid not null references marketing.tenants (id),
  channel     text not null,
  address     text not null,
  purpose     text not null,
  status      text not null check (status in ('granted', 'revoked')),
  source      text not null,
  recorded_at timestamptz not null default now()
);

create index if not exists consent_lookup_idx
  on marketing.consent (tenant_id, channel, address, purpose, recorded_at desc);

alter table marketing.consent enable row level security;

drop policy if exists consent_tenant_isolation on marketing.consent;
create policy consent_tenant_isolation on marketing.consent
  for all
  to marketing_app
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

grant select, insert on marketing.consent to marketing_app;
grant usage on sequence marketing.consent_id_seq to marketing_app;

-- ---------------------------------------------------------------------------
-- suppression
-- ---------------------------------------------------------------------------
-- tenant_id null is a platform-wide block: it applies to every tenant and only
-- the owning role can write one.
create table if not exists marketing.suppression (
  id         bigserial primary key,
  tenant_id  uuid null references marketing.tenants (id),
  channel    text not null,
  address    text not null,
  reason     text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists suppression_scope_idx
  on marketing.suppression (
    coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid),
    channel,
    address
  );

alter table marketing.suppression enable row level security;

drop policy if exists suppression_read on marketing.suppression;
create policy suppression_read on marketing.suppression
  for select
  to marketing_app
  using (
    tenant_id is null
    or tenant_id = current_setting('app.tenant_id', true)::uuid
  );

-- A tenant can add its own block but not a platform-wide one.
drop policy if exists suppression_write on marketing.suppression;
create policy suppression_write on marketing.suppression
  for insert
  to marketing_app
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

grant select, insert on marketing.suppression to marketing_app;
grant usage on sequence marketing.suppression_id_seq to marketing_app;

-- ---------------------------------------------------------------------------
-- regions
-- ---------------------------------------------------------------------------
-- Reference data, the same for every tenant, so no RLS.
create table if not exists marketing.regions (
  code     text primary key,
  timezone text not null
);

insert into marketing.regions (code, timezone) values ('SA', 'Asia/Riyadh')
  on conflict (code) do nothing;

grant select on marketing.regions to marketing_app;

-- ---------------------------------------------------------------------------
-- rules
-- ---------------------------------------------------------------------------
create table if not exists marketing.rules (
  id         uuid primary key default gen_random_uuid(),
  scope      text not null check (scope in ('platform', 'region', 'tenant')),
  region     text null references marketing.regions (code),
  tenant_id  uuid null references marketing.tenants (id),
  kind       text not null,
  name       text not null,
  document   jsonb not null,
  enabled    boolean not null default true,
  created_at timestamptz not null default now(),
  constraint rules_scope_target check (
    (scope = 'platform' and region is null and tenant_id is null)
    or (scope = 'region' and region is not null and tenant_id is null)
    or (scope = 'tenant' and region is null and tenant_id is not null)
  )
);

create index if not exists rules_kind_idx on marketing.rules (kind, enabled);

alter table marketing.rules enable row level security;

-- Tenants read platform and region rules but can never write them.
drop policy if exists rules_read on marketing.rules;
create policy rules_read on marketing.rules
  for select
  to marketing_app
  using (
    scope <> 'tenant'
    or tenant_id = current_setting('app.tenant_id', true)::uuid
  );

drop policy if exists rules_insert_own on marketing.rules;
create policy rules_insert_own on marketing.rules
  for insert
  to marketing_app
  with check (
    scope = 'tenant'
    and tenant_id = current_setting('app.tenant_id', true)::uuid
  );

drop policy if exists rules_delete_own on marketing.rules;
create policy rules_delete_own on marketing.rules
  for delete
  to marketing_app
  using (
    scope = 'tenant'
    and tenant_id = current_setting('app.tenant_id', true)::uuid
  );

grant select, insert, delete on marketing.rules to marketing_app;

-- The first Saudi row. Registered sender IDs and the mandatory unsubscribe text
-- are the other two Saudi requirements; they are adapter and template concerns
-- and arrive in step 3. This one is a sending window: deny promotional SMS and
-- WhatsApp outside 09:00-21:00 in the contact's own time zone.
insert into marketing.rules (scope, region, kind, name, document)
select 'region', 'SA', 'sending_window', 'sa-marketing-sms-hours', $${
  "and": [
    { "in": [{ "var": "channel" }, ["sms", "whatsapp"]] },
    { "==": [{ "var": "purpose" }, "marketing"] },
    {
      "or": [
        { "<": [{ "var": "localHour" }, 9] },
        { ">=": [{ "var": "localHour" }, 21] }
      ]
    }
  ]
}$$::jsonb
where not exists (
  select 1 from marketing.rules where name = 'sa-marketing-sms-hours'
);
