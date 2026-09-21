-- 0011_trgm_schema: put pg_trgm somewhere that survives a restore.
--
-- 0005 created it with search_path set to `marketing, public`, so it landed
-- inside our own schema. A dump of `--schema=marketing` then refers to
-- `marketing.gin_trgm_ops` while carrying no CREATE EXTENSION, and restoring
-- into a fresh database silently drops the trigram index on company names —
-- free-text discovery comes back subtly broken rather than loudly missing.
-- Found by restoring a backup by hand.
--
-- In `public` the extension is shared infrastructure like any other, and the
-- restore procedure in the README creates it before loading the dump.
do $$
begin
  if exists (
    select 1 from pg_extension e
    join pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'pg_trgm' and n.nspname = 'marketing'
  ) then
    execute 'alter extension pg_trgm set schema public';
  end if;
end
$$;
