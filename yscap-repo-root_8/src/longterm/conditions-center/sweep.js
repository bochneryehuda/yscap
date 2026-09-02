'use strict';
/**
 * THE CONDITION RULES RUN BY THEMSELVES (owner-directed 2026-09-02).
 *
 * The owner: *"all the conditions that we build — we need to click a rule to
 * re-run the condition rules that the condition should post. Please make sure
 * that it runs automatically on everything. You don't need to click this
 * button; that populates automatically on all the files and always re-checks
 * if stuff and rules were updated, so it needs to rerun itself."*
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
 * `engine.evaluateLoan` is the ONE thing that decides which conditions a file
 * carries, and it had three callers: the "Re-check the rules" button, the
 * flood-zone switch, and the loan sync — but only when the VESTING
 * classification moved. Nothing swept the book and nothing ran when a rule was
 * edited, so a freshly mirrored loan carried no conditions until somebody
 * opened it and pressed the button, and a rule changed on the settings screen
 * reached only the files somebody happened to re-run afterwards.
 *
 * ── WHAT THIS IS ────────────────────────────────────────────────────────────
 * ONE definition of "this loan is DUE a pass" (`STALE_SQL`), read by two doors:
 *
 *   · `sweepOnce`         — the background pass, on the sync worker's tick: a
 *                           bounded batch of due loans, oldest attempt first.
 *   · `evaluateIfStale`   — the file's own screen, before its conditions are
 *                           read, so what a person opens is already current
 *                           rather than current five minutes later.
 *
 * Both call the same engine; the engine stamps the loan (db/672) so neither
 * door has to keep its own memory of what it did. A loan is due when:
 *
 *   · it has never been evaluated (`conditions_evaluated_at IS NULL`);
 *   · the Encompass MIRROR moved since (`encompass_synced_at` — the loan read
 *     stamps it after the property, parties, residences and liabilities are
 *     written, so every rule input the mirror feeds is covered by one stamp);
 *   · the LIBRARY moved since — `max(checklist_templates.updated_at)` for the
 *     long-term scope, which every template edit (`PATCH /library/:code`) and
 *     every seed already bumps. "If stuff and rules were updated" is this line.
 *
 * The flood-zone switch and the vesting move still evaluate on the spot, as
 * they did; this is what covers everything else.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
 * It never decides a rule — the engine does. It never throws at the worker —
 * every answer is a report. It never re-runs a loan that is not due: a
 * caught-up book costs ONE SELECT that finds nothing. And it stamps nothing
 * itself: a pass the engine could not complete cleanly leaves
 * `conditions_evaluated_at` alone, so the loan stays due and is tried again
 * rather than believed — with `conditions_evaluate_tried_at` moving so it goes
 * to the back of the queue instead of blocking it.
 *
 * OFF SWITCH, the sync's own grammar: LT_CONDITION_RULES_ENABLED=0 stops the
 * background pass with no deploy. The on-open evaluation is not switched — a
 * screen that shows stale conditions is the defect this module removes.
 */

const db = require('../db');
const trash = require('../trash');
const engine = require('./engine');

/** Same OFF-value grammar as LT_SYNC_ENABLED, so one habit works everywhere. */
function enabled() {
  const raw = String(process.env.LT_CONDITION_RULES_ENABLED == null ? '' : process.env.LT_CONDITION_RULES_ENABLED).trim();
  return !['0', 'false', 'off', 'no'].includes(raw.toLowerCase());
}

/** Loans per pass. Bounded so the first pass over a 500-loan book is many
 *  small passes rather than one long one holding the worker. */
function perPass() {
  const raw = Number(process.env.LT_CONDITION_RULES_PER_PASS);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 40;
}

/**
 * THE ONE PREDICATE. `alias` is the lt_loans alias; `$edition` is the library
 * edition parameter (the newest template `updated_at` for the long-term scope,
 * 'epoch' when there is none yet). Every door that asks "is this loan due"
 * asks it in these words.
 */
function staleSql(alias, editionParam) {
  return `(${alias}.conditions_evaluated_at IS NULL
       OR ${alias}.encompass_synced_at > ${alias}.conditions_evaluated_at
       OR ${alias}.conditions_evaluated_at < ${editionParam}::timestamptz)`;
}

