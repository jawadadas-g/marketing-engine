-- 0012_operator: what the operator read API needs.
--
-- Numbered 0012, not 0010 as the brief says: 0010 and 0011 were taken by the
-- idempotency body hash and the pg_trgm move. Migrations are forward-only.

-- ---------------------------------------------------------------------------
-- Live stream
-- ---------------------------------------------------------------------------
-- NOTIFY is delivered only when the inserting transaction commits, which is
-- exactly the semantics the stream wants: an event that rolls back never
-- reaches a watcher. The payload is deliberately small — NOTIFY caps at 8000
-- bytes and an event payload has no bound — so a client that wants the whole
-- thing fetches /internal/events/:id.
create or replace function marketing.notify_event() returns trigger
language plpgsql
as $$
begin
  perform pg_notify(
    'marketing_events',
    json_build_object(
      'id', new.id,
      'type', new.type,
      'tenantId', new.tenant_id,
      'subjectType', new.subject_type,
      'subjectId', new.subject_id,
      'occurredAt', new.occurred_at
    )::text
  );
  return null;
end
$$;

drop trigger if exists events_notify on marketing.events;
create trigger events_notify
  after insert on marketing.events
  for each row execute function marketing.notify_event();

-- ---------------------------------------------------------------------------
-- Indexes the operator sections need
-- ---------------------------------------------------------------------------
-- Only the two that were measured to matter. Every tenant-scoped index from
-- earlier migrations leads with tenant_id, which an operator query filtering
-- on time or status alone cannot use, so these two cover the cross-tenant
-- message feed. Measured against 100k messages:
--
--   GET /internal/messages            125ms -> 31ms
--   GET /internal/messages?status=…    72ms -> 38ms
--   GET /internal/overview?window=24h  65ms -> 40ms
--
-- Four more were written and then removed, because they changed nothing:
-- events (type, occurred_at) and events (occurred_at) are unused by the
-- events feed, which orders by id and walks the primary key backwards; and
-- status indexes on redemptions and webhook_deliveries are pointless while
-- those tables are small. Add them when a measurement asks for them.
create index if not exists messages_created_at_idx
  on marketing.messages (created_at desc);
create index if not exists messages_status_created_at_idx
  on marketing.messages (status, created_at desc);

-- ---------------------------------------------------------------------------
-- A tenant always has a name to show
-- ---------------------------------------------------------------------------
update marketing.tenants
set name = coalesce(nullif(name, ''), external_ref, 'tenant ' || left(id::text, 8))
where name is null or name = '';
