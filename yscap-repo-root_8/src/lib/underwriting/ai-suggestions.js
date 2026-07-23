'use strict';
/**
 * AI Suggestions store (owner-directed 2026-07-22, HARD RULE).
 *
 * Every AI agent in PILOT writes here INSTEAD of taking direct action. Suggestions live
 * on a file's "AI Findings" panel; every action is a human click:
 *   Escalate · Add note · Convert to condition · Convert to task ·
 *   Mark important · Dismiss (with reason) · Ask super-admin.
 *
 * The AI never:
 *   * creates a checklist condition
 *   * changes a file's status
 *   * signs off / clears / declines / overrides anything
 *   * spawns document_findings on its own
 *   * issues certificates
 *   * applies promoted rules to real data
 * All of those become suggestions in this table with a proposed_action payload the
 * human confirms.
 *
 * SOURCES (add new ones as agents come online — the enum is enforced by convention
 * not a CHECK constraint so agents can extend it without a migration):
 *   cure_analysis, promoted_rules, committee, section_1071, twin_reconcile,
 *   authenticity, entity_chain, assignment_fraud, wrong_condition, ask_admin, splitter
 *
 * KINDS:
 *   finding       — suggests raising a document finding
 *   condition     — suggests attaching a checklist condition
 *   certificate   — suggests issuing a decision certificate
 *   value_pick    — twin value-picking suggestion
 *   question      — a plain question for the super-admin (kind='question' + source='ask_admin')
 *   info          — informational, no proposed action
 */

let _db = null;
const db = () => (_db || (_db = require('../../db')));

const VALID_STATUSES = new Set([
  'open', 'escalated', 'noted', 'converted_to_condition', 'converted_to_task',
  'dismissed', 'marked_important', 'asked_admin', 'answered',
]);

/**
 * Record a suggestion. Idempotent when { source, dedupe_key } collide on the same file
 * with status='open' — a second call updates the OPEN row in place instead of duplicating.
 * @param {*} client — pg client (uses a fresh connection if omitted; caller-tx honored)
 * @param {{
 *   applicationId: string, documentId?: string, checklistItemId?: string,
 *   source: string, kind: string, title: string, body?: string,
 *   evidence?: object, proposedAction?: object,
 *   severity?: string, confidence?: number, traceUrl?: string,
 *   dedupeKey?: string, important?: boolean,
 * }} s
 * @returns {Promise<{id:string, deduped:boolean}>}
 */
async function record(client, s) {
  const c = client || db();
  if (!s || !s.applicationId || !s.source || !s.kind || !s.title) {
    throw new Error('ai-suggestions.record: applicationId, source, kind, title required');
  }
  // R4.8 — Portfolio-wide code mute. If the finding's evidence.code (or the
  // proposedAction.fields.code, when the evidence is empty) is in
  // ai_silenced_codes, DROP the record silently. Belt-and-suspenders — the
  // caller sees a normal success shape so the AI pipeline never branches on
  // whether it fired or not.
  try {
    const code = (s.evidence && s.evidence.code) || (s.proposedAction && s.proposedAction.fields && s.proposedAction.fields.code) || null;
    if (code) {
      const mute = await c.query(`SELECT 1 FROM ai_silenced_codes WHERE code=$1 LIMIT 1`, [code]);
      if (mute.rowCount > 0) return { id: null, deduped: false, silenced: true };
    }
  } catch (_) { /* if the mute table isn't migrated yet, fall through */ }
  // If a dedupe key is provided, look for an OPEN row and refresh it in place.
  if (s.dedupeKey) {
    const cur = await c.query(
      `SELECT id FROM ai_suggestions
        WHERE application_id=$1 AND source=$2 AND dedupe_key=$3 AND status='open' LIMIT 1`,
      [s.applicationId, s.source, s.dedupeKey]);
    if (cur.rows[0]) {
      await c.query(
        `UPDATE ai_suggestions SET
            document_id=COALESCE($2, document_id),
            checklist_item_id=COALESCE($3, checklist_item_id),
            kind=$4, title=$5, body=$6,
            evidence=$7::jsonb, proposed_action=$8::jsonb,
            severity=$9, confidence=$10, trace_url=$11,
            important=$12
          WHERE id=$1`,
        [cur.rows[0].id, s.documentId || null, s.checklistItemId || null,
         s.kind, s.title, s.body || null,
         JSON.stringify(s.evidence || {}), JSON.stringify(s.proposedAction || {}),
         s.severity || null, s.confidence != null ? Number(s.confidence) : null, s.traceUrl || null,
         !!s.important]);
      return { id: cur.rows[0].id, deduped: true };
    }
  }
  const ins = await c.query(
    `INSERT INTO ai_suggestions
       (application_id, document_id, checklist_item_id, source, kind, title, body,
        evidence, proposed_action, severity, confidence, trace_url, dedupe_key, important)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14)
     RETURNING id`,
    [s.applicationId, s.documentId || null, s.checklistItemId || null,
     s.source, s.kind, s.title, s.body || null,
     JSON.stringify(s.evidence || {}), JSON.stringify(s.proposedAction || {}),
     s.severity || null, s.confidence != null ? Number(s.confidence) : null, s.traceUrl || null,
     s.dedupeKey || null, !!s.important]);
  const rowId = ins.rows[0].id;
  // R3.39 — real-time notify on NEW fatal AI suggestions. Fires only on the
  // fresh-insert branch (dedupe path above never re-notifies). Scheduled via
  // setImmediate so the caller's transaction gets a chance to COMMIT first,
  // and then re-verifies the row still exists (defensive against a rollback).
  // Best-effort — a notify failure never rolls back the suggestion.
  if (String(s.severity || '').toLowerCase() === 'fatal') {
    setImmediate(() => { _notifyFatalNew(s, rowId).catch(() => { /* additive */ }); });
  }
  return { id: rowId, deduped: false };
}

