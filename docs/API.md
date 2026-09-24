# marketing-engine API

Every route the engine serves. Hand-written, so if something here is wrong it is
a bug in this file — say so.

## Conventions

- **Money is an integer in the currency's minor unit.** Halalas for SAR. Never
  a float, never a major unit. `80000` is 800.00 SAR.
- **A percent discount is basis points.** `1000` is 10%.
- **Phone numbers are E.164** (`+9665…`). Send a national number only with
  `defaultCountry` beside it (ISO 3166-1 alpha-2), or it is rejected.
- **`Idempotency-Key` is required** on `POST /v1/redemptions` and the settle and
  release routes, and accepted everywhere else. The same key with a different
  body is a 422, not a replay.
- **Timestamps are ISO 8601 UTC.** IDs are UUIDs unless stated.
- Errors are `{ "error": "<code>", "message": "<human text>" }`. Validation
  failures add `detail` with the offending fields.

## Authentication

Three kinds, and a route takes exactly one.

**Tenant JWT** — `Authorization: Bearer <jwt>` on everything under `/v1`. The
marketplace mints these itself with the shared `JWT_SECRET`; the engine never
issues a token. HS256, and the only claim the engine reads is `tenant_id`:

```ts
import { SignJWT } from 'jose';

const token = await new SignJWT({ tenant_id: tenantId, sub: externalRef })
  .setProtectedHeader({ alg: 'HS256' })
  .setIssuedAt()
  .setExpirationTime('15m')
  .sign(new TextEncoder().encode(process.env.JWT_SECRET));
```

**Internal token** — `X-Internal-Token: <INTERNAL_TOKEN>` on `/internal/*`.
The marketplace's own key. These calls create the tenants that JWTs name, so
they cannot be scoped by one.

**None** — the public routes carry their own secret in the URL or the body.

---

## Tenants

### `POST /internal/tenants` — internal token

Provision a tenant. Idempotent on `externalRef`: asking twice returns the same
tenant, because the marketplace will retry.

```json
{ "name": "Acme Supplies", "externalRef": "mkt-company-1" }
```

→ `201 { "tenantId": "<uuid>", "name": "Acme Supplies" }` on the first call,
`200` with the same body afterwards. Emits `tenant.created`.

Errors: `400` invalid body, `401` wrong token.

---

## Channels

### `PUT /v1/channels/:channel` — tenant JWT

`:channel` is `sms`, `whatsapp`, `email` or `telegram`. The credentials are
checked against the provider before they are stored, and encrypted at rest.

```json
{
  "provider": "taqnyat",
  "sender": "GASABLE-AD",
  "unsubscribeText": "Reply STOP to unsubscribe",
  "config": { "token": "…" }
}
```

`config` keys by provider:

| provider | channel | keys |
| --- | --- | --- |
| `taqnyat` | sms | `token`, `baseUrl?` |
| `whatsapp-meta` | whatsapp | `accessToken`, `phoneNumberId`, `appSecret`, `apiVersion?` |
| `email-smtp` | email | `host`, `port`, `secure`, `user`, `pass`, `fromName?` |
| `telegram` | telegram | `botToken` |
| `fake` | all four | `token` (the value `"bad"` fails validation) |

→ `200 { "channel": { channel, provider, sender, unsubscribeText, configured, updatedAt } }`.
The credentials are never echoed. Emits `channel.configured`.

Errors: `400` invalid body, `422` `credentials_rejected` / `unknown_provider`.

### `GET /v1/channels/:channel` — tenant JWT

→ `200` with the same redacted shape, or `404`.

---

## Templates

### `PUT /v1/templates/:name` — tenant JWT

Liquid, rendered with `strictVariables`, so a missing variable is a 400 naming
it rather than an empty string sent to a real person.

```json
{
  "channel": "whatsapp",
  "body": "Hi {{ name }}",
  "subject": "Hello {{ name }}",
  "providerRef": { "name": "greet", "language": "ar", "params": ["name"] }
}
```

`subject` is required for `email`. `providerRef` is required for `whatsapp` and
names the Meta-approved template plus the order its positional parameters are
filled — Meta does not accept free text for business-initiated messages. A
template missing what its channel needs is `template_unfit`.

→ `200 { "template": { name, channel, body } }`. Emits `template.saved`.

Errors: `400` `template_invalid` (the Liquid does not parse).

---

## Messages

### `POST /v1/messages` — tenant JWT, `Idempotency-Key` accepted

