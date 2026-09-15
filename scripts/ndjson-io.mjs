import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { createInterface } from 'node:readline';

// Published JSON array files are written one record per line (`[`, then one
// `record,` per line, then `]`) so they can be produced and re-read without
// ever holding the whole array in memory — the shape is still plain valid
// JSON to any downstream reader.
export async function openArrayWriter(path) {
  const handle = await open(path, 'wx');
  let first = true;
  await handle.write('[\n');
  return {
    async write(value) {
      await handle.write(`${first ? '' : ',\n'}${JSON.stringify(value)}`);
      first = false;
    },
    async close() {
      await handle.write('\n]\n');
      await handle.close();
    }
  };
}

export async function* readArrayRecords(path) {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (let line of lines) {
    line = line.trim();
    if (!line || line === '[' || line === ']') continue;
    if (line.endsWith(',')) line = line.slice(0, -1);
    yield JSON.parse(line);
  }
}

// Internal working files: plain newline-delimited JSON, never published,
// used to spill per-year/per-pass working sets to disk instead of RAM.
export async function openLineWriter(path) {
  const handle = await open(path, 'wx');
  return {
    async write(value) { await handle.write(`${JSON.stringify(value)}\n`); },
    async close() { await handle.close(); }
  };
}

export async function* readLinesIfExists(path) {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  try {
    for await (const line of lines) if (line) yield JSON.parse(line);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
}
