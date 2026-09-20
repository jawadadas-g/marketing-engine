# Brief 04 — Messaging, all channels

Read `CLAUDE.md` and `docs/ARCHITECTURE.md` first. This brief is roadmap step 4. After it, messaging is complete and standalone. No registry, no discovery, no promocodes.

## Part A — fixes from the step 3 review (first, one commit each)

1. **Transactional enqueue.** `enqueue(tx, name, data)` takes the caller's transaction and passes it to pg-boss via the `db` option on `send()` (a `{ executeSql(text, values) }` wrapper over the `postgres` tx), so the job row commits with the message row or not at all. Remove the "job may arrive before its row" comment and the not-found retry path in `processSend`; a missing message is now a bug and should fail loudly, not retry.
2. **Delivery reports are guarded.** `applyDeliveryReport` updates only `where status = 'sent'`, and a report that matches no row or an already-final row is logged and dropped without an event. Duplicate reports produce nothing.
3. **Provider validation outside the transaction.** In the channel-config route, call `validateCredentials` before `withTenant`, then store. No HTTP call while a DB transaction is open.
4. **Taqnyat callback mapping.** If a real delivery-report body was captured during step 3, paste it as a fixture in `test/fixtures/taqnyat-dlr.json`, tighten `parseWebhook` to it, and test it. If none was captured, leave the permissive parser and its TODO alone.

## Part B — the step

### Goal
One `POST /v1/messages` intent can go out on SMS, WhatsApp, email or Telegram. The engine picks the channel by rule when the caller does not, checks consent per channel, and falls back to the next channel when a send fails for good. Every adapter has a fake twin so CI proves the whole thing; live tests run per provider only when its credentials are present.

### Contacts now have one address per channel
`POST /v1/messages` body becomes:
```json
{
  "contact": { "phone": "+9665...", "email": "a@b.co", "telegram": "123456789" },
  "channel": "whatsapp",          // optional: omit and the engine picks
  "purpose": "marketing",
  "template": "order_update",
  "variables": { "order": "A-1043" },
  "defaultCountry": "SA",
  "at": "..."
}
```
`phone` serves both `sms` and `whatsapp`. The old `{ channel, address }` shape stays accepted for one release (map it into `contact`), then goes. Normalisation is unchanged, per address.

### Migration `0004_channels.sql`
- `templates`: add `subject text null` (email only, Liquid too) and `provider_ref jsonb null` (WhatsApp: `{ "name": "<meta template name>", "language": "ar", "params": ["order"] }` — which variables fill which positional body parameter, in order). Unique key unchanged.
- `messages`: add `fallback_channels text[] not null default '{}'` and `parent_message_id uuid null references messages` (set when a message is a fallback of another).
- `unsubscribe_tokens`: not a table. Tokens are HMAC-signed, see email below.

### Channel selection
- Rule kind `channel_selection`, evaluated with a new `decide(tx, { kind, tenantId, region, context })` in the rules spine that returns the first non-null value a rule produces (json-logic returns values, not just booleans). `evaluate` stays for deny/allow kinds.
- Context: `{ purpose, region, preferred, available: ["whatsapp","sms"], consented: { whatsapp: true, sms: false, email: true, telegram: false } }` where `available` = channels with both a config and an address, and `consented` comes from `can_send` on each available channel (suppression and consent only; the window rule is applied to the chosen channel afterwards).
- A rule returns an ordered array of channels. The engine takes the first that is in `available` and passes `can_send` in full; the rest become `fallback_channels`.
- No rule matched: default order `[preferred, whatsapp, sms, email, telegram]` with `preferred` dropped if absent, filtered the same way.
- Nothing passes: one `blocked` row with `blocked_reason = no_channel` and a `message.blocked` event whose payload lists each channel's reason.
- Seed one platform rule: `kind = channel_selection`, `name = default-marketing-order`, returns `["whatsapp","sms","email","telegram"]` when `purpose == marketing` else `null`. It exists so tenants can see the shape of a selection rule.

