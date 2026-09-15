import { createReadStream } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { basename } from 'node:path';
import { createInterface } from 'node:readline';
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
const raw = await validateRawApplications(`${root}/snapshots/${index.metadata.source_snapshot_id}/raw-applications.ndjson`);
if (raw.count !== manifest.counts.unique_application_hits || raw.uniqueIds !== raw.count) throw new Error('Raw snapshot does not reconcile to unique canonical application IDs');
const schema = JSON.parse(await readFile(`${root}/snapshots/${index.metadata.source_snapshot_id}/source-schema-report.json`));
if (!schema.required_paths_valid) throw new Error('Required source schema paths failed');
const factKeys = new Set(); let factCount = 0;
for await (const fact of readJsonArrayRecords(`${root}/snapshots/${index.metadata.source_snapshot_id}/residential-unit-facts.json`)) { factKeys.add(fact.source_row_key); factCount++; }
if (factKeys.size !== factCount || factCount !== manifest.counts.unit_records) throw new Error('Normalised fact count or identity mismatch');
const dispositions = await validateDispositionRecords(`${dir}/fact-dispositions.json`, factKeys);
if (dispositions.expectedFacts !== factCount || dispositions.assignedFacts !== factCount || dispositions.count !== factCount) throw new Error('Fact disposition count mismatch');
if (dispositions.uniqueKeys !== factCount) throw new Error('A normalised fact has no unique terminal disposition');
const files = new Set(index.years.map(entry => basename(entry.file))), disk = new Set((await readdir(`${dir}/years`)).filter(file => file.endsWith('.json')));
if (files.size !== disk.size || [...files].some(file => !disk.has(file))) throw new Error('Shard inventory mismatch');
let recordCount = 0; const detail = new Map();
for (const entry of index.years) {
  const path = `${dir}/${entry.file}`, shard = JSON.parse(await readFile(path));
  if (shard.year !== entry.year || !Array.isArray(shard.records)) throw new Error(`Invalid shard ${entry.year}`);
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
if (index.metadata.disposition_accounting?.assigned_facts !== factCount) throw new Error('Index disposition metadata mismatch');
console.log(`Structural/accounting validation passed: ${variant}, ${index.years.length} years, ${recordCount} detail facts.`);
console.log('Historical comparison is informational only; live PLD is not the dated 10 December 2024 GLA snapshot.');
for (const [year, benchmark] of Object.entries({ '2019/20': 37843, '2020/21': 30703, '2021/22': 37524, '2022/23': 32053, '2023/24': 31629 })) if (london.has(year)) console.log(`${year}: calculated ${london.get(year)}, GLA dated benchmark ${benchmark}, difference ${london.get(year) - benchmark}`);
async function validateRawApplications(path) {
  const ids = new Set();
  let count = 0;
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    const identity = sourceApplicationIdentity(JSON.parse(line));
    ids.add(identity.application_id);
    count++;
  }
  return { count, uniqueIds: ids.size };
}
async function* readJsonArrayRecords(path) {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (let line of lines) {
    line = line.trim();
    if (!line || line === '[' || line === ']') continue;
    if (line.endsWith(',')) line = line.slice(0, -1);
    yield JSON.parse(line);
  }
}
async function validateDispositionRecords(path, factKeys) {
  const keys = new Set(); let count = 0, expectedFacts = null, assignedFacts = null, inRecords = false;
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (let line of lines) {
    line = line.trim();
    if (line.startsWith('"expected_facts":')) expectedFacts = JSON.parse(line.slice(line.indexOf(':') + 1).replace(/,$/, ''));
    else if (line.startsWith('"global":')) assignedFacts = JSON.parse(line.slice(line.indexOf(':') + 1).replace(/,$/, '')).assigned_facts;
    else if (line === '"dispositions":[') inRecords = true;
    else if (inRecords && line === '],') inRecords = false;
    else if (inRecords && line) {
      if (line.endsWith(',')) line = line.slice(0, -1);
      const row = JSON.parse(line);
      if (!factKeys.has(row.source_row_key)) throw new Error('Disposition references an unknown fact');
      keys.add(row.source_row_key); count++;
    }
  }
  return { expectedFacts, assignedFacts, count, uniqueKeys: keys.size };
}
function add(map, key, value) { map.set(key, (map.get(key) || 0) + value); }
