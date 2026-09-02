'use strict';
/**
 * PRIOR TO SUBMITTAL — COMPLETED (owner-directed 2026-09-02).
 *
 * The owner: *"After the bunch of prior to submittal conditions there should
 * be an option of a button that a loan officer can click — Prior to submittal
 * completed — nicely designed. And it should come up over there outstanding
 * what else he needs to do to complete … Everything that he clicks Done goes
 * down this list, and then he can click Complete Prior to Submittal."* And
 * what is NOT his: *"The actual ordering we can let the loan setup guy do, so
 * you don't need to do the VOR order, the insurance order, the title order.
 * Basically everything else other than that."*
 *
 * ── WHAT THIS IS ────────────────────────────────────────────────────────────
 * ONE definition of "what does the officer still have to do before this file
 * can be handed over", and the one door that records the hand-over.
 *
 *   readiness(loanId)   the list: every prior-to-submission condition that is
 *                       the officer's, each with what still blocks it, or done.
 *   complete(loanId)    the button: refuses while anything is outstanding,
 *                       otherwise stamps the loan (db/669) and tells ClickUp.
 *
 * ── THE RULES, AND WHERE THEY LIVE ──────────────────────────────────────────
 * The list does not decide what "done" means for a condition. `write.js`'s
 * sign-off gate does — the same rules the back office signs off against — asked
 * at the OFFICER stage (an upload counts before it is accepted; see
 * `signOffProblem`). So the entity's three documents, the credit reissued
 * before the mortgages count, the contacts on the file, the card on the
 * profile, the choice answered, the contract uploaded: each is ONE rule, read
 * here and at the sign-off door, and the two can never disagree about whether
 * a condition is finished.
 *
 * On top of the substance, the officer's own step: the condition is done for
 * this list when the back office has signed it off (or waived it), OR when the
 * substance is there AND the officer has pressed Done on it. Substance without
 * Done is "click Done on it"; Done without substance is listed with what is
 * still missing — a Done stamp on an empty condition is not a finished one.
 *
 * ── WHOSE CONDITIONS ────────────────────────────────────────────────────────
 * The orders (`kind: 'order'`) and the envelope that goes out to the landlord
 * (`kind: 'esign'` — the verification of rent) are the loan-setup desk's, by
 * the owner's own list, and are shown as such rather than counted. A template
 * switched off in the library is not anybody's. Everything else in the bucket
 * is the officer's.
 *
 * ── WHAT IT REFUSES ─────────────────────────────────────────────────────────
 * `complete` re-reads the list at the moment of the click and refuses with it
 * if anything is outstanding: the button is a check, not a claim. A second
 * click on a completed file is answered "already", never a second stamp.
 * Nothing here writes ClickUp directly — that is `clickup/submittal.js`, behind
 * the writer's own switches — and a card that is not linked yet, or a ClickUp
 * that is down, leaves the completion RECORDED and the push OWED, which the
 * sync worker retries every tick.
 */

const db = require('../db');
const read = require('./read');
const write = require('./write');

/** The two kinds that are the loan-setup desk's, by the owner's list. */
const NOT_THE_OFFICERS = Object.freeze(new Set(['order', 'esign']));

/** The bucket, in the library's own key. */
const BUCKET = 'prior_to_submission';

/** The officer's own step, said in one place. */
const CLICK_DONE = 'Click Done on it.';

/**
 * Judge ONE condition for the officer's list.
 *
 * @param {object} c       a shaped condition from `read.forLoan` (internal audience)
 * @param {object|null} found  `write.loadCondition`'s answer, or null when the
 *                             condition is already done and need not be loaded
 * @returns {{done:boolean, blockers:string[], how:string|null}}
 */
function judge(c, found) {
  if (read.DONE.has(c.status)) {
    const how = c.status === 'satisfied' ? 'signed off'
      : c.status === 'waived' ? 'waived'
        : 'did not apply';
    return { done: true, blockers: [], how };
  }
  if (!found) {
    // The condition could not be read at all — never "done", and said so.
    return { done: false, blockers: ['PILOT could not read this condition just now.'], how: null };
  }
  const gate = write.signOffProblem(found.condition, found.files, {
    readFailed: found.readFailed, entity: found.entity, contacts: found.contacts,
    liabilities: found.liabilities, card: found.card, stage: 'officer',
  });
  const blockers = [];
  if (!gate.ok) blockers.push(gate.why);
  const marked = !!c.reviewedAt;
  if (!marked) blockers.push(CLICK_DONE);
  return { done: gate.ok && marked, blockers, how: gate.ok && marked ? 'marked done' : null };
}

/** The completion stamp and the ClickUp state, off the loan row. */
async function stateOf(loanId, client) {
  const { rows } = await client.query(
    `SELECT l.submittal_completed_at, l.submittal_completed_by,
            su.full_name AS submittal_completed_by_name,
            l.submittal_clickup_pushed_at, l.submittal_clickup_error,
            l.clickup_task_id, l.clickup_url, l.clickup_custom_id
       FROM lt_loans l
       LEFT JOIN staff_users su ON su.id = l.submittal_completed_by
      WHERE l.id = $1::uuid`,
    [String(loanId)],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    completed: r.submittal_completed_at
      ? { at: r.submittal_completed_at, by: r.submittal_completed_by || null, byName: r.submittal_completed_by_name || null }
      : null,
    clickup: {
      taskId: r.clickup_task_id || null,
      url: r.clickup_url || null,
      customId: r.clickup_custom_id || null,
      pushedAt: r.submittal_clickup_pushed_at || null,
      error: r.submittal_clickup_error || null,
      // Owed = declared complete, not yet on the card. Said as a fact so the
      // screen can say "it will be filled when a card is linked" truthfully.
      owed: !!(r.submittal_completed_at && !r.submittal_clickup_pushed_at),
    },
  };
}

