# Brief 11 — Audiences and campaigns

Read `CLAUDE.md` and `docs/ARCHITECTURE.md` first. This adds the two things the engine is missing to deserve its name: a way to name a group of people, and a way to send to them later. It is a new module under `src/modules/campaigns/`; CLAUDE.md rule 8 asks before a new module, and the answer is yes.

Everything here goes through the existing `messaging.send()`. Nothing in this brief may bypass `can_send`, channel selection, templates, fallback or the event log. A campaign is a scheduler and a recipient list, nothing more.

## Part A — housekeeping (first commit)
- `POST /v1/messages` currently accepts `at` and uses it only for the rules check, which reads like a scheduled send and isn't. Rename it to `evaluateAt` in the request schema (keep `at` accepted for one release, mapped through, and note it in `docs/API.md` as deprecated), and add a line to the route's doc block: this does not delay the send; use campaigns for that.

## Part B — contacts and audiences

### Contacts
A contact today is a bare address on each message. Campaigns need a stored one.
- `contacts (id uuid pk, tenant_id uuid not null, phone text null, email text null, telegram text null, company_id uuid null references companies, name text null, locale text null, attributes jsonb not null default '{}', created_at, updated_at)`. Unique per tenant on each non-null address: three partial unique indexes on `(tenant_id, phone) where phone is not null`, and the same for email and telegram. Tenant RLS as usual.
- `upsertContact(tx, { tenantId, phone?, email?, telegram?, ... })`: normalise every address first (existing `normalize`), match on any address that already exists for that tenant, merge fields, never merge two existing contacts automatically (if the input matches two different contacts, return them and let the caller decide; route → 409 `contact_ambiguous`). Emit `contact.upserted`.
- Link to the registry when a company can be resolved from an address (same lookup `send()` already does).
- Routes: `POST /v1/contacts`, `GET /v1/contacts/:id`, `GET /v1/contacts?q&companyId&limit&cursor`, `PATCH /v1/contacts/:id`.

### Contact import with consent evidence
`POST /v1/contacts/import`, `text/csv`, header `phone,email,telegram,name,company_cr,attributes,consent_channels,consent_purpose,consent_source,consent_date`.
- `consent_channels` is `;`-separated (`sms;whatsapp`), `consent_purpose` is `marketing` or `transactional`, `consent_source` is free text describing the evidence ("signed supply agreement 2026-03-11"), `consent_date` is ISO.
- A row with consent columns filled records consent per channel through the existing `consent.record` with that source and date. A row without them imports the contact and records nothing: the contact exists, marketing to them will be blocked until consent arrives. Never infer consent from the presence of an address.
- Returns `{ rows, contactsCreated, contactsUpdated, consentRecorded, rejected: [{ row, reason }] }`. Up to 20,000 rows, parsed with the existing CSV reader, processed in batches of 500 inside separate transactions so one bad row can't roll back the file.

### Audiences
- `audiences (id uuid pk, tenant_id uuid not null, name text not null, kind text not null check (kind in ('static','search')), definition jsonb not null, created_at, updated_at)`, unique `(tenant_id, name)`.
  - `static`: members in `audience_members (audience_id, contact_id, added_at, primary key (audience_id, contact_id))`.
  - `search`: `definition` is `{ finderQuery: FinderQuery, contactFilter?: { hasChannel?: Channel[], tags?: string[], companyIds?: string[] } }`. Resolved at send time: run the finder, take the companies, take this tenant's contacts linked to those companies.
- `resolve(tx, audienceId, { limit })` returns contact ids. Deterministic order (contact id) so a resumed expansion doesn't repeat or skip.
- Routes: `POST /v1/audiences`, `GET /v1/audiences`, `GET /v1/audiences/:id`, `PATCH`, `DELETE`, `POST /v1/audiences/:id/members` (add by contact ids or by CSV of addresses), `DELETE /v1/audiences/:id/members/:contactId`, `POST /v1/audiences/:id/preview?limit=20` → the first N resolved contacts plus a total count and, for each, whether `can_send` would allow the campaign's purpose on its best channel. Preview is the honest "who will actually get this" answer and the UI should always show it before scheduling.

## Part C — campaigns

