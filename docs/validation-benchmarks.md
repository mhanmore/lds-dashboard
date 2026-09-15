# Validation status and reference comparisons

## What validation establishes

`npm run validate:data` checks the internal structure of the generated static artifact. It verifies the schema and methodology versions, continuous financial-year index, exact shard inventory, shard size, required fields, unique address-group keys, summary-cube arithmetic, agreement between detail and authority summaries, and agreement between authority totals and All London totals.

Passing these checks means the files are internally consistent enough to publish. It does **not** establish that the source data is complete or correct, that every relevant record has been included, or that the former GLA dashboard methodology has been reproduced.

## Historical reference figures

The following figures were recorded during the reconstruction as London-wide net self-contained completion totals from surviving material. They should be treated as provisional reference values: their precise original table and measure definition have not yet been independently documented in this repository.

| Financial year | Reference | Current snapshot | Difference |
|---|---:|---:|---:|
| 2019/20 | 37,843 | 40,385 | +2,542 (+6.7%) |
| 2020/21 | 30,703 | 34,229 | +3,526 (+11.5%) |
| 2021/22 | 37,524 | 39,251 | +1,727 (+4.6%) |
| 2022/23 | 32,053 | 33,803 | +1,750 (+5.5%) |
| 2023/24 | 31,629 | 32,941 | +1,312 (+4.1%) |

“Current snapshot” refers to the artifact generated on 15 September 2026. A later PLD rebuild may change these values because the source database can be corrected retrospectively.

The validator prints these comparisons for visibility but deliberately does not fail on them. The differences are material and known. Making them hard release gates would imply equivalence that has not been established and could also reject legitimate retrospective PLD corrections.

Likely contributors include the unreconstructed `Units LP2021` rules, changes to PLD records since the historic publication, and differences in inclusion or deduplication logic. Those explanations are hypotheses, not findings.

## Publication position

The dashboard is suitable as an experimental data-access and exploration tool, not as an authoritative statistical publication. Figures should be checked against the [GLA explanation of housing-supply measures](https://data.london.gov.uk/housing/housing-supply-data-sources), relevant London Plan Annual Monitoring Reports, and source PLD records before consequential use.

Future equivalence work should first identify a citable source and exact definition for every reference figure, then add borough- and tenure-level comparisons. A benchmark should become a release gate only after this project's measure is intended and demonstrated to be equivalent to that published measure.
