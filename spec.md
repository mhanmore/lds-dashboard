# London residential completions explorer

## 1. Project status

This repository contains an independent, experimental reconstruction of part of the withdrawn Greater London Authority Residential Completions Dashboard. It was prompted by the intention of making the underlying public data easier to access and explore. It is not affiliated with, commissioned, endorsed or maintained by the GLA and is not a definitive reproduction of the former dashboard.

Source data is supplied by the Greater London Authority through the Planning London Datahub, and the GLA cannot warrant its quality or accuracy. The site and transformed data are also published without warranty or representation of accuracy, completeness or fitness for a particular purpose. They must not be presented as official statistics or relied upon for statutory monitoring, planning decisions, financial decisions or other consequential uses.

## 2. Purpose and scope

The project aims to:

- restore useful exploratory access to residential-completion records after withdrawal of the former dashboard;
- make the source, transformations and limitations inspectable;
- provide fast browser-side filtering and visualisation without Power BI;
- operate as a static GitHub Pages site without a public API or database; and
- refresh its checked-in snapshot periodically through an isolated offline process.

It does not currently aim to reproduce every former dashboard page or establish equivalence with the GLA's complete housing-supply methodology.

## 3. Source

The source is the public, read-only Planning London Datahub Elasticsearch API. The current importer reads residential units nested in PLD application documents. Relevant PLD collections also include other residential accommodation and non-permanent dwellings, but those are not yet imported.

PLD is a changing operational database populated from planning-authority data and subject to reporting and processing lags. Historic snapshot totals may therefore change after the period concerned.

## 4. Implemented architecture

```text
External weekly VPS job ──► Planning London Datahub API
          │
          ├── build a temporary complete snapshot
          ├── transform and split it by financial year
          ├── validate internal consistency
          └── replace site/data, commit and push only on success
                                      │
                                      ▼
                         GitHub Pages deployment
                                      │
                                      ▼
                              Static dashboard
```

The repository contains:

- `site/data/index.json`: metadata, shard inventory and `annual_summary` rows;
- `site/data/years/*.json`: address-grouped detail rows by financial year;
- `scripts/build-data.mjs`: PLD retrieval and transformation;
- `scripts/validate-data.mjs`: artifact consistency checks;
- `scripts/merge-data.mjs`: a maintenance utility for combining separately built ranges; and
- `.github/workflows/pages.yml`: static GitHub Pages deployment.

There is no visitor-facing refresh button, runtime service, database or KV store. Dashboard interactions never query PLD.

The intended weekly cron job, VPS path and repository write credential are deliberately external to this repository. Their configuration is described in the README but cannot be verified from this codebase.

## 5. Implemented data model

The current artifact uses schema version 4 and methodology version 1.

`metadata` records the generation time, source, schema and methodology versions, number of retrieved unit entries and number of address-grouped detail rows. `years` lists every detail shard. `annual_summary` contains authority-year net completions, an optional London-wide target, one-dimensional category totals and an affordability × dwelling-type × inferred-use-class cube — accumulated from every included raw unit fact, independently of detail-row grouping below.

Detail rows are grouped by address text, planning authority, financial year, affordability, dwelling type and inferred use class (see "Aggregation and dashboard behaviour" in [methodology and limitations](docs/methodology.md)); groups whose net units sum to zero are omitted. Each surviving row contains:

- address text assembled from available site fields;
- planning authority;
- financial year;
- `units`: the group's net signed unit count (this is the field the dashboard's detail table and CSV export display as "Net units");
- a schema-compatibility `units_lp2021` field, explicitly `null` until an independent GLA LP2021 adjustment is reconstructed (see docs/methodology.md) — it is not a net-units fallback and must not be read by dashboard code expecting a populated value;
- inferred affordability grouping;
- lightly normalised unit type; and
- use class inferred from unit type.

Detail rows carry no application identifier, exact reporting date or `borough` field — none of these are part of the grouping key, and `borough` is known to diverge from planning authority in roughly a fifth of raw unit facts, so it cannot be attached to a grouped row without ambiguity. These are address-grouped analytical rows, not authoritative site or application records. See [methodology and limitations](docs/methodology.md).

## 6. Implemented dashboard

The static browser application provides:

