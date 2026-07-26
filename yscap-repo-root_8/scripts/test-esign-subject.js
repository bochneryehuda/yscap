/**
 * Pure test for the DocuSign envelope SUBJECT-line address (owner-directed 2026-07-22:
 * the term-sheet invitation subject was "Your loan documents are ready to sign — Loan #NNN"
 * with NO property — impossible to tell which property when signing several a day).
 * Root cause: subjectAddress() only read oneLine/formatted_address/line1/… — a file whose
 * whole address sits under a single `address` (or `formatted`) key produced an EMPTY
 * string, so the suffix collapsed to just the loan number. No DB needed.
 *   node scripts/test-esign-subject.js
 */
const R = require('path').resolve(__dirname, '..');
const { subjectAddress, subjectSuffix, PACKAGES } = require(R + '/src/lib/esign/orchestrate');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// --- subjectAddress across every property_address shape the loaders can hand it ---
eq(subjectAddress(null), '', 'null app -> empty');
eq(subjectAddress({}), '', 'no address keys -> empty');
eq(subjectAddress({ addr_oneline: '12 Oak St, Newark, NJ 07104' }), '12 Oak St, Newark, NJ 07104', 'oneLine wins');
eq(subjectAddress({ addr_formatted: '12 Oak St, Newark, NJ 07104' }), '12 Oak St, Newark, NJ 07104', 'formatted_address used');
eq(subjectAddress({ addr_formatted2: '12 Oak St, Newark, NJ 07104' }), '12 Oak St, Newark, NJ 07104', 'ClickUp `formatted` key used');
eq(subjectAddress({ addr_scalar: '12 Oak St, Newark, NJ 07104' }), '12 Oak St, Newark, NJ 07104', 'scalar-string address used');
eq(subjectAddress({ addr_line1: '12 Oak St', addr_city: 'Newark', addr_state: 'NJ', addr_zip: '07104' }),
   '12 Oak St, Newark, NJ 07104', 'discrete parts compose');
eq(subjectAddress({ addr_line1: '12 Oak St', addr_unit: 'Apt 3', addr_city: 'Newark', addr_state: 'NJ', addr_zip: '07104' }),
   '12 Oak St Apt 3, Newark, NJ 07104', 'unit included');
// THE BUG CASE: the whole address under a single `address` key -> was empty, now returned.
eq(subjectAddress({ addr_address: '12 Oak St, Newark, NJ 07104' }), '12 Oak St, Newark, NJ 07104',
   '`address` one-liner (the reported bug) is no longer dropped');
// `address` holding just the street + separate city/state/zip -> composes.
eq(subjectAddress({ addr_address: '12 Oak St', addr_city: 'Newark', addr_state: 'NJ', addr_zip: '07104' }),
   '12 Oak St, Newark, NJ 07104', '`address` street + discrete city/state/zip compose');
// oneLine still wins over an `address` fallback.
eq(subjectAddress({ addr_oneline: '99 First Ave, NY, NY 10001', addr_address: '12 Oak St' }),
   '99 First Ave, NY, NY 10001', 'oneLine beats address fallback');

// --- subjectSuffix ---
eq(subjectSuffix('YSCAP258134746', ''), ' — Loan #YSCAP258134746', 'no address -> loan-only suffix (old behavior)');
eq(subjectSuffix('YSCAP258134746', '12 Oak St, Newark, NJ 07104'),
   ' — Loan #YSCAP258134746 · 12 Oak St, Newark, NJ 07104', 'loan + address suffix');
eq(subjectSuffix('', '12 Oak St'), ' — 12 Oak St', 'address-only suffix (no loan)');
eq(subjectSuffix('', ''), '', 'nothing -> empty suffix');

// --- the actual term-sheet package subject the borrower sees ---
const app = { ys_loan_number: 'YSCAP258134746', addr_address: '12 Oak St, Newark, NJ 07104' };
const subj = PACKAGES.term_sheet_package.subject(app.ys_loan_number, subjectAddress(app));
eq(subj, 'Your loan documents are ready to sign — Loan #YSCAP258134746 · 12 Oak St, Newark, NJ 07104',
   'term-sheet subject now carries the property');
ok(subj.includes('12 Oak St'), 'term-sheet subject includes the property address');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
