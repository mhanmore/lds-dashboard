import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normaliseApplications, applyVariant, assemble, parsePldDate } from '../scripts/rebuild-lib.mjs';

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
assert.ok(unitOnly.exceptions.some(item => item.reason === 'missing_unit_commencement_date'));
const fallback = applyVariant(facts, 'unit-root-fallback-losses', 2019, 2021);
assert.equal(fallback.included.length, 3);
assert.equal(fallback.included.find(row => row.unit_no === 'L2').reporting_date_source, 'root_commencement');
const root = applyVariant(facts, 'root-commencement-losses', 2019, 2021);
assert.equal(root.included.filter(row => row.change_type === 'Loss').every(row => row.year === '2019/20'), true);
const assembled = assemble(fallback.included);
assert.equal(assembled.records.length, 3);
assert.equal(assembled.records.every(row => row.units_lp2021 === null), true);
assert.equal(assembled.annual_summary.find(row => row.authority === 'All London' && row.year === '2019/20').completions, -2);
console.log('Rebuild transformation tests passed.');
