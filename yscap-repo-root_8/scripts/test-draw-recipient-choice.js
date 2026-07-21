/* Draw-send recipient choice (owner-directed 2026-07-21): the DocuSign wire form (a soloBorrower package)
 * can be sent to the borrower (default) OR the co-borrower; multi-signer packages (term sheet) are unchanged.
 * This exercises the PURE roster builder (no DB, no network) — the one place the choice takes effect.
 * Run: node scripts/test-draw-recipient-choice.js
 */
const orch = require('../src/lib/esign/orchestrate');
const buildRoster = orch.buildRoster;

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('FAIL ' + n); } };

if (typeof buildRoster !== 'function') { console.log('FAIL buildRoster not exported'); process.exit(1); }

const app = {
  b_id: 'B1', b_first: 'Moshe', b_last: 'Spitzer', b_email: 'moshe@example.com',
  cb_id: 'C1', cb_first: 'Sarah', cb_last: 'Spitzer', cb_email: 'sarah@example.com',
  co_borrower_id: 'C1',
};
const soloSpec = { soloBorrower: true, countersignRequired: false };
const dualSpec = { soloBorrower: false, countersignRequired: false };

// 1) SOLO, default → the PRIMARY borrower is the single signer
{ const r = buildRoster(app, soloSpec, 'env1');
  ok('1 solo default: one signer', r.length === 1);
  ok('1 solo default: is borrower', r[0].email === 'moshe@example.com' && r[0].role === 'borrower' && r[0].borrowerId === 'B1'); }

// 2) SOLO, recipient=co_borrower → the CO-BORROWER is the single signer (identity swapped, still role 'borrower')
{ const r = buildRoster(app, soloSpec, 'env2', { recipient: 'co_borrower' });
  ok('2 solo→co: one signer', r.length === 1);
  ok('2 solo→co: is co-borrower', r[0].email === 'sarah@example.com' && r[0].borrowerId === 'C1' && r[0].role === 'borrower'); }

// 3) SOLO, recipient=co_borrower but NO co-borrower on file → falls back to the primary borrower (never empty)
{ const solo = { ...app, cb_id: null, cb_first: null, cb_last: null, cb_email: null, co_borrower_id: null };
  const r = buildRoster(solo, soloSpec, 'env3', { recipient: 'co_borrower' });
  ok('3 solo→co w/o co: falls back to borrower', r.length === 1 && r[0].email === 'moshe@example.com'); }

// 4) SOLO, recipient='borrower' explicit → primary borrower (same as default)
{ const r = buildRoster(app, soloSpec, 'env4', { recipient: 'borrower' });
  ok('4 solo borrower explicit', r.length === 1 && r[0].email === 'moshe@example.com'); }

// 5) MULTI-signer package (term sheet) is UNCHANGED by the choice: both borrower + co-borrower sign,
//    and recipient='co_borrower' does NOT swap/drop the primary (the choice only applies to solo).
{ const r = buildRoster(app, dualSpec, 'env5', { recipient: 'co_borrower' });
  ok('5 dual: two signers', r.length === 2);
  ok('5 dual: primary borrower first', r[0].role === 'borrower' && r[0].email === 'moshe@example.com');
  ok('5 dual: co-borrower second', r[1].role === 'co_borrower' && r[1].email === 'sarah@example.com'); }

console.log(`\ntest-draw-recipient-choice: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
