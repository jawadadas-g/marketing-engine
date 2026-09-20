# Brief 03 — Messaging, one channel (SMS via Taqnyat)

Read `CLAUDE.md` and `docs/ARCHITECTURE.md` first. This brief is roadmap step 3. No WhatsApp, email or Telegram; no channel-selection rule. That is step 4.

## Part A — housekeeping (first commit)

- `test/helpers.ts` `resetDb()`: add `delete from rules where scope = 'tenant'` so a failed test cannot leak a tenant rule into the next run.

## Part B — the step

### Goal
`POST /v1/messages` takes an intent, runs it through `can_send`, renders a template, queues a job, and an adapter sends it with the tenant's own credentials. Delivery reports come back through a webhook and land in `events`. CI proves the whole pipeline with a fake adapter; a separate live test proves it with Taqnyat.

### Definitions
- **Adapter**: one file per provider implementing
  ```ts
  interface ChannelAdapter {
    readonly provider: string;           // 'taqnyat' | 'fake'
    readonly channel: Channel;           // 'sms'
    send(input: { config: ProviderConfig; to: string; body: string; sender: string })
      : Promise<{ providerMessageId: string; raw: unknown }>;
    parseWebhook(req: { headers: Record<string,string>; body: unknown })
      : Array<{ providerMessageId: string; status: 'delivered' | 'failed' | 'unknown'; raw: unknown }>;
    validateCredentials(config: ProviderConfig, sender: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  }
  ```
  A registry `adapters/index.ts` maps `provider` to adapter. Nothing outside `modules/messaging/adapters/` imports a provider.
- **Fake adapter** (`adapters/fake.ts`): `send` returns a deterministic id (`fake-<messageId>`) and records the call in a module-level array the tests can read and reset; `parseWebhook` accepts `{ id, status }`; `validateCredentials` returns ok unless `config.token === 'bad'`. Used by CI and local dev.
- **Taqnyat adapter** (`adapters/taqnyat.ts`), per Taqnyat's OpenAPI spec:
  - `send`: `POST {baseUrl}/v1/messages`, header `Authorization: Bearer <token>`, JSON body `{ "recipients": [966500000000], "body": "<text>", "sender": "<sender>" }`. Recipients are E.164 with the `+` stripped, as numbers. Success is HTTP 201 with `{ statusCode, messageId, cost, currency, totalCount, msgLength, accepted, rejected }`; take `messageId` as the provider id. Any other status, or `rejected` containing the number, is a thrown error with the response body in the message. `baseUrl` defaults to `https://api.taqnyat.sa` and is overridable in config.
  - `validateCredentials`: `GET {baseUrl}/v1/messages/senders` with the bearer; ok when the response lists `sender` with `status: "active"`; otherwise return the reason (`401` → bad token, missing → sender not on account).
  - `parseWebhook`: Taqnyat's delivery-report callback shape is not in their OpenAPI spec. Be permissive: accept any JSON body; if it has `messageId` (or `id`) and a `status` string, map `delivered|DELIVERED` to `delivered`, `failed|FAILED|undelivered|rejected` to `failed`, anything else to `unknown`; always return the raw body. The live test below records a real callback so the mapping can be tightened in a follow-up; put a TODO with that instruction above the function.

### Migration `0003_messaging.sql`
All under `marketing`, RLS for `marketing_app` as before.
- `tenant_channel_configs (id uuid pk default gen_random_uuid(), tenant_id uuid not null references tenants, channel text not null, provider text not null, sender text not null, unsubscribe_text text null, config_ciphertext bytea not null, config_iv bytea not null, config_tag bytea not null, created_at, updated_at)`, unique `(tenant_id, channel)`. One active provider per channel per tenant in v1. `marketing_app`: select, insert, update.
- `templates (id uuid pk, tenant_id uuid not null, name text not null, channel text not null, body text not null, created_at, updated_at)`, unique `(tenant_id, name, channel)`. `marketing_app`: select, insert, update.
- `messages (id uuid pk default gen_random_uuid(), tenant_id uuid not null, channel text not null, address text not null, region text null, purpose text not null, template_name text not null, body text not null, provider text null, provider_message_id text null, status text not null check (status in ('blocked','queued','sent','delivered','failed')), blocked_reason text null, error text null, created_at, updated_at)`. Indexes on `(tenant_id, created_at desc)` and `(provider, provider_message_id)`. `marketing_app`: select, insert only. Status changes are made by the worker and the webhook handler, which run as the owning role.

