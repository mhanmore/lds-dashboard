# Implementation Plan — LDS Residential Completions Dashboard

Status: draft, based on `spec.md` + external research. Research note up front:
this session's network egress is blocked for `london.gov.uk` / `data.london.gov.uk`
/ `planninglondondatahub.london.gov.uk` (sandbox proxy policy), so the PLD API's
exact index schema, field names and auth flow could not be inspected directly here.
Confirmed via search instead:

- API is a **read-only, guest-access, limited subset of Elasticsearch 7.x**,
  returning JSON, exposing only the **latest snapshot** (no history — a record's
  past `decision` values etc. are not retrievable via the API itself).
- Official doc: the PDF at `www.london.gov.uk/sites/default/files/planninglondondatahub_api_connection_technical_documentation_v1.pdf`
  (title "Steps to connect to the Planning London Datahub API") — needs fetching
  from an environment with open egress, or pasted in by the user, before Phase 1
  can be finished. It should give base URL, index names, and an ES query example.
- A third party (`davidarkemp/london-planning-datahub` on GitHub) mirrors PLD
  records into git for history tracking — useful prior art, not a dependency.
- Production code (the Cloudflare Worker) will have normal outbound internet
  access at runtime; the blocker is only for *this planning session's* research.

**Action needed before Phase 1 can close:** either (a) the user pastes the
technical-documentation PDF contents / a sample ES query+response, or (b) we run
a short research pass from an unblocked environment (local machine, or a Worker
`fetch` smoke test deployed to Cloudflare) to nail down base URL, index names,
auth headers, and field names for the four indices named in the spec.

---

## 1. Repo layout

```
/worker/                Cloudflare Worker (cache refresh + serving)
  src/index.ts           fetch handler: freshness check, lock, refresh, fallback
  src/pld-client.ts       PLD Elasticsearch query wrapper
  src/transform.ts        raw records -> annual-summary / completion-sites
  src/validate.ts          regression checks vs published GLA totals
  src/types.ts
  wrangler.toml
  test/                  vitest unit tests (transform + validate, with fixture ES responses)

/site/                  static frontend (plain HTML/CSS/JS, no build step
                         unless research shows a framework is clearly worth it)
  index.html
  data.html               (Data view - separate lazy-loaded page/section)
  css/
  js/
    app.js                 boot: fetch metadata, decide loading-screen vs dashboard
    state.js                filter state + URL querystring sync
    charts/                 one module per chart (completions-vs-target, affordability, ...)
    data-table.js            searchable/exportable table for Data view
  assets/

/docs/
  methodology.md          Section 9 writeup, kept current as reverse-engineering proceeds
  validation-benchmarks.md  known published totals (Section 10) + sources
  api-notes.md             PLD API findings (indices, fields, quirks)

spec.md
PLAN.md
README.md
```

## 2. Data flow / cache design

- KV (or R2, decide in Phase 2) stores three JSON blobs behind fixed keys:
  `metadata.json`, `annual-summary.json`, `completion-sites.json`, matching
  spec §6. `metadata.generated_at` is the single source of truth for freshness.