/**
 * Fire a staff notification for a new fatal AI finding. In-app + email to the
 * file's LO + processor (and admins-that-should-know via notifyAdmins). Uses
 * the notify chokepoint's file enrichment so the subject + meta name the file.
 * Best-effort — never throws.
 */
async function _notifyFatalNew(s, suggestionId) {
  try {
    const notify = require('../notify');
    const applicationId = s.applicationId;
    // Registered notify type `ai_fatal_finding` — action-bearing so NOT in
    // STAFF_INAPP_TYPES; the notify layer emails LO/processor and lets the
    // recipient's category preference silence it if they've muted 'conditions'.
    const opts = {
      applicationId,
      type: 'ai_fatal_finding',
      title: 'New fatal AI finding',
      body: `AI detected a fatal issue on this file: "${(s.title || '').slice(0, 140)}". Open the AI Findings panel to review, escalate, or dismiss.`,
      link: `/internal/app/${applicationId}#ai-findings-${suggestionId}`,
      ctaLabel: 'Open the AI Findings panel',
      // Kicker auto-mapped from type via KICKER_OF; category auto-mapped via CATEGORY_OF.
    };
    // Fan out to the file's staff (LO + processor + assistants). notifyAppStaff
    // enriches the subject line with the file identity and wires the officer card.
    if (typeof notify.notifyAppStaff === 'function') {
      await notify.notifyAppStaff(applicationId, opts);
    }
    // Also loop admins in so a rogue AI signal on a file isn't missed if the LO
    // is off-hours. Keyed to the same message; notifyAdmins dedupes by (type,
    // entity_id) via its own upstream logic.
    if (typeof notify.notifyAdmins === 'function') {
      await notify.notifyAdmins({ ...opts, applicationId });
    }
  } catch (_) { /* additive */ }
}

/**
 * Bulk-record: run record() over an array of suggestions. Each failure is swallowed so a
 * single bad row never derails the batch (agents produce dozens at a time).
 * @returns {Promise<{recorded:number, deduped:number, failed:number}>}
 */
async function recordMany(client, arr) {
  let recorded = 0, deduped = 0, failed = 0;
  for (const s of (arr || [])) {
    try {
      const r = await record(client, s);
      if (r.deduped) deduped += 1; else recorded += 1;
    } catch (_) { failed += 1; }
  }
  return { recorded, deduped, failed };
}

/**
 * List open suggestions for a file. Newest first, IMPORTANT rows pinned to the top.
 * @param {{status?:string, source?:string, includeDismissed?:boolean, limit?:number}} opts
 */
