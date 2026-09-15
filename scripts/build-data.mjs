import { mkdir, writeFile } from 'node:fs/promises';

// Public, read-only Planning London Datahub Elasticsearch endpoint. The header
// is required by the API's published connection documentation.
const endpoint = process.env.PLD_EXPORT_URL || 'https://planningdata.london.gov.uk/api-guest/applications/_search';
const apiHeader = process.env.PLD_API_ALLOW_REQUEST || 'be2rmRnt&';
const firstYear = Number(process.env.PLD_FIRST_YEAR || 2004);
const now = new Date();
// Default to the most recently finished financial year; partial current-year
// returns are useful for analysis, but should always be requested explicitly.
const lastYear = Number(process.env.PLD_LAST_YEAR || (now.getUTCMonth() < 3 ? now.getUTCFullYear() - 2 : now.getUTCFullYear() - 1));
const pageSize = 1_000;
const outputDir = process.env.PLD_OUTPUT_DIR || 'site/data';

if (!Number.isInteger(firstYear) || !Number.isInteger(lastYear) || firstYear > lastYear) throw new Error('PLD_FIRST_YEAR and PLD_LAST_YEAR must form a valid inclusive range');

const units = [];
for (let startYear = firstYear; startYear <= lastYear; startYear += 1) {
  const yearRecords = await fetchYear(startYear);
  units.push(...yearRecords);
  console.log(`${financialYear(startYear)}: ${yearRecords.length} completed residential units`);
}
if (!units.length) throw new Error('PLD returned no completed residential units; refusing to replace the existing artifact');

const annual_summary = summarise(units);
const records = aggregateSites(units);
const metadata = { generated_at: new Date().toISOString(), source: 'Planning London Datahub public API', source_url: 'https://planningdata.london.gov.uk/api-guest/', schema_version: 3, methodology_version: 2, unit_records: units.length, records: records.length, demo: false };
const years = [...new Set(units.map(row => row.year))].sort();
await mkdir(`${outputDir}/years`, { recursive: true });
for (const year of years) {
  const file = `${year.replace('/', '-')}.json`;
  const shard = { year, records: records.filter(row => row.year === year) };
  await writeFile(`${outputDir}/years/${file}`, JSON.stringify(shard));
}
await writeFile(`${outputDir}/index.json`, JSON.stringify({ metadata, years: years.map(year => ({ year, file: `years/${year.replace('/', '-')}.json` })), annual_summary }));
console.log(`Wrote ${years.length} year shards with ${records.length} address-grouped records and ${annual_summary.length} authority-year summaries from ${units.length} live PLD unit records`);

async function fetchYear(startYear) {
  const hits = [], from = `01/04/${startYear}`, to = `01/04/${startYear + 1}`;
  const unitCompletionDate = 'application_details.residential_details.residential_units.actual_completion_date';
  const headers = { accept: 'application/json', 'content-type': 'application/json', 'X-API-AllowRequest': apiHeader };
  const scrollEndpoint = process.env.PLD_SCROLL_URL || endpoint.replace(/applications\/_search(?:\?.*)?$/, '_search/scroll');
  let scrollId = null, expected = null;
  for (;;) {
    const url = scrollId ? scrollEndpoint : `${endpoint}${endpoint.includes('?') ? '&' : '?'}scroll=2m`;
    const body = scrollId ? { scroll: '2m', scroll_id: scrollId } : { size: pageSize, sort: ['_doc'], track_total_hits: true, query: { nested: { path: 'application_details.residential_details.residential_units', query: { range: { [unitCompletionDate]: { gte: from, lt: to, format: 'dd/MM/yyyy' } } } } }, _source: ['lpa_name', 'site_name', 'site_number', 'street_name', 'postcode', 'actual_completion_date', 'application_details.residential_details.residential_units'] };
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`PLD query for ${financialYear(startYear)} failed with HTTP ${response.status}`);
    const page = await response.json();
    scrollId = page._scroll_id;
    expected ??= page.hits?.total?.value;
    const pageHits = page.hits?.hits || [];
    if (!pageHits.length) break;
    hits.push(...pageHits);
  }
  const uniqueHits = [...new Map(hits.map(hit => [hit._id, hit])).values()];
  if (expected !== null && uniqueHits.length !== expected) throw new Error(`${financialYear(startYear)} returned ${uniqueHits.length} unique applications; expected ${expected}`);
  return uniqueHits.flatMap(hit => normaliseApplication(hit._source, startYear));
}

