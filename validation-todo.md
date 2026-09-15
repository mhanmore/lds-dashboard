# Validation research and next steps

This note records the external validation work identified for the reconstructed London residential completions explorer. Its purpose is to distinguish internal consistency from equivalence with the withdrawn Greater London Authority Residential Completions Dashboard, and to provide a concrete route towards testing that equivalence.

## Current position

The current importer is internally consistent, but it does **not** yet reproduce the former GLA dashboard methodology. In particular, the generated `units_lp2021` field is currently identical to `units`, non-conventional accommodation is excluded, and several dashboard classifications and adjustments remain reconstructed or inferred rather than authoritative.

The most important newly identified methodological difference is the treatment of losses. The current importer assigns both gains and losses to the financial year containing the residential unit's `actual_completion_date`. Surviving GLA material describing the Residential Completions Dashboard states that **unit losses are recorded in the financial year in which the scheme commenced**. This should be tested before treating the remaining historical discrepancy as unexplained PLD revision or an LP2021 adjustment.

## Key research findings

### 1. Losses were allocated to commencement year

GLA material accompanying the Annual Monitoring Report tables states that the Residential Completions Dashboard methodology allocates losses to the year in which work commenced. The present importer instead filters and dates every unit, including a `change_type === 'Loss'` unit, using `actual_completion_date`.

This is a confirmed methodological mismatch and is the first candidate for explaining why the reconstructed annual net totals are consistently above the surviving GLA figures.

Source: GLA London Plan AMR tables / monitoring material:
https://www.london.gov.uk/programmes-strategies/planning/implementing-london-plan/monitoring-london-plan/london-plan-amr-tables

### 2. The five existing historical benchmarks now have identifiable provenance

The figures already stored in `scripts/validate-data.mjs` and `docs/validation-benchmarks.md` correspond to a GLA answer reporting **net self-contained housing completions (C3/C4)** extracted from the Planning London Datahub on **10 December 2024**.

| Financial year | GLA 10 Dec 2024 extraction | 15 Sep 2026 reconstruction | Difference |
| --- | ---: | ---: | ---: |
| 2019/20 | 37,843 | 40,385 | +2,542 (+6.7%) |
| 2020/21 | 30,703 | 34,229 | +3,526 (+11.5%) |
| 2021/22 | 37,524 | 39,251 | +1,727 (+4.6%) |
| 2022/23 | 32,053 | 33,803 | +1,750 (+5.5%) |
| 2023/24 | 31,629 | 32,941 | +1,312 (+4.1%) |

These should no longer be described as reference values of undocumented provenance. They are useful benchmarks because they are specifically identified as self-contained C3/C4 completions rather than the broader London Plan housing-supply measure.

Source: GLA / Mayor's Question Time, “Net Housing Completions in London”:
https://www.london.gov.uk/who-we-are/what-london-assembly-does/questions-mayor/find-an-answer/net-housing-completions-london

### 3. `Units LP2021` is a distinct measure

A February 2024 GLA FOI response describes page 6 of 8 of the former dashboard as its “Data” page and confirms that `Number of units` and `Units LP2021` were distinct fields. The LP2021 measure applies the London Plan 2021 ratio used for non-self-contained accommodation.

The reconstruction currently sets `units_lp2021 === units`. That remains an important limitation for reproducing the complete dashboard and London Plan target measure. It is, however, unlikely by itself to explain the discrepancy against the five benchmarks above because those benchmarks are expressly described as self-contained C3/C4 completions.

Source: GLA FOI, “Newham new homes small sites”, February 2024:
https://www.london.gov.uk/who-we-are/governance-and-spending/sharing-our-information/foi-disclosure-log/foi-newham-new-homes-small-sites-feb-2024

### 4. Surviving material documents the former dashboard's structure and behaviour

A planning-appeal document from 2025 contains a reproduced/printed page from the former GLA dashboard. It records that the dashboard had eight pages and preserves explanatory material about the measure. In particular, surviving material indicates that:

- the top-line housing-supply measure combined conventional residential completions with non-self-contained accommodation and, for the relevant pre-2021/22 period, changes in long-term vacancies;
- non-self-contained accommodation had separate dashboard treatment;
- losses were assigned to the year of scheme commencement;
- recent-year results were expressly provisional and subject to substantial later revision; and
- displayed target context could depend on which planning authorities had supplied completion data for the selected period.

This surviving capture should be retained as evidence of dashboard behaviour even if a fully functioning Internet Archive copy of the embedded Power BI application cannot be recovered.

Surviving capture in planning-appeal evidence:
https://gat04-live-1517c8a4486c41609369c68f30c8-aa81074.divio-media.org/filer_public/54/19/5419aa41-68a9-4a3d-8a44-bce481591317/cd0807_appellant_appendices_to_planning_proof_of_evidence_of_nicholas_alston_-_part_1.pdf

### 5. AMR tables provide a second historical comparison series

The GLA AMR tables publish conventional completions over a much longer period and state that historic figures have been updated using the same methodology as the Residential Completions Dashboard, including the commencement-year treatment of losses.

These figures do not necessarily equal the 10 December 2024 C3/C4 extraction. That difference is itself useful evidence that PLD records and published monitoring totals can be revised retrospectively. AMR figures should therefore be used as a second validation series rather than silently substituted for the dated December 2024 extraction.

### 6. Historic PLD snapshots and live PLD are not necessarily identical

The current reconstruction was generated from the live PLD in September 2026, whereas the principal benchmark is a December 2024 extraction. The GLA's own material warns that completion data are revised as borough submissions and corrections arrive. Exact agreement with a historic extraction cannot therefore be assumed even after the methodology is corrected.

The validation work should distinguish:

1. differences caused by reconstruction methodology;
2. differences caused by retrospective changes in PLD source records; and
3. differences caused by the scope or definition of the published measure.

## Validation work programme

### Priority 1 — reproduce the loss-year rule

- [ ] Identify the authoritative PLD application/scheme commencement-date field used by the former dashboard.
- [ ] Confirm whether the rule applies to every loss unit in a scheme or whether there are exceptions/record-level commencement dates.
- [ ] Build a test importer in which gains remain allocated by actual completion date while losses are allocated by commencement date.
- [ ] Rebuild at least 2019/20–2023/24 with that rule.
- [ ] Compare the resulting London totals against the 10 December 2024 C3/C4 benchmarks.
- [ ] Record the amount of each year's existing discrepancy explained by the change.
- [ ] If supported by the evidence, promote the revised rule into the production importer and increment `methodology_version`.

### Priority 2 — establish borough-level benchmarks

London-wide agreement can conceal offsetting errors. Find surviving GLA dashboard tables, FOI responses, Mayor's Answers, AMR appendices or appeal evidence containing borough/year totals.

- [ ] Assemble a benchmark table for several boroughs across 2019/20–2023/24.
- [ ] Prefer sources carrying an extraction/publication date and a clear measure definition.
- [ ] Compare reconstructed borough totals before and after the loss-year correction.
- [ ] Investigate boroughs with unusually large residual differences at application/unit level.

### Priority 3 — investigate residual differences

After applying the confirmed loss rule, investigate remaining differences in this order:

- [ ] retrospective PLD amendments since the dated historic extraction;
- [ ] C3/C4 inclusion and exclusion rules;
- [ ] treatment of schemes or units with missing/ambiguous dates;
- [ ] duplicate or superseded application records and any dashboard-specific deduplication;
- [ ] change-type values other than a simple Gain/Loss distinction;
- [ ] treatment of conversions, demolitions, replacement units and amended schemes;
- [ ] borough attribution where authority names or boundaries have changed.

Do not attribute residual discrepancies to `Units LP2021` unless the benchmark being tested actually uses that measure.

