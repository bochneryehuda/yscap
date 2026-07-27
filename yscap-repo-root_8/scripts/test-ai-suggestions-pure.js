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
// Statuses that still need handling — escalating or flagging a finding is not a
// DECISION about it, so record() refreshes those rows instead of stacking a copy.
const LIVE_STATUSES = new Set(['open', 'escalated', 'marked_important', 'asked_admin']);
// 'answered' is the super-admin REPLYING to a question the AI asked — an answer, not a
// judgement that the issue is closed — so it never blocks the agent asking again.
const SETTLED_EXEMPT = new Set([...LIVE_STATUSES, 'answered']);

const STORES = [];
class Store {
  constructor() {
    STORES.push(this);
    this.rows = []; this.qs = []; this.aq = []; this.decisions = [];
    // Every statement this stub did not recognise. Asserted empty at the end — see the
    // fall-through note in `mkClient`.
    this.unhandled = [];
    this.silenced = new Set();
    this.proposals = [];
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
      // A DECIDED row is the last word — record() must not re-raise it (the
      // 2026-07-27 "I dismiss it and it keeps popping up again" root cause).
      // THE COLUMN LIST IS PART OF THE CONTRACT (re-audit 2026-07-27). These stubs are anchored
      // regexes, and `record()`'s two consults are wrapped in fail-OPEN catches — so when a
      // SELECT list gained `severity` and this pattern did not, the stub fell through to its own
      // `unhandled sql` throw, the catch swallowed it, and this file went on printing `all pass`
      // while protecting NOTHING: a dismissed row was re-raised as a brand-new open one, which is
      // the exact owner-reported bug the assertions below claim to pin. Matched loosely on the
      // Keyed on the CLAUSE that distinguishes the two dedupe queries (`decided_by_staff_id IS
      // NOT NULL` here, `status IN (` for the live-refresh pick below) rather than on the SELECT
      // list, so adding a column can never silently disarm the test again. Verified: adding a
      // column to either query keeps both matching.
      if (/^SELECT .* FROM ai_suggestions WHERE application_id=\$1 AND source=\$2 AND dedupe_key=\$3.*decided_by_staff_id IS NOT NULL/.test(s)) {
        const hit = store.rows.find(r => r.application_id === params[0] && r.source === params[1]
          && r.dedupe_key === params[2] && !SETTLED_EXEMPT.has(r.status) && r.decided_by_staff_id != null);
        return { rows: hit ? [{ id: hit.id, status: hit.status, severity: hit.severity }] : [] };
      }
      // The refresh-in-place pick. "Live" spans open/escalated/marked_important/
      // asked_admin (all still need handling); a plain 'open' row wins.
      if (/^SELECT .* FROM ai_suggestions WHERE application_id=\$1 AND source=\$2 AND dedupe_key=\$3.*status IN \(/.test(s)) {
        const hits = store.rows.filter(r => r.application_id === params[0] && r.source === params[1]
          && r.dedupe_key === params[2] && LIVE_STATUSES.has(r.status));
        hits.sort((a, b) => (b.status === 'open') - (a.status === 'open'));
        // `severity` is part of the row the real pick returns — it is how `record()` tells an
        // UPGRADE from a plain re-record. Omitting it here made every refresh look like a rise
        // from nothing, which is precisely the fatal-restated-as-fatal blast this asserts against.
        return { rows: hits[0] ? [{ id: hits[0].id, severity: hits[0].severity }] : [] };
      }
      // The per-finding decision ledger (db/333) + the savepoint it runs inside.
      if (/^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT) finding_decision$/i.test(s)) return { rows: [] };
      if (/^SELECT .* FROM finding_decisions WHERE application_id = \$1 AND suppressed = true/i.test(s)) {
        return { rows: store.decisions.filter(d => d.application_id === params[0] && d.suppressed)
          .map(d => ({ finding_key: d.finding_key, severity: d.severity })) };
      }
      if (/^INSERT INTO finding_decisions/i.test(s)) {
        const [appId2, key, code, origin, decision, suppressed, note, by, severity] = params;
        const prev = store.decisions.find(d => d.application_id === appId2 && d.finding_key === key);
        // COALESCE, mirroring the real ON CONFLICT: a later write with no severity must not
        // erase the severity an earlier one recorded.
        if (prev) Object.assign(prev, { code, origin, decision, suppressed, note, decided_by: by,
          severity: severity == null ? prev.severity : severity });
        else store.decisions.push({ application_id: appId2, finding_key: key, code, origin, decision,
          suppressed, note, decided_by: by, severity: severity == null ? null : severity });
        return { rows: [] };
      }
      if (/^UPDATE finding_decisions/i.test(s)) {
        const hit = store.decisions.find(d => d.application_id === params[0] && d.finding_key === params[1]);
        if (hit) hit.suppressed = false;
        return { rowCount: hit ? 1 : 0, rows: [] };
      }
      if (/^UPDATE ai_suggestions SET document_id=/.test(s)) {
        const [id, docId, ciId, kind, title, body, evidence, action, severity, confidence, traceUrl, important] = params;
        const row = store.rows.find(r => r.id === id);
        if (docId) row.document_id = docId; if (ciId) row.checklist_item_id = ciId;
        row.kind = kind; row.title = title; row.body = body;
        row.evidence = JSON.parse(evidence); row.proposed_action = JSON.parse(action);
        row.severity = severity; row.confidence = confidence; row.trace_url = traceUrl;
        row.important = row.important || !!important;   // never un-flag what a human flagged
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
      // (and its 23505 race re-select share this SELECT-list prefix). The
      // legacy (agent+question) match only applies when $5 says file-scoped.
      if (/^SELECT id, suggestion_id FROM ai_admin_questions/i.test(s)) {
        const legacyOk = params.length > 4 ? !!params[4] : false;
        const hit = store.aq.find(r => r.application_id === params[0] && !r.answered_at &&
          (r.dedupe_key === params[1] || (legacyOk && r.dedupe_key == null && r.agent === params[2] && r.question === params[3])));
        return { rows: hit ? [{ id: hit.id, suggestion_id: hit.suggestion_id }] : [] };
      }
      // askAdmin's best-effort savepoint around the inbox INSERT.
      if (/^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT) ask_admin$/i.test(s)) return { rows: [] };
      if (/^UPDATE ai_admin_questions SET learning_captured=true/i.test(s)) return { rows: [] };
      if (/^UPDATE ai_admin_questions SET answered_by_staff_id/i.test(s)) {
        const [id, staffId, ans] = params;
        const row = store.aq.find(r => r.id === id);
        if (!row) return { rows: [] };
        row.answered_by_staff_id = staffId; row.answered_at = new Date().toISOString(); row.answer = ans;
        return { rows: [{ suggestion_id: row.suggestion_id, application_id: row.application_id, agent: row.agent, question: row.question, context: row.context }] };
      }
      // THREE PRE-EXISTING DARK PATHS, surfaced the moment the fall-through became an assertion
      // (re-audit 2026-07-27). Each sits behind its own fail-open catch, so each was throwing and
      // being swallowed on every run — the branches ran, they just never did anything.
      //
      // The portfolio-wide code mute (R4.8). Not muted unless the test says so.
      if (/^SELECT 1 FROM ai_silenced_codes WHERE code=\$1/i.test(s)) {
        return { rows: store.silenced.has(params[0]) ? [{ '?column?': 1 }] : [] };
      }
      // Deciding a suggestion auto-closes the admin question it raised (R3.42).
      if (/^UPDATE ai_admin_questions SET answered_at/i.test(s)) {
        let n = 0;
        for (const q of store.aq) {
          if (q.suggestion_id !== params[0] || q.answered_at) continue;
          q.answered_at = new Date().toISOString();
          q.answer = q.answer == null ? params[1] : q.answer;
          n += 1;
        }
        return { rowCount: n, rows: [] };
      }
      // The learning capture (`learning.captureAdminAnswer`) and its savepoint.
      if (/^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT) learning_capture$/i.test(s)) return { rows: [] };
      if (/^SELECT id FROM training_proposals WHERE proposal_type='admin_answer'/i.test(s)) {
        const hit = store.proposals.find(t => t.key === params[0]);
        return { rows: hit ? [{ id: hit.id }] : [] };
      }
      if (/^INSERT INTO training_proposals/i.test(s)) {
        const scope = JSON.parse(params[0]);
        const row = { id: store.id(), key: scope.key, scope };
        store.proposals.push(row);
        return { rows: [{ id: row.id }] };
      }
      if (/^UPDATE training_proposals/i.test(s)) {
        const hit = store.proposals.find(t => t.id === params[0]);
        if (hit) hit.scope = Object.assign({}, hit.scope, { answer: params[1], answered_at: params[2] });
        return { rows: [] };
      }
      if (/^SELECT \* FROM ai_admin_questions/i.test(s)) {
        return { rows: store.aq.filter(r => !r.answered_at) };
      }
      // A FALL-THROUGH IS A TEST FAILURE, NOT A THROW TO BE SWALLOWED (re-audit 2026-07-27).
      // `record()`'s ledger consult and its settled-row dedupe both run inside fail-OPEN
      // catches — by design, since a ledger blip must never hide a finding. The side effect is
      // that a stub which stops matching becomes INVISIBLE: the throw is caught, the door goes
      // dark, and every assertion below still passes. Recording it and asserting at the end is
      // the only way this file can tell the difference between 'the door held' and 'the door
      // was never opened'.
      store.unhandled.push(s.slice(0, 120));
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
  // Audit fix 2026-07-23: the SAME question text about a DIFFERENT document is a
  // DIFFERENT escalation — the scope is part of the dedupe key, so doc B's ask
  // must NOT be swallowed by doc A's unanswered question.
  const qDocA = await aiSug.askAdmin(c, {
    applicationId: appId, agent: 'cure', documentId: 'doc-A',
    question: 'The cure engine could not verify this document. Review?',
  });
  const qDocB = await aiSug.askAdmin(c, {
    applicationId: appId, agent: 'cure', documentId: 'doc-B',
    question: 'The cure engine could not verify this document. Review?',
  });
  assert.ok(!qDocB.deduped, 'a different document is a different escalation');
  assert.notStrictEqual(qDocB.questionId, qDocA.questionId, 'doc B gets its own inbox question');
  const qDocA2 = await aiSug.askAdmin(c, {
    applicationId: appId, agent: 'cure', documentId: 'doc-A',
    question: 'The cure engine could not verify this document. Review?',
  });
  assert.strictEqual(qDocA2.deduped, true, 'the SAME document re-ask still dedupes');
  assert.strictEqual(qDocA2.questionId, qDocA.questionId);
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

