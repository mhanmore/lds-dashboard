import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { SCHEMA_VERSION, METHODOLOGY_VERSION, CATEGORY_MAPPING_VERSION, SUPERSESSION_POLICY, VARIANTS, CATEGORY_RULES, sha256, sourceApplicationIdentity, normaliseApplications, applyVariant, assemble } from './rebuild-lib.mjs';

const firstYear = integerEnv('PLD_FIRST_YEAR', 2004);
const lastYear = integerEnv('PLD_LAST_YEAR', mostRecentCompletedYear());
const root = process.env.PLD_OUTPUT_DIR || 'build/pld';
const requestedVariants = (process.env.PLD_VARIANTS || Object.keys(VARIANTS).join(',')).split(',').map(value => value.trim()).filter(Boolean);
if (firstYear > lastYear) throw new Error('PLD_FIRST_YEAR and PLD_LAST_YEAR must form a valid inclusive range');
for (const variant of requestedVariants) if (!VARIANTS[variant]) throw new Error(`Unknown PLD_VARIANTS entry: ${variant}`);

const extractedAt = new Date().toISOString();
const snapshotId = process.env.PLD_SNAPSHOT_ID || extractedAt.replace(/[-:.TZ]/g, '').slice(0, 14);
const snapshotDir = `${root}/snapshots/${snapshotId}`;
const hits = await inputHits();
if (!hits.length) throw new Error('PLD returned no application hits; refusing to create a snapshot');
const unique = new Map();
for (const hit of hits) {
  const identity = sourceApplicationIdentity(hit);
  if (!identity.application_id) throw new Error('Source hit has no application identifier');
  if (unique.has(identity.application_id)) throw new Error(`Duplicate application hit for canonical ID ${identity.application_id}`);
  unique.set(identity.application_id, hit);
}
const rawText = [...unique.values()].map(hit => JSON.stringify(hit)).join('\n') + '\n';
const normalised = normaliseApplications([...unique.values()]);
await mkdir(snapshotDir, { recursive: true });
await writeFile(`${snapshotDir}/raw-applications.ndjson`, rawText);
await writeJson(`${snapshotDir}/source-schema-report.json`, sourceSchemaReport([...unique.values()], normalised));
await writeJson(`${snapshotDir}/applications.json`, normalised.applications);
await writeJson(`${snapshotDir}/residential-unit-facts.json`, normalised.facts);
await writeJson(`${snapshotDir}/normalisation-exceptions.json`, normalised.exceptions);
const snapshotManifest = { snapshot_id: snapshotId, extracted_at: extractedAt, source: process.env.PLD_INPUT_FILE ? `fixture:${basename(process.env.PLD_INPUT_FILE)}` : 'Planning London Datahub public API', source_index: 'applications', requested_financial_years: years(firstYear, lastYear), schema_version: SCHEMA_VERSION, methodology_version: METHODOLOGY_VERSION, category_mapping_version: CATEGORY_MAPPING_VERSION, supersession_policy: SUPERSESSION_POLICY, source_row_identity: 'snapshot source-row identity (application canonical ID + array position + raw unit hash); not a stable longitudinal PLD unit identifier', counts: { application_hits: hits.length, unique_application_hits: unique.size, unit_records: normalised.facts.length, normalisation_exceptions: normalised.exceptions.length }, files: [{ path: 'raw-applications.ndjson', bytes: Buffer.byteLength(rawText), sha256: sha256(rawText) }] };
await writeJson(`${snapshotDir}/manifest.json`, snapshotManifest);