### Priority 4 — reconstruct `Units LP2021` and non-self-contained supply

This is required for equivalence with the broader former dashboard, but should be kept analytically separate from validation of the self-contained C3/C4 series.

- [ ] Locate the exact London Plan 2021 conversion ratios and dashboard implementation rules for non-self-contained accommodation.
- [ ] Identify the relevant PLD collections/fields for student accommodation, hostels, halls of residence and other non-self-contained accommodation.
- [ ] Reconstruct `Units LP2021` as a genuinely separate measure.
- [ ] Determine the treatment of long-term vacant dwellings in the pre-2021/22 target measure.
- [ ] Validate the reconstructed broader measure against surviving dashboard/AMR totals.

### Priority 5 — reproduce target behaviour

The present dashboard hard-codes an All-London target of 42,388 before 2021/22 and 52,287 thereafter. Surviving material indicates that the former dashboard's displayed target could reflect which authorities had supplied completion data.

- [ ] Establish the exact target values and borough target source used by the former dashboard.
- [ ] Determine how missing borough submissions altered the displayed aggregate target.
- [ ] Decide whether the reconstruction should reproduce this behaviour or show a fixed statutory/contextual target with a clear completeness warning.
- [ ] Do not present a partial-year completion/target ratio as directly comparable with a complete-year statutory target without an explicit qualification.

### Priority 6 — validate classifications and filters

The current affordability and use-class categories are inferred from PLD unit text and are useful exploratory classifications, but have not been shown to match the original Power BI dimensions.

- [ ] Recover screenshots, exports or documentation showing the original dashboard's filter values.
- [ ] Map PLD tenure values to the former dashboard's affordability categories where possible.
- [ ] Determine whether use class came from an authoritative application field rather than `unit_type`.
- [ ] Validate site-size categories and Opportunity Area fields if those original dashboard functions are restored.

### Priority 7 — continue archive recovery

- [ ] Search the Internet Archive for the original London Datastore landing page and Power BI embed URL at multiple dates.
- [ ] Search archived page source for Power BI report IDs, embed URLs, downloadable CSV/XLSX links and explanatory text even where the embedded application itself is not replayable.
- [ ] Search planning appeals, committee reports, FOI disclosures, consultation material and screenshots that quote or reproduce dashboard tables.
- [ ] Record every recovered source with URL, capture/publication date, dashboard page/filter state and measure definition.
- [ ] Preserve locally useful benchmark values in documentation so validation does not depend on an interactive archive continuing to work.

## Changes to make to existing validation documentation

- [ ] Update `docs/validation-benchmarks.md` to identify the five 2019/20–2023/24 figures as the GLA's 10 December 2024 PLD extraction of net self-contained C3/C4 completions.
- [ ] Link the GLA source directly from that document.
- [ ] Add the GLA AMR conventional-completions series as a separately labelled secondary benchmark.
- [ ] Replace the current speculative list of causes with a distinction between confirmed methodological differences and hypotheses.
- [ ] Document the commencement-year loss rule prominently in `docs/methodology.md` once implemented.
- [ ] Keep historic comparisons informational until the intended reconstructed measure and source benchmark have demonstrably equivalent definitions.

## Proposed validation standard

A future release should distinguish three levels of assurance:

**Structural validation** — files, summaries, shards and cubes reconcile internally. This is what `validate-data.mjs` primarily establishes today.

**Methodological validation** — the transformation rules have been checked against surviving GLA documentation and known differences are explicit.

**Historical reconciliation** — reconstructed results have been compared against dated GLA outputs at London and borough level, with discrepancies quantified and explained where possible.

Only a benchmark whose scope, date and methodology are sufficiently well established should become a blocking release gate. Historic GLA figures should not be treated as immutable truth where PLD itself has subsequently been corrected, but material unexplained differences should remain visible rather than being normalised away.
