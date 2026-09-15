import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const source = process.env.PLD_BASELINE_SOURCE || 'site/data';
const destination = process.env.PLD_BASELINE_DIR || `build/pld/baselines/${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
const files = [`${source}/index.json`, ...(await readdir(`${source}/years`)).filter(file => file.endsWith('.json')).sort().map(file => `${source}/years/${file}`)];
const index = JSON.parse(await readFile(`${source}/index.json`));
const inventory = [];
for (const path of files) { const content = await readFile(path); inventory.push({ path: path.slice(source.length + 1), bytes: (await stat(path)).size, sha256: createHash('sha256').update(content).digest('hex') }); }
const manifest = { repository_commit: safeGit('rev-parse', 'HEAD'), captured_at: new Date().toISOString(), source_artifact: source, source: index.metadata?.source || null, extraction_timestamp: index.metadata?.generated_at || null, requested_financial_years: index.years?.map(entry => entry.year) || [], schema_version: index.metadata?.schema_version || null, methodology_version: index.metadata?.methodology_version || null, node_version: process.version, pld_environment: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('PLD_'))), counts: { application_hits: null, unit_records: index.metadata?.unit_records ?? null, published_records: index.metadata?.records ?? null, authority_year_summaries: index.annual_summary?.length ?? null }, files: inventory };
await mkdir(destination, { recursive: true });
await writeFile(`${destination}/baseline-manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Frozen baseline manifest written to ${destination}/baseline-manifest.json`);
function safeGit(...args) { try { return execFileSync('git', args, { encoding: 'utf8' }).trim(); } catch { return null; } }