### Credentials at rest
`src/spine/secrets.ts`: `encrypt(json) → { ciphertext, iv, tag }` and `decrypt(...)` with AES-256-GCM from `node:crypto`, key from `CREDENTIALS_KEY` (32 bytes, hex). No library. The plaintext never appears in logs, events or API responses; `GET` of a channel config returns `provider`, `sender`, `unsubscribe_text` and `configured: true` only.

### Messaging module `src/modules/messaging/`
- `setChannelConfig(tx, { tenantId, channel, provider, sender, unsubscribeText?, config })`: `validateCredentials` first; on failure return the reason (route → 422). On success encrypt and upsert. Emit `channel.configured` (payload: provider, sender; never the config).
- `upsertTemplate(tx, { tenantId, name, channel, body })`: parse the body with LiquidJS once to reject syntax errors (route → 400). Emit `template.saved`.
- `send(tx, { tenantId, channel, address, purpose, template, variables, defaultCountry?, at? })`:
  1. `normalize` the contact.
  2. Load the tenant's channel config; none → 409 `channel_not_configured`.
  3. Load the template; none → 404.
  4. `canSend`. If refused: insert a `messages` row with `status = 'blocked'` and `blocked_reason` (`suppressed` / `no_consent` / `rule:<name>`), emit `message.blocked`, return the row. Nothing is queued.
  5. Render with LiquidJS, `strictVariables: true`, `strictFilters: true`; a missing variable → 400 `template_variable_missing` with the variable name. `variables` is the caller's object plus `contact.address`.
  6. If `purpose === 'marketing'`: the channel config must have a non-empty `unsubscribe_text`, appended to the body on its own line; missing → 422 `unsubscribe_text_required`. (The Saudi requirement from step 2's TODO. Region-specific wording is the tenant's, stored per channel.)
  7. Insert the `messages` row as `queued`, emit `message.queued`, `enqueue('message.send', { messageId })`. Return the row.
- `processSend(messageId)` in `worker.ts`: runs as owner (no `withTenant`). Load message, config (decrypt), adapter by `config.provider`; `adapter.send`; on success update `status = 'sent'`, `provider`, `provider_message_id`, emit `message.sent` (payload includes provider id). On throw: rethrow so pg-boss retries; the job is registered with `retryLimit: 3, retryBackoff: true`; on the final failure (pg-boss `failed` state, or `retryCount >= retryLimit` inside the handler) update `status = 'failed'`, `error`, emit `message.failed`. Export `processSend` so tests call it directly without running the queue loop.
- `applyDeliveryReport({ provider, providerMessageId, status, raw })`: owner role; find the message by `(provider, provider_message_id)`; `delivered` → status `delivered` + `message.delivered`; `failed` → status `failed` + `message.failed`; `unknown` or no match → emit only `provider.webhook.unmatched` with the raw body under a platform tenant id? No: there is no platform tenant. Log it with `console.warn` and return 202; nothing else. Never 4xx to a provider for a body we do not understand, or they retry forever.

