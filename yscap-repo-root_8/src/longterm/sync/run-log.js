'use strict';
/**
 * LONG-TERM — the record of what each sync pass actually did.
 *
 * WHY THIS EXISTS, and it is worth reading before changing anything here.
 *
 * The owner asked twice why nothing was arriving on the long-term side, and nobody
 * could answer — including the person who built it. The reason is structural rather
 * than a missing log line: `GET /api/lt/sync` assembles its whole answer out of
 * `lt_loans` — how many rows, how many read, how many carry a sync error. That is a
 * fine report on the loans we HAVE, and it says nothing whatsoever about a pass that
 * never got a loan in the first place. A refused login, an Encompass outage, a
 * pipeline search that answered with an empty list, the feature switched off: every
 * one of those renders as zero loans, zero failing, and no explanation.
 *
 * So an empty book has always had two completely different meanings — "Encompass has
 * nothing for us" and "we could not reach Encompass" — drawn identically, with the
 * distinguishing fact written to a process log nobody can read. THE CLASS: a report
 * built only from the rows a job PRODUCED can never explain a job that produced
 * none. This records the RUN, not just its output.
 *
 * IT CAN NEVER BREAK A PASS. Every function here swallows its own failure and
 * returns something harmless. A sync that stopped working because its diary was
 * unwritable would be a worse bug than the one this fixes, and this module runs on
 * the same connection pool as the pass it is describing — so a database wobble hits
 * both, and only one of them matters.
 *
 * IT IS BOUNDED BY THE WRITER. Pruning happens on the way out of `finish`, keeping
 * the newest `KEEP_PER_KIND` rows of each kind, so the table cannot grow without
 * limit and no scheduled job has to exist to keep it that way.
 *
 * ENCOMPASS IS NOT TOUCHED. Nothing here reads or writes a vendor; it is one INSERT,
 * one UPDATE and one DELETE against our own table.
 */

const db = require('../db');

/**
 * How many passes of each kind to keep. Enough to answer "has this been failing all
 * week?" at a pass every twenty minutes (about three days of history), and small
 * enough that the table never becomes something anybody has to think about.
 */
const KEEP_PER_KIND = 200;

/** Trim a reason to something a screen can show without becoming a wall of text. */
function shortReason(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  return s.length > 500 ? `${s.slice(0, 497)}…` : s;
}

/** A count, or null. Never NaN, and never a silent 0 standing in for "unknown". */
function count(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * Begin a pass. Returns the row id, or null if it could not be recorded — callers
 * pass that straight back to `finish`, which does nothing with a null.
 *
 * `trigger` separates the timer from the button on purpose: "the button did
 * nothing" and "the timer has not run" send somebody to two different places.
 */
async function start(kind, trigger = 'worker', dbc = db) {
  try {
    const { rows } = await dbc.query(
      `INSERT INTO lt_sync_runs (id, kind, trigger, started_at)
            VALUES (gen_random_uuid(), $1, $2, now())
         RETURNING id`,
      [String(kind || 'unknown'), String(trigger || 'worker')],
    );
    return (rows[0] && rows[0].id) || null;
  } catch (e) {
    console.error('[lt-sync] could not record the start of a pass:', (e && e.message) || e);
    return null;
  }
}

/**
 * Close a pass out with what it found.
 *
 * `result` is the pass's OWN shape, whatever that is — the columns it recognises are
 * lifted out for the screen and the whole object is kept in `detail`, so a question
 * nobody thought to ask today is still answerable from what was captured.
 *
 * A refusal and a failure are both `ok:false` WITH a reason, and that is deliberate:
 * from the reader's side "Encompass is switched off" and "Encompass would not answer"
 * are the same question — why is nothing arriving — and both need the sentence.
 */
async function finish(id, result = {}, dbc = db) {
  if (!id) return;
  const r = result || {};
  try {
    await dbc.query(
      `UPDATE lt_sync_runs
          SET finished_at = now(),
              ok          = $2,
              reason      = $3,
              discovered  = $4,
              read_count  = $5,
              failed      = $6,
              skipped     = $7,
              remaining   = $8,
              passes      = $9,
              detail      = $10::jsonb
        WHERE id = $1::uuid`,
      [
        id,
        r.ok !== false,
        shortReason(r.reason),
        count(r.discovered),
        count(r.read),
        count(r.failed),
        count(r.skippedShortTerm != null ? r.skippedShortTerm : r.skipped),
        count(r.remaining),
        count(r.passes),
        safeJson(r),
      ],
    );
  } catch (e) {
    console.error('[lt-sync] could not record the end of a pass:', (e && e.message) || e);
  }
  await prune(String(r.kind || ''), dbc);
}

/**
 * The pass's own shape, as jsonb — or null if it cannot be one.
 *
 * A pass result can carry an Error, a circular reference or a value Postgres will
 * refuse, and none of that may cost us the ROW: the columns above are what the
 * screen reads, and `detail` is the extra. So an unserialisable detail becomes null
 * rather than an exception that loses the whole record of the pass.
 */
function safeJson(v) {
  try {
    const s = JSON.stringify(v, (k, val) => (val instanceof Error ? String(val.message || val) : val));
    if (!s || s.length > 20000) return null;
    return s;
  } catch (_) { return null; }
}

/** Keep the newest KEEP_PER_KIND rows of a kind. Never throws. */
async function prune(kind, dbc = db) {
  if (!kind) return;
  try {
    await dbc.query(
      `DELETE FROM lt_sync_runs
        WHERE kind = $1
          AND id NOT IN (
                SELECT id FROM lt_sync_runs
                 WHERE kind = $1
                 ORDER BY started_at DESC
                 LIMIT $2)`,
      [kind, KEEP_PER_KIND],
    );
  } catch (e) {
    console.error('[lt-sync] could not prune the pass log:', (e && e.message) || e);
  }
}

/**
 * Run a pass and record it, in one call — so a caller cannot record a start and
 * then forget the finish, which would leave a row that reads as "still running"
 * for ever.
 *
 * The pass's own result is returned untouched. A THROW is recorded as a failure
 * carrying its message and then RE-THROWN, because swallowing it here would change
 * how the caller behaves to suit the diary.
 */
async function record(kind, trigger, fn) {
  const id = await start(kind, trigger);
  try {
    const out = await fn();
    await finish(id, { ...(out && typeof out === 'object' ? out : {}), kind });
    return out;
  } catch (e) {
    await finish(id, { ok: false, reason: (e && e.message) || String(e), kind });
    throw e;
  }
}

/**
 * The newest pass of each kind — what the Sync screen shows.
 *
 * DISTINCT ON is the right shape here rather than a window function: it is one
 * index scan over (kind, started_at DESC), which is exactly the index db/616
 * creates. Returns [] rather than throwing, because a screen that cannot read the
 * diary should still show the figures it CAN read.
 */
async function latest(dbc = db) {
  try {
    const { rows } = await dbc.query(
      `SELECT DISTINCT ON (kind)
              kind, trigger, started_at, finished_at, ok, reason,
              discovered, read_count, failed, skipped, remaining, passes,
              -- The pass's own shape, so a screen can say something the columns do
              -- not have a place for — today, WHICH loans the database refused. A
              -- fact recorded and never selected is a fact nobody can act on.
              detail
         FROM lt_sync_runs
        ORDER BY kind, started_at DESC`,
    );
    return rows;
  } catch (e) {
    console.error('[lt-sync] could not read the pass log:', (e && e.message) || e);
    return [];
  }
}

module.exports = { start, finish, record, latest, prune, KEEP_PER_KIND, _internals: { shortReason, count, safeJson } };
