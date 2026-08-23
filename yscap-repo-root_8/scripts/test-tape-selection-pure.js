'use strict';
/**
 * BUILDING A TAPE FROM ANY LOANS — the selection workflow the owner asked for
 * (2026-08-23): *"We can import and select different loans to be included in that
 * tape … We can search loans by loan numbers and by address … We can check mark
 * which loans should be included … I can include any kind of loans that I want."*
 * Pure: no database, no HTTP.
 *
 * WHAT THIS PROVES, AND WHY EACH ONE MATTERS:
 *
 *   · THE PICKER WAS THE DEFECT, NOT THE RULE. An admin has always been allowed to
 *     export any provider's tape for any loan; the old picker just could not SHOW a
 *     loan that was not already assigned to that provider. So the search must stamp
 *     rows with the SAME pure gate the builder enforces — the screen can then never
 *     offer something the export would refuse, and never hide something it would
 *     allow. Asserted directly against `exportGate` for both roles.
 *
 *   · NOTHING WAS QUIETLY RELAXED. The non-admin gate — register first, manual is
 *     admin-only, provider must match, program must match — is asserted intact. A
 *     "selection workflow" that also loosened who may export would be a different
 *     change wearing this one's clothes.
 *
 *   · THE SEARCH IS BOUNDED AND EXACT. Its SQL matches each field separately rather
 *     than a concatenated haystack (a concatenation lets a loan-number search hit a
 *     ZIP code, and a tape exported for the wrong loan is the expensive mistake
 *     here); the query is scoped to what the staffer may see; the paste list and
 *     the result set are both capped.
 *
 *   · EVERY SELECTED LOAN GETS ITS OWN ROW. That is the third thing the owner asked
 *     for, and it is what `buildBulkTape` already did — asserted so a change to the
 *     selection side can never quietly collapse the rows.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const R = path.resolve(__dirname, '..');

const buyerRule = require(R + '/src/lib/tapes/buyer-rule');
const registry = require(R + '/src/lib/tapes/registry');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };
const eq = (a, b, msg) => { assert.strictEqual(a, b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); passed++; };

const loan = (lenderRaw) => ({ found: true, app: { ys_loan_number: 'Y1' }, noteBuyerRaw: lenderRaw });
const tape = (k) => { const t = registry.getTape(k); assert.ok(t, `tape ${k} exists`); return t; };

const fidelis = tape('fidelis');
const bluelake = tape('bluelake');

// ── 1. the search must be able to offer what the gate allows ────────────────
// An ADMIN putting a Blue Lake loan on the Fidelis tape is ALLOWED — and this is
// exactly the row the old picker could not show, which is the whole defect.
ok(buyerRule.exportGate(loan('Blue Lake'), fidelis, { isAdmin: true, registeredProgram: 'gold' }).ok,
  'an admin may put a Blue Lake loan on the Fidelis tape — the picker must be able to offer it');
ok(buyerRule.exportGate(loan(null), fidelis, { isAdmin: true, registeredProgram: null }).ok,
  'an admin may export a loan with no provider and no registration — the picker must be able to offer it');

// ── 2. and must refuse to offer what the gate refuses, with the real reason ──
let g = buyerRule.exportGate(loan('Blue Lake'), fidelis, { isAdmin: false, registeredProgram: 'gold' });
eq(g.ok, false, 'a NON-admin still cannot put a Blue Lake loan on the Fidelis tape');
eq(g.error.code, 'buyer_mismatch', 'and the row is stamped with the real reason code');
ok(/Blue Lake/.test(g.error.message) && /Fidelis/.test(g.error.message),
  'whose message names both the loan’s provider and the tape — a reason a person can act on');

g = buyerRule.exportGate(loan('Fidelis'), fidelis, { isAdmin: false, registeredProgram: null });
eq(g.error.code, 'not_registered', 'register-first still applies to a non-admin');
g = buyerRule.exportGate(loan('Fidelis'), fidelis, { isAdmin: false, registeredProgram: 'manual' });
eq(g.error.code, 'manual_admin_only', 'a manual loan is still admin-only');
g = buyerRule.exportGate(loan('Fidelis'), fidelis, { isAdmin: false, registeredProgram: 'gold' });
eq(g.error.code, 'program_mismatch', 'the program↔provider pairing still applies to a non-admin');
ok(buyerRule.exportGate(loan('Fidelis Investors'), fidelis, { isAdmin: false, registeredProgram: 'standard' }).ok,
  'the ordinary, fully-lined-up non-admin case still passes');

// The "already assigned to this provider?" chip the screen shows is the buyer
// match ALONE — not the whole gate. They are different questions and the screen
// asks both: one is "is this an unusual thing to do", the other "may you do it".
eq(buyerRule.buyerMatches(loan('Blue Lake'), fidelis), false, 'buyerMatches is false for another provider’s loan…');
ok(buyerRule.exportGate(loan('Blue Lake'), fidelis, { isAdmin: true, registeredProgram: 'gold' }).ok,
  '…while the gate still allows an admin to export it — the chip warns, it does not block');
eq(buyerRule.buyerMatches(loan('fidelis investors'), fidelis), true, 'buyerMatches ignores casing/spacing/suffix');

// ── 3. the search endpoint's own guarantees, read from the route ────────────
const staff = fs.readFileSync(path.join(R, 'src/routes/staff.js'), 'utf8');
const search = staff.slice(staff.indexOf("router.get('/tapes/:tapeKey/search'"));
const searchBody = search.slice(0, search.indexOf("router.post('/tapes/:tapeKey/selected'"));

ok(/canExportTapes\(req\)/.test(searchBody), 'the search requires the export-tapes permission');
ok(/VISIBLE_OFFICERS_SQL/.test(searchBody), 'and is scoped to the files this staffer may see');
ok(/a\.deleted_at IS NULL/.test(searchBody), 'a soft-deleted file is never offered for a tape');
// Each field matched separately — never one concatenated haystack.
for (const field of ['a.ys_loan_number', 'a.investor_loan_number', "property_address->>'oneLine'", 'b.first_name']) {
  ok(searchBody.includes(field), `the search covers ${field}`);
}
ok(/ILIKE ANY \(\$1::text\[\]\)/.test(searchBody), 'matching is an array comparison, not a per-row subquery');
ok(/\.slice\(0, 200\)/.test(searchBody), 'a pasted list of loan numbers is capped — never an unbounded OR');
ok(/LIMIT 200/.test(searchBody), 'and the result set is capped');
ok(/exportGate\(/.test(searchBody) && /ineligibleReason/.test(searchBody),
  'every row is stamped with the SAME gate the builder enforces, and the reason when it fails');
ok(/buyerMatches:/.test(searchBody), 'and with whether the loan is already assigned to this provider');

// The selection re-check door exists and carries the same scoping.
const sel = staff.slice(staff.indexOf("router.post('/tapes/:tapeKey/selected'"));
const selBody = sel.slice(0, sel.indexOf("router.post('/tapes/:tapeKey/export/bulk'"));
ok(/canExportTapes\(req\)/.test(selBody), 'the selection re-check requires the same permission');
ok(/VISIBLE_OFFICERS_SQL/.test(selBody), 'and the same visibility scope');
ok(/UUID\.test/.test(selBody), 'ids are validated as uuids before they reach SQL');
ok(/\.slice\(0, 1000\)/.test(selBody), 'and the id list is capped');

// ── 4. one loan, one row — the third thing the owner asked for ─────────────
const idx = fs.readFileSync(path.join(R, 'src/lib/tapes/index.js'), 'utf8');
ok(/const rows = loans\.map\(\(loan\) => tape\.buildRow\(/.test(idx),
  'the bulk tape builds ONE row per selected loan');
ok(/rows,/.test(idx.slice(idx.indexOf('async function buildBulkTape'))),
  'and hands the whole set to the workbook filler in one pass');

// ── 5. the screen actually offers the workflow ──────────────────────────────
const screen = fs.readFileSync(path.join(R, 'app-v2/src/screens/StaffTapes.jsx'), 'utf8');
ok(/staffTapeSearch\(/.test(screen), 'the screen searches loans');
ok(/type="checkbox"/.test(screen), 'the screen check-marks them');
ok(/staffTapeBulkExport\(/.test(screen), 'and exports the selection');
// The basket surviving a search is the difference between a search box and a workflow.
ok(/setResults\(/.test(screen) && !/setBasket\(new Map\(\)\)[\s\S]{0,200}runSearch/.test(screen),
  'running a search does NOT clear the selection');
ok(/localStorage/.test(screen), 'and the selection survives a page refresh');

console.log(`test-tape-selection-pure: OK (${passed} assertions)`);
