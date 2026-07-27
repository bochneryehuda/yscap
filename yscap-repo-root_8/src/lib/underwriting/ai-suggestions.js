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
/**
 * Sources whose rows are ADVISORY BACKGROUND — they belong in the findings list, but must NOT
 * score, rank or notify (post-merge audit 2026-07-27).
 *
 * WHY THIS EXISTS. The file view deliberately keeps the note-buyer desk's rows OUT of
 * `summary.fatal/warning/info` (`routes/underwriting.js`, `isgOnly`) so the desk can never disagree
 * with the clear-to-close gate. But SIX other queries aggregate this table with no source filter,
 * and they re-admitted the same rows through a different door — so the two surfaces contradicted
 * each other. Measured: up to 7 desk rows on one file x 8 points = 56, which pushes a file with
 * ZERO real problems past the 50-point ELEVATED threshold and puts an amber risk badge on the
 * pipeline; it also promoted note-only files into the admin "top 5 riskiest" email and started a
 * weekly "your files with open AI findings" digest for officers whose files have nothing wrong.
 *
 * One definition, so a seventh consumer cannot drift. This is about SCORING and NOTIFYING only —
 * these rows still render, are still dismissable, and a genuinely fatal one still notifies through
 * `record()`'s own severity guard.
 */
const ADVISORY_ONLY_SOURCES = ['investor_guideline_desk'];

/**
 * A stored `ai_suggestions` row, in the shape `finding-claims.claimOf` keys on.
 *
 * THE ONE PLACE THAT ANSWERS "WHICH FINDING IS THIS ROW ABOUT?" (re-audit 2026-07-27).
 * Four call sites need it — `listForFile`'s claim stamp, `record()`'s ledger consult,
 * `decide()`'s ledger write, and the escalation door — and the first cut hand-rolled the
 * shape at each one. They drifted immediately, and the drift was invisible:
 *
 *   - `decide()` gated its whole ledger write on a non-null `code`, taken from
 *     `evidence.code` = the spec row's `pilot_template_code`. EVERY row that carries a
 *     `concern_field` — i.e. every row that has a fact to declare — has a NULL template
 *     code, and structurally so: `desk.js` routes any row WITH a template code to the
 *     `document` disposition, and only the non-document dispositions carry a concern
 *     field. So the ledger was never written for exactly the findings the fact key
 *     exists for, and "dismiss it once and it's gone" silently did nothing for them.
 *   - `listForFile` stamped its claim key without the fact derivation, so a desk row
 *     whose sibling had merged away in the Open-findings list did not recognise itself
 *     as already-shown and rendered a second card for the same fact — re-creating, in
 *     the AI Findings panel, the duplication this whole change removes.
 *
 * The desk's code lives in its `dedupe_key` (`isg-appraisal_review:3345`), normalized by
 * the SAME `codeOf` the finding producer uses — so the row and the finding it mirrors
 * always agree.
 *
 * THE DESK'S CODE IS ITS DEDUPE KEY, ALWAYS — NOT `evidence.code` (third audit pass).
 * `evidence.code` on a desk row is the PILOT CONDITION TEMPLATE the guideline maps to
 * (`rtl_cond_fraud`), which is a different namespace from the finding's own code
 * (`isg_gap_rtl_cond_fraud`) and is SHARED by every guideline pointing at that template.
 * Preferring it did two wrong things at once:
 *   - a coverage-gap mirror could never key-match the finding it mirrors, so the AI panel
 *     had no way to recognise it as already shown;
 *   - worse, several rows collapsed onto ONE key. Blue Lake cond 44 carries BOTH a
 *     `concern_field` and `pilot_template_code: 'rtl_cond_fraud'` (the "explicit
 *     disposition wins" branch in desk.js runs before the template-code branch, so a row
 *     can have both — the earlier comment here claimed otherwise and was simply wrong).
 *     Dismissing that non-arm's-length CONCERN wrote a ledger row keyed `rtl_cond_fraud`,
 *     which then suppressed the unrelated BACKGROUND-CHECK / OFAC coverage gap — a finding
 *     nobody had decided about, refused a row by `record()` yet still rendered, with no
 *     buttons. Deriving from the dedupe key keys them `isg_concern_44` and
 *     `isg_gap_rtl_cond_fraud`: distinct, and each matching its own finding.
 * The derivation is scoped to the desk's own source; every other producer writes a real
 * finding code into `evidence.code` and is untouched.
 */
