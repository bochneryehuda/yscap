#!/usr/bin/env node
'use strict';

/**
 * The gate that guards the gate.
 *
 * `scripts/check-product-separation.js` is what keeps Residential Transition Loans
 * and Long-Term Loans from growing into each other (owner-directed 2026-08-02).
 * A guard nobody tests is a guard that quietly stops guarding — so this suite
 * builds a throwaway copy of the repo layout, plants each violation the owner
 * cares about, and proves the gate FAILS on it and PASSES without it.
 *
 * It also proves the two things a naive checker gets wrong: a module named inside
 * a comment is not an import, and a crossing the owner authorized IN WRITING
 * (recorded in docs/LONG-TERM-AUTHORIZED-COPIES.md) is allowed through.
 *
 * No database, no network, no deps.
 *
 *   node scripts/test-product-separation-gate.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const GATE = path.join(__dirname, 'check-product-separation.js');

let passed = 0;
const failures = [];

function write(root, relPath, body) {
  const p = path.join(root, relPath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
}

// A minimal but complete fixture: git root + the nested project folder, with every
// rule document the gate insists on, and a couple of RTL files to cross toward.
function makeFixture(ledgerLines = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sep-gate-'));
  const app = path.join(root, 'yscap-repo-root_8');

  write(root, 'AGENTS.md', '# AGENTS\n\nThere are TWO products and they never mix.\n');
  write(root, '.github/PRODUCT-SEPARATION.md', '# PILOT has TWO products.\n');
  write(root, '.github/pull_request_template.md', '## Which product is this for?\n');
  write(app, 'CLAUDE.md', '# CLAUDE.md\n\n## TWO PRODUCTS, TWO SYSTEMS\n');
  write(app, 'docs/LONG-TERM-LOANS-SEPARATION-CHARTER.md', '# charter\n');
  write(app, 'docs/LONG-TERM-AUTHORIZED-COPIES.md',
    '# ledger\n\n```authorized\n# nothing authorized\n' + ledgerLines.join('\n') + (ledgerLines.length ? '\n' : '') + '```\n');

  // RTL code that a Long-Term module might be tempted to reach for.
  write(app, 'src/lib/crypto.js', 'module.exports = {};\n');
  write(app, 'src/server.js', "const express = require('express');\n");
  write(app, 'src/routes/staff.js', "const crypto = require('../lib/crypto.js');\n");
  write(app, 'db/schema.sql', 'CREATE TABLE applications (id uuid PRIMARY KEY);\n');

  fs.mkdirSync(path.join(app, 'scripts'), { recursive: true });
  fs.copyFileSync(GATE, path.join(app, 'scripts', 'check-product-separation.js'));
  return { root, app };
}

function runGate(app) {
  try {
    const out = execFileSync(process.execPath, [path.join(app, 'scripts', 'check-product-separation.js')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status === undefined ? -1 : e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

/**
 * @param name      what is being proved
 * @param setup     (app) => void — plants the scenario
 * @param expect    'pass' | 'fail'
 * @param mustSay   substring the failure message must contain (fail cases only)
 * @param ledger    lines to place in the authorized block
 */
