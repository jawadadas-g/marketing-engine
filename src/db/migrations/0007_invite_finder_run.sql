-- 0007_invite_finder_run: tie an invite back to the search that surfaced it.
--
-- This is the only outcome signal discovery has. finder_runs records what was
-- asked and how much came back; without this column there is no way to tell
-- which suggestions were any good, and every search until it exists is data
-- that cannot be recovered.
alter table marketing.invites
  add column if not exists finder_run_id bigint null references marketing.finder_runs (id);

create index if not exists invites_finder_run_idx
  on marketing.invites (finder_run_id) where finder_run_id is not null;
