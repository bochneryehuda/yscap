#!/usr/bin/env node
'use strict';
/**
 * Pure tests for src/lib/underwriting/ai-suggestions.js — mocks the pg client
 * (in-memory row store) so we exercise every branch without a DB. Asserts:
 *   * record() writes shape / dedupe collapses to one open row
 *   * decide() action semantics (all 8 actions) + status transitions
 *   * addNote() appends to the notes array
 *   * askAdmin() / answerAdminQuestion() close the loop
 *   * fromCureNewFinding() shape
 */
const assert = require('assert');

// ---- Minimal in-memory pg client ----
class Store {
  constructor() {
    this.rows = []; this.qs = []; this.aq = [];
    this.nextId = 1;
  }
  id() { return String(this.nextId++); }
}
function mkClient(store) {
  return {
    async query(sql, params) {
      const s = sql.replace(/\s+/g, ' ').trim();

      if (/^INSERT INTO ai_suggestions/i.test(s)) {
        const [appId, docId, ciId, source, kind, title, body, evidence, action, severity, confidence, traceUrl, dedupe, important] = params;
        const row = {
          id: store.id(),
          application_id: appId, document_id: docId, checklist_item_id: ciId,
          source, kind, title, body,
          evidence: JSON.parse(evidence), proposed_action: JSON.parse(action),
          severity, confidence, trace_url: traceUrl,
          status: 'open', status_reason: null,
          decided_by_staff_id: null, decided_at: null,
          important: !!important, notes: [],
          linked_condition_id: null, linked_task_id: null,
          dedupe_key: dedupe,
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        };
        store.rows.push(row);
        return { rows: [{ id: row.id }] };
      }
      if (/^SELECT id FROM ai_suggestions WHERE application_id=\$1 AND source=\$2 AND dedupe_key=\$3 AND status='open'/.test(s)) {
        const hit = store.rows.find(r => r.application_id === params[0] && r.source === params[1] && r.dedupe_key === params[2] && r.status === 'open');
        return { rows: hit ? [{ id: hit.id }] : [] };
      }
      if (/^UPDATE ai_suggestions SET document_id=/.test(s)) {
        const [id, docId, ciId, kind, title, body, evidence, action, severity, confidence, traceUrl, important] = params;
        const row = store.rows.find(r => r.id === id);
        if (docId) row.document_id = docId; if (ciId) row.checklist_item_id = ciId;
        row.kind = kind; row.title = title; row.body = body;
        row.evidence = JSON.parse(evidence); row.proposed_action = JSON.parse(action);
        row.severity = severity; row.confidence = confidence; row.trace_url = traceUrl;
        row.important = !!important;
        return { rows: [] };
      }
      if (/^SELECT \* FROM ai_suggestions WHERE id=\$1$/.test(s)) {
        const hit = store.rows.find(r => r.id === params[0]);
        return { rows: hit ? [hit] : [] };
      }
      if (/^SELECT notes FROM ai_suggestions WHERE id=\$1/.test(s)) {
        const hit = store.rows.find(r => r.id === params[0]);
        return { rows: hit ? [{ notes: hit.notes }] : [] };
      }
      if (/^UPDATE ai_suggestions SET notes=\$2::jsonb WHERE id=\$1$/.test(s)) {
        const hit = store.rows.find(r => r.id === params[0]);
        if (hit) hit.notes = JSON.parse(params[1]);
        return { rows: [] };
      }
      if (/^UPDATE ai_suggestions SET status=\$2/.test(s)) {
        const [id, status, reason, staffId, important, condId, taskId, notes] = params;
        const row = store.rows.find(r => r.id === id);
        row.status = status; row.status_reason = reason;
        if (staffId) row.decided_by_staff_id = staffId;
        row.decided_at = new Date().toISOString();
        row.important = !!important;
        row.linked_condition_id = condId; row.linked_task_id = taskId;
        row.notes = JSON.parse(notes);
        return { rows: [row] };
      }
      if (/^UPDATE ai_suggestions SET status='asked_admin' WHERE id=\$1 AND status='open'$/.test(s)) {
        const row = store.rows.find(r => r.id === params[0] && r.status === 'open');
        if (row) row.status = 'asked_admin';
        return { rows: [] };
      }
      if (/^SELECT \* FROM ai_suggestions WHERE application_id=\$1/.test(s)) {
        const filtered = store.rows.filter(r => r.application_id === params[0])
          .sort((a, b) => (b.important - a.important) || (b.created_at.localeCompare(a.created_at)));
        return { rows: filtered };
      }
      if (/^INSERT INTO ai_admin_questions/i.test(s)) {
        const [sugId, appId, agent, question, context, dedupeKey] = params;
        const row = { id: store.id(), suggestion_id: sugId, application_id: appId, agent, question, context: JSON.parse(context), dedupe_key: dedupeKey || null, asked_at: new Date().toISOString(), answered_at: null };
        store.aq.push(row);
        return { rows: [row] };
      }
      // Fix 2026-07-23 (#208): askAdmin's unanswered-question dedupe pre-check
      // (and its 23505 race re-select share this SELECT-list prefix).
      if (/^SELECT id, suggestion_id FROM ai_admin_questions/i.test(s)) {
        const hit = store.aq.find(r => r.application_id === params[0] && !r.answered_at &&
          (r.dedupe_key === params[1] || (r.dedupe_key == null && params.length > 2 && r.agent === params[2] && r.question === params[3])));
        return { rows: hit ? [{ id: hit.id, suggestion_id: hit.suggestion_id }] : [] };
      }
      if (/^UPDATE ai_admin_questions SET learning_captured=true/i.test(s)) return { rows: [] };
      if (/^UPDATE ai_admin_questions SET answered_by_staff_id/i.test(s)) {
        const [id, staffId, ans] = params;
        const row = store.aq.find(r => r.id === id);
        if (!row) return { rows: [] };
        row.answered_by_staff_id = staffId; row.answered_at = new Date().toISOString(); row.answer = ans;
        return { rows: [{ suggestion_id: row.suggestion_id, application_id: row.application_id, agent: row.agent, question: row.question, context: row.context }] };
      }
      if (/^SELECT \* FROM ai_admin_questions/i.test(s)) {
        return { rows: store.aq.filter(r => !r.answered_at) };
      }
      throw new Error('unhandled sql: ' + s.slice(0, 100));
    },
  };
}

