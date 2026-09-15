# Scraper rebuild: second-pass review

This document records the next implementation pass following review of the first `scraper-rebuild` implementation. The architecture is now broadly correct: extraction, normalisation, named methodology variants and assembly are separated, and the rebuilt model retains substantially more audit information than the original pipeline.

The purpose of the second pass is **not** to broaden the methodology speculatively. It is to turn the current implementation into a reliable measurement and reconciliation instrument, then run a single PLD snapshot through the competing variants so that subsequent changes are driven by observed differences.

## 1. Priority fixes before live comparison

### 1.1 Canonical source application identity

`build-data.mjs` currently accepts a source hit where any of `_id`, `_source.id` or `id` exists, but duplicate detection is performed using `hit._id` alone. This creates inconsistent identity semantics and will incorrectly treat multiple records without Elasticsearch `_id` as duplicates under the `undefined` key.

Introduce one canonical helper, e.g. `sourceApplicationId(hit)`, and use it consistently for:

- source-hit validation;
- duplicate detection;
- unique-hit counting;
- normalisation/application identity;
- source-schema diagnostics; and
- extraction reconciliation.

Retain Elasticsearch `_id`, PLD/source `id` and `lpa_app_no` separately so mismatches remain observable. Do not silently choose between conflicting non-null identifiers without reporting the conflict.

### 1.2 Complete source-fact disposition accounting

The validator currently reconciles included detail rows through authority totals, London totals and cubes. It does not yet demonstrate that every normalised source fact has exactly one explainable disposition.

For each methodology variant, classify every fact into mutually exclusive disposition categories, at minimum:

- included in requested reporting window;
- valid reporting date but outside requested window;
- missing required reporting date;
- invalid/impossible required reporting date;
- missing `change_type`;
- unrecognised `change_type`; and
- any future explicit exclusion category.

The exact taxonomy can be refined, but the accounting invariant should be explicit and machine-tested:

```text
normalised facts = included facts + excluded/exception facts
```

No fact should disappear merely because its reporting year falls outside the requested range. The validator should fail if a fact is unaccounted for or assigned to incompatible terminal dispositions.

Emit disposition counts globally and, where useful, by gain/loss, reporting-date source and authority.

### 1.3 Supersession diagnostics and alternative totals

`retain-and-flag-v1` is a sensible initial supersession policy, but the current implementation only labels included records as `flagged`/`not_flagged`. It does not yet quantify the effect.

Retain all records in the canonical output for this policy, but generate diagnostics showing:

- total units from flagged records by FY;
- total units from unflagged records by FY;
- authority/FY breakdown;
- gain/loss breakdown;
- relevant raw supersession indicators; and
- an **informational alternative total excluding flagged records**.

The alternative total is a diagnostic, not a new methodology claim. It must be labelled accordingly because the existence of a supersession marker does not establish that every residential unit in the permission should be excluded.

This is required to answer whether supersession plausibly explains any material part of the difference from the former GLA series.

### 1.4 Expand source-schema profiling

The present schema report chiefly verifies that `application_details.residential_details.residential_units` exists and is an array. Extend it so schema/mapping drift in analytically important fields becomes visible.

Profile at least:

- application/source identifiers;
- `lpa_app_no`;
- `lpa_name` and `borough`;
- residential-unit container;
- `change_type`;
- unit commencement/completion dates;
- root commencement/completion dates;
- `unit_type`;
- `unit_development_type`;
- `tenure`;
- `phase_detail`;
- supersession fields; and
- `bo_system`.

Distinguish **hard required structural fields** from fields that may legitimately be null/missing on individual records. Report observed types, null/missing counts and raw categorical values where useful rather than making every nullable analytical field a hard schema failure.

Capture enough information to recognise a new field shape or category before it silently alters the output.

## 2. Classification cleanup

### 2.1 Move category rules out of hard-coded functions

`CATEGORY_MAPPING_VERSION` currently suggests a versioned mapping contract, while affordability, dwelling type and inferred use class are implemented directly as functions/regular expressions.

Move these rules into an explicit versioned configuration/lookup structure, or otherwise make the versioned rule set machine-readable. Preserve raw values in all cases.

The immediate goal is reproducibility, not perfect classification.

### 2.2 Treat inferred use class conservatively

The current `inferredUseClass()` effectively classifies most populated unit types that are not recognised as HMO/student/co-living/etc. as `C3 dwelling`. That is a stronger inference than the raw source necessarily supports.

Before relying on this dimension for GLA comparison:

- inventory actual `unit_type` and `unit_development_type` values from the live snapshot;
- document which values genuinely support C3/C4 inference;
- distinguish direct source classification from inference; and
- use `Not known`/`Other residential` where the evidence does not support a planning use-class assignment.

Do not optimise the mapping merely to improve agreement with the GLA benchmark.

## 3. Identity semantics