const ledger = { generated_at: extractedAt, source_snapshot_id: snapshotId, methodology_variants: {}, benchmarks: glaBenchmarks() };
for (const variantId of requestedVariants) {
  const calculated = applyVariant(normalised.facts, variantId, firstYear, lastYear);
  const assembled = assemble(calculated.included);
  const output = `${root}/variants/${variantId}`;
  await mkdir(`${output}/years`, { recursive: true });
  const outputYears = years(firstYear, lastYear);
  for (const year of outputYears) if (!assembled.annual_summary.some(row => row.authority === 'All London' && row.year === year)) assembled.annual_summary.push({ authority: 'All London', year, completions: 0, target: year >= '2021/22' ? 52287 : 42388, affordability: {}, dwelling_type: {}, use_class: {}, cube: {} });
  assembled.annual_summary.sort((a, b) => a.year.localeCompare(b.year) || a.authority.localeCompare(b.authority));
  for (const year of outputYears) await writeJson(`${output}/years/${year.replace('/', '-')}.json`, { year, records: assembled.records.filter(row => row.year === year) });
  const disposition = dispositionReport(calculated.dispositions, normalised.facts.length);
  const supersession = supersessionDiagnostics(calculated.included);
  const metadata = { generated_at: extractedAt, source_snapshot_id: snapshotId, source_snapshot_path: resolve(snapshotDir), source: snapshotManifest.source, schema_version: SCHEMA_VERSION, methodology_identifier: variantId, methodology_version: METHODOLOGY_VERSION, category_mapping_version: CATEGORY_MAPPING_VERSION, supersession_policy: SUPERSESSION_POLICY, units_lp2021_status: 'unavailable', unit_records: normalised.facts.length, included_records: calculated.included.length, records: assembled.records.length, disposition_accounting: disposition.global, demo: false };
  await writeJson(`${output}/exceptions.json`, [...normalised.exceptions, ...calculated.exceptions]);
  await writeJson(`${output}/fact-dispositions.json`, { variant: variantId, expected_facts: normalised.facts.length, ...disposition });
  await writeJson(`${output}/supersession-diagnostics.json`, supersession);
  await writeJson(`${output}/index.json`, { metadata, years: outputYears.map(year => ({ year, file: `years/${year.replace('/', '-')}.json` })), annual_summary: assembled.annual_summary });
  ledger.methodology_variants[variantId] = variantLedger(assembled.annual_summary, calculated.included, supersession, glaBenchmarks());
  console.log(`${variantId}: ${calculated.included.length} included facts, ${calculated.exceptions.length} dated exceptions, ${assembled.records.length} application/unit detail rows`);
}
ledger.pairwise_effects = pairwiseEffects(ledger.methodology_variants);
await writeJson(`${root}/reconciliation-ledger.json`, ledger);
console.log(`Snapshot ${snapshotId} written to ${root}; published site/data was not changed.`);

