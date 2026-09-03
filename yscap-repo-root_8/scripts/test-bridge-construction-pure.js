'use strict';
/**
 * A BRIDGE WITHOUT CONSTRUCTION CARRIES NO BUDGET / SOW CONDITIONS — the JS half
 * (owner-directed 2026-09-03). The SQL twin and the trigger are proven against a
 * real database in test-bridge-construction-db.js; this file pins the rule
 * itself and the wiring that has to exist for the rule to reach a file.
 *
 * Proven to fail: (1) the `with\s+construction` test removed — "Bridge With
 * Construction" went red; (2) the budget test removed — the typed-budget case
 * went red; (3) the fix & hold test removed — "Bridge / Fix & Hold" went red;
 * (4) `CONSTRUCTION_ONLY_CODES` reference removed from generateChecklist — the
 * source guard went red.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { isBridgeWithoutConstruction, CONSTRUCTION_ONLY_CODES } = require('../src/lib/conditions/bridge-construction');

let n = 0;
const eq = (a, b, w) => { assert.strictEqual(a, b, w); console.log('  ok  ', w); n++; };
const ok = (c, w) => { assert.ok(c, w); console.log('  ok  ', w); n++; };

console.log('\nA. the rule, case by case (the same battery the DB twin runs)');
const BATTERY = require('./lib/bridge-construction-battery');
for (const c of BATTERY) {
  eq(isBridgeWithoutConstruction(c.row), c.expect, `${c.why} → ${c.expect ? 'NO budget/SOW' : 'keeps them'}`);
}

console.log('\nB. the three conditions, and nothing else');
eq(JSON.stringify([...CONSTRUCTION_ONLY_CODES]), JSON.stringify(['rtl_p1_budget', 'rtl_p3_sow1', 'rtl_p3_sow2']),
  'the budget, the SOW from the borrower, the SOW to the appraiser — the ground-up plans keep their own rule (db/178)');

console.log('\nC. wiring');
const src = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const borrower = src('src/routes/borrower.js');
ok(/isBridgeWithoutConstruction\(/.test(borrower) && /CONSTRUCTION_ONLY_CODES\.includes\(tpl\.code\)/.test(borrower),
  'generateChecklist asks the rule and skips exactly those codes');
ok(/rehab_budget FROM applications/.test(borrower) || /is_assignment, rehab_budget/.test(borrower),
  'generateChecklist reads the rehab budget off the file (the rule needs it)');
const mig = src('db/691_bridge_without_construction_carries_no_budget_or_scope_of_wo.sql');
ok(/CREATE OR REPLACE FUNCTION pilot_bridge_without_construction/.test(mig), 'the SQL twin exists');
for (const code of CONSTRUCTION_ONLY_CODES) ok(mig.includes(`'${code}'`), `the trigger names ${code}`);
ok(/UPDATE OF program, loan_type, rehab_type, rehab_budget ON applications/.test(mig),
  'the trigger fires on the four columns the rule reads');
ok(/NOT EXISTS \(SELECT 1 FROM documents d WHERE d\.checklist_item_id = ci\.id\)/.test(mig),
  'only an UNTOUCHED condition is taken off — a document keeps its row');

console.log(`\ntest-bridge-construction-pure: ${n} assertions passed — a bridge that builds nothing is asked for no budget and no scope of work; fix & flip, fix & hold and ground-up still are.`);