An intent, not a channel command.

```json
{
  "contact": { "phone": "+9665…", "email": "a@b.co", "telegram": "123456789" },
  "channel": "whatsapp",
  "purpose": "marketing",
  "template": "order_update",
  "variables": { "order": "A-1043" },
  "defaultCountry": "SA",
  "evaluateAt": "2026-09-21T10:00:00Z"
}
```

Name a `channel` and that is the channel. Leave it out and the engine picks: it
asks suppression and consent of every channel the contact has both an address
and a configured provider for, lets a `channel_selection` rule order what is
left, and applies the sending window to the one it picks. The rest become the
fallback order. `evaluateAt` pins the clock the sending window and rules are
checked against, for testing. **It does not delay the send**: the message is
queued now either way. To send later, use a campaign.

`at` is the deprecated name for `evaluateAt`, accepted for one release and then
removed. When both are given, `evaluateAt` wins.

The older `{ "channel", "address" }` pair is still accepted and folded into a
contact. It will be removed.

→ `202 { "message": … }` when queued, `200` when `can_send` refused — a refusal
is an answer, not an error. The message carries `status`, `blockedReason`,
`fallbackChannels`, `parentMessageId` and the rendered `body`.

Statuses: `blocked`, `queued`, `sent`, `delivered`, `read`, `failed`.
Block reasons: `no_channel` (with each channel's reason in the
`message.blocked` event), or a specific one on a named channel.

Errors: `400` `address_missing` / `template_variable_missing`, `404`
`template_not_found`, `409` `channel_not_configured`, `422`
`unsubscribe_text_required` / `template_unfit`.

### `GET /v1/messages/:id` — tenant JWT

→ `200 { "message": … }` or `404`.

---

## Consent and suppression

### `POST /v1/consent` — tenant JWT

```json
{ "channel": "sms", "address": "+9665…", "purpose": "marketing",
  "status": "granted", "source": "signup-form", "defaultCountry": "SA" }
```

Append-only: the latest row for a contact and purpose wins, so a revoke after a
grant refuses. → `201 { "consent": … }`. Emits `consent.granted` / `consent.revoked`.

### `POST /v1/suppression` — tenant JWT

```json
{ "channel": "email", "address": "a@b.co", "reason": "complaint" }
```

→ `201 { "suppression": … }`. Emits `suppression.added`. Platform-wide blocks
exist but are not writable through the API.

### `GET /v1/can-send?channel=&address=&purpose=&at=&defaultCountry=` — tenant JWT

A dry run; sends nothing.

→ `200 { "allowed": true }` or
`{ "allowed": false, "reason": "suppressed" | "no_consent" | "rule", "rule": { id, name } }`.

The order is fixed and the first failure wins: suppression (an opt-out beats
everything, including a transactional message), then consent for `marketing`
only, then region-scoped `sending_window` rules in the contact's own local time.

---

## Rules

### `GET /v1/rules` — tenant JWT

→ `200 { "rules": [ … ] }`: platform, region and this tenant's own.

### `POST /v1/rules` — tenant JWT

```json
{ "kind": "sending_window", "name": "no-fridays",
  "document": { "==": [{ "var": "weekday" }, "fri"] } }
```

`kind` is `sending_window` or `channel_selection`. → `201 { "rule": … }`.

**Two senses, and they differ.** A `sending_window` rule *denies* when its
document is true. A `channel_selection` rule *returns a value* — an ordered
array of channels — and the most specific scope wins, so a tenant can reorder
its own channels but never lift a platform restriction, because every channel
returned still has to pass `can_send`. A promocode's own `rules` document is
different again: it says when the code *may* be used, so anything but `true`
refuses it.

### `DELETE /v1/rules/:id` — tenant JWT

Deletes only this tenant's own rule. A platform or region rule reads as `404`.
→ `204` or `404`.

---

## Companies

The prospect pool: companies **not** on the marketplace. `companies` and
`company_identifiers` are shared across tenants; what a tenant says *about* a
company is private to it.

### `POST /v1/companies` — tenant JWT

```json
{
  "name": "شركة الفلاح للتجارة",
  "country": "SA",
  "identifiers": [{ "type": "cr", "value": "1010123456" }],
  "source": { "type": "rfq", "ref": "RFQ-9" },
  "enrich": true,
  "defaultCountry": "SA",
  "tenantView": { "relationship": "prospect", "tags": ["vip"], "notes": "…" }
}
```

