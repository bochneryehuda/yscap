'use strict';
/**
 * THE GROUND-UP EXIT AMENDMENT — owner-authorized 2026-08-09.
 *
 * The owner, choosing between three options put to them in plain language: a
 * ground-up construction deal is finished when the building is done AND they
 * "Sold OR rented/refinanced". Before the amendment a ground-up that was BUILT
 * AND SOLD had no exit date at all and counted toward nothing.
 *
 * This is an authorized change to a FROZEN counting rule (the experience window
 * feeds the tier, and the tier feeds leverage), so it is held to the standard
 * this repo applies to every frozen-engine change: prove the new rule is
 * RUNTIME-EQUIVALENT to the old one everywhere it is allowed to be, and prove
 * the ONLY differences are the ones the owner authorized.
 *
 * THE CENTRAL CLAIM, asserted exhaustively below:
 *
 *     For EVERY row, either the new exit date equals the old exit date, or the
 *     OLD exit date was NULL. There is no third case.
 *
 * That is what makes it safe to ship against live files: no borrower can lose a
 * deal, no tier can fall, no registered loan can be re-sized downward, and the
 * experience condition cannot reopen on a file that was signed off.
 *
 * Section D additionally runs the SQL twin against a real database and asserts
 * it agrees with the JavaScript ROW FOR ROW — the twins governing a pricing
 * input must never drift, and a pure test cannot see a wrong column name.
 */

let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };

const E = require('../src/lib/experience');

/* The rule as it stood BEFORE the amendment, written out independently here
   rather than imported, so a mistake in the shipped code cannot quietly redefine
   the thing we are comparing against. This is the baseline. */
function oldExitDate(row) {
  const flip = String(row.deal_type || '').toLowerCase().includes('flip');
  const v = flip ? row.sale_date : (row.rent_date || row.refi_date);
  return v || null;
}

/* Every deal_type spelling that reaches this rule in practice, plus the awkward
   ones: a type carrying BOTH words, junk, blank, and null. */
const DEAL_TYPES = [
  'flip', 'fix-and-flip', 'Fix & Flip', 'FLIP',
  'hold', 'fix-and-hold', 'rental', 'brrrr',
  'ground-up', 'ground_up', 'Ground Up', 'construction', 'new-construction',
  'ground-up flip',            // carries both words — the base rule calls it a flip
  'construction flip',
  '', null, undefined, 'nonsense',
];
const D = { S: '2025-06-01', R: '2024-03-15', F: '2023-09-20' };

/** All 8 present/absent combinations of the three completion dates. */
function dateCombos() {
  const out = [];
  for (const s of [null, D.S]) for (const r of [null, D.R]) for (const f of [null, D.F]) {
    out.push({ sale_date: s, rent_date: r, refi_date: f });
  }
  return out;
}

// ───────────────────────────────────────── A. THE ADDITIVE PROPERTY, EXHAUSTIVE
console.log('\nA. The amendment can only ADD an exit date, never move or remove one');
{
  let checked = 0, added = 0, moved = 0, removed = 0;
  const examples = [];
  for (const dt of DEAL_TYPES) {
    for (const dates of dateCombos()) {
      const row = { deal_type: dt, ...dates };
      const before = oldExitDate(row);
      const after = E.exitDateOf(row);
      checked += 1;
      if (before && after !== before) { moved += 1; examples.push(`${dt} ${JSON.stringify(dates)}: ${before} -> ${after}`); }
      if (before && !after) removed += 1;
      if (!before && after) added += 1;
    }
  }
  ok(checked === DEAL_TYPES.length * 8, `checked every deal_type against all 8 date combinations (${checked} rows)`);
  ok(moved === 0, `NO counted deal's exit date moved${moved ? ` — ${examples[0]}` : ''}`);
  ok(removed === 0, 'NO deal that had an exit date lost it');
  ok(added > 0, `and ${added} row(s) that had NO exit date now have one — which is the authorized change`);
}