  // ---- A HUMAN'S DECISION IS NOT RE-RAISED (the door this file's stub had gone dark on) ----
  // Repairing the stub was necessary and not sufficient: nothing in this file actually
  // ASSERTED the settled-row guard, so deleting it left every test green (verified by
  // mutation). This is the owner's original report — "I dismiss it and it keeps popping up
  // again" — at the one door that decides it.
  const ds = new Store();
  const dc = mkClient(ds);
  const dkey = 'isg-gap:rtl_cond_feasibility';
  const mk = (severity) => ({
    applicationId: 'app-settled', source: 'investor_guideline_desk', kind: 'finding',
    title: 'Feasibility report required', body: 'x', severity, dedupeKey: dkey,
    evidence: { code: 'isg_gap_200' },
    // This file has no database. A newly inserted FATAL otherwise schedules the real
    // whole-team fan-out, which reaches for `db()` and prints a DATABASE_URL banner from a
    // PURE test. The fan-out itself is covered where it belongs (the desk-sync suites).
    suppressNotify: true,
  });
  const first = await aiSug.record(dc, mk('warning'));
  await aiSug.decide(dc, first.id, { action: 'dismiss', reason: 'not applicable', staffId: 'staff-1' });
  const again = await aiSug.record(dc, mk('warning'));
  assert.strictEqual(again.settled, true, 'a dismissed finding is refused a fresh row');
  assert.strictEqual(again.id, first.id, 'and the caller is pointed back at the decided row');
  assert.strictEqual(ds.rows.length, 1, 'no second row was inserted — the dismissal sticks');

