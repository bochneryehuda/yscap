'use strict';
/**
 * "PRIOR TO SUBMITTAL CONDITIONS → COMPLETED" ON THE CARD — the one ClickUp
 * write the completion makes (owner-directed 2026-09-02).
 *
 * The owner: *"There is a new field added to each ClickUp task — Prior to
 * submittal conditions — a dropdown where you can click on Complete. Any loan
 * officer that finishes all the stuff that he needs to finish is able to click
 * on the Prior to Submittal Completed. That ClickUp field gets filled to
 * Complete, and that moves it up on the list for faster submissions."*
 *
 * ── THE FIELD, READ OFF THE LIVE WORKSPACE (2026-09-02), NEVER GUESSED ──────
 *   id       bfbe7258-c59f-4b52-b0e4-4992ffcd9e11
 *   type     drop_down   "Prior to submittal conditions"
 *   options  one — "Completed" (option id 6fa587f4-… on the day it was read)
 * Read off a live card in an officer's folder, because the list-level field
 * catalogue the writer normally reads had not yet caught up with the field
 * (161 fields on the list, 163 on the card). The FIELD id is pinned here the
 * way every id in `mapper.js` is; the OPTION id is never pinned — dropdown
 * option ids churn when somebody edits the dropdown (`registry.js`), so the
 * option is resolved LIVE, by its label, off the card's own field definition
 * first and the list catalogue second.
 *
 * ── THE SAME GUARDS AS EVERY OTHER WRITE ────────────────────────────────────
 * Goes through `writer-client.setField` (never clears a value, never a wrong
 * verb, never a v3 path), behind the writer's own switches
 * (`LT_CLICKUP_WRITE_ENABLED`, `LT_CLICKUP_WRITE_DRYRUN`), the volume circuit
 * breaker and the write journal from `push.js`. It writes ONE value — the
 * "Completed" option — and only when the card does not already hold it; a
 * re-run on a completed card is a read and a journal line, not a write. It
 * never un-completes: there is no "not completed" option and this module
 * would refuse to write one if there were — undoing a hand-over is a person's
 * act in ClickUp.
 *
 * ── WHEN IT RUNS ────────────────────────────────────────────────────────────
 * On the click (`conditions-center/submittal.complete`), and on every sync
 * tick for any loan that is declared complete and not yet on the card
 * (`pushPass`) — so a loan whose card was linked AFTER the click, or whose
 * push met a ClickUp outage, still gets it. What it could not do is written
 * on the loan in words (`submittal_clickup_error`), never swallowed.
 */

const db = require('../db');
const trash = require('../trash');
const writer = require('./writer-client');
const push = require('./push');

/** The field, as read off the live workspace 2026-09-02. */
const FIELD = Object.freeze({
  id: 'bfbe7258-c59f-4b52-b0e4-4992ffcd9e11',
  name: 'Prior to submittal conditions',
  option: 'Completed',
  key: 'prior_to_submittal',            // the journal's field_key
});

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

/** The dropdown's "Completed" option, off the card's own field definition. */
function completedOption(field) {
  const options = field && field.type_config && Array.isArray(field.type_config.options)
    ? field.type_config.options : [];
  return options.find((o) => norm(o && o.name) === norm(FIELD.option)) || null;
}

/** Does the card already hold the option? Reads come back as an orderindex
 *  integer, sometimes as the option id — both are checked. */
function holdsOption(field, option) {
  if (!field || !option) return false;
  const v = field.value;
  if (v === null || v === undefined || v === '') return false;
  if (String(v) === String(option.id)) return true;
  if (Number.isFinite(Number(v)) && Number(v) === Number(option.orderindex)) return true;
  return false;
}

/**
 * PUSH ONE CARD. Answers, never throws.
 *
 * @param {object} a
 * @param {string} a.taskId
 * @param {string} [a.ltLoanId]  for the journal
 * @param {object} [a.deps]      { getTask, setField } — injected by the tests
 * @returns {Promise<{ok:boolean, wrote:boolean, skipped?:string, reason?:string, dryRun?:boolean}>}
 */
