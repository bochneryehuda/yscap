/**
 * Encompass vesting: field 4008 (Officer / Individual), and 1859 goes N/A on an
 * individual-vested file (owner-directed 2026-08-05).
 *
 * "Encompass always needs to have field 4008. If this is vested on an LLC, then
 * field 4008 needs to say Officer, and if it's vested on the individual, then that
 * field needs to say Individual … once that field says Individual, you don't need
 * to map the LLC name anymore because there is no LLC name for the subject."
 *
 * PURE — no DB (buildOurValues + the field map are pure). In `npm test`.
 */
'use strict';
const assert = require('assert');
const map = require('../src/lib/integrations/encompass-field-map');
const { buildOurValues } = require('../src/encompass/reconcile');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// 1) Field 4008 is registered and read by number.
ok(map.allFieldIds().includes('4008'), 'field 4008 is in the registry (auto-read by the fieldReader)');
const e4008 = map.BY_KEY.vesting_title_role;
ok(!!e4008, 'vesting_title_role field exists');
ok(e4008 && e4008.encompassFieldId === '4008', 'vesting_title_role maps to Encompass field 4008');
ok(e4008 && e4008.naWhenOursMissing === true, 'vesting_title_role is N/A when our side is undecided');
ok(e4008 && e4008.blocksCtc === false, 'vesting_title_role never blocks (advisory, pull-only)');

// 2) vesting_llc (1859) now goes N/A when our side is blank (individual file).
const e1859 = map.BY_KEY.vesting_llc;
ok(e1859 && e1859.naWhenOursMissing === true, 'vesting_llc (1859) is flagged naWhenOursMissing');

// 3) The comparison of field 4008: Officer↔Officer match; Officer↔Individual mismatch;
//    officer synonyms all normalize to Officer.
const cmp = (our, enc) => map.compareField(e4008, our, enc).status;
ok(cmp('Officer', 'Officer') === 'match', '4008: Officer vs Officer → match');
ok(cmp('Individual', 'Individual') === 'match', '4008: Individual vs Individual → match');
ok(cmp('Officer', 'Individual') === 'mismatch', '4008: Officer vs Individual → mismatch (real disagreement surfaces here)');
ok(cmp('Officer', 'Managing Member') === 'match', '4008: an entity signer phrased "Managing Member" normalizes to Officer');
ok(cmp('Officer', 'Member') === 'match', '4008: "Member" → Officer');

// 4) An individual file's 1859: our side blank → incomparable + N/A (empty-string
//    ours is treated as missing, so the term-sheet gate skips it).
const c1859 = map.compareField(e1859, undefined, 'MW Trading LLC');
ok(c1859.status === 'incomparable', '1859 individual file: incomparable (no LLC on our side)');
const oursBlank = c1859.oursNorm === null || c1859.oursNorm === undefined || c1859.oursNorm === '';
ok(oursBlank, '1859 individual file: our normalized side is blank ("" for an entity compare)');
ok(c1859.naWhenOursMissing === true && oursBlank, '1859 individual file resolves to "Doesn\'t apply" (does not hold the term sheet)');

// 5) buildOurValues derives 4008 from the same signal as loan_to_be_vested — they
//    can never disagree.
const entity = buildOurValues({ llc_id: 'llc-1', borrower_id: 'b-1', program: '', loan_type: 'Purchase', lender: '' }, null, 'Acme Holdings LLC');
ok(entity.vesting_title_role === 'Officer', 'LLC-vested file → 4008 = Officer');
ok(entity.loan_to_be_vested === 'Entity', 'LLC-vested file → loan_to_be_vested = Entity (consistent)');
ok(entity.vesting_llc === 'Acme Holdings LLC', 'LLC-vested file → 1859 = the LLC name');

const indiv = buildOurValues({ llc_id: null, borrower_id: 'b-2', program: '', loan_type: 'Purchase', lender: '' }, null, null);
ok(indiv.vesting_title_role === 'Individual', 'individual-vested file → 4008 = Individual');
ok(indiv.loan_to_be_vested === 'Individual', 'individual-vested file → loan_to_be_vested = Individual (consistent)');
ok(indiv.vesting_llc === undefined || indiv.vesting_llc === null, 'individual-vested file → 1859 has no LLC name');

if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
console.log('\nAll Encompass vesting/4008 checks passed.');
