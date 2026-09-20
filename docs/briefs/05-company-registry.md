# Brief 05 — Company registry

Read `CLAUDE.md` and `docs/ARCHITECTURE.md` first. This brief is roadmap step 5. No search endpoints, no profiles, no invites; that is step 6.

Scope decision: the registry is a **platform-owned prospect pool of companies that are not on the marketplace**. Marketplace members are not mirrored in. Sources are imports, RFQ counterparties, API calls and lookups. Companies are shared across tenants (every supplier searches the same pool); what a tenant says about a company stays private to that tenant.

## Part A — housekeeping (first commit)

Amend CLAUDE.md rule 3 to: "Every tenant-owned table has `tenant_id` and RLS. The prospect-pool tables (`companies`, `company_identifiers`) are shared across tenants by design: readable by all, written only through `registry.upsert`. Everything a tenant says *about* a company lives in tenant-scoped tables." Mention the same in `docs/ARCHITECTURE.md` under The spine.

## Part B — the step

### Goal
One record per real off-platform company, whichever door it came through. `registry.upsert` is the only way in. Messages learn which company they went to. Nothing here searches or ranks; it stores and dedupes.

### Identifier normalisation (`src/spine/registry/identifiers.ts`, pure)
| type | rule | strength |
| --- | --- | --- |
| `cr` | digits only. Saudi CRs are 10 digits; the unified national number is 10 digits starting with 7. Keep both as-is after stripping. | strong |
| `vat` | digits only (Saudi: 15 digits starting with 3). | strong |
| `domain` | lower-case; strip scheme, `www.`, path, port. Reject free-mail domains (`gmail.com`, `hotmail.com`, `outlook.com`, `yahoo.com`, `icloud.com`, `live.com`, `msn.com`, `protonmail.com`) and the marketplace's own domain: they identify nobody. | strong |
| `phone` | E.164 via the existing `normalize`. | weak |
| `email` | lower-case, trimmed. Also derives a `domain` identifier unless free-mail. | weak |

Strong identifiers are unique per company and merge on match. Weak ones link but never merge, because a phone or a shared mailbox can belong to several companies over time.

### Name normalisation (`normalizeName`, pure)
For matching only; the stored `name` is the caller's. Lower-case; strip Arabic diacritics (tashkeel) and tatweel; unify `أ إ آ` → `ا`, `ة` → `ه`, `ى` → `ي`; collapse whitespace; drop legal-form tokens in both languages: `شركة`, `مؤسسة`, `ش.م.م`, `ذ.م.م`, `المحدودة`, `للتجارة`, `التجارية`, `co`, `co.`, `company`, `ltd`, `llc`, `inc`, `est`, `establishment`, `trading`, `limited`, `for trading`, `& co`. Keep everything else.

### Migration `0005_registry.sql`
- `create extension if not exists pg_trgm;`
- `companies (id uuid pk default gen_random_uuid(), name text not null, name_normalized text not null, country text null, on_platform_ref text null, on_platform_at timestamptz null, merged_into uuid null references companies, created_at, updated_at)`. `on_platform_ref` is the marketplace's own id once the company signs up (set by step 6's invite acceptance); such rows stay in the pool but discovery excludes them. GIN index `using gin (name_normalized gin_trgm_ops)`. Index on `merged_into`. RLS on with policy `using (true) with check (true)` for `marketing_app`; grant select, insert, update. Shared by design; the comment in the file says why.
- `company_identifiers (id bigserial pk, company_id uuid not null references companies, type text not null check (type in ('cr','vat','domain','phone','email')), value text not null, created_at)`, unique `(type, value)`. Same policy and grants.
- `company_sources (id bigserial pk, company_id uuid not null references companies, tenant_id uuid null references tenants, source_type text not null check (source_type in ('rfq','import','api','lookup')), source_ref text null, data jsonb not null default '{}', recorded_at timestamptz not null default now())`. RLS: `tenant_id is null or tenant_id = current tenant`. Grant select, insert. Provenance is the contributing tenant's; other tenants see the company, not who told us.
- `tenant_company (tenant_id uuid not null references tenants, company_id uuid not null references companies, relationship text null check (relationship in ('customer','supplier','prospect','other')), tags text[] not null default '{}', notes text null, created_at, updated_at, primary key (tenant_id, company_id))`. Tenant RLS as usual; grant select, insert, update, delete.
- `messages`: add `company_id uuid null references companies`. Index `(tenant_id, company_id)`.

