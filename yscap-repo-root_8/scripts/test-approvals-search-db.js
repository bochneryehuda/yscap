'use strict';
/*
 * FINDING A FILE IN AN APPROVALS QUEUE — by its loan number, its address, or the
 * borrower, proven against a REAL Postgres through the REAL list functions.
 *
 * Owner-directed 2026-08-26, on the exception workflow: *"merge everything into
 * one place with filters for exceptions … search by loan number, by address …
 * filter by statuses."* The merge and the status/type filters shipped 2026-07-31
 * (the Approvals hub); the SEARCH did not exist in it at all, so a queue of a
 * hundred rows could only be scrolled.
 *
 * AND THE ADDRESS HALF WAS ALREADY BROKEN WHERE SEARCH DID EXIST. The global
 * omnibox matched an address against `property_address->>'oneLine'` alone —
 * MEASURED on the live table, of 319 files carrying an address only 137 hold
 * that key, because the public form and the staff new-file form both store
 * `{line1, city, state, zip}` and older rows use `street`. So more than half of
 * all files could not be found by their own address, silently: the search
 * returned nothing and read as "no such file". Section B below is that bug,
 * reproduced and fixed.
 *
 * A PURE TEST CANNOT PROVE THIS. The whole subject is a SQL predicate over a
 * jsonb column with several live shapes; a mocked query proves only that a
 * string was assembled.
 *
 * Requires DATABASE_URL with migrations applied; SKIPs cleanly otherwise. Runs in
 * a transaction and ROLLS BACK.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-approvals-search-db (no DATABASE_URL)'); process.exit(0); }
const assert = require('assert');
const { Pool } = require('pg');
const S = require('../src/lib/file-search');
const loanExceptions = require('../src/lib/loan-exceptions');
const manualProgram = require('../src/lib/manual-program');

let n = 0;
const ok = (m) => { n++; console.log('  ok  ' + m); };
const eq = (a, b, m) => { assert.strictEqual(a, b, m + ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); ok(m); };
const yes = (v, m) => { assert.ok(v, m); ok(m); };

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const tag = `q${process.pid}${Date.now() % 100000}`;

    const b1 = (await c.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Mordechai','Scharf'||$1,$2) RETURNING id`,
      [tag, `sch.${tag}@example.test`])).rows[0];
    const b2 = (await c.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Other','Person'||$1,$2) RETURNING id`,
      [tag, `oth.${tag}@example.test`])).rows[0];

    /* THE TWO ADDRESS SHAPES THAT ARE BOTH LIVE. `line1` is what the public form
       and the staff new-file form store (and it carries NO oneLine); `oneLine`
       is what the canonicalizer writes. A search that knows only one of them is
       the bug this exists to fix, so the fixture holds one of each. */
    const mkApp = async (borrowerId, loanNo, address) => (await c.query(
      `INSERT INTO applications (borrower_id, ys_loan_number, property_address, loan_amount, status)
       VALUES ($1,$2,$3::jsonb,500000,'underwriting') RETURNING id`,
      [borrowerId, loanNo, JSON.stringify(address)])).rows[0].id;

    const appLine1 = await mkApp(b1.id, `YSCAP${tag}A`,
      { line1: '598 Pawling Ave', city: 'Troy', state: 'NY', zip: '12180' });          // NO oneLine
    const appOneLine = await mkApp(b2.id, `YSCAP${tag}B`,
      { oneLine: '12 Elmwood Ter, Lakewood, NJ 08701', city: 'Lakewood', state: 'NJ' });
    const appStreet = await mkApp(b2.id, `YSCAP${tag}C`,
      { street: '77 Quaker Ridge Rd', city: 'Monsey', state: 'NY', zip: '10952' });    // the OLD key

    const mkExc = async (appId, staffId) => (await c.query(
      `INSERT INTO loan_exceptions (application_id, exception_type, status, reason_code, requested_by, requested_by_kind)
       VALUES ($1,'guaranty_waiver','requested','other',$2,'staff') RETURNING id`, [appId, staffId])).rows[0].id;
    const staff = (await c.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, password_hash, token_version)
       VALUES ($1,'Queue Tester','admin',true,'x',0) RETURNING id`, [`qt.${tag}@example.test`])).rows[0];
    await mkExc(appLine1, staff.id);
    await mkExc(appOneLine, staff.id);
    await mkExc(appStreet, staff.id);

    const keysOf = (rows) => rows.map((r) => r.ys_loan_number).sort();
    const mine = (rows) => rows.filter((r) => String(r.ys_loan_number || '').includes(tag));

    // ── A. THE LOAN NUMBER AND THE BORROWER ───────────────────────────────
    const all = mine(await loanExceptions.listExceptions({ status: 'open' }, c));
    eq(all.length, 3, 'A1 all three exceptions are in the queue with no search');
    eq(keysOf(mine(await loanExceptions.listExceptions({ status: 'open', q: `YSCAP${tag}A` }, c))).length, 1,
      'A2 searching the full loan number finds exactly that file');
    eq(keysOf(mine(await loanExceptions.listExceptions({ status: 'open', q: `${tag}B` }, c))).length, 1,
      'A3 a PART of the loan number finds it too — nobody types the whole thing');
    eq(mine(await loanExceptions.listExceptions({ status: 'open', q: `Scharf${tag}` }, c)).length, 1,
      'A4 the borrower\'s surname finds their file');
    eq(mine(await loanExceptions.listExceptions({ status: 'open', q: `Mordechai Scharf${tag}` }, c)).length, 1,
      'A5 and so does the whole name, which is how a person actually types it');

    // ── B. THE ADDRESS — THE HALF THAT WAS BROKEN ─────────────────────────
    eq(mine(await loanExceptions.listExceptions({ status: 'open', q: '598 Pawling' }, c)).length, 1,
      'B1 an address stored as line1 (no oneLine at all) is FOUND — this is the file the owner reported');
    eq(mine(await loanExceptions.listExceptions({ status: 'open', q: 'Elmwood' }, c)).length, 1,
      'B2 an address stored as oneLine is found');
    eq(mine(await loanExceptions.listExceptions({ status: 'open', q: 'Quaker Ridge' }, c)).length, 1,
      'B3 an address stored under the OLD `street` key is found');
    eq(mine(await loanExceptions.listExceptions({ status: 'open', q: 'Troy' }, c)).length, 1,
      'B4 the city works too');
    /* THE CONTROL that makes B1 mean something: the OLD rule finds nothing for
       that file, so this is a real repair and not a fixture that would have
       passed either way. */
    const oldRule = await c.query(
      `SELECT count(*)::int AS n FROM applications a
        WHERE a.id = $1 AND COALESCE(a.property_address->>'oneLine','') ILIKE $2`,
      [appLine1, '%598 Pawling%']);
    eq(oldRule.rows[0].n, 0, 'B5 CONTROL: the old oneLine-only rule finds that same file ZERO times');

    // ── C. WHAT A SEARCH MUST NOT DO ──────────────────────────────────────
    eq(mine(await loanExceptions.listExceptions({ status: 'open', q: '' }, c)).length, 3, 'C1 an empty search does not filter');
    eq(mine(await loanExceptions.listExceptions({ status: 'open', q: '   ' }, c)).length, 3, 'C2 nor does whitespace');
    eq(mine(await loanExceptions.listExceptions({ status: 'open', q: 'x' }, c)).length, 3,
      'C3 nor does a single character — on a queue of loan numbers it matches nearly everything, which reads as broken');
    eq(mine(await loanExceptions.listExceptions({ status: 'open', q: 'Zzz No Such Place' }, c)).length, 0,
      'C5 a genuine miss returns nothing rather than everything');

    /* A WILDCARD SOMEBODY TYPES IS A LITERAL. `%` and `_` are LIKE wildcards, so
       unescaped, "%%" would match every row in the queue and "YSCAP_" would match
       every file whose number merely STARTS that way — the search would silently
       become a match-all and the queue would look unfiltered.

       BOTH OF THESE ARE TWO CHARACTERS OR MORE ON PURPOSE. A bare "%" is refused
       by the minimum-length rule above and never reaches the escaping at all, so
       an assertion on it proves that rule a SECOND time and says nothing
       whatsoever about the escaping — measured: the first cut of this test did
       exactly that, and a mutation stripping the escaping sailed through it. */
    eq(mine(await loanExceptions.listExceptions({ status: 'open', q: '%%' }, c)).length, 0,
      'C6 a typed %% is a LITERAL — it matches none of these files, rather than every row in the queue');
    eq(mine(await loanExceptions.listExceptions({ status: 'open', q: 'YSCAP_' }, c)).length, 0,
      'C7 and a typed _ is a literal underscore, never "any character"');

    // The same rule at the VALUE level, including the backslash — Postgres' own
    // default LIKE escape, which unescaped would swallow the character after it.
    eq(S.likeParam('100%'), '%100\\%%', 'C8 likeParam turns a typed % into a literal one');
    eq(S.likeParam('a_b'), '%a\\_b%', 'C9 and a typed _');
    eq(S.likeParam('c:\\x'), '%c:\\\\x%', 'C10 and a typed backslash');
    const pct = await c.query(
      `SELECT count(*)::int AS n FROM applications a WHERE COALESCE(a.ys_loan_number,'') ILIKE $1`, [S.likeParam('YSCAP_')]);
    eq(pct.rows[0].n, 0,
      'C11 and bound against the REAL column, "YSCAP_" matches no row — while unescaped it would match every YSCAP number there is');

    /* THE TWO THINGS THIS MODULE INTERPOLATES INTO SQL ARE PROVEN TO BE WHAT
       THEY CLAIM. The typed VALUE is always bound, never interpolated — but the
       table ALIAS and the PARAMETER POSITION are written into the statement, and
       the module is exported. Every caller today passes a literal, which is
       exactly why this is worth pinning: the cost of a future one passing a
       request value is SQL injection rather than a wrong answer. */
    for (const bad of ['a; DROP TABLE applications --', 'a b', '', null, 1]) {
      let threw = false;
      try { S.ADDRESS_TEXT_SQL(bad); } catch (_) { threw = true; }
      eq(threw, true, `C12 a table alias of ${JSON.stringify(bad)} is refused, never written into the statement`);
    }
    for (const bad of ['1; DROP TABLE x', 0, -1, 1.5, null, '2']) {
      let threw = false;
      try { S.fileSearchSql(bad); } catch (_) { threw = true; }
      eq(threw, true, `C13 a parameter position of ${JSON.stringify(bad)} is refused`);
    }
    yes(/\$7/.test(S.fileSearchSql(7, { app: 'a', borrower: 'b' })),
      'C14 while a real position still builds the predicate it always built');

    // ── D. THE SEARCH COMPOSES WITH THE FILTERS, IT DOES NOT REPLACE THEM ─
    await c.query(`UPDATE loan_exceptions SET status='approved' WHERE application_id=$1`, [appLine1]);
    eq(mine(await loanExceptions.listExceptions({ status: 'open', q: '598 Pawling' }, c)).length, 0,
      'D1 a file whose exception is approved is not in the OPEN queue, search or no search');
    eq(mine(await loanExceptions.listExceptions({ status: 'approved', q: '598 Pawling' }, c)).length, 1,
      'D2 and the status filter plus the search together find it');
    eq(mine(await loanExceptions.listExceptions({ status: 'all', q: 'Pawling', type: 'guaranty_waiver' }, c)).length, 1,
      'D3 the TYPE filter still narrows alongside the search');
    eq(mine(await loanExceptions.listExceptions({ status: 'all', q: 'Pawling', type: 'esign_before_ctc' }, c)).length, 0,
      'D4 and a type that does not match narrows it to nothing');

    // ── E. THE OTHER QUEUE FINDS THE FILE THE SAME WAY ────────────────────
    await c.query(
      `INSERT INTO manual_program_escalations (application_id, status, requested_by)
       VALUES ($1,'pending',$2)`, [appLine1, staff.id]);
    const escAll = (await manualProgram.listEscalations({ status: 'open' }, c)).filter((r) => String(r.ys_loan_number || '').includes(tag));
    eq(escAll.length, 1, 'E1 the escalation is in its own queue');
    eq((await manualProgram.listEscalations({ status: 'open', q: '598 Pawling' }, c))
      .filter((r) => String(r.ys_loan_number || '').includes(tag)).length, 1,
      'E2 and the SAME typed address finds it there — one definition, both queues');
    eq((await manualProgram.listEscalations({ status: 'open', q: 'Zzz No Such Place' }, c))
      .filter((r) => String(r.ys_loan_number || '').includes(tag)).length, 0, 'E3 with the same honest miss');
    eq((await manualProgram.listEscalations({ status: 'open', q: '' }, c))
      .filter((r) => String(r.ys_loan_number || '').includes(tag)).length, 1, 'E4 and the same do-nothing on a blank search');

    console.log(`\ntest-approvals-search-db: all ${n} checks passed.`);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
    await pool.end();
  }
})().catch((e) => { console.error(e); process.exit(1); });
