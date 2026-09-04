'use strict';
/*
 * A REFINANCE HAS NO PURCHASE FIELDS TO MATCH — and the A/B-piece split still must.
 *
 * Owner-directed 2026-08-26: *"Encompass sync for rtl for refinance transactions,
 * any cash-out or rate and term, certain fields don't need to match, for example
 * Purchase price - Effective purchase price - Seller / contract price - Assignment
 * fee, because there is no purchase and there is no contract, it's a refinance, so
 * we need to fix this logic."*
 *
 * WHAT WAS ACTUALLY WRONG. The Encompass sync section passes only when EVERY
 * compared field is an exact match (owner-directed 2026-07-26), and a not-passing
 * row holds the DocuSign term-sheet send AND the data-tape export. On a refinance
 * all four purchase-side rows are structurally unresolvable:
 *   · `purchase_price` — db/399 CLEARED the column on every refinance on purpose,
 *     and the details door REFUSES to store one, so our side is blank forever.
 *   · `effective_purchase` / `contract_price` — both fall back to the purchase
 *     price, so both are blank too.
 *   · `assignment_fee` — db/630 forces `is_assignment` false on a refinance, so
 *     our side is a deliberate ZERO; a stale non-zero fee in Encompass therefore
 *     reads as an honest MISMATCH rather than as missing data.
 * Encompass, meanwhile, routinely carries a purchase price on a refinance (the
 * property was bought at some point). So the panel told staff either "Our file has
 * no value for this yet — enter it on the file" (advice nobody can act on) or
 * "the values differ" — on four rows, on every refinance, with no way through
 * except a super-admin field exception per file, forever.
 *
 * THE SHAPE OF THE FIX, and why the obvious one is wrong. `naWhenOursMissing`
 * already exists and already makes summarize() skip a row. It cannot do this job:
 * it is STATIC (so it would also switch the check off on a PURCHASE whose price
 * nobody entered — a real gap the section exists to hold), it only fires when OUR
 * side is blank (so the assignment fee's deliberate 0 escapes it), and it says
 * nothing about a value THEIR side holds. So the registry names the deal SHAPE a
 * field does not apply to (`naOnDealShape: 'refinance'`) and reconcile asks the
 * FILE which shape it is — through `deal-basis.sizesOnAsIsValue`, the same
 * predicate the frozen engine sizes on and the same one that cleared the column.
 *
 * PURE — no database, no network.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const map = require('../src/lib/integrations/encompass-field-map');
const recon = require('../src/encompass/reconcile');
const dealBasis = require('../src/lib/deal-basis');

let n = 0;
const ok = (msg) => { n++; console.log('PASS ' + msg); };
const eq = (a, b, msg) => { assert.strictEqual(a, b, msg + ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); ok(msg); };
const yes = (v, msg) => { assert.ok(v, msg); ok(msg); };

const SRC = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
/* Comments necessarily NAME the thing they explain, so a "must not appear" guard that
   reads them fails on its own explanation and then gets "fixed" by deleting it. */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const OWNER_FOUR = ['purchase_price', 'effective_purchase', 'contract_price', 'assignment_fee'];

// ── A. THE PREDICATE ─────────────────────────────────────────────────────────
console.log('\nA. notApplicableReason — the four the owner named, and nothing else');

for (const k of OWNER_FOUR) {
  yes(map.notApplicableReason(k, { refinance: true }), `A1 ${k} does not apply to a refinance`);
  eq(map.notApplicableReason(k, { refinance: false }), null, `A2 ${k} DOES apply to a purchase`);
}
// The whole point of a per-file rule: a purchase is completely untouched.
for (const k of ['loan_amount', 'as_is_value', 'arv', 'rehab_budget', 'ys_loan_number', 'units', 'rate_pct']) {
  eq(map.notApplicableReason(k, { refinance: true }), null, `A3 ${k} still has to match on a refinance`);
}
// A fact we could not establish must never silence a compared field.
eq(map.notApplicableReason('purchase_price', undefined), null, 'A4 no facts at all → the field still applies (never silence on an unknown shape)');
eq(map.notApplicableReason('purchase_price', {}), null, 'A5 an absent fact → the field still applies');
eq(map.notApplicableReason('purchase_price', { refinance: 'yes' }), null, 'A6 a TRUTHY-but-not-true fact is refused — only an explicit boolean true silences a row');
eq(map.notApplicableReason('purchase_price', { refinance: 1 }), null, 'A6b 1 is not true either');
eq(map.notApplicableReason('no_such_field_key', { refinance: true }), null, 'A7 an unknown field key answers null rather than throwing');

