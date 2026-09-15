# Validation status and reference comparisons

## What validation establishes

`npm run validate:data` validates one named rebuild variant (default `unit-root-fallback-losses`). It checks snapshot/schema provenance, source-schema validation, exact shard inventory, required application/unit identity and reporting-date fields, unique source-row keys, summary-cube arithmetic, agreement between detail and authority summaries, and agreement between authority totals and All London totals.

Passing these checks means the files are internally consistent enough to publish. It does **not** establish that the source data is complete or correct, that every relevant record has been included, or that the former GLA dashboard methodology has been reproduced.

## Historical reference figures

The following figures are the GLA's dated 10 December 2024 PLD extraction of net self-contained C3/C4 completions. They are an informational benchmark, not a release gate: live PLD may contain retrospective corrections and the reconstructed scope has not yet been demonstrated equivalent. See the GLA's [housing supply data sources](https://data.london.gov.uk/housing/housing-supply-data-sources) for the wider measure context.

| Financial year | Reference | Current snapshot | Difference |
|---|---:|---:|---:|
| 2019/20 | 37,843 | 40,385 | +2,542 (+6.7%) |
| 2020/21 | 30,703 | 34,229 | +3,526 (+11.5%) |
| 2021/22 | 37,524 | 39,251 | +1,727 (+4.6%) |
| 2022/23 | 32,053 | 33,803 | +1,750 (+5.5%) |
| 2023/24 | 31,629 | 32,941 | +1,312 (+4.1%) |

“Current snapshot” refers to the artifact generated on 15 September 2026. A later PLD rebuild may change these values because the source database can be corrected retrospectively.

The validator prints these comparisons for visibility but deliberately does not fail on them. The differences are material and known. Making them hard release gates would imply equivalence that has not been established and could also reject legitimate retrospective PLD corrections.

One confirmed methodological difference in the old importer is that it dated losses by completion; the rebuilt experimental variants can instead date losses by commencement. Remaining candidates—including retrospective PLD changes, C3/C4 scope, missing dates, supersession and deduplication—remain hypotheses until reconciled at application and borough level. `Units LP2021` is a separate, unreconstructed non-self-contained-accommodation measure and is not an explanation for a self-contained C3/C4 benchmark difference.

## Publication position

The dashboard is suitable as an experimental data-access and exploration tool, not as an authoritative statistical publication. Figures should be checked against the [GLA explanation of housing-supply measures](https://data.london.gov.uk/housing/housing-supply-data-sources), relevant London Plan Annual Monitoring Reports, and source PLD records before consequential use.

Future equivalence work should first identify a citable source and exact definition for every reference figure, then add borough- and tenure-level comparisons. A benchmark should become a release gate only after this project's measure is intended and demonstrated to be equivalent to that published measure.
