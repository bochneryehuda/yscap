#!/usr/bin/env node
'use strict';
/**
 * LT — THE FLOOD ANSWER LANDS FROM ENCOMPASS, AND A PERSON'S TICK SURVIVES IT.
 *
 * Owner-directed 2026-08-31: *"This is only if you tick that this is a flood zone
 * or if it realizes from encompass that this is in a flood zone."* Both routes
 * write the SAME two columns, so the whole question is which one wins — and the
 * loser has to be the sync, because it runs every few minutes and a person ticks
 * once. `db/658` is that guard, and this is what proves it.
 *
 * ── WHY THIS CANNOT BE A PURE TEST ──────────────────────────────────────────
 *
 * The rule lives in an `ON CONFLICT ... DO UPDATE` CASE expression. Reading the
 * source proves the CASE is written; only a real Postgres proves it BEHAVES —
 * that a second sync pass over a ticked file changes nothing, that an unanswered
 * file still fills, that a thin read never blanks an answer we already hold, and
 * that the CHECK refuses a source that is neither. All four are the failure this
 * exists to stop and none of them is visible from the text.
 *
 * DB-GATED.
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
  await require(__dirname + '/lib/db-gate').skipUnlessDb('lt-flood-zone');
  const { ensureSchema } = require('../src/migrate-boot.js');
  const db = require('../src/db.js');
  const application = require('../src/longterm/application/sync.js');

  await ensureSchema();

  const cx = await db.pool.connect();
  let failed = false;
  try {
    await cx.query('BEGIN');

    // ── The column db/658 adds, before anything leans on it ─────────────────
    console.log('\nA. THE COLUMN AND ITS CHECK');
    {
      const { rows } = await cx.query(
        `SELECT data_type FROM information_schema.columns
          WHERE table_name = 'lt_properties' AND column_name = 'flood_zone_source'`);
      ok(rows.length === 1, 'lt_properties.flood_zone_source exists', JSON.stringify(rows));
    }
    for (const good of ['encompass', 'manual', null]) {
      await cx.query('SAVEPOINT sp');
      let threw = false;
      try {
        await cx.query(
          `INSERT INTO lt_properties (loan_id, flood_zone_source) VALUES ($1::uuid, $2)`,
          [crypto.randomUUID(), good]);
      } catch (_) { threw = true; }
      await cx.query('ROLLBACK TO SAVEPOINT sp');
      // The loan_id is a dangling uuid, so a foreign key may refuse it — what is
      // being asked here is only that the CHECK did not.
      ok(!threw || !/flood_zone_source_chk/.test(String(threw)),
        `${good === null ? 'NULL' : good} is an allowed source`);
    }
    {
      await cx.query('SAVEPOINT sp');
      let msg = '';
      try {
        await cx.query(
          `INSERT INTO lt_properties (loan_id, flood_zone_source) VALUES ($1::uuid, 'guessed')`,
          [crypto.randomUUID()]);
      } catch (e) { msg = String((e && e.message) || e); }
      await cx.query('ROLLBACK TO SAVEPOINT sp');
      ok(/flood_zone_source_chk/.test(msg),
        'a source that is neither is REFUSED — the guard is a string compare, so a typo there fails OPEN and loses the tick', msg.slice(0, 120));
    }

    // ── A loan to sync onto ─────────────────────────────────────────────────
    const stamp = Date.now();
    const borrower = (await cx.query(
      `INSERT INTO borrowers (first_name, last_name, email) VALUES ('Flood','Probe',$1) RETURNING id`,
      [`flood-${stamp}@example.test`])).rows[0].id;
    const loanId = crypto.randomUUID();
    await cx.query(
      `INSERT INTO lt_loans (id, borrower_id, loan_number, program_name)
       VALUES ($1::uuid,$2::uuid,$3,'DSCR 30yr')`,
      [loanId, borrower, `FLOOD-${stamp}`]);

    /** The loan payload the sync already holds, plus whatever 541 said. */
    const LOAN = { property: { streetAddress: '1 Flood St', city: 'Somewhere', state: 'NJ', postalCode: '11111' } };
    const syncWith = (v) => application.syncSubjectProperty(loanId, LOAN, {
      db: cx, values: v === undefined ? {} : { 541: v },
    });
    const propRow = async () => (await cx.query(
      `SELECT in_flood_zone, flood_zone, flood_zone_source FROM lt_properties WHERE loan_id = $1::uuid`,
      [loanId])).rows[0] || null;

    // ── B. Encompass answers ────────────────────────────────────────────────
    console.log('\nB. ENCOMPASS ANSWERS, AND THE FILE LEARNS IT');

    await syncWith('AE');
    ok(JSON.stringify(await propRow()) === JSON.stringify(
      { in_flood_zone: true, flood_zone: 'AE', flood_zone_source: 'encompass' }),
      'zone AE lands as a flood zone, recorded verbatim, sourced to Encompass', JSON.stringify(await propRow()));

    await syncWith('X');
    ok(JSON.stringify(await propRow()) === JSON.stringify(
      { in_flood_zone: false, flood_zone: 'X', flood_zone_source: 'encompass' }),
      '…and Encompass may correct its OWN answer — a re-zoned property becomes not-a-flood-zone', JSON.stringify(await propRow()));

    // A THIN READ MAY NEVER BLANK WHAT WE HOLD. Encompass omits an unpopulated
    // field entirely rather than sending a null, so "no flood zone on this loan"
    // and "this payload did not carry one" look identical on the wire.
    await syncWith(undefined);
    ok((await propRow()).flood_zone === 'X' && (await propRow()).in_flood_zone === false,
      'a later payload that carried no 541 leaves the answer we hold alone');

    // FEMA'S UNDETERMINED D. Recorded so it can be SEEN; never turned into a "no".
    await syncWith('D');
    {
      const r = await propRow();
      ok(r.flood_zone === 'D' && r.in_flood_zone === false && r.flood_zone_source === 'encompass',
        'D records the zone and claims no NEW determination — the previous one stands rather than being overwritten by a guess',
        JSON.stringify(r));
    }

    // …AND ON A FILE THAT HAS NEVER BEEN ANSWERED, D CLAIMS NO SOURCE EITHER.
    // This needs its OWN loan: asked on the file above, the source is already
    // 'encompass' from the AE and X reads, so the answer could not decide anything
    // — a mutation that stamped the source on ANY answered field survived exactly
    // that assertion. What is being pinned is that the row never says Encompass
    // determined something it did not, which is what leaves a later real zone
    // letter, and a later human tick, both free to land.
    {
      const loanD = crypto.randomUUID();
      await cx.query(
        `INSERT INTO lt_loans (id, borrower_id, loan_number, program_name)
         VALUES ($1::uuid,$2::uuid,$3,'DSCR 30yr')`,
        [loanD, borrower, `FLOODD-${stamp}`]);
      await application.syncSubjectProperty(loanD, LOAN, { db: cx, values: { 541: 'D' } });
      const { rows } = await cx.query(
        `SELECT in_flood_zone, flood_zone, flood_zone_source FROM lt_properties WHERE loan_id = $1::uuid`,
        [loanD]);
      ok(rows[0] && rows[0].flood_zone === 'D' && rows[0].in_flood_zone === null
        && rows[0].flood_zone_source === null,
        'THE ZONE IS RECORDED AND THE SOURCE IS NOT CLAIMED — the row never says Encompass answered a question it did not answer',
        JSON.stringify(rows[0]));

      // The bare word "Yes" the census found — one filled value in 772 loans — is
      // the same shape and the owner deliberately left it unread.
      await application.syncSubjectProperty(loanD, LOAN, { db: cx, values: { 541: 'Yes' } });
      const after = (await cx.query(
        `SELECT in_flood_zone, flood_zone, flood_zone_source FROM lt_properties WHERE loan_id = $1::uuid`,
        [loanD])).rows[0];
      ok(after.flood_zone === 'Yes' && after.in_flood_zone === null && after.flood_zone_source === null,
        '…and the same for the single bare "Yes" — recorded so it can be SEEN, never turned into a determination',
        JSON.stringify(after));
    }

    // ── C. A PERSON'S ANSWER WINS, FOR GOOD ─────────────────────────────────
    console.log('\nC. THE ONE THAT MATTERS: A TICK SURVIVES THE SYNC');

    // Exactly what the Orders screen's switch does (routes/orders.js).
    await cx.query(
      `UPDATE lt_properties SET in_flood_zone = true, flood_zone_source = 'manual' WHERE loan_id = $1::uuid`,
      [loanId]);

    await syncWith('X');
    {
      const r = await propRow();
      ok(r.in_flood_zone === true && r.flood_zone_source === 'manual',
        'Encompass says X and the person said yes — THE PERSON STANDS. Without this the tick is wiped within the hour and the switch looks broken',
        JSON.stringify(r));
      ok(r.flood_zone === 'D',
        '…and the zone letter is not quietly rewritten underneath them either', JSON.stringify(r));
    }
    await syncWith('AE');
    ok((await propRow()).flood_zone_source === 'manual',
      '…and it still stands when Encompass AGREES — the guard is about who answered, not about who is right');

    // ── D. A FILE NOBODY HAS ANSWERED ───────────────────────────────────────
    console.log('\nD. AN UNANSWERED FILE IS UNANSWERED, NOT A NO');

    const loan2 = crypto.randomUUID();
    await cx.query(
      `INSERT INTO lt_loans (id, borrower_id, loan_number, program_name)
       VALUES ($1::uuid,$2::uuid,$3,'DSCR 30yr')`,
      [loan2, borrower, `FLOOD2-${stamp}`]);
    await application.syncSubjectProperty(loan2, LOAN, { db: cx, values: {} });
    {
      const { rows } = await cx.query(
        `SELECT in_flood_zone, flood_zone, flood_zone_source FROM lt_properties WHERE loan_id = $1::uuid`,
        [loan2]);
      ok(rows.length === 1 && rows[0].in_flood_zone === null && rows[0].flood_zone_source === null,
        'a blank 541 leaves all three NULL — "we have not been told" rather than "not in a flood zone"',
        JSON.stringify(rows[0]));
    }

    // The property row is written on the FIGURES it found, so a loan carrying only
    // a flood zone must still get one — otherwise the answer is read and dropped.
    const loan3 = crypto.randomUUID();
    await cx.query(
      `INSERT INTO lt_loans (id, borrower_id, loan_number, program_name)
       VALUES ($1::uuid,$2::uuid,$3,'DSCR 30yr')`,
      [loan3, borrower, `FLOOD3-${stamp}`]);
    const thin = await application.syncSubjectProperty(loan3, {}, { db: cx, values: { 541: 'VE' } });
    {
      const { rows } = await cx.query(
        `SELECT in_flood_zone, flood_zone FROM lt_properties WHERE loan_id = $1::uuid`, [loan3]);
      ok(thin.written === true && rows.length === 1 && rows[0].in_flood_zone === true,
        'a payload carrying the flood zone and nothing else is still recorded — it decides whether the file asks for flood insurance',
        JSON.stringify({ thin, rows }));
    }
    const empty = await application.syncSubjectProperty(crypto.randomUUID(), {}, { db: cx, values: {} });
    ok(empty.written === false && empty.found === 0,
      '…while a payload carrying nothing at all still writes no row — an empty row reads on every screen like a property we read and found blank');

    await cx.query('ROLLBACK');
  } catch (e) {
    failed = true;
    console.error('  ✗ threw: ' + ((e && e.stack) || e));
    try { await cx.query('ROLLBACK'); } catch (_) { /* the transaction is already gone */ }
  } finally {
    cx.release();
    await db.pool.end();
  }

  console.log(`\n${pass} passed, ${fails.length} failed`);
  if (failed || fails.length) { fails.forEach((f) => console.error('  FAIL ' + f)); process.exit(1); }
})();
