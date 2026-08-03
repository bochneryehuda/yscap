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
 * It covers the crossings that need no import at all (raw SQL against the other
 * product's tables), the parser traps that a naive checker falls into (a module
 * named in a comment or a string, a regex literal containing "//", a statement with
 * no trailing semicolon, a quoted schema-qualified table name), and the gate's own
 * wiring — because a gate that has been unwired from `npm test` fails nothing.
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
// rule document and every piece of wiring the gate insists on, plus a little RTL to
// cross toward.
function makeFixture(ledgerLines = [], ledgerTail = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sep-gate-'));
  const app = path.join(root, 'yscap-repo-root_8');

  write(root, 'AGENTS.md', '# AGENTS\n\nThere are TWO products and they never mix.\n');
  write(root, '.github/PRODUCT-SEPARATION.md', '# PILOT has TWO products.\n');
  write(root, '.github/pull_request_template.md', '## Which product is this for?\n');
  write(root, '.github/workflows/test.yml', 'jobs:\n  test:\n    steps:\n      - run: npm test\n');
  write(app, 'CLAUDE.md', '# CLAUDE.md\n\n## TWO PRODUCTS, TWO SYSTEMS\n');
  write(app, 'docs/LONG-TERM-LOANS-SEPARATION-CHARTER.md', '# charter\n');
  write(app, 'package.json', JSON.stringify({
    scripts: { test: 'node scripts/check-product-separation.js && node scripts/test-product-separation-gate.js' },
  }, null, 2) + '\n');
  write(app, 'docs/LONG-TERM-AUTHORIZED-COPIES.md',
    '# ledger\n\n```authorized\n# nothing authorized\n' + ledgerLines.join('\n') +
    (ledgerLines.length ? '\n' : '') + '```\n' + ledgerTail);

  // RTL code a Long-Term module might be tempted to reach for.
  write(app, 'src/lib/crypto.js', 'module.exports = {};\n');
  write(app, 'src/db.js', 'module.exports = { query: () => {} };\n');
  write(app, 'src/server.js', "const express = require('express');\n");
  write(app, 'src/routes/staff.js', "const crypto = require('../lib/crypto.js');\n");
  write(app, 'app-v2/src/components/Layout.jsx', 'export const Brand = () => null;\n');
  write(app, 'app-v2/src/screens/StaffQueue.jsx', "import { Brand } from '../components/Layout.jsx';\n");
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
 * @param setup     (app, root) => void — plants the scenario
 * @param expect    'pass' | 'fail'
 * @param mustSay   substring the failure message must contain (fail cases only)
 * @param opts      { ledger: string[], ledgerTail: string }
 */
function scenario(name, setup, expect, mustSay, opts = {}) {
  const { root, app } = makeFixture(opts.ledger || [], opts.ledgerTail || '');
  let verdict;
  try {
    setup(app, root);
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
}, 'pass', null, { ledger: ['import src/lib/crypto.js'] });

scenario('ledger authorization is PER ITEM, not blanket', (app) => {
  write(app, 'src/longterm/lib/loan.js',
    "const crypto = require('../../lib/crypto.js');\nconst db = require('../../db.js');\n");
}, 'fail', 'src/db.js', { ledger: ['import src/lib/crypto.js'] });

scenario('an ES import from RTL FAILS too (not just require)', (app) => {
  write(app, 'src/longterm/lib/loan.js', "import crypto from '../../lib/crypto.js';\n");
}, 'fail', 'imports RTL code');

scenario('a Long-Term import of an RTL module that does not exist yet still FAILS', (app) => {
  write(app, 'src/longterm/lib/loan.js', "const c = require('../../lib/conditions/engine.js');\n");
}, 'fail', 'imports RTL code');

// ---- parser traps -----------------------------------------------------------
scenario('an RTL module named in a COMMENT is not an import', (app) => {
  write(app, 'src/longterm/lib/loan.js',
    "// we deliberately do NOT require('../../lib/crypto.js') here — Long-Term starts at zero.\n" +
    "/* see require('../../routes/staff.js') for how RTL does it */\nmodule.exports = {};\n");
}, 'pass');

scenario('an RTL module named inside a STRING is not an import', (app) => {
  write(app, 'src/longterm/lib/loan.js',
    'const msg = "never require(\'../../lib/crypto.js\') from Long-Term";\n' +
    'const hint = `see require(\'../../db.js\') in the RTL code`;\nmodule.exports = { msg, hint };\n');
}, 'pass');

scenario('a regex literal containing "//" cannot hide a crossing on the same line', (app) => {
  write(app, 'src/longterm/lib/loan.js',
    "const url = /https?:\\/\\//; const crypto = require('../../lib/crypto.js');\n");
}, 'fail', 'imports RTL code');

// ---- 2. RTL reaching into Long-Term ----------------------------------------
scenario('RTL importing Long-Term FAILS', (app) => {
  write(app, 'src/longterm/routes/index.js', 'module.exports = {};\n');
  write(app, 'src/routes/staff.js', "const lt = require('../longterm/routes/index.js');\n");
}, 'fail', 'imports Long-Term code');

scenario('server.js mounting the Long-Term ROUTER is the one permitted seam', (app) => {
  write(app, 'src/longterm/routes/index.js', 'module.exports = {};\n');
  write(app, 'src/server.js', "const lt = require('./longterm/routes/index.js');\napp.use('/api/lt', lt);\n");
}, 'pass');

scenario('server.js reaching PAST the router into Long-Term internals FAILS', (app) => {
  write(app, 'src/longterm/lib/loan.js', 'module.exports = {};\n');
  write(app, 'src/server.js', "const loan = require('./longterm/lib/loan.js');\n");
}, 'fail', 'imports Long-Term code');

scenario("Long-Term's own tests may import Long-Term", (app) => {
  write(app, 'src/longterm/lib/loan.js', 'module.exports = {};\n');
  write(app, 'scripts/test-lt-loan.js', "const loan = require('../src/longterm/lib/loan.js');\n");
}, 'pass');

scenario('an RTL test importing Long-Term FAILS', (app) => {
  write(app, 'src/longterm/lib/loan.js', 'module.exports = {};\n');
  write(app, 'scripts/test-pricing.js', "const loan = require('../src/longterm/lib/loan.js');\n");
}, 'fail', 'imports Long-Term code');

scenario('an RTL file may import Long-Term once the ledger says so', (app) => {
  write(app, 'src/longterm/routes/index.js', 'module.exports = {};\n');
  write(app, 'src/worker.js', "const lt = require('./longterm/routes/index.js');\n");
}, 'pass', null, { ledger: ['rtl-import src/worker.js'] });

// ---- front end --------------------------------------------------------------
scenario('a Long-Term SCREEN importing an RTL component FAILS', (app) => {
  write(app, 'app-v2/src/longterm/LtPipeline.jsx', "import { Brand } from '../components/Layout.jsx';\n");
}, 'fail', 'imports RTL code');

scenario('an RTL screen importing a Long-Term screen FAILS', (app) => {
  write(app, 'app-v2/src/longterm/LtPipeline.jsx', 'export default () => null;\n');
  write(app, 'app-v2/src/screens/StaffQueue.jsx', "import Lt from '../longterm/LtPipeline.jsx';\n");
}, 'fail', 'imports Long-Term code');

scenario('a Long-Term screen that only uses its own code passes', (app) => {
  write(app, 'app-v2/src/longterm/api.js', 'export const list = () => [];\n');
  write(app, 'app-v2/src/longterm/LtPipeline.jsx', "import { list } from './api.js';\nimport React from 'react';\n");
}, 'pass');

scenario('a dynamic require() inside Long-Term FAILS', (app) => {
  write(app, 'src/longterm/lib/loan.js',
    "const path = require('node:path');\nconst mod = require(path.join(__dirname, '..', '..', 'lib', 'crypto.js'));\n");
}, 'fail', 'dynamic require');

scenario('a template-literal require inside Long-Term FAILS', (app) => {
  write(app, 'src/longterm/lib/loan.js', 'const mod = require(`../../lib/${name}.js`);\n');
}, 'fail', 'dynamic require');

scenario('RTL keeps its dynamic requires (a live idiom there)', (app) => {
  write(app, 'src/lib/esign/pdf.js', "const path = require('node:path');\nconst mod = require(path.join(__dirname, 'x.js'));\n");
}, 'pass');

// ---- 7. the crossing that needs no import ----------------------------------
scenario('Long-Term reading an RTL table in raw SQL FAILS', (app) => {
  write(app, 'src/longterm/lib/loan.js',
    "const db = require('pg');\nasync function f(){ return db.query('SELECT id FROM applications WHERE id=$1'); }\n");
}, 'fail', 'reads or writes the RTL table');

scenario('Long-Term WRITING an RTL table in raw SQL FAILS', (app) => {
  write(app, 'src/longterm/lib/loan.js',
    "async function f(db){ return db.query('UPDATE applications SET status=$1 WHERE id=$2'); }\n");
}, 'fail', 'reads or writes the RTL table');

scenario('…and passes once the owner authorized that table in the ledger', (app) => {
  write(app, 'src/longterm/lib/loan.js',
    "async function f(db){ return db.query('SELECT id FROM applications WHERE id=$1'); }\n");
}, 'pass', null, { ledger: ['sql-read applications'] });

scenario('Long-Term SQL against its own tables passes, CTEs and all', (app) => {
  write(app, 'src/longterm/lib/loan.js',
    "async function f(db){ return db.query(`WITH recent AS (SELECT id FROM lt_loans) SELECT * FROM recent JOIN lt_loan_notes ON true`); }\n");
}, 'pass');

scenario('RTL reading a Long-Term table in raw SQL FAILS', (app) => {
  write(app, 'src/routes/staff.js',
    "async function f(db){ return db.query('SELECT id FROM lt_loans'); }\n");
}, 'fail', 'reads or writes the Long-Term table');

scenario('the raw-SQL exemption is narrow: another script naming an lt_ table still FAILS', (app) => {
  write(app, 'scripts/report-pipeline.js', "async function f(db){ return db.query('SELECT id FROM lt_loans'); }\n");
}, 'fail', 'reads or writes the Long-Term table');

scenario('RTL back-end code calling /api/lt FAILS', (app) => {
  write(app, 'src/routes/staff.js', "const url = '/api/lt/pipeline';\n");
}, 'fail', '/api/lt');

scenario('the front end MAY call /api/lt (one screen, both products)', (app) => {
  write(app, 'app-v2/src/screens/StaffQueue.jsx', "const url = '/api/lt/pipeline';\n");
}, 'pass');

// ---- 3. foreign keys across the line ---------------------------------------
scenario('an lt_ table with a foreign key to an RTL table FAILS', (app) => {
  write(app, 'db/500_lt_loans.sql',
    'CREATE TABLE IF NOT EXISTS lt_loans (id uuid PRIMARY KEY, borrower_id uuid REFERENCES borrowers(id));\n');
}, 'fail', 'foreign key to the RTL table');

scenario('…and passes once that exact table is authorized in the ledger', (app) => {
  write(app, 'db/500_lt_loans.sql',
    'CREATE TABLE IF NOT EXISTS lt_loans (id uuid PRIMARY KEY, borrower_id uuid REFERENCES borrowers(id));\n');
}, 'pass', null, { ledger: ['sql-ref borrowers'] });

scenario('an lt_ table referencing another lt_ table passes', (app) => {
  write(app, 'db/500_lt_loans.sql',
    'CREATE TABLE IF NOT EXISTS lt_loans (id uuid PRIMARY KEY);\n' +
    'CREATE TABLE IF NOT EXISTS lt_loan_notes (id uuid PRIMARY KEY, loan_id uuid REFERENCES lt_loans(id));\n');
}, 'pass');

scenario('an RTL table pointing at a Long-Term table FAILS', (app) => {
  write(app, 'db/501_rtl.sql',
    'CREATE TABLE IF NOT EXISTS rtl_thing (id uuid PRIMARY KEY, lt_id uuid REFERENCES lt_loans(id));\n');
}, 'fail', 'foreign key to the Long-Term table');

scenario('a cross-product foreign key added by ALTER TABLE FAILS', (app) => {
  write(app, 'db/502_lt_alter.sql',
    'ALTER TABLE lt_loans ADD COLUMN borrower_id uuid REFERENCES borrowers(id);\n');
}, 'fail', 'foreign key to the RTL table');

scenario('a quoted, schema-qualified Long-Term table is still a Long-Term table', (app) => {
  write(app, 'db/503_lt_quoted.sql',
    'CREATE TABLE IF NOT EXISTS "public"."lt_loans" (id uuid PRIMARY KEY, b uuid REFERENCES "public"."borrowers"(id));\n');
}, 'fail', 'foreign key to the RTL table');

// ---- 4. Long-Term columns on RTL tables ------------------------------------
scenario('adding an lt_ column to applications FAILS', (app) => {
  write(app, 'db/504_col.sql', 'ALTER TABLE applications ADD COLUMN IF NOT EXISTS lt_flag boolean;\n');
}, 'fail', 'is being added to the RTL table');

scenario('adding a long_term_ column to an RTL table FAILS', (app) => {
  write(app, 'db/505_col.sql', 'ALTER TABLE applications ADD COLUMN IF NOT EXISTS long_term_rate numeric;\n');
}, 'fail', 'is being added to the RTL table');

scenario('a statement with NO trailing semicolon is still checked', (app) => {
  write(app, 'db/506_col.sql', 'ALTER TABLE applications ADD COLUMN IF NOT EXISTS lt_flag boolean\n');
}, 'fail', 'is being added to the RTL table');

scenario('an ordinary RTL column change is untouched by the gate', (app) => {
  write(app, 'db/507_col.sql', 'ALTER TABLE applications ADD COLUMN IF NOT EXISTS rehab_type text;\n');
}, 'pass');

// ---- 5. one migration touching both products -------------------------------
scenario('a migration that touches BOTH products FAILS', (app) => {
  write(app, 'db/508_mixed.sql',
    'CREATE TABLE IF NOT EXISTS lt_loans (id uuid PRIMARY KEY);\n' +
    'ALTER TABLE applications ADD COLUMN IF NOT EXISTS note text;\n');
}, 'fail', 'touches BOTH products');

scenario('a Long-Term migration that UPDATEs an RTL table FAILS', (app) => {
  write(app, 'db/509_lt_seed.sql',
    'CREATE TABLE IF NOT EXISTS lt_loans (id uuid PRIMARY KEY);\n' +
    "UPDATE applications SET status='x' WHERE id IS NULL;\n");
}, 'fail', 'touches BOTH products');

scenario('a Long-Term migration that DROPs an RTL trigger FAILS', (app) => {
  write(app, 'db/510_lt_drop.sql',
    'CREATE TABLE IF NOT EXISTS lt_loans (id uuid PRIMARY KEY);\n' +
    'DROP TRIGGER IF EXISTS trg_reopen ON applications;\n');
}, 'fail', 'touches BOTH products');

// ---- 6. triggers and functions ---------------------------------------------
scenario('an RTL trigger function firing on an lt_ table FAILS', (app) => {
  write(app, 'db/511_trg.sql',
    'CREATE TABLE IF NOT EXISTS lt_loans (id uuid PRIMARY KEY);\n' +
    'CREATE TRIGGER trg_lt AFTER UPDATE ON lt_loans FOR EACH ROW EXECUTE FUNCTION pilot_reopen_pricing();\n');
}, 'fail', 'runs the non-Long-Term function');

scenario('a Long-Term migration REDEFINING an RTL function FAILS', (app) => {
  write(app, 'db/512_lt_trg.sql',
    'CREATE TABLE IF NOT EXISTS lt_loans (id uuid PRIMARY KEY);\n' +
    'CREATE OR REPLACE FUNCTION pilot_reopen_pricing() RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql;\n' +
    'CREATE TRIGGER trg_lt AFTER UPDATE ON lt_loans FOR EACH ROW EXECUTE FUNCTION pilot_reopen_pricing();\n');
}, 'fail', 'not named lt_');

scenario('a Long-Term trigger with its own lt_ function passes', (app) => {
  write(app, 'db/513_lt_trg.sql',
    'CREATE TABLE IF NOT EXISTS lt_loans (id uuid PRIMARY KEY);\n' +
    'CREATE OR REPLACE FUNCTION lt_touch() RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql;\n' +
    'CREATE TRIGGER trg_lt AFTER UPDATE ON lt_loans FOR EACH ROW EXECUTE FUNCTION lt_touch();\n');
}, 'pass');

scenario('a Long-Term function firing on an RTL table FAILS', (app) => {
  write(app, 'db/514_trg.sql',
    'CREATE TRIGGER trg_rtl AFTER UPDATE ON applications FOR EACH ROW EXECUTE FUNCTION lt_sync();\n');
}, 'fail', 'must never fire on an RTL table');

// ---- 8. naming discipline ---------------------------------------------------
scenario('a Long-Term migration creating a table not named lt_ FAILS', (app) => {
  write(app, 'db/515_lt_loans.sql', 'CREATE TABLE IF NOT EXISTS longterm_loans (id uuid PRIMARY KEY);\n');
}, 'fail', 'not named lt_');

scenario('a Long-Term-sounding table without the prefix FAILS wherever it is declared', (app) => {
  write(app, 'db/517_loans.sql', 'CREATE TABLE IF NOT EXISTS long_term_loans (id uuid PRIMARY KEY);\n');
}, 'fail', 'does not use the lt_ prefix');

scenario('an ordinary RTL table name is not mistaken for Long-Term', (app) => {
  write(app, 'db/518_rtl.sql', 'CREATE TABLE IF NOT EXISTS loan_terms (id uuid PRIMARY KEY);\n');
}, 'pass');

scenario('SQL inside a comment does not trip the gate', (app) => {
  write(app, 'db/516_comment.sql',
    '-- ALTER TABLE applications ADD COLUMN lt_flag boolean;\n' +
    '/* CREATE TABLE lt_loans (borrower_id uuid REFERENCES borrowers(id)); */\n' +
    'ALTER TABLE applications ADD COLUMN IF NOT EXISTS note text;\n');
}, 'pass');

// ---- 9. the rules, and the wiring, must stay put ---------------------------
for (const [label, file] of [
  ['AGENTS.md', '../AGENTS.md'],
  ['.github/PRODUCT-SEPARATION.md', '../.github/PRODUCT-SEPARATION.md'],
  ['the PR template', '../.github/pull_request_template.md'],
  ['the charter', 'docs/LONG-TERM-LOANS-SEPARATION-CHARTER.md'],
  ['the ledger', 'docs/LONG-TERM-AUTHORIZED-COPIES.md'],
]) {
  scenario(`deleting ${label} FAILS the build`, (app) => {
    fs.rmSync(path.join(app, file));
  }, 'fail', 'missing');
}

scenario('gutting the CLAUDE.md rule FAILS the build', (app) => {
  write(app, 'CLAUDE.md', '# CLAUDE.md\n\nnothing to see here\n');
}, 'fail', 'no longer states the rule');

scenario('unwiring the gate from npm test FAILS the build', (app) => {
  write(app, 'package.json', JSON.stringify({ scripts: { test: 'node scripts/test-auth-session.js' } }, null, 2) + '\n');
}, 'fail', 'package.json');

scenario('unwiring the gate TEST from npm test FAILS the build', (app) => {
  write(app, 'package.json', JSON.stringify({
    scripts: { test: 'node scripts/check-product-separation.js' },
  }, null, 2) + '\n');
}, 'fail', 'test-product-separation-gate');

scenario('a CI workflow that no longer runs npm test FAILS the build', (app, root) => {
  write(root, '.github/workflows/test.yml', 'jobs:\n  test:\n    steps:\n      - run: echo skip\n');
}, 'fail', 'workflows/test.yml');

scenario('a malformed ledger line FAILS the build', () => {}, 'fail', 'Unreadable ledger line',
  { ledger: ['import src/lib/crypto.js because we felt like it'] });

scenario('a SECOND authorized block later in the ledger grants nothing', (app) => {
  write(app, 'src/longterm/lib/loan.js', "const crypto = require('../../lib/crypto.js');\n");
}, 'fail', 'imports RTL code', { ledgerTail: '\nExample only:\n\n```authorized\nimport src/lib/crypto.js\n```\n' });

// ---- report -----------------------------------------------------------------
if (failures.length) {
  console.error(`\n  ✗ ${failures.length} of ${failures.length + passed} checks failed:\n`);
  for (const f of failures) console.error('  ✗ ' + f + '\n');
  process.exit(1);
}
console.log(`\n  ✓ ${passed} checks passed — the separation gate does what it promises.`);
