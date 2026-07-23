'use strict';

/**
 * Pure test for src/lib/underwriting/investor-guidelines/desk-sync.js (no DB).
 * Proves the overlay's `unhappy[]` maps to the right ai-suggestions payloads:
 * a construction-feasibility coverage gap is a FATAL attach_condition, a plain
 * coverage gap is a warning, a conflict is a fatal finding, and a happy desk
 * produces nothing.
 */

const assert = require('assert');
const ds = require('../src/lib/underwriting/investor-guidelines/desk-sync');

let n = 0;
function check(name, fn) { fn(); n++; console.log('  ok -', name); }

console.log('desk-sync pure tests');

// 1 — happy / empty / malformed desk → no suggestions, never throws.
check('happy or empty desk raises nothing', () => {
  assert.deepStrictEqual(ds.deskToSuggestions(null), []);
  assert.deepStrictEqual(ds.deskToSuggestions({}), []);
  assert.deepStrictEqual(ds.deskToSuggestions({ unhappy: [] }), []);
  assert.deepStrictEqual(ds.deskToSuggestions({ unhappy: 'nope' }), []);
});

// 2 — a construction-feasibility coverage gap is a FATAL attach_condition suggestion.
check('missing feasibility condition → fatal attach_condition', () => {
  const desk = {
    noteBuyer: { name: 'Blue Lake Capital' },
    unhappy: [{
      cond_no: 200, name: 'CONSTRUCTION FEASIBILITY REPORT (GROUND-UP / HEAVY REHAB)',
      domain: 'construction_feasibility', flag: 'coverage_gap', severity: 'fatal',
      pilot_template_code: 'rtl_cond_feasibility',
      required_evidence: 'A third-party feasibility report from an approved vendor.',
    }],
  };
  const [s] = ds.deskToSuggestions(desk);
  assert.strictEqual(s.source, 'investor_guideline_desk');
  assert.strictEqual(s.kind, 'condition');
  assert.strictEqual(s.severity, 'fatal');
  assert.strictEqual(s.important, true);
  assert.match(s.title, /Blue Lake Capital requires/);
  assert.match(s.title, /no condition on the file/);
  assert.match(s.body, /Post one now/);
  assert.match(s.body, /Needs: A third-party feasibility/);
  assert.strictEqual(s.proposedAction.type, 'attach_condition');
  assert.strictEqual(s.proposedAction.fields.code, 'rtl_cond_feasibility');
  assert.strictEqual(s.evidence.code, 'rtl_cond_feasibility');
  assert.strictEqual(s.evidence.domain, 'construction_feasibility');
  assert.strictEqual(s.dedupeKey, 'isg-gap:200');
});

// 3 — a non-feasibility coverage gap is a WARNING (not fatal).
check('other missing condition → warning attach_condition', () => {
  const [s] = ds.deskToSuggestions({
    noteBuyer: { name: 'CorrFirst' },
    unhappy: [{ cond_no: 12, name: 'FLOOD CERT', domain: 'flood', flag: 'coverage_gap', severity: 'warning', pilot_template_code: 'rtl_cond_flood' }],
  });
  assert.strictEqual(s.severity, 'warning');
  assert.strictEqual(s.important, false);
  assert.ok(!/Post one now/.test(s.body), 'no urgent line for a warning gap');
  assert.strictEqual(s.dedupeKey, 'isg-gap:12');
});

// 4 — a conflict is a FATAL finding carrying the conflicting check details.
check('guideline conflict → fatal finding', () => {
  const [s] = ds.deskToSuggestions({
    noteBuyer: { name: 'Blue Lake Capital' },
    unhappy: [{
      cond_no: 3035, name: 'SELLER CONCESSION', domain: 'concessions', flag: 'conflict', severity: 'fatal',
      reason: 'The seller concession exceeds 6% of the sale price.',
      checks: [
        { status: 'conflict', detail: 'Concession 8% exceeds the 6% cap.' },
        { status: 'ok', detail: 'ignored' },
      ],
    }],
  });
  assert.strictEqual(s.kind, 'finding');
  assert.strictEqual(s.severity, 'fatal');
  assert.match(s.title, /conflicts with Blue Lake Capital's guideline/);
  assert.strictEqual(s.body, 'The seller concession exceeds 6% of the sale price.');
  assert.deepStrictEqual(s.evidence.conflicts, ['Concession 8% exceeds the 6% cap.']);
  assert.strictEqual(s.proposedAction.type, 'review_guideline_conflict');
  assert.strictEqual(s.dedupeKey, 'isg-conflict:3035');
});

// 5 — falls back to a generic note-buyer label and skips malformed rows.
check('missing noteBuyer name + malformed row are handled', () => {
  const out = ds.deskToSuggestions({
    unhappy: [
      { flag: 'coverage_gap', severity: 'fatal' },           // no cond_no → skipped
      { cond_no: 7, name: 'X', flag: 'coverage_gap', severity: 'warning' },
    ],
  });
  assert.strictEqual(out.length, 1, 'malformed row skipped');
  assert.match(out[0].title, /the note buyer requires/i);
});

console.log(`\ndesk-sync: ${n} checks passed`);
