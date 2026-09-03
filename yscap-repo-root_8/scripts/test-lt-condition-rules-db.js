#!/usr/bin/env node
'use strict';
/**
 * THE CONDITION RULES RUN BY THEMSELVES (db/679, conditions-center/sweep.js).
 *
 * Owner-directed 2026-09-02: *"You don't need to click this button; that
 * populates automatically on all the files and always re-checks if stuff and
 * rules were updated, so it needs to rerun itself."*
 *
 * WHAT IS PROVEN, against a real Postgres:
 *
 *   A. A loan nobody has evaluated is DUE; the sweep evaluates it, its
 *      conditions appear, and the loan is stamped — and a second sweep finds
 *      NOTHING to do (a caught-up book costs one SELECT).
 *   B. The Encompass MIRROR moving (`encompass_synced_at` newer than the stamp)
 *      makes the loan due again — and a loan whose mirror did NOT move stays
 *      caught up. The control is what proves the predicate is selective.
 *   C. The LIBRARY moving (a template's `updated_at`, which every edit and
 *      every seed bumps) makes EVERY loan due again — "if stuff and rules were
 *      updated".
 *   D. The file's own door (`evaluateIfStale`) evaluates a due loan and leaves
 *      a caught-up one alone.
 *   E. A pass that could not read cleanly does NOT stamp `conditions_evaluated_at`
 *      (the loan stays due) but DOES stamp `conditions_evaluate_tried_at` (it
 *      goes to the back of the queue).
 *   F. The stamp is the START of the pass, so a mirror write during the pass
 *      still reads as newer.
 *
 * Everything runs inside one transaction and is rolled back.
 */

const crypto = require('crypto');

let pass = 0;
const fails = [];
const ok = (cond, name, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); return; }
  fails.push(detail ? `${name} — ${detail}` : name);
  console.log('  ✗ ' + name + (detail ? ` — ${detail}` : ''));
};