### Tables
- `campaigns (id uuid pk, tenant_id uuid not null, name text not null, audience_id uuid not null references audiences, template text not null, channel text null, purpose text not null, variables jsonb not null default '{}', scheduled_at timestamptz null, recurrence jsonb null, timezone text not null default 'Asia/Riyadh', throttle_per_minute int not null default 60, status text not null check (status in ('draft','scheduled','running','paused','done','cancelled','failed')), created_at, updated_at)`.
  - `channel` null means let selection decide per recipient.
  - `recurrence` is `{ cron: '0 10 * * 1', endsAt?: iso, maxRuns?: int }` or null for one-shot. Cron is interpreted in `timezone`.
  - `throttle_per_minute`: 1..600, default 60. This is a per-campaign send rate; it exists because a supplier firing 5,000 WhatsApp messages in a minute gets their number flagged.
- `campaign_runs (id uuid pk, campaign_id uuid not null, run_no int not null, started_at, finished_at, status text check (status in ('expanding','sending','done','cancelled','failed')), audience_size int null, queued int not null default 0, blocked int not null default 0, error text null)`, unique `(campaign_id, run_no)`.
- `campaign_recipients (run_id uuid not null references campaign_runs, contact_id uuid not null, message_id uuid null references messages, state text not null check (state in ('pending','queued','blocked','skipped')), reason text null, primary key (run_id, contact_id))`. This is the audience **snapshot**: taken once at expansion time, so a recurrence next Monday sends to that Monday's audience and never re-sends this Monday's. `messages` gains `campaign_run_id uuid null` for the reverse link.

