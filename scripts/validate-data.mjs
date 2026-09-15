import { readFile, readdir, stat } from 'node:fs/promises';
import { basename } from 'node:path';

const root = process.env.PLD_OUTPUT_DIR || 'site/data';
const index = JSON.parse(await readFile(`${root}/index.json`));
const referenceTotals = {
  '2019/20': 37843,
  '2020/21': 30703,
  '2021/22': 37524,
  '2022/23': 32053,
  '2023/24': 31629
};

if (!Number.isFinite(Date.parse(index.metadata?.generated_at))) throw new Error('Missing or invalid snapshot timestamp');
if (index.metadata.schema_version !== 3) throw new Error(`Unexpected schema version ${index.metadata.schema_version}`);
if (index.metadata.methodology_version !== 2) throw new Error(`Unexpected methodology version ${index.metadata.methodology_version}`);
if (!Number.isInteger(index.metadata.unit_records) || index.metadata.unit_records < 1) throw new Error('Invalid source unit-record count');
if (!Array.isArray(index.years) || !index.years.length) throw new Error('No financial years in the data index');
if (!Array.isArray(index.annual_summary) || !index.annual_summary.length) throw new Error('No annual summaries in the data index');
if (new Set(index.years.map(entry => entry.year)).size !== index.years.length) throw new Error('Duplicate financial years in the data index');

const startYears = index.years.map(entry => parseYear(entry.year));
for (let position = 1; position < startYears.length; position += 1) {
  if (startYears[position] !== startYears[position - 1] + 1) throw new Error('Financial years are not ordered and continuous');
}

const listedFiles = new Set(index.years.map(entry => basename(entry.file)));
const diskFiles = new Set((await readdir(`${root}/years`)).filter(file => file.endsWith('.json')));
if (listedFiles.size !== diskFiles.size || [...listedFiles].some(file => !diskFiles.has(file))) throw new Error('Year shard directory does not match the data index');

let recordCount = 0;
const detailTotals = new Map();
for (const entry of index.years) {
  if (entry.file !== `years/${entry.year.replace('/', '-')}.json`) throw new Error(`Unexpected shard path for ${entry.year}`);
  const path = `${root}/${entry.file}`;
  const shard = JSON.parse(await readFile(path));
  if (shard.year !== entry.year || !Array.isArray(shard.records)) throw new Error(`Invalid shard for ${entry.year}`);
  if ((await stat(path)).size > 25 * 1024 * 1024) throw new Error(`${entry.year} exceeds GitHub Pages' intended shard size`);

  const rowKeys = new Set();
  for (const row of shard.records) {
    if (row.year !== entry.year) throw new Error(`Cross-year record in ${entry.year}`);
    for (const field of ['address', 'authority', 'affordability', 'dwelling_type', 'use_class']) {
      if (typeof row[field] !== 'string' || !row[field]) throw new Error(`Missing ${field} in ${entry.year}`);
    }
    if (!Number.isFinite(row.units) || !Number.isFinite(row.units_lp2021)) throw new Error(`Invalid unit value in ${entry.year}`);
    if (row.units !== row.units_lp2021) throw new Error(`Unexpected Units LP2021 adjustment in ${entry.year}`);
    const rowKey = [row.address, row.authority, row.year, row.affordability, row.dwelling_type, row.use_class].join('\u0000');
    if (rowKeys.has(rowKey)) throw new Error(`Duplicate address-grouped row in ${entry.year}`);
    rowKeys.add(rowKey);
    add(detailTotals, `${row.authority}\u0000${row.year}`, row.units_lp2021);
    recordCount += 1;
  }
}

const summaryKeys = new Set();
const londonRows = new Map();
const boroughYearTotals = new Map();
for (const row of index.annual_summary) {
  const key = `${row.authority}\u0000${row.year}`;
  if (summaryKeys.has(key)) throw new Error(`Duplicate summary for ${row.authority} ${row.year}`);
  summaryKeys.add(key);
  if (!index.years.some(entry => entry.year === row.year)) throw new Error(`Summary references unlisted year ${row.year}`);
  if (!Number.isFinite(row.completions)) throw new Error(`Invalid summary total for ${row.authority} ${row.year}`);

  let cubeTotal = 0;
  for (const dwellings of Object.values(row.cube || {})) for (const useClasses of Object.values(dwellings)) for (const value of Object.values(useClasses)) cubeTotal += value;
  if (cubeTotal !== row.completions) throw new Error(`Summary cube mismatch for ${row.authority} ${row.year}`);

  if (row.authority === 'All London') londonRows.set(row.year, row);
  else {
    if (detailTotals.get(key) !== row.completions) throw new Error(`Detailed rows disagree with summary for ${row.authority} ${row.year}`);
    add(boroughYearTotals, row.year, row.completions);
  }
}

for (const entry of index.years) {
  const london = londonRows.get(entry.year);
  if (!london) throw new Error(`Missing All London summary for ${entry.year}`);
  if (london.completions !== boroughYearTotals.get(entry.year)) throw new Error(`All London total disagrees with authority summaries for ${entry.year}`);
}
if (recordCount !== index.metadata.records) throw new Error(`Address-grouped record count mismatch: ${recordCount} != ${index.metadata.records}`);

console.log(`Validated ${index.years.length} years, ${index.annual_summary.length} summary rows and ${recordCount} address-grouped records`);
console.log('Historical reference comparisons (informational; provenance not yet independently documented; not release gates):');
for (const [year, reference] of Object.entries(referenceTotals)) {
  const actual = londonRows.get(year)?.completions;
  if (actual === undefined) continue;
  const difference = actual - reference;
  const percentage = difference / reference * 100;
  console.log(`${year}: snapshot ${actual}, reference ${reference}, difference ${difference >= 0 ? '+' : ''}${difference} (${percentage >= 0 ? '+' : ''}${percentage.toFixed(1)}%)`);
}

function add(map, key, value) { map.set(key, (map.get(key) || 0) + value); }
function parseYear(year) {
  const match = /^(\d{4})\/(\d{2})$/.exec(year);
  if (!match || Number(match[2]) !== (Number(match[1]) + 1) % 100) throw new Error(`Invalid financial year ${year}`);
  return Number(match[1]);
}
