'use strict';
/**
 * LONG-TERM — A FILE HANDED TO THE PROCESSOR ALWAYS HAS A CLICKUP CARD.
 *
 * Owner-directed 2026-08-27, reporting file YSCAP258134841 / 300 Apple St,
 * Syracuse: *"Any file that finishes the LO_PREP status, if it's not linked
 * already to a ClickUp task, then it should create a new task ... If it's
 * linked already to a task in ClickUp, then you're good without opening a new
 * task."*
 *
 * THE DEFECT THIS PINS. `createPass` selected only loans with
 * `lt_loans.created_at >= LT_CLICKUP_CREATE_SINCE` (default 2026-08-24). That
 * column is when PILOT FIRST DISCOVERED the loan — the discovery INSERT takes
 * the column default — not any Encompass date. It was a go-live guard so the
 * historical book would not get cards at once, and its flaw is that it also
 * excluded every loan ALREADY IN FLIGHT on go-live day. 300 Apple St started
 * 8/13, was discovered before the cutoff, finished LO Prep on the 24th, and was
 * therefore never once considered for a card — silently, because the query
 * simply never selected it. A person opened it by hand three days later.
 *
 * These assertions run the REAL selection SQL from push.js against a REAL
 * Postgres. A pure test cannot see this: the bug IS the query.
 */
const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');
const push = require('../src/longterm/clickup/push');
const statusEngine = require('../src/longterm/clickup/status-engine');

let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };

const CUTOFF = '2026-08-24';
const PRE = '2026-08-13';   // discovered before go-live, like the reported file
const POST = '2026-08-25';

(async () => {
    /* NO DATABASE, NO FAILURE. `npm test` is ONE chain and BOTH CI jobs run it —
       `test` has no Postgres at all — so a *-db suite must SKIP rather than hang.
       It must come before ensureSchema(), which does not throw when the database
       is unreachable: it retries for ~75s and then RESOLVES, so the suite sails
       past it and dies on its first query with the wrong cause named. */
    await require(__dirname + '/lib/db-gate').skipUnlessDb('lt-clickup-handoff-create');
  const tag = `hoff${Math.random().toString(36).slice(2, 8)}`;
  try {
    await ensureSchema();

    const mk = async (suffix, createdAt, linked) => {
      const id = (await db.query(
        `INSERT INTO lt_loans (id, encompass_loan_guid, loan_number, borrower_name,
                               encompass_synced_at, created_at, clickup_task_id)
         VALUES (gen_random_uuid(), $1, $2, 'Hand Off', now(), $3, $4) RETURNING id`,
        [`${tag}-${suffix}`, `${tag}-${suffix}`, createdAt, linked || null])).rows[0].id;
      return id;
    };
    const milestone = (id, name, done) => db.query(
      `INSERT INTO lt_loan_milestones (loan_id, milestone_name, done) VALUES ($1,$2,$3)`, [id, name, done]);

    /* THE REAL QUERY — push.createCandidates, not a copy of it. The first cut of
       this suite re-declared the SQL here and reported all-passed with the whole
       hand-off clause reverted: it was grading itself. Calling the production
       function is what makes a mutation of the rule show up as a red test. */
    const selected = async () => (await push.createCandidates({ scan: 500, since: CUTOFF }))
      .rows.map((r) => r.loan_number).filter((n) => String(n || '').startsWith(`${tag}-`));

    console.log('\nA. the reported file — discovered before go-live, LO Prep finished');
    const a = await mk('A', PRE); await milestone(a, 'LO Prep', true);
    ok((await selected()).includes(`${tag}-A`),
      'A1 THE REPORTED DEFECT: a pre-cutoff loan whose LO Prep is done is now considered for a card');

    console.log('\nB. the rule is the HAND-OFF, not merely being old');
    const b = await mk('B', PRE); await milestone(b, 'LO Prep', false);
    ok(!(await selected()).includes(`${tag}-B`),
      'B1 a pre-cutoff loan still STARTING (LO Prep not finished) is not given a card');

    console.log('\nC. a file further along has finished LO Prep too');
    const c = await mk('C', PRE); await milestone(c, 'LO Prep', true); await milestone(c, 'Cond Approval', true);
    ok((await selected()).includes(`${tag}-C`), 'C1 a loan past the hand-off is covered — the ladder keeps LO Prep done');

    console.log('\nD. the existing go-live rule is untouched');
    const d = await mk('D', POST);
    ok((await selected()).includes(`${tag}-D`),
      'D1 a post-cutoff loan with no ladder at all is selected exactly as before (the clause only ADDS)');

    console.log('\nE. never a second card');
    const e = await mk('E', PRE, 'already-linked-123'); await milestone(e, 'LO Prep', true);
    ok(!(await selected()).includes(`${tag}-E`),
      "E1 a loan already linked to a card is left alone — the owner's \"then you're good\"");

    console.log('\nF. the milestone is matched by MEANING, not by spelling');
    const f = await mk('F', PRE); await milestone(f, 'LO_PREP', true);
    ok((await selected()).includes(`${tag}-F`), "F1 the owner's own spelling LO_PREP matches");
    const g = await mk('G', PRE); await milestone(g, '  lo   prep!  ', true);
    ok((await selected()).includes(`${tag}-G`), 'F2 punctuation and repeated spaces match');

    console.log('\nG. the SQL normalizer is the JS one — a drift here silences the hand-off');
    let drift = 0;
    for (const v of ['LO Prep', 'LO_PREP', 'lo prep', '  LO   Prep  ', 'LO-Prep', 'Submittal', 'Cond Approval', 'LOPrep']) {
      const sql = (await db.query(`SELECT ${push.MILESTONE_NORM_SQL('$1')} AS v`, [v])).rows[0].v;
      if (sql !== statusEngine._internals.norm(v)) { drift++; console.error(`    drift on ${JSON.stringify(v)}: sql=${sql}`); }
    }
    ok(drift === 0, 'G1 the SQL twin agrees with statusEngine.norm on every spelling');

    console.log('\nH. the milestone list is DERIVED from the status engine, never retyped');
    const derived = push.HANDOFF_MILESTONES();
    const expected = [...statusEngine._internals.MILESTONE_STATUS.entries()]
      .filter(([, v]) => v === 'assigned to processor').map(([k]) => k);
    ok(derived.length > 0 && JSON.stringify(derived) === JSON.stringify(expected),
      'H1 the hand-off milestones come from MILESTONE_STATUS, so they cannot disagree with the ladder');
  } catch (e) {
    fail++; console.error('  FAIL threw:', e.message);
  } finally {
    try { await db.query(`DELETE FROM lt_loans WHERE loan_number LIKE $1`, [`${tag}-%`]); } catch (_) { /* best-effort */ }
  }
  console.log(fail ? `\n${fail} failing` : '\nall passed');
  process.exit(fail ? 1 : 0);
})();
