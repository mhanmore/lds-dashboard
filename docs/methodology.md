# Methodology and limitations

## Status and intended use

This is an independent, experimental reconstruction prompted by the aim of making withdrawn housing-completion data easier to explore. It is not affiliated with or endorsed by the Greater London Authority and should not be treated as an official product, continuation or authoritative reproduction of the former Power BI dashboard.

Source data: Greater London Authority, Planning London Datahub. The GLA cannot warrant the source data's quality or accuracy. This project's data and calculations are also provided without warranty or representation of accuracy, completeness or fitness for a particular purpose. The results may change when source records are corrected or when this project's interpretation changes. Do not rely on the dashboard for statutory monitoring, planning decisions, financial decisions or other consequential uses. Consult the [GLA housing-supply explanation](https://data.london.gov.uk/housing/housing-supply-data-sources), [London Datastore terms](https://data.london.gov.uk/about/terms-and-conditions/), London Plan Annual Monitoring Reports and source PLD records as appropriate.

## Source and snapshot process

`npm run build:data` reads the public, read-only Planning London Datahub Elasticsearch API. By default it requests every financial year from 2004/05 through the most recently completed financial year. Each year is retrieved using an Elasticsearch scroll, application hits are de-duplicated by their Elasticsearch identifier, and the number of unique applications is checked against the API's reported hit count.

The generated static artifact consists of:

- `site/data/index.json`, containing metadata, the shard inventory and authority-year summary cubes; and
- `site/data/years/*.json`, containing address-grouped detail rows for individual financial years.

The checked-in artifact currently uses schema version 3 and methodology version 2. The browser reads only these local files. It never queries PLD when a filter or chart changes.

The intended production arrangement is an external weekly VPS job which pulls the repository, builds and validates a temporary snapshot, replaces `site/data` only after validation succeeds, and pushes the result. GitHub Pages then republishes the static site. That external schedule and credential are not part of this repository and must be configured separately.

## Completion measure

The importer reads nested `application_details.residential_details.residential_units` entries from PLD application documents. A unit is included when it has an `actual_completion_date` in the requested financial year. A unit whose `change_type` is `Loss` contributes −1; every other included unit contributes +1.

This is a project-defined net count of the retrieved self-contained unit entries. It is not the complete London Plan housing-supply measure. In particular, the importer does not currently include PLD's other-residential-accommodation or non-permanent-dwellings collections. The GLA explains that total net housing supply combines conventional self-contained completions with non-conventional accommodation such as hostel and halls-of-residence bedrooms.

The output fields `units` and `units_lp2021` are currently identical. No independent GLA `Units LP2021` adjustment has been reconstructed. The latter name is retained only for schema compatibility and must not be read as confirmation that the former dashboard's adjusted measure has been reproduced.

## Classifications

Affordability is inferred from the source unit's tenure text:

- text containing affordable, social, shared, living rent or intermediate is grouped as `Affordable`;
- text containing market is grouped as `Market`;
- unknown and not-applicable values remain explicit; and
- other tenure labels are retained as supplied.

Unit types are lightly normalised for display. The use-class field is not supplied by PLD: it is inferred from unit type. HMO-like records are grouped as `C4 small HMO`, ordinary identified dwelling types as `C3 dwelling`, and student, co-living, communal and other types as `Other residential`. This inference is convenient for exploration but is not a planning use-class determination.

## Aggregation and dashboard behaviour

Annual summaries are grouped by authority and financial year and retain a three-dimensional affordability × unit-type × inferred-use-class cube. An `All London` row is independently accumulated from all included unit entries.

Detail rows are grouped by address text, authority, financial year, affordability, unit type and inferred use class. They are not application-level records and contain no stable planning-application identifier. Separate developments with identical grouping values may therefore be combined, while one development may appear in several rows. Groups with a net value of zero are omitted.

The dashboard's “affordable share” is the net affordable count divided by the overall net count for the selected filters. Losses and unknown tenure categories can affect that ratio.

London-wide annual target references are hard-coded as 42,388 before 2021/22 and 52,287 from 2021/22. They are shown only for an unfiltered All London selection. They are contextual reference values, not a borough target series or a statutory assessment, and the numerator excludes non-conventional supply.

When a borough is selected, its comparison panel shows the five authorities immediately above and five immediately below it in the current filtered delivery ranking where available. If the selected authority is near an end of the ranking, the list is filled with the remaining closest totals. The selected authority is shown in addition to those ten comparators and is visually marked as the focus.

## Validation and known differences

`npm run validate:data` checks internal consistency of a completed artifact. It does not prove that PLD is complete, that source values are correct, or that the transformation matches the withdrawn dashboard. Several historical London-wide totals are printed as non-blocking reference comparisons; the current reconstructed measure is higher than those figures. See [validation status](validation-benchmarks.md).

Known gaps include non-conventional accommodation, the former `Units LP2021` adjustment, Opportunity Area and site-size fields, an authoritative use class, borough target series, and reconciliation against borough- and tenure-level published figures.