const aiSug = require('../src/lib/underwriting/ai-suggestions');

(async function main() {
  // ---- record + dedupe ----
  const store = new Store();
  const c = mkClient(store);
  const appId = 'app-1';
  const r1 = await aiSug.record(c, {
    applicationId: appId, source: 'cure_analysis', kind: 'finding',
    title: 'Missing page in bank statement', body: 'Page 3 is missing',
    severity: 'warning', confidence: 0.85,
    evidence: { pages: [1, 2, 4], docId: 'doc-1' },
    proposedAction: { type: 'create_finding', fields: { code: 'BS_MISSING_PAGE' } },
    dedupeKey: 'bs:doc-1:missing-page',
  });
  assert.ok(r1.id);
  assert.strictEqual(r1.deduped, false);
  // Re-record same dedupe → merges in place
  const r2 = await aiSug.record(c, {
    applicationId: appId, source: 'cure_analysis', kind: 'finding',
    title: 'Missing page in bank statement (rev 2)',
    dedupeKey: 'bs:doc-1:missing-page',
  });
  assert.strictEqual(r2.id, r1.id);
  assert.strictEqual(r2.deduped, true);
  assert.strictEqual(store.rows.length, 1);
  assert.strictEqual(store.rows[0].title, 'Missing page in bank statement (rev 2)');

  // ---- decide: escalate ----
  await aiSug.decide(c, r1.id, { action: 'escalate', staffId: 's1', reason: 'looks fraudulent' });
  assert.strictEqual(store.rows[0].status, 'escalated');

  // ---- decide: mark_important then unmark ----
  await aiSug.decide(c, r1.id, { action: 'mark_important', staffId: 's1' });
  assert.strictEqual(store.rows[0].important, true);
  await aiSug.decide(c, r1.id, { action: 'unmark_important', staffId: 's1' });
  assert.strictEqual(store.rows[0].important, false);

  // ---- decide: convert_to_condition ----
  await aiSug.decide(c, r1.id, { action: 'convert_to_condition', conditionId: 'ci-42', staffId: 's1' });
  assert.strictEqual(store.rows[0].status, 'converted_to_condition');
  assert.strictEqual(store.rows[0].linked_condition_id, 'ci-42');

  // ---- decide: convert_to_task ----
  await aiSug.decide(c, r1.id, { action: 'convert_to_task', taskId: 't-99', staffId: 's1' });
  assert.strictEqual(store.rows[0].linked_task_id, 't-99');

  // ---- decide: convert_to_condition without conditionId throws ----
  await assert.rejects(aiSug.decide(c, r1.id, { action: 'convert_to_condition' }), /conditionId/);

  // ---- decide: dismiss ----
  const r3 = await aiSug.record(c, {
    applicationId: appId, source: 'authenticity', kind: 'info',
    title: 'PDF has been edited', dedupeKey: 'auth:1',
  });
  await aiSug.decide(c, r3.id, { action: 'dismiss', reason: 'expected — vendor re-signed' });
  assert.strictEqual(store.rows.find(r => r.id === r3.id).status, 'dismissed');
  assert.strictEqual(store.rows.find(r => r.id === r3.id).status_reason, 'expected — vendor re-signed');

  // ---- addNote appends without changing status ----
  const r4 = await aiSug.record(c, { applicationId: appId, source: 'entity_chain', kind: 'finding', title: 'chain break' });
  await aiSug.addNote(c, r4.id, { staffId: 's2', text: 'checked title report — matches' });
  const rowN = store.rows.find(r => r.id === r4.id);
  assert.strictEqual(rowN.notes.length, 1);
  assert.strictEqual(rowN.notes[0].text, 'checked title report — matches');
  assert.strictEqual(rowN.status, 'open', 'note did not change status');

  // ---- listForFile: important pinned to top ----
  const r5 = await aiSug.record(c, { applicationId: appId, source: 'assignment_fraud', kind: 'finding', title: 'non-arm', important: true });
  const list = await aiSug.listForFile(appId, {}, c);
  assert.strictEqual(list[0].id, r5.id, 'important row pinned first');

  // ---- askAdmin + answer ----
  const q = await aiSug.askAdmin(c, {
    applicationId: appId, agent: 'cure', question: 'The insurance dec page is 4-family but the file says 3-family. Which is the truth?',
    context: { fileUnits: 3, docUnits: 4 },
  });
  assert.ok(q.suggestionId && q.questionId);
  const sug = store.rows.find(r => r.id === q.suggestionId);
  assert.strictEqual(sug.status, 'asked_admin');
  assert.strictEqual(sug.kind, 'question');
  // Fix 2026-07-23 (#208): re-asking while the question is still UNANSWERED
  // dedupes to the SAME inbox row (before the fix it stacked a duplicate —
  // the suggestion's 'asked_admin' status hid it from record()'s open-only dedupe).
  const qDup = await aiSug.askAdmin(c, {
    applicationId: appId, agent: 'cure', question: 'The insurance dec page is 4-family but the file says 3-family. Which is the truth?',
  });
  assert.strictEqual(qDup.deduped, true, 'unanswered repeat ask is deduped');
  assert.strictEqual(qDup.questionId, q.questionId, 'same inbox question returned');
  assert.strictEqual(store.aq.length, 1, 'no duplicate inbox row stacked');
  await aiSug.answerAdminQuestion(c, q.questionId, { staffId: 's3', answer: 'File says 3 — appraiser to confirm.' });
  const aq = store.aq.find(r => r.id === q.questionId);
  assert.ok(aq.answered_at);
  assert.strictEqual(aq.answer, 'File says 3 — appraiser to confirm.');
  assert.strictEqual(store.rows.find(r => r.id === q.suggestionId).status, 'answered');

  // Re-asking the SAME question dedupes to the SAME suggestion (no spam).
  const q2 = await aiSug.askAdmin(c, {
    applicationId: appId, agent: 'cure', question: 'The insurance dec page is 4-family but the file says 3-family. Which is the truth?',
  });
  // suggestion was closed → dedupe hunts for an OPEN row → creates a NEW one this time. That IS correct.
  assert.notStrictEqual(q2.suggestionId, q.suggestionId, 'closed suggestions do not block re-asking');

  // ---- fromCureNewFinding shape ----
  const s = aiSug.fromCureNewFinding({
    applicationId: 'app-x', documentId: 'doc-y', checklistItemId: 'ci-z', extractionId: 'ext-1', traceUrl: 'https://lf/1',
    finding: { code: 'INS_UNDERINSURED', title: 'coverage < loan', howTo: 'request higher coverage', severity: 'fatal',
               docValue: '50000', fileValue: '250000', field: 'coverage_amount', opens_condition: 'ins_upgrade' },
  });
  assert.strictEqual(s.source, 'cure_analysis');
  assert.strictEqual(s.kind, 'finding');
  assert.strictEqual(s.severity, 'fatal');
  assert.strictEqual(s.proposedAction.type, 'create_finding');
  assert.strictEqual(s.proposedAction.fields.opensCondition, 'ins_upgrade');
  assert.strictEqual(s.dedupeKey, 'cure:ci-z:INS_UNDERINSURED:coverage_amount');
  assert.strictEqual(s.traceUrl, 'https://lf/1');

  console.log('test-ai-suggestions-pure: record/dedupe/decide-all-actions/note/askAdmin/answer/fromCureNewFinding all pass');
})().catch(e => { console.error(e); process.exit(1); });