// ─────────────────────────────────── B. WHAT WAS ADDED IS ONLY EVER A GROUND-UP
console.log('\nB. Only a ground-up gained anything');
{
  const gained = [];
  for (const dt of DEAL_TYPES) {
    for (const dates of dateCombos()) {
      const row = { deal_type: dt, ...dates };
      if (!oldExitDate(row) && E.exitDateOf(row)) gained.push(dt);
    }
  }
  const nonGround = gained.filter((dt) => !E.isGroundUp(dt));
  ok(nonGround.length === 0,
    `every row that gained an exit is a ground-up${nonGround.length ? ` — leaked: ${[...new Set(nonGround)].join(', ')}` : ''}`);

  // A flip and a hold must be byte-identical to before, in every combination.
  let flipHoldDiffs = 0;
  for (const dt of ['flip', 'fix-and-flip', 'hold', 'fix-and-hold', 'rental', 'brrrr', '', null, 'nonsense']) {
    for (const dates of dateCombos()) {
      const row = { deal_type: dt, ...dates };
      if (E.exitDateOf(row) !== oldExitDate(row)) flipHoldDiffs += 1;
    }
  }
  ok(flipHoldDiffs === 0, 'a flip, a hold, a blank and a junk deal type are all UNCHANGED, in every combination');
}

// ────────────────────────────────────────────── C. THE OWNER'S OWN CASES
console.log("\nC. The owner's cases, stated as they stated them");
{
  const today = new Date(2026, 7, 9);              // 2026-08-09
  const counts = (r) => E.exitCounts(r, today);

  ok(E.exitDateOf({ deal_type: 'ground-up', sale_date: '2025-06-01' }) === '2025-06-01',
    'BUILT AND SOLD: a ground-up with only a sale date now exits on the sale — it used to exit on nothing');
  ok(counts({ deal_type: 'ground-up', sale_date: '2025-06-01' }) === true,
    '…and therefore counts toward experience, which is the whole point of the change');
  ok(E.exitDateOf({ deal_type: 'construction', sale_date: '2025-06-01' }) === '2025-06-01',
    "'construction' is the same deal by another name, and is read the same way");

  ok(E.exitDateOf({ deal_type: 'ground-up', rent_date: '2024-03-15' }) === '2024-03-15',
    'BUILT AND RENTED: unchanged — it already exited on the lease-up');
  ok(E.exitDateOf({ deal_type: 'ground-up', refi_date: '2023-09-20' }) === '2023-09-20',
    'BUILT AND REFINANCED: unchanged');

  /* The case that makes the COALESCE-over-the-old-rule shape necessary. A
     rewritten CASE putting sale_date first would move this deal's exit from 2024
     to 2025 — and a deal near the boundary can be pushed OUT of the window that
     way. */
  ok(E.exitDateOf({ deal_type: 'ground-up', rent_date: '2024-03-15', sale_date: '2025-06-01' }) === '2024-03-15',
    'BUILT, RENTED, LATER SOLD: still exits on the lease-up — the amendment does not re-date a deal that already counted');
  ok(E.exitDateOf({ deal_type: 'ground-up flip', sale_date: '2025-06-01', rent_date: '2024-03-15' }) === '2025-06-01',
    "a type spelled 'ground-up flip' keeps the flip answer the base rule already gave it");

  ok(E.exitDateOf({ deal_type: 'ground-up' }) === null,
    'a ground-up with NO completion date at all still has no exit — nothing is invented');
  ok(counts({ deal_type: 'ground-up', sale_date: '2027-01-01' }) === false,
    'a FUTURE sale still counts for nothing — the future-exit rule is untouched');
  ok(counts({ deal_type: 'ground-up', sale_date: '2021-06-01' }) === false,
    'and a sale outside the 36-month window still counts for nothing — the window is untouched');
}

// ───────────────────────────────────── D. THE BUCKET AND THE WINDOW DID NOT MOVE
console.log('\nD. Everything that was NOT authorized to change, did not change');
{
  ok(E.EXIT_WINDOW_MONTHS === 36, 'the window is still 36 months');
  ok(E.bucketOf('ground-up') === 'ground' && E.bucketOf('construction') === 'ground',
    'bucketOf still puts a ground-up in the ground bucket');
  ok(E.bucketOf('flip') === 'flips' && E.bucketOf('fix-and-hold') === 'holds',
    'bucketOf is otherwise unchanged');
  ok(E.bucketOf('ground-up flip') === 'ground',
    'bucketOf still prefers ground over flip — the amendment did not touch it');

  /* isGroundUp must be true exactly where GROUND_SQL is, and it must agree with
     bucketOf, or a row could be COUNTED in the ground bucket while being DATED by
     the hold rule. */
  for (const dt of DEAL_TYPES) {
    const agree = E.isGroundUp(dt) === (E.bucketOf(dt) === 'ground');
    if (!agree) { ok(false, `isGroundUp disagrees with bucketOf on ${JSON.stringify(dt)}`); break; }
  }
  ok(DEAL_TYPES.every((dt) => E.isGroundUp(dt) === (E.bucketOf(dt) === 'ground')),
    'isGroundUp and bucketOf agree on every deal type — a row can never be counted in one bucket and dated by another');

  // The exported baseline must really be the OLD rule, or section E proves nothing.
  ok(/LIKE '%flip%' THEN sale_date ELSE COALESCE\(rent_date, refi_date\)/.test(E.EXIT_DATE_BASE_SQL),
    'EXIT_DATE_BASE_SQL is the pre-amendment expression, so the DB comparison below is a real baseline');
  ok(E.EXIT_DATE_SQL.startsWith('COALESCE(' + E.EXIT_DATE_BASE_SQL),
    'and the live rule is literally COALESCE(old rule, ground fallback) — the additive property is visible in the SQL itself');
}

