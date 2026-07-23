'use strict';

/**
 * AI-FREEZE LOCK (owner-directed 2026-07-22).
 *
 * The AI machine may NEVER write a condition. Every AI agent writes only to
 * `ai_suggestions`; a HUMAN converts a suggestion into a condition (a staff click
 * that attaches a vetted library template — see src/lib/underwriting/ai-suggestions.js
 * and the convert_to_condition route in src/routes/underwriting.js).
 *
 * This test fails the build if ANY code path — an AI module, an AI suggestion
 * producer, or any NEW unreviewed file — inserts a `checklist_items`,
 * `checklist_templates`, OR first-class `conditions` (db/022) row. The complete
 * set of condition-writers (across BOTH condition models) is pinned to a
 * reviewed allowlist below; a new writer can't slip in unnoticed (least of all an
 * AI one). This is a source scan, so it holds even with no database.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
// Cover BOTH condition models: the checklist-item model (checklist_items /
// checklist_templates) AND the first-class conditions table (db/022). An AI
// writing EITHER is a freeze breach — the /loan-conditions box this fix guards
// writes the `conditions` table, so the lock must watch it too.
const INSERT_RE = /INSERT\s+INTO\s+(checklist_(items|templates)|conditions)\b/i;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// The COMPLETE, reviewed set of code paths allowed to create a condition
// (checklist_items) or a condition definition (checklist_templates). Every one is
// human-triggered (a staff route) or deterministic (the rules engine / a fixed
// template / a document workflow) — NONE is an AI agent. Adding a file here is a
// deliberate, reviewed act: confirm it is NOT an AI path before you do.
const ALLOWLIST = new Set([
  'src/lib/co-borrower.js',          // co-borrower doc condition (staff adds a co-borrower)
  'src/lib/credit/co-condition.js',  // co-borrower CREDIT condition (staff splits a credit pull)
  'src/lib/conditions/engine.js',    // deterministic rules engine (admin-defined templates)
  'src/lib/appraisal/desk.js',       // appraisal desk condition (fixed template)
  'src/lib/vesting.js',              // entity / LLC vesting condition
  'src/lib/esign/draw-wire.js',      // e-sign / draw-wire condition
  'src/lib/raise-issue.js',          // staff "raise an issue" on an entity
  'src/lib/product-registration.js', // product registration -> first-class conditions row (db/022)
  'src/routes/admin-conditions.js',  // admin Condition Studio (checklist_templates)
  'src/routes/underwriting.js',      // ensureUnderwritingCondition + human convert_to_condition (vetted template)
  'src/routes/borrower.js',          // initial checklist generated from templates on registration
  'src/routes/staff-chat.js',        // staff chat -> assigned staff task
  'src/routes/staff.js',             // the staff "add a condition" routes (human)
]);

// Belt-and-suspenders: no file under src/lib/ai/ may EVER write a condition.
const AI_DIR_PREFIX = 'src/lib/ai/';

const writers = [];
for (const file of walk(SRC)) {
  if (INSERT_RE.test(fs.readFileSync(file, 'utf8'))) writers.push(rel(file));
}
writers.sort();

let failures = 0;

// 1) Explicit: nothing in the AI toolbox writes a condition.
const aiWriters = writers.filter((f) => f.startsWith(AI_DIR_PREFIX));
if (aiWriters.length) {
  console.error('FAIL: an AI module writes a condition (AI must only write ai_suggestions):');
  for (const f of aiWriters) console.error('   -', f);
  failures++;
}

// 2) Catch-all: every condition-writer is on the reviewed allowlist. A new,
//    unreviewed writer (e.g. a future AI agent, an AI suggestion producer under
//    src/lib/underwriting/) trips this until a human vets it and adds it here.
const unexpected = writers.filter((f) => !ALLOWLIST.has(f));
if (unexpected.length) {
  console.error('FAIL: an unreviewed code path writes a condition. If (and ONLY if) it is NOT an AI path,');
  console.error('      add it to ALLOWLIST in scripts/test-ai-no-condition-write.js:');
  for (const f of unexpected) console.error('   -', f);
  failures++;
}

// 3) Keep the allowlist honest: an entry that no longer writes a condition should
//    be pruned (a stale allowlist hides the next real regression).
const stale = [...ALLOWLIST].filter((f) => !writers.includes(f));
if (stale.length) {
  console.error('FAIL: ALLOWLIST entries no longer write a condition — prune them:');
  for (const f of stale) console.error('   -', f);
  failures++;
}

if (failures) {
  console.error(`\nAI-freeze lock: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log(`test-ai-no-condition-write: OK — ${writers.length} condition-writers, all human/deterministic; no AI path can post a condition.`);
