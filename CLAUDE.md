# marketing-engine

Read `docs/ARCHITECTURE.md` before doing anything. It is the source of truth. If a task conflicts with it, stop and say so instead of improvising.

## What this is
A standalone, multi-tenant marketing engine: messaging (SMS, email, WhatsApp, Telegram), company discovery, promocodes. One Node service, one Postgres (Supabase), one HTTP API. No screens.

## Rules (non-negotiable)
1. Keep it simple. The smallest thing that works. If you are about to add a dependency, abstraction or config option the current step does not need, don't.
2. One deployable, one database. Postgres holds data, queue (pg-boss), events and rules. No Redis, no broker, no second datastore.
3. Every table has `tenant_id`. Every query is scoped by the tenant from the JWT. RLS is on.
4. Modules own their tables and never read another module's tables. Cross-module calls go through the module's service interface only.
5. `can_send()` is the only path to a provider. Nothing bypasses it.
6. Every module appends to `events`. Nothing else is the source of truth for "what happened".
7. Standalone and generic. A tenant is any organisation; a contact is any phone/email/handle. Marketplace- and country-specific things are adapters, connectors or rule rows, never hardcoded.
8. Extension only through: a new adapter file, a new ingest connector, a new rule kind, or reading the event log. If a feature needs a fifth mechanism, stop and ask.

## Stack (do not add to this without asking)
TypeScript, Node 22, Hono, Zod, `postgres` (porsager) or `pg`, pg-boss, json-logic-js, liquidjs, nodemailer, libphonenumber-js, jose. Vitest for tests. Plain `fetch` for every external HTTP API. No ORM.

## Layout
```
src/
  api/            Hono app, middleware (auth, tenant, idempotency), route mounting
  spine/
    events/       events table + emit()
    consent/      consent, suppression, can_send()
    rules/        rules table + evaluate(kind, ctx) over json-logic
    registry/     (step 5) companies, identifiers, sources, upsert()
  modules/
    messaging/    send intent, templates, queue jobs, adapters/
    discovery/    (step 6)
    promocodes/   (step 7)
  db/
    migrations/   plain SQL, numbered, forward-only
    client.ts
  jobs/           pg-boss registration and workers
test/
docs/
briefs/
```

## Working agreement
- Work from the brief in `briefs/NN-*.md` that I point you to. Do only what it says.
- Migrations are plain SQL files. Never edit an applied migration; add a new one.
- Every step ends with its "done when" check passing as an automated test, not a manual claim.
- Commit in small, named commits. Open one PR per brief. Do not merge.
- When unsure between two designs, pick the simpler one and note the alternative in the PR description.