/**
 * Close every OTHER open suggestion on this file that declares the SAME fact.
 *
 * The fact is read straight out of what the producer stored (`evidence.concern_field`,
 * or an explicit `evidence.factKey`) and compared to the settled fact — so this can only
 * ever reach rows that would re-merge into the card the human just dismissed. It matches
 * no code and no condition template, which is deliberate: a template code is shared by
 * several unrelated guidelines, and matching on one would settle findings nobody decided.
 *
 * Only rows still awaiting a decision are touched, and never the row being decided.
 * Best-effort: a failure leaves the sibling open (visible), never hides one.
 */
async function closeSiblingClaims(c, { applicationId, factKey, exceptId, action, by } = {}) {
  try {
    if (!applicationId || !factKey) return 0;
    const r = await c.query(
      `UPDATE ai_suggestions
          SET status = 'dismissed',
              status_reason = COALESCE(status_reason, $5),
              decided_by_staff_id = COALESCE($4, decided_by_staff_id),
              decided_at = now()
        WHERE application_id = $1
          AND id <> COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
          AND status IN ('open','escalated','marked_important','asked_admin')
          AND COALESCE(
                evidence->>'factKey',
                'isg_signal:' || NULLIF(COALESCE(
                  evidence->>'concern_field',
                  proposed_action->'fields'->>'concern_field'), '')
              ) = $3`,
      [applicationId, exceptId || null, factKey, by || null,
       `Settled with the same finding (${String(action || 'dismissed')}) — one decision, one fact.`]);
    return r.rowCount || 0;
  } catch (_) { return 0; }
}

