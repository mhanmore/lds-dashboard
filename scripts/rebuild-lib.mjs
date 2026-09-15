import { createHash } from 'node:crypto';

export const SCHEMA_VERSION = 4;
export const METHODOLOGY_VERSION = 1;
export const CATEGORY_MAPPING_VERSION = 'tenure-regex-v1';
export const SUPERSESSION_POLICY = 'retain-and-flag-v1';
export const VARIANTS = {
  'completion-date-all': { lossDate: 'unit_completion', gainFallback: false, lossFallback: false },
  'unit-commencement-losses': { lossDate: 'unit_commencement', gainFallback: false, lossFallback: false },
  'root-commencement-losses': { lossDate: 'root_commencement', gainFallback: true, lossFallback: false },
  'unit-root-fallback-losses': { lossDate: 'unit_commencement', gainFallback: true, lossFallback: true }
};

export function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
export function financialYear(date) {
  if (!date?.parsed_date) return null;
  const [year, month] = date.parsed_date.split('-').map(Number);
  const start = month < 4 ? year - 1 : year;
  return `${start}/${String(start + 1).slice(-2)}`;
}

// PLD normally uses dd/MM/yyyy. Alternatives are deliberately explicit so an
// unexpected value remains invalid rather than being guessed by Date.parse.
export function parsePldDate(raw) {
  if (raw === null || raw === undefined || raw === '') return { raw_date: raw ?? null, parsed_date: null, date_status: 'missing' };
  const text = String(raw).trim();
  let match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  let day, month, year;
  if (match) [, day, month, year] = match.map(Number);
  else {
    match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (match) [, year, month, day] = match.map(Number);
    else return { raw_date: raw, parsed_date: null, date_status: 'invalid_format' };
  }
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return { raw_date: raw, parsed_date: null, date_status: 'impossible_date' };
  return { raw_date: raw, parsed_date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, date_status: 'valid' };
}

export function normaliseApplications(hits) {
  const facts = [], exceptions = [], apps = [];
  for (const hit of hits) {
    const application = hit._source || hit;
    const applicationId = String(application.id || hit._id || 'missing-application-id');
    const rootCommencement = parsePldDate(application.actual_commencement_date);
    const rootCompletion = parsePldDate(application.actual_completion_date);
    const residential = application.application_details?.residential_details || {};
    const sourceUnits = Array.isArray(residential.residential_units) ? residential.residential_units : [];
    apps.push({ application_id: applicationId, elasticsearch_id: hit._id || null, lpa_app_no: application.lpa_app_no || null, lpa_name: application.lpa_name || null, borough: application.borough || null, unit_array_count: sourceUnits.length, total_no_existing_residential_units: residential.total_no_existing_residential_units ?? null, total_no_proposed_residential_units: residential.total_no_proposed_residential_units ?? null });
    sourceUnits.forEach((unit, position) => {
      const change = String(unit.change_type || '').trim();
      const unitCommencement = parsePldDate(unit.actual_commencement_date);
      const unitCompletion = parsePldDate(unit.actual_completion_date);
      const sourceRowKey = `${applicationId}:${position}:${sha256(JSON.stringify(unit))}`;
      const fact = {
        source_row_key: sourceRowKey, application_id: applicationId, elasticsearch_id: hit._id || null,
        lpa_app_no: application.lpa_app_no || null, lpa_name: application.lpa_name || null, borough: application.borough || null,
        address: address(application), uprn: application.uprn || null, bo_system: application.bo_system || null,
        application_development_type_raw: application.development_type || null, application_last_updated: application.last_updated || null,
        change_type_raw: unit.change_type ?? null, change_type: change === 'Gain' || change === 'Loss' ? change : null,
        unit_no: unit.unit_no ?? null, phase_detail_raw: unit.phase_detail ?? null,
        unit_type_raw: unit.unit_type ?? null, unit_development_type_raw: unit.unit_development_type ?? null,
        tenure_raw: unit.tenure ?? null, provider_raw: unit.provider ?? null,
        unit_commencement_date: unitCommencement, unit_completion_date: unitCompletion,
        root_commencement_date: rootCommencement, root_completion_date: rootCompletion,
        superseded_date_raw: unit.superseded_date ?? null, superseded_by_lpa_app_no: unit.superseded_by_lpa_app_no ?? null,
        application_superseding_details: application.application_details?.superseding_details || []
      };
      facts.push(fact);
      if (!fact.change_type) exceptions.push({ source_row_key: sourceRowKey, reason: change ? 'unrecognised_change_type' : 'missing_change_type', value: unit.change_type ?? null });
      for (const [name, parsed] of [['unit_commencement', unitCommencement], ['unit_completion', unitCompletion], ['root_commencement', rootCommencement], ['root_completion', rootCompletion]]) if (parsed.date_status.startsWith('invalid') || parsed.date_status === 'impossible_date') exceptions.push({ source_row_key: sourceRowKey, reason: `${name}_${parsed.date_status}`, value: parsed.raw_date });
    });
  }
  return { applications: apps, facts, exceptions };
}

export function applyVariant(facts, variantId, firstYear, lastYear) {
  const variant = VARIANTS[variantId];
  if (!variant) throw new Error(`Unknown methodology variant: ${variantId}`);
  const included = [], exceptions = [];
  for (const fact of facts) {
    if (!fact.change_type) { exceptions.push({ ...exception(fact, 'unrecognised_or_missing_change_type') }); continue; }
    const selected = selectDate(fact, variant);
    if (!selected.date?.parsed_date) { exceptions.push({ ...exception(fact, selected.reason), reporting_date_source: selected.source }); continue; }
    const year = financialYear(selected.date);
    if (yearStart(year) < firstYear || yearStart(year) > lastYear) continue;
    included.push({ ...fact, year, units: fact.change_type === 'Loss' ? -1 : 1, reporting_date: selected.date.parsed_date, reporting_date_source: selected.source, fallback_reason: selected.fallback_reason || null, affordability: affordability(fact.tenure_raw), dwelling_type: dwellingType(fact.unit_type_raw), inferred_use_class: inferredUseClass(fact.unit_type_raw), supersession_status: supersessionStatus(fact) });
  }
  return { included, exceptions };
}

