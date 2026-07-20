'use strict';

/**
 * Reminders + task management (#93) — the engine behind a loan file's "Remind"
 * button. Staff schedule a reminder or a task with a due date+time, a set of
 * recipients (any mix of the loan team, the borrower/co-borrower, or an ad-hoc
 * email), and a message. A lightweight dispatcher (started from server.js) fans
 * the notification out at the due moment via the normal notify service, so the
 * in-app + branded-email plumbing, borrower notification preferences, and the
 * note-buyer redaction rules all keep applying.
 *
 * Recipients are described by the client as ROLE TOKENS ({kind:'self'|
 * 'loan_officer'|'processor'|'underwriter'|'borrower'|'co_borrower'} / an
 * explicit {kind:'staff',id} / an {kind:'email',email}) and RESOLVED on the
 * server against the file + actor into concrete {kind,id/email,name,role}
 * entries. That keeps the client from having to know every email and lets the
 * stored list stay meaningful even if the roster later changes.
 */
const db = require('../db');
const notify = require('./notify');
const email = require('./email');
const cfg = require('../config');
const { fileReplyTo } = require('./file-address');   // #68 per-file shared reply-to

const KINDS = new Set(['reminder', 'task']);

function niceWhen(due) {
  try {
    return new Date(due).toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  } catch (_) { return String(due); }
}

// Resolve the client's recipient tokens into concrete, de-duplicated entries.
// Unknown / unfilled roles (e.g. "processor" on a file with no processor) are
// silently dropped rather than erroring, so the caller never has to pre-check.
async function resolveRecipients(app, actorId, tokens, client = db) {
  const out = [];
  const seen = new Set();
  const staffIds = new Set();
  const borrowerIds = new Set();
  const emails = new Map();   // lowercased email -> display name

  for (const t of Array.isArray(tokens) ? tokens : []) {
    if (!t || typeof t !== 'object') continue;
    const kind = String(t.kind || '').toLowerCase();
    if (kind === 'self') { if (actorId) staffIds.add(actorId); }
    else if (kind === 'loan_officer') { if (app.loan_officer_id) staffIds.add(app.loan_officer_id); }
    else if (kind === 'processor') { if (app.processor_id) staffIds.add(app.processor_id); }
    else if (kind === 'underwriter') { if (app.underwriter_id) staffIds.add(app.underwriter_id); }
    else if (kind === 'staff') { if (t.id) staffIds.add(t.id); }
    else if (kind === 'borrower') { if (app.borrower_id) borrowerIds.add(app.borrower_id); }
    else if (kind === 'co_borrower') { if (app.co_borrower_id) borrowerIds.add(app.co_borrower_id); }
    else if (kind === 'email') {
      const e = String(t.email || '').trim().toLowerCase();
      if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) emails.set(e, String(t.name || '').trim() || e);
    }
  }

  if (staffIds.size) {
    const r = await client.query(
      `SELECT id, full_name, email, role FROM staff_users WHERE id = ANY($1::uuid[]) AND is_active=true`,
      [[...staffIds]]);
    for (const s of r.rows) {
      const key = 'staff:' + s.id; if (seen.has(key)) continue; seen.add(key);
      out.push({ kind: 'staff', id: s.id, name: s.full_name || s.email, email: s.email || null, role: s.role || null });
    }
  }
  if (borrowerIds.size) {
    const r = await client.query(
      `SELECT id, first_name, last_name, email FROM borrowers WHERE id = ANY($1::uuid[])`,
      [[...borrowerIds]]);
    for (const b of r.rows) {
      const key = 'borrower:' + b.id; if (seen.has(key)) continue; seen.add(key);
      const isCo = app.co_borrower_id && b.id === app.co_borrower_id;
      out.push({
        kind: 'borrower', id: b.id,
        name: [b.first_name, b.last_name].filter(Boolean).join(' ') || b.email || 'Borrower',
        email: b.email || null, role: isCo ? 'co_borrower' : 'borrower',
      });
    }
  }
  for (const [e, name] of emails) {
    const key = 'email:' + e; if (seen.has(key)) continue; seen.add(key);
    out.push({ kind: 'email', email: e, name: name || e, role: 'contact' });
  }
  return out;
}