`source.type` is `rfq`, `import` or `api`. Identifier types are `cr`, `vat`,
`domain` (strong: they merge) and `phone`, `email` (weak: they link). An email
also yields its domain. `enrich: true` asks the registrar about a `cr` first,
when a lookup is configured.

→ `201 { "company", "created", "mergedFrom": [ … ] }`. Emits `company.created`
or `company.updated`, and `company.merged` when two records turn out to be one.

### `GET /v1/companies/:id` — tenant JWT

Follows a merge: asking for a merged-away id returns the survivor.

→ `200 { "company", "identifiers", "tenantView", "sources" }` or `404`.
`tenantView` and `sources` are yours only.

### `GET /v1/companies?identifier=cr:1010123456` — tenant JWT

Same shape, found by identifier. The value is normalised before matching.

### `PUT /v1/companies/:id/view` — tenant JWT

```json
{ "relationship": "customer", "tags": ["gold"], "notes": "…" }
```

→ `200 { "view": … }`. Yours; another tenant gets its own.

### `PUT /v1/companies/:id/profile` — tenant JWT

```json
{ "buys": ["diesel"], "sells": [], "sector": "energy", "city": "Riyadh", "size": "50-200" }
```

Shared, like the company. Category codes are free strings; the engine owns no
catalogue and validates nothing against one. → `200 { "profile": … }`. Emits
`company.profiled`.

### `POST /v1/companies/import` — tenant JWT, `Content-Type: text/csv`

Up to 5,000 rows. Header exactly:

```
name,country,cr,vat,domain,phone,email,relationship,tags
```

optionally followed by `,buys,sells,sector,city`. List columns are
`;`-separated. `?ref=<name>` labels the import; each row's source reference
becomes `<ref>:<line>`.

→ `200 { "rows", "created", "linked", "merged", "rejected": [{ row, reason }] }`.
A row that offered identifiers and had none survive normalisation is rejected
with its line number: nothing could ever match it.

---

## Discovery

### `POST /v1/discovery/search` — tenant JWT

```json
{ "buys": ["diesel"], "sector": "energy", "city": "Riyadh", "country": "SA",
  "text": "الفلاح", "excludeCompanyIds": [], "limit": 20 }
```

→ `200 { "finder", "finderRunId", "candidates": [{ company, profile, view, score, reasons }] }`.

`score` is 0..1 and comparable within one finder, not between finders. Every
search is logged; **pass `finderRunId` back on an invite** so the search can be
judged by its outcome.

**The matching algorithm is a placeholder.** `basic` is an AND of exact filters
plus trigram matching on the name, so everything it returns matched everything
asked and scores 1.0. Companies already on the marketplace, and merged-away
ones, are never returned.

### `POST /v1/companies/:id/invite` — tenant JWT

```json
{ "contact": { "phone": "+9665…" }, "channel": "sms", "template": "invite",
  "variables": {}, "expiresInDays": 14, "finderRunId": 42 }
```

The template gets `invite_url`. An invite is a transactional message, so consent
and the sending rules apply to it like anything else.

→ `202 { "invite", "message" }`, or `200 { "invite": null, "message": … }` when
`can_send` refused — no invite row is written. Emits `invite.sent`.

### `GET /v1/invites/:id` — tenant JWT

→ `200 { "invite": … }` or `404`.

---

## Promocodes

### `POST /v1/promocodes` — tenant JWT

```json
{
  "code": "SAVE10",
  "currency": "SAR",
  "discount": { "type": "percent", "value": 1000, "maxDiscount": 5000, "minSubtotal": 20000 },
  "budget": { "maxSpend": 500000, "maxUses": 100, "perBuyerMaxUses": 1 },
  "funders": [{ "party": "platform", "share": 0.6 }, { "party": "tenant:<uuid>", "share": 0.4 }],
  "rules": { ">=": [{ "var": "cart.subtotal" }, 100000] },
  "startsAt": "…", "endsAt": "…"
}
```

Funder shares sum to 1. A discount that does not divide evenly puts the
remainder on the first funder, so the parts always sum exactly.

→ `201 { "promocode": … }`. Emits `promo.created`.

Errors: `400` `invalid_currency` / `invalid_funders` / `invalid_discount`.

### `GET /v1/promocodes?status=` · `GET /v1/promocodes/:id` · `PATCH /v1/promocodes/:id`

List carries `usage: { uses, spend }`. `PATCH` takes `{ "status": "active" | "paused" | "ended" }`.

