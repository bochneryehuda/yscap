/* THE STUCK ASSIGNMENT FEE (owner-reported 2026-08-10, YSCAP258134769 / 54
 * Avenue C): an assignment fee removed from a file kept showing on the
 * Encompass comparison as "$7,500 / No data to compare", forever.
 *
 * The loop this pins closed:
 *   1. The details door clears assignment_fee + underlying_contract_price and
 *      pushes the assignment CHECKBOX off — but the card's two CURRENCY fields
 *      can never be cleared by the push (the no-wipe guard skips empty values),
 *      so ClickUp kept holding 7500 / 75000.
 *   2. Every inbound pull wrote them back over the file's deliberate NULL via
 *      its COALESCE — invisibly, because the inbound change audit skips
 *      null→value fills.
 *   3. reconcile read applications.assignment_fee unconditionally, so the panel
 *      claimed a fee on a deal that has none, against an empty Encompass side.
 *
 * Three fixes, each asserted here:
 *   A. reconcile.buildOurValues — a non-assignment file's fee is ZERO (a real
 *      statement), and its contract price is simply the purchase price; an
 *      assignment file is byte-identical to before.
 *   B. compareField('assignment_fee', …) — our 0 meets Encompass blank/0
 *      through the entry's own zeroMeansNone and MATCHES; a real Encompass fee
 *      against our 0 is an honest MISMATCH; a REAL assignment whose fee is
 *      missing in Encompass still reads "no data" (unchanged — that hold is
 *      correct).
 *   C. ingest.dropAssignmentMoneyWithoutCheckbox — a card whose assignment
 *      checkbox is not ticked cannot assert assignment money (decline to
 *      import, never clear), plus a source guard that the pull actually calls
 *      it before the COALESCE UPDATE/INSERT cols are read.
 *
 * Pure — no DB / no network. Run: node scripts/test-assignment-fee-stale-pure.js
 */
const path = require('path');
const fs = require('fs');
const { buildOurValues } = require('../src/encompass/reconcile');
const map = require('../src/lib/integrations/encompass-field-map');
const { dropAssignmentMoneyWithoutCheckbox } = require('../src/clickup/ingest');

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else { fail++; console.log(`FAIL ${name} — got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
};

// ── A. buildOurValues gates the assignment money on is_assignment ───────────
// The owner's exact file: not an assignment, stale 7500/75000 still in the columns.
const stale = buildOurValues({
  is_assignment: false, assignment_fee: '7500.00', underlying_contract_price: '75000.00',
  purchase_price: '75000.00', loan_type: 'Purchase', program: 'Fix & Flip w/ Construction',
}, {}, null);
eq('A1 non-assignment + stale fee → fee reads 0, never the leftover', stale.assignment_fee, 0);
eq('A2 non-assignment + stale underlying → contract price is the purchase price', stale.contract_price, '75000.00');

const realAsg = buildOurValues({
  is_assignment: true, assignment_fee: '7500.00', underlying_contract_price: '75000.00',
  purchase_price: '82500.00', loan_type: 'Purchase',
}, {}, null);
eq('A3 real assignment → fee unchanged', realAsg.assignment_fee, '7500.00');
eq('A4 real assignment → contract price is the underlying', realAsg.contract_price, '75000.00');

const asgNoFee = buildOurValues({ is_assignment: true, assignment_fee: null, purchase_price: '82500.00' }, {}, null);
eq('A5 real assignment with no fee entered → undefined (enter it), never a fabricated 0', asgNoFee.assignment_fee, undefined);

const clean = buildOurValues({ is_assignment: false, assignment_fee: null, underlying_contract_price: null, purchase_price: '75000.00' }, {}, null);
eq('A6 clean non-assignment → fee 0', clean.assignment_fee, 0);
eq('A7 clean non-assignment → contract price falls back to purchase price', clean.contract_price, '75000.00');

// ── B. the compare: 0 vs Encompass blank/0/real-fee ─────────────────────────
eq('B1 our 0 vs Encompass BLANK → MATCH (zeroMeansNone), not "no data to compare"',
  map.compareField('assignment_fee', 0, '').status, 'match');
eq('B2 our 0 vs Encompass 0 → MATCH', map.compareField('assignment_fee', 0, 0).status, 'match');
eq('B3 our 0 vs a REAL Encompass fee → honest MISMATCH, never hidden',
  map.compareField('assignment_fee', 0, 7500).status, 'mismatch');
eq('B4 a real assignment fee missing in Encompass still reads no-data (unchanged hold)',
  map.compareField('assignment_fee', 7500, '').status, 'incomparable');
eq('B5 matching fees on a real assignment still MATCH', map.compareField('assignment_fee', 7500, 7500).status, 'match');

// ── C. the pull: assignment money travels WITH its checkbox ─────────────────
const offCard = dropAssignmentMoneyWithoutCheckbox({ is_assignment: false, assignment_fee: 7500, underlying_contract_price: 75000, loan_amount: 145831 });
eq('C1 checkbox OFF → fee declined (null → COALESCE keeps the file value)', offCard.assignment_fee, null);
eq('C2 checkbox OFF → underlying declined', offCard.underlying_contract_price, null);
eq('C3 checkbox OFF → other columns untouched', offCard.loan_amount, 145831);

const noBox = dropAssignmentMoneyWithoutCheckbox({ assignment_fee: 7500, underlying_contract_price: 75000 });
eq('C4 checkbox ABSENT from the pull → money declined too (never loose numbers)', noBox.assignment_fee, null);

const onCard = dropAssignmentMoneyWithoutCheckbox({ is_assignment: true, assignment_fee: 7500, underlying_contract_price: 75000 });
eq('C5 checkbox ON → fee imports exactly as before', onCard.assignment_fee, 7500);
eq('C6 checkbox ON → underlying imports', onCard.underlying_contract_price, 75000);

const bare = dropAssignmentMoneyWithoutCheckbox({ is_assignment: false, loan_amount: 100 });
eq('C7 no money keys on the pull → none invented', Object.keys(bare).sort(), ['is_assignment', 'loan_amount']);
eq('C8 null cols → safe no-op', dropAssignmentMoneyWithoutCheckbox(null), null);

// ── C9. source guard: the pull actually CALLS the guard before the COALESCE
// cols are read — reverting the wiring while the pure function survives must
// fail this suite (the repo's established wiring-guard idiom).
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'clickup', 'ingest.js'), 'utf8');
const callAt = src.indexOf('dropAssignmentMoneyWithoutCheckbox(cols);');
const valsAt = src.indexOf('const vals = Object.values(cols);');
eq('C9 ingest calls the guard before the UPDATE/INSERT cols are read', callAt > 0 && valsAt > 0 && callAt < valsAt, true);

// ── D. the owner's whole story, end to end (pure halves composed) ───────────
// The card today: checkbox unset, fee 7500, underlying 75000. The pull declines
// both; the healed row then compares clean against Encompass's empty CX field.
const pulled = dropAssignmentMoneyWithoutCheckbox({ is_assignment: false, assignment_fee: 7500, underlying_contract_price: 75000 });
eq('D1 the pull no longer re-imports the removed fee', pulled.assignment_fee, null);
const healedRow = buildOurValues({ is_assignment: false, assignment_fee: null, underlying_contract_price: null, purchase_price: '75000.00' }, {}, null);
eq('D2 the healed file compares MATCH against Encompass\'s empty fee field',
  map.compareField('assignment_fee', healedRow.assignment_fee, '').status, 'match');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
