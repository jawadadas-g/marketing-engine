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
| `POST /webhooks/:provider/:token` | token in the URL | provider callbacks |
| `GET /webhooks/whatsapp-meta/:token` | token in the URL | Meta's subscription handshake |
| `POST`/`GET /unsubscribe/:token` | signed token | one-click opt-out from an email |

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
which purpose. A contact carries one address per channel, and a phone serves
both SMS and WhatsApp:

```json
{
  "contact": { "phone": "+9665...", "email": "a@b.co", "telegram": "123456789" },
  "purpose": "marketing",
  "template": "order_update",
  "variables": { "order": "A-1043" },
  "defaultCountry": "SA"
}
```

Name a `channel` and that is the channel. Leave it out and the engine picks:
it asks suppression and consent of every channel the contact has both an
address and a configured provider for, lets a `channel_selection` rule order
what is left, and applies the sending window to the one it picks. Channels
after the winner become its fallback order. A tenant's own selection rule beats
the platform default, because an order is a preference — whatever comes back,
every channel in it still has to pass `can_send`.

Nothing usable is not an error: it is a `messages` row with
`status: 'blocked'`, `blocked_reason: 'no_channel'` and a `message.blocked`
event naming each channel's reason, returned with 200. A `queued` message comes
back 202; the pg-boss worker sends it with the tenant's own credentials and
writes `sent`, and provider callbacks move it to `delivered`, `read` or
`failed`. When a send fails for good and a fallback remains, the worker re-runs
the same intent on the next channel as a child message and emits
`message.fallback`. Every transition appends to `events`.

Marketing messages on SMS, WhatsApp and Telegram need `unsubscribeText` on the
channel config; it is appended to the body on its own line, and a send without
it is a 422. Email carries its opt-out in the `List-Unsubscribe` header instead.
Templates are Liquid, rendered with `strictVariables`, so a missing variable is a
400 naming it rather than an empty string sent to a real person.

### The four providers

| Provider | Channel | `config` keys |
| --- | --- | --- |
| `taqnyat` | `sms` | `token`, `baseUrl?` |
| `whatsapp-meta` | `whatsapp` | `accessToken`, `phoneNumberId`, `appSecret`, `apiVersion?` |
| `email-smtp` | `email` | `host`, `port`, `secure`, `user`, `pass`, `fromName?` |
| `telegram` | `telegram` | `botToken` |
| `fake` | all four | `token` (`"bad"` fails validation) |

An email template needs a `subject`; a WhatsApp template needs a `providerRef`
naming the Meta-approved template and the order its positional parameters are
filled, because Meta does not accept free text for business-initiated messages:

```json
{ "channel": "whatsapp", "body": "Hi {{ name }}",
  "providerRef": { "name": "greet", "language": "ar", "params": ["name"] } }
```

A template missing the piece its channel needs is `template_unfit`.

Provider credentials are AES-256-GCM encrypted before they touch the database,
with a key the database never sees. Generate one with:

```bash
openssl rand -hex 32     # this is CREDENTIALS_KEY
```

`GET /v1/channels/:channel` returns the provider, sender and `configured: true`
and never the credentials themselves.

## Provider webhooks

Callbacks arrive at one URL shape, which you register with each provider:

```
POST https://<PUBLIC_BASE_URL>/webhooks/<provider>/<WEBHOOK_TOKEN>
```

There is no JWT — a provider has none — so the URL itself is the secret. A wrong
token gets the same 404 as an unknown path. Set `WEBHOOK_TOKEN` to something
long and random and treat the whole URL as a credential. A body an adapter
cannot make sense of is logged and answered 202: replying 4xx makes a provider
retry the same body forever.

- **Taqnyat** — set the delivery-report URL in the dashboard. The callback shape
  is not in their OpenAPI spec, so the parser is permissive and carries a TODO.
- **WhatsApp (Meta)** — register the same URL as the webhook callback with
  `WEBHOOK_TOKEN` as the verify token. Meta GETs it once and expects the
  challenge echoed, which `GET /webhooks/whatsapp-meta/:token` does. Meta signs
  every payload, so the tenant is resolved from `phone_number_id` and the body
  is checked against that tenant's `appSecret`. A bad signature is the one case
  a provider gets a 401 from us: it is not a malformed body, it is someone who
  should not be posting here.
- **Telegram** — register with the secret header:
  ```bash
  curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
    -d "url=https://<PUBLIC_BASE_URL>/webhooks/telegram/<WEBHOOK_TOKEN>" \
    -d "secret_token=<WEBHOOK_TOKEN>"
  ```
  Telegram has no delivery reports; the callback carries inbound replies only.
- **SMTP** — no callbacks at all. A sent email stays `sent`.

Inbound replies become `message.replied` events with the text. Acting on a STOP
reply is a rule for a later step; nothing is automatic yet.

## Unsubscribe

Marketing email carries `List-Unsubscribe` and `List-Unsubscribe-Post`, which is
what Gmail and Yahoo require on bulk mail and the difference between an opt-out
and a spam complaint. The link is
`<PUBLIC_BASE_URL>/unsubscribe/<token>`, where the token is an HMAC over the
tenant, channel and address signed with `WEBHOOK_TOKEN` — so there is no table
behind it and a tampered link is a 404. Following it writes both a suppression
and a revoked consent, so `can_send` says `suppressed` from then on.

## Tenant isolation

Every tenant table has `tenant_id` and row-level security. Requests run inside
`withTenant()`, which opens a transaction, sets `app.tenant_id` and switches to
the non-owning `marketing_app` role — so the RLS policies actually apply rather
than being bypassed by the table owner. `events` is append-only: `marketing_app`
is granted `select, insert` and nothing more.
