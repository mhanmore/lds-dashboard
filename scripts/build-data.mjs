import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { SCHEMA_VERSION, METHODOLOGY_VERSION, CATEGORY_MAPPING_VERSION, SUPERSESSION_POLICY, VARIANTS, sourceApplicationIdentity, normaliseHit, classifyFact, addSummary, emptySummaryRow, toDetailRow, compareSummary, compareDetail } from './rebuild-lib.mjs';
import { openArrayWriter, readArrayRecords, openLineWriter, readLinesIfExists } from './ndjson-io.mjs';

// Everything here is written to and re-read from disk one record at a time.
// No stage holds the full application/fact set in memory: a single streaming
// pass writes the snapshot, then each methodology variant re-reads
// residential-unit-facts.json from disk rather than reusing an in-memory
// array, so peak memory stays bounded regardless of dataset size (this ran
// out of a 4GB default V8 heap holding four separate full-dataset copies
// before this rewrite; a modest VPS should now handle it comfortably).

const firstYear = integerEnv('PLD_FIRST_YEAR', 2004);
const lastYear = integerEnv('PLD_LAST_YEAR', mostRecentCompletedYear());
const root = process.env.PLD_OUTPUT_DIR || 'build/pld';
const requestedVariants = (process.env.PLD_VARIANTS || Object.keys(VARIANTS).join(',')).split(',').map(value => value.trim()).filter(Boolean);
if (firstYear > lastYear) throw new Error('PLD_FIRST_YEAR and PLD_LAST_YEAR must form a valid inclusive range');
for (const variant of requestedVariants) if (!VARIANTS[variant]) throw new Error(`Unknown PLD_VARIANTS entry: ${variant}`);
const outputYears = years(firstYear, lastYear);

const extractedAt = new Date().toISOString();
const snapshotId = process.env.PLD_SNAPSHOT_ID || extractedAt.replace(/[-:.TZ]/g, '').slice(0, 14);
const snapshotDir = `${root}/snapshots/${snapshotId}`;

const { hitCount, uniqueCount, factCount, exceptionCount, rawFile } = await buildSnapshot();
const ledger = { generated_at: extractedAt, source_snapshot_id: snapshotId, methodology_variants: {}, benchmarks: glaBenchmarks() };
for (const variantId of requestedVariants) {
  const result = await buildVariant(variantId);
  ledger.methodology_variants[variantId] = result.ledgerEntry;
  console.log(`${variantId}: ${result.includedCount} included facts, ${result.exceptionCount} dated exceptions, ${result.includedCount} application/unit detail rows`);
}
ledger.pairwise_effects = pairwiseEffects(ledger.methodology_variants);
await writeJson(`${root}/reconciliation-ledger.json`, ledger);
console.log(`Snapshot ${snapshotId} written to ${root}; published site/data was not changed.`);

