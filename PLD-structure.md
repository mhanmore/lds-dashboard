# Planning London Datahub structure for residential completions

## Purpose

This note maps the parts of the Planning London Datahub (PLD) needed to rebuild the former GLA Residential Completions Dashboard more faithfully. It distinguishes fields demonstrated in the public PLD data from rules that remain to be established from GLA methodology or validation.

The immediate conclusion is that the existing importer reads the right broad source but too narrow a slice of it. PLD contains unit-level commencement, completion, phase and supersession information, as well as separate collections for other residential accommodation and non-permanent dwellings. A cleaner implementation should preserve these source records in a normalised intermediate layer and apply dashboard methodology afterwards.

## Evidence base and limits

This structure has been checked against:

- the GLA's public API connection document, which identifies the available Elasticsearch indices and confirms that `applications` contains the nested data;
- the GLA Planning Information Non-Technical Data Standard, which describes the intended information model;
- public PLD application documents, including a June 2025 repository snapshot of the API; and
- the current `scripts/build-data.mjs` implementation.

The public API is Elasticsearch 7.9. The API connection document points to a separate technical schema, but the exact current mapping was not retrievable during this review. Field paths below are therefore classed as either **observed** in public PLD documents or **index documented** by the GLA. Before changing production code, run the small mapping and coverage probes set out below against the live endpoint.

## Available indices

The GLA API guide documents these relevant indices:

| Index | Grain | Relevance |
| --- | --- | --- |
| `applications` | One document per planning application, with nested arrays | Canonical context and relationships; contains residential units and all other nested details |
| `residential_units` | One document per residential unit | Potentially simpler fact-table source for conventional housing; parent keys and parity with the nested array must be verified |
| `other_resi_accommodation_unit_details` | One document per other-residential-accommodation unit | Required for hostels, halls, care and other non-self-contained supply and the LP2021-adjusted measure |
| `non-permanent_dwellings_details` | One document per non-permanent dwelling record | Required for traveller pitches, houseboat moorings and other non-permanent main residences |
| `existing_proposed_floorspace_details` | One document per floorspace item | Not needed for the conventional completions count, but useful for checking use-class and mixed-use context |
| `open_spaces_details`, `protected_spaces_details` | One document per relevant spatial item | Out of scope for this dashboard |

The clean design should test the three flattened housing indices against their corresponding nested arrays. If identifiers and parent application keys are stable and the counts agree, use the flattened indices as fact tables and `applications` as the dimension/context table. If not, use `applications` as the authoritative extraction source.

## Observed application document hierarchy

```text
application
├── identity, authority and address
├── application status and decisions
├── application-level progress dates
├── geometry and spatial context
└── application_details
    ├── residential_details
    │   └── residential_units[]
    ├── other_residential_accommodation_details
    │   └── other_resi_accommodation_unit_details[]
    ├── non_permanent_dwellings_details[]
    ├── superseding_details[]
    ├── constraints_details[]
    └── other development details
```

### Application identity and context

These observed root fields should be retained in the intermediate model rather than discarded after forming an address:

| Field | Use |
| --- | --- |
| `id` and Elasticsearch `_id` | Stable join/deduplication candidate; test whether they always agree |
| `lpa_app_no` | Human-readable application reference |
| `lpa_name` | Reporting planning authority as supplied |
| `borough` | Geographic borough label; do not assume it is interchangeable with `lpa_name` |
| `site_name`, `site_number`, `street_name`, `secondary_street_name`, `locality`, `postcode` | Display address components |
| `uprn` | Site/building linkage where populated |
| `centroid`, `centroid_easting`, `centroid_northing`, `polygon`, `wgs84_polygon` | Map display and spatial joins |
| `ward` | Optional geography/filter |
| `application_type`, `application_type_full` | Application scope and diagnostic filtering |
| `development_type` | Scheme-level development classification |
| `description` | Audit and exception investigation |
| `bo_system`, `last_updated`, `last_updated_by` | Provenance and revision diagnostics |

The current importer groups output by assembled address. That is suitable only as a display aggregation. It loses application identity and can merge unrelated permissions at the same address. Store `application_id` and `lpa_app_no` in the canonical layer and aggregate only for the final view.

### Application status, decisions and progress

Observed root fields relevant to inclusion and chronology include:

