'use strict';
/**
 * LT test — THE PURCHASED STEP, against a REAL database.
 *
 * The pure suite proves the reading and the ladder. This proves the three things a
 * pure suite structurally cannot, and each has been a live bug somewhere in this
 * repo:
 *
 *   · **The columns these statements name exist.** A phantom column inside a
 *     swallowing catch becomes a confident, permanent silence — the class that left
 *     `lt_loans.borrower_id` unwritten for months and the whole-loan run returning
 *     null on every call.
 *   · **THE THREE ANSWERS SURVIVE THE WRITE.** The reading is three-valued and the
 *     UPDATE has to keep it that way: a sale WRITES, a "Shipped" CLEARS, and a field
 *     Encompass did not give LEAVES A RECORDED SALE ALONE. That is a `CASE WHEN` in
 *     SQL, and only Postgres can settle whether it does what its comment says.
 *   · **The step's anchor is a milestone this tenant actually has.** `insertInto`
 *     appends when it cannot find the anchor — deliberately, so nothing vanishes —
 *     which means a typo'd setting degrades SILENTLY into a step at the wrong end of
 *     the ladder. The seeded catalog is the only place that can be checked.
 *
 * The Encompass client is stubbed through `require.cache` (the pattern
 * `test-lt-loan-sync-db.js` uses) so the REAL read runs end to end; the database is
 * real, because what is being proven is what lands in it.
 *
 * DB-GATED: skips cleanly with no database.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const assert = require('assert');

async function main() {
  await require(`${__dirname}/lib/db-gate`).skipUnlessDb('lt-purchased-milestone');

  const CLIENT = require.resolve('../src/longterm/encompass/client');
  const LOANS = require.resolve('../src/longterm/sync/loans');

  const stub = { loanById: {} };
  const put = (p, exports) => { require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  put(CLIENT, {
    configured: () => true,
    getLoan: async (guid) => stub.loanById[guid] || { id: guid },
    // The two fields are read off the loan JSON on purpose (the long-term client does
    // not split a failed batch), so the fieldReader answers nothing here — which is
    // also the shape a real pass sees when the team ids are unpermitted.
    fieldReader: async () => ({}),
    apiGet: async () => ({}),
  });

  const db = require('../src/longterm/db');
  const sync = require(LOANS);
  const purchased = require('../src/longterm/milestone-purchased');
  const workspace = require('../src/longterm/workspace');
  const registry = require('../src/longterm/settings/encompass-settings');
  const { settings } = registry.resolve({});
  const cfg = purchased.configFrom(settings);

  let checks = 0;
  const ok = (c, w) => { assert.ok(c, w); checks++; };
  const eq = (a, b, w) => { assert.strictEqual(a, b, w); checks++; };

  const tag = `pmb-${Date.now().toString(36)}`;
  const guid = `${tag}-guid`;
  const row = async () => (await db.query(
    'SELECT * FROM lt_loans WHERE encompass_loan_guid = $1', [guid])).rows[0] || null;

  try {
    // ── A. THE COLUMNS ARE REAL ───────────────────────────────────────────
    const { rows: cols } = await db.query(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name = 'lt_loans' AND column_name IN ('purchased_status','purchased_at')`);
    eq(cols.length, 2, 'db/615 gave lt_loans both purchase columns');
    eq((cols.find((x) => x.column_name === 'purchased_at') || {}).data_type, 'date',
      '…and the date is a DATE, because a purchase advice is a day and not an instant');

    // ── B. THE ANCHOR IS A MILESTONE THIS TENANT HAS ──────────────────────
    const { rows: catalogRows } = await db.query(
      `SELECT milestone_name AS name, sequence AS sort_order, expected_days
         FROM lt_encompass_milestones
        WHERE COALESCE(is_archived, false) = false
        ORDER BY sequence`);
    ok(catalogRows.length >= 19, `the tenant catalog is seeded (${catalogRows.length} milestones)`);
    const ladder = purchased.insertInto(catalogRows, cfg);
    const i = ladder.findIndex((r) => r.pilot);
    ok(i > 0 && i < ladder.length - 1,
      'THE ONE THAT MATTERS HERE: the step lands INSIDE the ladder, not appended to the end — '
      + 'a settings anchor that names a milestone this tenant does not have would degrade silently');
    eq(ladder[i - 1].name, 'Purchasing Conditions', '…immediately after Purchasing Conditions');
    eq(ladder[i + 1].name, 'Final Docs', '…and before Final Docs');

    // ── C. THE FIRST READ: a sale lands ───────────────────────────────────
    await db.query(
      `INSERT INTO lt_loans (id, encompass_loan_guid, loan_number)
            VALUES (gen_random_uuid(), $1, $2)`, [guid, `${tag}-1`]);
    const loanId = String((await row()).id);

    stub.loanById[guid] = {
      id: guid,
      currentMilestone: 'Final Docs',
      rateLock: { sellSideInvestorStatus: 'Purchased', date: '2026-07-31' },
    };
    const readSold = await sync.readLoan(loanId, guid, settings);
    eq(readSold.ok, true, 'the loan reads');
    const sold = await row();
    eq(sold.purchased_status, 'Purchased', 'Encompass\'s own word is stored verbatim');
    eq(String(sold.purchased_at).slice(0, 10), '2026-07-31',
      '…with Encompass\'s own purchase advice date, not the day we looked');
    eq(purchased.describePurchase(sold, cfg).purchased, true, '…and the row reads back as sold');

    // ── D. A FIELD ENCOMPASS DID NOT GIVE CHANGES NOTHING ─────────────────
    //
    // This is the arm that a two-valued reading would get wrong, and it would get it
    // wrong in the expensive direction: every loan whose payload happens not to carry
    // the field would have its recorded sale wiped on the next tick.
    stub.loanById[guid] = { id: guid, currentMilestone: 'Final Docs', rateLock: {} };
    await sync.readLoan(loanId, guid, settings);
    const quiet = await row();
    eq(quiet.purchased_status, 'Purchased',
      'THE ONE THAT MATTERS: a read that could not see the field LEAVES the recorded sale alone');
    eq(String(quiet.purchased_at).slice(0, 10), '2026-07-31', '…date included');

    // ── E. A SALE CORRECTED AWAY IN ENCOMPASS CLEARS IT ───────────────────
    stub.loanById[guid] = {
      id: guid,
      currentMilestone: 'Final Docs',
      rateLock: { sellSideInvestorStatus: 'Shipped', date: '2026-07-31' },
    };
    await sync.readLoan(loanId, guid, settings);
    const undone = await row();
    eq(undone.purchased_status, 'Shipped',
      'a status that is no longer a sale REPLACES the old one — the step must not stand on evidence that is gone');
    eq(undone.purchased_at, null, '…and the date goes with it');
    eq(purchased.describePurchase(undone, cfg).purchased, false, '…so the row reads back as not sold');

    // ── F. THE STEPPER, ON THE REAL LADDER ────────────────────────────────
    const stepper = workspace.milestoneStepper(undone, ladder, {
      pilotReached: { [purchased.PILOT_MILESTONE_ID]: false },
    });
    const step = (n) => stepper.steps.find((s) => s.name === n);
    eq(step('Purchasing Conditions').reached, true,
      'the loan sits at Final Docs, so it HAS passed Purchasing Conditions');
    eq(step('Purchased').reached, false,
      'and has NOT been bought — on the tenant\'s own nineteen-step ladder, with our step spliced into it');
    eq(step('Final Docs').current, true, '…and Final Docs is still the current milestone');

    // A loan that never carried the field at all reads as unknown, not as unsold.
    const neverRead = workspace.milestoneStepper(
      { milestone_name: 'Funding' }, ladder,
      { pilotReached: { [purchased.PILOT_MILESTONE_ID]: undefined } });
    eq(neverRead.steps.find((s) => s.pilot).unknown, true,
      'a loan Encompass has said nothing about draws as "we have not been told", never as "no"');

    console.log(`  ok   ${checks} checks`);
  } finally {
    await db.query('DELETE FROM lt_loans WHERE encompass_loan_guid = $1', [guid]).catch(() => {});
  }
}

main().then(() => { console.log('\nall good'); process.exit(0); })
  .catch((e) => { console.error('  FAIL', (e && e.message) || e); process.exit(1); });