function scenario(name, setup, expect, mustSay, ledger) {
  const { root, app } = makeFixture(ledger || []);
  let verdict;
  try {
    setup(app);
    const { code, out } = runGate(app);
    if (expect === 'pass' && code !== 0) verdict = `expected a PASS, got exit ${code}:\n${out}`;
    else if (expect === 'fail' && code === 0) verdict = `expected a FAILURE, but the gate passed:\n${out}`;
    else if (expect === 'fail' && mustSay && !out.includes(mustSay)) {
      verdict = `failed as expected, but the message never said "${mustSay}":\n${out}`;
    }
  } catch (e) {
    verdict = 'threw: ' + e.message;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  if (verdict) { failures.push(`${name}\n      ${verdict.split('\n').join('\n      ')}`); console.log('  ✗ ' + name); }
  else { passed++; console.log('  ✓ ' + name); }
}

console.log('Two-product separation gate — behaviour');

// ---- the baseline -----------------------------------------------------------
scenario('a repo with no Long-Term code at all passes', () => {}, 'pass');

scenario('Long-Term code that only talks to itself passes', (app) => {
  write(app, 'src/longterm/lib/loan.js', "const util = require('node:util');\nmodule.exports = {};\n");
  write(app, 'src/longterm/routes/index.js', "const loan = require('../lib/loan.js');\nconst express = require('express');\n");
}, 'pass');

// ---- 1. Long-Term reaching into RTL ----------------------------------------
scenario('Long-Term importing an RTL module FAILS', (app) => {
  write(app, 'src/longterm/lib/loan.js', "const crypto = require('../../lib/crypto.js');\n");
}, 'fail', 'imports RTL code');

scenario('…and passes once the owner authorized it in the ledger', (app) => {
  write(app, 'src/longterm/lib/loan.js', "const crypto = require('../../lib/crypto.js');\n");
}, 'pass', null, ['import src/lib/crypto.js']);

scenario('an RTL module named in a COMMENT is not an import', (app) => {
  write(app, 'src/longterm/lib/loan.js',
    "// we deliberately do NOT require('../../lib/crypto.js') here — Long-Term starts at zero.\n" +
    "/* see require('../../routes/staff.js') for how RTL does it */\nmodule.exports = {};\n");
}, 'pass');

scenario('an ES import from RTL FAILS too (not just require)', (app) => {
  write(app, 'src/longterm/lib/loan.js', "import crypto from '../../lib/crypto.js';\n");
}, 'fail', 'imports RTL code');

scenario('a Long-Term import of an RTL module that does not exist yet still FAILS', (app) => {
  write(app, 'src/longterm/lib/loan.js', "const c = require('../../lib/conditions/engine.js');\n");
}, 'fail', 'imports RTL code');

// ---- 2. RTL reaching into Long-Term ----------------------------------------
scenario('RTL importing Long-Term FAILS', (app) => {
  write(app, 'src/longterm/routes/index.js', 'module.exports = {};\n');
  write(app, 'src/routes/staff.js', "const lt = require('../longterm/routes/index.js');\n");
}, 'fail', 'imports Long-Term code');

scenario('server.js mounting the Long-Term router is the one permitted seam', (app) => {
  write(app, 'src/longterm/routes/index.js', 'module.exports = {};\n');
  write(app, 'src/server.js', "const lt = require('./longterm/routes/index.js');\n");
}, 'pass');

// ---- 3. foreign keys across the line ---------------------------------------
scenario('an lt_ table with a foreign key to an RTL table FAILS', (app) => {
  write(app, 'db/500_lt_loans.sql',
    'CREATE TABLE IF NOT EXISTS lt_loans (id uuid PRIMARY KEY, borrower_id uuid REFERENCES borrowers(id));\n');
}, 'fail', 'foreign key to the RTL table');

scenario('…and passes once that exact table is authorized in the ledger', (app) => {
  write(app, 'db/500_lt_loans.sql',
    'CREATE TABLE IF NOT EXISTS lt_loans (id uuid PRIMARY KEY, borrower_id uuid REFERENCES borrowers(id));\n');
}, 'pass', null, ['sql-ref borrowers']);

scenario('an lt_ table referencing another lt_ table passes', (app) => {
  write(app, 'db/500_lt_loans.sql',
    'CREATE TABLE IF NOT EXISTS lt_loans (id uuid PRIMARY KEY);\n' +
    'CREATE TABLE IF NOT EXISTS lt_loan_notes (id uuid PRIMARY KEY, loan_id uuid REFERENCES lt_loans(id));\n');
}, 'pass');

scenario('an RTL table pointing at a Long-Term table FAILS', (app) => {
  write(app, 'db/501_rtl.sql',
    'CREATE TABLE IF NOT EXISTS rtl_thing (id uuid PRIMARY KEY, lt_id uuid REFERENCES lt_loans(id));\n');
}, 'fail', 'RTL table');

scenario('a cross-product foreign key added by ALTER TABLE FAILS', (app) => {
  write(app, 'db/502_lt_alter.sql',
    'ALTER TABLE lt_loans ADD COLUMN borrower_id uuid REFERENCES borrowers(id);\n');
}, 'fail', 'foreign key to the RTL table');

// ---- 4. Long-Term columns on RTL tables ------------------------------------
scenario('adding an lt_ column to applications FAILS', (app) => {
  write(app, 'db/503_col.sql', 'ALTER TABLE applications ADD COLUMN IF NOT EXISTS lt_flag boolean;\n');
}, 'fail', 'is being added to the RTL table');

scenario('adding a long_term_ column to an RTL table FAILS', (app) => {
  write(app, 'db/504_col.sql', 'ALTER TABLE applications ADD COLUMN IF NOT EXISTS long_term_rate numeric;\n');
}, 'fail', 'is being added to the RTL table');

scenario('an ordinary RTL column change is untouched by the gate', (app) => {
  write(app, 'db/505_col.sql', 'ALTER TABLE applications ADD COLUMN IF NOT EXISTS rehab_type text;\n');
}, 'pass');

// ---- 5. one migration touching both products -------------------------------
scenario('a migration that touches BOTH products FAILS', (app) => {
  write(app, 'db/506_mixed.sql',
    'CREATE TABLE IF NOT EXISTS lt_loans (id uuid PRIMARY KEY);\n' +
    'ALTER TABLE applications ADD COLUMN IF NOT EXISTS note text;\n');
}, 'fail', 'touches BOTH products');

// ---- 6. triggers carrying one product's logic onto the other ---------------
scenario('an RTL trigger function firing on an lt_ table FAILS', (app) => {
  write(app, 'db/507_trg.sql',
    'CREATE TABLE IF NOT EXISTS lt_loans (id uuid PRIMARY KEY);\n' +
    'CREATE TRIGGER trg_lt AFTER UPDATE ON lt_loans FOR EACH ROW EXECUTE FUNCTION pilot_reopen_pricing();\n');
}, 'fail', 'runs the RTL function');

scenario('a Long-Term trigger with its own function in the same migration passes', (app) => {
  write(app, 'db/508_trg.sql',
    'CREATE TABLE IF NOT EXISTS lt_loans (id uuid PRIMARY KEY);\n' +
    'CREATE OR REPLACE FUNCTION lt_touch() RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql;\n' +
    'CREATE TRIGGER trg_lt AFTER UPDATE ON lt_loans FOR EACH ROW EXECUTE FUNCTION lt_touch();\n');
}, 'pass');

scenario('a Long-Term function firing on an RTL table FAILS', (app) => {
  write(app, 'db/509_trg.sql',
    'CREATE TRIGGER trg_rtl AFTER UPDATE ON applications FOR EACH ROW EXECUTE FUNCTION lt_sync();\n');
}, 'fail', 'must never fire on an RTL table');

scenario('SQL inside a comment does not trip the gate', (app) => {
  write(app, 'db/510_comment.sql',
    '-- ALTER TABLE applications ADD COLUMN lt_flag boolean;\n' +
    '/* CREATE TABLE lt_loans (borrower_id uuid REFERENCES borrowers(id)); */\n' +
    'ALTER TABLE applications ADD COLUMN IF NOT EXISTS note text;\n');
}, 'pass');

// ---- 7. the rules themselves must stay put ---------------------------------
scenario('deleting AGENTS.md FAILS the build', (app) => {
  fs.rmSync(path.join(app, '..', 'AGENTS.md'));
}, 'fail', 'Rule document is missing');

scenario('gutting the CLAUDE.md rule FAILS the build', (app) => {
  write(app, 'CLAUDE.md', '# CLAUDE.md\n\nnothing to see here\n');
}, 'fail', 'no longer states the rule');

scenario('deleting the ledger FAILS the build', (app) => {
  fs.rmSync(path.join(app, 'docs', 'LONG-TERM-AUTHORIZED-COPIES.md'));
}, 'fail', 'ledger is missing');

scenario('a malformed ledger line FAILS the build', () => {}, 'fail', 'Unreadable ledger line',
  ['import src/lib/crypto.js because we felt like it']);

// ---- report -----------------------------------------------------------------
if (failures.length) {
  console.error(`\n  ✗ ${failures.length} of ${failures.length + passed} checks failed:\n`);
  for (const f of failures) console.error('  ✗ ' + f + '\n');
  process.exit(1);
}
console.log(`\n  ✓ ${passed} checks passed — the separation gate does what it promises.`);
