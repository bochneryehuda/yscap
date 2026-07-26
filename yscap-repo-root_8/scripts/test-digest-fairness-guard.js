'use strict';
/**
 * The CAPPED-WORK-QUEUE fairness guard — a source-level check over the scheduled digests.
 * PURE: no database, no network. It must run everywhere, including a DB-less environment.
 *
 * WHY THIS EXISTS, and why it is not the check it started as.
 *
 * A scheduled job that selects work with `LIMIT n` and no `ORDER BY` does not get "the first n
 * rows" — Postgres may return ANY n, and a different n next time. Past the cap, a file can be
 * passed over on every pass and never reached, silently: the job reports success, the work it did
 * do looks right, and nothing records what it skipped. Six such queries were found in
 * notification-digests.js.
 *
 * The first version of this guard checked only "does the statement have an ORDER BY". Two
 * independent audits showed that is NOT the invariant that makes the class safe:
 *
 *   1. An ORDER BY on a key the work does NOT ADVANCE is worse than no order at all. Sending a
 *      stale-file alert does not change `status_changed_at`; nudging a borrower does not change
 *      `delivered_at`. Sorted by those, the same rows fill the batch on every pass forever — the
 *      cap stops being a queue and becomes a permanent membership boundary. Ordering converted a
 *      RANDOM skip into a GUARANTEED one.
 *   2. An ORDER BY that does not end in a unique column is not a total order. Ties are still
 *      returned in whatever order the plan produces.
 *
 * So the guard now checks all three properties a capped work query needs:
 *   (a) it is ORDERED,
 *   (b) the order is TOTAL (ends in a unique tie-break — `id`),
 *   (c) if the job self-gates per file, the SAME throttle appears in the WHERE clause, so an
 *       already-notified row does not consume a slot. (c) is what actually delivers "the cap
 *       delays a file, it never hides one".
 *
 * It is a SOURCE check on purpose: it guards the whole class and keeps guarding when someone adds
 * the next digest — which a data-shaped test on a small CI database cannot do.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '../src/lib/notification-digests.js');
const src = fs.readFileSync(SRC, 'utf8');

let n = 0;
const ok = (m) => { console.log('  ok -', m); n += 1; };

/**
 * Split the module into candidate SQL statements.
 *
 * Comments are stripped FIRST, both kinds. Several of these queries explain this very defect in a
 * comment ("an unordered LIMIT lets Postgres return an arbitrary 300…") and that prose would
 * otherwise be matched as the statement's own LIMIT clause — reporting a correctly-ordered query
 * as an offender (`--`), or supplying a phantom ORDER BY that hides a real one (`/* *\/`).
 */
function sqlLiterals(text) {
  return text.split('`')
    .map((chunk) => chunk.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' '))
    .filter((chunk) => /\bSELECT\b/i.test(chunk) && /\bFROM\b/i.test(chunk));
}

/** Strip parenthesised groups to a FIXED POINT — one pass only removes the innermost level, so a
    nested subquery would keep its ORDER BY and be mistaken for the outer statement's. */
function withoutParens(text) {
  let out = text, prev = null;
  while (out !== prev) { prev = out; out = out.replace(/\([^()]*\)/g, ' '); }
  return out;
}

/**
 * The OUTER row cap, if any. Matches `LIMIT 100`, `LIMIT $1`, and `LIMIT ${expr}` — the last of
 * which the first version missed entirely, because the `)` in the interpolation broke its tail
 * pattern. `FETCH FIRST n ROWS ONLY` is the standard-SQL spelling of the same thing and counts too.
 */
function outerCap(sql) {
  const nudged = withoutParens(sql);
  const m = /\b(?:LIMIT\b|FETCH\s+FIRST\b)/i.exec(nudged);
  if (!m) return null;
  // LIMIT 1 is a "get me the single latest row" idiom, not a work queue — it cannot starve anything.
  const one = /\bLIMIT\s+1\b(?!\d)/i.exec(nudged);
  if (one && one.index === m.index) return null;
  return { index: m.index, head: nudged.slice(0, m.index), full: nudged };
}

const compact = (s) => s.replace(/\s+/g, ' ').trim().slice(0, 110);

