-- 0008_promocodes: codes, redemptions and the internal ledger.
--
-- Every amount is an integer in the currency's minor unit (halalas for SAR).
-- Nothing here is ever a float: money arithmetic is integer arithmetic, and a
-- discount that does not divide evenly among its funders puts the remainder on
-- the first one rather than losing it to rounding.

-- ---------------------------------------------------------------------------
-- promocodes
-- ---------------------------------------------------------------------------
create table if not exists marketing.promocodes (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references marketing.tenants (id),
  code       text not null,
  currency   text not null,
  -- { type: 'percent'|'fixed', value, maxDiscount?, minSubtotal? }
  -- A percent value is basis points: 1000 is 10%.
  discount   jsonb not null,
  -- A json-logic document of kind promo_eligibility, carried on the code
  -- itself rather than in the rules table, so a code travels with its own
  -- conditions. Platform promo_eligibility rows in `rules` still run first.
  rules      jsonb null,
  -- { maxSpend?, maxUses?, perBuyerMaxUses? }
  budget     jsonb not null,
  -- [{ party: 'platform'|'tenant:<uuid>', share }], shares summing to 1.
  funders    jsonb not null,
  starts_at  timestamptz not null default now(),
  ends_at    timestamptz null,
  status     text not null check (status in ('active', 'paused', 'ended')) default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists promocodes_tenant_code_idx
  on marketing.promocodes (tenant_id, upper(code));

alter table marketing.promocodes enable row level security;

drop policy if exists promocodes_isolation on marketing.promocodes;
create policy promocodes_isolation on marketing.promocodes
  for all to marketing_app
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

grant select, insert, update on marketing.promocodes to marketing_app;

-- ---------------------------------------------------------------------------
-- redemptions
-- ---------------------------------------------------------------------------
create table if not exists marketing.redemptions (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references marketing.tenants (id),
  promocode_id    uuid not null references marketing.promocodes (id),
  buyer_ref       text not null,
  company_id      uuid null references marketing.companies (id),
  order_ref       text not null,
  currency        text not null,
  discount_amount bigint not null,
  status          text not null check (status in ('reserved', 'settled', 'released')),
  -- The hold each funder's share is sitting on, as the ledger returned them.
  holds           jsonb not null default '[]'::jsonb,
  reserved_at     timestamptz not null default now(),
  settled_at      timestamptz null,
  released_at     timestamptz null,
  release_reason  text null,
  expires_at      timestamptz not null
);

-- The order reference is the natural idempotency key: one order, one redemption.
create unique index if not exists redemptions_tenant_order_idx
  on marketing.redemptions (tenant_id, order_ref);
create index if not exists redemptions_promo_status_idx
  on marketing.redemptions (promocode_id, status);
create index if not exists redemptions_promo_buyer_idx
  on marketing.redemptions (promocode_id, buyer_ref);
create index if not exists redemptions_expiry_idx
  on marketing.redemptions (expires_at) where status = 'reserved';

alter table marketing.redemptions enable row level security;

drop policy if exists redemptions_isolation on marketing.redemptions;
create policy redemptions_isolation on marketing.redemptions
  for all to marketing_app
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

grant select, insert, update on marketing.redemptions to marketing_app;

-- ---------------------------------------------------------------------------
-- ledger_entries
-- ---------------------------------------------------------------------------
-- The internal Ledger implementation's store, one row per posting. The Ledger
-- interface hides it: nothing outside the ledger folder reads this table.
create table if not exists marketing.ledger_entries (
  id            bigserial primary key,
  tenant_id     uuid not null references marketing.tenants (id),
  redemption_id uuid not null references marketing.redemptions (id),
  party         text not null,
  currency      text not null,
  kind          text not null check (kind in ('hold', 'capture', 'release')),
  amount        bigint not null,
  hold_ref      text not null,
  created_at    timestamptz not null default now()
);

create index if not exists ledger_entries_tenant_party_idx
  on marketing.ledger_entries (tenant_id, party, currency);
create index if not exists ledger_entries_redemption_idx
  on marketing.ledger_entries (redemption_id);

-- One capture and one release at most per hold. A partial capture may be
-- followed by a release of what was not captured, so both can exist for one
-- hold; what cannot happen is capturing or releasing the same hold twice.
create unique index if not exists ledger_entries_settlement_idx
  on marketing.ledger_entries (hold_ref, kind)
  where kind in ('capture', 'release');

alter table marketing.ledger_entries enable row level security;

drop policy if exists ledger_entries_isolation on marketing.ledger_entries;
create policy ledger_entries_isolation on marketing.ledger_entries
  for all to marketing_app
  using (tenant_id = current_setting('app.tenant_id', true)::uuid)
  with check (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Append-only: a posting is never edited or deleted.
grant select, insert on marketing.ledger_entries to marketing_app;
grant usage on sequence marketing.ledger_entries_id_seq to marketing_app;
