# Brief 06 — Discovery skeleton

Read `CLAUDE.md` and `docs/ARCHITECTURE.md` first. This brief is roadmap step 6. It is a skeleton on purpose: the endpoints, the interface and the invite loop are real; the matching algorithm is a placeholder that will be replaced without touching anything else.

## Goal
A supplier asks "which off-platform corporate buyers should I talk to?" and gets a ranked list from the prospect pool. They invite one; the marketplace later reports the signup; the engine links the company to its new account. The ranking logic lives behind one interface with one deliberately trivial implementation.

## Scope
Off-platform corporate buyers only. Companies with `on_platform_ref` set are excluded from every result. No supplier search, no member matching, no PGroonga, no scoring rules.

## Migration `0006_discovery.sql`
- `company_profiles (company_id uuid pk references companies, buys text[] not null default '{}', sells text[] not null default '{}', sector text null, city text null, size text null, updated_at)`. Shared like `companies`; same RLS shape and grants. `buys`/`sells` hold your category codes as strings; the engine does not validate them against a catalogue in v1.
- `invites (id uuid pk default gen_random_uuid(), tenant_id uuid not null references tenants, company_id uuid not null references companies, message_id uuid null references messages, token text not null unique, status text not null check (status in ('sent','accepted','expired')), accepted_ref text null, created_at, accepted_at timestamptz null, expires_at timestamptz not null)`. Tenant RLS; grant select, insert. Status changes by owner role.
- `finder_runs (id bigserial pk, tenant_id uuid not null, finder text not null, query jsonb not null, result_count int not null, duration_ms int not null, created_at)`. Tenant RLS; insert, select. Every search is logged so the algorithm you choose later can be evaluated against what people actually asked.

## The Finder interface (`src/modules/discovery/finder/types.ts`)
```ts
export type FinderQuery = {
  buys?: string[];        // category codes the buyer should purchase
  sector?: string;
  city?: string;
  country?: string;
  text?: string;          // free text, meaning left to the implementation
  excludeCompanyIds?: string[];
  limit: number;          // 1..100
};

export type Candidate = {
  companyId: string;
  score: number;          // 0..1, higher is better; 1 = exact match on everything asked
  reasons: string[];      // human-readable, e.g. "buys: diesel", "city: Riyadh"
};

export interface Finder {
  readonly name: string;  // stored on finder_runs
  find(tx: Tx, tenantId: string, query: FinderQuery): Promise<Candidate[]>;
}
```
Rules for any implementation: never return a company with `merged_into` or `on_platform_ref` set; never return more than `limit`; `score` is comparable across calls of the same finder, not across finders. The active finder is chosen by env `FINDER` (default `basic`) from a registry `finder/index.ts`; adding an algorithm is a new file and one line there.

## `basic` finder (`finder/basic.ts`)
The placeholder. One SQL query: companies joined to profiles, `where merged_into is null and on_platform_ref is null`, then each present query field adds a filter (`buys && $buys`, `sector = $sector`, `city = $city`, `country = $country`; `text` uses `name_normalized % normalizeName($text)` via pg_trgm). Score = fraction of the asked fields the row matched (all filters are AND, so this is 1.0 for every row in v1; compute it anyway so the shape is exercised). Reasons list the matched fields. Order by `created_at desc`. Put a comment at the top saying this is the placeholder and what the interface guarantees.

## Discovery module (`src/modules/discovery/`)
- `search(tx, { tenantId, query })`: resolve the active finder, run it, log a `finder_runs` row, load the candidates' companies and profiles and the tenant's `tenant_company` view for each, return `{ finder, candidates: [{ company, profile, view, score, reasons }] }`. Also emit `discovery.searched` (payload: finder, query, count).
- `setProfile(tx, { companyId, buys?, sells?, sector?, city?, size? })`: upsert; emit `company.profiled`. Callable by any tenant (the pool is shared) and by imports.
- `invite(tx, { tenantId, companyId, channel?, contact, template, variables, expiresInDays = 14 })`: create the invite row with a random 32-byte base64url token; call `messaging.send` with `variables.invite_url = "{PUBLIC_BASE_URL}/i/{token}"` and `purpose = 'transactional'`; store `message_id`; emit `invite.sent`. If `send` returns `blocked`, the invite is not created and the blocked message is returned.
- `acceptInvite({ token, ref })` (owner role, called by the marketplace, not a tenant): find the invite by token; expired or already accepted → 409; else set `status = accepted`, `accepted_ref = ref`, and on the company `on_platform_ref = ref`, `on_platform_at = now()`; emit `invite.accepted` under the inviting tenant. Any other open invites for that company are marked `expired`.
- Extend the CSV import from step 5 with optional columns `buys,sells,sector,city` (`;`-separated lists) that populate the profile.