### `POST /v1/promocodes/validate` — tenant JWT

```json
{ "code": "SAVE10", "buyerRef": "cust-1", "companyId": null,
  "cart": { "currency": "SAR", "subtotal": 80000,
            "items": [{ "sku": "lpg", "qty": 1, "unitPrice": 80000 }] } }
```

→ `200 { "valid": true, "discountAmount": 5000, "promocodeId": … }` or
`200 { "valid": false, "reason": … }`. Reasons, first true one wins:
`not_found`, `not_active`, `currency_mismatch`, `min_subtotal`, `rule`,
`budget_uses`, `budget_buyer`, `budget_spend`. Writes nothing.

### `POST /v1/redemptions` — tenant JWT, **`Idempotency-Key` required**

The validate body plus `orderRef` and optional `ttlMinutes`. Locks the code and
re-checks everything, so two checkouts racing for the last use cannot both pass.
`orderRef` is the natural key: the same order twice returns the same redemption
and one set of holds.

→ `201 { "redemption": … }` or `200 { "valid": false, "reason": … }`.
Emits `promo.reserved`.

### `POST /v1/redemptions/:id/settle` — tenant JWT, **`Idempotency-Key` required**

`{ "finalDiscountAmount": 2500 }` — optional, and never above what was reserved.
Captures what was used and releases what was not, so no hold is left open.

→ `200 { "redemption": … }`. Emits `promo.settled`. `409` from any state but
`reserved`.

### `POST /v1/redemptions/:id/release` — tenant JWT, **`Idempotency-Key` required**

`{ "reason": "cancelled" }` → `200`. Emits `promo.released`. `409` from
`settled`: a refund is a marketplace matter. Reservations nobody settles or
releases are let go automatically after `RESERVATION_TTL_MINUTES`.

### `GET /v1/redemptions/:id` · `GET /v1/redemptions?orderRef=`

→ `200 { "redemption": … }` or `404`.

### `GET /v1/promocodes/reconcile` — tenant JWT

→ `200 { "reconciliation": [{ currency, settled: { redemptions, ledger, agrees },
outstanding: { redemptions, ledger, agrees } }] }`. Both `agrees` should be
true; if either is false, the ledger and the redemptions disagree and something
is wrong.

---

## Events

### `POST /v1/events` — tenant JWT

`{ "type", "subjectType", "subjectId", "payload" }` → `201 { "event": … }`.

### `GET /v1/events?type=&since=&limit=` — tenant JWT

→ `200 { "events": [ … ] }`, newest first. Append-only: nothing edits or
deletes an event.

---

## Webhooks out

### `POST /v1/webhooks` — tenant JWT

```json
{ "url": "https://marketplace.example.com/hooks/engine", "eventTypes": ["promo.settled"] }
```

Omit `eventTypes` for every event. The URL must be `https` unless the engine
itself is running on `http`.

→ `201 { "webhook": { id, url, eventTypes, active, createdAt }, "secret": "…" }`.
**The secret is shown once.** It is not retrievable; losing it means creating a
new endpoint.

### `GET /v1/webhooks` · `DELETE /v1/webhooks/:id`

→ `200 { "webhooks": [ … ] }` (no secrets) · `204` or `404`.

### `GET /v1/webhooks/:id/deliveries?status=` — tenant JWT

→ `200 { "deliveries": [ … ] }`, newest first, up to 200. Status is `pending`,
`delivered` or `failed`.

### `POST /v1/webhooks/:id/deliveries/:deliveryId/replay` — tenant JWT

→ `202 { "delivery": … }`, reset to `pending` and queued again.

### `POST /internal/webhooks` — internal token

The platform endpoint: hears every tenant's events, belongs to none, invisible
to all of them. Same body and response.

---

## Public routes

### `GET /i/:token`

The invite link. → `302` to `{MARKETPLACE_SIGNUP_URL}?invite=<token>` while the
invite is open, `410` once it is used or expired.

### `POST /internal/invites/accept` — internal token

`{ "token": "<invite token>", "ref": "<marketplace account id>" }` →
`200 { "companyId", "tenantId" }`. Marks the invite accepted, stamps the company
as on-platform, expires the company's other open invites, emits
`invite.accepted`. `409` if already accepted or expired, `404` if unknown.

### `POST` / `GET /unsubscribe/:token`

One-click opt-out from a marketing email's `List-Unsubscribe` header. The token
is an HMAC over tenant, channel and address, so there is no table behind it.
→ `200` (or a plain confirmation page on `GET`), `404` if tampered. Writes both
a suppression and a revoked consent.

