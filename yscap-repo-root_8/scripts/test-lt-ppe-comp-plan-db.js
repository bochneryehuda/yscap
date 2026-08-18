#!/usr/bin/env node
'use strict';
/**
 * LT PPE — the compensation plan RESOLVER and its door, against a REAL Postgres.
 *
 * The arithmetic has its own pure suite. What is proved here is everything that suite structurally
 * cannot see — the layering, the write door, and the one rule the owner stated twice:
 *
 *   A. AN OFFICER'S OWN NUMBER WINS OVER THE COMPANY'S, and where each number came from is reported
 *      rather than left to be guessed from the value.
 *   B. THE COMPANY HOLDBACK IS NOT AN OFFICER'S TO SET. The write door refuses it at an officer slot,
 *      and — the part that matters — even a row written straight into the table BEHIND the door is
 *      never read: the resolver filters the officer layer through the same declaration the door does.
 *      That is what makes "non-overridable" structural rather than a check somebody could route round.
 *   C. THE COMPANY MINIMUM IS A MOVABLE DEFAULT. An officer's own minimum LOWER than the company's is
 *      stored, resolved and used, with nothing bumping it back up.
 *   D. THE DOOR answers the plan on its own, answers the breakdown when there is a loan to compute it
 *      on, and refuses an unusable officer id rather than resolving somebody's numbers by accident.
 *   E. NOTHING HERE PRICES ANYTHING, and the answer says so.
 *
 *   DATABASE_URL=postgres://… node scripts/test-lt-ppe-comp-plan-db.js
 *
 * LT-only. No RTL imports.
 */