### Routes
- `PUT /v1/channels/:channel` body `{ provider, sender, unsubscribeText?, config }` → 200 with the redacted config; 422 with the reason when validation fails.
- `GET /v1/channels/:channel` → redacted config or 404.
- `PUT /v1/templates/:name` body `{ channel, body }` → 200.
- `POST /v1/messages` body `{ channel, address, purpose, template, variables?, defaultCountry?, at? }` → 202 with the row when `queued`, 200 with the row when `blocked`. Idempotency middleware applies.
- `GET /v1/messages/:id` → the row.
- `POST /webhooks/:provider/:token`, no JWT: `token` must equal `WEBHOOK_TOKEN` env or 404 (so the URL itself is the secret; Taqnyat cannot sign callbacks). Route to `adapters[provider].parseWebhook`, then `applyDeliveryReport` per item, then 202.

### Env
Add to `.env.example`: `CREDENTIALS_KEY` (generate with `openssl rand -hex 32`), `WEBHOOK_TOKEN`. Live-test only, not read by the service: `TAQNYAT_URL`, `TAQNYAT_BEARER`, `TAQNYAT_SENDER`, `LIVE_SMS_TO`. In CI set `CREDENTIALS_KEY` to a fixed test value.

### Tests, CI (`test/messaging.test.ts`, fake adapter)
1. `PUT /v1/channels/sms` with `config.token = 'bad'` → 422; with a good token → 200 and the response contains no token; a bare `select config_ciphertext from tenant_channel_configs` as owner does not contain the token bytes.
2. Template with a syntax error → 400.
3. Send to an unconsented number with `purpose = marketing` → 200 `blocked`, `blocked_reason = no_consent`, one `message.blocked` event, no row in `pgboss.job` for `message.send`.
4. Transactional send with all variables → 202 `queued`, one job enqueued. `processSend(id)` → status `sent`, `provider_message_id = fake-<id>`, fake adapter recorded exactly one call with the rendered body, `message.sent` event.
5. Missing template variable → 400 naming it; nothing inserted.
6. Marketing send with consent and no `unsubscribe_text` → 422; with it → body ends with the unsubscribe line.
7. Webhook `POST /webhooks/fake/<token>` with `{ id: 'fake-<id>', status: 'delivered' }` → 202, message `delivered`, `message.delivered` event. Wrong token → 404. Unknown id → 202 and nothing changes.
8. Fake adapter set to throw → `processSend` throws; after the final attempt the message is `failed` with `error` set and a `message.failed` event.
9. Tenant B `GET /v1/messages/<A's id>` → 404; bare `select` under `withTenant(B)` → 0 rows.

### Test, live (`test/live/taqnyat.live.test.ts`, separate script `npm run test:live`)
Skipped unless `TAQNYAT_BEARER`, `TAQNYAT_SENDER` and `LIVE_SMS_TO` are all set. Uses the real Taqnyat adapter and a real tenant config: `validateCredentials` returns ok; `POST /v1/messages` transactional to `LIVE_SMS_TO` with template `Marketing engine test {{ n }}`; `processSend` → status `sent` with a numeric `provider_message_id`. Print the provider response. If Taqnyat's dashboard lets you set a delivery-report URL, point it at `https://<your-tunnel>/webhooks/taqnyat/<WEBHOOK_TOKEN>` and paste the first real callback body into the PR description so `parseWebhook` can be tightened in step 4.

### Done when
CI tests pass; `npm run test:live` passes on your machine and the phone receives the SMS; README documents the five routes, the webhook URL shape, and how to generate `CREDENTIALS_KEY`.

## Do not
- Add any dependency other than `liquidjs`. Encryption is `node:crypto`.
- Add a second channel or adapter beyond `fake` and `taqnyat`.
- Add a `contacts` or `companies` table. Messages store the raw address.
- Build inbound message handling (STOP replies). Taqnyat's SMS API has no inbound endpoint; opt-out arrives through `POST /v1/consent` or `/v1/suppression` for now.
- Retry outside pg-boss. No custom retry loops.

## Report back
PR titled `03 messaging, one channel`. Description: CI test output, live test output with the provider response, the real delivery-report body if you got one, and any decision the brief left open.