async function inputHits() {
  if (process.env.PLD_INPUT_FILE) {
    const text = await readFile(process.env.PLD_INPUT_FILE, 'utf8');
    const parsed = text.trim().startsWith('[') ? JSON.parse(text) : text.trim().split('\n').filter(Boolean).map(JSON.parse);
    return parsed.map(value => value._source || value._id ? value : { _id: String(value.id), _source: value });
  }
  const endpoint = process.env.PLD_EXPORT_URL || 'https://planningdata.london.gov.uk/api-guest/applications/_search';
  const scrollEndpoint = process.env.PLD_SCROLL_URL || endpoint.replace(/applications\/_search(?:\?.*)?$/, '_search/scroll');
  const headers = { accept: 'application/json', 'content-type': 'application/json', 'X-API-AllowRequest': process.env.PLD_API_ALLOW_REQUEST || 'be2rmRnt&' };
  const hits = []; let scrollId = null; let expected = null;
  for (;;) {
    const url = scrollId ? scrollEndpoint : `${endpoint}${endpoint.includes('?') ? '&' : '?'}scroll=2m`;
    const body = scrollId ? { scroll: '2m', scroll_id: scrollId } : { size: 1000, sort: ['_doc'], track_total_hits: true, query: { nested: { path: 'application_details.residential_details.residential_units', query: { exists: { field: 'application_details.residential_details.residential_units.change_type' } } } } };
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`PLD extraction failed with HTTP ${response.status}`);
    const page = await response.json(); scrollId = page._scroll_id; expected ??= page.hits?.total?.value;
    const pageHits = page.hits?.hits || []; if (!pageHits.length) break; hits.push(...pageHits);
  }
  const count = new Set(hits.map(hit => sourceApplicationIdentity(hit).application_id)).size;
  if (expected === null || count !== expected) throw new Error(`Incomplete PLD scroll: ${count} unique hits, expected ${expected ?? 'unknown'}`);
  return hits;
}
function sourceSchemaReport(hits, normalised) {
  const required = ['application_details.residential_details.residential_units'];
  const missing = required.filter(path => hits.some(hit => get(hit._source || hit, path) === undefined));
  const wrongTypes = required.filter(path => hits.some(hit => !Array.isArray(get(hit._source || hit, path))));
  const appFields = ['id', 'lpa_app_no', 'lpa_name', 'borough', 'bo_system', 'actual_commencement_date', 'actual_completion_date'];
  const unitFields = ['change_type', 'actual_commencement_date', 'actual_completion_date', 'unit_type', 'unit_development_type', 'tenure', 'phase_detail', 'superseded_date', 'superseded_by_lpa_app_no'];
  const profile = {};
  profile.elasticsearch_id = profileValues(hits.map(hit => hit._id));
  for (const field of appFields) profile[`application.${field}`] = profileValues(hits.map(hit => (hit._source || hit)[field]));
  profile['application_details.residential_details.residential_units'] = profileValues(hits.map(hit => get(hit._source || hit, 'application_details.residential_details.residential_units')));
  for (const field of unitFields) profile[`residential_unit.${field}`] = profileValues(normalised.facts.map(fact => rawFactValue(fact, field)));
  return { schema_version: SCHEMA_VERSION, applications_checked: hits.length, required_paths: required, missing_paths: missing, wrong_container_types: wrongTypes, required_paths_valid: !missing.length && !wrongTypes.length, unit_records: normalised.facts.length, fields: profile, raw_change_type_values: count(normalised.facts.map(fact => fact.change_type_raw ?? '(missing)')), raw_unit_type_values: count(normalised.facts.map(fact => fact.unit_type_raw ?? '(missing)')), raw_unit_development_type_values: count(normalised.facts.map(fact => fact.unit_development_type_raw ?? '(missing)')), raw_tenure_values: count(normalised.facts.map(fact => fact.tenure_raw ?? '(missing)')), date_statuses: count(normalised.facts.flatMap(fact => [fact.unit_commencement_date.date_status, fact.unit_completion_date.date_status, fact.root_commencement_date.date_status, fact.root_completion_date.date_status])), application_identifier_conflicts: normalised.applications.filter(app => app.identifier_conflict).map(app => ({ application_id: app.application_id, elasticsearch_id: app.elasticsearch_id, source_id: app.source_id, hit_id: app.hit_id })) };
}
function rawFactValue(fact, field) { return ({ change_type: fact.change_type_raw, actual_commencement_date: fact.unit_commencement_date.raw_date, actual_completion_date: fact.unit_completion_date.raw_date, unit_type: fact.unit_type_raw, unit_development_type: fact.unit_development_type_raw, tenure: fact.tenure_raw, phase_detail: fact.phase_detail_raw, superseded_date: fact.superseded_date_raw, superseded_by_lpa_app_no: fact.superseded_by_lpa_app_no })[field]; }
function profileValues(values) { const missing = values.filter(value => value === undefined).length, nulls = values.filter(value => value === null).length; return { observed_types: count(values.filter(value => value !== undefined && value !== null).map(value => Array.isArray(value) ? 'array' : typeof value)), missing, nulls, populated: values.length - missing - nulls, raw_values: count(values.filter(value => value !== undefined && value !== null && ['string', 'number', 'boolean'].includes(typeof value)).map(String)) }; }
function dispositionReport(dispositions, expected) { const counts = count(dispositions.map(item => item.reason)); const byAuthority = {}, byGainLoss = {}, byDateSource = {}; for (const item of dispositions) { const authority = item.authority || 'Unallocated', change = item.change_type || 'Not classified', dateSource = item.reporting_date_source || 'none'; for (const [target, key] of [[byAuthority, authority], [byGainLoss, change], [byDateSource, dateSource]]) { target[key] ??= {}; target[key][item.reason] = (target[key][item.reason] || 0) + 1; } } if (dispositions.length !== expected || new Set(dispositions.map(item => item.source_row_key)).size !== expected) throw new Error('Fact disposition accounting failed: every fact must have exactly one disposition'); return { global: { expected_facts: expected, assigned_facts: dispositions.length, categories: counts }, dispositions, by_authority: byAuthority, by_gain_loss: byGainLoss, by_reporting_date_source: byDateSource }; }
function supersessionDiagnostics(rows) { const byYear = {}, byAuthorityYear = {}, rawIndicators = {}; for (const row of rows) { const bucket = byYear[row.year] ||= { flagged_units: 0, unflagged_units: 0, informational_excluding_flagged_total: 0, gain: { flagged_units: 0, unflagged_units: 0 }, loss: { flagged_units: 0, unflagged_units: 0 } }; const authority = byAuthorityYear[`${row.authority}\0${row.year}`] ||= { authority: row.authority, year: row.year, flagged_units: 0, unflagged_units: 0, informational_excluding_flagged_total: 0, gain: { flagged_units: 0, unflagged_units: 0 }, loss: { flagged_units: 0, unflagged_units: 0 } }; const key = row.supersession_status === 'flagged' ? 'flagged_units' : 'unflagged_units'; const change = row.change_type.toLowerCase(); for (const target of [bucket, authority]) { target[key] += row.units; target[change][key] += row.units; if (row.supersession_status !== 'flagged') target.informational_excluding_flagged_total += row.units; } if (row.supersession_status === 'flagged') { for (const indicator of ['superseded_date_raw', 'superseded_by_lpa_app_no', 'application_superseding_details']) { const value = row[indicator]; if (value) rawIndicators[indicator] = (rawIndicators[indicator] || 0) + 1; } } } return { policy: SUPERSESSION_POLICY, note: 'Informational alternative only: a supersession marker does not prove every unit should be excluded.', by_financial_year: byYear, by_authority_financial_year: Object.values(byAuthorityYear), raw_indicator_counts: rawIndicators }; }
function variantLedger(summary, rows, supersession, benchmarks) { const london = Object.fromEntries(summary.filter(row => row.authority === 'All London').map(row => [row.year, row.completions])); const yearsOut = {}; for (const [year, total] of Object.entries(london)) { const matching = rows.filter(row => row.year === year); yearsOut[year] = { tested_variant_total: total, gain_total: matching.filter(row => row.units > 0).length, loss_total: -matching.filter(row => row.units < 0).length, unit_date_contribution: matching.filter(row => row.reporting_date_source.startsWith('unit_')).reduce((sum, row) => sum + row.units, 0), root_fallback_contribution: matching.filter(row => row.fallback_reason).reduce((sum, row) => sum + row.units, 0), flagged_supersession_contribution: supersession.by_financial_year[year]?.flagged_units || 0, unallocated_authority_contribution: matching.filter(row => row.lpa_name == null).reduce((sum, row) => sum + row.units, 0), external_gla_benchmark: benchmarks[year] ?? null, residual_difference_from_benchmark: benchmarks[year] == null ? null : total - benchmarks[year] }; } return { by_financial_year: yearsOut, by_authority: summary.filter(row => row.authority !== 'All London').map(row => ({ authority: row.authority, year: row.year, tested_variant_total: row.completions })) }; }
function pairwiseEffects(variants) { const pairs = [['completion-date-all', 'unit-commencement-losses'], ['unit-commencement-losses', 'root-commencement-losses'], ['unit-commencement-losses', 'unit-root-fallback-losses']]; return pairs.map(([from, to]) => ({ from, to, by_financial_year: Object.fromEntries(Object.keys(variants[from]?.by_financial_year || {}).map(year => [year, (variants[to]?.by_financial_year?.[year]?.tested_variant_total || 0) - (variants[from]?.by_financial_year?.[year]?.tested_variant_total || 0)])) })); }
function glaBenchmarks() { return { '2019/20': 37843, '2020/21': 30703, '2021/22': 37524, '2022/23': 32053, '2023/24': 31629 }; }
function get(object, path) { return path.split('.').reduce((value, key) => value?.[key], object); }
function count(values) { return Object.fromEntries([...new Set(values)].sort().map(value => [value, values.filter(other => other === value).length])); }
function years(from, to) { return Array.from({ length: to - from + 1 }, (_, index) => `${from + index}/${String(from + index + 1).slice(-2)}`); }
function integerEnv(name, fallback) { const value = Number(process.env[name] ?? fallback); if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`); return value; }
function mostRecentCompletedYear() { const now = new Date(); return now.getUTCMonth() < 3 ? now.getUTCFullYear() - 2 : now.getUTCFullYear() - 1; }
async function writeJson(path, value) { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`); }