### Lifecycle
1. `create` → `draft`. Validation: template exists for the channel (or for every channel the audience could use when `channel` is null); purpose valid; audience belongs to the tenant; cron parses; `scheduled_at` in the future.
2. `schedule(campaignId)` → `scheduled`; enqueue `campaign.run` with `startAfterSeconds` from `scheduled_at` (one-shot) or from the next cron occurrence in the campaign's timezone (recurring). One job, singleton-keyed on `campaign:<id>:<runNo>` so a double-schedule can't double-run.
3. `campaign.run` worker (owner role): create the `campaign_runs` row `expanding`; resolve the audience; insert `campaign_recipients` as `pending` in batches of 1,000; set `audience_size`; status `sending`; enqueue the first `campaign.batch`. For a recurring campaign, schedule the next occurrence now, before sending, so a long run can't delay the next one.
4. `campaign.batch` worker: take up to `ceil(throttle_per_minute / 6)` pending recipients (a tenth of a minute's allowance), for each one call `messaging.send()` in its own transaction with the campaign's template, variables (merged with `{ contact, company }`), purpose and channel. A `queued` message → recipient `queued` with the message id. A `blocked` message → recipient `blocked` with the reason, and no retry. A send that throws for a non-message reason (no template for that channel) → recipient `skipped` with the reason. Then re-enqueue itself with `startAfterSeconds: 10` until no pending remain, then mark the run `done` and, if one-shot, the campaign `done`. Counts on the run row are updated as it goes so the dashboard sees progress live.
5. `pause(campaignId)` → `paused`: the batch worker stops re-enqueuing; pending recipients stay pending. `resume` → re-enqueue. `cancel` → run and campaign `cancelled`; pending recipients `skipped` with reason `cancelled`; already-queued messages are not recalled (they are real sends).
6. Failure of the expansion itself → run `failed` with the error, campaign `failed`, event emitted. Individual recipient failures never fail the run.

### Guards
- A campaign whose purpose is `marketing` and whose audience preview shows zero sendable contacts refuses to schedule (400 `audience_empty`), rather than running and blocking everything.
- `maxRuns` and `endsAt` end a recurrence: when the next occurrence is past `endsAt` or `run_no >= maxRuns`, the campaign goes `done` instead of rescheduling.
- A tenant may have at most 5 campaigns in `running` at once (409 `too_many_running`); this is the crude backpressure that keeps one tenant from monopolising the queue. Note it in the README as a number to revisit.
- Events: `campaign.scheduled`, `campaign.run.started`, `campaign.run.finished` (payload: counts), `campaign.paused`, `campaign.cancelled`, `campaign.failed`. Per-recipient sends already emit `message.*`; do not duplicate them.

### Routes
`POST /v1/campaigns`, `GET /v1/campaigns?status=`, `GET /v1/campaigns/:id` (with the latest run's counts), `PATCH /v1/campaigns/:id` (draft only), `POST /v1/campaigns/:id/schedule`, `/pause`, `/resume`, `/cancel`, `GET /v1/campaigns/:id/runs`, `GET /v1/campaigns/:id/runs/:runId/recipients?state=` (with message status joined, so "who got it, who didn't, why" is one call).

## Part D — operator and dashboard
- `/internal/overview` gains a `campaigns` section: `{ scheduled, running, recipientsPending, sentInWindow, blockedInWindow }`, and the queue table naturally shows `campaign.run` and `campaign.batch`.
- `/internal/campaigns?tenantId&status&limit&cursor` and `/internal/campaigns/:id` (runs and counts) for the operator.
- Dashboard: a `#/campaigns` view (list with status, next run, last run counts; detail with the run history, a progress bar from `queued + blocked` over `audience_size`, and the recipients table filtered by state) and the campaigns card on the overview. Same rules as brief 10: the dashboard renders, the engine decides.

## Tests, CI (`test/campaigns.test.ts`)
1. Contact import: 5 rows, two with consent columns → contacts created, consent recorded only for those two; a marketing send to a consentless contact is blocked; rejected rows report their row number; a re-import updates rather than duplicates.
2. Static audience of 3 contacts, one suppressed, one without consent → preview shows 3 total, 1 sendable, with reasons.
3. One-shot campaign scheduled 2 seconds out with a fake SMS channel and 3 consented contacts: after the worker runs, one run row, 3 recipients `queued`, 3 messages with `campaign_run_id` set, run `done`, campaign `done`, `campaign.run.finished` counts match.
4. Blocked recipients: audience of 3 where 1 has no consent → recipient `blocked` reason `no_consent`, no message queued for it, run counts 2 queued / 1 blocked, run still `done`.
5. Snapshot: schedule a recurring campaign, run it, then add a contact to the audience, run the next occurrence → the new contact is in run 2 only; nobody from run 1 is re-sent.
6. Recurrence: cron `*/1 * * * *` with `maxRuns: 2` → exactly two runs, then campaign `done`, no third job scheduled. `endsAt` in the past after run 1 → `done`.
7. Throttle: `throttle_per_minute: 6` with 10 recipients → the first batch queues at most 1, a batch job is re-enqueued, and all 10 land after the worker is driven to completion (drive the jobs directly; don't sleep in the test).
8. Pause mid-run leaves pending recipients pending and stops re-enqueue; resume finishes them; cancel marks the rest `skipped` and does not touch already-queued messages.
9. Search audience: two companies match a finder query, each with one contact → resolve returns both contacts; a company that goes on-platform drops out of the next run.
10. Guards: scheduling a marketing campaign with zero sendable contacts → 400; a sixth running campaign → 409; `scheduled_at` in the past → 400.
11. Idempotency: the `campaign.run` job delivered twice for the same run number creates one run and one set of recipients.
12. Tenant B sees none of A's contacts, audiences, campaigns or runs.

## Done when
CI passes; `npm run e2e` gains a campaign leg (create contacts, audience, campaign scheduled 1s out, drive the workers, assert 3 messages and the `campaign.run.finished` event on the webhook); `docs/API.md` covers the new routes; the dashboard shows a campaign running; README documents the throttle and concurrency numbers and where to change them.

## Do not
- Bypass `messaging.send()`. Every recipient goes through consent, rules, selection and fallback exactly as a single send does.
- Add A/B variants, drip sequences, open/click tracking, or template personalisation beyond the variables already supported.
- Add a scheduling library. pg-boss cron and `startAfterSeconds` are the mechanism; parse cron with a hand-written next-occurrence function for the timezone maths (it only needs standard 5-field crons) and unit-test it, or use pg-boss's own schedule where it fits.
- Send during expansion. Expansion snapshots; batches send.
- Let a run's failure retry the whole audience. Recipients are the retry unit, and blocked is terminal.

## Report back
PR titled `11 audiences and campaigns`. Description: CI output, the e2e campaign leg, a dashboard screenshot of a campaign mid-run, and anything the brief left open. Add row 11 to the roadmap in `docs/ARCHITECTURE.md`.