async function buildSnapshot() {
  // Peek the first hit before creating anything on disk, so an empty or
  // failed fetch aborts before any files exist (matches prior behaviour).
  const iterator = iterHits()[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) throw new Error('PLD returned no application hits; refusing to create a snapshot');
  async function* hits() { yield first.value; for (;;) { const next = await iterator.next(); if (next.done) return; yield next.value; } }

  await mkdir(snapshotDir, { recursive: true });
  const rawHandle = await open(`${snapshotDir}/raw-applications.ndjson`, 'wx');
  const rawHash = createHash('sha256');
  let rawBytes = 0;
  const appsWriter = await openArrayWriter(`${snapshotDir}/applications.json`);
  const factsWriter = await openArrayWriter(`${snapshotDir}/residential-unit-facts.json`);
  const exceptionsWriter = await openArrayWriter(`${snapshotDir}/normalisation-exceptions.json`);
  const schema = createSchemaAccumulator();
  const seenIds = new Set();
  let hitCount = 0, factCount = 0, exceptionCount = 0;
  try {
    for await (const hit of hits()) {
      hitCount++;
      const identity = sourceApplicationIdentity(hit);
      if (!identity.application_id) throw new Error('Source hit has no application identifier');
      if (seenIds.has(identity.application_id)) throw new Error(`Duplicate application hit for canonical ID ${identity.application_id}`);
      seenIds.add(identity.application_id);
      const line = `${JSON.stringify(hit)}\n`;
      await rawHandle.write(line);
      rawHash.update(line);
      rawBytes += Buffer.byteLength(line);
      const { application, facts, exceptions } = normaliseHit(hit);
      schema.addHit(hit, hit._source || hit);
      schema.addApplicationRecord(application);
      await appsWriter.write(application);
      for (const fact of facts) { factCount++; schema.addFact(fact); await factsWriter.write(fact); }
      for (const item of exceptions) { exceptionCount++; await exceptionsWriter.write(item); }
    }
  } finally {
    await rawHandle.close();
    await appsWriter.close();
    await factsWriter.close();
    await exceptionsWriter.close();
  }
  const rawFile = { bytes: rawBytes, sha256: rawHash.digest('hex') };
  await writeJson(`${snapshotDir}/source-schema-report.json`, schema.finalize(hitCount, factCount));
  const manifest = { snapshot_id: snapshotId, extracted_at: extractedAt, source: process.env.PLD_INPUT_FILE ? `fixture:${basename(process.env.PLD_INPUT_FILE)}` : 'Planning London Datahub public API', source_index: 'applications', requested_financial_years: outputYears, schema_version: SCHEMA_VERSION, methodology_version: METHODOLOGY_VERSION, category_mapping_version: CATEGORY_MAPPING_VERSION, supersession_policy: SUPERSESSION_POLICY, source_row_identity: 'snapshot source-row identity (application canonical ID + array position + raw unit hash); not a stable longitudinal PLD unit identifier', counts: { application_hits: hitCount, unique_application_hits: seenIds.size, unit_records: factCount, normalisation_exceptions: exceptionCount }, files: [{ path: 'raw-applications.ndjson', ...rawFile }] };
  await writeJson(`${snapshotDir}/manifest.json`, manifest);
  return { hitCount, uniqueCount: seenIds.size, factCount, exceptionCount, rawFile };
}