- `status`;
- `valid_date`, `decision_date`, `decision`, `decision_process`, `decision_agency`;
- `actual_commencement_date`;
- `actual_completion_date`;
- `lapsed_date`;
- `date_building_work_started_under_previous_permission`;
- `date_building_work_completed_under_previous_permission`;
- `reference_no_of_permission_being_relied_on`; and
- appeal dates/status fields.

For completions, the two root progress dates are useful fallbacks and scheme-level checks. They must not automatically overwrite more specific unit dates.

## Conventional residential units

Nested path:

`application_details.residential_details.residential_units[]`

Observed unit fields are:

| Field | Interpretation/use |
| --- | --- |
| `change_type` | Normally `Gain` or `Loss`; enumerate all live values before assuming a binary vocabulary |
| `actual_commencement_date` | Unit/phase-level actual commencement date; primary candidate for dating losses |
| `actual_completion_date` | Unit/phase-level actual completion date; primary field for dating gains |
| `phase_detail` | Phase identifier or description; retain for phased schemes and date diagnostics |
| `unit_no` | Unit identifier within the application where supplied |
| `description` | Unit description |
| `unit_type` | Dwelling/accommodation type, not necessarily a statutory planning use class |
| `unit_development_type` | New build, conversion or other unit-level development type |
| `tenure` | Detailed tenure label |
| `provider` | Provider category |
| `no_bedrooms`, `gia` | Unit size fields |
| `provision_for_older_persons` | Specialist-housing flag |
| `m42_compliant`, `m43_2a_compliant` | Accessibility fields |
| `superseded_date` | Unit-level supersession indicator |
| `superseded_by_lpa_app_no` | Link to the replacing permission |

The parent `residential_details` object also contains totals and checks including:

- `total_no_existing_residential_units`;
- `total_no_proposed_residential_units`;
- existing/proposed affordable-unit totals;
- detailed existing/proposed tenure totals;
- `total_no_proposed_bedrooms`;
- `affordable_percentage`;
- `dwelling_density` and `habitable_rooms_density`; and
- `site_area`.

These totals should be used as quality-control checks, not substituted for unit-level fact rows. They describe the permission and may not encode completion timing or partial/phased delivery.

### Date rule for the former dashboard

Surviving GLA methodology says gains are recorded in the year completed while losses are recorded in the year the scheme commenced. PLD can support that distinction at unit level.

Recommended candidate rule for testing:

1. For `Gain`, use the unit's `actual_completion_date`.
2. For `Loss`, use the unit's `actual_commencement_date`.
3. If the required unit date is missing, test a fallback to the corresponding root `actual_commencement_date` or `actual_completion_date`.
4. Keep fallback-dated and undated rows separately flagged so their effects can be reported.

This is a **candidate implementation**, not yet proof of the original Power BI rule. The GLA wording “scheme commencement” might mean the root date in every case. Unit-level dates are nevertheless important because PLD explicitly supports phases. Validate both variants:

- losses by unit commencement with root fallback; and
- losses always by root scheme commencement.

An observed legacy application demonstrates why a fallback policy is necessary: its root `actual_commencement_date` is populated, its completed gain units carry unit commencement/completion dates, but its loss units have null unit dates. A unit-only rule would silently drop every loss on that scheme.

### Why the present year-by-year query cannot simply be patched

The current query first selects applications containing a unit whose `actual_completion_date` falls within one financial year, then filters all returned units to that same completion year. If losses are moved to commencement year, that retrieval predicate becomes incomplete.

For each reporting year the query must retrieve at least the union of:

- a nested `Gain` unit with completion in the year; and
- a nested `Loss` unit with commencement in the year.

The `change_type` and date clauses for each branch must be inside the same nested query so Elasticsearch does not satisfy them from different units in the array. Root-fallback losses require a further branch for loss units missing unit commencement where the application's root commencement is in range.

A cleaner and less error-prone approach is to extract the relevant source facts once, normalise them, and assign `reporting_date_source` and `reporting_financial_year` in code. This also avoids retrieving the same application independently for several financial years.

## Supersession and duplicate permissions

PLD expresses replacement relationships at two levels:

- `application_details.superseding_details[]`, observed with `lpa_app_no` and `partial_supersedence`; and
- unit fields `superseded_date` and `superseded_by_lpa_app_no`.

Application `_id` deduplication only removes duplicate Elasticsearch hits from paging. It does **not** prevent double counting across separate original and superseding permissions.