### `POST` / `GET /webhooks/:provider/:token`

Provider callbacks; see below. → `202` almost always; `401` only for a bad
WhatsApp signature; `404` for a wrong token or unknown provider.

### `GET /health`

→ `200 { ok, db, boss, version }`, or `503` when the database is unreachable.

---

## What the marketplace has to implement

### 1. The invite handshake

1. Call `POST /v1/companies/:id/invite`. The engine sends a message containing
   `{PUBLIC_BASE_URL}/i/<token>`.
2. The invited company follows that link; the engine redirects to
   `{MARKETPLACE_SIGNUP_URL}?invite=<token>`.
3. **Your signup form carries `invite` through** to the account it creates.
4. Once the account exists, call `POST /internal/invites/accept` with
   `{ token, ref }` and your internal token.

From then on the company is out of the prospect pool's results.

### 2. The checkout handshake

1. **Validate at the cart** — `POST /v1/promocodes/validate` while the buyer is
   still typing. A refusal is a 200 with a reason.
2. **Reserve at order placed** — `POST /v1/redemptions` with an `orderRef` and
   an `Idempotency-Key`.
3. **Settle at order completed** — `POST /v1/redemptions/:id/settle`, with
   `finalDiscountAmount` if the order shrank.
4. **Release on cancel** — `POST /v1/redemptions/:id/release`.

Reconcile whenever you like; both `agrees` should always be true.

### 3. Receiving webhooks

