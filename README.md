# marketing-engine

A standalone, multi-tenant marketing engine: messaging, company discovery and
promocodes. One Node service, one Postgres, one HTTP API. No screens.

See `docs/ARCHITECTURE.md` for the design and `docs/briefs/` for the steps.

## Run it locally

You need Node 22 and a Postgres you can write to. Any Postgres will do; a
throwaway one is a single command:

```bash
docker run -d --name marketing-pg -e POSTGRES_PASSWORD=postgres \
  -p 127.0.0.1:55432:5432 postgres:15
docker exec marketing-pg psql -U postgres \
  -c 'create database marketing' -c 'create database marketing_test'
```

Then, the four commands:

```bash
npm install                 # install dependencies
cp .env.example .env        # then edit DATABASE_URL and JWT_SECRET
npm run migrate             # apply src/db/migrations in order
npm run dev                 # start the service on $PORT (default 3000)
```

`npm test` runs the suite against `DATABASE_URL_TEST`. It migrates and truncates
that database, so point it at a throwaway one.

`npm run build` compiles to `dist/`; `npm start` runs the build.

## API

| Route | Auth | What |
| --- | --- | --- |
| `GET /health` | none | `{ ok, db }` |
| `POST /v1/events` | Bearer JWT | append one event |
| `GET /v1/events?type=&since=&limit=` | Bearer JWT | read this tenant's events |

Auth is a Bearer JWT signed HS256 with `JWT_SECRET` and carrying a
`tenant_id` claim. Anything else is a 401.

Writes accept an `Idempotency-Key` header. A repeat of the same key from the
same tenant replays the stored response and does not run the handler again.

```bash
curl -s localhost:3000/v1/events \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: abc-123' \
  -d '{"type":"thing.happened","subjectType":"thing","subjectId":"1","payload":{}}'
```

## Tenant isolation

Every tenant table has `tenant_id` and row-level security. Requests run inside
`withTenant()`, which opens a transaction, sets `app.tenant_id` and switches to
the non-owning `marketing_app` role — so the RLS policies actually apply rather
than being bypassed by the table owner. `events` is append-only: `marketing_app`
is granted `select, insert` and nothing more.
