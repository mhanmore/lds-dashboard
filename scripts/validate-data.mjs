import { readFile, readdir, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { SCHEMA_VERSION, METHODOLOGY_VERSION, VARIANTS, sourceApplicationIdentity } from './rebuild-lib.mjs';

const root = process.env.PLD_OUTPUT_DIR || 'build/pld';
const variant = process.env.PLD_VARIANT || 'unit-root-fallback-losses';
const dir = `${root}/variants/${variant}`;
if (!VARIANTS[variant]) throw new Error(`Unknown PLD_VARIANT ${variant}`);
const index = JSON.parse(await readFile(`${dir}/index.json`));
const manifest = JSON.parse(await readFile(`${root}/snapshots/${index.metadata.source_snapshot_id}/manifest.json`));
if (index.metadata.schema_version !== SCHEMA_VERSION || manifest.schema_version !== SCHEMA_VERSION) throw new Error('Unexpected schema version');
if (index.metadata.methodology_version !== METHODOLOGY_VERSION || index.metadata.methodology_identifier !== variant) throw new Error('Methodology metadata mismatch');
if (index.metadata.units_lp2021_status !== 'unavailable') throw new Error('Units LP2021 must not be substituted with ordinary units');
if (!manifest.counts.application_hits || !manifest.counts.unit_records) throw new Error('Snapshot manifest has invalid counts');
const rawHits = (await readFile(`${root}/snapshots/${index.metadata.source_snapshot_id}/raw-applications.ndjson`, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const rawIds = new Set(rawHits.map(sourceApplicationIdentity).map(identity => identity.application_id));
if (rawHits.length !== manifest.counts.unique_application_hits || rawIds.size !== rawHits.length) throw new Error('Raw snapshot does not reconcile to unique canonical application IDs');
const schema = JSON.parse(await readFile(`${root}/snapshots/${index.metadata.source_snapshot_id}/source-schema-report.json`));
if (!schema.required_paths_valid) throw new Error('Required source schema paths failed');
const facts = JSON.parse(await readFile(`${root}/snapshots/${index.metadata.source_snapshot_id}/residential-unit-facts.json`));
const dispositions = JSON.parse(await readFile(`${dir}/fact-dispositions.json`));
if (dispositions.expected_facts !== facts.length || dispositions.global.assigned_facts !== facts.length || dispositions.dispositions.length !== facts.length) throw new Error('Fact disposition count mismatch');
const dispositionKeys = new Set(dispositions.dispositions.map(row => row.source_row_key));
if (dispositionKeys.size !== facts.length || facts.some(fact => !dispositionKeys.has(fact.source_row_key))) throw new Error('A normalised fact has no unique terminal disposition');
const files = new Set(index.years.map(entry => basename(entry.file))), disk = new Set((await readdir(`${dir}/years`)).filter(file => file.endsWith('.json')));
if (files.size !== disk.size || [...files].some(file => !disk.has(file))) throw new Error('Shard inventory mismatch');
let recordCount = 0; const detail = new Map();
for (const entry of index.years) {
  const path = `${dir}/${entry.file}`, shard = JSON.parse(await readFile(path));
  if (shard.year !== entry.year || !Array.isArray(shard.records) || (await stat(path)).size > 25 * 1024 * 1024) throw new Error(`Invalid shard ${entry.year}`);
  const keys = new Set();
  for (const row of shard.records) {
    for (const field of ['source_row_key', 'application_id', 'authority', 'address', 'reporting_date', 'reporting_date_source', 'change_type', 'affordability', 'dwelling_type', 'use_class']) if (typeof row[field] !== 'string' || !row[field]) throw new Error(`Missing ${field} in ${entry.year}`);
    if (row.year !== entry.year || !Number.isFinite(row.units) || row.units_lp2021 !== null || keys.has(row.source_row_key)) throw new Error(`Invalid or duplicate detail row in ${entry.year}`);
    keys.add(row.source_row_key); add(detail, `${row.authority}\0${row.year}`, row.units); recordCount++;
  }
}
const summaries = new Set(), borough = new Map(), london = new Map();
for (const row of index.annual_summary) {
  const key = `${row.authority}\0${row.year}`; if (summaries.has(key)) throw new Error(`Duplicate summary ${key}`); summaries.add(key);
  const cube = Object.values(row.cube).flatMap(a => Object.values(a)).flatMap(d => Object.values(d)).reduce((sum, value) => sum + value, 0);
  if (cube !== row.completions) throw new Error(`Cube mismatch ${key}`);
  if (row.authority === 'All London') london.set(row.year, row.completions); else { if (detail.get(key) !== row.completions) throw new Error(`Detail mismatch ${key}`); add(borough, row.year, row.completions); }
}
for (const entry of index.years) if (london.get(entry.year) !== (borough.get(entry.year) || 0)) throw new Error(`All London mismatch ${entry.year}`);
if (recordCount !== index.metadata.records) throw new Error('Record count mismatch');
if (index.metadata.disposition_accounting?.assigned_facts !== facts.length) throw new Error('Index disposition metadata mismatch');
console.log(`Structural/accounting validation passed: ${variant}, ${index.years.length} years, ${recordCount} detail facts.`);
console.log('Historical comparison is informational only; live PLD is not the dated 10 December 2024 GLA snapshot.');
for (const [year, benchmark] of Object.entries({ '2019/20': 37843, '2020/21': 30703, '2021/22': 37524, '2022/23': 32053, '2023/24': 31629 })) if (london.has(year)) console.log(`${year}: calculated ${london.get(year)}, GLA dated benchmark ${benchmark}, difference ${london.get(year) - benchmark}`);
function add(map, key, value) { map.set(key, (map.get(key) || 0) + value); }
