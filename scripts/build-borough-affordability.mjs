import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function buildBoroughAffordability(dataDir = 'site/data') {
  const index = JSON.parse(await readFile(join(dataDir, 'index.json')));
  const annual = [];

  for (const entry of index.years) {
    const shard = JSON.parse(await readFile(join(dataDir, entry.file)));
    const authorities = new Map();
    for (const record of shard.records || []) {
      if (record.units <= 0 || record.authority === 'All London') continue;
      const bucket = authorities.get(record.authority) || {
        authority: record.authority,
        year: shard.year,
        positive_completions: 0,
        positive_affordable: 0,
        top_affordable_contributor: null
      };
      bucket.positive_completions += record.units;
      if (record.affordability === 'Affordable') {
        bucket.positive_affordable += record.units;
        if (!bucket.top_affordable_contributor || record.units > bucket.top_affordable_contributor.units) {
          bucket.top_affordable_contributor = { address: record.address, units: record.units };
        }
      }
      authorities.set(record.authority, bucket);
    }
    annual.push(...authorities.values());
  }

  annual.sort((a, b) => a.authority.localeCompare(b.authority) || a.year.localeCompare(b.year));
  await writeFile(join(dataDir, 'borough-affordability.json'), JSON.stringify({ annual }));
  return annual.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const count = await buildBoroughAffordability(process.argv[2] || 'site/data');
  console.log(`Wrote ${count} borough-year affordability summaries`);
}
