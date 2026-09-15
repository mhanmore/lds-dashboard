import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { SCHEMA_VERSION, METHODOLOGY_VERSION, CATEGORY_MAPPING_VERSION, SUPERSESSION_POLICY, VARIANTS, sha256, normaliseApplications, applyVariant, assemble } from './rebuild-lib.mjs';

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
for (const hit of hits) { if (!hit?._id && !hit?._source?.id && !hit?.id) throw new Error('Source hit has no application identifier'); if (unique.has(hit._id)) throw new Error(`Duplicate application hit ${hit._id}`); unique.set(hit._id, hit); }
const rawText = [...unique.values()].map(hit => JSON.stringify(hit)).join('\n') + '\n';
const normalised = normaliseApplications([...unique.values()]);
await mkdir(snapshotDir, { recursive: true });
await writeFile(`${snapshotDir}/raw-applications.ndjson`, rawText);
await writeJson(`${snapshotDir}/source-schema-report.json`, sourceSchemaReport([...unique.values()], normalised));
await writeJson(`${snapshotDir}/applications.json`, normalised.applications);
await writeJson(`${snapshotDir}/residential-unit-facts.json`, normalised.facts);
await writeJson(`${snapshotDir}/normalisation-exceptions.json`, normalised.exceptions);
const snapshotManifest = { snapshot_id: snapshotId, extracted_at: extractedAt, source: process.env.PLD_INPUT_FILE ? `fixture:${basename(process.env.PLD_INPUT_FILE)}` : 'Planning London Datahub public API', source_index: 'applications', requested_financial_years: years(firstYear, lastYear), schema_version: SCHEMA_VERSION, methodology_version: METHODOLOGY_VERSION, category_mapping_version: CATEGORY_MAPPING_VERSION, supersession_policy: SUPERSESSION_POLICY, counts: { application_hits: hits.length, unique_application_hits: unique.size, unit_records: normalised.facts.length, normalisation_exceptions: normalised.exceptions.length }, files: [{ path: 'raw-applications.ndjson', bytes: Buffer.byteLength(rawText), sha256: sha256(rawText) }] };
await writeJson(`${snapshotDir}/manifest.json`, snapshotManifest);

for (const variantId of requestedVariants) {
  const calculated = applyVariant(normalised.facts, variantId, firstYear, lastYear);
  const assembled = assemble(calculated.included);
  const output = `${root}/variants/${variantId}`;
  await mkdir(`${output}/years`, { recursive: true });
  const outputYears = years(firstYear, lastYear);
  for (const year of outputYears) if (!assembled.annual_summary.some(row => row.authority === 'All London' && row.year === year)) assembled.annual_summary.push({ authority: 'All London', year, completions: 0, target: year >= '2021/22' ? 52287 : 42388, affordability: {}, dwelling_type: {}, use_class: {}, cube: {} });
  assembled.annual_summary.sort((a, b) => a.year.localeCompare(b.year) || a.authority.localeCompare(b.authority));
  for (const year of outputYears) await writeJson(`${output}/years/${year.replace('/', '-')}.json`, { year, records: assembled.records.filter(row => row.year === year) });
  const metadata = { generated_at: extractedAt, source_snapshot_id: snapshotId, source_snapshot_path: resolve(snapshotDir), source: snapshotManifest.source, schema_version: SCHEMA_VERSION, methodology_identifier: variantId, methodology_version: METHODOLOGY_VERSION, category_mapping_version: CATEGORY_MAPPING_VERSION, supersession_policy: SUPERSESSION_POLICY, units_lp2021_status: 'unavailable', unit_records: normalised.facts.length, included_records: calculated.included.length, records: assembled.records.length, demo: false };
  await writeJson(`${output}/exceptions.json`, [...normalised.exceptions, ...calculated.exceptions]);
  await writeJson(`${output}/index.json`, { metadata, years: outputYears.map(year => ({ year, file: `years/${year.replace('/', '-')}.json` })), annual_summary: assembled.annual_summary });
  console.log(`${variantId}: ${calculated.included.length} included facts, ${calculated.exceptions.length} dated exceptions, ${assembled.records.length} application/unit detail rows`);
}
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
  const count = new Set(hits.map(hit => hit._id)).size;
  if (expected === null || count !== expected) throw new Error(`Incomplete PLD scroll: ${count} unique hits, expected ${expected ?? 'unknown'}`);
  return hits;
}
function sourceSchemaReport(hits, normalised) { const required = ['application_details.residential_details.residential_units']; const missing = required.filter(path => hits.some(hit => get(hit._source, path) === undefined)); const wrongTypes = required.filter(path => hits.some(hit => !Array.isArray(get(hit._source, path)))); return { schema_version: SCHEMA_VERSION, applications_checked: hits.length, required_paths: required, missing_paths: missing, wrong_container_types: wrongTypes, required_paths_valid: !missing.length && !wrongTypes.length, unit_records: normalised.facts.length, raw_change_type_values: count(normalised.facts.map(fact => fact.change_type_raw ?? '(missing)')), date_statuses: count(normalised.facts.flatMap(fact => [fact.unit_commencement_date.date_status, fact.unit_completion_date.date_status])), application_id_mismatches: normalised.applications.filter(app => app.elasticsearch_id && app.application_id !== app.elasticsearch_id).length }; }
function get(object, path) { return path.split('.').reduce((value, key) => value?.[key], object); }
function count(values) { return Object.fromEntries([...new Set(values)].sort().map(value => [value, values.filter(other => other === value).length])); }
function years(from, to) { return Array.from({ length: to - from + 1 }, (_, index) => `${from + index}/${String(from + index + 1).slice(-2)}`); }
function integerEnv(name, fallback) { const value = Number(process.env[name] ?? fallback); if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`); return value; }
function mostRecentCompletedYear() { const now = new Date(); return now.getUTCMonth() < 3 ? now.getUTCFullYear() - 2 : now.getUTCFullYear() - 1; }
async function writeJson(path, value) { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`); }
