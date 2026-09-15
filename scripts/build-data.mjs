import { mkdir, readFile, writeFile } from 'node:fs/promises';

// Build-time only: this script is never called by the visitor-facing worker.
// Set PLD_EXPORT_URL to a verified, narrow PLD export endpoint. The endpoint
// may return { records: [...] } or an Elasticsearch-style { hits: { hits: [] } }.
const endpoint = process.env.PLD_EXPORT_URL;
if (!endpoint) throw new Error('PLD_EXPORT_URL is required; runtime must not perform a historical backfill');
const response = await fetch(endpoint, { headers: { accept: 'application/json' } });
if (!response.ok) throw new Error(`PLD export failed with HTTP ${response.status}`);
const payload = await response.json();
const records = payload.records || payload.hits?.hits?.map(hit => ({ ...hit._source, _id: hit._id })) || [];
if (!records.length) throw new Error('PLD export returned no records; refusing to replace baseline');

const years = [...new Set(records.map(record => year(record.completion_year || record.financial_year || record.year)).filter(Boolean))].sort();
const annual_summary = years.map(financialYear => {
  const rows = records.filter(record => year(record.completion_year || record.financial_year || record.year) === financialYear);
  const completions = rows.reduce((sum, record) => sum + number(record.units_lp2021 ?? record.net_units ?? record.units), 0);
  const affordability = group(rows, record => record.affordability || 'Not known / not applicable');
  const dwelling_type = group(rows, record => record.dwelling_type || 'Other');
  return { year: financialYear, authority: 'All London', completions, target: target(financialYear), affordability, dwelling_type };
});
const output = { metadata: { generated_at: new Date().toISOString(), source: 'Planning London Datahub', schema_version: 1, methodology_version: 1, records: records.length }, annual_summary, records: records.map(normalise) };
if (output.annual_summary.some(row => row.completions < 0)) throw new Error('Validation failed: negative annual total');
await mkdir('site/data', { recursive: true });
await writeFile('site/data/data.json', JSON.stringify(output));
console.log(`Wrote ${records.length} records across ${annual_summary.length} financial years`);

function number(value) { const n = Number(value); return Number.isFinite(n) ? n : 0; }
function year(value) { if (!value) return null; const text = String(value); const match = text.match(/(20\d\d)[-/](\d\d)/); if (match) return `${match[1]}/${match[2].slice(-2)}`; return text.match(/^20\d\d$/) ? `${text}/${String(Number(text)+1).slice(-2)}` : null; }
function group(rows, key) { return rows.reduce((result, row) => { const k=key(row); result[k]=(result[k]||0)+number(row.units_lp2021 ?? row.net_units ?? row.units); return result; }, {}); }
function normalise(row) { return { address: row.address || row.site_address || 'Address not recorded', authority: row.authority || row.planning_authority || 'Not known', year: year(row.completion_year || row.financial_year || row.year), units: number(row.units), units_lp2021: number(row.units_lp2021 ?? row.net_units ?? row.units), affordability: row.affordability || 'Not known / not applicable' }; }
function target(value) { return value >= '2021/22' ? 52290 : 42500; }