// EXACTLY these four carry the flag. A fifth would silence a check nobody asked to
// silence, and the mistake would be invisible — the row simply stops being counted.
const flagged = map.REGISTRY.filter((e) => e.naOnDealShape === 'refinance').map((e) => e.key).sort();
assert.deepStrictEqual(flagged, OWNER_FOUR.slice().sort(),
  `A8 exactly the owner's four fields are flagged refinance-not-applicable (got ${flagged.join(',')})`);
ok('A8 exactly the four fields the owner named carry naOnDealShape:refinance — no more, no fewer');

const shapes = new Set(map.REGISTRY.map((e) => e.naOnDealShape).filter(Boolean));
for (const s of shapes) yes(map.NA_REASON[s], `A9 the deal shape "${s}" has a plain-language reason to show`);

// ── B. THE MARKER ────────────────────────────────────────────────────────────
console.log('\nB. markNotApplicable — one place, both halves, idempotent');

const rowsOf = (o) => Object.keys(o).map((k) => ({ ...o[k], key: k }));

{
  // The deal-shape half fires whatever either side holds — that is the difference
  // from naWhenOursMissing, and it is the half that fixes the assignment fee.
  const f = rowsOf({
    purchase_price: { status: 'incomparable', naOnDealShape: 'refinance', oursNorm: null, theirsNorm: 420000 },
    assignment_fee: { status: 'mismatch', naOnDealShape: 'refinance', oursNorm: 0, theirsNorm: 5000, open: true },
  });
  recon.markNotApplicable(f, { refinance: true });
  eq(f[0].status, 'not_applicable', 'B1 our side blank + THEIR side holding a purchase price → not applicable');
  eq(f[1].status, 'not_applicable', 'B2 a real MISMATCH on the assignment fee → not applicable (naWhenOursMissing could never reach this: our 0 is not blank)');
  eq(f[1].open, false, 'B3 a not-applicable row carries no open disagreement to resolve');
  yes(f[0].notApplicable === true && f[1].notApplicable === true, 'B4 the verdict is stated as a flag the screen can read');
  yes(/refinance/i.test(f[0].naReason), 'B5 the reason says, in plain words, that it is a refinance');
}
{
  // The pre-existing half, unchanged in meaning: nothing to derive on our side.
  const f = rowsOf({
    exit_plan: { status: 'incomparable', naWhenOursMissing: true, oursNorm: null, theirsNorm: 'Sale' },
    vesting_llc: { status: 'incomparable', naWhenOursMissing: true, oursNorm: '', theirsNorm: 'ABC LLC' },
    still_missing: { status: 'incomparable', naWhenOursMissing: true, oursNorm: 5, theirsNorm: null },
  });
  recon.markNotApplicable(f, { refinance: false });
  eq(f[0].status, 'not_applicable', 'B6 an underivable our-side (exit plan on a bridge) is not applicable');
  eq(f[1].status, 'not_applicable', 'B7 an EMPTY STRING counts as blank too (an individual-vested file has no LLC name)');
  eq(f[2].status, 'incomparable', 'B8 a DERIVABLE our-side still has to match — the flag alone never silences a row');
}
{
  const f = rowsOf({
    reference_row: { status: 'reference', naOnDealShape: 'refinance' },
    a_match: { status: 'match', naOnDealShape: 'refinance', oursNorm: 1, theirsNorm: 1 },
  });
  recon.markNotApplicable(f, { refinance: true });
  eq(f[0].status, 'reference', 'B9 a reference row is left alone — it was never compared');
  eq(f[1].status, 'not_applicable', 'B10 even a coincidental MATCH on a refinance reads as not-applicable, so the panel never implies the question was meaningful');
}
{
  const f = rowsOf({ purchase_price: { status: 'incomparable', naOnDealShape: 'refinance', oursNorm: null, theirsNorm: 1 } });
  recon.markNotApplicable(f, { refinance: true });
  const first = f[0].naReason;
  recon.markNotApplicable(f, { refinance: true });
  recon.markNotApplicable(f, { refinance: false });
  eq(f[0].status, 'not_applicable', 'B11 the marker is idempotent — a second pass is a no-op');
  eq(f[0].naReason, first, 'B12 and a later pass with different facts cannot rewrite a verdict already reached');
}
yes(recon.markNotApplicable([null, undefined], { refinance: true }), 'B13 a junk row never throws');

// ── C. THE GATE — the same fixture, the only difference being the loan type ──
console.log('\nC. summarize — a refinance stops blocking, a purchase does not move');

// PILOT's real refinance shape: db/399 cleared the price, db/630 forced the fee to 0.
const OURS_REFI = { loan_amount: 500000, purchase_price: undefined, effective_purchase: undefined, contract_price: undefined, assignment_fee: 0 };
// Encompass on that same loan still carries purchase-side numbers.
const THEIRS = { loan_amount: 500000, purchase_price: 420000, effective_purchase: 420000, contract_price: 415000, assignment_fee: 5000 };

