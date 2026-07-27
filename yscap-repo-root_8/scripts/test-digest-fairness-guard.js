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
const stripComments = (s) => s.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');

/**
 * Split the module into candidate SQL chunks — from BACKTICK templates and from ordinary quoted
 * strings (audit 2026-07-26: splitting on backticks alone meant a single-quoted `db.query('… LIMIT
 * 200')` was invisible to every check below).
 *
 * A chunk is "analysable" when it holds a whole statement (SELECT … FROM). A chunk holding a cap
 * but NOT a statement is a fragment — the tail half of `base + ` LIMIT 200`` — which the first
 * version silently dropped, so a cap assembled by concatenation escaped entirely. Those are
 * returned separately and the guard FAILS on them: a cap it cannot analyse is reported, never
 * skipped. Silently passing what you could not read is the same class of bug as everything else
 * this file guards.
 */
function sqlChunks(text) {
  // JS `//` comments go FIRST, before anything is split out. This file's own prose quotes SQL at
  // length ("…was `ORDER BY a.id LIMIT 25`…"), and once the guard started reporting caps it could
  // not analyse rather than skipping them, that prose became three loud false failures. `(^|[^:])`
  // keeps a `https://` URL intact.
  // Block comments go first of all, and BEFORE the backtick split — a comment that quotes SQL in
  // backticks ("…was `ORDER BY a.id LIMIT 25`…") would otherwise be split into its own chunk, at
  // which point it no longer carries the comment delimiters that would have identified it as prose.
  const jsClean = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  const chunks = [];
  jsClean.split('`').forEach((c) => chunks.push(stripComments(c)));
  for (const m of jsClean.matchAll(/'((?:[^'\\\n]|\\.){20,})'|"((?:[^"\\\n]|\\.){20,})"/g)) {
    chunks.push(stripComments(m[1] || m[2] || ''));
  }
  const statements = [];
  const orphanCaps = [];
  for (const c of chunks) {
    const isStatement = /\bSELECT\b/i.test(c) && /\bFROM\b/i.test(c);
    if (isStatement) { statements.push(c); continue; }
    // A fragment carrying a real cap clause (not the word "limit" in prose) is unanalysable.
    if (/\b(?:LIMIT\s+(?:\d+|\$\d+|\$\{)|FETCH\s+FIRST\b)/i.test(c)) orphanCaps.push(c.trim().slice(0, 80));
  }
  return { statements, orphanCaps };
}

/**
 * EVERY row cap in a statement, at ANY nesting depth, each paired with the text of the scope that
 * governs it. Three audit findings collapse into this one function:
 *
 *   - a cap inside a derived table or CTE used to be STRIPPED along with its parentheses, so
 *     `SELECT * FROM (SELECT … LIMIT 200) q` with no ORDER BY anywhere passed every check;
 *   - only the FIRST cap per statement was examined, so the second arm of a UNION could be
 *     unordered and capped and never be looked at;
 *   - `LIMIT ${expr}` and `FETCH FIRST` both count as caps (kept from the previous version).
 *
 * The scope of a cap is the innermost parenthesised group containing it, or the whole statement.
 * That is the text its ORDER BY must appear in — an ORDER BY in a DIFFERENT scope does not order it.
 */
function rowCaps(sql) {
  const out = [];
  const opens = [];              // stack of indices just after each unclosed '('
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (ch === '(') { opens.push(i + 1); continue; }
    if (ch === ')') { opens.pop(); continue; }
    const rest = sql.slice(i);
    const m = /^\b(?:LIMIT\b|FETCH\s+FIRST\b)/i.exec(rest);
    if (!m) continue;
    // LIMIT 1 is a "get me the single latest row" idiom, not a work queue — it cannot starve anything.
    if (/^\bLIMIT\s+1\b(?!\d)/i.test(rest)) { i += m[0].length - 1; continue; }
    const scopeStart = opens.length ? opens[opens.length - 1] : 0;
    // Within the scope, a cap is governed only by the ORDER BY of ITS OWN arm. Without this, the
    // second half of a UNION inherits the first half's ORDER BY and an unordered capped arm reads
    // as ordered — the cap is examined but judged against somebody else's sort.
    let head = sql.slice(scopeStart, i);
    const arm = /[\s\S]*\b(?:UNION\s+ALL|UNION|EXCEPT|INTERSECT)\b/i.exec(head);
    if (arm) head = head.slice(arm[0].length);
    out.push({ index: i, head });
    i += m[0].length - 1;
  }
  return out;
}

const compact = (s) => s.replace(/\s+/g, ' ').trim().slice(0, 110);