/** The library's edition: when any long-term template last changed. */
async function libraryEdition(client) {
  const { rows } = await client.query(
    `SELECT COALESCE(max(updated_at), 'epoch'::timestamptz) AS edition
       FROM checklist_templates WHERE scope = 'lt_loan'`);
  return rows[0] && rows[0].edition ? rows[0].edition : new Date(0);
}

/** The SQL for "which loans are due", oldest attempt first. */
function dueSql() {
  return `SELECT l.id
            FROM lt_loans l
           WHERE ${trash.notTrashSql('l')}
             AND ${staleSql('l', '$1')}
           ORDER BY l.conditions_evaluate_tried_at ASC NULLS FIRST,
                    l.encompass_synced_at DESC NULLS LAST
           LIMIT $2`;
}

/** The SQL for "is THIS loan due". Same predicate, one row. */
function oneSql() {
  return `SELECT 1
            FROM lt_loans l
           WHERE l.id = $2::uuid
             AND ${staleSql('l', '$1')}`;
}

/**
 * Is this loan due a pass? Never throws: an unreadable answer is reported as
 * `null` ("could not tell"), which the on-open door treats as "run it" — the
 * cost of a needless pass is one engine run, the cost of a missed one is a
 * screen that lies.
 */
async function isStale(loanId, client = db) {
  try {
    const edition = await libraryEdition(client);
    const { rows } = await client.query(oneSql(), [edition, String(loanId)]);
    return rows.length > 0;
  } catch (_) {
    return null;
  }
}

/**
 * THE FILE'S OWN DOOR. Evaluate this loan if it is due, before its conditions
 * are read. Returns what happened, never throws.
 *
 * @returns {Promise<{evaluated:boolean, stale:boolean|null, added:number, removed:number, degraded:string|null}>}
 */
async function evaluateIfStale(loanId, opts = {}) {
  const client = opts.db || db;
  const out = { evaluated: false, stale: null, added: 0, removed: 0, degraded: null };
  try {
    const stale = await isStale(loanId, client);
    out.stale = stale;
    if (stale === false) return out;
    const r = await engine.evaluateLoan(loanId, { db: client });
    out.evaluated = true;
    out.added = (r.added || []).length;
    out.removed = (r.removed || []).length;
    out.degraded = r.degraded || null;
    return out;
  } catch (e) {
    out.degraded = String((e && e.message) || e).slice(0, 200);
    return out;
  }
}

/**
 * THE BACKGROUND PASS. A bounded batch of due loans, each through the engine.
 *
 * @returns {Promise<{ok:boolean, reason?:string, due:number, evaluated:number, clean:number,
 *   failed:number, added:number, removed:number, more:boolean}>}
 */
async function sweepOnce(opts = {}) {
  const client = opts.db || db;
  const limit = opts.limit || perPass();
  const out = { ok: true, due: 0, evaluated: 0, clean: 0, failed: 0, added: 0, removed: 0, more: false };
  if (!enabled()) return { ...out, ok: false, reason: 'the condition-rules sweep is switched off (LT_CONDITION_RULES_ENABLED)' };

  let ids;
  try {
    const edition = await libraryEdition(client);
    ({ rows: ids } = await client.query(dueSql(), [edition, limit]));
  } catch (e) {
    return { ...out, ok: false, reason: `could not read which loans are due: ${String((e && e.message) || e).slice(0, 200)}` };
  }
  out.due = ids.length;
  out.more = ids.length >= limit;

  for (const row of ids) {
    // eslint-disable-next-line no-await-in-loop
    const r = await engine.evaluateLoan(row.id, { db: client });
    out.evaluated += 1;
    if (r.ok === false) out.failed += 1;
    else if (r.clean) out.clean += 1;
    out.added += (r.added || []).length;
    out.removed += (r.removed || []).length;
  }
  return out;
}

module.exports = {
  enabled,
  perPass,
  staleSql,
  libraryEdition,
  isStale,
  evaluateIfStale,
  sweepOnce,
  _internals: { dueSql, oneSql },
};