  // ...but the SAME rule coming back as a DEALBREAKER is not silenced by a judgement made
  // about something milder. That is a false clear, and it is the whole point of db/336.
  const worse = await aiSug.record(dc, mk('fatal'));
  assert.ok(!worse.settled, 'a dealbreaker is NOT held back by a warning-level dismissal');
  assert.strictEqual(ds.rows.length, 2, 'and it really gets a row of its own');

  // ...and a DECIDED row that carries NO severity does not silence a dealbreaker either.
  // This is deliberately the OPPOSITE of db/336's NULL policy on `finding_decisions` — see the
  // note at the guard. Unlike that column, `ai_suggestions.severity` has no legacy population,
  // so suppress-always would let one severity-less row silence a fatal on that key forever.
  const ns = new Store();
  const nc = mkClient(ns);
  const nmk = (severity) => ({
    applicationId: 'app-nullsev', source: 'cure_analysis', kind: 'finding', severity,
    title: 't', body: 'x', dedupeKey: 'nullsev:1', evidence: { code: 'nullsev' },
    suppressNotify: true,
  });
  const n1 = await aiSug.record(nc, nmk(null));
  // Settled DIRECTLY on the row, not through `decide()`. `decide()` also writes the durable
  // ledger, whose NULL policy is the opposite one — and the ledger consult runs after this
  // door, so it would decide the outcome and this assertion would be testing the wrong thing.
  // The case this isolates is real: a row decided before db/333, or one whose ledger write
  // failed (that write is best-effort by design).
  Object.assign(ns.rows.find(r => r.id === n1.id), { status: 'dismissed', decided_by_staff_id: 'staff-9' });
  const nFatal = await aiSug.record(nc, nmk('fatal'));
  assert.ok(!nFatal.settled,
    'a dismissal recorded with NO severity does not silence a later dealbreaker — fail OPEN');
  assert.strictEqual(ns.rows.length, 2, 'the dealbreaker really gets its own row');

