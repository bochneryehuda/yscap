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

/* ── (c) a self-gated digest expresses the SAME throttle in its WHERE ────────────────────── */
{
  // Each digest claims an audit_log stamp before sending (`_gate`). If that stamp is not ALSO a
  // filter in the query, an already-notified row keeps consuming a slot in the capped batch on
  // every pass — which is how ordering by a never-advancing key starves the tail. Pairing the two
  // is the property that makes the cap a delay rather than a wall.
  const actions = [...src.matchAll(/^\s*([A-Z_]+):\s*'([a-z_]+)',/gm)]
    .filter((m) => /^(BORROWER_OUTSTANDING|STALE_FILE|DRAW_FINDINGS_REMINDER|TRUSTPOINT_UNRELEASED|DRAW_RELEASE_OVERDUE|DIRECT_SOURCE_FILE)$/.test(m[1]))
    .map((m) => m[1]);
  assert.ok(actions.length === 6, `expected the 6 per-file DIGEST_ACTION constants, found ${actions.length}: ${actions.join(', ')}`);
  const missing = [];
  for (const key of actions) {
    const gated = new RegExp(`_gate\\(DIGEST_ACTION\\.${key}\\b`).test(src);
    // The filter is either the shared helper or, where the stamp is ALSO the sort key, the LATERAL
    // that reads it once for both purposes — both express the same "not inside its window" test.
    const filtered = new RegExp(`notThrottled\\([^)]*DIGEST_ACTION\\.${key}\\b`).test(src)
      || new RegExp(`l\\.action = '\\$\\{DIGEST_ACTION\\.${key}\\}'`).test(src);
    if (gated && !filtered) missing.push(key);
  }
  assert.ok(missing.length === 0,
    `a digest that self-gates per file must ALSO filter on that stamp in its query, or an already-notified file keeps consuming a slot in the capped batch forever.\nGated but not filtered:\n  - ${missing.join('\n  - ')}`);
  ok(`all ${actions.length} per-file digests filter on their own throttle stamp in SQL (the cap delays, it cannot hide)`);
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