// ────────────────────────────────────────────────────────── DB: THE SQL TWIN
if (!process.env.DATABASE_URL) {
  console.log('\nSKIP the database section (no DATABASE_URL)');
  console.log(fail ? `\n${fail} FAILURE(S)` : '\nOK  ground-up exit amendment (pure assertions only)');
  process.exit(fail ? 1 : 0);
}

process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
const db = require('../src/db');

(async () => {
  console.log('\nE. The SQL twin agrees with the JavaScript, row for row');

  /* Build every row as a VALUES list and evaluate BOTH expressions in Postgres,
     then compare each against the JS. This is the only way to catch a twin that
     drifts: the pure sections above cannot see the SQL at all. */
  const rows = [];
  for (const dt of DEAL_TYPES) for (const d of dateCombos()) rows.push({ deal_type: dt, ...d });

  const values = rows.map((_, i) => {
    const b = i * 4;
    return `($${b + 1}::text, $${b + 2}::date, $${b + 3}::date, $${b + 4}::date)`;
  }).join(',');
  const params = [];
  for (const r of rows) params.push(r.deal_type == null ? null : String(r.deal_type), r.sale_date, r.rent_date, r.refi_date);

  const q = await db.query(
    `WITH t(deal_type, sale_date, rent_date, refi_date) AS (VALUES ${values})
     SELECT deal_type, sale_date, rent_date, refi_date,
            ${require('../src/lib/experience').EXIT_DATE_BASE_SQL} AS old_exit,
            ${require('../src/lib/experience').EXIT_DATE_SQL}      AS new_exit
       FROM t`, params);

  const day = (v) => (v == null ? null : (v instanceof Date
    ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
    : String(v).slice(0, 10)));

  let disagree = 0, sqlMoved = 0, sqlAdded = 0, first = '';
  for (const r of q.rows) {
    const js = E.exitDateOf(r);
    const sql = day(r.new_exit);
    if (js !== sql) { disagree += 1; if (!first) first = `${r.deal_type}: js=${js} sql=${sql}`; }
    const before = day(r.old_exit);
    if (before && sql !== before) sqlMoved += 1;
    if (!before && sql) sqlAdded += 1;
  }

  ok(q.rows.length === rows.length, `evaluated all ${rows.length} rows in Postgres`);
  ok(disagree === 0, `the SQL and the JS agree on every row${first ? ` — first disagreement: ${first}` : ''}`);
  ok(sqlMoved === 0, 'and in SQL too, no row that already had an exit date had it moved or removed');
  ok(sqlAdded > 0, `while ${sqlAdded} row(s) gained one — the same rows the JS gained`);

  /* Finally: the real counting query. RECENT_EXIT_SQL is what every tier count
     actually runs, so prove the amendment reaches it rather than stopping at the
     date expression. */
  const c = await db.query(
    `WITH t(deal_type, sale_date, rent_date, refi_date) AS (VALUES
        ('ground-up'::text, (CURRENT_DATE - 200)::date, NULL::date, NULL::date),
        ('ground-up',       (CURRENT_DATE - 2000)::date, NULL::date, NULL::date),
        ('flip',            (CURRENT_DATE - 200)::date, NULL::date, NULL::date))
     SELECT deal_type, (${require('../src/lib/experience').RECENT_EXIT_SQL}) AS counts FROM t`);
  ok(c.rows[0].counts === true, 'a ground-up sold 200 days ago now COUNTS through RECENT_EXIT_SQL — the query the tier is built from');
  ok(c.rows[1].counts === false, '…while one sold 2000 days ago still does not — the 36-month window still binds');
  ok(c.rows[2].counts === true, 'and a flip is unaffected');

  console.log(fail ? `\n${fail} FAILURE(S)` : '\nOK  ground-up exit amendment: additive by construction, and the twins agree');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
