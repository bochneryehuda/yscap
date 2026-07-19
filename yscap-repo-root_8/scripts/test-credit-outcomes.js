/* Unit tests for src/lib/credit/outcomes.js (error/outcome catalog). Pure, no DB.
 * Run: node scripts/test-credit-outcomes.js */
const O = require('../src/lib/credit/outcomes');

let pass = 0, fail = 0;
const eq = (n, g, e) => { if (JSON.stringify(g) === JSON.stringify(e)) pass++; else { fail++; console.log(`FAIL ${n}: got ${JSON.stringify(g)} exp ${JSON.stringify(e)}`); } };
const ok = (n, c) => { if (c) pass++; else { fail++; console.log(`FAIL ${n}`); } };

// outcomeForCode
eq('E037 -> bad_password block ops', [O.outcomeForCode('E037').key, O.outcomeForCode('E037').severity, O.outcomeForCode('E037').owner], ['bad_password', 'block', 'ops']);
eq('E051 account inactive', O.outcomeForCode('E051').key, 'account_inactive');
eq('E061 reissue mismatch', O.outcomeForCode('E061').key, 'reissue_mismatch');
eq('E101 malformed', O.outcomeForCode('E101').key, 'malformed_request');
eq('E103 duplicate_recent', O.outcomeForCode('E103').key, 'duplicate_recent');
ok('E103 not billable (Xactus no-charge dedupe)', O.outcomeForCode('E103').billable === false);
eq('E004 in data range -> bad_input', O.outcomeForCode('E004').key, 'bad_input');
eq('E031 upper bound data', O.outcomeForCode('E031').key, 'bad_input');
eq('E032 not data range', O.outcomeForCode('E032'), null);
eq('unknown code -> null', O.outcomeForCode('ZZZ'), null);
ok('bad_password not billable', O.outcomeForCode('E037').billable === false);

// conditionFromText
eq('frozen text', O.conditionFromText('Consumer credit file is FROZEN'), 'frozen');
eq('deceased text', O.conditionFromText('Deceased indicator present'), 'deceased');
eq('fraud text', O.conditionFromText('Security alert / fraud victim'), 'fraud');
eq('ofac text', O.conditionFromText('Possible OFAC/SDN match'), 'ofac');
eq('no-hit text', O.conditionFromText('No record found for this SSN'), 'no_hit');
eq('no-score text', O.conditionFromText('Insufficient credit to generate a score'), 'no_score');
eq('mixed text', O.conditionFromText('File may belong to a different person'), 'mixed_file');
eq('unknown text', O.conditionFromText('all good here'), null);

// describeError: code wins, then text, then generic
eq('describe by code', O.describeError({ code: 'E046' }).key, 'bad_login');
eq('describe by text', O.describeError({ code: null, description: 'file frozen' }).key, 'frozen');
ok('describe generic fallback billable', O.describeError({ code: null, description: 'weird bureau thing' }).key === 'vendor_error');

// summarizeOutcome: builds a reason + severity + owners
const parsed = { errors: [{ code: null, description: 'TransUnion file frozen' }], repositoriesReturned: { equifax: true, experian: true, transunion: true } };
const scored = { perBorrower: [{ reportBorrowerId: 'B1', identity: { firstName: 'Ann' }, middle: { noScore: false, classified: [
  { bureau: 'Equifax', usable: true, value: 700, reason: 'ok' },
  { bureau: 'Experian', usable: true, value: 705, reason: 'ok' },
  { bureau: 'TransUnion', usable: false, reason: 'excluded', exclusionReason: 'file frozen' },
] } }] };
const sum = O.summarizeOutcome(parsed, scored);
ok('summary mentions frozen + thaw', /thaw|frozen/i.test(sum.reason));
eq('summary severity partial (frozen)', sum.severity, 'partial');
ok('summary owner borrower', sum.owners.includes('borrower'));

// no-score bumps to review
const scored2 = { perBorrower: [{ reportBorrowerId: 'C1', identity: { firstName: 'Bob' }, middle: { noScore: true, classified: [] } }] };
eq('no-score -> review severity', O.summarizeOutcome({ errors: [] }, scored2).severity, 'review');

// a VALID file (usable middle) with a leftover excluded/empty score node must NOT
// review — the borrower has a real middle; leftover nodes are noise (the live 3.4
// batch caught valid files reviewing because of duplicate/non-mortgage nodes).
const scored3 = { perBorrower: [{ reportBorrowerId: 'B1', identity: { firstName: 'Val' }, middle: { noScore: false, middle: 689, classified: [
  { bureau: 'Equifax', usable: true, value: 693, reason: 'ok' },
  { bureau: 'Experian', usable: true, value: 688, reason: 'ok' },
  { bureau: 'TransUnion', usable: true, value: 689, reason: 'ok' },
  { bureau: 'Equifax', usable: false, value: null, reason: 'excluded', exclusionReason: '' },   // leftover empty node
] } }] };
const vsum = O.summarizeOutcome({ errors: [] }, scored3);
eq('valid file w/ leftover node -> not review', vsum.severity, 'info');
eq('valid file -> empty reason', vsum.reason, '');

// bureauStatus: N of 3
const bs = O.bureauStatus(parsed, scored);
eq('2 of 3 scored', bs.scoredCount, 2);
eq('equifax scored', bs.perBureau.equifax, 'scored');
eq('transunion excluded', bs.perBureau.transunion, 'excluded');
eq('requested 3', bs.requested, 3);

console.log(`\ncredit-outcomes: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
