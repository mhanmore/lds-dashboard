import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { SCHEMA_VERSION, METHODOLOGY_VERSION } from './rebuild-lib.mjs';

const inputs = process.argv.slice(2);
if (!inputs.length) throw new Error('Pass one or more index.json files or legacy data.json files');

const outputDir = process.env.PLD_OUTPUT_DIR || 'site/data';
const annualSummary = [];
const years = [];
let unitRecords = 0;
let records = 0;
let newestGeneratedAt = '';
await mkdir(join(outputDir, 'years'), { recursive: true });

for (const input of inputs) {
  const payload = JSON.parse(await readFile(input));
  newestGeneratedAt = [newestGeneratedAt, payload.metadata.generated_at].sort().at(-1);
  unitRecords += payload.metadata.unit_records || 0;
  records += payload.metadata.records || payload.records?.length || 0;
  annualSummary.push(...payload.annual_summary);
  if (Array.isArray(payload.years)) {
    for (const year of payload.years) {
      const source = join(input.replace(/\/[^/]+$/, ''), year.file);
      const destination = join(outputDir, 'years', basename(year.file));
      await copyFile(source, destination);
      years.push({ year: year.year, file: `years/${basename(year.file)}` });
    }
  } else {
    for (const year of [...new Set(payload.records.map(row => row.year))].sort()) {
      const file = `${year.replace('/', '-')}.json`;
      await writeFile(join(outputDir, 'years', file), JSON.stringify({ year, records: payload.records.filter(row => row.year === year) }));
      years.push({ year, file: `years/${file}` });
    }
  }
}

const uniqueYears = [...new Map(years.map(year => [year.year, year])).values()].sort((a, b) => a.year.localeCompare(b.year));
const uniqueSummary = [...new Map(annualSummary.map(row => [`${row.authority}\u0000${row.year}`, row])).values()].sort((a, b) => a.year.localeCompare(b.year) || a.authority.localeCompare(b.authority));
const metadata = { generated_at: newestGeneratedAt, source: 'Planning London Datahub public API', source_url: 'https://planningdata.london.gov.uk/api-guest/', schema_version: SCHEMA_VERSION, methodology_version: METHODOLOGY_VERSION, unit_records: unitRecords, records, demo: false };
await writeFile(join(outputDir, 'index.json'), JSON.stringify({ metadata, years: uniqueYears, annual_summary: uniqueSummary }));
const bytes = (await stat(join(outputDir, 'index.json'))).size;
console.log(`Merged ${uniqueYears.length} years, ${uniqueSummary.length} summary rows and ${records} address-grouped records; index ${bytes} bytes`);
