-- 0003_messaging: the messaging module's own tables. Provider credentials,
-- tenant templates, and one row per message with the body actually rendered.

-- ---------------------------------------------------------------------------
-- tenant_channel_configs
-- ---------------------------------------------------------------------------
-- One active provider per channel per tenant in v1. The provider credentials
-- are AES-256-GCM ciphertext; the key never goes in the database.
create table if not exists marketing.tenant_channel_configs (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references marketing.tenants (id),
  channel           text not null,
  provider          text not null,
  sender            text not null,
  unsubscribe_text  text null,
  config_ciphertext bytea not null,
  config_iv         bytea not null,
  config_tag        bytea not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (tenant_id, channel)
);

alter table marketing.tenant_channel_configs enable row level security;

drop policy if exists tenant_channel_configs_isolation on marketing.tenant_channel_configs;
create policy tenant_channel_configs_isolation on marketing.tenant_channel_configs
  for all
  to marketing_app
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

grant select, insert, update on marketing.tenant_channel_configs to marketing_app;

-- ---------------------------------------------------------------------------
-- templates
-- ---------------------------------------------------------------------------
create table if not exists marketing.templates (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references marketing.tenants (id),
  name       text not null,
  channel    text not null,
  body       text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, name, channel)
);

alter table marketing.templates enable row level security;

drop policy if exists templates_isolation on marketing.templates;
create policy templates_isolation on marketing.templates
  for all
  to marketing_app
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

grant select, insert, update on marketing.templates to marketing_app;

-- ---------------------------------------------------------------------------
-- messages
-- ---------------------------------------------------------------------------
-- One row per send intent, including the ones can_send refused. The body is
-- the rendered text, kept so what went out is not a guess.
create table if not exists marketing.messages (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references marketing.tenants (id),
  channel             text not null,
  address             text not null,
  region              text null,
  purpose             text not null,
  template_name       text not null,
  body                text not null,
  provider            text null,
  provider_message_id text null,
  status              text not null
    check (status in ('blocked', 'queued', 'sent', 'delivered', 'failed')),
  blocked_reason      text null,
  error               text null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists messages_tenant_created_at_idx
  on marketing.messages (tenant_id, created_at desc);
create index if not exists messages_provider_id_idx
  on marketing.messages (provider, provider_message_id);

alter table marketing.messages enable row level security;

drop policy if exists messages_isolation on marketing.messages;
create policy messages_isolation on marketing.messages
  for all
  to marketing_app
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Select and insert only. Every status change after the row is written is made
-- by the send worker or the webhook handler, which run as the owning role.
grant select, insert on marketing.messages to marketing_app;