async function listForFile(appId, opts = {}, client) {
  const c = client || db();
  const conds = ['application_id=$1'];
  const params = [appId];
  if (opts.status) { params.push(opts.status); conds.push(`status=$${params.length}`); }
  else if (!opts.includeDismissed) { conds.push(`status <> 'dismissed'`); }
  if (opts.source) { params.push(opts.source); conds.push(`source=$${params.length}`); }
  const limit = Math.min(200, Math.max(1, Number(opts.limit) || 100));
  const q = await c.query(
    `SELECT * FROM ai_suggestions
      WHERE ${conds.join(' AND ')}
      ORDER BY important DESC, created_at DESC LIMIT ${limit}`, params);
  return q.rows;
}

/**
 * Apply a human's decision to a suggestion.
 * @param {*} client pg client (transaction honored)
 * @param {string} id — suggestion id
 * @param {{action:string, staffId?:string, reason?:string, note?:string,
 *          conditionId?:string, taskId?:string}} decision
 *   actions: 'escalate' | 'note' | 'convert_to_condition' | 'convert_to_task' |
 *            'mark_important' | 'unmark_important' | 'dismiss' | 'ask_admin' | 'answer_admin'
 * @returns {Promise<{ok:boolean, row:object}>}
 */
async function decide(client, id, decision = {}) {
  const c = client || db();
  const cur = (await c.query(`SELECT * FROM ai_suggestions WHERE id=$1`, [id])).rows[0];
  if (!cur) throw new Error('ai-suggestions.decide: suggestion not found');
  const staffId = decision.staffId || null;
  const at = new Date().toISOString();
  let newStatus = cur.status;
  let statusReason = decision.reason || null;
  let important = cur.important;
  let linkedCondition = cur.linked_condition_id;
  let linkedTask = cur.linked_task_id;

  switch ((decision.action || '').toLowerCase()) {
    case 'escalate': newStatus = 'escalated'; break;
    case 'dismiss':  newStatus = 'dismissed'; break;
    case 'note':     newStatus = 'noted'; break;
    case 'mark_important':   important = true;  newStatus = 'marked_important'; break;
    case 'unmark_important': important = false; newStatus = cur.status === 'marked_important' ? 'open' : cur.status; break;
    case 'convert_to_condition':
      if (!decision.conditionId) throw new Error('convert_to_condition needs conditionId');
      linkedCondition = decision.conditionId;
      newStatus = 'converted_to_condition';
      break;
    case 'convert_to_task':
      if (!decision.taskId) throw new Error('convert_to_task needs taskId');
      linkedTask = decision.taskId;
      newStatus = 'converted_to_task';
      break;
    case 'ask_admin':  newStatus = 'asked_admin'; break;
    case 'answer_admin': newStatus = 'answered'; break;
    default: throw new Error(`ai-suggestions.decide: unknown action ${decision.action}`);
  }
  if (!VALID_STATUSES.has(newStatus)) throw new Error(`invalid status ${newStatus}`);

  // Append the note (if any) to the notes array — the trigger updates updated_at.
  let notes = Array.isArray(cur.notes) ? cur.notes.slice() : [];
  if (decision.note) notes.push({ staff_id: staffId, at, action: decision.action, text: String(decision.note) });

  const upd = await c.query(
    `UPDATE ai_suggestions SET
       status=$2, status_reason=$3,
       decided_by_staff_id=COALESCE($4, decided_by_staff_id), decided_at=now(),
       important=$5, linked_condition_id=$6, linked_task_id=$7, notes=$8::jsonb
     WHERE id=$1 RETURNING *`,
    [id, newStatus, statusReason, staffId, important, linkedCondition, linkedTask, JSON.stringify(notes)]);

  // R3.42 — a suggestion the human dismissed / converted / noted / signed off in
  // ANY terminal way no longer needs the super-admin's answer. Auto-close every
  // still-open ai_admin_questions row that references this suggestion, marking
  // the answer text with a machine note so the super-admin's inbox stops
  // showing questions whose underlying finding has been decided by the LO. The
  // ONLY status where we keep the question OPEN is 'asked_admin' itself (the
  // question was just posted; obviously don't close it in the same breath).
  // Best-effort — a failure never rolls back the suggestion decision.
  if (newStatus !== 'asked_admin') {
    try {
      await c.query(
        `UPDATE ai_admin_questions
            SET answered_at = COALESCE(answered_at, now()),
                answer      = COALESCE(answer, $2),
                answered_by_staff_id = COALESCE(answered_by_staff_id, $3)
          WHERE suggestion_id = $1 AND answered_at IS NULL`,
        [id, `[auto-closed] suggestion decided (${newStatus})`, staffId]);
    } catch (_) { /* additive */ }
  }

  return { ok: true, row: upd.rows[0] };
}

