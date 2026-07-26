'use strict';
/**
 * Fix 2026-07-23 (#208) — regression tests for three silent-attribution bugs:
 *   1. dead `status='ok'` filters on document_extractions (real value: 'analyzed')
 *   2. req.actor.staffId (the actor object only ever has .id) → NULL attribution
 *   3. askAdmin stacking duplicate super-admin questions (its own status flip to
 *      'asked_admin' hid the row from record()'s open-only dedupe)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// --- 1+2: source-scan guard — the dead patterns must never come back --------
const SRC = path.join(__dirname, '..', 'src');
function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
const files = walk(SRC, []);
const okBad = [];
const staffIdBad = [];
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  // A document_extractions query filtering on the never-written 'ok' status.
  if (/document_extractions[\s\S]{0,200}?status\s*=\s*'ok'/.test(text)) okBad.push(f);
  if (/req\.actor\.staffId/.test(text)) staffIdBad.push(f);
}
assert.deepStrictEqual(okBad, [], `dead status='ok' extraction filter in: ${okBad.join(', ')}`);
ok("no document_extractions query filters on the never-written status='ok'");
assert.deepStrictEqual(staffIdBad, [], `req.actor.staffId (always undefined) in: ${staffIdBad.join(', ')}`);
ok('no route reads req.actor.staffId (the actor only carries .id)');

// --- 3: askAdmin dedupe with a scripted fake pg client ----------------------
const aiSug = require('../src/lib/underwriting/ai-suggestions');

function fakeClient(state) {
  return {
    async query(sql, params) {
      state.calls.push({ sql, params });
      const s = String(sql);
      if (/FROM ai_admin_questions/.test(s) && /answered_at IS NULL/.test(s)) {
        return { rows: state.openQuestion ? [state.openQuestion] : [], rowCount: state.openQuestion ? 1 : 0 };
      }
      if (/FROM ai_silenced_codes/.test(s)) return { rows: [], rowCount: 0 };
      if (/FROM ai_suggestions/.test(s) && /dedupe_key=\$3/.test(s)) return { rows: [], rowCount: 0 };
      if (/INSERT INTO ai_suggestions/.test(s)) { state.suggestionInserts++; return { rows: [{ id: 'sug-1' }], rowCount: 1 }; }
      if (/INSERT INTO ai_admin_questions/.test(s)) {
        state.questionInserts++;
        assert.ok(/dedupe_key/.test(s), 'the question INSERT persists the dedupe_key (db/264 index needs it)');
        return { rows: [{ id: 'q-1' }], rowCount: 1 };
      }
      if (/UPDATE ai_suggestions SET status='asked_admin'/.test(s)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
}

(async () => {
  // First ask: no open question → inserts suggestion + question.
  const s1 = { calls: [], suggestionInserts: 0, questionInserts: 0, openQuestion: null };
  const r1 = await aiSug.askAdmin(fakeClient(s1), {
    applicationId: 'app-1', agent: 'cure', question: 'Does this document clear the condition?',
  });
  assert.strictEqual(r1.suggestionId, 'sug-1');
  assert.strictEqual(r1.questionId, 'q-1');
  assert.strictEqual(s1.suggestionInserts, 1);
  assert.strictEqual(s1.questionInserts, 1);
  ok('first askAdmin inserts one suggestion + one inbox question (with dedupe_key)');

  // Second identical ask while unanswered: returns the SAME question, inserts NOTHING.
  const s2 = { calls: [], suggestionInserts: 0, questionInserts: 0, openQuestion: { id: 'q-1', suggestion_id: 'sug-1' } };
  const r2 = await aiSug.askAdmin(fakeClient(s2), {
    applicationId: 'app-1', agent: 'cure', question: 'Does this document clear the condition?',
  });
  assert.strictEqual(r2.deduped, true, 'the repeat ask is deduped');
  assert.strictEqual(r2.questionId, 'q-1', 'the existing inbox question is returned');
  assert.strictEqual(s2.suggestionInserts, 0, 'no second suggestion is stacked');
  assert.strictEqual(s2.questionInserts, 0, 'no duplicate inbox question is stacked');
  ok('a repeat askAdmin while unanswered returns the existing question — nothing stacks');

  console.log(`\nattribution + askAdmin-dedupe pure — ${passed} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