// The set of contacts the composer offers for a file (role tokens + concrete
// details for display). Loan-team members come from the file's assignments; the
// borrower + co-borrower from the file. "You" is always offered.
async function contactsForApplication(appId, actor, client = db) {
  const ar = await client.query(
    `SELECT a.borrower_id, a.co_borrower_id, a.loan_officer_id, a.processor_id, a.underwriter_id,
            b.first_name AS b_first, b.last_name AS b_last, b.email AS b_email,
            cb.first_name AS c_first, cb.last_name AS c_last, cb.email AS c_email
       FROM applications a
       JOIN borrowers b ON b.id=a.borrower_id
       LEFT JOIN borrowers cb ON cb.id=a.co_borrower_id
      WHERE a.id=$1`, [appId]);
  const a = ar.rows[0];
  if (!a) return [];
  const staffIds = [a.loan_officer_id, a.processor_id, a.underwriter_id, actor && actor.id].filter(Boolean);
  const staffById = {};
  if (staffIds.length) {
    const sr = await client.query(
      `SELECT id, full_name, email, role FROM staff_users WHERE id = ANY($1::uuid[])`, [staffIds]);
    for (const s of sr.rows) staffById[s.id] = s;
  }
  const out = [];
  const nameOf = (id) => (staffById[id] ? (staffById[id].full_name || staffById[id].email) : null);
  out.push({ token: 'self', kind: 'staff', label: 'You' + (nameOf(actor && actor.id) ? ` (${nameOf(actor.id)})` : ''), role: 'you' });
  if (a.loan_officer_id && a.loan_officer_id !== (actor && actor.id))
    out.push({ token: 'loan_officer', kind: 'staff', label: `Loan officer${nameOf(a.loan_officer_id) ? ` - ${nameOf(a.loan_officer_id)}` : ''}`, role: 'loan_officer' });
  if (a.processor_id)
    out.push({ token: 'processor', kind: 'staff', label: `Processor${nameOf(a.processor_id) ? ` - ${nameOf(a.processor_id)}` : ''}`, role: 'processor' });
  if (a.underwriter_id)
    out.push({ token: 'underwriter', kind: 'staff', label: `Underwriter${nameOf(a.underwriter_id) ? ` - ${nameOf(a.underwriter_id)}` : ''}`, role: 'underwriter' });
  if (a.borrower_id)
    out.push({ token: 'borrower', kind: 'borrower', label: `Borrower${[a.b_first, a.b_last].filter(Boolean).length ? ` - ${[a.b_first, a.b_last].filter(Boolean).join(' ')}` : ''}`, role: 'borrower' });
  if (a.co_borrower_id)
    out.push({ token: 'co_borrower', kind: 'borrower', label: `Co-borrower${[a.c_first, a.c_last].filter(Boolean).length ? ` - ${[a.c_first, a.c_last].filter(Boolean).join(' ')}` : ''}`, role: 'co_borrower' });
  return out;
}