if (!process.env.DATABASE_URL) {
  console.log('SKIP test-lt-ppe-comp-plan-db (no DATABASE_URL)');
  process.exit(0);
}
const fs = require('fs');
const path = require('path');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }
function eq(a, b, label) { ok(a === b, `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

function stubRes() {
  const r = { statusCode: 200, body: null, headersSent: false };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; r.headersSent = true; return r; };
  return r;
}
const call = async (fn, req) => {
  const res = stubRes();
  try { await fn(req, res); } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: String((e && e.message) || e), threw: true });
  }
  return res;
};
const REQ = (over = {}) => Object.assign({ params: {}, body: {}, query: {}, actor: { id: null } }, over);

(async () => {
  const route = require('../src/longterm/routes/ppe');
  const H = route.handlers;
  const I = route._internals;
  const store = require('../src/longterm/ppe/store');
  const settingsAdmin = require('../src/longterm/ppe/settings-admin');
  const db = require('../src/longterm/db');

  const SCOPE = I.SCOPE;
  // A fixed, obviously-synthetic officer id: this suite never needs a real staff row, because the
  // scope is keyed on the id and nothing here reads the person.
  const OFFICER = '2f1c9d3a-0000-4000-8000-00000000c0de';
  const OTHER = '2f1c9d3a-0000-4000-8000-00000000beef';
  const scopes = [`officer:${OFFICER}`, `officer:${OTHER}`];

  const cleanup = async () => {
    await db.query('DELETE FROM lt_ppe_setting_value WHERE scope = ANY($1::text[])', [scopes]).catch(() => {});
    await db.query(
      `DELETE FROM lt_ppe_setting_value WHERE scope = $1 AND key LIKE 'comp.%'`, [SCOPE]).catch(() => {});
  };

  try {
    for (const f of ['558_lt_ppe_foundation.sql']) {
      await db.query(fs.readFileSync(path.join(__dirname, '..', 'db', f), 'utf8'));
    }
    await cleanup();

    // =========================================================================
    console.log('\nA. the layers, and where each number came from\n');
    // =========================================================================

    let r = await store.resolveCompPlanForOfficer(db, OFFICER);
    eq(r.plan.officerMarginMilli, 2000, 'A1 with nothing set, the officer is on the shipped 2.000');
    eq(r.sources.officerMarginMilli, 'product_default', 'A2 …and the answer says it is the shipped default');
    eq(r.plan.splitPct, null, 'A3 nobody has set the share of the origination');
    eq(r.plan.companyHoldbackMilli, 250, 'A4 the company holdback is the shipped 0.250');
    eq(r.officerScope, `officer:${OFFICER}`, 'A5 …under this officer\'s own slot');

    await store.setSetting(db, SCOPE, 'comp.officer_margin_milli', 2500, null);
    r = await store.resolveCompPlanForOfficer(db, OFFICER);
    eq(r.plan.officerMarginMilli, 2500, 'A6 a company value overrides the shipped default');
    eq(r.sources.officerMarginMilli, 'company', 'A7 …and is reported as the company\'s');

    await store.setSetting(db, `officer:${OFFICER}`, 'comp.officer_margin_milli', 3000, null);
    r = await store.resolveCompPlanForOfficer(db, OFFICER);
    eq(r.plan.officerMarginMilli, 3000, 'A8 THE ONE THAT MATTERS: the officer\'s own number wins');
    eq(r.sources.officerMarginMilli, 'officer', 'A9 …and is reported as theirs');

    // THE DEFECT THIS FOUND, PINNED. Setting a margin alone is the ordinary administrative act, and it
    // leaves the front/back split behind at whatever an OUTER layer says — 2.000 and 0 against a
    // margin of 3.000, which does not add up and which `computeComp` refuses outright. A staler split
    // is therefore treated as unstated and derived from how the officer is paid.
    eq(r.plan.officerFrontMilli, null,
      'A8b THE ONE THAT MATTERS: a split left behind by an outer layer is not mixed with his own margin');
    eq(r.sources.officerFrontMilli, 'derived_from_how_they_are_paid', 'A8c …and the answer says where it came from');
    const comp = require('../src/longterm/ppe/comp-plan');
    const afterMarginOnly = comp.computeComp({ ...r.plan, splitPct: 60 }, { loanAmountCents: 100000 * 100 });
    ok(afterMarginOnly.ok, 'A8d …so setting a margin alone leaves his compensation workable-out, not refused');
    eq(afterMarginOnly.officer.frontMilli, 3000, 'A8e …with all of it as origination on a borrower-paid file');

    const other = await store.resolveCompPlanForOfficer(db, OTHER);
    eq(other.plan.officerMarginMilli, 2500, 'A10 …and it is HIS number, not everybody\'s');

    // =========================================================================
    console.log('\nB. the holdback is not an officer\'s to set\n');
    // =========================================================================

    const refusal = settingsAdmin.checkKeyForTarget('officer', 'comp.company_holdback_milli');
    ok(refusal && /officer/.test(refusal.error), 'B1 the write door refuses the holdback at an officer slot');
    ok(/cannot set it/.test(refusal.message), 'B2 …and says so in words a person can act on');

    // BEHIND the door: a row written straight into the table. This is the assertion that makes the
    // rule structural — the door can be routed round, the resolver cannot.
    await db.query(
      `INSERT INTO lt_ppe_setting_value (scope, key, value)
            VALUES ($1, 'comp.company_holdback_milli', $2::jsonb)
       ON CONFLICT (scope, key) DO UPDATE SET value = EXCLUDED.value`,
      [`officer:${OFFICER}`, JSON.stringify(0)]);
    r = await store.resolveCompPlanForOfficer(db, OFFICER);
    eq(r.plan.companyHoldbackMilli, 250,
      'B3 THE ONE THAT MATTERS: a holdback row written behind the door is never read');
    eq(r.sources.companyHoldbackMilli, 'product_default', 'B4 …the answer still names the layer it really came from');
    eq(r.plan.holdbackSource, 'company', 'B5 …and the plan records that the holdback is the company\'s');

    const filtered = await store.loadOfficerOverrides(db, OFFICER);
    ok(!Object.prototype.hasOwnProperty.call(filtered, 'comp.company_holdback_milli'),
      'B6 …because the officer layer is filtered through the same declaration the door reads');

    // THERE ARE TWO LOCKS AND THEY ARE INDEPENDENT, which is why a mutation of either one alone does
    // not show up above. The FILTER (B6) is what empties the officer layer; the RESOLVER additionally
    // never passes an officer layer for this key at all. This proves the filter is load-bearing: were
    // such a layer ever handed to the resolver, the officer's value WOULD win.
    const settingsMod = require('../src/longterm/ppe/settings');
    eq(settingsMod.resolve('comp.company_holdback_milli', { tenant: { 'comp.company_holdback_milli': 0 }, org: {} }).value, 0,
      'B7 …and that filter is what stops it: an officer layer carrying the key WOULD otherwise win');

    // =========================================================================
    console.log('\nC. the company minimum is a movable default, not a floor\n');
    // =========================================================================

    await store.setSetting(db, SCOPE, 'comp.officer_min_cents', 300000, null);       // $3,000
    await store.setSetting(db, `officer:${OFFICER}`, 'comp.officer_min_cents', 50000, null); // $500
    r = await store.resolveCompPlanForOfficer(db, OFFICER);
    eq(r.plan.minCents, 50000, 'C1 THE ONE THAT MATTERS: his own lower minimum is what resolves');
    eq(r.sources.minCents, 'officer', 'C2 …reported as his');
    const still = await store.resolveCompPlanForOfficer(db, OTHER);
    eq(still.plan.minCents, 300000, 'C3 …and everybody else still follows the company number');

    // =========================================================================
    console.log('\nD. the door\n');
    // =========================================================================

    let res = await call(H.compPlanRoute, REQ({ query: {} }));
    eq(res.statusCode, 400, 'D1 no officer is a refusal, not somebody\'s numbers by accident');

    res = await call(H.compPlanRoute, REQ({ query: { officerId: 'not-an-id' } }));
    eq(res.statusCode, 400, 'D2 …and so is an unusable id');

    res = await call(H.compPlanRoute, REQ({ query: { officerId: OFFICER } }));
    eq(res.statusCode, 200, 'D3 the plan reads back with no loan amount');
    eq(res.body.breakdown, null, 'D4 …and nothing is computed on a loan nobody named');
    eq(res.body.plan.officerMarginMilli, 3000, 'D5 …carrying his own margin');

    // With a loan and no split set, the officer's own SHARE cannot be worked out — and that is
    // reported rather than defaulted to a number this codebase invented.
    res = await call(H.compPlanRoute, REQ({ query: { officerId: OFFICER, loanAmountCents: String(100000 * 100) } }));
    eq(res.body.breakdown.ok, false, 'D6 with nobody\'s share set, the money is not worked out');
    ok(res.body.breakdown.refusals.some((x) => x.code === 'no_split'),
      'D7 …and the reason is that nobody has set the share, said plainly');

    await store.setSetting(db, SCOPE, 'comp.officer_split_pct', 60, null);
    res = await call(H.compPlanRoute, REQ({ query: { officerId: OFFICER, loanAmountCents: String(100000 * 100) } }));
    eq(res.body.breakdown.ok, true, 'D8 once the share is set the file works out');
    eq(res.body.breakdown.officer.grossCents, 3000 * 100, 'D9 3.000 points of $100,000 is $3,000');
    eq(res.body.breakdown.holdback.cents, 250 * 100, 'D10 …and the company\'s 0.25 is $250 beside it');
    eq(res.body.breakdown.holdback.split, false, 'D11 …never split');

    // The requested mode overrides the company default, and the answer says the request is why.
    res = await call(H.compPlanRoute, REQ({ query: { officerId: OFFICER, mode: 'lender_paid', loanAmountCents: String(100000 * 100) } }));
    eq(res.body.plan.mode, 'lender_paid', 'D12 a mode asked for is the mode used');
    eq(res.body.sources.mode, 'requested', 'D13 …and it is reported as asked-for, not as anybody\'s setting');

    // =========================================================================
    console.log('\nE. it prices nothing\n');
    // =========================================================================
    eq(res.body.priceEffect.applied, false, 'E1 the answer states that no price moved');
    eq(res.body.breakdown.priceEffect.applied, false, 'E2 …and so does the breakdown');
  } finally {
    await cleanup();
    await db.pool.end().catch(() => {});
  }

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
