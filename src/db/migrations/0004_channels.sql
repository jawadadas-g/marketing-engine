-- 0004_channels: what the other three channels need, plus channel selection
-- and fallback.

-- ---------------------------------------------------------------------------
-- templates
-- ---------------------------------------------------------------------------
-- subject: email only, Liquid like the body.
-- provider_ref: WhatsApp only. Meta accepts approved templates for
-- business-initiated messages, not free text, so this names the approved
-- template and says which variable fills which positional body parameter:
--   { "name": "order_update", "language": "ar", "params": ["order"] }
alter table marketing.templates add column if not exists subject text null;
alter table marketing.templates add column if not exists provider_ref jsonb null;

-- ---------------------------------------------------------------------------
-- messages
-- ---------------------------------------------------------------------------
alter table marketing.messages
  add column if not exists fallback_channels text[] not null default '{}';
alter table marketing.messages
  add column if not exists parent_message_id uuid null references marketing.messages (id);

-- Falling back re-renders the same intent for a different channel, which needs
-- the other addresses and the original variables. The message row is the only
-- record of the intent, so it carries both.
alter table marketing.messages
  add column if not exists contact jsonb not null default '{}'::jsonb;
alter table marketing.messages
  add column if not exists variables jsonb not null default '{}'::jsonb;

create index if not exists messages_parent_idx
  on marketing.messages (parent_message_id)
  where parent_message_id is not null;

-- WhatsApp reports reads as well as deliveries.
alter table marketing.messages drop constraint if exists messages_status_check;
alter table marketing.messages add constraint messages_status_check
  check (status in ('blocked', 'queued', 'sent', 'delivered', 'read', 'failed'));

-- ---------------------------------------------------------------------------
-- channel selection
-- ---------------------------------------------------------------------------
-- A channel_selection rule returns an ordered list of channels rather than a
-- boolean. The engine takes the first that is available and allowed; the rest
-- become the fallback order. This platform row exists mostly so a tenant can
-- see the shape of one.
insert into marketing.rules (scope, kind, name, document)
select 'platform', 'channel_selection', 'default-marketing-order', $${
  "if": [
    { "==": [{ "var": "purpose" }, "marketing"] },
    ["whatsapp", "sms", "email", "telegram"],
    null
  ]
}$$::jsonb
where not exists (
  select 1 from marketing.rules where name = 'default-marketing-order'
);
