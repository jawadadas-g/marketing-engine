# Brief 09 — Operator read API

Read `CLAUDE.md` and `docs/ARCHITECTURE.md` first. This brief adds the platform-scope read side the marketplace admin needs to show what the engine is doing, across all tenants, live. The engine still owns no screens; the marketplace renders this.

## Goal
An operator dashboard in the marketplace can answer, from the engine's API alone: what is queued, running, retrying or failed right now; what each tenant sent, to whom, with what result, over any window; every operation in order, across tenants, as it happens; which scheduled jobs exist and when they last ran; which webhook deliveries are failing. Read-only, plus two safe actions: retry a failed job, replay a failed delivery.

## Auth
Everything under `/internal/` is authenticated by `X-Internal-Token` as before. A tenant JWT on an `/internal/` route is 401, tested. No new roles; this is the marketplace operator's key.

## Conventions
- Every list endpoint takes `limit` (1..500, default 100) and `cursor` (opaque; the last row's id), returns `{ items, nextCursor }`, newest first. No offsets.
- Every window is `since`/`until` ISO timestamps; `window=24h|7d|30d` is shorthand for `since = now - window`.
- Cross-tenant rows always carry `tenantId` and `tenantName`. Secrets never appear: channel configs come back redacted exactly as the tenant `GET` does.
- Responses are shaped as named sections so future sections (batches, audiences) slot in without changing existing keys.

## Endpoints

### Overview
`GET /internal/overview?window=24h` →
```json
{
  "asOf": "...",
  "health": { "db": true, "boss": "started", "version": "..." },
  "queue": [ { "name": "message.send", "created": 3, "active": 1, "retry": 2, "failed": 0, "completedInWindow": 412 }, ... ],
  "messages": { "queued": 3, "sent": 200, "delivered": 180, "read": 40, "replied": 6, "failed": 4, "blocked": 12 },
  "blockedReasons": { "no_consent": 9, "suppressed": 1, "rule:sa-marketing-sms-hours": 2 },
  "tenants": [ { "tenantId", "tenantName", "messages": {...by status...}, "invites": { "sent": 5, "accepted": 1 }, "redemptions": { "reserved": 2, "settled": 9, "released": 1 }, "webhookFailures": 0 } ],
  "webhooks": { "pending": 1, "failed": 2 },
  "reservations": { "open": 2, "expiringWithin15m": 1 },
  "discovery": { "searches": 33, "invitesFromSearch": 4 }
}
```
Queue numbers come from `pgboss.job` grouped by name and state (read the actual column names from the installed pg-boss version's schema; do not assume). Everything else is SQL over the engine's own tables within the window. Cache nothing; this is one query per section and must return in under a second on 100k messages (add indexes if a section is slow, and say which in the PR).

### Tenants
- `GET /internal/tenants?limit&cursor` → tenants with `createdAt`, `externalRef`, and the same per-tenant counts as the overview, last 24h.
- `GET /internal/tenants/:id` → tenant, channels configured (redacted), template names, rule count by kind, webhook endpoints (url, event types, active; never the secret), counts for 24h/7d/30d.

### Feeds
- `GET /internal/events?tenantId&type&subjectType&subjectId&since&until&limit&cursor` → cross-tenant events, full payload. `type` accepts a prefix with a trailing `*` (`message.*`).
- `GET /internal/messages?tenantId&status&channel&provider&companyId&address&since&until&limit&cursor` → messages with tenant name, company name when linked, and a `timeline` of the message's own events (queued, sent, delivered, ...) so one row shows the whole story.
- `GET /internal/messages/:id` → the message, its events, its delivery reports (raw provider bodies included), and its fallback children/parent.
- `GET /internal/redemptions?tenantId&status&promocodeId&since&until&limit&cursor`, `GET /internal/invites?tenantId&status&...`, `GET /internal/companies?q&country&onPlatform&limit&cursor` (pool browse, `q` uses `name_normalized %` trigram).

### Queue and schedules
- `GET /internal/jobs?name&state&limit&cursor` → rows from `pgboss.job`: id, name, state, retryCount, data, createdOn, startedOn, completedOn, output (the error text on failure). `data` may reference a message or redemption id; join and include `tenantId` when it does.
- `GET /internal/jobs/:id` → one job.
- `POST /internal/jobs/:id/retry` → for `failed` jobs only. Use pg-boss's own retry/resume API for the installed version if it has one; if not, re-enqueue the same name and data and record the original id in the new job's data as `retryOf`. 409 for any other state.
- `GET /internal/schedules` → pg-boss schedules (name, cron, timezone, data) joined with each one's last completed job time and last outcome.

### Deliveries
- `GET /internal/webhook-deliveries?status&tenantId&endpointId&since&limit&cursor` → cross-tenant, with the event type and the endpoint url.
- `POST /internal/webhook-deliveries/:id/replay` → same behaviour as the tenant replay, any tenant.

### Metrics
`GET /internal/metrics?series=messages|events|redemptions|searches&bucket=hour|day&window=7d&tenantId?&groupBy=status|channel|type?` → `{ bucket, series: [{ key, points: [[ts, count], ...] }] }`. One `date_trunc` query per call. Enough for a chart; nothing more.

### Live stream
`GET /internal/stream?tenantId&type` → Server-Sent Events. Each event as it commits:
```
id: 48213
event: message.sent
data: {"id":48213,"type":"message.sent","tenantId":"...","tenantName":"...","subjectType":"message","subjectId":"...","occurredAt":"..."}
```
- Mechanism: a trigger `after insert on marketing.events` calls `pg_notify('marketing_events', <small json: id, type, tenant_id, subject_type, subject_id, occurred_at>)`. NOTIFY is delivered only when the inserting transaction commits, which is exactly the semantics we want; a rolled-back event never reaches the stream. The service holds one `LISTEN` connection (`sql.listen` in postgres.js), fans out in-process to connected SSE clients, applies each client's filters. Payload stays under NOTIFY's 8000-byte limit by design; clients fetch `/internal/events/:id` for the full payload.
- Reconnect: honour `Last-Event-ID`: replay rows with `id > lastId` from the table (bounded to 1000), then continue live. Heartbeat comment line every 15s. Cap concurrent stream clients at 20 with a 503 beyond that.
- `GET /internal/events/:id` → one event with full payload.

## Migration `0010_operator.sql`
- The notify trigger and function.
- Indexes the sections need: `messages (created_at desc)`, `messages (status, created_at desc)`, `events (type, occurred_at desc)`, `redemptions (status, reserved_at desc)`, `webhook_deliveries (status, created_at desc)`. Only the ones the PR can show were needed.
- A `tenants.name` non-null default from `externalRef` if any rows lack it.

## `docs/DASHBOARD.md`
One page for whoever builds the admin screen: the six views it should have (overview, live feed, queue, per-tenant, message detail, deliveries), which endpoints each one calls, the refresh model (SSE for the feed, 10-second poll for the overview, on-demand for the rest), and the one rule: the admin renders, the engine decides. Add the endpoints to `docs/API.md`.

## Tests, CI (`test/operator.test.ts`)
1. `/internal/*` with a tenant JWT → 401; with the internal token → 200.
2. Overview: seed two tenants with mixed message statuses, two blocked reasons, one reserved redemption expiring in 10 minutes, one failed delivery → every section's numbers match the seed exactly; queue section shows `message.send` counts consistent with `pgboss.job`.
3. Events feed: filters by tenant, by `message.*` prefix, by subject; cursor pagination walks 250 rows in three pages with no gaps or duplicates.
4. Messages feed: a message with a fallback child shows both; `timeline` is ordered; detail includes the raw delivery report body.
5. Jobs: a deliberately failed `message.send` appears with `state = failed` and its error in `output`; `POST /retry` → a new attempt exists and, with the fake adapter fixed, ends `sent`; retry on a completed job → 409.
6. Schedules: the two crons appear with their cron strings.
7. Metrics: hourly message counts over the seed bucket correctly, grouped by status.
8. Stream: connect, emit an event in a committed transaction → received within 2s with the right `id` and `event`; emit inside a rolled-back transaction → nothing received; reconnect with `Last-Event-ID` → missed events replayed in order then live continues; `tenantId` filter excludes other tenants; the 21st client → 503.
9. No response body anywhere under `/internal/` contains a stored channel credential or webhook secret (grep the JSON of every endpoint in the test against the seeded secret strings).

## Done when
CI passes; `docs/DASHBOARD.md` and the `API.md` additions exist; the overview endpoint returns in under a second against a seeded 100k-message table (the PR shows the timing).

## Do not
- Build any HTML. Not even a debug page.
- Add a dependency. SSE is a streaming response in Hono; LISTEN/NOTIFY is postgres.js.
- Add write endpoints beyond `retry` and `replay`.
- Expose `pgboss` tables directly or return job `data` that contains credentials (there is none today; assert it in the test).
- Add per-tenant dashboard endpoints; tenants already have their own scoped lists.

## Report back
PR titled `09 operator read API`. Description: CI output, the overview timing on the seeded table, which indexes were actually needed, and anything the brief left open. Add a row 9 to the roadmap in `docs/ARCHITECTURE.md`.

