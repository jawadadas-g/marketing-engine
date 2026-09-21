# Brief 10 — Operator dashboard

Read `CLAUDE.md`, `docs/ARCHITECTURE.md` and `docs/DASHBOARD.md` first. This brief builds the screen brief 09's API was designed for. It lives in `dashboard/` as a separate static app with its own container. The engine service is not modified except where Part A says.

## Part A — housekeeping (first commit)

- `docs/ARCHITECTURE.md`: amend "It owns no screens" to: "The engine service serves only JSON. An operator dashboard lives in `dashboard/` as a separate static app that talks only to the `/internal/` API and deploys as its own container; deleting it changes nothing in the engine." Same sentence in `CLAUDE.md` under What this is.
- `CLAUDE.md`: add a Dashboard section to the layout and a rule: "The dashboard renders; the engine decides. No business logic, no derived counts, no status inference in the UI. If a number isn't in an API response, add it to the API in a separate brief, not in the browser."

## Part B — the step

### Shape
- `dashboard/`: its own `package.json`, Vite + Preact + TypeScript strict. No UI kit, no chart library, no state library, no router library (a 30-line hash router is fine). Hand-written CSS in one file with custom properties; charts are hand-built SVG. Dependencies allowed: `preact`, `vite`, `@preact/preset-vite`, `typescript`, `vitest`, `preact-render-to-string` (tests). Nothing else without asking.
- Served by `nginx:alpine` from `dashboard/Dockerfile` (multi-stage: build, then copy `dist/` into nginx). nginx config:
  - `auth_basic` on everything, users from an `htpasswd` file mounted at runtime (`dashboard/htpasswd.example` with instructions; never a real one in the repo).
  - `location /api/` → `proxy_pass` to the engine's `/internal/`, adding `X-Internal-Token` from an nginx variable filled by `envsubst` at container start from `INTERNAL_TOKEN`. Strip the `Authorization` header before proxying so basic-auth credentials never reach the engine.
  - `location /api/stream` additionally `proxy_buffering off`, `proxy_read_timeout 1h`, `chunked_transfer_encoding on` for SSE.
  - Security headers: `Content-Security-Policy: default-src 'self'`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`.
- `docker-compose.prod.yml` gains a `dashboard` service on port 8443 behind whatever TLS you terminate with (document Caddy as the one-liner option; do not add it to the compose). Dev: `vite` proxies `/api/` to `localhost:3000/internal/` with the token from `.env.local`.

### Views (hash routes)
Each view calls only the endpoints `docs/DASHBOARD.md` lists for it. Every view has: a loading state, an error state that shows the API's error body, an empty state, and a "last refreshed" stamp. Times render in the operator's local zone with the ISO value on hover. Money renders from minor units using the row's currency. Never compute a count client-side that the API could return; if you need one, note it in the PR as an API gap.

1. **`#/overview`**: the sections of `/api/overview` as cards: queue table (name × waiting/active/retry/failed, failed cell links to `#/queue?name=&state=failed`), message status bar, blocked-reasons list, tenants table sorted by 24h sends (row → `#/tenants/:id`), webhooks pending/failed, reservations open/expiring, discovery searches/invites. Window selector 24h / 7d / 30d. Polls every 10s; pauses when the tab is hidden.
2. **`#/live`**: the SSE feed from `/api/stream`. Newest at top, capped at 500 rows in memory, filter chips for tenant and event type prefix (sent as query params, so the server filters), a pause button that buffers and shows a count. Each row expands to `/api/events/:id` on click. Shows connection state and reconnects with `Last-Event-ID`.
3. **`#/queue`**: `/api/jobs` with filters name/state, cursor "load more". Row expands to the job with `output` in a `<pre>`; failed jobs have a Retry button (POST, then refetch that row). Below the table, `/api/schedules` as a small list with cron, last run, last outcome.
4. **`#/tenants`** and **`#/tenants/:id`**: the list with 24h counts; the detail with configured channels (redacted, as returned), templates, rule counts, endpoints, three count windows, and tabs for that tenant's messages, redemptions, invites, deliveries (each a filtered call to the corresponding feed).
5. **`#/messages`** and **`#/messages/:id`**: the cross-tenant feed with filters (tenant, status, channel, provider, address, since/until); the detail shows the message, its timeline as a vertical list, raw delivery reports in `<pre>`, and fallback parent/children links.
6. **`#/deliveries`**: `/api/webhook-deliveries` with status filter; Replay button on failed rows.
7. **`#/metrics`**: `/api/metrics` as hand-drawn SVG line/bar charts: messages by status per hour (7d), events by type per day (30d), redemptions by status. Series/bucket/window controls map 1:1 to the API params. Tooltip on hover with the exact count. No animation.
8. **`#/companies`**: pool browse over `/api/companies` with `q` and country filter; on-platform badge from the API field.

A left nav with these eight, the engine `version` from `/api/overview` in the footer, and a global banner if any request returns 401 (basic auth expired) or the stream has been disconnected for more than 30s.

### Code rules
- One folder per view under `dashboard/src/views/`, shared pieces under `src/ui/` (table, card, filter bar, pager, timestamp, money, svg chart primitives), one `src/api.ts` with typed fetch wrappers whose types mirror the API responses (copy the shapes from `docs/API.md`; do not import from the engine's source).
- No `any`. No client-side joins across endpoints. No caching beyond the current view.
- CSS: dark by default, light via `prefers-color-scheme`, all colours as custom properties, one font stack. Keep the look plain and dense; it's an operations screen.

### Tests
- `vitest` with `preact-render-to-string`: each view renders from a fixture JSON (copied from the operator API tests' expected responses) without throwing, and shows the empty/error state when handed `[]` or an error. Formatting helpers (money from minor units, relative time, cron to text) have unit tests.
- `npm run typecheck` and `npm run build` in `dashboard/` run in CI.
- No browser automation framework.

### Done when
CI builds the dashboard; the image builds; against a locally running engine with the e2e seed, every view shows real data and the live feed updates when `npm run e2e` runs; retry and replay work from the screen; a screenshot of the overview and the live feed is in the PR; the README has a Dashboard section (run locally, create the htpasswd, deploy).

## Do not
- Add any dependency to the engine. The dashboard's allowed list is above and is final.
- Serve the dashboard from the engine process or add any HTML route to it.
- Put the internal token in the browser, in the built bundle, or in the repo.
- Compute, infer or derive anything the API doesn't return.
- Add write actions beyond Retry and Replay.
- Add a chart library, a component library, or a CSS framework.

## Report back
PR titled `10 operator dashboard`. Description: the screenshots, the bundle size, any API gap you hit (counts you wanted and had to omit), and anything the brief left open. Add row 10 to the roadmap in `docs/ARCHITECTURE.md`.