- authority, start-year, end-year, affordability, unit-type and inferred-use-class filters;
- filter state in the URL query string;
- annual net-completion metrics and stacked charts;
- affordability, unit-type and inferred-use-class composition views;
- an indicative All London target comparison for an otherwise unfiltered view;
- top-ten authorities for All London;
- a selected borough plus ten nearby totals for borough comparisons, with the focus borough visually distinguished;
- an annual values table;
- lazy loading of selected financial-year detail shards;
- address/authority search over loaded detail rows; and
- CSV export of all filtered detail rows.

The detail table displays at most 500 rows on screen but includes all matching rows in the CSV. A snapshot older than ten days produces a maintenance warning without blocking access.

Not implemented are tenure as a separate filter, site size, Opportunity Area, application identifiers, authoritative planning use class, borough-specific targets, or non-conventional accommodation.

## 7. Current calculation

A nested residential unit with an `actual_completion_date` in the requested financial year is included. A `Loss` contributes −1 and every other included unit contributes +1. Affordability, unit type and inferred use class are then classified as described in the methodology document.

The calculation does not reproduce the former `Units LP2021` adjustment. The dashboard therefore describes the result as a reconstructed net count of self-contained PLD residential-unit entries, not the full London Plan supply measure.

Annual target references are hard-coded as 42,388 before 2021/22 and 52,287 from 2021/22. They provide London-wide context only. Because the completion numerator excludes non-conventional supply, percentage-of-target results are indicative and not a statutory assessment.

## 8. Retrieval and publication safeguards

The builder:

1. requests every application hit in one Elasticsearch scroll covering the full requested history;
2. de-duplicates application hits by canonical application identifier (PLD/source `id`, falling back to Elasticsearch `_id` only when necessary), hard-failing on a genuine duplicate;
3. checks the total hits retrieved against the API's reported total once the scroll is exhausted;
4. streams every stage to disk rather than holding the fetched or normalised dataset in memory — each named methodology variant re-reads the normalised fact set from disk independently, so peak memory stays bounded by a handful of small aggregate maps regardless of dataset size, not by the full ~2.7 million unit-fact count; and
5. writes a compact index and one address-grouped detail shard per financial year, per variant.

The validator rejects unexpected schema versions, invalid or discontinuous year indexes, shard-inventory mismatches, shards above 25 MiB, missing fields, duplicate address groups, inconsistent cubes, disagreements between detail and authority totals, and disagreements between authority totals and All London.

Several historic London-wide figures are printed as informational comparisons. They are not release gates because their precise provenance and methodological equivalence have not yet been established. Passing validation demonstrates internal consistency, not correctness of PLD or equivalence with an official publication.

The recommended VPS process builds into a temporary directory and validates it before replacing `site/data`. A failed job does not push, so the previously deployed snapshot remains available.

## 9. Known limitations and remaining work

The principal unresolved work is methodological rather than presentational:

- establish citable definitions and sources for historical comparison figures;
- reconstruct or remove the `Units LP2021` compatibility field;
- identify the former dashboard's rules for incomplete, corrected and duplicate records;
- add non-conventional residential accommodation where a defensible conversion method is available;
- reconcile London, borough and tenure totals against official publications;
- verify the target periods and values from primary material;
- determine whether site-size and Opportunity Area fields can be added reliably;
- add automated tests for transformation functions after they are separated into importable modules; and
- re-scrape and validate borough/year outliers identified by cross-checking against London Plan AMR Table 3.9 (2016/17 gross completions by borough, via the LDD extract reproduced in [jgleeson/housing_analysis](https://github.com/jgleeson/housing_analysis/blob/master/AMR_tables.md)) and by an internal per-authority outlier sweep of `site/data/index.json`. Raw-record traces (`build/audit/{bd,kc,outlier-sweep}/FINDINGS.md`, not committed) found:
  - **Confirmed date-quality defect, not necessarily a completions-validity defect — Barking & Dagenham 2016/17** (reconstructed net 10,572 vs AMR reference 601, 17.6x): a single application (`04/01230/OUT`, Barking Riverside) contributes 10,800 of 11,091 unit records in the window, every one dated 2017-03-30 (the last day of the financial year) with no per-unit completion date or `unit_no`. The same signature (large block of unit records, one uniform date at or within two days of financial year-end, `unit_no` null throughout) recurred in five further applications traced the same way: K&C 2014/15 (`PP_10_01539`, `PP_09_02786`) and 2019/20 (`PP_14_01242`, identified as **Wornington Green Estate Phase II**, a real, known regeneration scheme), and LLDC's 2023/24→2024/25 360x swing (`LLDC-18_00470_OUT`, identified as **Stratford Waterfront**, also a real scheme). Do not read this as fabricated or duplicated units: the most plausible explanation is a monitoring officer clearing a backlog of real-but-imprecisely-dated completions onto one administrative closing date, not invented delivery — bolting undated units onto a single year-end date is the ordinary path of least resistance for a records backlog, not a fabrication pattern. A control check (LLDC 2023/24's ordinary 3-completion year) showed normal scattered dates with no red flags, confirming the detection signature doesn't just fire on every year.
    - **Policy: flag, don't exclude.** Removing these units to fix an over-count risk creates the opposite bias (undercounting real delivery) to solve a problem that is about *when* the units complete, not *whether* they exist. Add a detection rule in `scripts/rebuild-lib.mjs` (new normalisation-exception/flag category, e.g. `bulk_administrative_date`, for applications above a record-count threshold where 100% of units share one date and `unit_no` is null/empty) that (a) keeps the units in headline totals, (b) excludes them specifically from the per-authority statistical baselines used for outlier detection, so one bulk entry doesn't distort what "normal" looks like for that authority, and (c) surfaces a caveat at the affected authority/year level (validator output and ideally the dashboard's year detail) that single-year timing for that authority/year should not be relied on.
  - **Still unresolved and separate from the above — K&C 2016/17** (net 155 vs AMR gross 395, ratio 0.39): this year was not flagged by any internal outlier check, and the gap runs opposite to this project's general overcounting bias (here the reconstruction is *lower* than the reference). No candidate cause identified yet.
  - **Lower-priority backlog from the sweep** (`build/audit/outlier-sweep/FINDINGS.md`): 8 per-authority z-score outliers and 58 year-over-year ratio outliers were found dataset-wide; most large ratio swings are plausible for small authorities (a single large scheme can genuinely move a small borough 10–40x year-on-year) and are not presumed bugs without a raw trace. Ten further negative-loss years were also found (largest: Ealing 2013/14, −1,293) — plausible as genuine net loss (demolition/regeneration) but not yet checked against the commencement-vs-completion effect confirmed above.
  - Once the confirmed and candidate bugs are fixed, extend the AMR cross-check (Test 2 above) to additional AMR years beyond 2016/17 to see whether the bias is stable or itself varies by year.

The surviving printed copy of the old dashboard is evidence of layout, filters and displayed categories, but it is a messy printout with expanded controls and should not be treated as a definitive interface specification.

## 10. References

- [GLA housing-supply data sources](https://data.london.gov.uk/housing/housing-supply-data-sources)
- [Planning London Datahub](https://www.london.gov.uk/programmes-strategies/planning/digital-planning/planning-london-datahub)
- [PLD API technical documentation](https://www.london.gov.uk/sites/default/files/planninglondondatahub_api_connection_technical_documentation_v1.pdf)
- [London Datastore record for the withdrawn dashboard](https://data.london.gov.uk/dataset/residential-completions-dashboard-e196j)
- [London Datastore terms and conditions](https://data.london.gov.uk/about/terms-and-conditions/)
- [Avison Young appendix containing a surviving printed dashboard record](https://gat04-live-1517c8a4486c41609369c68f30c8-aa81074.divio-media.org/filer_public/54/19/5419aa41-68a9-4a3d-8a44-bce481591317/cd0807_appellant_appendices_to_planning_proof_of_evidence_of_nicholas_alston_-_part_1.pdf)

## 11. Publication criteria

A snapshot is technically ready for publication when:

- the complete requested PLD retrieval finishes;
- `npm test` succeeds;
- the static page, index and representative year shards are served successfully;
- no public runtime-refresh dependency remains; and
- the public interface and documentation retain the experimental-status, methodology and no-warranty caveats.

Technical readiness is not a claim that the figures are accurate or statistically equivalent to the former GLA dashboard.