function selectDate(fact, variant) {
  if (fact.change_type === 'Gain') {
    if (fact.unit_completion_date.parsed_date) return { date: fact.unit_completion_date, source: 'unit_completion' };
    if (variant.gainFallback && fact.root_completion_date.parsed_date) return { date: fact.root_completion_date, source: 'root_completion', fallback_reason: 'missing_unit_completion' };
    return { date: null, source: null, reason: 'missing_gain_completion_date' };
  }
  if (variant.lossDate === 'unit_completion') return fact.unit_completion_date.parsed_date ? { date: fact.unit_completion_date, source: 'unit_completion' } : { date: null, reason: 'missing_loss_completion_date' };
  if (variant.lossDate === 'root_commencement') return fact.root_commencement_date.parsed_date ? { date: fact.root_commencement_date, source: 'root_commencement' } : { date: null, reason: 'missing_root_commencement_date' };
  if (fact.unit_commencement_date.parsed_date) return { date: fact.unit_commencement_date, source: 'unit_commencement' };
  if (variant.lossFallback && fact.root_commencement_date.parsed_date) return { date: fact.root_commencement_date, source: 'root_commencement', fallback_reason: 'missing_unit_commencement' };
  return { date: null, reason: 'missing_unit_commencement_date' };
}

export function assemble(rows) {
  const summaries = new Map(), details = new Map();
  for (const row of rows) {
    for (const authority of [row.lpa_name || 'Unallocated', 'All London']) addSummary(summaries, authority, row);
    // Application identity is intentionally part of the browser-detail key.
    const key = [row.application_id, row.source_row_key, row.year].join('\0');
    details.set(key, { source_row_key: row.source_row_key, application_id: row.application_id, lpa_app_no: row.lpa_app_no, authority: row.lpa_name || 'Unallocated', borough: row.borough || null, address: row.address, year: row.year, units: row.units, units_lp2021: null, reporting_date: row.reporting_date, reporting_date_source: row.reporting_date_source, change_type: row.change_type, phase_detail: row.phase_detail_raw, affordability: row.affordability, dwelling_type: row.dwelling_type, use_class: row.inferred_use_class, tenure_raw: row.tenure_raw, unit_type_raw: row.unit_type_raw, unit_development_type_raw: row.unit_development_type_raw, supersession_status: row.supersession_status });
  }
  return { annual_summary: [...summaries.values()].sort(compareSummary), records: [...details.values()].sort(compareDetail) };
}

function addSummary(map, authority, row) {
  const key = `${authority}\0${row.year}`;
  if (!map.has(key)) map.set(key, { authority, year: row.year, completions: 0, target: authority === 'All London' ? target(row.year) : null, affordability: {}, dwelling_type: {}, use_class: {}, cube: {} });
  const bucket = map.get(key); bucket.completions += row.units;
  add(bucket.affordability, row.affordability, row.units); add(bucket.dwelling_type, row.dwelling_type, row.units); add(bucket.use_class, row.inferred_use_class, row.units);
  const a = bucket.cube[row.affordability] ||= {}; const d = a[row.dwelling_type] ||= {}; add(d, row.inferred_use_class, row.units);
}
function add(object, key, value) { object[key] = (object[key] || 0) + value; }
function exception(fact, reason) { return { source_row_key: fact.source_row_key, application_id: fact.application_id, reason }; }
function address(app) { return [app.site_name, app.site_number, app.street_name, app.secondary_street_name, app.locality, app.postcode].filter(Boolean).join(', ') || 'Address not recorded'; }
function yearStart(year) { return Number(year.slice(0, 4)); }
function target(year) { return year >= '2021/22' ? 52287 : 42388; }
function affordability(tenure) { if (!tenure || /not known|unknown/i.test(tenure)) return 'Not known'; if (/not applicable|n\/a/i.test(tenure)) return 'n/a'; return /affordable|social|shared|living rent|intermediate/i.test(tenure) ? 'Affordable' : /market/i.test(tenure) ? 'Market' : String(tenure); }
function dwellingType(value) { const type = String(value || '').trim(); if (!type) return 'Other'; if (/^hmo$/i.test(type)) return 'C4 small HMO'; if (/^flat apartment maisonette$/i.test(type)) return 'Flat Apartment Maisonette'; if (/^studio bedsit$/i.test(type)) return 'Studio Bedsit'; if (/^house$/i.test(type)) return 'House or Bungalow'; return type; }
function inferredUseClass(value) { const type = String(value || ''); if (/C4|HMO/i.test(type)) return 'C4 small HMO'; if (/student|co living|communal|other/i.test(type)) return 'Other residential'; return type ? 'C3 dwelling' : 'Not known'; }
function supersessionStatus(fact) { return fact.superseded_date_raw || fact.superseded_by_lpa_app_no || fact.application_superseding_details.length ? 'flagged' : 'not_flagged'; }
function compareSummary(a, b) { return a.year.localeCompare(b.year) || a.authority.localeCompare(b.authority); }
function compareDetail(a, b) { return a.year.localeCompare(b.year) || a.authority.localeCompare(b.authority) || a.application_id.localeCompare(b.application_id) || a.source_row_key.localeCompare(b.source_row_key); }