Do not invent an exclusion rule from the field names alone. First profile:

- completed units with a non-null `superseded_date`;
- whether the replacing application contains corresponding unit rows;
- full versus partial supersedence;
- whether supersession occurred before commencement, during construction or after a recorded completion; and
- whether historical GLA benchmark totals include or exclude each category.

The intermediate model should preserve all relationship fields so alternative rules can be replayed without re-downloading PLD.

## Other residential accommodation

Observed application path:

`application_details.other_residential_accommodation_details`

Observed contents include:

- `no_council_tax_rateable_units_lost`;
- `no_council_tax_rateable_units_gained`; and
- `other_resi_accommodation_unit_details[]`.

The GLA separately documents a flattened `other_resi_accommodation_unit_details` index. This is the likely source for non-self-contained accommodation and the distinct `Units LP2021` measure. The non-technical standard says the relevant family includes hostels and other non-standard residential types and records rooms/units lost and gained. It also separately asks for hotel/holiday bedrooms.

Before implementing it, retrieve the live mapping and value distributions for:

- accommodation/use type;
- change type;
- room, bedroom or unit count;
- commencement and completion dates;
- phase and supersession fields; and
- parent application identifiers.

Do not infer a one-row-equals-one-dwelling conversion. The former dashboard's `Units LP2021` field was distinct from raw unit count and applied London Plan 2021 ratios to non-self-contained accommodation.

## Non-permanent dwellings

Observed application path:

`application_details.non_permanent_dwellings_details[]`

The GLA also documents a flattened `non-permanent_dwellings_details` index. The data standard describes:

- Gypsy and Traveller pitches / Travelling Showpeople or circus plots;
- other non-permanent main residences, such as caravans and mobile homes; and
- houseboat moorings used as a main residence,

with losses and gains recorded separately.

As with other residential accommodation, inspect the live mapping before writing transformations. Retain raw type, count, change, dates and parent identifiers, and apply any housing-supply conversion only in the methodology layer.

## Use class, dwelling type and affordability

### Use class

`unit_type` is not an authoritative planning use-class field. The application's general/non-residential data may contain existing and proposed use-class information, but it may be at floorspace rather than dwelling-unit grain. The current `useClass(unit.unit_type)` output must therefore remain explicitly inferred unless a defensible unit/application join is established.

### Dwelling type

Use the supplied `unit_type` and optionally `unit_development_type` as separate dimensions. Do not collapse them early. This retains distinctions between physical accommodation type and the mechanism of development.

### Affordability

The unit's `tenure` is the best observed fact at unit grain. Parent residential totals provide reconciliation checks. A clean implementation should preserve the raw tenure and map it through a versioned lookup table; regex classification should be a visible fallback, not the canonical stored value.

## Site size and spatial filters

The former dashboard's Data page supported a site-size filter. Observed candidates include:

- `application_details.residential_details.site_area`; and
- `application_details.non_residential_details.site_area`.

The correct field and threshold convention must be established from the former dashboard or GLA documentation. Profile disagreements between the two fields on mixed-use schemes before selecting one.

Opportunity Area is not demonstrated as a stable application field in the evidence reviewed. The application has geometry plus `constraints_details[]`; an Opportunity Area may appear there for some records, but a reproducible implementation should preferably spatially join the application centroid/polygon to a versioned official Opportunity Area layer. This avoids depending on inconsistent free-text constraint labels.

## Authority and target completeness

Retain both `lpa_name` and `borough`. Development corporations and cross-boundary cases mean “planning authority” and geographic borough are not always the same concept. Cross-borough applications are expected by the data standard to be reported by both authorities using the same lead UPRN, creating another possible double-counting route that `_id` deduplication will not catch.

To reproduce the former target behaviour, build a separate borough-year submission/completeness table. It should not be inferred merely from whether a borough has at least one completion row: zero completions and no submission are different states. The PLD application data alone may not provide the original dashboard's submission flag, so this remains an external-methodology requirement.

## Recommended canonical intermediate model

Do not write directly from API documents to address-grouped dashboard rows. Preserve a small, auditable star-like model:

### `applications`

- application and LPA identifiers;
- both authority/geographic labels;
- address, UPRN and geometry;
- application/status/decision fields;
- root commencement and completion dates;
- update/provenance fields; and
- superseding relationships.

