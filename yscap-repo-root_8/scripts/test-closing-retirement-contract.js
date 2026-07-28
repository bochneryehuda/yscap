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
ok(/unwindInvestorDelivery\(/.test(signOff),
  'the sign-off route calls it rather than inlining the steps');
ok(!/UPDATE closing_workflow SET stage='fully_reconciled'/.test(signOff),
  'the route no longer carries its own copy of the stage step-back');
// The ClickUp resync that used to live here was REMOVED (see the route): it
// silently no-opped for a non-admin closer and, when it did apply, un-parked an
// on-hold file and emailed the borrower. Pin its ABSENCE so it cannot be
// reinstated as a bolt-on without a deliberate change here.
ok(!/applyInternalStatus\(/.test(signOff),
  'the sign-off route does NOT drive the status door at all — ANY status, not just the one that shipped');

// ── exactly ONE definition of the rule ───────────────────────────────────────
// A JS mirror was deleted precisely because nothing pinned it to the SQL.
ok(closing.closingRetired === undefined,
  'there is no second, unpinned copy of the rule');

console.log(`test-closing-retirement-contract: ${n} assertions passed`);
