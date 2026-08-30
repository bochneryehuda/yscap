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
  // ── THE LONG-TERM SIDE OF THE ONE CONDITION CENTER (db/650, db/651) ────────
  // These three began writing `checklist_items` / `checklist_templates` when the
  // Long-Term loan became the FOURTH OWNER SCOPE of the shared Condition Center
  // (the owner's 2026-08-30 share-the-code directive). They wrote Long-Term's own
  // parallel table before that, which is why this lock had never seen them — the
  // move is what surfaced them, and the lock did exactly its job.
  //
  // NONE IS AN AI PATH, and that was CHECKED rather than assumed: not one of the
  // three requires an AI module, a model client or an ai-* helper. Each is the
  // Long-Term twin of an entry already on this list:
  //   engine.js  — the deterministic rules engine, the exact analogue of
  //                lib/conditions/engine.js above; templates in, rows out, no model.
  //   library.js — seeds the FIXED, vetted library (the owner's own 28 conditions,
  //                written by hand in that file) into checklist_templates.
  //   write.js   — the staff door: addFromTemplate attaches a vetted template when
  //                a person asks for it. Nothing here runs without that ask.
  'src/longterm/conditions-center/engine.js',
  'src/longterm/conditions-center/library.js',
  'src/longterm/conditions-center/write.js',
  'src/lib/appraisal/desk.js',       // appraisal desk condition (fixed template)
  'src/lib/vesting.js',              // entity / LLC vesting condition
  // Staff press "Add this LLC to the borrower's profile" on a different-entity bank finding; this
  // carries that click out — it attaches the fixed, vetted `rtl_cond_entity_docs` template (db/400)
  // and generates the entity's own document slots. Not an AI path: PILOT only ever SUGGESTS the
  // button, and nothing here runs without a human's click (src/routes/underwriting.js entity-adopt).
  'src/lib/underwriting/entity-adopt.js',
  // A title / insurance vendor replies to an order a HUMAN placed, and the reply's
  // attachments are filed onto that order's own condition. When the file does not
  // carry that condition yet the fixed, vetted template (rtl_cond_title /
  // rtl_cond_insurance, db/051) is instantiated so the document is never orphaned.
  // Not an AI path: nothing here runs unless a staffer sent the order and the
  // vendor answered it; no model chooses the template, the condition or the moment.
  'src/lib/order-inbox.js',
  'src/lib/esign/draw-wire.js',      // e-sign / draw-wire condition
  // Plans & permits before the FIRST DRAW (owner-directed 2026-08-18): on a purchase the
  // condition may be waived at closing and MUST re-populate when the first draw starts,
  // pre-filled with the closing-time document. ensureDrawPlansCondition() instantiates the
  // fixed, vetted `draw_cond_plans_permits` template (db/576, auto_apply='manual' so ONLY
  // this module raises it) at that deterministic workflow moment. Not an AI path: no model
  // chooses the template, the condition or the moment — it fires on the draw birth a human
  // (the borrower's request or the coordinator's Start) set in motion.
  'src/sitewire/plans-permits.js',
  // The Heter Iska condition ensure (ensureIskaCondition). rtl_cond_iska is a fixed,
  // vetted template (db/051); this instantiates it when the DocuSign package is sent or
  // completed so the executed Iska is never orphaned. Not an AI path — no model chooses
  // the template, the condition or the moment; it fires only on a staff/borrower e-sign
  // send and on the DocuSign completion webhook.
  'src/lib/esign/orchestrate.js',
  'src/lib/raise-issue.js',          // staff "raise an issue" on an entity
  // A staffer picks a document type and a reason on a past project and presses
  // "Request a document"; this carries that click out. Not an AI path — there is
  // no model anywhere in it: the vocabulary is a fixed table in the file, the
  // wording is built from that table, and every field is chosen by the person at
  // the screen. The routes are `POST /track-records/:id/request-doc` and the
  // "needs documents" verify button, both behind the staff scope check.
  'src/lib/track-record/doc-request.js',
  'src/lib/product-registration.js', // product registration -> first-class conditions row (db/022)
  'src/lib/closing.js',              // closing workspace -> HUD/ALTA + closed-package + tracking conditions (fixed templates, closer workflow)
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