// Borrower-facing outstanding items for the "prefill outstanding conditions"
// helper. Deliberately uses the BORROWER label/title only (never the internal
// wording, which can carry capital-partner detail) - safe to show to anyone.
// Each outstanding item as "Label — exactly what's needed" (owner-directed
// 2026-07-20: a notification must never just say "2 items outstanding" — it must
// list the EXACT items with their details). For a checklist item the detail is
// its borrower hint, or — if the item was sent back — the reason it needs redoing.
// For a condition it's the borrower-facing detail. Detail is trimmed/capped; the
// notifyBorrower chokepoint scrubs any staff-typed text before it reaches the
// borrower. Returns formatted STRINGS (drop-in for every existing caller).
function _fmtItem(label, detail) {
  const d = (detail == null ? '' : String(detail)).replace(/\s+/g, ' ').trim();
  const l = String(label || '').trim();
  return d ? `${l} — ${d.length > 160 ? d.slice(0, 157) + '…' : d}` : l;
}
async function outstandingItems(appId, client = db) {
  const items = await client.query(
    `SELECT COALESCE(borrower_label,label) AS label,
            CASE WHEN status='issue' AND issue_reason IS NOT NULL THEN 'sent back — ' || issue_reason
                 ELSE COALESCE(borrower_hint, hint) END AS detail
       FROM checklist_items
      WHERE application_id=$1 AND audience IN ('borrower','both')
        AND status IN ('outstanding','requested','issue')
      ORDER BY sort_order LIMIT 30`, [appId]);
  const conds = await client.query(
    `SELECT borrower_title AS label, borrower_detail AS detail FROM conditions
      WHERE application_id=$1 AND audience IN ('borrower','both') AND borrower_title IS NOT NULL
        AND status IN ('open','borrower_responded') LIMIT 30`, [appId]);
  return [...items.rows, ...conds.rows].map((r) => _fmtItem(r.label, r.detail)).filter(Boolean);
}

async function listForApplication(appId, client = db) {
  const r = await client.query(
    `SELECT r.*, cu.full_name AS created_by_name, au.full_name AS assignee_name,
            comp.full_name AS completed_by_name
       FROM reminders r
       LEFT JOIN staff_users cu ON cu.id=r.created_by
       LEFT JOIN staff_users au ON au.id=r.assignee_staff_id
       LEFT JOIN staff_users comp ON comp.id=r.completed_by
      WHERE r.application_id=$1
      ORDER BY (r.status IN ('done','dismissed','cancelled')) ASC, r.due_at ASC`,
    [appId]);
  return r.rows;
}

async function create(appId, input, actor, client = db) {
  const ar = await client.query(
    `SELECT id, borrower_id, co_borrower_id, loan_officer_id, processor_id, underwriter_id
       FROM applications WHERE id=$1`, [appId]);
  const app = ar.rows[0];
  if (!app) { const e = new Error('application not found'); e.status = 404; throw e; }

  const kind = KINDS.has(String(input.kind)) ? input.kind : 'reminder';
  const title = String(input.title || '').trim();
  if (!title) { const e = new Error('a title is required'); e.status = 400; throw e; }
  const due = input.dueAt ? new Date(input.dueAt) : null;
  if (!due || isNaN(due.getTime())) { const e = new Error('a valid due date/time is required'); e.status = 400; throw e; }
  const remindAt = input.remindAt ? new Date(input.remindAt) : null;
  const recipients = await resolveRecipients(app, actor && actor.id, input.recipients, client);
  if (!recipients.length) { const e = new Error('add at least one recipient'); e.status = 400; throw e; }
  let assignee = null;
  if (kind === 'task' && input.assigneeStaffId) {
    const sr = await client.query(`SELECT id FROM staff_users WHERE id=$1 AND is_active=true`, [input.assigneeStaffId]);
    if (sr.rows[0]) assignee = sr.rows[0].id;
  }

  const r = await client.query(
    `INSERT INTO reminders (application_id, kind, title, body, due_at, remind_at, recipients, assignee_staff_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) RETURNING id`,
    [appId, kind, title, String(input.body || '').trim() || null, due.toISOString(),
     remindAt && !isNaN(remindAt.getTime()) ? remindAt.toISOString() : null,
     JSON.stringify(recipients), assignee, actor && actor.id || null]);
  return r.rows[0].id;
}