const run = (refinance) => {
  const { fields } = recon.compareAll(OURS_REFI, THEIRS, {}, { refinance });
  return { fields, summary: recon.summarize(fields), byKey: fields.reduce((m, f) => (m[f.key] = f, m), {}) };
};
const refi = run(true);
const purch = run(false);

for (const k of OWNER_FOUR) {
  eq(refi.byKey[k].status, 'not_applicable', `C1 refinance: ${k} reads not-applicable`);
  yes(!refi.summary.notPassingKeys.includes(k), `C2 refinance: ${k} does not hold the term sheet or the tape`);
}
for (const k of OWNER_FOUR) {
  yes(purch.byKey[k].status !== 'not_applicable', `C3 purchase: ${k} is still compared`);
  yes(purch.summary.notPassingKeys.includes(k), `C4 purchase: ${k} still holds the section until it matches`);
}
eq(purch.summary.compared - refi.summary.compared, 4, 'C5 exactly four fields leave the compared set on a refinance — no other row moved');
eq(purch.summary.notPassing - refi.summary.notPassing, 4,
  'C6 exactly four rows stop holding the section on a refinance (this fixture states only the money fields, so the rest of the registry is legitimately still un-entered on both sides)');
// The proof that the fix is per-FILE and not a blanket switch-off: a file that is
// otherwise identical still blocks on all four the moment it is a purchase.
yes(purch.summary.notPassingKeys.length > refi.summary.notPassingKeys.length,
  'C7 the same numbers on a PURCHASE hold more of the section — the rule reads the deal, never the registry alone');

// The one thing a money-comparing assertion cannot see: that no OTHER field's
// verdict moved. Compare the whole roster key by key, refinance against purchase.
const moved = Object.keys(refi.byKey).filter((k) => refi.byKey[k].status !== purch.byKey[k].status);
assert.deepStrictEqual(moved.sort(), OWNER_FOUR.slice().sort(),
  `C8 the ONLY rows whose verdict differs between a refinance and a purchase are the owner's four (got ${moved.join(',') || 'none'})`);
ok('C8 the refinance rule reaches exactly four rows and touches nothing else in the whole registry');

// ── D. THE EXCEPTION MACHINERY ───────────────────────────────────────────────
console.log('\nD. a field that never applied is not something anybody had to ask permission for');
{
  const { fields } = recon.compareAll(OURS_REFI, THEIRS, {}, { refinance: true });
  const f = fields.find((x) => x.key === 'purchase_price');
  recon._internals.applyFieldExceptions(fields, {
    purchase_price: { resolution: 'excepted', ours_snapshot: f.oursNorm, theirs_snapshot: f.theirsNorm, resolved_by: 'x' },
  });
  eq(f.excepted, undefined, 'D1 a stale granted exception is NOT applied to a not-applicable row (it would imply somebody had to ask)');
  eq(recon.summarize(fields).excepted, 0, 'D2 and it is not counted as an exception in the summary');
}