### Registry spine `src/spine/registry/`
`upsert(tx, input)` where `input = { name, country?, identifiers: [{ type, value }], source: { type, ref?, tenantId?, data? }, defaultCountry? }` returns `{ company, created: boolean, mergedFrom: uuid[] }`.

1. Normalise every identifier; drop the invalid and the free-mail; derive domain from email. Compute `name_normalized`.
2. **Strong match.** Find distinct live companies (follow `merged_into` to the survivor) owning any of the strong identifiers. One → that is the company. Several → **merge**: the oldest `created_at` survives; the others get `merged_into = survivor`; their identifiers and sources are re-pointed; their `tenant_company` rows are re-pointed, and where a tenant already has a row for the survivor, tags are unioned, notes concatenated, the loser's row deleted; `messages.company_id` is re-pointed. Emit `company.merged` (payload: survivor, losers) under the calling tenant, or under no tenant if none (owner call). Merging is deterministic and reversible by hand because `merged_into` and the source rows are kept.
3. **Fuzzy match**, only when step 2 found nothing: `select id from companies where merged_into is null and (country is null or country = $country) and similarity(name_normalized, $name) >= 0.90 order by similarity desc limit 1`. A hit links to it (no merge, no identifier conflict possible since none matched). Threshold is a named constant `FUZZY_LINK_THRESHOLD = 0.90`; put the reasoning in a comment: below it, false positives across Saudi trading companies with near-identical names are common, so anything looser is step 6's problem as a search ranking, not a registry link.
4. Nothing → insert the company. `created = true`.
5. Attach identifiers: insert each; on conflict for a strong type pointing at a different live company this can only happen inside a race, so re-run step 2 once; on conflict for a weak type pointing elsewhere, leave the existing link alone and note it in `source.data.conflicts`.
6. Update `name`/`country` only if the company's are null or the source type is `lookup`. Insert the source row. Emit `company.created` or `company.updated` (payload: identifiers added, source type).
7. If `source.tenantId` is set, upsert a `tenant_company` row for that tenant (relationship/tags/notes from `input.tenantView` when given).

Other functions: `resolve(tx, id)` follows `merged_into`; `findByIdentifier(tx, type, value)`; `get(tx, id)` returns company + identifiers + (for the calling tenant) its `tenant_company` row and its own sources.

### `CompanyLookup` interface (`src/spine/registry/lookup/`)
```ts
interface CompanyLookup {
  readonly provider: string;
  byCr(cr: string): Promise<{ name: string; nameEn?: string; status?: string; city?: string; activities?: string[]; raw: unknown } | null>;
}
```
- `fake.ts`: an in-memory map the tests seed.
- `wathq.ts`: platform-level connector, configured by `WATHQ_API_KEY` (and `WATHQ_BASE_URL`). Read the current Commercial Registration API spec on developer.wathq.sa and implement `byCr` against it; if the spec is unreachable or the key is absent, the adapter returns `null` and logs once at startup that lookup is disabled. Do not invent field names: map only what the spec shows, keep the rest in `raw`.
- `upsert` accepts `enrich: true`; when set and a `cr` identifier is present and lookup is enabled, call `byCr` first and merge the returned name/city into the input with a second source row `source_type = 'lookup'`, `source_ref = 'wathq:<cr>'`.