/* ── (a) every capped statement is ORDERED, at every nesting depth ───────────────────────── */
const { statements: SQLS, orphanCaps: ORPHANS } = sqlChunks(src);
{
  // A cap the guard cannot analyse is REPORTED, never skipped. Passing what you could not read is
  // the same silent-failure class as everything else in this file.
  assert.ok(ORPHANS.length === 0,
    `a row cap was found in a string fragment this guard cannot analyse (a query assembled by concatenation?).\nMake it one SQL literal so the cap can be checked:\n  - ${ORPHANS.join('\n  - ')}`);

  const offenders = [];
  let capCount = 0;
  for (const sql of SQLS) {
    for (const cap of rowCaps(sql)) {
      capCount += 1;
      if (!/\bORDER\s+BY\b/i.test(cap.head)) offenders.push(compact(sql));
    }
  }
  assert.ok(offenders.length === 0,
    `every capped digest query must be ORDERED, so the same rows are not silently skipped forever.\nUnordered:\n  - ${offenders.join('\n  - ')}`);
  ok(`all ${capCount} row cap(s) across ${SQLS.length} digest SQL literals are ordered — including caps inside a subquery or CTE, and every cap in a multi-statement literal`);
}

/* ── (b) the order is TOTAL — it ends in a unique tie-break ──────────────────────────────── */
{
  const offenders = [];
  for (const sql of SQLS) {
    for (const cap of rowCaps(sql)) {
      const ob = /\bORDER\s+BY\b([\s\S]*)$/i.exec(cap.head);
      if (!ob) continue;   // (a) already reports this one
      // The final sort term must be UNIQUE PER ROW of the result. Every table here keys on `id` /
      // `<name>_id`, so a trailing `…, a.id` or `…, application_id` qualifies.
      //
      // `code` was ALSO allowed, on the stated grounds that the condition-code tile groups by the
      // template code so the code is unique within that result. That was simply wrong (audit
      // 2026-07-26): the query groups by a.id as WELL as t.code, so two different files sharing a
      // code and a count tie and come back in arbitrary order. The exemption is removed and the
      // query now ends in a.id like every other one.
      const terms = ob[1].split(',').map((t) => t.trim()).filter(Boolean);
      const last = (terms[terms.length - 1] || '').toLowerCase();
      if (!/(^|\.)\b(id|[a-z_]+_id)\b/.test(last)) offenders.push(`${compact(sql)}   [last sort term: ${last || '(none)'}]`);
    }
  }
  assert.ok(offenders.length === 0,
    `a capped query's ORDER BY must end in a unique column (an id), or rows that TIE are still returned in an arbitrary order.\nNot a total order:\n  - ${offenders.join('\n  - ')}`);
  ok('every capped digest query orders by a unique tie-break (a total order, not just an order)');
}

