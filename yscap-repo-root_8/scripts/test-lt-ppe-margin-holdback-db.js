#!/usr/bin/env node
'use strict';
/**
 * LT PPE per-investor margin & holdback resolution (Layer 1) — store bridge test.
 *   - PURE section (always runs): investorScope + the layered resolver against a fake db.
 *   - DB section (DATABASE_URL set): real overrides in lt_ppe_setting_value under a
 *     `company` scope and an `investor:<code>` scope, proving the layering.
 *
 * Owner rule (2026-08-16): margin + holdback per investor, pre-filled 0.250, changeable,
 * different margins/holdbacks per scenario via rules.
 *
 *   node scripts/test-lt-ppe-margin-holdback-db.js
 *   DATABASE_URL=postgres://… node scripts/test-lt-ppe-margin-holdback-db.js
 */
const fs = require('fs');
const path = require('path');
const store = require('../src/longterm/ppe/store');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }

(async () => {
  console.log('LT PPE margin/holdback store — pure bridge\n');

  // investorScope
  ok(store.investorScope('DHVN') === 'investor:DHVN', 'investorScope prefixes the code');
  ok(store.investorScope('  ') === null, 'investorScope of a blank code is null (degrades to company scope)');

  // A fake db that serves different overrides per scope.
  function fakeDbForScopes(byScope) {
    return { query: async (_t, p) => ({ rows: byScope[p[0]] || [] }) };
  }

  // 1) No overrides anywhere → the 0.250 pre-fill for both, sourced product_default.
  {
    const db = fakeDbForScopes({});
    const r = await store.resolveMarginHoldbackForInvestor(db, 'DHVN', {});
    ok(r.marginMilli === 250 && r.holdbackMilli === 250, 'no overrides → 0.250 pre-fill for both');
    ok(r.defaults.margin.source === 'product_default' && r.defaults.holdback.source === 'product_default', 'defaults sourced product_default');
    ok(r.investorScope === 'investor:DHVN', 'the investor scope is reported');
  }

  // 2) A COMPANY override applies to every investor; a per-INVESTOR override wins over it.
  {
    const db = fakeDbForScopes({
      company: [{ key: 'pricing.margin_milli', value: 300 }, { key: 'pricing.holdback_milli', value: 300 }],
      'investor:DHVN': [{ key: 'pricing.margin_milli', value: 400 }],
    });
    const dhvn = await store.resolveMarginHoldbackForInvestor(db, 'DHVN', {});
    ok(dhvn.marginMilli === 400 && dhvn.defaults.margin.source === 'tenant', 'investor margin override wins over company');
    ok(dhvn.holdbackMilli === 300 && dhvn.defaults.holdback.source === 'org', 'company holdback applies when the investor is silent');

    const other = await store.resolveMarginHoldbackForInvestor(db, 'OTHR', {});
    ok(other.marginMilli === 300 && other.holdbackMilli === 300, 'a different investor gets the company defaults (reaching every investor)');
  }

  // 3) A per-scenario rule (stored on the investor scope) overrides for the matching scenario only.
  {
    const rules = [{ code: 'ny', when: { all: [{ fact: 'state', op: 'eq', value: 'NY' }] }, holdbackMilli: 500 }];
    const db = fakeDbForScopes({
      'investor:DHVN': [{ key: 'pricing.margin_holdback_rules', value: rules }],
    });
    const ny = await store.resolveMarginHoldbackForInvestor(db, 'DHVN', { state: 'NY' });
    ok(ny.holdbackMilli === 500 && ny.holdbackSource === 'rule', 'NY scenario picks up the per-scenario holdback rule');
    const fl = await store.resolveMarginHoldbackForInvestor(db, 'DHVN', { state: 'FL' });
    ok(fl.holdbackMilli === 250 && fl.holdbackSource === 'default', 'FL scenario falls back to the default holdback');
  }

  // 4) An unreadable table degrades to the coded defaults (never throws).
  {
    const throwingDb = { query: async () => { throw new Error('boom'); } };
    const r = await store.resolveMarginHoldbackForInvestor(throwingDb, 'DHVN', {});
    ok(r.marginMilli === 250 && r.holdbackMilli === 250, 'unreadable table → 0.250 product defaults (never throws)');
  }

  // ---- DB round-trip (only with DATABASE_URL) -------------------------------
  if (!process.env.DATABASE_URL) {
    console.log('\n(DB round-trip skipped — set DATABASE_URL to run it.)');
    console.log(`\n${failures ? failures + ' FAILED' : 'all passed (pure)'}`);
    process.exit(failures ? 1 : 0);
  }

  console.log('\nLT PPE margin/holdback — DB round-trip\n');
  const { Pool } = require('pg');
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'db', '558_lt_ppe_foundation.sql'), 'utf8');
    await db.query(sql); // idempotent
    const scope = 'company_test_' + Math.abs(process.pid || 1);
    const invScope = 'investor:MHDB_' + Math.abs(process.pid || 1);
    const clean = async () => {
      await db.query('DELETE FROM lt_ppe_setting_value WHERE scope IN ($1, $2)', [scope, invScope]);
    };
    await clean();

    // Company defaults: margin 300, holdback 300.
    await store.setSetting(db, scope, 'pricing.margin_milli', 300);
    await store.setSetting(db, scope, 'pricing.holdback_milli', 300);
    // Investor MHDB: margin 400, and a per-scenario rule bumping the NY holdback.
    await store.setSetting(db, invScope, 'pricing.margin_milli', 400);
    await store.setSetting(db, invScope, 'pricing.margin_holdback_rules',
      [{ code: 'ny', when: { all: [{ fact: 'state', op: 'eq', value: 'NY' }] }, holdbackMilli: 500 }]);

    const invCode = 'MHDB_' + Math.abs(process.pid || 1);
    const fl = await store.resolveMarginHoldbackForInvestor(db, invCode, { state: 'FL' }, scope);
    ok(fl.marginMilli === 400 && fl.defaults.margin.source === 'tenant', 'DB: investor margin 400 wins over company 300');
    ok(fl.holdbackMilli === 300 && fl.defaults.holdback.source === 'org', 'DB: company holdback 300 applies (investor silent)');

    const ny = await store.resolveMarginHoldbackForInvestor(db, invCode, { state: 'NY' }, scope);
    ok(ny.holdbackMilli === 500 && ny.holdbackSource === 'rule', 'DB: per-scenario NY rule overrides holdback to 500');
    ok(ny.marginMilli === 400, 'DB: NY scenario keeps the investor margin');

    // An investor with no overrides gets the company defaults.
    const bare = await store.resolveMarginHoldbackForInvestor(db, 'NOOVERRIDE_' + process.pid, {}, scope);
    ok(bare.marginMilli === 300 && bare.holdbackMilli === 300, 'DB: an un-overridden investor reaches the company defaults');

    await clean();
  } finally {
    await db.end();
  }

  console.log(`\n${failures ? failures + ' FAILED' : 'all passed'}`);
  process.exit(failures ? 1 : 0);
})();