### Messaging hook
In `send()`, after normalisation and before insert, look up the chosen address as a `phone` or `email` identifier and set `messages.company_id` when found. One indexed query; never blocks a send.

### Routes
- `POST /v1/companies` body `{ name, country?, identifiers: [{type, value}], source: { type: 'rfq'|'import'|'api', ref? }, enrich?, tenantView?: { relationship?, tags?, notes? } }` → 201 `{ company, created, mergedFrom }`. Idempotent by nature. This is also how an RFQ counterparty enters: the marketplace calls it with `source.type = 'rfq'` and the RFQ id as `ref`.
- `GET /v1/companies/:id` → company (resolved), identifiers, this tenant's view and sources. 404 if none.
- `GET /v1/companies?identifier=cr:1010xxxxxx` → the same, by identifier.
- `PUT /v1/companies/:id/view` body `{ relationship?, tags?, notes? }` → the tenant's view. Tenant-scoped.
- `POST /v1/companies/import` with `Content-Type: text/csv`, fixed header `name,country,cr,vat,domain,phone,email,relationship,tags` (tags `;`-separated), up to 5,000 rows, parsed with a small hand-written RFC 4180 reader (quotes, commas inside quotes, CRLF). Runs `upsert` per row with `source.type = 'import'`, `source.ref = '<filename or import id>:<row>'`. Returns `{ rows, created, linked, merged, rejected: [{ row, reason }] }`. Synchronous in v1; 5,000 rows is seconds.

### Tests, CI (`test/registry.test.ts`)
1. Same CR via `import`, `api` and `rfq` → one company, three source rows, `created` true then false, false.
2. Company X created with a CR; company Y created with a domain; an upsert carrying both → one survivor (the older), the other `merged_into`, identifiers and sources re-pointed, `GET` on the loser's id returns the survivor, `company.merged` emitted.
3. Fuzzy: `شركة الفلاح للتجارة` (SA) then `الفلاح للتجاره` (SA) with no strong identifiers → linked, one company. `شركة النور` then `شركة الفلاح` → two companies.
4. `normalizeName('Al-Falah Trading Co. Ltd')` equals `normalizeName('AL FALAH TRADING')`.
5. `info@gmail.com` yields an `email` identifier and no `domain`; `sales@alfalah.com.sa` yields both.
6. A weak identifier already linked to company A, sent with company B's CR → B keeps its CR, the phone stays with A, `source.data.conflicts` names it.
7. Tenant A's `tenant_company` and sources are invisible to tenant B; the company itself is visible to both.
8. `POST /v1/messages` to a phone that is an identifier → the message row has that `company_id`; to an unknown phone → null.
9. CSV import of 4 rows where two share a CR → `created: 3, linked: 1`; a row with an unparseable phone and no strong id → `rejected` with the row number; a quoted field containing a comma parses.
10. `enrich: true` with the fake lookup seeded for a CR → name filled from lookup, a `lookup` source row exists; with lookup disabled → no error, no lookup row.
11. Tenant B cannot `PUT /v1/companies/:id/view` on A's view (it creates its own).

### Done when
CI passes; README documents identifier rules, the merge behaviour and its reversibility, the CSV format, and how to enable Wathq.

## Do not
- Mirror marketplace members into the registry. No signup hook. The pool is off-platform companies only.
- Add any dependency. CSV parsing is hand-written; Wathq is `fetch`; matching is SQL.
- Add a `contacts` table or company profiles (sells/buys/sector). Step 6.
- Add PGroonga or any search endpoint. Step 6.
- Auto-merge on fuzzy match. Fuzzy links; only strong identifiers merge.
- Store Wathq responses beyond the mapped fields plus `raw` on the source row.

## Report back
PR titled `05 registry`. Description: CI output, whether Wathq was implemented against the live spec or left disabled and why, any decision the brief left open. Update the roadmap row in `docs/ARCHITECTURE.md`.
