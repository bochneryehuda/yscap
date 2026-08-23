'use strict';
/**
 * THE ONE WRITE LONG-TERM MAKES INTO CLICKUP — the binding stamp, and nothing else.
 *
 * WHAT IT IS FOR. The owner, 2026-08-23: *"every Encompass Long-Term file should
 * know which ClickUp task belongs to him"*, and, on the go-forward shape,
 * *"Anything new, we can open confidently ... If not, if we're not linking them
 * before, then even old files that already have a ClickUp file are going to create
 * new ones, and we're going to find ourselves with duplicate ClickUps."* PILOT
 * records its side of that link in `lt_loans.clickup_task_id` (db/618); this writes
 * the other side, so the card itself says which loan it belongs to and neither
 * system has to take the other's word for it.
 *
 * WHY IT IS A SEPARATE MODULE FROM THE CLIENT. `client.js` is read-only and
 * structurally so — it refuses every verb but GET before a request is built — and
 * its header says in as many words that the stamp, when it came, would arrive as
 * ONE named function with the write allowlisted by path rather than quietly inside
 * a client that was already allowed to write. This is that function. Nothing here
 * is general: there is no "set a field" helper, no task update, no create, no
 * delete. A second write is a second decision and gets its own argument.
 *
 * THE ALLOWLIST IS THE FEATURE, and it is checked before a request exists:
 *   POST /task/{taskId}/field/{fieldId}   with fieldId one of exactly two —
 *   the portal file id and the portal file link.
 * Every other method, every other path, and any other field id throws. This
 * mirrors `src/encompass/flood-order.js`, the same shape the one authorized
 * Encompass write uses.
 *
 * IT IS OFF UNTIL SOMEBODY TURNS IT ON. `LT_CLICKUP_STAMP_ENABLED` is blank by
 * default and blank means OFF — the opposite of the Encompass master switch, and
 * deliberately: that one guards a connection that is already live and must not be
 * lost on a deploy, this one guards a write that has never happened. A dry run
 * (`LT_CLICKUP_STAMP_DRYRUN`) builds the exact body and sends nothing, so the
 * request can be read before it is made.
 *
 * FOUR THINGS IT WILL NOT DO, each because the failure is expensive:
 *   - It never CLEARS a field. A blank stamp silently unlinks a file, and nothing
 *     downstream could tell that from a file that was never linked.
 *   - It never OVERWRITES a stamp that already holds something else. A card
 *     already claimed by another PILOT file is a contradiction a person needs to
 *     look at, not a race for last writer. It answers `occupied` and stops.
 *   - It never re-writes a stamp that already says exactly what we would write.
 *     ClickUp's rate budget is shared with the RTL sync, and a no-op write spends
 *     from it and shows up in the card's activity log as a change that was not one.
 *   - It never guesses the task. The caller passes a task id that came from a
 *     confirmed link; there is no lookup-by-name path in here to get wrong.
 */

const { SYNC } = require('../../clickup/fields');
const client = require('./client');

const BASE = 'https://api.clickup.com/api/v2';

/** The only two fields this module may ever touch. */
const STAMPABLE = Object.freeze({
  portalFileId: SYNC.portalFileId,
  portalFileLink: SYNC.portalFileLink,
});
const STAMPABLE_IDS = Object.freeze(Object.values(STAMPABLE));

/** Blank means OFF. A write that has never run does not default itself on. */
function enabled() {
  const v = String(process.env.LT_CLICKUP_STAMP_ENABLED || '').trim();
  return /^(1|true|yes|on)$/i.test(v);
}

/** Build the body, log it, send nothing. */
function dryRun() {
  const v = String(process.env.LT_CLICKUP_STAMP_DRYRUN || '').trim();
  return /^(1|true|yes|on)$/i.test(v);
}

/**
 * The gate. Throws BEFORE a request is built, so an unallowed write cannot reach
 * the wire even if a caller assembles one by hand.
 */
function assertStampablePath(method, path) {
  const m = String(method || '').toUpperCase();
  if (m !== 'POST') {
    throw new Error(`Long-Term's ClickUp stamp refuses ${m} — the only write it makes is POST to one custom field.`);
  }
  const match = /^\/task\/[A-Za-z0-9_-]+\/field\/([0-9a-fA-F-]{36})$/.exec(String(path || ''));
  if (!match) {
    throw new Error(`Long-Term's ClickUp stamp refuses the path "${path}" — only /task/{id}/field/{fieldId}.`);
  }
  if (!STAMPABLE_IDS.includes(match[1])) {
    throw new Error(
      'Long-Term\'s ClickUp stamp refuses that field — it may only write the portal file id '
      + 'and the portal file link. Any other field is a separate decision.');
  }
  return true;
}

