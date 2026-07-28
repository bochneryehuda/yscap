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

// ── exactly ONE definition of the rule ───────────────────────────────────────
// A JS mirror was deleted precisely because nothing pinned it to the SQL.
ok(closing.closingRetired === undefined,
  'there is no second, unpinned copy of the rule');

console.log(`test-closing-retirement-contract: ${n} assertions passed`);
