# London Residential Completions Dashboard

## 1. Purpose

Recreate the functionality of the former Greater London Authority **Residential Completions Dashboard** as a lightweight, open web application.

The former dashboard was a Power BI report published through the London Datastore using data from the **Planning London Datahub (PLD)**. The London Datastore record remains available, but the original interactive dashboard has been removed or is no longer practically accessible.

The replacement should:

- reproduce the useful analytical functionality of the former dashboard;
- obtain its underlying data from the public Planning London Datahub API;
- require no conventional application server or database;
- perform filtering, aggregation and visualisation in browser-side JavaScript;
- use a minimal serverless worker solely to refresh the static data cache when it becomes stale;
- be suitable for deployment through Cloudflare Pages or equivalent static hosting;
- preserve enough information about data extraction and methodology that results can be reproduced and audited.

This is initially a **functional recreation**, not a pixel-for-pixel clone of the former Power BI interface.

## 2. Source system

The authoritative source is the GLA **Planning London Datahub**.

The PLD is London's consolidated planning database and includes planning applications, permissions, commencements and completions across London planning authorities.

The GLA provides read-only programmatic access through an Elasticsearch API. Relevant API indices include:

- `applications`
- `residential_units`
- `other_resi_accommodation_unit_details`
- `non-permanent_dwellings_details`

The precise queries, transformations and field mappings necessary to reproduce the former dashboard will need to be established during implementation.

Particular care is required because the published dashboard represents an analytical treatment of PLD records rather than necessarily a simple count of records returned by the API.

## 3. Architecture

The dashboard should remain essentially a **static web application**.

There should be no conventional runtime application server or database. HTML, CSS, JavaScript and the processed dashboard dataset should be served as static assets.

A small serverless worker should provide **cache refresh on demand**.

```text
                         ┌──────────────────────┐
                         │ Planning London      │
                         │ Datahub API          │
                         └──────────┬───────────┘
                                    │
                              stale cache only
                                    │
                                    ▼
Browser ──page load──► Cloudflare Worker
                         │
                         ├── cache < 36h old
                         │       │
                         │       └── use existing data
                         │
                         └── cache ≥ 36h old / absent
                                 │
                                 ├── retrieve PLD data
                                 ├── transform / aggregate
                                 ├── validate
                                 └── replace cached dataset
                                           │
                                           ▼
                                   Static dashboard
                                           │
                                           ▼
                                Browser-side JavaScript
```

The serverless component therefore exists to solve two problems only:

1. avoid browser CORS restrictions when accessing the PLD API; and
2. maintain a reasonably current cached dataset.

It should not become an application backend.

## 4. On-demand refresh and 36-hour cache

Data should be refreshed **on demand**, rather than by an hourly, daily or weekly scheduled process.

On initial page load the application should determine the age of the most recently successfully generated dataset.

### Fresh cache

If:

```text
current time - data.generated_at < 36 hours
```

the existing dataset should be returned immediately and the dashboard should load normally.

No request to the GLA API should be made.

### Stale or absent cache

If the dataset is more than **36 hours old**, or no usable cached dataset exists, the worker should initiate an update from the Planning London Datahub API.

During this process the browser should display a simple loading screen:

> **We're just updating the London Data Store information…**

The dashboard should appear automatically when the refreshed data is available.

The interface may display a small secondary message if useful, for example:

> This can take a moment. The information hasn't been refreshed in the last 36 hours.

The user should not need to reload the page manually.

### Successful refresh

Following a successful refresh:

- validate the retrieved data;
- write/replace the cached processed dataset;
- record its generation timestamp;
- return the new data to the requesting browser;
- initialise the dashboard.

The timestamp must represent the **last successful data refresh**, not merely the last request to the worker.

### Failed refresh

Failure of the GLA API should not make an otherwise usable dashboard unavailable.

If refresh fails and an older cached dataset exists, the application should fall back to that dataset and clearly indicate its age, for example:

> **Using data last updated 4 days ago — the London Data Store could not currently be refreshed.**

The previous good dataset must not be overwritten by a failed, incomplete or obviously invalid refresh.

Only if there is no usable cached dataset should an API failure prevent the dashboard from loading.

## 5. Concurrency

The implementation should prevent several simultaneous visitors from triggering several expensive PLD refreshes when the 36-hour threshold is crossed.

Conceptually:

```text
request A ─┐
request B ─┼──► cache stale ──► ONE refresh ──► new cached dataset
request C ─┘                         │
                                    └── all requests use result
```

The precise locking/coalescing mechanism can be selected during implementation.

This matters particularly because the first visit after a long period of inactivity is the expected refresh mechanism.

## 6. Processed data and cache design

Do not simply proxy the complete PLD dataset to every browser.

The worker/update process should transform source records into assets appropriate to dashboard analysis. A possible logical structure is:

```text
metadata
annual-summary
completion-sites
```

Metadata should include at least:

```json
{
  "generated_at": "2026-09-15T12:00:00Z",
  "source": "Planning London Datahub",
  "schema_version": 1,
  "methodology_version": 1
}
```

The summary dataset should contain the relatively compact multidimensional information necessary for the principal charts.

A larger site/application dataset may support the detailed Data view and can be fetched by the browser only when that view is opened.

Once data has been delivered, ordinary dashboard interaction should be entirely client-side. Changing authority, year, affordability, dwelling type or other filters must **not** result in further GLA API requests.

## 7. Former dashboard functionality

The original Power BI report contained **eight pages**.

The initial objective should be to identify and reproduce the analytically useful functions of those pages rather than their precise layout.

Surviving material confirms functionality including:

### Completions against target

Annual residential completions by planning authority, compared with the applicable housing target.

