import { createHash } from 'node:crypto';

export const SCHEMA_VERSION = 4;
export const METHODOLOGY_VERSION = 1;
export const CATEGORY_MAPPING_VERSION = 'category-rules-v2';
export const SUPERSESSION_POLICY = 'retain-and-flag-v1';
export const VARIANTS = {
  'completion-date-all': { lossDate: 'unit_completion', gainFallback: false, lossFallback: false },
  'unit-commencement-losses': { lossDate: 'unit_commencement', gainFallback: false, lossFallback: false },
  'root-commencement-losses': { lossDate: 'root_commencement', gainFallback: true, lossFallback: false },
  'unit-root-fallback-losses': { lossDate: 'unit_commencement', gainFallback: true, lossFallback: true }
};

// This is deliberately data, rather than an implicit contract hidden in the
// classifiers below. Raw source values are retained on every fact.
export const CATEGORY_RULES = {
  affordability: [
    { label: 'Not known', pattern: 'not known|unknown' },
    { label: 'n/a', pattern: 'not applicable|n/a' },
    { label: 'Affordable', pattern: 'affordable|social|shared|living rent|intermediate' },
    { label: 'Market', pattern: 'market' }
  ],
  dwelling_type: [
    { label: 'C4 small HMO', exact: 'hmo' },
    { label: 'Flat Apartment Maisonette', exact: 'flat apartment maisonette' },
    { label: 'Studio Bedsit', exact: 'studio bedsit' },
    { label: 'House or Bungalow', exact: 'house' }
  ],
  use_class: [
    { label: 'C4 small HMO', pattern: '\\bc4\\b|\\bhmo\\b', evidence: 'unit_type or unit_development_type' },
    { label: 'Other residential', pattern: 'student|co[ -]?living|communal', evidence: 'unit_type or unit_development_type' },
    { label: 'C3 dwelling', pattern: '^house$|flat apartment maisonette|studio bedsit|^flat$|^apartment$|^maisonette$', evidence: 'unit_type' }
  ]
};