The fallback `source_row_key` combines application ID, array position and a hash of the raw unit object. This is deterministic for a frozen snapshot and suitable for exact reconstruction, but it should not be described or relied upon as a stable longitudinal unit identifier: array order or mutable source fields can change between PLD snapshots.

Document it explicitly as **snapshot source-row identity** unless/until a stable PLD unit identifier is validated.

If a flattened PLD representation exposes a candidate stable unit identifier, investigate and test nested/flattened parity separately before adopting it.

## 4. Test-fixture expansion

The current transformation tests prove the basic variant mechanism but do not yet exercise enough of the design contract. Add small committed fixtures and expected outcomes for at least:

- gain with unit completion;
- gain missing unit completion with root-completion fallback;
- gain missing all usable completion dates;
- loss with unit commencement;
- loss requiring root-commencement fallback;
- root and unit dates in different financial years;
- commencement after completion;
- malformed and impossible dates;
- missing `change_type`;
- unexpected `change_type`;
- missing reporting authority/unallocated treatment;
- superseded permission;
- partially/ambiguously superseded permission where available;
- duplicate-looking but legitimate units;
- identical addresses on separate applications;
- repeated source hit/paging duplicate;
- source `id` without Elasticsearch `_id`;
- conflicting source and Elasticsearch identifiers; and
- facts with valid dates outside the requested reporting window.

Each fixture expectation should identify the methodology variant being tested. Tests should assert disposition accounting as well as totals.

## 5. Expected-difference ledger

Generate the reconciliation ledger automatically from the same snapshot for all four current variants:

- `completion-date-all`;
- `unit-commencement-losses`;
- `root-commencement-losses`; and
- `unit-root-fallback-losses`.

For each FY report, at minimum:

- frozen/current-pipeline total where available;
- tested variant total;
- gain total;
- loss total;
- unit-date contribution;
- root-fallback contribution;
- flagged-supersession contribution;
- unallocated-authority contribution;
- external GLA benchmark where available; and
- residual difference from the benchmark.

Also make the principal differences available by authority. London-wide agreement alone is insufficient because borough errors may offset one another.

Where practical, derive explicit pairwise effects rather than merely printing four totals, especially:

- completion-date losses → unit-commencement losses;
- unit commencement → root commencement;
- addition of root fallback; and
- informational removal of supersession-flagged records.

## 6. Validation gates for the second pass

Before interpreting a live comparison, require the following to pass:

1. API scroll count reconciles to unique canonical source application IDs.
2. Required source structure passes schema validation.
3. Normalised application/unit counts are recorded.
4. Every normalised fact has an accounted terminal disposition for each variant.
5. Included facts reconcile to browser detail rows.
6. Detail rows reconcile to authority/FY summaries.
7. Authority totals reconcile to All London.
8. Every filter cube reconciles to its parent total.
9. Expected shards are present once only and within size limits.
10. `units_lp2021` remains explicitly unavailable rather than substituted with ordinary unit counts.
11. Source snapshot and methodology metadata identify the exact build inputs.

External GLA agreement remains a separate validation layer. Structural/accounting success must not be presented as proof that the rebuilt methodology reproduces the former dashboard.

## 7. Live comparison run

Once the fixes above are complete, take **one immutable live PLD snapshot** and run all four variants from that same normalised fact set.

Do not make further methodological adjustments before inspecting this comparison unless required to fix a structural/accounting defect.

The first analysis should answer:

- How much does moving losses from completion to commencement redistribute totals between financial years?
- Does it materially change the long-run conventional-completions total, or chiefly timing?
- How many gains/losses require root fallback, and what is their FY distribution?
- How large is the supersession-flagged population?
- Which authorities and years drive the difference from the dated GLA benchmarks?
- Are residual differences concentrated in particular raw tenure, dwelling/unit type, source system, phase status or reporting-date source?
- Are parent residential totals systematically inconsistent with unit-array facts?

The result should determine the scope of the **third pass**. In particular, do not add speculative deduplication, supersession exclusion, LP2021 conversion, non-conventional accommodation or increasingly aggressive use-class inference simply because a benchmark residual remains.

## 8. Lower-priority follow-up

These remain part of the rebuild design but need not block the first empirical methodology comparison unless they expose a correctness problem:

- richer raw-snapshot request/mapping inventory;
- retry/back-off and scroll-expiry recovery;
- performance/memory measurements;
- deterministic file/checksum coverage beyond the raw snapshot;
- release-manifest/code-commit capture;
- privacy/licensing review of expanded browser detail;
- flattened-index parity investigation; and
- publication/migration of the browser from schema v3 to the rebuilt schema.

## 9. Acceptance point for this pass

The second pass is complete when the rebuilt pipeline can take one frozen PLD snapshot, produce all four methodology variants, prove complete source-fact accounting and internal aggregate reconciliation, quantify fallback and supersession effects, and emit a comparison ledger against the frozen pipeline/available GLA benchmarks.

At that point the code is not necessarily ready to replace production. It is ready to tell us, with evidence, which methodological questions actually matter next.
