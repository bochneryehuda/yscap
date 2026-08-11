/**
 * The inbound portal-edit guard's classifier (owner-directed 2026-07-28: a
 * change you make must never silently bounce back).
 *
 * classifyConflicts(cols, current, snapshotApp) is PURE — it compares three
 * values per field (ClickUp-now `cols`, the file now `current`, ClickUp-last
 * `snapshotApp`) and sorts each real disagreement into:
 *   kept      — only the FILE changed (ClickUp is stale)      → keep + re-push
 *   conflicts — BOTH sides changed to different values         → keep + review
 * and stays silent for everything else (only ClickUp changed, they already
 * agree, or ClickUp's last-seen value is unknown). This test pins every branch,
 * including the semantic equality that must never read a spelling as a change.
 */
const G = require('../src/lib/inbound-portal-edit-guard');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const keys = (a) => a.map((x) => x.field).sort();
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- loan_type, the owner's own example (Fix & Flip / Fix & Hold) -----------

// only ClickUp changed → normal pull, ClickUp wins → nothing held.
let r = G.classifyConflicts(
  { loan_type: 'Fix & Hold' }, { loan_type: 'Fix & Flip' }, { loan_type: 'Fix & Flip' });
assert(eq(keys(r.kept), []) && eq(keys(r.conflicts), []),
  'only ClickUp changed (file == last-seen) → nothing is held (ClickUp wins as before)');

// only the FILE changed (ClickUp stale) → KEEP + re-push (silent).
r = G.classifyConflicts(
  { loan_type: 'Fix & Flip' }, { loan_type: 'Fix & Hold' }, { loan_type: 'Fix & Flip' });
assert(eq(keys(r.kept), ['loan_type']) && eq(keys(r.conflicts), []),
  'the file changed but ClickUp is stale → the edit is KEPT (no bounce-back), no review');

// BOTH changed to different values → CONFLICT → keep + review.
r = G.classifyConflicts(
  { loan_type: 'Bridge / Stabilized' }, { loan_type: 'Fix & Hold' }, { loan_type: 'Fix & Flip' });
assert(eq(keys(r.conflicts), ['loan_type']) && eq(keys(r.kept), []),
  'both sides changed to different values → a two-sided CONFLICT (goes to review)');
assert(r.conflicts[0].from === 'Fix & Hold' && r.conflicts[0].to === 'Bridge / Stabilized',
  'the conflict carries the file value (from) and the ClickUp value (to) for the review copy');

// they already agree → nothing.
r = G.classifyConflicts(
  { loan_type: 'Fix & Hold' }, { loan_type: 'Fix & Hold' }, { loan_type: 'Fix & Flip' });
assert(eq(keys(r.kept), []) && eq(keys(r.conflicts), []),
  'ClickUp already matches the file → nothing to do');

// ---- fail-safe cases -------------------------------------------------------

// ClickUp's last-seen value unknown (blank at the last sync) → do nothing.
r = G.classifyConflicts(
  { loan_type: 'Fix & Flip' }, { loan_type: 'Fix & Hold' }, {} /* no snapshot for the field */);
assert(eq(keys(r.kept), []) && eq(keys(r.conflicts), []),
  'unknown last-seen ClickUp value → the guard does NOTHING (never a false protection)');

// incoming null (COALESCE keeps ours / an earlier guard stripped it) → skip.
r = G.classifyConflicts(
  { loan_type: null }, { loan_type: 'Fix & Hold' }, { loan_type: 'Fix & Flip' });
assert(eq(keys(r.kept), []) && eq(keys(r.conflicts), []),
  'a null incoming value (already stripped / ClickUp blank) is skipped');

// a field not present in cols → skip (not every pull carries every field).
r = G.classifyConflicts({}, { loan_type: 'Fix & Hold' }, { loan_type: 'Fix & Flip' });
assert(eq(keys(r.kept), []) && eq(keys(r.conflicts), []), 'a field absent from the pull is skipped');

// ---- semantic equality: a spelling difference is NOT a change --------------

// term "12" (ClickUp) vs "12 Months" (file) — the file changed nothing real.
r = G.classifyConflicts(
  { term: '12' }, { term: '12 Months' }, { term: '12' });
assert(eq(keys(r.kept), []) && eq(keys(r.conflicts), []),
  'term "12" ≡ "12 Months" — a spelling difference is never a bounce-back or a conflict');