/* ── (c) a self-gated digest expresses the SAME throttle, with the SAME window, in its WHERE ── */
{
  // Each digest claims an audit_log stamp before sending. If that stamp is not ALSO a filter in the
  // query, an already-notified row keeps consuming a slot in the capped batch on every pass — which
  // is how ordering by a never-advancing key starves the tail. Pairing the two is the property that
  // makes the cap a delay rather than a wall.
  //
  // The list is derived from the CALL SITES, not from DIGEST_ACTION membership (audit 2026-07-26).
  // The previous version required the shape `_gate(DIGEST_ACTION.X` and so examined five of the
  // twenty-odd gated digests: fifteen gate on a raw string literal and were never looked at, a new
  // constant declared without a trailing comma or with double quotes fell out of the derivation,
  // and renaming the helper (this very change added `_claim`) dropped a digest out of the guard
  // silently. Matching the call sites means the guard sees a per-file gate however it is written.
  const CONSTS = new Map([...src.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*:\s*['"]([a-z][a-z0-9_]*)['"]/gm)]
    .map((m) => [m[1], m[2]]));
  // `_gate(action, entityId, window)` / `_claim(...)`. entityId NOT null ⇒ it is PER FILE, which is
  // the only kind that can starve — a global digest has one stamp for the whole pass.
  const callSites = [...src.matchAll(/\b_(?:gate|claim)\(\s*([^,]+?)\s*,\s*([^,]+?)\s*,\s*([^;]{0,120}?)\)/g)]
    .map((m) => ({ actionExpr: m[1].trim(), entity: m[2].trim(), win: m[3].trim() }))
    .filter((c) => c.entity !== 'null' && c.entity !== 'undefined');
  const perFile = callSites.map((c) => {
    const konst = /^DIGEST_ACTION\.([A-Z0-9_]+)$/.exec(c.actionExpr);
    const lit = /^['"]([a-z][a-z0-9_]*)['"]$/.exec(c.actionExpr);
    return { ...c, key: konst ? konst[1] : null, action: konst ? CONSTS.get(konst[1]) : (lit ? lit[1] : null) };
  }).filter((c) => c.action);
  assert.ok(perFile.length >= 6,
    `expected to DERIVE the per-file gated digests from their CALL SITES, found ${perFile.length}`);

  /** Normalize an interval to comparable SECONDS — `interval '3 days'`, `'3 days'`,
      `($1 || ' hours')::interval`, and a backtick `` `${waitHours} hours` `` must all be recognized,
      and `3 days` must compare EQUAL to `72 hours` (the previous version compared the literal
      strings, so rewriting a window to an identical-but-differently-spelled one failed the build). */
  const UNIT_SEC = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800, month: 2592000 };
  function windowOf(text) {
    if (!text) return null;
    const lit = /(\d+)\s*(second|minute|hour|day|week|month)s?/i.exec(text);
    if (lit) return { sec: Number(lit[1]) * UNIT_SEC[lit[2].toLowerCase()], show: `${lit[1]} ${lit[2].toLowerCase()}` };
    // A variable-driven interval: compare on the VARIABLE + unit. The quote class now includes the
    // BACKTICK — without it the one env-var-driven window in the module (the draw-findings
    // reminder) resolved to null on the gate side, which short-circuited the comparison and left
    // the single dynamic window, the one this check was written for, entirely unguarded.
    const dyn = /\$\{\s*([A-Za-z_$][\w$.]*)[^}]*\}\s*(second|minute|hour|day|week|month)s?/i.exec(text)
             || /\$\d+\s*\|\|\s*'\s*(second|minute|hour|day|week|month)s?/i.exec(text);
    if (!dyn) return null;
    return dyn.length > 2
      ? { sec: null, show: `${dyn[1]} ${dyn[2].toLowerCase()}`, dyn: true }
      : { sec: null, show: `bound ${dyn[1].toLowerCase()}`, dyn: true };
  }
  const unitOf = (w) => (w && /(\w+)$/.exec(w.show) || [])[1] || null;
  const sameWindow = (a, b) => {
    if (!a || !b) return true;                       // one side unreadable → not a provable skew
    if (a.sec != null && b.sec != null) return a.sec === b.sec;   // both literal: compare SECONDS
    // One side is a BIND PARAMETER (`($1 || ' hours')::interval`). The guard can prove the UNITS
    // agree; it cannot see what value the driver binds, so it verifies what it can and says so
    // rather than either failing a correct build or pretending to a check it did not make. This is
    // the honest edge of a source-level guard — the magnitude of a bound window is a runtime fact.
    if (/^bound /.test(a.show) || /^bound /.test(b.show)) return unitOf(a) === unitOf(b);
    return a.show === b.show;                        // dynamic: same variable AND same unit
  };

  const missing = [];
  const skewed = [];
  for (const c of perFile) {
    const A = c.key ? `DIGEST_ACTION\\.${c.key}` : `'${c.action}'`;
    // The throttle may be expressed as notThrottled(...), or as the LATERAL form that reads the
    // stamp ONCE for both the filter and the sort key. Either counts; neither present does not.
    const thr = new RegExp(`notThrottled\\([^,]*,\\s*${A}\\s*,([^;]{0,200}?)\\)`).exec(src);
    const lateralRe = c.key
      ? new RegExp(`l\\.action = '\\$\\{DIGEST_ACTION\\.${c.key}\\}'[\\s\\S]{0,400}`)
      : new RegExp(`l\\.action = '${c.action}'[\\s\\S]{0,400}`);
    const lateral = lateralRe.exec(src);
    if (!thr && !lateral) { missing.push(c.action); continue; }

    // The two windows must AGREE. A filter SHORTER than the gate re-admits rows the gate will then
    // reject — burning slots, which is the exact starvation this guard exists to prevent. A filter
    // LONGER than the gate suppresses sends that are genuinely due. Both are silent.
    const gateWin = windowOf(c.win);
    const thrWin = thr ? windowOf(thr[1])
      : windowOf(((/now\(\)\s*-\s*([^)\n]{0,60})/.exec(lateral[0]) || [])[1]));
    if (!sameWindow(gateWin, thrWin)) {
      skewed.push(`${c.action}: gate=${gateWin ? gateWin.show : '?'} filter=${thrWin ? thrWin.show : '?'}`);
    }
  }
  assert.ok(missing.length === 0,
    `a digest that self-gates per file must ALSO filter on that stamp in its query, or an already-notified file keeps consuming a slot in the capped batch forever.\nGated but not filtered:\n  - ${missing.join('\n  - ')}`);
  assert.ok(skewed.length === 0,
    `the SQL throttle window must match the window its gate claims — a shorter filter burns slots on rows the gate rejects, a longer one suppresses due sends.\nSkewed:\n  - ${skewed.join('\n  - ')}`);
  ok(`all ${perFile.length} per-file gated digests filter on their own throttle stamp in SQL, with a matching window (windows compared in SECONDS, so 3 days === 72 hours)`);
}

