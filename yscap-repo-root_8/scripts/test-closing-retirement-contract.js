'use strict';
/*
 * CONTRACT test for the closing-desk RETIREMENT rule (owner-directed 2026-07-26).
 *
 * A file leaves the closer's Closing desk when the closing is FINISHED —
 * reconciled AND investor delivered — "either way": handed to purchasing, or
 * TABLE FUNDED (sold at closing, which is structurally barred from ever reaching
 * stage='in_purchasing'). Keying the desk on that stage left every table-funded
 * file on the screen permanently with the badge climbing and no way to clear it.
 *
 * WHY A SOURCE CONTRACT TEST: the behavioural coverage in test-purchasing-db.js
 * calls closing.CLOSING_RETIRED_SQL directly, so it stays green even if the two
 * ROUTES and the SCREEN are reverted to the old stage check — which is exactly
 * the user-visible half. A pre-merge audit proved that gap. This pins the three
 * consumers to the one shared definition instead.
 *
 * Pure — no DB, no network. Runs in `npm test`.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); };
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const closing = require('../src/lib/closing');
const staff = read('src/routes/staff.js');
const screen = read('app-v2/src/screens/StaffClosing.jsx');

// ── the shared definition exists and means what the desk needs ───────────────
ok(typeof closing.CLOSING_RETIRED_SQL === 'function', 'CLOSING_RETIRED_SQL is exported');
const sql = closing.CLOSING_RETIRED_SQL('cw');
ok(/fully_reconciled_at\s+IS NOT NULL/.test(sql) && /investor_delivery_signed_off_at\s+IS NOT NULL/.test(sql),
  'retirement requires BOTH the reconciliation and the investor-delivery stamp');
ok(sql.trim().startsWith('(') && sql.trim().endsWith(')'),
  'the predicate is fully parenthesised — it is interpolated under NOT, where loose precedence would invert the badge');
ok(closing.CLOSING_RETIRED_SQL('x').includes('x.stage'), 'it honours the alias it is given');

// ── the two ROUTES use it, and no longer key on the stage ────────────────────
const deskQuery = staff.slice(staff.indexOf("router.get('/closing'"), staff.indexOf("router.get('/closing/count'"));
const badgeQuery = staff.slice(staff.indexOf("router.get('/closing/count'"), staff.indexOf("router.get('/closing/count'") + 1200);

ok(deskQuery.includes("CLOSING_RETIRED_SQL('cw')") && /AS closing_retired/.test(deskQuery),
  'the desk queue computes closing_retired from the shared predicate');
ok(badgeQuery.includes("CLOSING_RETIRED_SQL('cw')") && /NOT \$\{closing\.CLOSING_RETIRED_SQL/.test(badgeQuery),
  'the nav badge counts NOT-retired files using the same predicate');
// The precise regression: a table-funded file can never reach this stage, so any
// consumer keying on it retires that file NEVER.
for (const [name, src] of [['desk queue', deskQuery], ['nav badge', badgeQuery]])
  ok(!/stage\s*(<>|!=)\s*'in_purchasing'/.test(src) && !/stage\s*=\s*'in_purchasing'/.test(src),
    `the ${name} no longer decides retirement from the stage`);

// ── the SCREEN filters on the server-computed flag ───────────────────────────
ok(/r\.closing_retired/.test(screen), 'the Closing screen filters on the server-computed closing_retired');
ok(!/closing_stage\s*(===|!==)\s*'in_purchasing'/.test(screen),
  'the screen no longer re-derives retirement from the stage');
ok(/'Completed'/.test(screen),
  'the finished tab is labelled "Completed" — a table-funded loan was never in purchasing');

// ── the UN-SIGN unwind is one shipped function, and the route calls it ───────
// All three steps must happen together; the route used to inline them and the DB
// test mirrored them, so the mirror stayed green while the route lost a step.
const purchasing = require('../src/lib/purchasing');
ok(typeof purchasing.unwindInvestorDelivery === 'function',
  'unwindInvestorDelivery is the one shipped definition of the un-sign unwind');
// Slice the sign-off handler out by its OWN boundaries. `indexOf` returning -1
// on a moved end-marker would make slice() hand back the whole file and turn
// every assertion below into a silent no-op — so both ends are asserted, and the
// slice is sanity-checked for a plausible size.
const soStart = staff.indexOf("router.post('/applications/:id/closing/sign-off'");
ok(soStart > 0, 'the sign-off route still exists (the slice has a start)');
const soEnd = staff.indexOf('\nrouter.', soStart + 10);
ok(soEnd > soStart, 'the sign-off route has a following route (the slice has an end)');
const signOffRaw = staff.slice(soStart, soEnd);
// Match against a COMMENT-STRIPPED projection. The handler's own comments
// describe the forbidden call in prose, so a plain text match passes today only
// because the shipped wording happens to wrap mid-phrase — re-flowing that
// paragraph would fail CI on a comment alone. Assert on code, not prose.
const signOff = signOffRaw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
ok(signOffRaw.length > 400 && signOffRaw.length < 12000,
  `the sliced handler is a plausible size (${signOffRaw.length} chars) — a bad slice would make every assertion below vacuous`);
// The route now calls applyInvestorDeliverySignOff, which owns BOTH directions
// (enter on sign-off, unwind on un-sign) and calls unwindInvestorDelivery itself.
// What matters is unchanged: the route does not carry its own copy of the steps.
ok(/applyInvestorDeliverySignOff\(|unwindInvestorDelivery\(/.test(signOff),
  'the sign-off route calls a shared helper rather than inlining the steps');
ok(!/UPDATE closing_workflow SET stage='fully_reconciled'/.test(signOff),
  'the route no longer carries its own copy of the stage step-back');
// The ClickUp resync that used to live here was REMOVED (see the route): it
// silently no-opped for a non-admin closer and, when it did apply, un-parked an
// on-hold file and emailed the borrower. Pin its ABSENCE so it cannot be
// reinstated as a bolt-on without a deliberate change here.
ok(!/applyInternalStatus\(/.test(signOff),
  'the sign-off route does NOT drive the status door at all — ANY status, not just the one that shipped');

// ── the DEADLOCK fix is WIRED, in both completion routes ─────────────────────
// workflow.lockClosingItems exists and is well covered — but only because the
// deadlock test CALLS it directly. Nothing pinned the routes to it, so deleting
// both `await workflow.lockClosingItems(...)` lines left the entire suite green,
// including the deadlock test and its own negative control, while the money-grade
// deadlock it prevents came straight back. The lock must be taken FIRST: the
// submit route takes workflow_items -> closing_workflow and cannot be reordered,
// so any path that touches closing_workflow first inverts the order.
function sliceRoute(startsWith) {
  const a = staff.indexOf(startsWith);
  ok(a > 0, `route ${startsWith} still exists`);
  const b = staff.indexOf('\nrouter.', a + 10);
  ok(b > a, `route ${startsWith} has an end`);
  const raw = staff.slice(a, b);
  ok(raw.length > 400 && raw.length < 20000,
    `${startsWith} sliced to a plausible size (${raw.length} chars)`);
  return raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
}
for (const [name, start] of [
  ['stage', "router.post('/applications/:id/closing-workflow'"],
  ['sign-off', "router.post('/applications/:id/closing/sign-off'"],
]) {
  const code = sliceRoute(start);
  const lock = code.indexOf('lockClosingItems(');
  ok(lock > 0, `the ${name} route takes the closing hand-off lock`);
  for (const after of ['ensureClosingRow(', 'advanceClosing(', 'UPDATE closing_workflow']) {
    const at = code.indexOf(after);
    if (at > 0) ok(lock < at, `the ${name} route locks BEFORE ${after.trim()} (lock order, not just presence)`);
  }
}

// ── a TABLE FUNDED loan can never be pushed to purchasing ────────────────────
// Deleting this 422 left the suite green while the file moved to
// stage='in_purchasing', dropped off the closing badge, and never appeared on
// the purchasing desk (which correctly excludes table-funded files) — on NEITHER
// desk, the exact failure the stage guard exists to prevent.
{
  const code = sliceRoute("router.post('/applications/:id/closing-workflow'");
  ok(/table_funded/.test(code) && /422/.test(code),
    'the stage route refuses in_purchasing for a table-funded loan');
  ok(/in_purchasing/.test(code) && /enterPurchasing\(/.test(code),
    'and the manual "Send to purchasing" button actually enrols the file on the desk');
}

// ── the sign-off route uses the ONE shipped fork ─────────────────────────────
// It used to write the table-funded test out inline, which forced the DB test to
// copy it — so `if (on) enterPurchasing()` (enrolling a table-funded loan on the
// desk it must never reach) shipped with every test passing.
{
  const code = sliceRoute("router.post('/applications/:id/closing/sign-off'");
  ok(/applyInvestorDeliverySignOff\(/.test(code),
    'the sign-off route calls the shared fork rather than inlining it');
  ok(!/SELECT table_funded FROM closing_workflow/.test(code),
    'and no longer carries its own copy of the table-funded read');
}

// ── the warehouse derivation has exactly ONE definition ──────────────────────
ok(typeof closing.tableFundedFor === 'function', 'the warehouse->table-funded rule is a shared function');
ok(closing.tableFundedFor(closing.TABLE_FUNDING) === true, 'the Table Funding warehouse marks a file table funded');
ok(closing.tableFundedFor('Stride Bank') === false, 'and every other warehouse does not');
ok(closing.tableFundedFor(null) === false, 'and no warehouse at all does not');
{
  const code = sliceRoute("router.patch('/applications/:id/closing'");
  ok(/closing\.tableFundedFor\(/.test(code), 'the closing PATCH uses the shared derivation');
  ok(!/wh === closing\.TABLE_FUNDING/.test(code), 'and does not re-write the comparison inline');
}

// ── the closer-only field list matches what the route actually WRITES ────────
// These were two hand-maintained lists — one to write a field, one to refuse it
// from a non-closer — and they drifted: `collateralTrackingCarrier` was written
// but never refused, so a processor setting the carrier got 200 {ok:true} and
// nothing saved. Rather than fix the one field and leave the trap armed, the
// list moved into closing.js and BOTH branches read it. This pins the list to
// the route source, so adding a sixth closer-only field without listing it
// fails here instead of shipping another silent no-op.
const pStart = staff.indexOf("router.patch('/applications/:id/closing'");
ok(pStart > 0, 'the closing PATCH route still exists');
const pEnd = staff.indexOf('\nrouter.', pStart + 10);
ok(pEnd > pStart, 'the closing PATCH route has an end');
const patchRaw = staff.slice(pStart, pEnd);
ok(patchRaw.length > 400 && patchRaw.length < 20000,
  `the sliced closing PATCH is a plausible size (${patchRaw.length} chars)`);
const patchCode = patchRaw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

// Everything the CLOSER-ONLY branch writes, discovered from the source: each
// `if ('x' in b)` / `typeof b.x === 'boolean'` guard inside it. The slice starts
// at `if (isCloser) {` — NOT at the top of the handler, which also carries the
// deliberately SHARED toggles (investorCtc, closingDateConfirmed) that anyone on
// the file may set and which must NOT be in the closer-only list.
const brStart = patchCode.indexOf('if (isCloser) {');
ok(brStart > 0, 'the closer-only branch still opens with `if (isCloser) {`');
const closerBranch = patchCode.slice(brStart, patchCode.indexOf('} else if (', brStart));
ok(closerBranch.length > 200, 'the closer-only branch was located');
const written = new Set();
for (const m of closerBranch.matchAll(/if\s*\(\s*'([A-Za-z]+)'\s+in\s+b\s*\)/g)) written.add(m[1]);
for (const m of closerBranch.matchAll(/typeof\s+b\.([A-Za-z]+)\s*===\s*'boolean'/g)) written.add(m[1]);
ok(written.size >= 4, `found the closer-only writes in the source (${[...written].join(', ')})`);

const listed = new Set(closing.CLOSER_ONLY_CLOSING_FIELDS);
for (const f of written)
  ok(listed.has(f), `'${f}' is written only for a closer, so it must also be REFUSED for a non-closer`);
ok(/closing\.CLOSER_ONLY_CLOSING_FIELDS/.test(patchCode),
  'the refusal branch reads the shared list rather than a second hand-written one');
ok(listed.has('collateralTrackingCarrier'),
  'the field that was silently dropped is covered (the regression this pins)');

// ── exactly ONE definition of the rule ───────────────────────────────────────
// A JS mirror was deleted precisely because nothing pinned it to the SQL.
ok(closing.closingRetired === undefined,
  'there is no second, unpinned copy of the rule');

console.log(`test-closing-retirement-contract: ${n} assertions passed`);