### Fallback
When `processSend` marks a message `failed` on its final attempt and `fallback_channels` is non-empty, it calls `send()` again (as owner, inside its own transaction) for the same contact and template on the next channel, with `parent_message_id` set and the remaining channels as the new `fallback_channels`. Emit `message.fallback` on the parent with the child id. A `blocked` result from the fallback is recorded as a blocked child; no further fallback from a blocked child. Rendering may fail for the new channel (no email subject, no WhatsApp `provider_ref`): record that as a blocked child with `blocked_reason = template_unfit`.

### Adapters (one file each, registry keyed by provider)

**WhatsApp, Meta Cloud API** (`adapters/whatsapp-meta.ts`, channel `whatsapp`). Config: `{ accessToken, phoneNumberId, appSecret, apiVersion? }`.
- `send`: `POST https://graph.facebook.com/{apiVersion|v21.0}/{phoneNumberId}/messages`, Bearer `accessToken`, body `{ "messaging_product": "whatsapp", "to": "<E.164 without +>", "type": "template", "template": { "name", "language": { "code" }, "components": [{ "type": "body", "parameters": [{ "type": "text", "text": "<var>" }...] }] } }`. Template name, language and the parameter order come from the template row's `provider_ref`; the rendered Liquid body is not sent (Meta only accepts approved templates for business-initiated messages). A template without `provider_ref` on this channel is `template_unfit`. Success: `messages[0].id`.
- `validateCredentials`: `GET /{phoneNumberId}` with the bearer; 200 is ok. `sender` is informational here (the display name); do not validate it.
- `parseWebhook`: verify `X-Hub-Signature-256` = `sha256=` + HMAC-SHA256 of the raw body with `appSecret`; a bad signature throws (the route turns that into 401, the one exception to "never 4xx a provider", because a wrong signature is not a malformed body). Map `entry[].changes[].value.statuses[]`: `sent` → ignore, `delivered` → `delivered`, `read` → `read`, `failed` → `failed`. Map `value.messages[]` (inbound) to `replied` with the text. `parseWebhook` therefore needs the raw body string and the tenant's `appSecret`: the webhook route resolves the tenant by `phoneNumberId` from `value.metadata.phone_number_id` before verifying. Add a `GET /webhooks/whatsapp-meta/:token` that answers Meta's verification handshake (`hub.mode`, `hub.verify_token` = `WEBHOOK_TOKEN`, echo `hub.challenge`).
- New statuses `read` and `replied`: `messages.status` check gains `'read'`; `replied` is an event only (`message.replied`, payload text), status unchanged.

**Email, SMTP** (`adapters/email-smtp.ts`, channel `email`). Config: `{ host, port, secure, user, pass, fromName? }`; `sender` is the from address.
- `send` with Nodemailer: `from`, `to`, `subject` (rendered from `templates.subject`; missing → `template_unfit`), `text` = rendered body. For `marketing`: headers `List-Unsubscribe: <https://{PUBLIC_BASE_URL}/unsubscribe/{token}>, <mailto:{sender}?subject=unsubscribe>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, where `token` = base64url of `tenantId:channel:address:hmac` signed with `WEBHOOK_TOKEN` derived key. Provider id = the SMTP `messageId`.
- `validateCredentials`: `transporter.verify()`.
- `parseWebhook`: returns `[]`. SMTP has no delivery reports; status stays `sent`.
- New public route `POST /unsubscribe/:token` (and `GET` returning a plain confirmation page, since some clients GET): verify the HMAC, then as owner insert a tenant-scoped suppression `reason = unsubscribe` and a consent `revoked` row `source = list-unsubscribe`. 200 on success, 404 on a bad token.

**Telegram, Bot API** (`adapters/telegram.ts`, channel `telegram`). Config: `{ botToken }`; `sender` informational. Address = `chat_id`.
- `send`: `POST https://api.telegram.org/bot{botToken}/sendMessage` `{ chat_id, text }`; success `result.message_id`. A 403 "bot was blocked by the user" throws with that text; the worker's final-attempt path handles it.
- `validateCredentials`: `GET /bot{botToken}/getMe`, `ok: true`.
- `parseWebhook`: verify header `X-Telegram-Bot-Api-Secret-Token` = `WEBHOOK_TOKEN` (set when you call `setWebhook`); map inbound `message.text` to `replied`. No delivery reports.