async function pushCompleted({ taskId, ltLoanId = null, deps = {} } = {}) {
  const id = String(taskId || '').trim();
  if (!id) return { ok: false, wrote: false, reason: 'no ClickUp card is linked to this loan yet' };
  if (!push.writeEnabled()) {
    return { ok: false, wrote: false, reason: 'the ClickUp writer is switched off (LT_CLICKUP_WRITE_ENABLED) — the completion is recorded here and will reach the card when it is on' };
  }
  const getTask = deps.getTask || writer.getTask;
  const setField = deps.setField || writer.setField;
  const journal = deps.journal || push._internals.journalFieldWrite;

  let task;
  try {
    task = await getTask(id);
  } catch (e) {
    return { ok: false, wrote: false, reason: `could not read the card first: ${String((e && e.message) || e).slice(0, 160)}` };
  }
  const field = (Array.isArray(task && task.custom_fields) ? task.custom_fields : []).find((f) => f && f.id === FIELD.id);
  if (!field) {
    return { ok: false, wrote: false, reason: `the card has no "${FIELD.name}" field — it has to be added to the list in ClickUp` };
  }
  const option = completedOption(field);
  if (!option) {
    return { ok: false, wrote: false, reason: `the "${FIELD.name}" dropdown has no "${FIELD.option}" option — PILOT never invents one` };
  }
  if (holdsOption(field, option)) {
    await journal({ ltLoanId, taskId: id, fieldId: FIELD.id, fieldKey: FIELD.key, oldValue: FIELD.option, newValue: FIELD.option, changed: false, blocked: false, source: 'submittal' });
    return { ok: true, wrote: false, skipped: 'already_completed' };
  }
  if (push.dryRun()) {
    // eslint-disable-next-line no-console
    console.log('[lt-clickup-submittal] DRY RUN', 'POST', `/task/${id}/field/${FIELD.id}`, JSON.stringify({ value: option.id }));
    return { ok: true, wrote: false, dryRun: true };
  }
  try {
    // The breaker counts the last ten minutes of writes from the JOURNAL, and a
    // fresh process starts with that window empty — so seed it first, exactly as
    // pushLoan/pushPass do, or this module's writes are undercounted.
    await push._internals.seedBreakerFromDb();
    push._internals.circuitCheck();
    await setField(id, FIELD.id, option.id);
    push._internals.countWrite();
    await journal({ ltLoanId, taskId: id, fieldId: FIELD.id, fieldKey: FIELD.key, oldValue: field.value == null ? null : field.value, newValue: FIELD.option, changed: true, blocked: false, source: 'submittal' });
    return { ok: true, wrote: true };
  } catch (e) {
    await journal({ ltLoanId, taskId: id, fieldId: FIELD.id, fieldKey: FIELD.key, oldValue: field.value == null ? null : field.value, newValue: FIELD.option, changed: false, blocked: true, source: 'submittal' });
    return { ok: false, wrote: false, reason: String((e && e.message) || e).slice(0, 200), retryable: !!(e && e.retryable) };
  }
}

/**
 * PUSH FOR ONE LOAN, and record the outcome on it. Answers, never throws.
 * A loan that is not declared complete is left alone (nothing to tell).
 */
