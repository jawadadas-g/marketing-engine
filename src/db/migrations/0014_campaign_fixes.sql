-- 0014_campaign_fixes: recipients a sending window defers rather than drops,
-- and what the sweeper needs to find runs whose job chain died.

-- When a deferred recipient may be tried again. Null: now. A recipient waiting
-- on a quiet hour stays `pending` with this set; nothing else changes state.
alter table marketing.campaign_recipients add column if not exists not_before timestamptz null;

-- How many times sending to this recipient threw something unexpected. At 3 it
-- is skipped, so one bad row cannot stall a run or loop the sweeper forever.
alter table marketing.campaign_recipients add column if not exists attempts int not null default 0;

-- Batches pick pending recipients that are ready now, in contact order.
drop index if exists marketing.campaign_recipients_pending_idx;
create index if not exists campaign_recipients_pending_idx
  on marketing.campaign_recipients (run_id, not_before, contact_id) where state = 'pending';

-- Touched whenever expansion finishes a chunk and whenever a batch finishes.
-- A run that is expanding or sending and has not moved for a while has lost
-- its job; the sweeper reads this column, never pg-boss's tables.
alter table marketing.campaign_runs add column if not exists last_progress_at timestamptz not null default now();