async function buildVariant(variantId) {
  const output = `${root}/variants/${variantId}`;
  const tmpDir = `${root}/.tmp-${snapshotId}-${variantId}`;
  await mkdir(`${output}/years`, { recursive: true });
  await mkdir(tmpDir, { recursive: true });
  try {
    const summaries = new Map();
    const yearWriters = new Map();
    async function yearWriter(year) {
      if (!yearWriters.has(year)) yearWriters.set(year, await openLineWriter(`${tmpDir}/${year.replace('/', '-')}.ndjson`));
      return yearWriters.get(year);
    }
    const dispositionsTmp = `${tmpDir}/dispositions.ndjson`;
    const dispTmpWriter = await openLineWriter(dispositionsTmp);
    const excWriter = await openArrayWriter(`${output}/exceptions.json`);
    for await (const item of readArrayRecords(`${snapshotDir}/normalisation-exceptions.json`)) await excWriter.write(item);

    const categoryCounts = new Map();
    const byAuthority = {}, byGainLoss = {}, byDateSource = {};
    const supersession = { byYear: {}, byAuthorityYear: {}, rawIndicators: {} };
    const yearStats = new Map();
    let assignedCount = 0, variantExceptionCount = 0, includedCount = 0;

    for await (const fact of readArrayRecords(`${snapshotDir}/residential-unit-facts.json`)) {
      const result = classifyFact(fact, variantId, firstYear, lastYear);
      assignedCount++;
      bump(categoryCounts, result.disposition.reason);
      bumpBucket(byAuthority, result.disposition.authority || 'Unallocated', result.disposition.reason);
      bumpBucket(byGainLoss, result.disposition.change_type || 'Not classified', result.disposition.reason);
      bumpBucket(byDateSource, result.disposition.reporting_date_source || 'none', result.disposition.reason);
      await dispTmpWriter.write(result.disposition);
      if (result.exception) { variantExceptionCount++; await excWriter.write(result.exception); }
      if (result.included) {
        const row = result.included;
        includedCount++;
        for (const authority of [row.lpa_name || 'Unallocated', 'All London']) addSummary(summaries, authority, row);
        addSupersession(supersession, row);
        addYearStat(yearStats, row);
        const writer = await yearWriter(row.year);
        await writer.write(toDetailRow(row));
      }
    }
    for (const writer of yearWriters.values()) await writer.close();
    await dispTmpWriter.close();
    await excWriter.close();
    if (assignedCount !== factCount) throw new Error('Fact disposition accounting failed: every fact must have exactly one disposition');

    for (const year of outputYears) if (!summaries.has(`All London\0${year}`)) summaries.set(`All London\0${year}`, emptySummaryRow('All London', year));
    const sortedSummary = [...summaries.values()].sort(compareSummary);

    let recordsTotal = 0;
    for (const year of outputYears) {
      const rows = [];
      for await (const row of readLinesIfExists(`${tmpDir}/${year.replace('/', '-')}.ndjson`)) rows.push(row);
      rows.sort(compareDetail);
      recordsTotal += rows.length;
      await writeJson(`${output}/years/${year.replace('/', '-')}.json`, { year, records: rows });
    }

    const disposition = { global: { expected_facts: factCount, assigned_facts: assignedCount, categories: sortedObject(categoryCounts) }, by_authority: byAuthority, by_gain_loss: byGainLoss, by_reporting_date_source: byDateSource };
    await writeDispositionReport(`${output}/fact-dispositions.json`, variantId, factCount, disposition, dispositionsTmp);

    const supersessionOutput = finalizeSupersession(supersession);
    await writeJson(`${output}/supersession-diagnostics.json`, supersessionOutput);

    const metadata = { generated_at: extractedAt, source_snapshot_id: snapshotId, source_snapshot_path: resolve(snapshotDir), source: process.env.PLD_INPUT_FILE ? `fixture:${basename(process.env.PLD_INPUT_FILE)}` : 'Planning London Datahub public API', schema_version: SCHEMA_VERSION, methodology_identifier: variantId, methodology_version: METHODOLOGY_VERSION, category_mapping_version: CATEGORY_MAPPING_VERSION, supersession_policy: SUPERSESSION_POLICY, units_lp2021_status: 'unavailable', unit_records: factCount, included_records: includedCount, records: recordsTotal, disposition_accounting: disposition.global, demo: false };
    await writeJson(`${output}/index.json`, { metadata, years: outputYears.map(year => ({ year, file: `years/${year.replace('/', '-')}.json` })), annual_summary: sortedSummary });

    const ledgerEntry = finalizeLedger(sortedSummary, yearStats, supersessionOutput, glaBenchmarks());
    return { includedCount, exceptionCount: variantExceptionCount, ledgerEntry };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

async function writeDispositionReport(path, variant, expectedFacts, report, dispositionsTmpPath) {
  const handle = await open(path, 'wx');
  try {
    await handle.write(`{\n"variant":${JSON.stringify(variant)},\n"expected_facts":${expectedFacts},\n"global":${JSON.stringify(report.global)},\n"dispositions":[\n`);
    let first = true;
    for await (const disposition of readLinesIfExists(dispositionsTmpPath)) {
      await handle.write(`${first ? '' : ',\n'}${JSON.stringify(disposition)}`);
      first = false;
    }
    await handle.write(`\n],\n"by_authority":${JSON.stringify(report.by_authority)},\n"by_gain_loss":${JSON.stringify(report.by_gain_loss)},\n"by_reporting_date_source":${JSON.stringify(report.by_reporting_date_source)}\n}\n`);
  } finally {
    await handle.close();
  }
}

function newSupersessionBucket() { return { flagged_units: 0, unflagged_units: 0, informational_excluding_flagged_total: 0, gain: { flagged_units: 0, unflagged_units: 0 }, loss: { flagged_units: 0, unflagged_units: 0 } }; }
function addSupersession(acc, row) {
  const bucket = acc.byYear[row.year] ||= newSupersessionBucket();
  const authorityKey = `${row.authority}\0${row.year}`;
  const authority = acc.byAuthorityYear[authorityKey] ||= { authority: row.authority, year: row.year, ...newSupersessionBucket() };
  const key = row.supersession_status === 'flagged' ? 'flagged_units' : 'unflagged_units';
  const change = row.change_type.toLowerCase();
  for (const target of [bucket, authority]) {
    target[key] += row.units;
    target[change][key] += row.units;
    if (row.supersession_status !== 'flagged') target.informational_excluding_flagged_total += row.units;
  }
  if (row.supersession_status === 'flagged') {
    for (const indicator of ['superseded_date_raw', 'superseded_by_lpa_app_no', 'application_superseding_details']) {
      const value = row[indicator];
      if (value) acc.rawIndicators[indicator] = (acc.rawIndicators[indicator] || 0) + 1;
    }
  }
}
function finalizeSupersession(acc) {
  return { policy: SUPERSESSION_POLICY, note: 'Informational alternative only: a supersession marker does not prove every unit should be excluded.', by_financial_year: acc.byYear, by_authority_financial_year: Object.values(acc.byAuthorityYear), raw_indicator_counts: acc.rawIndicators };
}

function addYearStat(map, row) {
  const stat = map.get(row.year) || { gain: 0, loss: 0, unitDateSum: 0, rootFallbackSum: 0, unallocatedSum: 0 };
  if (row.units > 0) stat.gain++; else if (row.units < 0) stat.loss++;
  if (row.reporting_date_source.startsWith('unit_')) stat.unitDateSum += row.units;
  if (row.fallback_reason) stat.rootFallbackSum += row.units;
  if (row.lpa_name == null) stat.unallocatedSum += row.units;
  map.set(row.year, stat);
}
function finalizeLedger(summary, yearStats, supersession, benchmarks) {
  const london = Object.fromEntries(summary.filter(row => row.authority === 'All London').map(row => [row.year, row.completions]));
  const yearsOut = {};
  for (const [year, total] of Object.entries(london)) {
    const stat = yearStats.get(year) || { gain: 0, loss: 0, unitDateSum: 0, rootFallbackSum: 0, unallocatedSum: 0 };
    yearsOut[year] = { tested_variant_total: total, gain_total: stat.gain, loss_total: -stat.loss, unit_date_contribution: stat.unitDateSum, root_fallback_contribution: stat.rootFallbackSum, flagged_supersession_contribution: supersession.by_financial_year[year]?.flagged_units || 0, unallocated_authority_contribution: stat.unallocatedSum, external_gla_benchmark: benchmarks[year] ?? null, residual_difference_from_benchmark: benchmarks[year] == null ? null : total - benchmarks[year] };
  }
  return { by_financial_year: yearsOut, by_authority: summary.filter(row => row.authority !== 'All London').map(row => ({ authority: row.authority, year: row.year, tested_variant_total: row.completions })) };
}

async function* iterHits() {
  if (process.env.PLD_INPUT_FILE) { yield* iterFixtureHits(process.env.PLD_INPUT_FILE); return; }
  const endpoint = process.env.PLD_EXPORT_URL || 'https://planningdata.london.gov.uk/api-guest/applications/_search';
  const scrollEndpoint = process.env.PLD_SCROLL_URL || endpoint.replace(/applications\/_search(?:\?.*)?$/, '_search/scroll');
  const headers = { accept: 'application/json', 'content-type': 'application/json', 'X-API-AllowRequest': process.env.PLD_API_ALLOW_REQUEST || 'be2rmRnt&' };
  let scrollId = null, expected = null, seen = 0;
  for (;;) {
    const url = scrollId ? scrollEndpoint : `${endpoint}${endpoint.includes('?') ? '&' : '?'}scroll=2m`;
    const body = scrollId ? { scroll: '2m', scroll_id: scrollId } : { size: 1000, sort: ['_doc'], track_total_hits: true, query: { nested: { path: 'application_details.residential_details.residential_units', query: { exists: { field: 'application_details.residential_details.residential_units.change_type' } } } } };
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`PLD extraction failed with HTTP ${response.status}`);
    const page = await response.json();
    scrollId = page._scroll_id;
    expected ??= page.hits?.total?.value;
    const pageHits = page.hits?.hits || [];
    if (!pageHits.length) break;
    for (const hit of pageHits) { seen++; yield hit; }
  }
  // This can only be checked once the scroll is exhausted, so — unlike the
  // prior all-in-memory version — a genuinely incomplete scroll now leaves a
  // partial (and clearly invalid) snapshot on disk rather than failing
  // before any bytes are written. That trade is what makes the fetch
  // streamable at all; the downstream duplicate-hit check below still
  // catches any hit repeated within the scroll itself.
  if (expected === null || seen !== expected) throw new Error(`Incomplete PLD scroll: ${seen} hits, expected ${expected ?? 'unknown'}`);
}
async function* iterFixtureHits(path) {
  const text = await readFile(path, 'utf8');
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) { for (const value of JSON.parse(trimmed)) yield normaliseFixtureEntry(value); return; }
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) if (line.trim()) yield normaliseFixtureEntry(JSON.parse(line));
}
function normaliseFixtureEntry(value) { return value._source || value._id ? value : { _id: String(value.id), _source: value }; }