### `residential_unit_facts`

- stable source-row key (or deterministic hash if PLD supplies none);
- parent application ID;
- raw unit/phase identifiers and classifications;
- gain/loss sign;
- raw unit commencement/completion dates;
- root fallback dates copied from the parent;
- supersession fields;
- chosen reporting date, its source and financial year;
- raw count (`1` for a genuine unit row); and
- methodology-adjusted count as a separately named field.

### `other_residential_facts` and `non_permanent_facts`

Use the same parent/date/change/supersession pattern, retaining the supplied raw quantity and accommodation type. Add LP2021 equivalents only after the exact ratios and scope have been sourced.

### Derived dimensions

Keep raw and mapped versions of tenure, dwelling type, development type, use class and spatial area. Store mapping/methodology versions in metadata.

This structure permits several methodologies and historic snapshot comparisons to be calculated from the same extracted facts.

## Live API probes required before implementation

The following are deliberately small diagnostic requests, not a full rebuild.

1. Retrieve `_mapping` for `applications`, `residential_units`, `other_resi_accommodation_unit_details` and `non-permanent_dwellings_details`.
2. Retrieve a few documents from each flattened index and record their parent application keys.
3. Compare counts and deterministic field hashes between a sample of flattened residential-unit rows and the nested units in their parent applications.
4. Run `terms` aggregations for `change_type`, `unit_type`, `unit_development_type`, `tenure`, status and relevant supersession flags.
5. Run `missing`/`exists` counts for unit and root commencement/completion dates, split by gain/loss, LPA and source/back-office system.
6. Count losses in these mutually exclusive categories:
   - unit commencement present;
   - unit commencement missing but root commencement present;
   - both commencement dates missing;
   - unit and root commencement disagree in financial year.
7. Profile phased schemes using `phase_detail` and multiple distinct unit dates.
8. Profile completed rows with non-null supersession fields.
9. Check whether `residential_units` is mapped as nested in `applications`; the current query assumes that it is and appears to operate successfully, but the live mapping is the authority.
10. Save probe date, query bodies and aggregate results because PLD changes retrospectively.

## Retrieval design for a cleaner implementation

Recommended sequence:

1. Extract raw application/unit facts into a dated local snapshot without assigning dashboard years.
2. Validate source structure, parent joins and flattened-versus-nested parity.
3. Normalise dates with strict `dd/MM/yyyy` parsing and retain invalid raw values in an exceptions report.
4. Apply a versioned reporting-date policy with explicit fallback flags.
5. Apply a separately versioned supersession policy.
6. Reconcile unit counts against parent totals, without forcing them to agree.
7. Produce conventional C3/C4 output separately from broader LP2021-equivalent supply.
8. Aggregate by stable application/site identifiers; construct address labels only for display.
9. Emit validation tables by year, LPA, date-source category, change type, tenure and supersession status.
10. Compare against the dated December 2024 self-contained benchmark and current AMR series.

## Minimal first implementation change

The first defensible experiment should remain narrow:

- conventional `residential_units` only;
- gains dated by unit completion;
- losses tested under both unit-commencement-with-root-fallback and root-scheme-commencement variants;
- raw tenure/unit type retained;
- superseded rows reported separately but not silently excluded; and
- London and borough totals produced for 2019/20–2023/24.

This will measure how much of the existing excess is explained by the confirmed loss-year mismatch without mixing in LP2021 conversion, non-conventional accommodation or speculative deduplication rules.

## Sources

- GLA, [Planning London Datahub API connection technical documentation](https://www.london.gov.uk/sites/default/files/planninglondondatahub_api_connection_technical_documentation_v1.pdf)
- GLA, [Planning London Datahub](https://www.london.gov.uk/programmes-strategies/planning/digital-planning/planning-london-datahub)
- GLA, [Planning Information Non-Technical Data Standard, version 2](https://www.london.gov.uk/sites/default/files/updated_non_technical_planning_data_standard.pdf)
- GLA, [London Plan AMR tables](https://www.london.gov.uk/programmes-strategies/planning/implementing-london-plan/monitoring-london-plan/london-plan-amr-tables)
- Public June 2025 PLD snapshot, [davidarkemp/london-planning-datahub](https://github.com/davidarkemp/london-planning-datahub)
- Project validation programme, [`validation-todo.md`](validation-todo.md)

