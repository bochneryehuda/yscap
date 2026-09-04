'use strict';
/**
 * LONG-TERM — WRITING THE RULE FIRING LEDGER (db/697).
 *
 * Owner-directed 2026-09-04: *"open audit engines to make sure that every rule
 * is actually firing."*
 *
 * ── THE ONE CONTRACT ───────────────────────────────────────────────────────
 *
 * ⛔ THIS MODULE MUST NEVER COST A BOARD ITS PRICE. Not when the database is
 * down, not when the table is missing, not when a delta is malformed, not when
 * the flush is already running. `record()` does arithmetic in memory and
 * returns; it is not `async` and it cannot reject, because a caller who forgot
 * to `await` an async recorder would get an unhandled rejection on the pricing
 * path, and one who did await it would put a database round trip in front of a
 * board.
 *
 * An audit trail that can take down pricing is worse than no audit trail,
 * because it fails on the busiest day — the day the most rules are firing and
 * the most people are watching. Every failure here is counted and swallowed, and
 * `stats()` is how an operator sees that it is failing at all.
 *
 * ── WHY BUFFERED, AND WHAT THAT COSTS ──────────────────────────────────────
 *
 * Boards are priced all day and each one touches every rule in force, so writing
 * on the request path would put a write amplification of (rules × boards) on the
 * hot path to answer a question about RATES. The buffer folds a flush window
 * into one upsert per (rule, day, engine).
 *
 * The honest cost, stated rather than hidden: a process that dies with a full
 * buffer loses that window's counts. That is acceptable HERE and would not be
 * for money — these are diagnostics, the loss is bounded by the window, and the
 * questions they answer ("has this ever fired", "is it firing today") survive
 * losing a few seconds of counts. Nothing about a price, a lock or a quote is
 * kept here.
 */

const db = require('../../db');
const firing = require('./firing');

/** How often the buffer is drained, and the most it may hold before it sheds. */
const FLUSH_MS = 15000;
/*
 * ⛔ THE BUFFER IS BOUNDED, and this is a real safety limit rather than a round
 * number. If the database is unreachable the buffer cannot drain, and an
 * unbounded one turns a database outage into an out-of-memory crash of the
 * pricing process — trading a broken audit trail for a broken product. At the
 * cap the OLDEST keys are dropped and `dropped` counts them, so the loss is
 * visible in `stats()` rather than silent. One key is one rule for one day on
 * one engine, so a shop with forty rules uses eighty keys a day.
 */
const MAX_KEYS = 5000;

const buffer = new Map();
let timer = null;
let flushing = false;
const counters = { recorded: 0, flushed: 0, failures: 0, dropped: 0, lastError: null, lastFlushAt: null };

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function keyOf(d) { return `${d.ruleId} ${d.day} ${d.engine}`; }

/** Fold one delta into the buffer. Total: never throws, whatever it is handed. */
function fold(d) {
  if (!d || !d.ruleId || !d.day || !d.engine) return;
  const key = keyOf(d);
  const cur = buffer.get(key);
  if (!cur) {
    if (buffer.size >= MAX_KEYS) {
      /* SHED THE OLDEST, not the newest. A Map iterates in insertion order, so
         the first key is the one that has been waiting longest — and if it has
         been waiting longer than the flush window, the flush is not working and
         this key is the least likely to ever drain. */
      const oldest = buffer.keys().next();
      if (!oldest.done) { buffer.delete(oldest.value); counters.dropped += 1; }
    }
    buffer.set(key, { ...d });
    return;
  }
  cur.boardsSeen += num(d.boardsSeen);
  cur.boardsMatched += num(d.boardsMatched);
  cur.quotesReached += num(d.quotesReached);
  cur.quotesAdjusted += num(d.quotesAdjusted);
  cur.quotesRefused += num(d.quotesRefused);
  cur.rowsBlocked += num(d.rowsBlocked);
  cur.unreadable += num(d.unreadable);
  if (d.ruleName != null) cur.ruleName = d.ruleName;
  if (d.at && (!cur.at || d.at > cur.at)) cur.at = d.at;
}

/**
 * RECORD ONE BOARD. Synchronous, total, and never throws.
 *
 * @param {object} result what `overlay.apply` returned
 * @param {object} opts   {rules, engine, at}
 */
function record(result, opts) {
  try {
    /* THE OVERLAY DID NOT RUN — no rules in force, or a board that had already
       been overlaid. There is nothing to say about a board nobody's rules were
       asked about, and recording `boardsSeen` for it would inflate every
       denominator with boards the rule was never on. */
    if (!result || result.ran === false) return;
    const deltas = firing.deltasFrom(result, opts || {});
    for (const d of deltas) fold(d);
    counters.recorded += deltas.length;
    arm();
  } catch (e) {
    /* Swallowed on purpose — see the contract at the top. A malformed result is
       a lost count, never a lost board. */
    counters.failures += 1;
    counters.lastError = String((e && e.message) || e);
  }
}