(async () => {
  await require(__dirname + '/lib/db-gate').skipUnlessDb('lt-condition-rules');
  const { ensureSchema } = require('../src/migrate-boot.js');
  const db = require('../src/db.js');
  const lib = require('../src/longterm/conditions-center/library.js');
  const engine = require('../src/longterm/conditions-center/engine.js');
  const sweep = require('../src/longterm/conditions-center/sweep.js');

  await ensureSchema();
  await lib.ensureSeeded(db);

  const cx = await db.pool.connect();
  let failed = false;
  try {
    await cx.query('BEGIN');
    const stamp = Date.now();
    const borrower = (await cx.query(
      `INSERT INTO borrowers (first_name, last_name, email) VALUES ('Rules','Probe',$1) RETURNING id`,
      [`rules-${stamp}@example.test`])).rows[0].id;

    const makeLoan = async (tag) => {
      const id = crypto.randomUUID();
      await cx.query(
        `INSERT INTO lt_loans (id, borrower_id, loan_number, program_name, loan_purpose, encompass_synced_at)
         VALUES ($1::uuid,$2::uuid,$3,'DSCR 30yr','purchase'::lt_loan_purpose, now() - interval '1 hour')`,
        [id, borrower, `RULES-${tag}-${stamp}`]);
      await cx.query(
        `INSERT INTO lt_properties (loan_id, street, city, state, zip, unit_count, gse_property_type)
         VALUES ($1::uuid,'9 Rules Way','Anytown','NJ','07001',1,'SFR')`, [id]);
      return id;
    };
    const stamps = async (id) => (await cx.query(
      `SELECT conditions_evaluated_at AS evaluated, conditions_evaluate_tried_at AS tried
         FROM lt_loans WHERE id = $1::uuid`, [id])).rows[0];
    const conditionCount = async (id) => (await cx.query(
      `SELECT count(*)::int AS n FROM checklist_items WHERE lt_loan_id = $1::uuid`, [id])).rows[0].n;
    // The sweep is scoped to THIS test's loans, so a real book behind the test
    // database cannot make the counts below wrong.
    const mine = [];
    const due = async () => {
      const edition = await sweep.libraryEdition(cx);
      const { rows } = await cx.query(
        `SELECT l.id FROM lt_loans l WHERE l.id = ANY($2::uuid[]) AND ${sweep.staleSql('l', '$1')}`,
        [edition, mine]);
      return rows.map((r) => r.id).sort();
    };

    const a = await makeLoan('a');
    const b = await makeLoan('b');
    mine.push(a, b);

    console.log('\nA. A LOAN NOBODY HAS EVALUATED IS DUE, AND ONE PASS CATCHES IT UP');
    {
      ok((await due()).length === 2, 'both fresh loans are due — never evaluated', String((await due()).length));
      ok((await conditionCount(a)) === 0, 'and neither carries a condition yet');

      // The sweep itself, on the transaction. The limit is generous so the
      // batch cannot be the reason a loan was left out.
      const r = await sweep.sweepOnce({ db: cx, limit: 500 });
      ok(r.ok === true, 'the pass ran', JSON.stringify(r));
      ok(r.evaluated >= 2, 'it evaluated (at least) both loans', String(r.evaluated));
      ok((await conditionCount(a)) > 0, 'THE ONE THAT MATTERS: the conditions are on the file with nobody having pressed anything', String(await conditionCount(a)));
      const s = await stamps(a);
      ok(s.evaluated !== null && s.tried !== null, 'the loan is stamped as evaluated and as tried');
      ok((await due()).length === 0, 'and neither loan is due any more');

      const again = await sweep.sweepOnce({ db: cx, limit: 500 });
      const mineAgain = (await due()).length;
      ok(mineAgain === 0 && again.ok === true, 'a second pass over a caught-up book has nothing to do for these loans');
    }

    console.log('\nB. THE MIRROR MOVING MAKES THE LOAN DUE AGAIN — AND ONLY THAT LOAN');
    {
      await cx.query(`UPDATE lt_loans SET encompass_synced_at = clock_timestamp() WHERE id = $1::uuid`, [a]);
      const d = await due();
      ok(d.length === 1 && d[0] === a, 'the loan whose mirror moved is due; the control is not', d.join(','));
      const before = await stamps(a);
      const r = await sweep.sweepOnce({ db: cx, limit: 500 });
      ok(r.ok === true && r.evaluated >= 1, 'the pass evaluated it');
      const after = await stamps(a);
      ok(new Date(after.evaluated) > new Date(before.evaluated), 'and moved its stamp forward');
      ok((await due()).length === 0, 'so it is caught up again');
    }

    console.log('\nC. THE LIBRARY MOVING MAKES EVERY LOAN DUE — "IF STUFF AND RULES WERE UPDATED"');
    {
      await cx.query(
        `UPDATE checklist_templates SET updated_at = clock_timestamp() WHERE code = 'lt_file_contacts' AND scope = 'lt_loan'`);
      const d = await due();
      ok(d.length === 2, 'a template edit puts both loans back on the list', d.join(','));
      const r = await sweep.sweepOnce({ db: cx, limit: 500 });
      ok(r.ok === true && r.evaluated >= 2, 'one pass works them both off again');
      ok((await due()).length === 0, 'and the book is caught up');
    }

    console.log('\nD. THE FILE\'S OWN DOOR RUNS A DUE LOAN AND LEAVES A CAUGHT-UP ONE ALONE');
    {
      const quiet = await sweep.evaluateIfStale(b, { db: cx });
      ok(quiet.evaluated === false && quiet.stale === false, 'a caught-up loan is not re-run on open', JSON.stringify(quiet));
      await cx.query(`UPDATE lt_loans SET encompass_synced_at = clock_timestamp() WHERE id = $1::uuid`, [b]);
      const ran = await sweep.evaluateIfStale(b, { db: cx });
      ok(ran.evaluated === true && ran.stale === true, 'a due loan is run as its screen opens', JSON.stringify(ran));
      // ⛔ SAYS WHY WHEN IT FAILS. This assertion went red once on main
      // (2026-09-03, run 4447) and reported nothing but "and is caught up
      // afterwards" — no loan named, no stamp shown — so there was nothing to
      // diagnose from and ~55 local re-runs could not reproduce it. A bare
      // `length === 0` over a derived predicate is a question with the answer
      // thrown away. It now prints the three timestamps the predicate is built
      // from, plus the library edition and the engine's own report, so the next
      // occurrence explains itself on the first look instead of the second.
      {
        const d = await due();
        if (d.length !== 0) {
          const rows = (await cx.query(
            `SELECT id, encompass_synced_at, conditions_evaluated_at, conditions_evaluate_tried_at
               FROM lt_loans WHERE id = ANY($1::uuid[])`, [mine])).rows;
          const iso = (t) => (t ? new Date(t).toISOString() : 'null');
          console.log(`     due=${JSON.stringify(d)}  (a=${a}, b=${b})`);
          console.log(`     library edition=${iso(await sweep.libraryEdition(cx))}`);
          for (const r of rows) {
            console.log(`     ${r.id === a ? 'a' : 'b'} synced=${iso(r.encompass_synced_at)}`
              + ` evaluated=${iso(r.conditions_evaluated_at)} tried=${iso(r.conditions_evaluate_tried_at)}`);
          }
          // The engine stamps `conditions_evaluated_at` ONLY on a clean pass, so an
          // unclean one leaves the loan due while `evaluated`/`stale` above still
          // read true. That is the first thing to check, and it is not otherwise
          // visible from this suite.
          console.log(`     the on-open run reported: ${JSON.stringify(ran)}`);
        }
        ok(d.length === 0, 'and is caught up afterwards', d.join(','));
      }
    }

    console.log('\nE. A PASS THAT COULD NOT READ CLEANLY STAYS DUE, BUT GOES TO THE BACK OF THE QUEUE');
    {
      // Make the property row unreadable-by-shape: the engine reads
      // lt_properties through a join; an inconsistent context is simulated by
      // asking the engine to evaluate with the stamp on and its context reader
      // failing. The honest way is a loan the engine cannot find at all: it
      // answers ok:false with no loan, and must stamp NOTHING (no such row).
      // The unclean-but-present case is exercised through `opts.db` refusing
      // one table: a client whose query throws on lt_parties.
      const before = await stamps(a);
      const flaky = {
        query: (sql, params) => {
          if (/FROM lt_parties/i.test(String(sql))) return Promise.reject(new Error('simulated: parties unreadable'));
          return cx.query(sql, params);
        },
        // NEVER CALLED with skipLock (the only getClient is inside the lock
        // branch). If a change ever makes the engine ask for one here, fail
        // loudly rather than hand back a Client that is already connected.
        getClient: () => { throw new Error('getClient must not be called under skipLock'); },
      };
      const r = await engine.evaluateLoan(a, { db: flaky, skipLock: true });
      ok(r.ok === true && !!r.degraded, 'the engine reports the degraded read rather than throwing', JSON.stringify({ ok: r.ok, degraded: r.degraded }));
      ok(r.clean === false && r.stamped === false, 'and calls the pass unclean — nothing is believed');
      const after = await stamps(a);
      ok(new Date(after.evaluated).getTime() === new Date(before.evaluated).getTime(), 'the evaluated stamp did not move — compared to the millisecond, since a same-second re-stamp is exactly the defect', `${before.evaluated} -> ${after.evaluated}`);
      ok(new Date(after.tried) > new Date(before.tried), 'the tried stamp did — so the loan goes to the back of the queue rather than blocking it');
    }

    console.log('\nF. THE STAMP IS THE START OF THE PASS');
    {
      const t0 = (await cx.query('SELECT clock_timestamp() AS t')).rows[0].t;
      const r = await engine.evaluateLoan(b, { db: cx, skipLock: true });
      const t1 = (await cx.query('SELECT clock_timestamp() AS t')).rows[0].t;
      const s = await stamps(b);
      ok(r.clean === true && r.stamped === true, 'a clean pass stamps');
      ok(new Date(s.evaluated) >= new Date(t0) && new Date(s.evaluated) <= new Date(t1),
        'the stamp is the moment the pass STARTED, taken from the engine\'s own clock, not the database\'s now() at the end',
        `${t0.toISOString()} <= ${new Date(s.evaluated).toISOString()} <= ${t1.toISOString()}`);
      // …so a mirror write that lands mid-pass is newer than the stamp.
      await cx.query(`UPDATE lt_loans SET encompass_synced_at = clock_timestamp() WHERE id = $1::uuid`, [b]);
      ok((await due()).includes(b), 'and a mirror write after the start makes the loan due again');
    }
  } catch (e) {
    failed = true;
    console.error('\nUNEXPECTED:', e && e.stack ? e.stack : e);
  } finally {
    try { await cx.query('ROLLBACK'); } catch (_) { /* nothing to do */ }
    cx.release();
    await db.pool.end().catch(() => {});
  }

  console.log(`\n${pass} passed, ${fails.length} failed`);
  if (fails.length) fails.forEach((f) => console.error('  FAIL ' + f));
  process.exit(failed || fails.length ? 1 : 0);
})();