function createSchemaAccumulator() {
  const appFields = ['id', 'lpa_app_no', 'lpa_name', 'borough', 'bo_system', 'actual_commencement_date', 'actual_completion_date'];
  const unitFields = ['change_type', 'actual_commencement_date', 'actual_completion_date', 'unit_type', 'unit_development_type', 'tenure', 'phase_detail', 'superseded_date', 'superseded_by_lpa_app_no'];
  const esIdProfiler = createProfiler();
  const unitsFieldProfiler = createProfiler();
  const appProfilers = Object.fromEntries(appFields.map(field => [field, createProfiler()]));
  const unitProfilers = Object.fromEntries(unitFields.map(field => [field, createProfiler()]));
  const changeTypeCounts = new Map(), unitTypeCounts = new Map(), unitDevTypeCounts = new Map(), tenureCounts = new Map(), dateStatusCounts = new Map();
  const identifierConflicts = [];
  let anyMissingUnits = false, anyWrongTypeUnits = false;
  return {
    addHit(hit, application) {
      esIdProfiler.add(hit._id);
      for (const field of appFields) appProfilers[field].add(application[field]);
      const unitsValue = get(application, 'application_details.residential_details.residential_units');
      unitsFieldProfiler.add(unitsValue);
      if (unitsValue === undefined) anyMissingUnits = true;
      if (!Array.isArray(unitsValue)) anyWrongTypeUnits = true;
    },
    addApplicationRecord(appRecord) {
      if (appRecord.identifier_conflict) identifierConflicts.push({ application_id: appRecord.application_id, elasticsearch_id: appRecord.elasticsearch_id, source_id: appRecord.source_id, hit_id: appRecord.hit_id });
    },
    addFact(fact) {
      for (const field of unitFields) unitProfilers[field].add(rawFactValue(fact, field));
      bump(changeTypeCounts, fact.change_type_raw ?? '(missing)');
      bump(unitTypeCounts, fact.unit_type_raw ?? '(missing)');
      bump(unitDevTypeCounts, fact.unit_development_type_raw ?? '(missing)');
      bump(tenureCounts, fact.tenure_raw ?? '(missing)');
      for (const date of [fact.unit_commencement_date, fact.unit_completion_date, fact.root_commencement_date, fact.root_completion_date]) bump(dateStatusCounts, date.date_status);
    },
    finalize(hitCount, factCount) {
      const required = ['application_details.residential_details.residential_units'];
      const profile = { elasticsearch_id: esIdProfiler.finalize() };
      for (const field of appFields) profile[`application.${field}`] = appProfilers[field].finalize();
      profile['application_details.residential_details.residential_units'] = unitsFieldProfiler.finalize();
      for (const field of unitFields) profile[`residential_unit.${field}`] = unitProfilers[field].finalize();
      return { schema_version: SCHEMA_VERSION, applications_checked: hitCount, required_paths: required, missing_paths: anyMissingUnits ? required : [], wrong_container_types: anyWrongTypeUnits ? required : [], required_paths_valid: !anyMissingUnits && !anyWrongTypeUnits, unit_records: factCount, fields: profile, raw_change_type_values: sortedObject(changeTypeCounts), raw_unit_type_values: sortedObject(unitTypeCounts), raw_unit_development_type_values: sortedObject(unitDevTypeCounts), raw_tenure_values: sortedObject(tenureCounts), date_statuses: sortedObject(dateStatusCounts), application_identifier_conflicts: identifierConflicts };
    }
  };
}
function createProfiler() {
  let total = 0, missing = 0, nulls = 0;
  const types = new Map(), rawValues = new Map();
  return {
    add(value) {
      total++;
      if (value === undefined) { missing++; return; }
      if (value === null) { nulls++; return; }
      bump(types, Array.isArray(value) ? 'array' : typeof value);
      if (['string', 'number', 'boolean'].includes(typeof value)) bump(rawValues, String(value));
    },
    finalize() { return { observed_types: sortedObject(types), missing, nulls, populated: total - missing - nulls, raw_values: sortedObject(rawValues) }; }
  };
}
function rawFactValue(fact, field) { return ({ change_type: fact.change_type_raw, actual_commencement_date: fact.unit_commencement_date.raw_date, actual_completion_date: fact.unit_completion_date.raw_date, unit_type: fact.unit_type_raw, unit_development_type: fact.unit_development_type_raw, tenure: fact.tenure_raw, phase_detail: fact.phase_detail_raw, superseded_date: fact.superseded_date_raw, superseded_by_lpa_app_no: fact.superseded_by_lpa_app_no })[field]; }