**Fake** generalises: `fakeAdapterFor(channel)` returns an adapter with `provider = 'fake'` for any channel, same recording and failure switch, keyed per channel so tests can fail WhatsApp and watch SMS pick up.

Registry: `adapterFor(provider, channel)`; `setChannelConfig` checks the pair.

### Webhook route
`POST /webhooks/:provider/:token` gains the raw body string and, for providers that need per-tenant secrets, a tenant lookup before verification. `GET` on the same path only for `whatsapp-meta`. A thrown signature error → 401.

### Env
Add `PUBLIC_BASE_URL` (for unsubscribe links). Live-test only: `WA_ACCESS_TOKEN`, `WA_PHONE_NUMBER_ID`, `WA_APP_SECRET`, `WA_TEMPLATE_NAME`, `WA_TEMPLATE_LANG`, `LIVE_WA_TO`; `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `LIVE_EMAIL_TO`; `TG_BOT_TOKEN`, `LIVE_TG_CHAT_ID`.

### Tests, CI (`test/channels.test.ts`, fake adapters on all four channels)
1. Part A: a rolled-back `send()` leaves no row in `pgboss.job`; a second delivery report for the same id changes nothing and emits nothing.
2. Four contacts, four channels: configure fake on all four; contact A consents only WhatsApp, B only SMS, C only email, D only Telegram; one marketing intent each with no `channel` → each `queued` on its consented channel; `fallback_channels` holds the remaining consented channels (empty here).
3. Explicit `channel: "email"` with no email address → 400 `address_missing`.
4. Tenant `channel_selection` rule returning `["sms"]` overrides the platform default for that tenant.
5. Fallback: contact consented on WhatsApp and SMS, fake WhatsApp set to fail; after the final attempt the parent is `failed`, a child exists on `sms` with `parent_message_id`, `message.fallback` emitted, child `processSend` → `sent`.
6. Fallback to a channel whose template is unfit (WhatsApp template without `provider_ref`) → blocked child `template_unfit`, no further fallback.
7. Nothing consented → one `blocked` row `no_channel`, payload lists each channel's reason.
8. Email marketing: rendered mail (fake records headers) carries `List-Unsubscribe` and `List-Unsubscribe-Post`; `POST /unsubscribe/<token>` → 200, then `can_send` says `suppressed`; a tampered token → 404.
9. WhatsApp webhook: signed body with a `delivered` status → `delivered`; unsigned → 401 and nothing changes; an inbound message → `message.replied` event with the text; `GET` handshake echoes the challenge.
10. Telegram webhook with the wrong secret header → 404; with the right one and an inbound text → `message.replied`.
11. Tenant B cannot read A's messages or templates (bare `select` under `withTenant`).

### Tests, live (`test/live/*.live.test.ts`, `npm run test:live`)
One file per provider, each skipped unless its env vars are set. Each: `validateCredentials` ok, one transactional send to the live address, `processSend` → `sent` with a provider id. Run whichever you have credentials for; the phone/inbox/chat receiving it is the check.

### Done when
CI passes; at least one live provider besides Taqnyat has sent a real message; README documents the new intent shape, the four providers' config keys, the webhook URLs to register with each provider (including the WhatsApp verification handshake and Telegram `setWebhook` command), and the unsubscribe route.

## Do not
- Add any dependency other than `nodemailer` (and `@types/nodemailer`). Meta and Telegram are `fetch`.
- Add a contacts table. Addresses still live on the message and consent rows.
- Build a scheduler, campaigns, or read-receipt tracking pixels for email.
- Handle inbound STOP/opt-out text automatically. `replied` events are recorded; acting on them is a rule for a later step.

## Report back
PR titled `04 messaging, all channels`. Description: CI output, which live providers were run and their responses, and any decision the brief left open. Update `docs/ARCHITECTURE.md` roadmap row 4 to "done" with the date.