/**
 * Add a note without changing the row's status (for quick per-suggestion comments).
 */
async function addNote(client, id, { staffId, text } = {}) {
  const c = client || db();
  if (!text || !String(text).trim()) throw new Error('addNote: text required');
  const cur = (await c.query(`SELECT notes FROM ai_suggestions WHERE id=$1`, [id])).rows[0];
  if (!cur) throw new Error('addNote: not found');
  const notes = Array.isArray(cur.notes) ? cur.notes.slice() : [];
  notes.push({ staff_id: staffId || null, at: new Date().toISOString(), text: String(text) });
  await c.query(`UPDATE ai_suggestions SET notes=$2::jsonb WHERE id=$1`, [id, JSON.stringify(notes)]);
  return { ok: true };
}

// ------------------------------ ADMIN QUESTIONS -----------------------------

/**
 * The AI asks the super-admin a question. Creates an ai_suggestions(kind='question')
 * row so it shows on the file's AI panel, AND an ai_admin_questions row on the super-
 * admin inbox — one write is the source of truth for each surface.
 */
async function askAdmin(client, { applicationId, agent, question, context, documentId, checklistItemId } = {}) {
  const c = client || db();
  if (!applicationId || !agent || !question) throw new Error('askAdmin: applicationId, agent, question required');
  // Dedupe by (agent + question) so the same open question doesn't stack across runs.
  const dedupe = 'q:' + agent + ':' + Buffer.from(String(question)).toString('base64').slice(0, 40);
  // Fix 2026-07-23: record()'s dedupe only matches status='open' suggestions,
  // but this function flips its suggestion to 'asked_admin' below — so every
  // repeat call (e.g. each cure re-run on the same document) stacked a brand-new
  // suggestion + a DUPLICATE super-admin inbox question. Check for a live
  // UNANSWERED question on the same (file, dedupe) first; legacy rows written
  // before dedupe_key was populated match by (agent + question text).
  const dup = await c.query(
    `SELECT id, suggestion_id FROM ai_admin_questions
      WHERE application_id=$1 AND answered_at IS NULL
        AND (dedupe_key=$2 OR (dedupe_key IS NULL AND agent=$3 AND question=$4))
      ORDER BY asked_at DESC LIMIT 1`,
    [applicationId, dedupe, agent, question]);
  if (dup.rows[0]) return { suggestionId: dup.rows[0].suggestion_id, questionId: dup.rows[0].id, deduped: true };
  const sug = await record(c, {
    applicationId, documentId, checklistItemId,
    source: 'ask_admin', kind: 'question',
    title: `${agent}: ${String(question).slice(0, 120)}`,
    body: question,
    evidence: { context: context || {}, agent },
    dedupeKey: dedupe,
  });
  let q;
  try {
    q = await c.query(
      `INSERT INTO ai_admin_questions (suggestion_id, application_id, agent, question, context, dedupe_key)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6) RETURNING *`,
      [sug.id, applicationId, agent, question, JSON.stringify(context || {}), dedupe]);
  } catch (e) {
    if (e && e.code === '23505') {
      // A concurrent ask won the db/264 partial-unique race. Inside a caller
      // transaction the tx is already aborted, so the re-select fails too and
      // we rethrow for the caller's rollback path; outside a tx it resolves.
      try {
        const again = await c.query(
          `SELECT id, suggestion_id FROM ai_admin_questions
            WHERE application_id=$1 AND dedupe_key=$2 AND answered_at IS NULL LIMIT 1`,
          [applicationId, dedupe]);
        if (again.rows[0]) return { suggestionId: again.rows[0].suggestion_id, questionId: again.rows[0].id, deduped: true };
      } catch (_) { /* aborted tx — fall through to rethrow */ }
    }
    throw e;
  }
  await c.query(`UPDATE ai_suggestions SET status='asked_admin' WHERE id=$1 AND status='open'`, [sug.id]);
  return { suggestionId: sug.id, questionId: q.rows[0].id };
}

