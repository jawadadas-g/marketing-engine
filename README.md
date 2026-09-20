# marketing-engine

A standalone, multi-tenant marketing engine: messaging, company discovery and
promocodes. One Node service, one Postgres, one HTTP API. No screens.

See `docs/ARCHITECTURE.md` for the design and `docs/briefs/` for the steps.

## Run it locally

You need Node 22 and a Postgres you can write to. Any Postgres will do; the
bundled compose file brings one up on `127.0.0.1:55432` with the `marketing`
and `marketing_test` databases already created:

```bash
docker compose up -d
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

`npm run test:live` sends one real SMS through Taqnyat. It is skipped unless
`TAQNYAT_BEARER`, `TAQNYAT_SENDER` and `LIVE_SMS_TO` are all set, and it is
never part of `npm test` or CI.

`npm run build` compiles to `dist/`; `npm start` runs the build.

## API

| Route | Auth | What |
| --- | --- | --- |
| `GET /health` | none | `{ ok, db }` |
| `POST /v1/events` | Bearer JWT | append one event |
| `GET /v1/events?type=&since=&limit=` | Bearer JWT | read this tenant's events |
| `POST /v1/consent` | Bearer JWT | record a `granted` or `revoked` consent |
| `POST /v1/suppression` | Bearer JWT | block an address for this tenant |
| `GET /v1/can-send?channel=&address=&purpose=&at=` | Bearer JWT | ask whether a message may go out |
| `GET /v1/rules`, `POST /v1/rules`, `DELETE /v1/rules/:id` | Bearer JWT | read all rules; create and delete this tenant's own |
| `PUT /v1/channels/:channel` | Bearer JWT | store this tenant's provider credentials for a channel |
| `GET /v1/channels/:channel` | Bearer JWT | the channel's provider and sender, never the credentials |
| `PUT /v1/templates/:name` | Bearer JWT | create or replace a Liquid template |
| `POST /v1/messages` | Bearer JWT | send intent: 202 when queued, 200 when `can_send` refused |
| `GET /v1/messages/:id` | Bearer JWT | one message and its status |
| `POST /webhooks/:provider/:token` | token in the URL | provider delivery reports |

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

## Can this message go out?

`can_send()` is the only place that answers, and it answers in a fixed order.
**Suppression** first: a block on the address, either this tenant's or a
platform-wide one, ends it immediately — an opt-out beats everything, including
a transactional message. **Consent** next, and only for `marketing`: the latest
consent row for that tenant, channel, address and purpose must say `granted`,
so a revoke recorded after a grant wins. Transactional messages skip this step.
**Rules** last: every enabled `sending_window` rule runs against the request in
scope order — platform, then the contact's region, then the tenant's own — and
the first rule that matches denies. That ordering is what stops a tenant from
writing a rule that lifts a platform or regional restriction; a tenant can only
add limits. The answer is `{ allowed: true }` or `{ allowed: false, reason }`
where `reason` is `suppressed`, `no_consent` or `rule`, naming the rule that
decided. `GET /v1/can-send` is a dry run and sends nothing.

Addresses are normalised before anything is stored or compared: phones to E.164,
emails lower-cased. A contact's region comes from its phone country, which is
what picks the time zone a sending window is measured in; email and telegram
have no region, so only platform and tenant rules apply to them. Pass
`defaultCountry` (ISO 3166-1 alpha-2) alongside a national number like
`0501234567` to have it parsed.

## Sending a message

`POST /v1/messages` takes an intent, not a channel command: who, which template,
which purpose. The engine normalises the address, loads the tenant's provider
config and template, asks `can_send`, and only then renders and queues. A
refusal is not an error — it is a `messages` row with `status: 'blocked'` and
the reason, returned with 200, and nothing reaches the queue. A `queued` message
comes back 202; the pg-boss worker sends it with the tenant's own credentials
and writes `sent`, and the provider's delivery report moves it to `delivered` or
`failed`. Every one of those transitions appends to `events`.

Marketing messages must have `unsubscribeText` on the channel config; it is
appended to the rendered body on its own line, and a send without it is a 422.
Templates are Liquid, rendered with `strictVariables`, so a missing variable is a
400 naming it rather than an empty string sent to a real phone.

Provider credentials are AES-256-GCM encrypted before they touch the database,
with a key the database never sees. Generate one with:

```bash
openssl rand -hex 32     # this is CREDENTIALS_KEY
```

`GET /v1/channels/:channel` returns the provider, sender and `configured: true`
and never the credentials themselves.

## Provider webhooks

Delivery reports arrive at:

```
POST https://<host>/webhooks/<provider>/<WEBHOOK_TOKEN>
```

There is no JWT — a provider has none — and SMS providers generally cannot sign
their callbacks, so the URL itself is the secret. A wrong token gets the same
404 as an unknown path. Set `WEBHOOK_TOKEN` to something long and random, and
treat the whole URL as a credential. A body the adapter cannot match is logged
and answered 202: replying 4xx to a provider makes it retry the same body
forever.

## Tenant isolation

Every tenant table has `tenant_id` and row-level security. Requests run inside
`withTenant()`, which opens a transaction, sets `app.tenant_id` and switches to
the non-owning `marketing_app` role — so the RLS policies actually apply rather
than being bypassed by the table owner. `events` is append-only: `marketing_app`
is granted `select, insert` and nothing more.