  // ---- AN UPGRADE TO A DEALBREAKER IS NEWS, EVEN IN PLACE (the NINTH door) ----
  // The fatal fan-out lived only on the fresh-INSERT branch. But desk-sync's alive skip now
  // deliberately lets a WORSE payload through so the live row is UPGRADED rather than cloned —
  // so a warning sitting at `escalated` became a dealbreaker and the file team heard nothing.
  //
  // The notify module is INJECTED INTO THE REQUIRE CACHE rather than required and patched:
  // `src/lib/notify` pulls in `src/db`, which prints a DATABASE_URL banner on load, and a pure
  // test must not reach for a database at all. `_notifyFatalNew` requires it lazily, so seeding
  // the cache first means the real module is never loaded.
  const notified = [];
  let us = null;
  const notifyPath = require.resolve('../src/lib/notify');
  const hadNotify = require.cache[notifyPath];
  require.cache[notifyPath] = { id: notifyPath, filename: notifyPath, loaded: true, exports: {
    notifyAppStaff: async (...a) => { notified.push(a); },
    notifyAdmins: async (...a) => { notified.push(a); },
  } };
  // A pool stub, kept so this file can never reach a real database if a lazily-required module
  // grows one. `_notifyFatalNew` no longer reads (see the note there); nothing else here does.
  const dbPath = require.resolve('../src/db');
  const hadDb = require.cache[dbPath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
    // Answers the guard's read the way the real query does: the ROW if it is visible on this
    // connection, nothing if it is not. Returning only a rowCount was itself a column-list-shaped
    // trap — the guard reads `rows[0].sev`, so a stub without it silently made every case look
    // like "not visible".
    async query(_sql, params) {
      const row = us.rows.find(r => r.id === params[0]);
      if (!row) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [{ sev: String(row.severity || '').trim().toLowerCase() }] };
    },
  } };
  try {
    us = new Store();
    const uc = mkClient(us);
    const up = (severity, status) => ({
      applicationId: 'app-upgrade', source: 'investor_guideline_desk', kind: 'finding',
      title: 'Feasibility report required', body: 'x', severity,
      dedupeKey: 'isg-gap:upgrade', evidence: { code: 'isg_gap_201' }, _status: status,
    });
    const live = await aiSug.record(uc, up('warning'));
    // The staffer escalates it — still live, still needs handling, not a decision.
    us.rows.find(r => r.id === live.id).status = 'escalated';
    notified.length = 0;
    const same = await aiSug.record(uc, up('warning'));
    assert.strictEqual(same.deduped, true, 'a re-record refreshes the escalated row in place');
    assert.strictEqual(us.rows.length, 1, 'and never clones it');
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(notified.length, 0, 'a warning restated as a warning tells nobody — no bombardment');

    const worse2 = await aiSug.record(uc, up('fatal'));
    assert.strictEqual(worse2.deduped, true, 'the dealbreaker still REFRESHES the row, never duplicates it');
    assert.strictEqual(us.rows.length, 1, 'still one row — no phantom duplicate, no 298-email burst');
    assert.strictEqual(us.rows[0].severity, 'fatal', 'and the row now reads as a dealbreaker');
    await new Promise((r) => setImmediate(r));
    assert.ok(notified.length > 0, 'but the file team IS told the item became a dealbreaker');

    // NOTE: there is deliberately no re-read guard in `_notifyFatalNew` — two attempts at one
    // both dropped this alert (see the note there). What keeps the upgrade notify from becoming
    // a per-page-load blast is the rank comparison alone, asserted above and below. The
    // in-transaction behaviour that killed both guards is asserted on a REAL connection in
    // test-isg-one-list-db; a stub store has no MVCC and cannot express it.

    // ...a WARNING raise never claims a dealbreaker. The fan-out's subject line reads "New
    // fatal AI finding"; firing it for a rise from info to warning would be a lie in the inbox.
    us.rows[0].severity = 'info';
    notified.length = 0;
    await aiSug.record(uc, up('warning'));
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(notified.length, 0, 'a rise to WARNING tells nobody — only a dealbreaker does');
    us.rows[0].severity = 'warning';   // back to the pre-upgrade state for the next case

    // ...and `suppressNotify` silences the upgrade branch too. The un-funded re-read sweep sets
    // it because its findings are not new to anyone; without this it would blast the whole book.
    notified.length = 0;
    await aiSug.record(uc, Object.assign({}, up('fatal'), { suppressNotify: true }));
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(notified.length, 0, 'suppressNotify silences an upgrade, not just an insert');
    us.rows[0].severity = 'fatal';     // the row IS a dealbreaker now — the next case restates it

    // ...and a DEALBREAKER RESTATED AS A DEALBREAKER says nothing. This is the half that stops
    // the upgrade notify becoming a per-page-load blast: the desk re-records the same finding
    // every time anyone opens the file.
    notified.length = 0;
    const again2 = await aiSug.record(uc, up('fatal'));
    assert.strictEqual(again2.deduped, true, 'the fatal is refreshed in place again');
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(notified.length, 0,
      'a fatal restated as a fatal notifies nobody — no per-page-load bombardment');
  } finally {
    if (hadNotify) require.cache[notifyPath] = hadNotify; else delete require.cache[notifyPath];
    if (hadDb) require.cache[dbPath] = hadDb; else delete require.cache[dbPath];
  }

  // THE STUB MUST HAVE UNDERSTOOD EVERY STATEMENT IT WAS ASKED (re-audit 2026-07-27).
  // Without this the file reports success for doors it never actually opened — which is
  // exactly what happened when two SELECT lists gained a `severity` column and these
  // anchored patterns stopped matching.
  const unhandled = STORES.flatMap((st) => st.unhandled);
  assert.deepStrictEqual(unhandled, [],
    'the stub did not recognise every statement — a door under test went dark:\n'
    + unhandled.join('\n'));

  console.log('test-ai-suggestions-pure: record/dedupe/decide-all-actions/note/askAdmin/answer/fromCureNewFinding all pass');
})().catch(e => { console.error(e); process.exit(1); });