async function answerAdminQuestion(client, questionId, { staffId, answer } = {}) {
  const c = client || db();
  if (!answer || !String(answer).trim()) throw new Error('answerAdminQuestion: answer required');
  const upd = await c.query(
    `UPDATE ai_admin_questions
        SET answered_by_staff_id=$2, answered_at=now(), answer=$3
      WHERE id=$1 RETURNING suggestion_id, application_id, agent, question, context`,
    [questionId, staffId || null, String(answer)]);
  if (!upd.rows[0]) throw new Error('answerAdminQuestion: not found');
  const row = upd.rows[0];
  // Close the on-file suggestion.
  if (row.suggestion_id) {
    await decide(c, row.suggestion_id, { action: 'answer_admin', staffId, note: `Super-admin answer: ${String(answer)}` });
  }
  // Best-effort learning capture — a super-admin answer becomes a training signal for
  // the specific agent that asked. Learning is additive; a failure never blocks the answer.
  try {
    const learning = require('./learning');
    if (learning && typeof learning.captureAdminAnswer === 'function') {
      await learning.captureAdminAnswer(c, {
        applicationId: row.application_id, agent: row.agent,
        question: row.question, answer: String(answer), context: row.context || {},
      });
    }
    await c.query(`UPDATE ai_admin_questions SET learning_captured=true WHERE id=$1`, [questionId]);
  } catch (_) { /* learning module may not have this yet — best-effort */ }
  return { ok: true };
}

async function listOpenAdminQuestions({ appId, limit = 100 } = {}, client) {
  const c = client || db();
  const params = [];
  const conds = ['answered_at IS NULL'];
  if (appId) { params.push(appId); conds.push(`application_id=$${params.length}`); }
  const q = await c.query(
    `SELECT * FROM ai_admin_questions
      WHERE ${conds.join(' AND ')}
      ORDER BY asked_at ASC LIMIT ${Math.min(200, Math.max(1, Number(limit) || 100))}`, params);
  return q.rows;
}

// -------------------------- CONVENIENCE FACTORIES --------------------------

/**
 * Convert a cure-analysis new-finding proposal into an AI suggestion row.
 * The cure engine used to INSERT into document_findings directly — now that's suggested.
 */
function fromCureNewFinding({ applicationId, documentId, checklistItemId, extractionId, finding, traceUrl }) {
  return {
    applicationId, documentId, checklistItemId,
    source: 'cure_analysis', kind: 'finding',
    title: finding.title || finding.code || 'AI noticed a new issue',
    body: finding.howTo || null,
    severity: finding.severity || 'warning',
    confidence: finding.confidence || null,
    traceUrl,
    evidence: {
      code: finding.code,
      field: finding.field || null,
      docValue: finding.docValue != null ? String(finding.docValue) : null,
      fileValue: finding.fileValue != null ? String(finding.fileValue) : null,
      extractionId: extractionId || null,
    },
    proposedAction: {
      type: 'create_finding',
      fields: {
        code: finding.code, severity: finding.severity || 'warning',
        title: finding.title, howTo: finding.howTo,
        source: 'cure_analysis',
        opensCondition: finding.opens_condition || finding.opensCondition || null,
        blocksCtc: !!finding.blocksCtc,
        field: finding.field || null,
        docValue: finding.docValue != null ? String(finding.docValue) : null,
        fileValue: finding.fileValue != null ? String(finding.fileValue) : null,
      },
    },
    dedupeKey: `cure:${checklistItemId || 'file'}:${finding.code || 'x'}:${finding.field || ''}`,
  };
}

module.exports = {
  record, recordMany, listForFile, decide, addNote,
  askAdmin, answerAdminQuestion, listOpenAdminQuestions,
  fromCureNewFinding,
  VALID_STATUSES,
};