## Routes
- `POST /v1/discovery/search` body = `FinderQuery` → 200 with the result. Idempotency not applied (reads).
- `PUT /v1/companies/:id/profile` body `{ buys?, sells?, sector?, city?, size? }` → 200.
- `POST /v1/companies/:id/invite` body `{ contact, channel?, template, variables? }` → 202 `{ invite, message }` or 200 with the blocked message.
- `GET /v1/invites/:id` → the tenant's invite.
- `POST /internal/invites/accept` body `{ token, ref }`, authenticated by header `X-Internal-Token` = `INTERNAL_TOKEN` env (the marketplace's own key, not a tenant JWT) → 200 `{ companyId, tenantId }`. This is the marketplace's callback after signup.
- `GET /i/:token` public → 302 redirect to `{MARKETPLACE_SIGNUP_URL}?invite={token}` if the invite is open, else a plain 410 page. The marketplace's signup form carries the token through and calls the accept route when the account exists.

## Env
`FINDER` (default `basic`), `INTERNAL_TOKEN`, `MARKETPLACE_SIGNUP_URL`.

## Tests, CI (`test/discovery.test.ts`)
1. Three companies with profiles (`buys: {diesel}` in Riyadh; `buys: {diesel}` in Jeddah; `buys: {lpg}` in Riyadh). Search `{ buys: [diesel], city: Riyadh }` → exactly the first, score 1, reasons include both fields. Search `{ buys: [diesel] }` → two, `finder_runs` has two rows with `finder = 'basic'`.
2. A company with `on_platform_ref` set never appears; a merged loser never appears.
3. `text: "الفلاح"` matches `شركة الفلاح للتجارة` via trigram.
4. `limit: 1` returns one.
5. A test finder registered under `FINDER=test` that returns a fixed list proves the swap: same search endpoint, different results, `finder_runs.finder = 'test'`.
6. Invite: fake SMS configured, transactional template with `{{ invite_url }}` → 202, invite `sent`, message `queued` with the URL in the body, `invite.sent` emitted. `GET /i/:token` → 302 to the signup URL with the token. `POST /internal/invites/accept` with the right internal token → company `on_platform_ref` set, invite `accepted`, `invite.accepted` emitted; a second accept → 409; wrong internal token → 401. After acceptance the company is excluded from search.
7. Invite to a contact `can_send` refuses → 200 blocked, no invite row.
8. Expired invite: `expires_at` in the past → `GET /i/:token` 410, accept → 409.
9. Tenant B cannot read A's invites or finder runs.
10. CSV import with `buys;sells;sector;city` columns populates profiles.

## Done when
CI passes; README has a "Discovery" section that states plainly: the algorithm is a placeholder, how to add a finder (one file, one registry line, `FINDER` env), and the invite handshake the marketplace must implement (`/i/:token` → signup with `?invite=` → `POST /internal/invites/accept`).

## Do not
- Add any dependency. Trigram search is `pg_trgm` from step 5.
- Add PGroonga, a `match_score` rule kind, weights, or any ranking beyond "matched all asked fields".
- Add supplier search or any endpoint that returns marketplace members.
- Validate category codes against a catalogue.

## Report back
PR titled `06 discovery skeleton`. Description: CI output, and a short list of what the eventual algorithm will need from the engine that isn't there yet (extra profile fields, signals from events, whatever came up). Update the roadmap row in `docs/ARCHITECTURE.md`.