Outputs included:

- completions by financial year;
- target by financial year;
- completions as percentage of target;
- annual chart;
- underlying annual values.

### Self-contained housing and affordability

Annual net self-contained housing completions, including breakdowns by affordability.

Known categories include:

- Affordable;
- Market;
- Not known / not applicable;
- replacement units where relevant.

Filters included planning authority and dwelling type.

Known dwelling-type categories included houses/bungalows, flats/apartments/maisonettes, studios/bedsits, cluster flats, C4 small HMOs and live/work units.

### Detailed Data view

The former report contained a record-level/table-oriented Data page.

Known filters included:

- planning authority;
- completion year;
- site size / large or small site;
- address;
- Opportunity Area.

The underlying data included both raw unit numbers and the GLA's adjusted `Units LP2021` measure.

The replacement should make this detailed data particularly easy to search, filter and export.

## 8. Filters and interaction

Subject to verification against the source data and archived dashboard, the client-side application should ultimately support filters for:

- planning authority;
- financial year or range of years;
- affordability;
- tenure where available;
- dwelling type;
- site size;
- Opportunity Area;
- address/site.

Selections should update relevant charts, totals and tables without server requests.

A URL/query-string representation of dashboard state would be desirable so that a filtered view can be bookmarked or shared.

## 9. Methodology

A critical implementation task is to reconstruct the GLA methodology used by the former Power BI report.

This includes identifying:

- what constitutes a residential completion;
- gross versus net units;
- treatment of losses;
- self-contained versus non-self-contained accommodation;
- treatment of replacement dwellings;
- affordability classification;
- site-size classification;
- financial-year allocation;
- London Plan target periods;
- derivation of `Units LP2021`;
- treatment of incomplete, duplicate or subsequently corrected PLD records.

The replacement should not silently invent a new methodology merely because it produces plausible-looking totals.

Where possible, calculated historic totals should be reconciled against published GLA figures.

Any differences that cannot be eliminated should be documented.

## 10. Validation

Automated validation should compare generated results against known published totals.

For example, the GLA has published London-wide net self-contained housing completions including:

```text
2019/20   37,843
2020/21   30,703
2021/22   37,524
2022/23   32,053
2023/24   31,629
```

These provide useful regression tests for the extraction/transformation code.

Additional borough-level and affordability benchmarks should be collected from surviving dashboard captures and GLA publications.

A refresh which unexpectedly produces materially inconsistent historic totals should be treated as a potential validation failure rather than silently replacing the last known-good dataset.

## 11. UI approach

The replacement should retain the analytical concepts of the Power BI dashboard but need not reproduce Power BI's visual design.

Priorities are:

1. fast loading;
2. obvious filters;
3. legible charts;
4. easy inspection of actual numbers;
5. responsive desktop/mobile behaviour;
6. shareable filtered views;
7. accessible HTML;
8. downloadable underlying data.

Normal visits with a cache less than 36 hours old should feel indistinguishable from visiting an ordinary static website.

The update screen should occur only on the first visit after the cached dataset becomes stale.

## 12. Provenance and references

### Current London Datastore record

https://data.london.gov.uk/dataset/residential-completions-dashboard-e196j

### Planning London Datahub

https://www.london.gov.uk/programmes-strategies/planning/digital-planning/planning-london-datahub

### API documentation

https://www.london.gov.uk/sites/default/files/planninglondondatahub_api_connection_technical_documentation_v1.pdf

### Surviving copy of former dashboard — Avison Young evidence

A particularly useful contemporary record of the former dashboard survives in **Appendix C of the Appellant's Appendices to the Planning Proof of Evidence of Nicholas Alston**, prepared by Avison Young.

The document contains captures of multiple pages of the GLA Residential Completions Dashboard dated **29 September 2025**:

https://gat04-live-1517c8a4486c41609369c68f30c8-aa81074.divio-media.org/filer_public/54/19/5419aa41-68a9-4a3d-8a44-bce481591317/cd0807_appellant_appendices_to_planning_proof_of_evidence_of_nicholas_alston_-_part_1.pdf

This is a publicly hosted planning-inquiry document. The project should link to it rather than duplicate the complete PDF unless preservation of a local evidential copy subsequently becomes desirable.

## 13. Initial implementation phases

**Phase 1 — reverse engineering**

Identify the former dashboard pages, measures, filters and methodology from surviving captures, GLA documentation, FOI responses and published figures.

Explore the PLD API and establish queries capable of reproducing known completion totals.

**Phase 2 — refresh/cache pipeline**

Implement the PLD retrieval and transformation process.

Implement:

- last-successful-refresh timestamp;
- 36-hour freshness test;
- on-demand refresh;
- concurrent-request protection;
- last-known-good fallback;
- validation before cache replacement.

**Phase 3 — dashboard**

Implement the principal completion, target and affordability views with browser-side filtering.

Implement the detailed searchable Data view.

Implement the stale-data update screen and graceful failure behaviour.

**Phase 4 — equivalence and documentation**

Compare results systematically against surviving examples of the former dashboard.

Document known methodological differences, limitations and source-data quality issues.

Add download/share functionality and refine responsive presentation.

## 14. Definition of success

The project succeeds if a user can open the dashboard and:

- normally receive a static cached dataset immediately;
- automatically trigger a refresh when that dataset is more than 36 hours old;
- see a simple explanatory wait screen while that exceptional refresh occurs;
- fall back safely to the last known-good data if the source is temporarily unavailable;
- subsequently perform all normal dashboard analysis locally in the browser.

The result should provide substantially the same housing-completion analysis previously available from the GLA Power BI dashboard, with transparent provenance and without requiring Power BI, a conventional runtime backend or database.