/* ── (a) every capped statement is ORDERED ───────────────────────────────────────────────── */
{
  const sqls = sqlLiterals(src);
  const offenders = [];
  for (const sql of sqls) {
    const cap = outerCap(sql);
    if (!cap) continue;
    if (!/\bORDER\s+BY\b/i.test(cap.head)) offenders.push(compact(sql));
  }
  assert.ok(offenders.length === 0,
    `every capped digest query must be ORDERED, so the same rows are not silently skipped forever.\nUnordered:\n  - ${offenders.join('\n  - ')}`);
  ok(`all ${sqls.length} digest SQL literals with a row cap are ordered`);
}

/* ── (b) the order is TOTAL — it ends in a unique tie-break ──────────────────────────────── */
{
  const sqls = sqlLiterals(src);
  const offenders = [];
  for (const sql of sqls) {
    const cap = outerCap(sql);
    if (!cap) continue;
    const ob = /\bORDER\s+BY\b([\s\S]*)$/i.exec(cap.head);
    if (!ob) continue;   // (a) already reports this one
    // The final sort term must be a column that is UNIQUE PER ROW of the result. Every table here
    // keys on `id` / `<name>_id`, so a trailing `…, a.id` or `…, application_id` qualifies. `code`
    // is the one non-surrogate key allowed: the condition-code tile GROUPS BY the template code, so
    // within that result the code is unique by construction. Anything else is not a tie-break.
    const terms = ob[1].split(',').map((t) => t.trim()).filter(Boolean);
    const last = (terms[terms.length - 1] || '').toLowerCase();
    if (!/(^|\.)\b(id|[a-z_]+_id|code)\b/.test(last)) offenders.push(`${compact(sql)}   [last sort term: ${last || '(none)'}]`);
  }
  assert.ok(offenders.length === 0,
    `a capped query's ORDER BY must end in a unique column (an id), or rows that TIE are still returned in an arbitrary order.\nNot a total order:\n  - ${offenders.join('\n  - ')}`);
  ok('every capped digest query orders by a unique tie-break (a total order, not just an order)');
}

/* ── (c) a self-gated digest expresses the SAME throttle, with the SAME window, in its WHERE ── */
{
  // Each digest claims an audit_log stamp before sending (`_gate`). If that stamp is not ALSO a
  // filter in the query, an already-notified row keeps consuming a slot in the capped batch on
  // every pass — which is how ordering by a never-advancing key starves the tail. Pairing the two
  // is the property that makes the cap a delay rather than a wall.
  //
  // The list is DERIVED, not whitelisted (audit finding 2026-07-26). The first version hard-coded
  // the six names that existed when it was written, so the next digest someone added was silently
  // not examined — flatly contradicting this guard's own promise to keep guarding as digests are
  // added. Every DIGEST_ACTION constant is now checked, and adding one to the map is enough to
  // bring it under the guard.
  const actions = [...src.matchAll(/^\s*([A-Z][A-Z0-9_]*):\s*'([a-z][a-z0-9_]*)',/gm)]
    .filter((m) => new RegExp(`_gate\\(DIGEST_ACTION\\.${m[1]}\\b`).test(src)
                || new RegExp(`notThrottled\\([^)]*DIGEST_ACTION\\.${m[1]}\\b`).test(src))
    .map((m) => m[1]);
  assert.ok(actions.length >= 6,
    `expected to DERIVE the per-file DIGEST_ACTION constants from the module, found ${actions.length}: ${actions.join(', ')}`);

  /** Normalize an interval to a comparable "<n> <unit>" — `interval '3 days'`, `'3 days'`,
      `($1 || ' hours')::interval` with $1 = waitHours, and `` `${waitHours} hours` `` must all be
      recognized as the same window when they are. */
  function windowOf(text) {
    if (!text) return null;
    const lit = /(\d+)\s*(second|minute|hour|day|week|month)s?/i.exec(text);
    if (lit) return `${Number(lit[1])} ${lit[2].toLowerCase()}`;
    // A variable-driven interval: compare on the VARIABLE + unit, e.g. "waitHours hours".
    const dyn = /\$\{?\s*([A-Za-z_$][\w$]*)\s*\}?[^']*'\s*(second|minute|hour|day|week|month)s?/i.exec(text)
             || /\$\d+\s*\|\|\s*'\s*(second|minute|hour|day|week|month)s?/i.exec(text);
    if (dyn) return dyn.length > 2 ? `var ${dyn[2].toLowerCase()}` : `var ${dyn[1].toLowerCase()}`;
    return null;
  }

  const missing = [];
  const skewed = [];
  for (const key of actions) {
    const gate = new RegExp(`_gate\\(\\s*DIGEST_ACTION\\.${key}\\s*,([^;]{0,200}?)\\)`).exec(src);
    if (!gate) continue;                       // filter-only constant (no send to throttle)
    const thr = new RegExp(`notThrottled\\([^,]*,\\s*DIGEST_ACTION\\.${key}\\s*,([^;]{0,200}?)\\)\\s*\\}`).exec(src)
      || new RegExp(`notThrottled\\([^,]*,\\s*DIGEST_ACTION\\.${key}\\s*,\\s*("[^"]*"|'[^']*')`).exec(src);
    // The LATERAL form reads the stamp ONCE for both the throttle and the sort key.
    const lateral = new RegExp(`l\\.action = '\\$\\{DIGEST_ACTION\\.${key}\\}'`).test(src);
    if (!thr && !lateral) { missing.push(key); continue; }

    // The two windows must AGREE. A filter SHORTER than the gate re-admits rows the gate will then
    // reject — burning slots, which is the exact starvation this guard exists to prevent. A filter
    // LONGER than the gate suppresses sends that are genuinely due. Both are silent.
    const gateWin = windowOf(gate[1]);
    if (thr) {
      const thrWin = windowOf(thr[1]);
      if (gateWin && thrWin && gateWin !== thrWin) skewed.push(`${key}: gate=${gateWin} filter=${thrWin}`);
    } else if (gateWin) {
      // LATERAL form: the window lives in the query body next to the action name.
      const body = new RegExp(`l\\.action = '\\$\\{DIGEST_ACTION\\.${key}\\}'[\\s\\S]{0,400}`).exec(src);
      const bodyWin = body ? windowOf((/now\(\)\s*-\s*([^)\n]{0,60})/.exec(body[0]) || [])[1]) : null;
      if (bodyWin && bodyWin !== gateWin) skewed.push(`${key}: gate=${gateWin} filter=${bodyWin}`);
    }
  }
  assert.ok(missing.length === 0,
    `a digest that self-gates per file must ALSO filter on that stamp in its query, or an already-notified file keeps consuming a slot in the capped batch forever.\nGated but not filtered:\n  - ${missing.join('\n  - ')}`);
  assert.ok(skewed.length === 0,
    `the SQL throttle window must match the window its _gate claims — a shorter filter burns slots on rows the gate rejects, a longer one suppresses due sends.\nSkewed:\n  - ${skewed.join('\n  - ')}`);
  ok(`all ${actions.length} per-file digests filter on their own throttle stamp in SQL, with a matching window`);
}