export function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
export function sourceApplicationIdentity(hit) {
  const source = hit?._source || hit || {};
  const elasticsearchId = nullable(hit?._id);
  const sourceId = nullable(source.id);
  // A bare application object can have id at its root; preserve it separately
  // only when it is not the same field as _source.id.
  const hitId = hit?._source ? nullable(hit?.id) : null;
  const candidates = [sourceId, elasticsearchId, hitId].filter(Boolean);
  return {
    application_id: sourceId || elasticsearchId || hitId || null,
    elasticsearch_id: elasticsearchId,
    source_id: sourceId,
    hit_id: hitId,
    conflicting_identifiers: [...new Set(candidates)].length > 1,
    identifiers: { elasticsearch_id: elasticsearchId, source_id: sourceId, hit_id: hitId }
  };
}
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
    const identity = sourceApplicationIdentity(hit);
    if (!identity.application_id) throw new Error('Source hit has no application identifier');
    const applicationId = identity.application_id;
    const rootCommencement = parsePldDate(application.actual_commencement_date);
    const rootCompletion = parsePldDate(application.actual_completion_date);
    const residential = application.application_details?.residential_details || {};
    const sourceUnits = Array.isArray(residential.residential_units) ? residential.residential_units : [];
    apps.push({ application_id: applicationId, elasticsearch_id: identity.elasticsearch_id, source_id: identity.source_id, hit_id: identity.hit_id, identifier_conflict: identity.conflicting_identifiers, lpa_app_no: application.lpa_app_no || null, lpa_name: application.lpa_name || null, borough: application.borough || null, unit_array_count: sourceUnits.length, total_no_existing_residential_units: residential.total_no_existing_residential_units ?? null, total_no_proposed_residential_units: residential.total_no_proposed_residential_units ?? null });
    sourceUnits.forEach((unit, position) => {
      const change = String(unit.change_type || '').trim();
      const unitCommencement = parsePldDate(unit.actual_commencement_date);
      const unitCompletion = parsePldDate(unit.actual_completion_date);
      const sourceRowKey = `${applicationId}:${position}:${sha256(JSON.stringify(unit))}`;
      const fact = {
        // Snapshot source-row identity: deterministic only for this frozen
        // payload; it is not a longitudinal PLD unit identifier.
        source_row_key: sourceRowKey, application_id: applicationId, elasticsearch_id: identity.elasticsearch_id, source_id: identity.source_id, hit_id: identity.hit_id,
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
  const included = [], exceptions = [], dispositions = [];
  for (const fact of facts) {
    if (!fact.change_type) {
      const reason = fact.change_type_raw == null || !String(fact.change_type_raw).trim() ? 'missing_change_type' : 'unrecognised_change_type';
      const item = { ...exception(fact, reason) }; exceptions.push(item); dispositions.push(item); continue;
    }
    const selected = selectDate(fact, variant);
    if (!selected.date?.parsed_date) {
      const reason = selected.invalid ? 'invalid_required_reporting_date' : 'missing_required_reporting_date';
      const item = { ...exception(fact, reason), reporting_date_source: selected.source || null, date_reason: selected.reason }; exceptions.push(item); dispositions.push(item); continue;
    }
    const year = financialYear(selected.date);
    if (yearStart(year) < firstYear || yearStart(year) > lastYear) { dispositions.push({ ...exception(fact, 'valid_reporting_date_outside_requested_window'), reporting_date: selected.date.parsed_date, reporting_date_source: selected.source, year }); continue; }
    const row = { ...fact, year, units: fact.change_type === 'Loss' ? -1 : 1, reporting_date: selected.date.parsed_date, reporting_date_source: selected.source, fallback_reason: selected.fallback_reason || null, affordability: affordability(fact.tenure_raw), dwelling_type: dwellingType(fact.unit_type_raw), inferred_use_class: inferredUseClass(fact.unit_type_raw, fact.unit_development_type_raw), supersession_status: supersessionStatus(fact) };
    included.push(row); dispositions.push({ ...exception(fact, 'included_in_requested_window'), year, reporting_date_source: selected.source });
  }
  return { included, exceptions, dispositions };
}

function selectDate(fact, variant) {
  if (fact.change_type === 'Gain') {
    if (fact.unit_completion_date.parsed_date) return { date: fact.unit_completion_date, source: 'unit_completion' };
    if (variant.gainFallback && fact.root_completion_date.parsed_date) return { date: fact.root_completion_date, source: 'root_completion', fallback_reason: 'missing_unit_completion' };
    return unusableDate(fact.unit_completion_date, 'unit_completion', 'missing_gain_completion_date');
  }
  if (variant.lossDate === 'unit_completion') return fact.unit_completion_date.parsed_date ? { date: fact.unit_completion_date, source: 'unit_completion' } : unusableDate(fact.unit_completion_date, 'unit_completion', 'missing_loss_completion_date');
  if (variant.lossDate === 'root_commencement') return fact.root_commencement_date.parsed_date ? { date: fact.root_commencement_date, source: 'root_commencement' } : unusableDate(fact.root_commencement_date, 'root_commencement', 'missing_root_commencement_date');
  if (fact.unit_commencement_date.parsed_date) return { date: fact.unit_commencement_date, source: 'unit_commencement' };
  if (variant.lossFallback && fact.root_commencement_date.parsed_date) return { date: fact.root_commencement_date, source: 'root_commencement', fallback_reason: 'missing_unit_commencement' };
  return unusableDate(fact.unit_commencement_date, 'unit_commencement', 'missing_unit_commencement_date');
}
function unusableDate(date, source, reason) { return { date: null, source, reason, invalid: Boolean(date && date.date_status !== 'missing') }; }

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
function exception(fact, reason) { return { source_row_key: fact.source_row_key, application_id: fact.application_id, authority: fact.lpa_name || 'Unallocated', change_type: fact.change_type || null, reason }; }
function address(app) { return [app.site_name, app.site_number, app.street_name, app.secondary_street_name, app.locality, app.postcode].filter(Boolean).join(', ') || 'Address not recorded'; }
function yearStart(year) { return Number(year.slice(0, 4)); }
function target(year) { return year >= '2021/22' ? 52287 : 42388; }
function affordability(tenure) { return classify(tenure, CATEGORY_RULES.affordability, tenure ? String(tenure) : 'Not known'); }
function dwellingType(value) { return classify(value, CATEGORY_RULES.dwelling_type, value ? String(value).trim() : 'Other', true); }
function inferredUseClass(unitType, developmentType) { const unit = String(unitType || '').trim(); const combined = [unit, developmentType].filter(Boolean).join(' '); for (const rule of CATEGORY_RULES.use_class) { const subject = rule.evidence === 'unit_type' ? unit : combined; if (new RegExp(rule.pattern, 'i').test(subject)) return rule.label; } return combined ? 'Other residential' : 'Not known'; }
function classify(value, rules, fallback, exact = false) { const text = String(value || '').trim(); for (const rule of rules) { if (exact ? text.toLowerCase() === rule.exact : new RegExp(rule.pattern, 'i').test(text)) return rule.label; } return fallback; }
function supersessionStatus(fact) { return fact.superseded_date_raw || fact.superseded_by_lpa_app_no || fact.application_superseding_details.length ? 'flagged' : 'not_flagged'; }
function nullable(value) { return value === null || value === undefined || String(value).trim() === '' ? null : String(value); }
function compareSummary(a, b) { return a.year.localeCompare(b.year) || a.authority.localeCompare(b.authority); }
function compareDetail(a, b) { return a.year.localeCompare(b.year) || a.authority.localeCompare(b.authority) || a.application_id.localeCompare(b.application_id) || a.source_row_key.localeCompare(b.source_row_key); }