async function update(id, patch, actor, client = db) {
  const cur = await client.query(`SELECT * FROM reminders WHERE id=$1`, [id]);
  const row = cur.rows[0];
  if (!row) { const e = new Error('reminder not found'); e.status = 404; throw e; }

  const sets = [], vals = []; let i = 1;
  const add = (col, v) => { sets.push(`${col}=$${i++}`); vals.push(v); };

  if (typeof patch.title === 'string' && patch.title.trim()) add('title', patch.title.trim());
  if ('body' in patch) add('body', String(patch.body || '').trim() || null);
  if (patch.dueAt) { const d = new Date(patch.dueAt); if (!isNaN(d.getTime())) { add('due_at', d.toISOString()); add('fired_at', null); if (row.status === 'sent') add('status', 'scheduled'); } }
  if ('remindAt' in patch) { const d = patch.remindAt ? new Date(patch.remindAt) : null; add('remind_at', d && !isNaN(d.getTime()) ? d.toISOString() : null); add('reminded_at', null); }
  if (patch.status === 'done') { add('status', 'done'); add('completed_at', new Date().toISOString()); add('completed_by', actor && actor.id || null); }
  else if (patch.status === 'dismissed') { add('status', 'dismissed'); add('completed_at', new Date().toISOString()); add('completed_by', actor && actor.id || null); }
  else if (patch.status === 'cancelled') { add('status', 'cancelled'); }
  else if (patch.status === 'scheduled') { add('status', 'scheduled'); add('completed_at', null); add('completed_by', null); }

  if (!sets.length) return row;
  sets.push('updated_at=now()'); vals.push(id);
  const r = await client.query(`UPDATE reminders SET ${sets.join(',')} WHERE id=$${i} RETURNING *`, vals);
  return r.rows[0];
}

async function remove(id, client = db) {
  await client.query(`DELETE FROM reminders WHERE id=$1`, [id]);
}

// Send a reminder's notification to every recipient. Reused for the due firing
// and the optional pre-due nudge (prefix differs). Best-effort per recipient.
async function _deliver(row, { lead } = {}) {
  const recipients = Array.isArray(row.recipients) ? row.recipients : [];
  const when = niceWhen(row.due_at);
  const isTask = row.kind === 'task';
  const label = isTask ? 'Task' : 'Reminder';
  const titleLine = lead
    ? `Upcoming ${label.toLowerCase()}: ${row.title}`
    : `${label}: ${row.title}`;
  const bodyLines = [];
  if (row.body) bodyLines.push(row.body);
  bodyLines.push(lead ? `Due ${when}.` : (isTask ? `This task is due now (${when}).` : `This was scheduled for ${when}.`));
  const body = bodyLines.join(' ');
  const link = `/app/${row.application_id}`;   // notifyBorrower/notifyStaff route by audience
  const staffLink = `/internal/app/${row.application_id}`;
  // The staff/borrower copies get file identity for free (enrichFileOpts inside
  // notifyStaff/notifyBorrower). The ad-hoc email branch below builds via
  // buildEmail directly, so fetch the file context ONCE here to give that email
  // the same file-tagged subject + detail block.
  const ctx = row.application_id ? await notify.fileContext(row.application_id).catch(() => null) : null;

  for (const rcp of recipients) {
    try {
      if (rcp.kind === 'staff' && rcp.id) {
        await notify.notifyStaff(rcp.id, {
          type: 'reminder', title: titleLine, body,
          applicationId: row.application_id, link: staffLink, ctaLabel: 'Open the loan file',
        });
      } else if (rcp.kind === 'borrower' && rcp.id) {
        await notify.notifyBorrower(rcp.id, {
          type: 'reminder', title: titleLine, body,
          applicationId: row.application_id, link, ctaLabel: 'Open your file',
        });
      } else if (rcp.kind === 'email' && rcp.email) {
        const msg = notify.buildEmail({
          type: 'reminder', title: titleLine, body, link: staffLink, ctaLabel: 'Open the loan file',
          subjectTag: ctx ? ctx.subjectTag : undefined, meta: ctx ? ctx.meta : undefined,
        }, 'staff');
        // #68: the ad-hoc recipient (title co, escrow…) is the one most likely
        // to reply with the answer — route it to the file's assigned team like
        // the staff/borrower copies of this same reminder; fall back to the
        // monitored inbox so the reply is never a dead end.
        await email.sendMail({ to: [rcp.email], subject: msg.subject, text: msg.text, html: msg.html,
          replyTo: fileReplyTo(row.application_id) || cfg.replyToDefault || null }).catch(() => {});
      }
    } catch (_) { /* one bad recipient never blocks the rest */ }
  }
}