/* ── the guard's own parser, pinned against the shapes that used to slip through ─────────── */
{
  const slipped = [
    ['interpolated cap',    'SELECT id FROM t WHERE x LIMIT ${Number(BATCH)}'],
    ['FETCH FIRST',         'SELECT id FROM t WHERE x FETCH FIRST 20 ROWS ONLY'],
    ['block-comment order', 'SELECT id FROM t /* ORDER BY id */ WHERE x LIMIT 50'],
    ['subquery-only order', 'SELECT id FROM t WHERE id IN (SELECT id FROM u ORDER BY at) LIMIT 50'],
    ['prose in a comment',  "SELECT id FROM t WHERE x -- an unordered LIMIT is a trap\n LIMIT 50"],
  ];
  for (const [label, sql] of slipped) {
    const cleaned = sqlLiterals('`' + sql + '`')[0];
    const cap = outerCap(cleaned);
    assert.ok(cap, `the guard must SEE the cap in: ${label}`);
    assert.ok(!/\bORDER\s+BY\b/i.test(cap.head), `the guard must NOT count a non-outer ORDER BY in: ${label}`);
  }
  // …and it must still pass a genuinely correct query rather than flagging everything.
  const good = sqlLiterals('`SELECT id FROM t WHERE x ORDER BY at ASC, id LIMIT 50`')[0];
  const goodCap = outerCap(good);
  assert.ok(goodCap && /\bORDER\s+BY\b/i.test(goodCap.head), 'a correctly ordered capped query passes');
  // A `LIMIT 1` latest-row lookup is not a work queue and must not be flagged.
  assert.ok(!outerCap(sqlLiterals('`SELECT id FROM audit_log WHERE action=$1 ORDER BY created_at DESC LIMIT 1`')[0]),
    'a LIMIT 1 latest-row lookup is not treated as a capped work queue');
  ok(`the guard's parser catches all ${slipped.length} shapes that previously slipped past it`);
}

console.log(`\ntest-digest-fairness-guard: ${n} passed, 0 failed`);
