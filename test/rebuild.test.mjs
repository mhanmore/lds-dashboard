import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normaliseApplications, applyVariant, assemble, parsePldDate, sourceApplicationIdentity } from '../scripts/rebuild-lib.mjs';

const hits = JSON.parse(await readFile(new URL('./fixtures/rebuild-applications.json', import.meta.url)));
const { facts, exceptions } = normaliseApplications(hits);
assert.equal(facts.length, 4);
assert.equal(facts[0].application_id, 'app-1');
assert.equal(facts[0].lpa_app_no, 'A/1');
assert.equal(facts[0].borough, 'Example Borough');
assert.equal(parsePldDate('31/02/2021').date_status, 'impossible_date');
assert.ok(exceptions.some(item => item.reason === 'unit_completion_impossible_date'));
const unitOnly = applyVariant(facts, 'unit-commencement-losses', 2019, 2021);
assert.equal(unitOnly.included.length, 2); // gain 2021/22 and dated loss 2019/20
assert.ok(unitOnly.exceptions.some(item => item.reason === 'missing_required_reporting_date' && item.date_reason === 'missing_unit_commencement_date'));
const fallback = applyVariant(facts, 'unit-root-fallback-losses', 2019, 2021);
assert.equal(fallback.included.length, 3);
assert.equal(fallback.included.find(row => row.unit_no === 'L2').reporting_date_source, 'root_commencement');
const root = applyVariant(facts, 'root-commencement-losses', 2019, 2021);
assert.equal(root.included.filter(row => row.change_type === 'Loss').every(row => row.year === '2019/20'), true);
const assembled = assemble(fallback.included);
assert.equal(assembled.records.length, 3);
assert.equal(assembled.records.every(row => row.units_lp2021 === null), true);
assert.equal(assembled.annual_summary.find(row => row.authority === 'All London' && row.year === '2019/20').completions, -2);
assert.equal(unitOnly.dispositions.length, facts.length);
assert.equal(new Set(unitOnly.dispositions.map(item => item.source_row_key)).size, facts.length);
assert.ok(unitOnly.dispositions.some(item => item.reason === 'unrecognised_change_type'));

// The canonical ID is source id when present, but disagreement remains visible.
const identity = sourceApplicationIdentity({ _id: 'elastic-1', _source: { id: 'pld-1' } });
assert.equal(identity.application_id, 'pld-1');
assert.equal(identity.conflicting_identifiers, true);
const sourceOnly = normaliseApplications([{ _source: { id: 'source-only', application_details: { residential_details: { residential_units: [{ change_type: 'Gain', actual_completion_date: '2020-04-01' }] } } } }]);
assert.equal(sourceOnly.facts[0].application_id, 'source-only');

// Valid facts outside the requested window are accounted for, never dropped.
const outside = applyVariant(sourceOnly.facts, 'completion-date-all', 2019, 2019);
assert.equal(outside.included.length, 0);
assert.equal(outside.dispositions[0].reason, 'valid_reporting_date_outside_requested_window');
console.log('Rebuild transformation tests passed.');