Deliveries follow [Standard Webhooks](https://www.standardwebhooks.com), so any
library for it verifies them. Body:

```json
{ "id": "<event id>", "type": "promo.settled", "tenantId": "<uuid>",
  "occurredAt": "2026-09-21T10:00:00Z", "data": { } }
```

Headers: `webhook-id` (the delivery id), `webhook-timestamp` (unix seconds),
`webhook-signature` (`v1,<base64 hmac>`).

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(secret: string, headers: Record<string, string>, body: string): boolean {
  const timestamp = Number(headers['webhook-timestamp']);
  // Reject anything older than five minutes, or a replayed body is accepted
  // forever.
  if (Math.abs(Date.now() / 1000 - timestamp) > 300) return false;

  const expected = `v1,${createHmac('sha256', secret)
    .update(`${headers['webhook-id']}.${timestamp}.${body}`)
    .digest('base64')}`;

  const a = Buffer.from(headers['webhook-signature'] ?? '');
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

Answer `2xx`. Anything else is retried at 1m, 5m, 30m, 2h and 12h, then marked
failed and left for a manual replay. **Verify the timestamp**: the signature
alone does not stop an old body being replayed at you.

### 4. Registering the provider webhooks

Both use `{PUBLIC_BASE_URL}/webhooks/<provider>/<WEBHOOK_TOKEN>`.

- **WhatsApp (Meta)** — set it as the callback URL with `WEBHOOK_TOKEN` as the
  verify token. Meta GETs it once and expects the challenge echoed, which the
  engine does. Meta signs every payload; a bad signature is the one case a
  provider gets a 401.
- **Telegram** — register with the secret header:

  ```bash
  curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
    -d "url={PUBLIC_BASE_URL}/webhooks/telegram/<WEBHOOK_TOKEN>" \
    -d "secret_token=<WEBHOOK_TOKEN>"
  ```

- **Taqnyat** — set the delivery-report URL in their dashboard. Their callback
  shape is not in their OpenAPI spec, so the parser is deliberately permissive.
- **SMTP** — no callbacks. A sent email stays `sent`.

---

## Operator routes — internal token

The platform read side, across every tenant. `docs/DASHBOARD.md` is the guide
for building against these; this is the reference.

All of them take `X-Internal-Token`. A tenant JWT is a 401. Lists take `limit`
(1..500, default 100) and `cursor` (the last row's `id`) and return
`{ items, nextCursor }`, newest first. Windows are `since`/`until`, or
`window=1h|24h|7d|30d`.

### `GET /internal/overview?window=24h`

Everything a dashboard's front page needs, in one call:

```json
{
  "asOf": "…", "window": { "since": "…", "until": "…" },
  "health": { "db": true, "boss": "running (3 queued)", "version": "0.1.0" },
  "queue": [{ "name": "message.send", "created": 3, "active": 1, "retry": 2,
              "failed": 0, "cancelled": 0, "completedInWindow": 412 }],
  "messages": { "queued": 3, "sent": 200, "delivered": 180, "read": 40, "failed": 4, "blocked": 12 },
  "blockedReasons": { "no_consent": 9, "suppressed": 1, "rule:sa-marketing-sms-hours": 2 },
  "tenants": [{ "tenantId": "…", "tenantName": "…", "messages": {…},
                "invites": { "sent": 5, "accepted": 1 },
                "redemptions": { "reserved": 2, "settled": 9, "released": 1 },
                "webhookFailures": 0 }],
  "webhooks": { "pending": 1, "failed": 2 },
  "reservations": { "open": 2, "expiringWithin15m": 1 },
  "discovery": { "searches": 33, "invitesFromSearch": 4 }
}
```

`blockedReasons` counts the reason *per channel* from the `message.blocked`
event payload, not the `blocked_reason` column — that column says `no_channel`
for almost every block and would tell you nothing.

`queue` comes from pg-boss's own tables; `completedInWindow` reads its archive
too, because finished jobs move there.

### `GET /internal/tenants` · `GET /internal/tenants/:id`

The list carries each tenant's 24-hour counts. The detail adds channels
(redacted), template names, rule counts by kind, webhook endpoints (never the
secret) and counts over 24h, 7d and 30d.

### Feeds

| Route | Filters |
| --- | --- |
| `GET /internal/events` | `tenantId`, `type` (trailing `*` is a prefix), `subjectType`, `subjectId` |
| `GET /internal/events/:id` | one event with its full payload |
| `GET /internal/messages` | `tenantId`, `status`, `channel`, `provider`, `companyId`, `address` |
| `GET /internal/messages/:id` | the message, its events, delivery reports with raw provider bodies, fallback children and parent |
| `GET /internal/redemptions` | `tenantId`, `status`, `promocodeId` |
| `GET /internal/invites` | `tenantId`, `status` |
| `GET /internal/companies` | `q` (trigram on the normalised name), `country`, `onPlatform` |
| `GET /internal/webhook-deliveries` | `status`, `tenantId`, `endpointId` |

Each message row carries a `timeline` of its own events in order, so a list
answers "what happened to this?" without opening it.

### Queue

- `GET /internal/jobs?name&state` → pg-boss rows: `id`, `name`, `state`,
  `retryCount`, `retryLimit`, `data`, `output`, `createdOn`, `startedOn`,
  `completedOn`, plus `tenantId`/`tenantName` when the job's data names a
  message or delivery.
- `GET /internal/jobs/:id` → one job.
- `POST /internal/jobs/:id/retry` → `200 { "retried": id }` for a `failed` job,
  `409` for any other state, `404` if unknown.
- `GET /internal/schedules` → the crons with `cron`, `timezone`, `data`, and
  when each last completed with what outcome.

### Actions

- `POST /internal/webhook-deliveries/:id/replay` → `202`, any tenant including
  the platform endpoint.

### `GET /internal/metrics`

`series=messages|events|redemptions|searches`, `bucket=hour|day`, optional
`tenantId` and `groupBy` (`status`/`channel` for messages, `status` for
redemptions, `type` for events).

→ `{ bucket, series: [{ key, points: [["2026-09-21T10:00:00Z", 12], …] }] }`

### `GET /internal/stream`

Server-Sent Events, one frame per event as it commits. Optional `tenantId` and
`type` (trailing `*` is a prefix).

```
id: 48213
event: message.sent
data: {"id":"48213","type":"message.sent","tenantId":"…","subjectType":"message", …}
```

Send `Last-Event-ID` on reconnect and the engine replays what you missed (up to
1000 rows) before going live. A heartbeat comment arrives every 15 seconds. At
most 20 concurrent streams; the 21st gets `503 too_many_streams`. The payload
is small by design — `GET /internal/events/:id` has the rest.

Events reach the stream only when their transaction commits, so nothing you see
here was later rolled back.

---

## Event types

`tenant.created` · `channel.configured` · `template.saved` · `consent.granted` ·
`consent.revoked` · `suppression.added` · `message.queued` · `message.blocked` ·
`message.sent` · `message.delivered` · `message.read` · `message.failed` ·
`message.replied` · `message.fallback` · `company.created` · `company.updated` ·
`company.merged` · `company.profiled` · `discovery.searched` · `invite.sent` ·
`invite.accepted` · `promo.created` · `promo.reserved` · `promo.settled` ·
`promo.released`