// One dispatch pass: fire due reminders and any pre-due nudges. Idempotent -
// fired_at / reminded_at stamps stop a row from being sent twice.
async function dispatchDue(client = db) {
  let fired = 0;
  // A reminder/task on a file that is funded, on hold, declined or withdrawn is
  // no longer active work (owner-directed 2026-07-14) — it must NOT fire a
  // notification. We DON'T stamp those rows, so they stay scheduled and simply
  // pause: if the file later comes off hold (or is otherwise reactivated) the
  // reminder becomes eligible again and fires. The row is always visible inside
  // the file. (A reminder with no linked application still fires normally.)
  // file_intake (#151): pre-processing prospects are muted like held files —
  // no task nudges until the file actually enters processing.
  const NOT_MUTED = `(a.id IS NULL OR a.status NOT IN ('funded','on_hold','declined','withdrawn','file_intake'))`;
  // 1) Pre-due nudges (tasks with remind_at reached, not yet nudged, not fired).
  const leads = await client.query(
    `SELECT r.* FROM reminders r
       LEFT JOIN applications a ON a.id=r.application_id
      WHERE r.status='scheduled' AND r.remind_at IS NOT NULL AND r.reminded_at IS NULL
        AND r.fired_at IS NULL AND r.remind_at <= now() AND r.due_at > now()
        AND ${NOT_MUTED}
      ORDER BY r.remind_at LIMIT 100`);
  for (const row of leads.rows) {
    // CLAIM the row atomically BEFORE delivering (owner-reported duplicate sweep
    // 2026-07-20): the mark used to happen AFTER _deliver, so two overlapping
    // passes — a slow pass still awaiting sends when the next 60s tick fires, or
    // two instances during a deploy overlap — could both select this un-nudged
    // row and both send it. `WHERE reminded_at IS NULL RETURNING` lets exactly one
    // pass win the claim; the loser skips.
    const claim = await client.query(`UPDATE reminders SET reminded_at=now(), updated_at=now() WHERE id=$1 AND reminded_at IS NULL RETURNING id`, [row.id]);
    if (!claim.rows[0]) continue;
    await _deliver(row, { lead: true });
  }
  // 2) Due firings.
  const due = await client.query(
    `SELECT r.* FROM reminders r
       LEFT JOIN applications a ON a.id=r.application_id
      WHERE r.status='scheduled' AND r.fired_at IS NULL AND r.due_at <= now()
        AND ${NOT_MUTED}
      ORDER BY r.due_at LIMIT 100`);
  for (const row of due.rows) {
    // CLAIM atomically BEFORE delivering (same duplicate guard as the nudge loop):
    // `WHERE fired_at IS NULL RETURNING` means only ONE overlapping pass wins and
    // delivers; the loser skips instead of sending a second copy.
    // A one-shot reminder is 'sent' once fired; a task stays actionable (still
    // 'scheduled' with fired_at stamped) so it lives on until marked done.
    const claim = await client.query(
      row.kind === 'task'
        ? `UPDATE reminders SET fired_at=now(), updated_at=now() WHERE id=$1 AND fired_at IS NULL RETURNING id`
        : `UPDATE reminders SET fired_at=now(), status='sent', updated_at=now() WHERE id=$1 AND fired_at IS NULL RETURNING id`,
      [row.id]);
    if (!claim.rows[0]) continue;   // another pass already claimed + delivered it
    await _deliver(row, {});
    fired++;
  }
  return fired;
}

let dispatcherStarted = false;
function startDispatcher() {
  if (dispatcherStarted) return;
  dispatcherStarted = true;
  // Minute cadence: reminders are scheduled to the minute, so this fires each due
  // one within ~60s. Cheap query (partial index on status='scheduled').
  setInterval(() => { dispatchDue().catch((e) => console.error('[reminders] dispatch:', e.message)); }, 60000).unref();
}

module.exports = {
  resolveRecipients, contactsForApplication, outstandingItems,
  listForApplication, create, update, remove,
  dispatchDue, startDispatcher,
};
