-- 0010_idempotency_body: the same key with a different body is a mistake, not
-- a retry, and answering it with the first call's response would be wrong.
alter table marketing.idempotency_keys add column if not exists request_hash text null;
