# Brief 12: campaign fixes (quiet-hours deferral, stuck-run recovery)

Read CLAUDE.md, docs/ARCHITECTURE.md and docs/briefs/11-campaigns.md first. Work in a clone of
github.com/jawadadas-g/marketing-engine on a branch 12-campaign-fixes off main. Save this brief as
docs/briefs/12-campaign-fixes.md in the first commit. One PR, small named commits, do not merge.
No new dependencies. If you can't push to GitHub from this box, stop and tell me.

## Fix 1: quiet hours defer campaign recipients instead of dropping them

Problem: in a campaign batch, a recipient blocked by a sending_window rule (e.g. the SA
09:00–21:00 marketing window) becomes `blocked`, which is terminal. A 5,000-recipient campaign at
60/min started at 20:00 permanently loses everyone reached after 21:00.

Change:
- Migration 0014: add `not_before timestamptz null` to campaign_recipients, and replace the
  pending index with one on (run_id, not_before, contact_id) where state = 'pending'.
- In the batch worker, before calling send() for a recipient, run the existing preflight for that
  contact/purpose/channel at now. Then:
  - allowed → send() exactly as today.
  - blocked ONLY because of a sending_window rule → do not call send() (no blocked message row,
    no message.blocked event). Leave the recipient `pending`, set not_before to the next time
    preflight would allow it, and set reason = 'deferred:<rule name>'.
  - blocked for anything else (suppressed, no_consent, no channel, …) → `blocked` as today.
    Never defer consent or suppression.
  If preflight's result can't cleanly tell a rule block from the others, add a structured field
  to it (e.g. the blocking rule's id/kind) rather than parsing reason strings.
- Next allowed time: step forward in 15-minute increments using the existing evaluate clock
  (`at`), up to 7 days. Memoise per (channel, region, purpose) within a batch so 5,000 recipients
  in one region cost one search, not 5,000. If no window opens within 7 days → `blocked` with
  reason 'no_sending_window'.
- If send() itself still comes back blocked by the rule (a window closing between preflight and
  send), treat it as blocked. Note that edge case in a comment; don't engineer around it.
- Batch selection takes pending recipients where not_before is null or <= now(), in contact_id
  order. When the only pending recipients left are deferred, re-enqueue the batch with
  startAfterSeconds = (earliest not_before - now), not 10s. The run stays `sending` and the
  campaign stays `running` until they're done. finishRun is unchanged, because deferred
  recipients are still pending.
- Run counts and the API: add `deferred` (pending with not_before > now) to the run counts
  returned by GET /v1/campaigns/:id, /runs and /internal/campaigns. The recipients list with
  ?state=pending shows not_before. The dashboard campaign detail shows "deferred until …" from
  the API; it computes nothing.
- Pause, resume and cancel keep working unchanged. Cancel marks deferred recipients skipped with
  reason 'cancelled'.
- A recurring campaign whose next run starts while the previous run still has deferred
  recipients: the new run proceeds as normal (runs are independent snapshots). Leave the old
  run's deferred recipients alone.

## Fix 2: recover runs whose batch chain died

Problem: if a campaign.batch or campaign.run job fails until pg-boss gives up (a DB error, a
crash), nothing re-enqueues it. The run stays `sending`/`expanding` forever, the campaign stays
`running`, and it holds one of the tenant's 5 running slots.

Change:
- Migration 0014 (same file): add `last_progress_at timestamptz not null default now()` to
  campaign_runs, and `attempts int not null default 0` to campaign_recipients.
- Update last_progress_at whenever expansion finishes a chunk and whenever a batch finishes.
- A new pg-boss cron job, `campaign.sweep`, every 5 minutes, registered like
  promo.expire-reservations. It runs as owner and scopes by tenant_id explicitly. Do not read
  pg-boss's own tables; use our columns.
  - Runs `expanding` with last_progress_at older than 10 min, whose campaign is scheduled or
    running → enqueueRun(same run_no). runCampaign already resumes an expanding run.
  - Runs `sending` whose campaign is `running`, with at least one pending recipient ready now
    (not_before null or <= now) and last_progress_at older than 5 min → enqueueBatch. The
    singleton keys make a duplicate a no-op.
  - Runs `sending` whose campaign is `running` with zero pending recipients → finishRun (a batch
    died right before finishing).
  - Emit `campaign.run.recovered` {runId, runNo, action} for each one it touches.
- Poison recipients: in sendOne, an unexpected (non-MessagingError, non-InvalidAddress) error
  increments that recipient's attempts in a separate transaction and rethrows. When attempts
  reaches 3, mark it `skipped` with reason 'error:<first 200 chars of message>' and carry on. One
  bad row must not kill the chain forever or loop the sweeper forever.
- Give campaign.run and campaign.batch an explicit retryLimit of 3 with backoff.

## Tests (test/campaigns.test.ts or a new test/campaign-fixes.test.ts; drive jobs directly, no sleeps, pin clocks)
1. SA marketing campaign, 10 consented recipients, throttle 6/min, clock at 20:58 Riyadh. After
   the batch at 20:58, the ones sent are queued. At 21:00+ the rest are pending with not_before =
   09:00 next day and reason deferred:…, with no blocked message rows for them. The run counts
   show deferred. Move the clock to 09:00 and drive: all 10 queued, run done, campaign done.
2. A recipient with no consent at 22:00 is `blocked no_consent`, not deferred.
3. A transactional campaign at 23:00 isn't deferred (the SA rule is marketing-only).
4. Cancel during deferral → deferred recipients skipped 'cancelled'.
5. No window within 7 days (a tenant rule that denies all hours) → blocked 'no_sending_window'.
6. Memoisation: 500 deferred recipients in one region trigger one window search. Assert via a
   counter or spy, not timing.
7. Sweep: a sending run with pending recipients and last_progress_at 6 min old gets a batch
   enqueued, and the campaign finishes. An expanding run 11 min old resumes and completes with no
   duplicate recipients. A sending run with zero pending gets finished. Running the sweep twice
   enqueues once.
8. Poison: a recipient whose send throws an unexpected error 3 times → skipped 'error:…'; the
   other recipients still get sent; the run completes.
9. Tenant isolation still holds: the sweep touching tenant A's run never writes to tenant B.

## Done when
CI passes (typecheck, tests, e2e, dashboard); docs/API.md documents `deferred`, `not_before`, the
reasons 'deferred:<rule>' / 'no_sending_window' / 'error:…' and the campaign.run.recovered event;
README notes the 15-min step, 7-day horizon and 5-min sweep as numbers to revisit; add row 12 to
the roadmap table in docs/ARCHITECTURE.md.

## Deploy (after the PR is open)
1. Staging only: build the branch into the marketing-staging stack. Take a pg_dump first.
   Migrations apply on start. Confirm /health and that migration 0014 is applied.
2. Staging smoke test: provision a tenant, connect the fake SMS channel, import 3 contacts with
   consent, create a static audience, schedule a campaign 1 minute out, and confirm it completes
   with 3 queued. Report the run counts from GET /v1/campaigns/:id.
3. Do NOT deploy to prod. I'll merge the PR, then you build main into marketing-prod (pg_dump
   first) and repeat the /health + migration check.

## Report back
PR link, the CI output, the staging smoke-test results, and anything this brief left open.
