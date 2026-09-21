# Brief 07 — Promocodes

Read `CLAUDE.md` and `docs/ARCHITECTURE.md` first. This brief is roadmap step 7. The marketplace's checkout calls these routes; the engine never sees a cart it wasn't handed.

## Part A — housekeeping (first commit)

Add `finder_run_id bigint null references finder_runs` to `invites`, and an optional `finderRunId` on `POST /v1/companies/:id/invite` that the UI passes when the invite came from a search result. Emit it in `invite.sent` and `invite.accepted` payloads. This is the only outcome signal discovery has; without it, every search from now on is unrecoverable data.

## Part B — the step

### Goal
A tenant creates a code with rules, a budget and named funders. Checkout validates it, reserves the discount when the order is placed, settles it when the order completes, releases it on cancel or timeout. Every reservation is a hold on a ledger; every settlement a capture; the ledger and the redemptions table agree at all times.

### Definitions
- **Funder**: who pays for the discount. `{ party: 'platform' | 'tenant:<uuid>', share: 0..1 }`, shares summing to 1. In v1 the tenant creating the code can name itself, the platform, or split. Money is never moved between funders by the engine; the ledger records who owes what.
- **Buyer**: a string `buyerRef` the marketplace supplies (its own customer id) plus an optional `companyId` from the registry. Per-buyer limits key on `buyerRef`.
- **Cart**: `{ currency, subtotal, items: [{ sku?, category?, qty, unitPrice }] }`. Amounts are integers in minor units (halalas). The engine trusts the cart; the marketplace is the source of truth for prices.
- **Discount**: `{ type: 'percent' | 'fixed', value, maxDiscount?, minSubtotal? }`. Percent value is basis points (1000 = 10%). Result is always an integer in minor units, rounded down.

### Migration `0007_promocodes.sql`
All under `marketing`, tenant RLS as usual unless noted.
- `promocodes (id uuid pk default gen_random_uuid(), tenant_id uuid not null, code text not null, currency text not null, discount jsonb not null, rules jsonb null, budget jsonb not null, funders jsonb not null, starts_at timestamptz not null default now(), ends_at timestamptz null, status text not null check (status in ('active','paused','ended')) default 'active', created_at, updated_at)`, unique `(tenant_id, upper(code))`. `budget = { maxSpend?, maxUses?, perBuyerMaxUses? }`; `rules` is a json-logic document evaluated with kind `promo_eligibility` (tenant scope, inline on the code rather than in the `rules` table, so a code carries its own conditions; platform `promo_eligibility` rows in `rules` still run first as usual). `marketing_app`: select, insert, update.
- `redemptions (id uuid pk default gen_random_uuid(), tenant_id uuid not null, promocode_id uuid not null references promocodes, buyer_ref text not null, company_id uuid null references companies, order_ref text not null, currency text not null, discount_amount bigint not null, status text not null check (status in ('reserved','settled','released')), reserved_at, settled_at, released_at, release_reason text null, expires_at timestamptz not null)`, unique `(tenant_id, order_ref)`. Index `(promocode_id, status)`, `(promocode_id, buyer_ref)`. `marketing_app`: select, insert, update.
- `ledger_entries (id bigserial pk, tenant_id uuid not null, redemption_id uuid not null references redemptions, party text not null, currency text not null, kind text not null check (kind in ('hold','capture','release')), amount bigint not null, hold_ref text not null, created_at)`. Append-only; `marketing_app` select, insert. This is the internal `Ledger` implementation's store, one row per posting. The interface hides it.

### `Ledger` interface (`src/modules/promocodes/ledger/types.ts`)
```ts
interface Ledger {
  readonly name: string;   // 'internal' | 'finance-engine'
  hold(tx, { tenantId, redemptionId, party, currency, amount }): Promise<{ holdRef: string }>;
  capture(tx, { tenantId, redemptionId, holdRef, amount }): Promise<void>;   // amount <= held
  release(tx, { tenantId, redemptionId, holdRef }): Promise<void>;
  balance(tx, { tenantId, party, currency }): Promise<{ held: number; captured: number }>;
}
```
- `internal.ts`: writes `ledger_entries`. `holdRef` = the entry id. `balance` sums by kind. Invariant per hold: at most one capture or one release, never both; enforce with a partial unique index on `(hold_ref, kind) where kind in ('capture','release')` plus a check in code.
- `finance-engine.ts`: stub that throws `not configured` unless `FINANCE_ENGINE_URL` is set; document in a comment the four calls it will make. Do not implement the HTTP client; there is no endpoint yet.
- Active ledger from env `LEDGER` (default `internal`).