function bump(map, key) { map.set(key, (map.get(key) || 0) + 1); }
function bumpBucket(target, key, reason) { target[key] ??= {}; target[key][reason] = (target[key][reason] || 0) + 1; }
function sortedObject(map) { return Object.fromEntries([...map].sort(([a], [b]) => String(a).localeCompare(String(b)))); }
function pairwiseEffects(variants) { const pairs = [['completion-date-all', 'unit-commencement-losses'], ['unit-commencement-losses', 'root-commencement-losses'], ['unit-commencement-losses', 'unit-root-fallback-losses']]; return pairs.map(([from, to]) => ({ from, to, by_financial_year: Object.fromEntries(Object.keys(variants[from]?.by_financial_year || {}).map(year => [year, (variants[to]?.by_financial_year?.[year]?.tested_variant_total || 0) - (variants[from]?.by_financial_year?.[year]?.tested_variant_total || 0)])) })); }
function glaBenchmarks() { return { '2019/20': 37843, '2020/21': 30703, '2021/22': 37524, '2022/23': 32053, '2023/24': 31629 }; }
function get(object, path) { return path.split('.').reduce((value, key) => value?.[key], object); }
function years(from, to) { return Array.from({ length: to - from + 1 }, (_, index) => `${from + index}/${String(from + index + 1).slice(-2)}`); }
function integerEnv(name, fallback) { const value = Number(process.env[name] ?? fallback); if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`); return value; }
function mostRecentCompletedYear() { const now = new Date(); return now.getUTCMonth() < 3 ? now.getUTCFullYear() - 2 : now.getUTCFullYear() - 1; }
async function writeJson(path, value) { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`); }