async function pushForLoan(loanId, opts = {}) {
  const client = opts.db || db;
  let row;
  try {
    ({ rows: [row] } = await client.query(
      `SELECT id, clickup_task_id, submittal_completed_at, submittal_clickup_pushed_at
         FROM lt_loans WHERE id = $1::uuid`, [String(loanId)]));
  } catch (e) {
    return { ok: false, reason: `could not read the loan: ${String((e && e.message) || e).slice(0, 160)}` };
  }
  if (!row) return { ok: false, reason: 'no such loan' };
  if (!row.submittal_completed_at) return { ok: false, skipped: 'not_completed', reason: 'the prior-to-submittal work has not been declared complete' };
  if (row.submittal_clickup_pushed_at) return { ok: true, skipped: 'already_pushed' };

  const r = await pushCompleted({ taskId: row.clickup_task_id, ltLoanId: row.id, deps: opts.deps || {} });
  try {
    if (r.ok && !r.dryRun) {
      await client.query(
        `UPDATE lt_loans SET submittal_clickup_pushed_at = now(), submittal_clickup_error = NULL,
                submittal_clickup_tried_at = now(), updated_at = now()
          WHERE id = $1::uuid`, [row.id]);
    } else {
      await client.query(
        `UPDATE lt_loans SET submittal_clickup_error = $2, submittal_clickup_tried_at = now(), updated_at = now()
          WHERE id = $1::uuid`,
        [row.id, String(r.reason || (r.dryRun ? 'dry run — nothing was sent' : 'not sent')).slice(0, 500)]);
    }
  } catch (e) {
    return { ...r, recordError: String((e && e.message) || e).slice(0, 160) };
  }
  return r;
}

/** Loans per pass; the owed set is small by nature (one per hand-over). */
/* HOW LONG A LOAN THAT COULD NOT BE PUSHED IS LEFT ALONE (db/678). Long enough
   that a card nobody can fix is asked about a handful of times a day rather
   than every tick; short enough that a card somebody DID fix pushes within the
   hour. Never a retirement — see the migration's header. */
function backoffMinutes() {
  const raw = Number(process.env.LT_SUBMITTAL_PUSH_RETRY_MINUTES);
  return Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : 30;
}

function perPass() {
  const raw = Number(process.env.LT_SUBMITTAL_PUSH_PER_PASS);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 25;
}

/**
 * THE RETRY, on the sync tick: every loan declared complete whose card has not
 * been told, oldest first. Refuses cheaply while the writer is off — one
 * SELECT, no ClickUp call.
 */
async function pushPass(opts = {}) {
  const client = opts.db || db;
  const out = { ok: true, owed: 0, pushed: 0, already: 0, failed: 0, more: false };
  if (!push.writeEnabled()) return { ...out, ok: false, reason: 'the ClickUp writer is switched off (LT_CLICKUP_WRITE_ENABLED)' };
  let rows;
  try {
    ({ rows } = await client.query(
      `SELECT l.id FROM lt_loans l
        WHERE l.submittal_completed_at IS NOT NULL
          AND l.submittal_clickup_pushed_at IS NULL
          AND l.clickup_task_id IS NOT NULL
          AND ${trash.notTrashSql('l')}
          -- BACKED OFF, NEVER RETIRED (db/678): a loan tried inside the window
          -- is skipped this pass, so a permanently unpushable card cannot hold
          -- the front of a bounded queue and starve a loan completed a minute
          -- ago. NULLS FIRST — a loan nobody has tried yet always goes first.
          AND (l.submittal_clickup_tried_at IS NULL
               OR l.submittal_clickup_tried_at < now() - ($2 || ' minutes')::interval)
        ORDER BY l.submittal_clickup_tried_at ASC NULLS FIRST, l.submittal_completed_at ASC
        LIMIT $1`, [opts.limit || perPass(), String(opts.backoffMinutes == null ? backoffMinutes() : opts.backoffMinutes)]));
  } catch (e) {
    return { ...out, ok: false, reason: `could not read which loans are owed: ${String((e && e.message) || e).slice(0, 160)}` };
  }
  out.owed = rows.length;
  out.more = rows.length >= (opts.limit || perPass());
  for (const r of rows) {
    // eslint-disable-next-line no-await-in-loop
    const p = await pushForLoan(r.id, { db: client, deps: opts.deps });
    if (p.ok && p.wrote) out.pushed += 1;
    else if (p.ok) out.already += 1;
    else out.failed += 1;
  }
  return out;
}

module.exports = {
  FIELD,
  pushCompleted,
  pushForLoan,
  pushPass,
  perPass,
  _internals: { completedOption, holdsOption },
};
