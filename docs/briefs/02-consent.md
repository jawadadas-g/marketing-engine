# Brief 02 — Consent, suppression, rules

Read `CLAUDE.md` and `docs/ARCHITECTURE.md` first. This brief is roadmap step 2. Do nothing from step 3 onward.

## Part A — housekeeping from the step 1 review (do first, one commit each)

1. **Own schema.** Move everything into a `marketing` schema so the engine can later be dropped into a shared database without collisions. Edit `0001_init.sql` in place (allowed this once; it has never run anywhere real): `create schema if not exists marketing;`, every table under `marketing.`, `grant usage on schema marketing to marketing_app` instead of `public`. `schema_migrations` goes in `marketing` too. The client sets `search_path` to `marketing` in the `postgres()` options so no query text changes. pg-boss keeps its own `pgboss` schema. From now on the forward-only rule applies to `0001`.
2. **Rename** `SUPABASE_JWT_SECRET` to `JWT_SECRET` everywhere. It is an HS256 secret; nothing about it is Supabase.
3. **Layout.** CLAUDE.md says `briefs/`; the repo has `docs/briefs/`. Keep `docs/briefs/` and fix CLAUDE.md.
4. **`docker-compose.yml`** with one service, `postgres:16`, a named volume, port `127.0.0.1:55432`, and an init script creating `marketing` and `marketing_test`. Replace the `docker run` lines in the README with `docker compose up -d`.

## Part B — the step

### Goal
`can_send()` exists and is the only decision point for whether a message may go out. It checks suppression, consent, and region-scoped rules, in that order, and says no with a reason. No messages are sent in this step.

### Definitions
- **Contact** = `{ channel, address }`. Channels in v1: `sms`, `whatsapp`, `email`, `telegram`. No contacts table yet; the address is stored inline on consent and suppression rows. Normalisation is a pure function in `src/spine/contacts/normalize.ts`: phones to E.164 via `libphonenumber-js` (reject unparseable), emails lower-cased and trimmed, telegram ids as given.
- **Region** = ISO 3166-1 alpha-2 derived from the address: phone country via `libphonenumber-js`; email and telegram have none (`null`). A `null` region means only platform and tenant rules apply.
- **Purpose**: `transactional` or `marketing`. Transactional needs no consent. Marketing needs a granted consent for that tenant, channel, address and purpose.

### Migration `0002_consent_rules.sql`
All under `marketing`, all with `tenant_id` where noted, RLS policies for `marketing_app` like `0001`.
- `consent (id bigserial pk, tenant_id uuid not null, channel text not null, address text not null, purpose text not null, status text not null check (status in ('granted','revoked')), source text not null, recorded_at timestamptz not null default now())`. Index `(tenant_id, channel, address, purpose, recorded_at desc)`. Append-only: the latest row wins. `marketing_app` gets select, insert.
- `suppression (id bigserial pk, tenant_id uuid null, channel text not null, address text not null, reason text not null, created_at timestamptz not null default now())`. `tenant_id null` = platform-wide block. Unique on `(coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'), channel, address)`. RLS policy: `tenant_id is null or tenant_id = current tenant`. `marketing_app` gets select, insert.
- `regions (code text pk, timezone text not null)`. Seed `('SA','Asia/Riyadh')`. No RLS; select for `marketing_app`.
- `rules (id uuid pk default gen_random_uuid(), scope text not null check (scope in ('platform','region','tenant')), region text null references regions, tenant_id uuid null references tenants, kind text not null, name text not null, document jsonb not null, enabled boolean not null default true, created_at timestamptz not null default now())`. Check: `scope='region'` requires `region`, `scope='tenant'` requires `tenant_id`, others null. RLS policy for `marketing_app`: read `scope <> 'tenant' or tenant_id = current tenant`; insert/delete only where `scope = 'tenant' and tenant_id = current tenant`. So tenants can never touch platform or region rules.
- Seed one region rule, the first Saudi row: `kind = 'sending_window'`, `name = 'sa-marketing-sms-hours'`, document = json-logic that returns `true` (deny) when `channel in [sms, whatsapp]` and `purpose == marketing` and `localHour < 9 or localHour >= 21`. Comment above it saying sender-ID registration and unsubscribe text are adapter and template concerns and arrive in step 3.

### Rules spine `src/spine/rules/`
- `evaluate(tx, { kind, tenantId, region, context })` loads enabled rules of that kind in order platform, region (if region non-null), tenant; runs each document with `json-logic-js` against `context`; returns `{ denied: boolean, byRule?: { id, name, scope } }`. First deny wins. A rule that throws is logged and skipped, never a silent allow of the whole call.
- Rule documents are json-logic; the module exposes nothing about json-logic outside this folder.

### Consent spine `src/spine/consent/`
- `record(tx, { tenantId, channel, address, purpose, status, source })` normalises the address, inserts a consent row, emits `consent.granted` or `consent.revoked`.
- `suppress(tx, { tenantId | null, channel, address, reason })` inserts a suppression row (ignore duplicate), emits `suppression.added`.
- `canSend(tx, { tenantId, channel, address, purpose, at?: Date })` returns `{ allowed: true } | { allowed: false, reason: 'suppressed' | 'no_consent' | 'rule', rule?: { id, name } }`. Order: suppression (platform then tenant) → consent (only for `marketing`) → rules of kind `sending_window` with context `{ channel, purpose, region, localHour, weekday }` where local time is `at` in the region's timezone from `regions`, or UTC when region is null. `at` defaults to now and exists so tests can pin the clock.

### Routes (all under `/v1`, auth + idempotency as in step 1)
- `POST /v1/consent` body `{ channel, address, purpose, status, source }` → 201 with the row.
- `POST /v1/suppression` body `{ channel, address, reason }` → tenant-scoped block, 201.
- `GET /v1/can-send?channel=&address=&purpose=&at=` → the `canSend` result. Dry run; sends nothing.
- `GET /v1/rules` → platform, region and this tenant's rules. `POST /v1/rules` body `{ kind, name, document }` creates a tenant rule (validate `kind in ('sending_window')` for now). `DELETE /v1/rules/:id` deletes only a tenant rule; 404 otherwise.

### Tests (Vitest, real Postgres, pinned `at`)
1. Marketing SMS to `+966501234567` with no consent → `no_consent`.
2. After `POST /v1/consent` granted, same call at 10:00 Riyadh → allowed.
3. Same at 23:00 Riyadh → `rule`, rule name `sa-marketing-sms-hours`.
4. Transactional SMS at 23:00 Riyadh → allowed (window rule does not apply).
5. Email suppressed by the tenant → `suppressed`; suppressed platform-wide (inserted as owner in the test) → `suppressed` for both tenants.
6. Revoke after grant → `no_consent` (latest row wins).
7. Tenant B sees none of tenant A's consent rows via bare `select` under `withTenant` (RLS).
8. Tenant `DELETE /v1/rules/:id` on the seeded region rule → 404 and the rule still exists.
9. Address normalisation: `0501234567` with default country SA and `+966 50 123 4567` resolve to the same consent row.

### Done when
All tests pass in CI. README gains the three new routes and a one-paragraph explanation of the decision order.

## Do not
- Send anything. No adapters, no templates, no pg-boss jobs beyond what step 1 has.
- Add a contacts or companies table.
- Add any dependency other than `json-logic-js` (and its types) and `libphonenumber-js`.
- Build rule kinds other than `sending_window`. `channel_selection` is step 4.

## Report back
Open a PR titled `02 consent, suppression, rules`. In the description: test output, and any decision the brief did not specify.