/* ── the guard's own parser, pinned against every shape that has slipped through ─────────── */
{
  // Each entry is a construction a previous version of this guard PASSED while the query was
  // genuinely unsafe. They are pinned here because a parser gap is invisible: the guard prints its
  // ok lines either way, so nothing tells you it stopped looking.
  const slipped = [
    ['interpolated cap',      'SELECT id FROM t WHERE x LIMIT ${Number(BATCH)}'],
    ['FETCH FIRST',           'SELECT id FROM t WHERE x FETCH FIRST 20 ROWS ONLY'],
    ['block-comment order',   'SELECT id FROM t /* ORDER BY id */ WHERE x LIMIT 50'],
    // An ORDER BY that lives in a SUBQUERY does not order the outer statement. The scope-aware
    // scanner still has to see the outer cap; whether it can tell the two ORDER BYs apart by text
    // alone is a known limit of a source-level guard, so this case pins only that the cap is SEEN.
    ['subquery-only order',   'SELECT id FROM t WHERE id IN (SELECT id FROM u ORDER BY at) LIMIT 50'],
    ['prose in a comment',    "SELECT id FROM t WHERE x -- an unordered LIMIT is a trap\n LIMIT 50"],
    // Audit 2026-07-26 — the paren-stripping parser removed a derived table WITH its cap, so this
    // reported no cap at all and was skipped entirely.
    ['cap inside a subquery', 'SELECT q.id FROM ( SELECT a.id FROM applications a WHERE a.x LIMIT 200 ) q'],
    ['cap inside a CTE',      'WITH q AS ( SELECT a.id FROM applications a WHERE a.x LIMIT 200 ) SELECT * FROM q'],
  ];
  for (const [label, sql] of slipped) {
    const { statements } = sqlChunks('`' + sql + '`');
    const caps = rowCaps(statements[0] || '');
    assert.ok(caps.length, `the guard must SEE the cap in: ${label}`);
    if (label !== 'subquery-only order') {
      assert.ok(caps.some((c) => !/\bORDER\s+BY\b/i.test(c.head)),
        `the guard must NOT count an ORDER BY from a different scope in: ${label}`);
    }
  }
  // Only the SECOND arm of this union is capped-and-unordered. The old parser stopped at the first
  // cap it found, so the offending half was never examined.
  {
    const { statements } = sqlChunks('`SELECT a.id FROM applications a ORDER BY a.updated_at, a.id LIMIT 50 UNION ALL SELECT b.id FROM borrowers b LIMIT 50`');
    const caps = rowCaps(statements[0]);
    assert.ok(caps.length === 2, 'every cap in a multi-statement literal is examined, not just the first');
    assert.ok(caps.some((c) => !/\bORDER\s+BY\b/i.test(c.head)), 'and the unordered one is caught');
  }
  // A cap in a fragment (a query built by concatenation) must be REPORTED as unanalysable, never
  // silently dropped — the guard fails loudly rather than certifying what it could not read.
  assert.ok(sqlChunks("const tail = ` LIMIT 200`;").orphanCaps.length === 1,
    'a cap in a string fragment is reported as unanalysable rather than skipped');
  // …and a plain single-quoted query is now examined like any other.
  assert.ok(rowCaps(sqlChunks("db.query('SELECT a.id FROM applications a WHERE a.x LIMIT 200')").statements[0] || '').length === 1,
    'a single-quoted SQL string is analysed, not just backtick templates');

  // …and it must still pass a genuinely correct query rather than flagging everything.
  const good = sqlChunks('`SELECT id FROM t WHERE x ORDER BY at ASC, id LIMIT 50`').statements[0];
  assert.ok(rowCaps(good).every((c) => /\bORDER\s+BY\b/i.test(c.head)), 'a correctly ordered capped query passes');
  // A `LIMIT 1` latest-row lookup is not a work queue and must not be flagged.
  assert.ok(rowCaps(sqlChunks('`SELECT id FROM audit_log WHERE action=$1 ORDER BY created_at DESC LIMIT 1`').statements[0]).length === 0,
    'a LIMIT 1 latest-row lookup is not treated as a capped work queue');
  ok(`the guard's parser catches all ${slipped.length} shapes that previously slipped past it, plus multi-cap, fragment and quoted-string caps`);
}

console.log(`\ntest-digest-fairness-guard: ${n} passed, 0 failed`);
