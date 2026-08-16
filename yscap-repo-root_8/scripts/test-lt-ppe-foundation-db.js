#!/usr/bin/env node
'use strict';
/**
 * LT PPE foundation (db/558) + store bridge.
 *   - PURE section (always runs): the settings-override bridge logic against a fake db.
 *   - DB section (runs only when DATABASE_URL is set): applies db/558 and does real round-trips
 *     for investor/alias resolution, program creation, and the setting override store.
 *
 *   node scripts/test-lt-ppe-foundation-db.js
 *   DATABASE_URL=postgres://… node scripts/test-lt-ppe-foundation-db.js
 */
const fs = require('fs');
const path = require('path');
const store = require('../src/longterm/ppe/store');
const settings = require('../src/longterm/ppe/settings');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }

(async () => {
  console.log('LT PPE foundation — pure bridge\n');

  // ---- PURE: the settings bridge against a fake db --------------------------
  // loadSettingOverrides keeps only real definition keys; unknown/legacy keys are dropped.
  const fakeRows = [
    { key: 'pricing.correspondent_margin_milli', value: 375 },
    { key: 'legacy.removed_setting', value: 1 },              // not a definition → dropped
  ];
  const fakeDb = { query: async () => ({ rows: fakeRows }) };
  const ov = await store.loadSettingOverrides(fakeDb, 'company');
  ok(ov['pricing.correspondent_margin_milli'] === 375 && !('legacy.removed_setting' in ov),
    'loadSettingOverrides keeps real keys and drops unknown ones');

  const resolved = await store.resolveSettings(fakeDb, 'company');
  ok(resolved.values['pricing.correspondent_margin_milli'] === 375 && resolved.sources['pricing.correspondent_margin_milli'] === 'tenant',
    'resolveSettings overlays the stored override on the coded defaults');
  ok(resolved.values['cutover.clean_weeks_required'] === 8, 'an un-overridden setting resolves to the coded default (8 weeks)');

  // An unreadable table degrades to the coded defaults (never throws).
  const throwingDb = { query: async () => { throw new Error('boom'); } };
  const degraded = await store.loadSettingOverrides(throwingDb, 'company');
  ok(Object.keys(degraded).length === 0, 'an unreadable override table degrades to {} (coded defaults win)');

  // setSetting validates against the definition BEFORE writing.
  let wrote = null;
  const capturingDb = { query: async (t, p) => { wrote = { t, p }; return { rows: [] }; } };
  ok((await store.setSetting(capturingDb, 'company', 'pricing.correspondent_margin_milli', 300)).ok === true && wrote,
    'setSetting writes a valid value');
  wrote = null;
  const bad = await store.setSetting(capturingDb, 'company', 'pricing.correspondent_margin_milli', 99999);
  ok(bad.ok === false && wrote === null, 'setSetting REFUSES an out-of-range value and writes nothing');
  ok((await store.setSetting(capturingDb, 'company', 'nope.not.a.key', 1)).ok === false, 'setSetting refuses an unknown key');

  // normAlias.
  ok(store.normAlias('Deephaven Mortgage, LLC') === 'deephavenmortgagellc', 'normAlias strips case + punctuation');

  // ---- DB round-trip (only with DATABASE_URL) -------------------------------
  if (!process.env.DATABASE_URL) {
    console.log('\n(DB round-trip skipped — set DATABASE_URL to run it.)');
    console.log(`\n${failures ? failures + ' FAILED' : 'all passed (pure)'}`);
    process.exit(failures ? 1 : 0);
  }

  console.log('\nLT PPE foundation — DB round-trip\n');
  const { Pool } = require('pg');
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'db', '558_lt_ppe_foundation.sql'), 'utf8');
    await db.query(sql); // idempotent — safe to re-run
    ok(true, 'db/558 applied (idempotent)');

    const scope = 'test_' + Math.abs((process.pid || 1)); // isolate this run
    await db.query('DELETE FROM lt_ppe_program WHERE scope = $1', [scope]);
    await db.query('DELETE FROM lt_ppe_investor_alias WHERE scope = $1', [scope]);
    await db.query('DELETE FROM lt_ppe_investor WHERE scope = $1', [scope]);
    await db.query('DELETE FROM lt_ppe_setting_value WHERE scope = $1', [scope]);

    const inv = await store.createInvestor(db, scope, { code: 'DHVN', name: 'Deephaven Mortgage' });
    ok(inv && inv.id, 'createInvestor returns a row');
    const found = await store.findInvestorByName(db, scope, 'deephaven mortgage');
    ok(found && found.id === inv.id, 'findInvestorByName resolves a spelling via the alias table');
    const foundByCode = await store.findInvestorByName(db, scope, 'DHVN');
    ok(foundByCode && foundByCode.id === inv.id, 'the code is registered as an alias too');

    const prog = await store.createProgram(db, scope, { investorId: inv.id, code: 'DSCR30', name: 'DSCR 30yr' });
    ok(prog && prog.channel === 'correspondent' && prog.status === 'draft', 'createProgram defaults channel=correspondent, status=draft');
    const progs = await store.listPrograms(db, scope, inv.id);
    ok(progs.length === 1, 'listPrograms returns the created program');

    // Setting override round-trip against the real table.
    await store.setSetting(db, scope, 'cutover.clean_weeks_required', 6, null);
    const r6 = await store.resolveSetting(db, 'cutover.clean_weeks_required', scope);
    ok(r6.value === 6 && r6.source === 'tenant', 'a stored override resolves from the DB');
    await store.clearSetting(db, scope, 'cutover.clean_weeks_required');
    const rDefault = await store.resolveSetting(db, 'cutover.clean_weeks_required', scope);
    ok(rDefault.value === 8 && rDefault.source === 'product_default', 'clearing an override reverts to the coded default');

    // cleanup
    await db.query('DELETE FROM lt_ppe_program WHERE scope = $1', [scope]);
    await db.query('DELETE FROM lt_ppe_investor_alias WHERE scope = $1', [scope]);
    await db.query('DELETE FROM lt_ppe_investor WHERE scope = $1', [scope]);
    await db.query('DELETE FROM lt_ppe_setting_value WHERE scope = $1', [scope]);
  } finally {
    await db.end();
  }

  console.log(`\n${failures ? failures + ' FAILED' : 'all passed'}`);
  process.exit(failures ? 1 : 0);
})();