// ── E. THE WORDING ───────────────────────────────────────────────────────────
console.log('\nE. the panel is told WHY a row is grey');
{
  const { fields } = recon.compareAll(OURS_REFI, THEIRS, {}, { refinance: true });
  for (const f of fields.filter((x) => OWNER_FOUR.includes(x.key))) {
    yes(f.naReason && /refinance/i.test(f.naReason), `E1 ${f.key} carries a reason naming the refinance`);
  }
  const exit = recon.compareAll({ exit_plan: undefined }, { exit_plan: 'Sale' }, {}, { refinance: false })
    .fields.find((x) => x.key === 'exit_plan');
  yes(exit.naReason && /doesn't apply/i.test(exit.naReason), "E2 the underivable-our-side half carries its own reason too");
}

// ── F. SOURCE GUARDS — the wiring a behaviour test cannot see ────────────────
console.log('\nF. source guards');
{
  const rec = stripComments(SRC('src/encompass/reconcile.js'));
  /* RE-POINTED 2026-09-04, never loosened. The facts moved into a named `naFacts` object when the
     minimum-origination switch joined them (db/695) — this guard's SUBJECT is unchanged: that the
     refinance verdict comes from `deal-basis` asking about the FILE's own loan type, which is the
     ONE definition the frozen engine sizes on. */
  yes(/refinance:\s*dealBasis\.sizesOnAsIsValue\(row\.loan_type\)/.test(rec),
    'F1 computeFindings asks deal-basis about the FILE\'s own loan_type — the ONE definition of a refinance');
  /* AND THE FACTS REACH BOTH PASSES OF THE MARKER. It runs once inside compareAll (over the
     economics family) and again over every family, and it is idempotent BY SKIPPING a row it has
     already decided — so a first pass handed no facts can decide a row wrongly and then block the
     second pass that knows better. MEASURED when the origination switch was added: both halves of
     that pair came back not-applicable, i.e. the fee was compared neither way. */
  yes(/const naFacts = \{/.test(rec) && /compareAll\(ours, theirs, resolutions, naFacts\)/.test(rec)
      && /markNotApplicable\(fields, naFacts\)/.test(rec),
    'F1b …and BOTH passes of the marker are handed the same facts');
  yes(!/\/refi\/i?\.test|includes\(['"]refi/.test(rec),
    'F2 reconcile never re-inlines a /refi/ test of its own — a second copy is how the panel ends up demanding a field the details door refuses to store');
  yes(/a\.loan_type/.test(rec), 'F3 the live SELECT actually reads loan_type (without it the rule silently never fires)');
  // summarize must skip it, or the row would still hold the term sheet.
  yes(/f\.status === 'not_applicable'\) continue;/.test(rec), 'F4 summarize skips a not-applicable row');
  // The old inline naWhenOursMissing skip stays as the backstop for a caller that
  // summarizes fields the marker never ran over.
  yes(/naWhenOursMissing && f\.status === 'incomparable'/.test(rec), 'F5 the naWhenOursMissing backstop in summarize is kept — a caller may summarize unmarked fields');
}
{
  const fm = stripComments(SRC('src/lib/integrations/encompass-field-map.js'));
  yes(!/require\(/.test(fm), 'F6 the field map is still PURE (no requires) — the deal fact is supplied by the caller, never fetched here');
}

// ── G. THE SCREEN READS THE SERVER'S VERDICT ────────────────────────────────
console.log('\nG. the browser is told the answer, it does not work it out again');
{
  const panel = stripComments(SRC('app-v2/src/components/EncompassSyncPanel.jsx'));
  const derivations = (panel.match(/naWhenOursMissing/g) || []).length;
  eq(derivations, 1, 'G1 the client-side derivation exists in exactly ONE place (the compatibility fallback), not copied per use site');
  yes(/function notApplicableTo\(f\)/.test(panel), 'G2 there is one helper that answers it for the whole screen');
  yes(/f\.notApplicable/.test(panel), 'G3 and it reads the flag the SERVER computed');
  yes(/naDoesntApply = notApplicableTo\(f\)/.test(panel) && /if \(notApplicableTo\(f\)\)/.test(panel),
    'G4 both the status pill and the blocking test go through that one helper');
  yes(/naReason/.test(panel), 'G5 the row shows the server\'s own sentence rather than re-wording it');
}

// ── H. THE A/B-PIECE SPLIT IS UNAFFECTED (the owner\'s other half of this ask) ─
console.log("\nH. the A/B-piece split still has to match — on a refinance too");
{
  const AB = require('../src/lib/ab-piece');
  yes(typeof AB._internals.shapeEncompass === 'function', 'H1 the A/B-piece Encompass shaper is the ONE definition both the card and the sync read');
  const abKeys = ['ref_ab_piece_structure', 'ref_a_piece_amount', 'ref_b_piece_amount'];
  for (const k of abKeys) {
    yes(map.BY_KEY[k], `H2 ${k} is in the registry`);
    eq(map.BY_KEY[k].naOnDealShape || null, null, `H3 ${k} is NOT swept up by the refinance rule — a B-piece structure is just as real on a refinance`);
  }
  const rec = stripComments(SRC('src/encompass/reconcile.js'));
  yes(/compareAbPiece\(row, loan, quote/.test(rec), 'H4 the computed A/B-piece rows are still assembled into the compared section');
  const f = rowsOf({
    ab_piece_a_amount: { status: 'mismatch', oursNorm: '$1', theirsNorm: '$2', open: true },
  });
  recon.markNotApplicable(f, { refinance: true });
  eq(f[0].status, 'mismatch', 'H5 an A/B-piece disagreement on a REFINANCE still blocks — "these three fields also need to match"');
}

// ── I. THE PREDICATE AGREES WITH THE REST OF THE SYSTEM ─────────────────────
console.log('\nI. what counts as a refinance');
for (const t of ['Refinance', 'Refinance — Cash-Out', 'refinance - rate and term', 'Cash-Out Refi', 'REFI']) {
  yes(dealBasis.sizesOnAsIsValue(t), `I1 "${t}" is a refinance`);
}
for (const t of ['Purchase', 'Delayed Purchase Financing', 'Ground up', '', null, undefined]) {
  yes(!dealBasis.sizesOnAsIsValue(t), `I2 "${t}" is NOT a refinance — its purchase fields still have to match`);
}

console.log(`\ntest-encompass-refinance-fields-pure: all ${n} checks passed.`);