function normaliseApplication(application, startYear) {
  const units = application.application_details?.residential_details?.residential_units || [];
  const address = [application.site_name, application.site_number, application.street_name, application.postcode].filter(Boolean).join(', ') || 'Address not recorded';
  return units.filter(unit => unit.actual_completion_date && completionYear(unit.actual_completion_date) === startYear).map(unit => ({ address, authority: application.lpa_name || 'Not known', year: financialYear(startYear), units: unit.change_type === 'Loss' ? -1 : 1, units_lp2021: unit.change_type === 'Loss' ? -1 : 1, affordability: affordability(unit.tenure), dwelling_type: dwellingType(unit.unit_type), use_class: useClass(unit.unit_type) }));
}

function summarise(rows) {
  const buckets = new Map();
  for (const row of rows) {
    for (const authority of [row.authority, 'All London']) {
      const key = `${authority}\u0000${row.year}`;
      if (!buckets.has(key)) buckets.set(key, { authority, year: row.year, completions: 0, target: authority === 'All London' ? target(row.year) : null, affordability: {}, dwelling_type: {}, use_class: {}, cube: {} });
      const bucket = buckets.get(key), value = row.units_lp2021;
      bucket.completions += value;
      bucket.affordability[row.affordability] = (bucket.affordability[row.affordability] || 0) + value;
      bucket.dwelling_type[row.dwelling_type] = (bucket.dwelling_type[row.dwelling_type] || 0) + value;
      bucket.use_class[row.use_class] = (bucket.use_class[row.use_class] || 0) + value;
      const byDwelling = bucket.cube[row.affordability] ||= {};
      const byUseClass = byDwelling[row.dwelling_type] ||= {};
      byUseClass[row.use_class] = (byUseClass[row.use_class] || 0) + value;
    }
  }
  return [...buckets.values()].sort((a, b) => a.year.localeCompare(b.year) || a.authority.localeCompare(b.authority));
}

function aggregateSites(rows) {
  const buckets = new Map();
  for (const row of rows) {
    const key = [row.address, row.authority, row.year, row.affordability, row.dwelling_type, row.use_class].join('\u0000');
    if (!buckets.has(key)) buckets.set(key, { ...row, units: 0, units_lp2021: 0 });
    const bucket = buckets.get(key);
    bucket.units += row.units;
    bucket.units_lp2021 += row.units_lp2021;
  }
  return [...buckets.values()].filter(row => row.units_lp2021 !== 0);
}

function completionYear(date) { const [, month, year] = String(date).split('/').map(Number); return month && year ? (month < 4 ? year - 1 : year) : null; }
function financialYear(startYear) { return `${startYear}/${String(startYear + 1).slice(-2)}`; }
function affordability(tenure) { if (!tenure || /not known|unknown/i.test(tenure)) return 'Not known'; if (/not applicable|n\/a/i.test(tenure)) return 'n/a'; return /affordable|social|shared|living rent|intermediate/i.test(tenure) ? 'Affordable' : /market/i.test(tenure) ? 'Market' : tenure; }
function dwellingType(value) { const type = String(value || '').trim(); if (!type) return 'Other'; if (/^hmo$/i.test(type)) return 'C4 small HMO'; if (/^flat apartment maisonette$/i.test(type)) return 'Flat Apartment Maisonette'; if (/^studio bedsit$/i.test(type)) return 'Studio Bedsit'; if (/^house$/i.test(type)) return 'House or Bungalow'; return type; }
function useClass(unitType) { const type = String(unitType || ''); if (/C4|HMO/i.test(type)) return 'C4 small HMO'; if (/student|co living|communal|other/i.test(type)) return 'Other residential'; return type ? 'C3 dwelling' : 'Not known'; }
function group(rows, key) { return rows.reduce((result, row) => { const name = key(row); result[name] = (result[name] || 0) + row.units_lp2021; return result; }, {}); }
function target(year) { return year >= '2021/22' ? 52287 : 42388; }