/** What the card currently holds in a given field, or null. Read-only, via the client. */
function fieldValueOf(task, fieldId) {
  const list = (task && Array.isArray(task.custom_fields)) ? task.custom_fields : [];
  const f = list.find((x) => x && x.id === fieldId);
  const v = f ? f.value : null;
  const s = (v == null) ? '' : String(v).trim();
  return s === '' ? null : s;
}

async function post(path, body) {
  assertStampablePath('POST', path);
  const token = (process.env.LT_CLICKUP_API_TOKEN || process.env.CLICKUP_API_TOKEN || '').trim();
  if (!token) throw new Error('Long-Term ClickUp is not connected — set LT_CLICKUP_API_TOKEN (or the shared CLICKUP_API_TOKEN).');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), parseInt(process.env.LT_CLICKUP_TIMEOUT_MS || '20000', 10));
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { Authorization: token, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  // The body can echo the token back inside an error, so it is never included.
  if (!res.ok) {
    const err = new Error(`ClickUp POST ${path} failed (HTTP ${res.status})`);
    err.status = res.status;
    throw err;
  }
  return true;
}

/**
 * STAMP ONE CARD WITH ONE LOAN'S IDENTITY.
 *
 * Answers, never throws — a stamp is the last step of a link that has already been
 * recorded on our side, and a vendor having a moment must not turn a settled link
 * into an error the caller has to unwind.
 *
 * @param {object} a
 * @param {string} a.taskId    the ClickUp task, from a confirmed link
 * @param {string} a.ltLoanId  the long-term loan's own id — what goes in the field
 * @param {string} [a.fileUrl] the loan's page in PILOT, for the link field
 * @param {object} [a.deps]    { getTask, send } — injected by the tests
 * @returns {Promise<{ok:boolean, wrote:string[], skipped?:string, reason?:string}>}
 */
async function stampTask({ taskId, ltLoanId, fileUrl = null, deps = {} } = {}) {
  const id = String(taskId || '').trim();
  const value = String(ltLoanId || '').trim();
  if (!id) return { ok: false, wrote: [], reason: 'no_task' };
  // Never clear. A blank stamp reads downstream exactly like a file that was
  // never linked, so there is no honest way to write one.
  if (!value) return { ok: false, wrote: [], reason: 'no_value' };
  if (!enabled()) {
    return { ok: false, wrote: [], reason: 'stamping is switched off (set LT_CLICKUP_STAMP_ENABLED to turn it on)' };
  }

  const getTask = deps.getTask || client.getTask;
  const send = deps.send || post;

  let task;
  try {
    task = await getTask(id);
  } catch (e) {
    return { ok: false, wrote: [], reason: `could not read the card first: ${(e && e.message) || e}` };
  }

  const held = fieldValueOf(task, STAMPABLE.portalFileId);
  if (held && held.toLowerCase() === value.toLowerCase()) {
    return { ok: true, wrote: [], skipped: 'already_stamped' };
  }
  if (held) {
    // Somebody else's binding stamp. Two loans pointing at one card is a
    // contradiction for a person, not a race to be won by whoever wrote last.
    return { ok: false, wrote: [], reason: 'occupied', heldBy: held };
  }

  const wrote = [];
  const plan = [{ field: STAMPABLE.portalFileId, value }];
  if (fileUrl) plan.push({ field: STAMPABLE.portalFileLink, value: String(fileUrl) });

  for (const step of plan) {
    const path = `/task/${encodeURIComponent(id)}/field/${step.field}`;
    if (dryRun()) {
      // eslint-disable-next-line no-console
      console.log('[lt-clickup-stamp] DRY RUN', 'POST', path, JSON.stringify({ value: step.value }));
      wrote.push(step.field);
      continue;
    }
    try {
      await send(path, { value: step.value });
      wrote.push(step.field);
    } catch (e) {
      return { ok: false, wrote, reason: (e && e.message) || String(e) };
    }
  }
  return { ok: true, wrote, dryRun: dryRun() };
}

module.exports = {
  STAMPABLE,
  STAMPABLE_IDS,
  enabled,
  dryRun,
  assertStampablePath,
  fieldValueOf,
  stampTask,
  WRITES_ONE_FIELD_ONLY: true,
};
