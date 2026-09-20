# Brief 01 — Skeleton

Read `CLAUDE.md` and `docs/ARCHITECTURE.md` first. This brief is roadmap step 1. Do nothing from later steps.

## Goal
A running Hono service on Node 22 connected to Supabase Postgres, with tenant auth, tenant-scoped tables under RLS, pg-boss installed, and the `events` spine piece. Nothing else.

## Build

1. **Project**: `npm init`, TypeScript strict, ESM, `tsx` for dev, Vitest. Scripts: `dev`, `build`, `test`, `migrate`. `.env.example` with `DATABASE_URL`, `SUPABASE_JWT_SECRET`, `PORT`.
2. **DB client** (`src/db/client.ts`): one Postgres connection pool from `DATABASE_URL`. A `withTenant(tenantId, fn)` helper that runs `fn` inside a transaction after `SET LOCAL app.tenant_id = $1`.
3. **Migrations** (`src/db/migrations/0001_init.sql`, runner in `src/db/migrate.ts`, plain SQL, forward-only, tracked in a `schema_migrations` table):
   - `tenants (id uuid pk, name text, created_at timestamptz)`
   - `events (id bigserial pk, tenant_id uuid not null references tenants, type text not null, subject_type text, subject_id text, payload jsonb not null default '{}', occurred_at timestamptz not null default now())`. Index on `(tenant_id, occurred_at desc)` and `(tenant_id, type)`. No update or delete grants: append-only.
   - RLS enabled on `events` with a policy `tenant_id = current_setting('app.tenant_id', true)::uuid`. Do the same for every tenant table from now on.
   - pg-boss schema created by pg-boss itself on first start; don't hand-write it.
4. **Auth middleware** (`src/api/middleware/auth.ts`): verify a Bearer JWT with `jose` against `SUPABASE_JWT_SECRET` (HS256). Require a `tenant_id` claim. Put `tenantId` on the Hono context. 401 on anything else.
5. **Idempotency middleware**: for POST/PUT, if `Idempotency-Key` header is present, store `(tenant_id, key, response_hash, response_body)` in an `idempotency_keys` table and replay the stored response on repeat. 24h TTL via a pg-boss cron that deletes old rows.
6. **Events spine** (`src/spine/events/`): `emit({ tenantId, type, subjectType?, subjectId?, payload? })` inserts one row inside the caller's transaction. `list({ tenantId, type?, since?, limit })` reads. Export only these two functions.
7. **Routes**:
   - `GET /health` (no auth) → `{ ok: true, db: true }`
   - `POST /v1/events` (auth) → emits an event with the body's `type`, `subjectType`, `subjectId`, `payload`. Zod-validated.
   - `GET /v1/events?type=&since=&limit=` (auth) → list.
8. **pg-boss**: start it with the service, register one worker `noop` and one cron `idempotency.cleanup`. Expose `jobs/index.ts` with `enqueue(name, data)` so later modules don't touch pg-boss directly.
9. **Tests** (Vitest, against a real Postgres from `DATABASE_URL_TEST`):
   - health returns 200
   - POST /v1/events with tenant A's token writes one `events` row visible via GET with A's token
   - GET /v1/events with tenant B's token returns zero rows for A's event (RLS proves it, not application filtering: run the query with B's `app.tenant_id` set directly in SQL too)
   - a request without a token returns 401
   - same `Idempotency-Key` twice returns the identical body and writes one row

## Done when
All five tests pass in CI (`npm test`). `README.md` has the four commands to run it locally.

## Do not
- Add an ORM, a DI container, a logger framework, or a config library. `console` and `process.env` are fine.
- Create any table not listed here.
- Write any messaging, consent, rules, registry or promo code.
- Add Docker, deployment, or OpenTelemetry. Those are step 8.

## Report back
Open a PR titled `01 skeleton`. In the description: what you built, the test output, and any decision you made that the brief did not specify.