/**
 * THE LIST.
 *
 * @returns {Promise<{ok:boolean, ready:boolean, items:Array, orders:Array,
 *   outstanding:number, total:number, completed:object|null, clickup:object,
 *   degraded:string|null}>}
 *   never throws — an unreadable file answers ok:false with the reason.
 */
async function readiness(loanId, opts = {}) {
  const client = opts.db || db;
  const out = { ok: true, ready: false, items: [], orders: [], outstanding: 0, total: 0, completed: null, clickup: null, degraded: null };
  let state;
  try {
    state = await stateOf(loanId, client);
  } catch (e) {
    return { ...out, ok: false, degraded: `Could not read the loan: ${String((e && e.message) || e).slice(0, 200)}` };
  }
  if (!state) return { ...out, ok: false, degraded: 'No such long-term loan.' };
  out.completed = state.completed;
  out.clickup = state.clickup;

  let list;
  try {
    list = await read.forLoan(loanId, { audience: 'internal', db: client });
  } catch (e) {
    return { ...out, ok: false, degraded: `Could not read the conditions: ${String((e && e.message) || e).slice(0, 200)}` };
  }
  if (list.degraded) out.degraded = list.degraded;
  const bucket = (list.buckets || []).find((b) => b.key === BUCKET);
  const conditions = bucket ? bucket.conditions : [];

  for (const c of conditions) {
    if (c.enabled === false) continue;               // switched off in the library: nobody's
    const row = { id: c.id, code: c.code, label: c.label, kind: c.kind, status: c.status, reviewedAt: c.reviewedAt || null };
    if (NOT_THE_OFFICERS.has(String(c.kind))) {
      out.orders.push({ ...row, done: read.DONE.has(c.status) || c.status === 'received' });
      continue;
    }
    let found = null;
    if (!read.DONE.has(c.status)) {
      try { found = await write.loadCondition(loanId, c.id, client); } catch (_) { found = null; }
    }
    const verdict = judge(c, found);
    out.items.push({ ...row, ...verdict });
  }
  out.total = out.items.length;
  out.outstanding = out.items.filter((i) => !i.done).length;
  // A file with NO officer conditions at all is not "ready" — it has not been
  // evaluated. The rules run by themselves (db/668); this is the moment before.
  out.ready = out.total > 0 && out.outstanding === 0 && !out.degraded;
  return out;
}

/**
 * THE BUTTON.
 *
 * @returns {Promise<{ok:true, already?:boolean, completed:object, clickup:object, push?:object}
 *   | {ok:false, status:number, error:string, outstanding?:Array}>}
 */
async function complete(loanId, staffId, opts = {}) {
  const client = opts.db || db;
  if (!staffId) {
    return { ok: false, status: 400, error: 'Completing the prior-to-submittal work records who did it, so it needs a signed-in member of staff.' };
  }
  const r = await readiness(loanId, { db: client });
  if (!r.ok) return { ok: false, status: 503, error: r.degraded || 'Could not read this file just now.' };
  if (r.completed) {
    return { ok: true, already: true, completed: r.completed, clickup: r.clickup };
  }
  if (!r.ready) {
    const left = r.items.filter((i) => !i.done);
    return {
      ok: false,
      status: 422,
      error: r.degraded
        ? `Some of this file could not be read (${r.degraded}), so it cannot be declared complete yet.`
        : `${left.length} prior-to-submittal item${left.length === 1 ? ' is' : 's are'} still outstanding: ${left.map((i) => i.label).join(', ')}.`,
      outstanding: left,
    };
  }
  // THE STAMP — once. The WHERE makes two clicks at the same moment one stamp.
  const { rows } = await client.query(
    `UPDATE lt_loans
        SET submittal_completed_at = now(), submittal_completed_by = $2::uuid, updated_at = now()
      WHERE id = $1::uuid AND submittal_completed_at IS NULL
      RETURNING submittal_completed_at`,
    [String(loanId), String(staffId)],
  );
  if (!rows.length) {
    const again = await stateOf(loanId, client);
    return { ok: true, already: true, completed: again && again.completed, clickup: again && again.clickup };
  }

  // TELL CLICKUP — best-effort, after the stamp is safely down. A push that
  // cannot land leaves the completion owed, and the worker retries it.
  let push = null;
  try {
    push = await require('../clickup/submittal').pushForLoan(loanId, { db: client });
  } catch (e) {
    push = { ok: false, reason: String((e && e.message) || e).slice(0, 200) };
  }
  const state = await stateOf(loanId, client);
  return { ok: true, completed: state.completed, clickup: state.clickup, push };
}

module.exports = {
  readiness,
  complete,
  stateOf,
  NOT_THE_OFFICERS,
  BUCKET,
  CLICK_DONE,
  _internals: { judge },
};