function claimShapeOf(row) {
  const r = row || {};
  const ev = r.evidence || {};
  const pa = r.proposed_action || r.proposedAction || {};
  const paf = pa.fields || {};
  let code = null;
  if (r.source === 'investor_guideline_desk' && r.dedupe_key) {
    try { code = require('./investor-guidelines/desk-findings')._internals.codeOf(r.dedupe_key); } catch (_) { /* fall through */ }
  }
  if (!code) code = ev.code || paf.code || null;
  const concernField = ev.concern_field || paf.concern_field || null;
  return {
    code,
    factKey: ev.factKey || (concernField ? `isg_signal:${concernField}` : undefined),
    field: ev.field || paf.field || null,
    document_id: r.document_id || null,
    docValue: ev.docValue || ev.doc_value || null,
  };
}
function notScoredSql(alias) {
  const a = alias ? `${alias}.` : '';
  return `${a}source <> ALL(ARRAY[${ADVISORY_ONLY_SOURCES.map((s) => `'${s}'`).join(',')}]::text[])`;
}

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
  // A DISMISSED SUGGESTION MUST NOT COME BACK (owner-reported 2026-07-27: "I hit
  // Dismiss and it keeps popping up again").
  //
  // ROOT CAUSE. The dedupe below matched ONLY `status='open'`. A dismissed row is
  // not open, so it was invisible to the dedupe and this function inserted a
  // BRAND-NEW open row for the identical finding — on the very next sync pass,
  // which runs every time a staffer opens the file. The human's decision was
  // recorded and then immediately overwritten by a fresh copy of the same finding.
  //
  // THE RULE. A row for this exact (file, source, dedupe_key) that a HUMAN DECIDED
  // — dismissed, converted to a condition or task, or noted — is the last word. Do
  // not re-raise it.
  //
  // NOT decisions, and deliberately excluded: `escalated` / `marked_important` /
  // `asked_admin` mean "this still needs handling, louder", so they stay in the live
  // set below and are refreshed in place exactly as before; and `answered` means the
  // super-admin REPLIED to a question the AI asked, which is an answer, not a
  // judgement that the issue is closed — the ask-admin flow has its own dedupe (one
  // unanswered inbox question per agent+scope+question) and is entitled to ask again.
  //
  // Belt-and-suspenders with the per-FINDING ledger (db/333) checked further down:
  // this half catches the suggestion surface, the ledger half catches the same
  // finding arriving from the Document Review desk or a derived desk.
  if (s.dedupeKey) {
    try {
      const settled = await c.query(
        `SELECT id, status FROM ai_suggestions
          WHERE application_id=$1 AND source=$2 AND dedupe_key=$3
            AND status NOT IN ('open','escalated','marked_important','asked_admin','answered')
            AND decided_by_staff_id IS NOT NULL
          ORDER BY decided_at DESC NULLS LAST, created_at DESC
          LIMIT 1`,
        [s.applicationId, s.source, s.dedupeKey]);
      if (settled.rows[0]) {
        return { id: settled.rows[0].id, deduped: true, settled: true, status: settled.rows[0].status };
      }
    } catch (_) { /* fail OPEN: an unreadable check just means the suggestion shows again */ }
  }
  // The per-FINDING durable ledger (db/333): the SAME issue may have been settled
  // from the Document Review desk or the "Findings to review" queue, where it has
  // no ai_suggestions row to match on. Keyed on the finding's identity, so a
  // decision taken on any surface silences it on every surface.
  try {
    // Same shape as every other consumer (claimShapeOf) — the incoming payload uses
    // camelCase where a stored row uses snake_case, so it is normalized first.
    const shape = claimShapeOf({
      evidence: s.evidence, proposed_action: s.proposedAction,
      source: s.source, dedupe_key: s.dedupeKey, document_id: s.documentId,
    });
    if (shape.code) {
      const fdec = require('./finding-decisions');
      const set = await fdec.suppressedKeys(c, s.applicationId);
      if (set.size && fdec.isSuppressed(set, shape)) return { id: null, deduped: false, settled: true };
    }
  } catch (_) { /* fail OPEN */ }
  // If a dedupe key is provided, look for a LIVE row and refresh it in place.
  // "Live" now includes escalated / marked-important / asked-admin (they are ways
  // of saying "this still needs handling", not decisions) so a re-run REFRESHES
  // the row the staffer is already working instead of stacking a second copy of it
  // next to their escalation. A plain 'open' row still wins the pick.
  if (s.dedupeKey) {
    const cur = await c.query(
      `SELECT id FROM ai_suggestions
        WHERE application_id=$1 AND source=$2 AND dedupe_key=$3
          AND status IN ('open','escalated','marked_important','asked_admin')
        ORDER BY (status='open') DESC, created_at DESC LIMIT 1`,
      [s.applicationId, s.source, s.dedupeKey]);
    if (cur.rows[0]) {
      await c.query(
        `UPDATE ai_suggestions SET
            document_id=COALESCE($2, document_id),
            checklist_item_id=COALESCE($3, checklist_item_id),
            kind=$4, title=$5, body=$6,
            evidence=$7::jsonb, proposed_action=$8::jsonb,
            severity=$9, confidence=$10, trace_url=$11,
            -- NEVER clear a flag a human raised: an agent re-run passes
            -- important:false by default, which would silently un-mark the row
            -- the staffer just flagged. OR it, never overwrite it.
            important=(important OR $12)
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
  // setImmediate so the caller's transaction gets a chance to COMMIT first.
  // Best-effort — a notify failure never rolls back the suggestion.
  // KNOWN GAP (audit 2026-07-27): the comment here used to claim `_notifyFatalNew` re-verifies the
  // row still exists before sending. It does not — it issues no query. Several callers record
  // inside a transaction, so if a LATER step in that transaction fails and rolls back, the email
  // has already been scheduled and goes out for a row that no longer exists. Pre-existing and rare
  // (a rollback after a successful insert), but do not rely on a re-verify that isn't there — add
  // a real `SELECT 1 FROM ai_suggestions WHERE id=$1` inside _notifyFatalNew to close it.
  // `suppressNotify` = the row BELONGS in the list, but this particular write is not a "chase this
  // now" event, so the team is not emailed. TWO independent producers arrived at the same flag on
  // 2026-07-27 and both reasons stand — do not narrow it to either one:
  //   1. The un-funded RE-READ sweep re-reads OLD documents across the whole book, so its findings
  //      are not new to the humans. Emailing each would be a portfolio-wide bombardment of alerts
  //      staff have already seen — and would re-notify a fatal a human already dismissed, since the
  //      dedupe only matches OPEN rows. A caller that is RE-recording, not surfacing something new,
  //      sets this.
  //   2. The note-buyer guideline desk's empty-file-slot and appraisal-read items: there is no
  //      document to collect and nobody to chase, so the row exists (a human's Dismiss can stick)
  //      without an email. That producer sets it BY SEVERITY, never by kind — a genuinely fatal one
  //      still emails like every other fatal.
  // It changes ONLY whether the team is emailed; the row, its severity, and every surface that
  // reads it are identical. Never set it on a finding a human is expected to act on promptly.
  if (String(s.severity || '').toLowerCase() === 'fatal' && !s.suppressNotify) {
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
  // Stamp each suggestion with its CLAIM KEY (owner 2026-07-27, the "six times" duplication): the
  // SAME semantic key the Open-findings list is deduped by (finding-claims.claimOf). The AI Findings
  // panel uses it to HIDE any suggestion whose claim is already shown in the one deduped list, so a
  // fact reached by several desks appears ONCE instead of re-listed here. Best-effort + pure; a code
  // that isn't in a claim family gets a per-row key that matches nothing (so it still shows).
  let claimOf = null;
  try { claimOf = require('./finding-claims').claimOf; } catch (_) { claimOf = null; }
  return q.rows.map((r) => {
    if (!claimOf) return r;
    let claimKey = null;
    try { claimKey = claimOf(claimShapeOf(r)); } catch (_) { claimKey = null; }
    return { ...r, claim_key: claimKey };
  });
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

  // THE DECISION IS DURABLE, ACROSS SURFACES (owner-reported 2026-07-27).
  // Recording it only on this row was never enough: the SAME issue is also raised
  // by the DERIVED desks (tie-out, chains, liquidity, experience, note-buyer
  // guidelines), which are pure functions of the file and re-raise on every view
  // with no row to carry a decision. The ledger (db/333) is keyed on the finding's
  // identity, so dismissing it here silences it everywhere — that is what makes it
  // actually disappear. Best-effort: never rolls back the decision.
  try {
    const shape = claimShapeOf(cur);
    if (shape.code) {
      const fdec = require('./finding-decisions');
      if (fdec.suppresses(newStatus)) {
        await fdec.record(c, {
          applicationId: cur.application_id, finding: shape, origin: 'ai_suggestion',
          decision: newStatus, note: statusReason || decision.note || null, decidedBy: staffId,
        });
        // …AND CLOSE THE OTHER ROWS ASSERTING THE SAME FACT (third audit pass).
        //
        // The ledger settles the FINDING, which is what the Open-findings list reads. The
        // AI Findings panel reads ROWS, and hides a mirror only while its claim is visible
        // in that list — so the instant the dismiss settled the merged card, the card left
        // the list, the claim left the "already shown" set, and the sibling producer's
        // mirror UN-HID. One dismiss, and the same rural item was live again one panel
        // over, needing a second dismiss: the owner's symptom, relocated rather than fixed.
        //
        // A human settled the fact, so every row asserting that fact is settled. Matched on
        // the DECLARED fact only (never a code, never a template), so it can reach exactly
        // the rows that would re-merge into the same card and nothing else. Best-effort and
        // inside the same guarded block: it can never roll back the human's decision.
        if (shape.factKey) await closeSiblingClaims(c, {
          applicationId: cur.application_id, factKey: shape.factKey, exceptId: cur.id,
          action: newStatus, by: staffId,
        });
      } else if (newStatus === 'open') {
        // "Unmark important" puts the row back to open — a re-open, not a decision.
        await fdec.reopen(c, { applicationId: cur.application_id, finding: shape, by: staffId });
      }
    }
  } catch (_) { /* ledger is additive — never blocks a human's decision */ }

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
  // Dedupe key = agent + SCOPE + full-question hash (audit fixes 2026-07-23):
  //   * the scope (condition/doc, else 'file') keeps the cure engine's CONSTANT
  //     question text from collapsing ACROSS documents — doc B's escalation must
  //     not be swallowed because doc A's identical question is still unanswered;
  //   * a sha256 of the WHOLE question (not a 30-byte base64 prefix) keeps two
  //     different staff questions with a shared prefix from colliding.
  const scope = checklistItemId || documentId || 'file';
  const qHash = require('crypto').createHash('sha256').update(String(question)).digest('hex').slice(0, 24);
  const dedupe = `q:${agent}:${scope}:${qHash}`;
  // Fix 2026-07-23: record()'s dedupe only matches status='open' suggestions,
  // but this function flips its suggestion to 'asked_admin' below — so every
  // repeat call (e.g. each cure re-run on the same document) stacked a brand-new
  // suggestion + a DUPLICATE super-admin inbox question. Check for a live
  // UNANSWERED question on the same (file, dedupe) first. Legacy rows written
  // before dedupe_key existed match by (agent + question text) — but ONLY for a
  // file-scoped ask: a doc/condition-scoped ask must never be suppressed by an
  // unscoped legacy row for a different document.
  const legacyMatch = scope === 'file';
  const dup = await c.query(
    `SELECT id, suggestion_id FROM ai_admin_questions
      WHERE application_id=$1 AND answered_at IS NULL
        AND (dedupe_key=$2 OR ($5 AND dedupe_key IS NULL AND agent=$3 AND question=$4))
      ORDER BY asked_at DESC LIMIT 1`,
    [applicationId, dedupe, agent, question, legacyMatch]);
  if (dup.rows[0]) return { suggestionId: dup.rows[0].suggestion_id, questionId: dup.rows[0].id, deduped: true };
  const sug = await record(c, {
    applicationId, documentId, checklistItemId,
    source: 'ask_admin', kind: 'question',
    title: `${agent}: ${String(question).slice(0, 120)}`,
    body: question,
    evidence: { context: context || {}, agent },
    dedupeKey: dedupe,
  });
  // SAVEPOINT (best-effort — no-op outside a transaction) so a lost 23505 race
  // on the db/264 partial-unique index doesn't abort the CALLER's transaction:
  // rolled back to the savepoint, the re-select works and resolves the race.
  let sp = false;
  try { await c.query('SAVEPOINT ask_admin'); sp = true; } catch (_) { /* not in a tx */ }
  let q;
  try {
    q = await c.query(
      `INSERT INTO ai_admin_questions (suggestion_id, application_id, agent, question, context, dedupe_key)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6) RETURNING *`,
      [sug.id, applicationId, agent, question, JSON.stringify(context || {}), dedupe]);
    if (sp) await c.query('RELEASE SAVEPOINT ask_admin').catch(() => {});
  } catch (e) {
    if (sp) await c.query('ROLLBACK TO SAVEPOINT ask_admin').catch(() => {});
    if (e && e.code === '23505') {
      // A concurrent ask won the race — return its row. (With the savepoint
      // rolled back this works even inside a caller transaction; without a
      // savepoint the re-select fails on the aborted tx and we rethrow.)
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
function fromCureNewFinding({ applicationId, documentId, checklistItemId, extractionId, finding, traceUrl, suppressNotify }) {
  return {
    applicationId, documentId, checklistItemId,
    suppressNotify,
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

module.exports = { ADVISORY_ONLY_SOURCES, notScoredSql,
  record, recordMany, listForFile, decide, addNote,
  askAdmin, answerAdminQuestion, listOpenAdminQuestions,
  fromCureNewFinding,
  VALID_STATUSES,
  // Exported for the regression test that pins the row -> finding key invariant: a desk
  // row must key on the FINDING's code, never on the condition template several rows share.
  _internals: { claimShapeOf, closeSiblingClaims },
};