// property_type en-dash vs hyphen — same value.
r = G.classifyConflicts(
  { property_type: 'Multi 2-4' }, { property_type: 'Multi 2–4' }, { property_type: 'Multi 2-4' });
assert(eq(keys(r.kept), []) && eq(keys(r.conflicts), []),
  'property type "Multi 2-4" ≡ "Multi 2–4" — the en-dash is not a change');

// ---- numeric economics -----------------------------------------------------

// file raised the purchase price, ClickUp stale → KEEP.
r = G.classifyConflicts(
  { purchase_price: 400000 }, { purchase_price: 450000 }, { purchase_price: 400000 });
assert(eq(keys(r.kept), ['purchase_price']) && eq(keys(r.conflicts), []),
  'a purchase-price edit the file made (ClickUp stale) is KEPT');

// ---- several fields at once, mixed outcomes --------------------------------
//   loan_type: file changed, ClickUp stale        → kept
//   program:   both sides changed to different     → conflict
//   arv:       only ClickUp changed (file==last)    → normal pull (nothing held)
//   term:      "12" ≡ "12 Months"                   → a spelling, no change
r = G.classifyConflicts(
  { loan_type: 'Fix & Flip', program: 'Fix & Hold', arv: 650000, term: '12' },
  { loan_type: 'Fix & Hold', program: 'Bridge',     arv: 700000, term: '12 Months' },
  { loan_type: 'Fix & Flip', program: 'Fix & Flip', arv: 700000, term: '12' });
assert(eq(keys(r.kept), ['loan_type']),
  'mixed pull: only the file-changed-ClickUp-stale field (loan_type) is kept');
assert(eq(keys(r.conflicts), ['program']),
  'mixed pull: only the both-sides-changed field (program) is a conflict');

// PROTECTED_KEYS mirrors the economics-freeze deal-field set (single source).
assert(G.PROTECTED_KEYS.includes('loan_type') && G.PROTECTED_KEYS.includes('program')
  && G.PROTECTED_KEYS.includes('purchase_price') && G.PROTECTED_KEYS.includes('property_type'),
  'the protected set covers the two-way deal fields');

// ---- expected closing date: the 2026-08-11 bounce-back --------------------
// It is protected too (mapped dir:'both'), but is NOT an economics field.
assert(G.PROTECTED_KEYS.includes('expected_closing'),
  'the expected closing date is in the protected set');

// THE REPORTED BUG: staff moved the closing date to 08/13, the outbound push
// hasn't landed (or is off), ClickUp still holds 07/29 → the file changed,
// ClickUp is stale → KEEP the edit + re-push. Never bounce back to 07/29.
r = G.classifyConflicts(
  { expected_closing: '2026-07-29' }, { expected_closing: '2026-08-13' }, { expected_closing: '2026-07-29' });
assert(eq(keys(r.kept), ['expected_closing']) && eq(keys(r.conflicts), []),
  'closing date: the portal edit (08/13) is KEPT, ClickUp\'s stale 07/29 never bounces back');
assert(r.kept[0].from === '2026-08-13' && r.kept[0].to === '2026-07-29',
  'closing date: the kept item carries the file value (08/13) and ClickUp\'s stale value (07/29)');

// both moved the closing date to different days → a real two-sided conflict.
r = G.classifyConflicts(
  { expected_closing: '2026-08-20' }, { expected_closing: '2026-08-13' }, { expected_closing: '2026-07-29' });
assert(eq(keys(r.conflicts), ['expected_closing']) && eq(keys(r.kept), []),
  'closing date: both sides changed to different days → a two-sided CONFLICT (goes to review)');

// same calendar day, different representation (a trailing time) → NOT a change.
r = G.classifyConflicts(
  { expected_closing: '2026-08-13' }, { expected_closing: '2026-08-13T00:00:00' }, { expected_closing: '2026-08-13' });
assert(eq(keys(r.kept), []) && eq(keys(r.conflicts), []),
  'closing date: the same day in a different shape is never read as a change');

// only ClickUp moved the closing date (file == last-seen) → normal pull, nothing held.
r = G.classifyConflicts(
  { expected_closing: '2026-09-01' }, { expected_closing: '2026-07-29' }, { expected_closing: '2026-07-29' });
assert(eq(keys(r.kept), []) && eq(keys(r.conflicts), []),
  'closing date: only ClickUp changed → ClickUp wins as before (the team moves it there too)');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