/** Start the drain timer if it is not already running. */
function arm() {
  if (timer || !buffer.size) return;
  timer = setTimeout(() => { timer = null; flush().catch(() => {}); }, FLUSH_MS);
  /* ⛔ UNREF, so a pending flush never holds the process open. Without it a
     15-second timer keeps a CLI script or a test runner alive after its work is
     done, which reads as a hang. */
  if (timer && typeof timer.unref === 'function') timer.unref();
}

/**
 * DRAIN THE BUFFER INTO db/697.
 *
 * ⛔ THE UPSERT ADDS, IT DOES NOT REPLACE. Two processes price boards at once
 * and both flush the same (rule, day, engine) key; `SET x = table.x + excluded.x`
 * makes that a sum. `SET x = excluded.x` would make the last writer's window the
 * whole day's count, and the number would go DOWN over a busy afternoon.
 */
async function flush() {
  if (flushing || !buffer.size) return { written: 0 };
  flushing = true;
  /* TAKE THE BUFFER FIRST. Anything recorded during the await lands in the fresh
     Map and drains next time, rather than being wiped by a `clear()` after the
     write. */
  const rows = [...buffer.values()];
  buffer.clear();
  let client = null;
  try {
    client = await db.getClient();
    for (const r of rows) {
      await client.query(
        `INSERT INTO lt_pricing_rule_firing
           (rule_id, rule_name, day, engine, boards_seen, boards_matched,
            quotes_reached, quotes_adjusted, quotes_refused, rows_blocked,
            unreadable, first_at, last_at)
         VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
         ON CONFLICT (rule_id, day, engine) DO UPDATE SET
           rule_name       = COALESCE(EXCLUDED.rule_name, lt_pricing_rule_firing.rule_name),
           boards_seen     = lt_pricing_rule_firing.boards_seen     + EXCLUDED.boards_seen,
           boards_matched  = lt_pricing_rule_firing.boards_matched  + EXCLUDED.boards_matched,
           quotes_reached  = lt_pricing_rule_firing.quotes_reached  + EXCLUDED.quotes_reached,
           quotes_adjusted = lt_pricing_rule_firing.quotes_adjusted + EXCLUDED.quotes_adjusted,
           quotes_refused  = lt_pricing_rule_firing.quotes_refused  + EXCLUDED.quotes_refused,
           rows_blocked    = lt_pricing_rule_firing.rows_blocked    + EXCLUDED.rows_blocked,
           unreadable      = lt_pricing_rule_firing.unreadable      + EXCLUDED.unreadable,
           first_at        = LEAST(COALESCE(lt_pricing_rule_firing.first_at, EXCLUDED.first_at), COALESCE(EXCLUDED.first_at, lt_pricing_rule_firing.first_at)),
           last_at         = GREATEST(COALESCE(lt_pricing_rule_firing.last_at, EXCLUDED.last_at), COALESCE(EXCLUDED.last_at, lt_pricing_rule_firing.last_at))`,
        [r.ruleId, r.ruleName == null ? null : String(r.ruleName), r.day, r.engine,
          num(r.boardsSeen), num(r.boardsMatched), num(r.quotesReached), num(r.quotesAdjusted),
          num(r.quotesRefused), num(r.rowsBlocked), num(r.unreadable), r.at || null],
      );
    }
    counters.flushed += rows.length;
    counters.lastFlushAt = new Date();
    return { written: rows.length };
  } catch (e) {
    counters.failures += 1;
    counters.lastError = String((e && e.message) || e);
    /* ⛔ THE COUNTS ARE NOT PUT BACK. A failed flush is a lost window, and that
       is the deliberate choice: re-buffering a batch that failed because the
       table is missing or a column is wrong means retrying it forever, growing
       the buffer until it sheds, and turning one broken deploy into a permanent
       memory leak. Diagnostics may be lost; the process may not be harmed. */
    return { written: 0, error: counters.lastError };
  } finally {
    flushing = false;
    if (client) { try { client.release(); } catch (_) { /* releasing twice is not worth a throw */ } }
    arm();
  }
}

/** What the ledger itself has been doing — so a failing audit trail is visible. */
function stats() {
  return { ...counters, buffered: buffer.size, flushMs: FLUSH_MS, maxKeys: MAX_KEYS };
}

/** Tests and shutdown: drop everything held without writing it. */
function reset() {
  buffer.clear();
  if (timer) { clearTimeout(timer); timer = null; }
  counters.recorded = 0; counters.flushed = 0; counters.failures = 0; counters.dropped = 0;
  counters.lastError = null; counters.lastFlushAt = null;
}

module.exports = { record, flush, stats, reset, _internals: { buffer, fold, FLUSH_MS, MAX_KEYS } };