- Worker `fetch` handler on every request:
  1. Read `metadata.json`. If absent or `now - generated_at >= 36h` → stale path.
  2. Stale path: acquire a lock (KV `put` with a short TTL "refreshing" key,
     conditional on absence — Cloudflare KV doesn't have native CAS, so use a
     short-TTL sentinel key + a second confirm read, accepting a small race
     window; or use Durable Objects for a proper single-flight lock if the
     project already needs a DO for something else). Losers of the race poll/
     wait briefly, or (simpler, matches spec's "no reload needed") return the
     *old* stale data immediately plus a `refreshing: true` flag, and the
     frontend re-polls a `/status` endpoint every few seconds until
     `generated_at` advances — this avoids holding an HTTP request open across
     a slow refresh and satisfies §4's "no manual reload" requirement without
     needing hard coalescing beyond "only the lock holder calls PLD".
  3. Winner performs refresh: query PLD, transform, validate against §10
     benchmarks (tolerance TBD, e.g. ±2%), and only on success overwrite the
     three keys atomically-enough (write summary+sites, then metadata last, so
     a crash mid-refresh can't leave `generated_at` pointing at incomplete data).
  4. On failure: leave old data in place, surface an `error`/`stale_reason` in
     the metadata response instead of throwing, so the frontend can show the
     "last updated N days ago, refresh failed" banner from spec §4.
- Fresh path: serve cached JSON straight from KV, no PLD call — this is the
  common case and should be near-static-file speed.
- `completion-sites.json` (record-level) is fetched by the browser lazily only
  when the Data view opens, per spec §6.

## 3. Frontend approach

- No SPA framework needed for v1 — plain JS modules + a lightweight chart lib
  (Chart.js via CDN, or D3 if we want more control over the completions/target
  combo chart) keep this dependency-light and easy to host as static files.
- `state.js` owns filter state (authority, year range, affordability, tenure,
  dwelling type, site size, Opportunity Area, address search) and mirrors it
  to `location.search` on every change (spec §8) — enables bookmarkable/
  shareable views without a router.
- Boot sequence (`app.js`): fetch `metadata.json`. If `generated_at` fresh →
  fetch `annual-summary.json` and render immediately. If stale/missing →
  show the "We're just updating..." screen (spec §4), call the worker to
  trigger/await refresh, poll, then render once ready.

## 4. Delegating implementation work

Given the plan/budget constraint, the bulk of this build is boilerplate-shaped
(static HTML/CSS scaffolding, chart wiring, table UI, filter widgets) and well
suited to smaller-model subagent workers once the harder pieces are pinned
down first by me:

**Kept for direct/careful work (not delegated):**
- PLD API research and query construction (`pld-client.ts`) — needs real
  judgement about what the index fields mean.
- `transform.ts` methodology logic (net vs gross, affordability
  classification, `Units LP2021`, financial-year allocation) — this is the
  crux of spec §9 and needs to stay coherent and be traceable to sources.
- `validate.ts` regression tests against spec §10 benchmarks.
- Cache/locking logic in the Worker `fetch` handler.

**Good candidates for delegated subagent tasks (parallelizable, checkable
independently against a small design spec I write first):**
- Static HTML page skeletons for the dashboard pages / Data view, once the
  layout and required chart slots are decided.
- CSS styling for filters, cards, the loading screen, responsive breakpoints.
- Individual chart-rendering modules (given a fixed data shape + Chart.js) —
  one subagent per chart.
- The Data-view table component (search/filter/sort/CSV export) given a fixed
  record schema.
- `docs/methodology.md` / `docs/validation-benchmarks.md` scaffolding once I
  supply the source facts.

I'll write a short data-shape contract (exact JSON shapes for
`annual-summary.json` / `completion-sites.json`) before delegating any UI
work, so subagents build against a stable interface rather than guessing.

## 5. Phased execution (maps to spec §13)

1. **Phase 1 — reverse engineering** (blocked on API doc access, see above).
   Deliverable: `docs/api-notes.md`, `docs/methodology.md` draft,
   `docs/validation-benchmarks.md` seeded with the §10 figures.
2. **Phase 2 — refresh/cache pipeline**: Worker + KV, `pld-client.ts`,
   `transform.ts`, `validate.ts`, freshness/lock/fallback logic, unit tests
   against recorded fixture ES responses (captured once Phase 1 confirms
   query shape).
3. **Phase 3 — dashboard**: static site, filters, charts, Data view, loading
   screen — largest delegation surface.
4. **Phase 4 — equivalence/docs**: compare against the Avison Young PDF
   captures (spec §12) and published figures, document deviations, polish
   responsive/export/share features.

## 6. Open decisions to confirm before coding starts

- KV vs Durable Object vs R2 for cache storage + locking.
- Chart library choice (Chart.js vs D3 vs uPlot).
- Tolerance threshold for §10 validation before treating a refresh as
  suspect.
- Whether the "eight pages" get one multi-page static site or a single
  scrolling dashboard with tabs — spec says functional recreation over
  pixel-for-pixel, leaning toward tabs/sections in one app shell.