### Promocodes module (`src/modules/promocodes/`)
- `create(tx, input)`: validate discount/budget/funders (shares sum to 1 within 1e-6; currency 3 letters; `rules` parses as json-logic); emit `promo.created`.
- `compute(promo, cart)`: pure. Returns the discount amount or a reason: `min_subtotal`, `currency_mismatch`.
- `validate(tx, { tenantId, code, buyerRef, companyId?, cart, at? })` → `{ valid: true, discountAmount, promocodeId } | { valid: false, reason }`. Order of checks, first failure wins: `not_found` → `not_active` (status, `starts_at`, `ends_at`) → `currency_mismatch` → `min_subtotal` → `rule` (platform `promo_eligibility` rules via `evaluate`, then the code's own document; context `{ buyerRef, companyId, cart, code, now }`) → `budget_uses` (`maxUses` vs count of `reserved+settled`) → `budget_buyer` (`perBuyerMaxUses` vs that buyer's `reserved+settled`) → `budget_spend` (`maxSpend` vs sum of `reserved+settled` amounts plus this discount). Reads only; emits nothing.
- `reserve(tx, { ...validate input, orderRef, ttlMinutes = 60 })`: runs `validate` inside the same transaction with `select ... for update` on the promocode row (so two concurrent reserves cannot both pass the budget), inserts the redemption `reserved` with `expires_at`, then one `ledger.hold` per funder for `round(discount * share)` with the remainder on the first funder so the parts sum exactly, stores hold refs on the redemption in a `holds jsonb` column (add it), emits `promo.reserved`. Returns the redemption. Same `orderRef` again → returns the existing redemption (idempotent by the unique key).
- `settle(tx, { tenantId, redemptionId, finalDiscountAmount? })`: only from `reserved`; `finalDiscountAmount` may be lower than reserved (partial order), never higher; `ledger.capture` per hold for the proportional part; status `settled`; emit `promo.settled`. From any other status → 409.
- `release(tx, { tenantId, redemptionId, reason })`: only from `reserved`; `ledger.release` per hold; status `released`; emit `promo.released`. From `settled` → 409 (a refund is a marketplace matter, not a promo matter, in v1).
- `expireReservations()` (owner, pg-boss cron every 5 minutes): every `reserved` row past `expires_at` → `release` with reason `expired`.
- `reconcile(tx, tenantId)`: for each currency, `sum(discount_amount where settled)` must equal `ledger.balance().captured`, and `sum(discount_amount where reserved)` must equal `held - captured - released`. Returns the two comparisons. This is the "spend equals settlement" check as a callable.

### Routes
- `POST /v1/promocodes` → 201. `GET /v1/promocodes/:id`, `GET /v1/promocodes?status=` → list with usage counts. `PATCH /v1/promocodes/:id` body `{ status }` only.
- `POST /v1/promocodes/validate` body `{ code, buyerRef, companyId?, cart, at? }` → 200 with the validate result (also 200 when invalid; the reason is the payload).
- `POST /v1/redemptions` body `{ code, buyerRef, companyId?, cart, orderRef, ttlMinutes? }` → 201 redemption, or 200 with `{ valid: false, reason }`. Idempotency middleware applies and `orderRef` is the natural key anyway.
- `POST /v1/redemptions/:id/settle` body `{ finalDiscountAmount? }` → 200. `POST /v1/redemptions/:id/release` body `{ reason }` → 200.
- `GET /v1/redemptions/:id`; `GET /v1/redemptions?orderRef=`.
- `GET /v1/promocodes/reconcile` → the reconcile result for the tenant.

### Env
`LEDGER` (default `internal`), `FINANCE_ENGINE_URL` (unused until the adapter exists), `RESERVATION_TTL_MINUTES` (default 60).

### Tests, CI (`test/promocodes.test.ts`, internal ledger)
1. Create a 10% code, max discount 5000, funders `platform 0.6 / tenant 0.4`; cart subtotal 80000 SAR → validate `discountAmount 5000`. Subtotal 30000 → 3000. `minSubtotal 50000` and subtotal 30000 → `min_subtotal`.
2. Reserve → redemption `reserved`, two `hold` entries 3000 and 2000 (60/40 of 5000), `promo.reserved` emitted; `reconcile` shows held 5000, captured 0.
3. Settle in full → two `capture` entries, status `settled`, `reconcile` captured 5000 equals settled discount sum.
4. Reserve then release → two `release` entries, status `released`; reconcile held 0.
5. Settle with `finalDiscountAmount 2500` → captures 1500 and 1000; the un-captured remainder is released automatically so no hold stays open; reconcile agrees.
6. Same `orderRef` reserved twice → one redemption, one set of holds.
7. `maxUses 1`: second buyer's reserve → `budget_uses`. `perBuyerMaxUses 1`: same buyer twice on different orders → `budget_buyer`. `maxSpend 6000`: after a 5000 reserve, a 3000 validate → `budget_spend`.
8. Concurrency: two `reserve` calls for a `maxUses 1` code fired in parallel → exactly one succeeds, one gets `budget_uses`; one hold set exists.
9. Expiry: a redemption with `expires_at` in the past, run `expireReservations()` → `released` with reason `expired`, ledger releases written.
10. A code rule `{ ">=": [{ var: "cart.subtotal" }, 100000] }` → `rule` for a 50000 cart; a platform `promo_eligibility` rule denying `buyerRef == 'banned'` → `rule` regardless of the code.
11. Rounding: 3 funders at 1/3 each on a 1000 discount → holds 334, 333, 333 (remainder on the first), sum exactly 1000.
12. Settle from `released` → 409; release from `settled` → 409.
13. `LEDGER=finance-engine` with no URL → `reserve` fails loudly with `not configured`; nothing written.
14. Tenant B cannot see A's codes, redemptions or ledger entries.

### Done when
CI passes; `reconcile` is exercised in tests after every state change; README documents the checkout handshake (validate at cart, reserve at order placed, settle at order completed, release at cancel) with the minor-unit and basis-point conventions stated in bold.

## Do not
- Add any dependency. Money math is integer arithmetic on bigints.
- Implement the finance-engine HTTP client. The stub and the interface are the deliverable.
- Add campaigns, code generation in bulk, or automatic (no-code) promotions. A code is created one at a time with a code string the tenant supplies; a 10-line random generator helper is fine.
- Move money between funders or compute payouts. The ledger says who owes what; settlement between parties is the finance engine's job later.
- Allow a redemption to change promocode after reservation.

## Report back
PR titled `07 promocodes`. Description: CI output including the concurrency test, and any decision the brief left open. Update the roadmap row in `docs/ARCHITECTURE.md`.
