'use strict';
/**
 * PROOF that the borrower's long-term switch is BUILT AND SWITCHED OFF — and that
 * when it is switched on it shows a client only what a human confirmed is theirs,
 * only the long-term files, and never an investor's name.
 *
 * The owner asked for the switch and then, asked whether to turn it on, said
 * *"build it ready"*. So "off" is not an incidental default here, it is the
 * requirement — and a requirement nothing tests is a requirement one careless
 * `default: true` away from putting an unfinished product in front of every
 * client. Section A is that test.
 *
 * The other three things only a database can settle:
 *   · a loan attached to NOBODY reaches nobody — the whole reason the mapping is
 *     confirm-and-not-guess;
 *   · another borrower's loan is not visible, ever;
 *   · the SHORT-term loans the long-term pipeline also mirrors (it discovers the
 *     whole Encompass book) do not appear on a screen headed "long-term".
 *
 * DB-GATED: skips cleanly with no database, like every other suite in the chain.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const assert = require('assert');

async function main() {
  // Both CI jobs run the one chain and `test` has no database, so this must skip
  // rather than dial one. BEFORE anything that opens a connection.
  await require(__dirname + '/lib/db-gate').skipUnlessDb('lt-borrower-switch');

  const db = require('../src/longterm/db');
  const decls = require('../src/longterm/settings/encompass-settings');

  let checks = 0;
  const ok = (c, w) => { assert.ok(c, w); checks++; };
  const eq = (a, b, w) => { assert.strictEqual(a, b, w); checks++; };

  // ---------------------------------------------------------------------------
  // A. THE SWITCH IS ON. This is the owner's decision, asserted.
  //
  // It shipped OFF on 2026-08-16 ("build it ready") and the owner said GO on
  // 2026-08-17 ("turn switch on"). What this assertion is really protecting is that
  // the state of the switch is always somebody's DECISION and never a drift — the
  // suite fails whichever way it moves without the owner having said so.
  // ---------------------------------------------------------------------------
  const list = Array.isArray(decls.SETTINGS) ? decls.SETTINGS : Object.values(decls.SETTINGS || {});
  const decl = list.find((d) => d && d.key === 'borrower.longTermVisible');
  ok(decl, 'the borrower-facing long-term switch is a declared setting');
  eq(decl.type, 'boolean', '…a plain on/off');
  eq(decl.default, true,
    'THE BORROWER-FACING LONG-TERM SIDE IS ON — owner-directed 2026-08-17 "turn switch on"');

  // The route module is required directly and its handler driven with a fake
  // request/response, so the whole thing runs without standing up an HTTP server
  // or minting a borrower session.
  const routeMod = require('../src/longterm/routes/my-loans');
  const layer = routeMod.stack.find((l) => l.route && l.route.path === '/loans');
  ok(layer, 'the borrower route exposes GET /loans');
  const handler = layer.route.stack[0].handle;

  const call = async (actorId) => {
    let body = null; let status = 200;
    const res = {
      json: (b) => { body = b; return res; },
      status: (s) => { status = s; return res; },
    };
    await handler({ actor: actorId ? { id: actorId, kind: 'borrower' } : null }, res);
    return { body, status };
  };

  const settingsStore = require('../src/longterm/settings/store');
  const tag = `bsw-${Date.now().toString(36)}`;
  const loanIds = [];
  const borrowerIds = [];
  let switchedOn = false;

  const seedBorrower = async (first, last) => {
    const { rows } = await db.query(
      `INSERT INTO borrowers (id, first_name, last_name, email)
       VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id`,
      [first, last, `${tag}-${first}@example.com`.toLowerCase()],
    );
    borrowerIds.push(rows[0].id);
    return rows[0].id;
  };
  const seedLoan = async (n, borrowerId, term, program) => {
    const { rows } = await db.query(
      `INSERT INTO lt_loans (id, encompass_loan_guid, loan_number, borrower_id,
                             term_months, program_name, stage_key, milestone_name, loan_amount)
       VALUES (gen_random_uuid(), $1, $1, $2::uuid, $3, $4, 'submittal', 'Submittal', 250000)
       RETURNING id`,
      [`${tag}-${n}`, borrowerId, term, program],
    );
    loanIds.push(rows[0].id);
    return rows[0].id;
  };

  try {
    const me = await seedBorrower('Sam', 'Fried');
    const someoneElse = await seedBorrower('Rivka', 'Stern');

    await seedLoan('mine-long', me, 360, 'Investor DSCR 30 YEAR FRM');
    await seedLoan('mine-short', me, 12, 'Fix & Flip Purchase + reno');
    await seedLoan('theirs', someoneElse, 360, 'Investor DSCR 30 YEAR FRM');
    // Attached to NOBODY — mirrored, but never confirmed as anyone's.
    await seedLoan('unlinked', null, 360, 'Investor DSCR 30 YEAR FRM');

    // -------------------------------------------------------------------------
    // B. THE OFF STATE IS STILL A REAL KILL SWITCH. It is no longer the default,
    //    which makes it MORE important to pin, not less: turning the product back
    //    off has to be one setting, without a deploy, and it has to reach a client
    //    who genuinely has long-term files. The answer is a plain "off", not an
    //    error, so the portal hides the switch rather than showing a failure.
    // -------------------------------------------------------------------------
    await settingsStore.save({ 'borrower.longTermVisible': false }, { actorId: null });
    switchedOn = true; // the setting has been touched; the finally restores it

    const off = await call(me);
    eq(off.status, 200, 'switched off the borrower door still answers cleanly');
    eq(off.body.enabled, false, '…and says the long-term side is off');
    eq(off.body.loans.length, 0, '…and returns no files at all, even though this borrower has one');

    // -------------------------------------------------------------------------
    // C. TURN IT BACK ON — the one setting that is the whole of what stands
    //    between this and a client's screen.
    // -------------------------------------------------------------------------
    await settingsStore.save({ 'borrower.longTermVisible': true }, { actorId: null });

    const on = await call(me);
    eq(on.body.enabled, true, 'switched on, the borrower door says so');
    eq(on.body.loans.length, 1, 'the borrower sees exactly their own LONG-TERM file');
    eq(on.body.loans[0].file, `${tag}-mine-long`, '…the right one');
    eq(on.body.loans[0].termMonths, 360, '…with the term it was judged on');
    ok(on.body.loans[0].status, '…and where it is up to');

    // Their SHORT-term file is not shown on the long-term side, even though the
    // long-term pipeline mirrors it — it discovers the whole Encompass book.
    ok(!on.body.loans.some((l) => l.file.endsWith('mine-short')),
      'a short-term file is NOT shown under the long-term switch');
    eq(on.body.counts.total, 2, '…though both of this borrower\'s loans were read');

    // -------------------------------------------------------------------------
    // D. THE TWO THINGS THAT MUST NEVER HAPPEN.
    // -------------------------------------------------------------------------
    ok(!on.body.loans.some((l) => l.file.endsWith('theirs')),
      'another borrower\'s file is NEVER visible');
    ok(!on.body.loans.some((l) => l.file.endsWith('unlinked')),
      'a loan nobody has confirmed reaches NOBODY — an unmatched file is not everyone\'s');

    const other = await call(someoneElse);
    eq(other.body.loans.length, 1, 'the other borrower sees their own file');
    eq(other.body.loans[0].file, `${tag}-theirs`, '…and only theirs');

    // -------------------------------------------------------------------------
    // E. THE INVESTOR NAME NEVER REACHES A CLIENT (charter §10). A program name is
    //    free text a human typed, so it is scrubbed on the way out — proven with a
    //    real recorded spelling rather than an invented one.
    // -------------------------------------------------------------------------
    const investorLoan = await seedLoan('investor', me, 360, 'Deephaven DSCR 30 YEAR FRM');
    const scrubbed = await call(me);
    const row = scrubbed.body.loans.find((l) => l.file.endsWith('investor'));
    ok(row, 'the file with an investor name in its program is returned');
    ok(!/deephaven/i.test(JSON.stringify(row)),
      'the investor name is scrubbed out of everything the client is sent');
    ok(/capital partner/i.test(String(row.programName)),
      '…and replaced with the neutral wording, not blanked into a mystery');
    loanIds.push(investorLoan);

    // -------------------------------------------------------------------------
    // G. THE STATUS A CLIENT READS IS THE ONE WRITTEN FOR A CLIENT.
    //
    // There are three layers of wording on this side — Encompass's 19 milestones,
    // our 9 stages, and the tenant's own consumer wording per milestone
    // (`lt_encompass_milestones.consumer_status`, db/547). Only the third was
    // written to be read by a borrower, and the door used to send `stage_key`
    // verbatim: a client checking their loan was shown a database value.
    //
    // The two halves are asserted separately because they fail differently: the
    // consumer wording WINNING, and the fallback never being the raw key.
    // -------------------------------------------------------------------------
    const consumer = await call(me);
    const mine = consumer.body.loans.find((l) => l.file.endsWith('mine-long'));
    ok(mine, 'the borrower\'s long-term file is returned');
    eq(mine.status, 'Submitted for Approval',
      'the status is the tenant\'s own CONSUMER wording for that milestone (db/547)');
    ok(mine.status !== 'submittal',
      '…never the stored stage key — a client must not be shown a database value');
    eq(mine.milestone, 'Submittal', 'the milestone itself is still reported as Encompass names it');

    // A milestone with no consumer wording — one added since we last read the
    // list, or one the tenant never published — must still return the loan (the
    // LEFT JOIN) and must fall back to our stage's LABEL, never its key.
    const oddId = await seedLoan('odd', me, 360, 'Investor DSCR 30 YEAR FRM');
    await db.query(
      `UPDATE lt_loans SET milestone_name = $2, stage_key = 'clear_to_close' WHERE id = $1::uuid`,
      [oddId, `${tag} milestone nobody has published`],
    );
    const odd = await call(me);
    const oddRow = odd.body.loans.find((l) => l.file.endsWith('odd'));
    ok(oddRow, 'a loan whose milestone has no consumer wording is STILL returned — the join is a LEFT one');
    eq(oddRow.status, 'Clear to Close', '…and falls back to our stage\'s LABEL');
    ok(oddRow.status !== 'clear_to_close', '…never the raw key');

    // With neither, it says NOTHING. A status invented for a client is worse than
    // a blank one, and the screen prints its own neutral wording instead.
    await db.query(`UPDATE lt_loans SET stage_key = NULL WHERE id = $1::uuid`, [oddId]);
    const bare = await call(me);
    const bareRow = bare.body.loans.find((l) => l.file.endsWith('odd'));
    eq(bareRow.status, null, 'with no wording anywhere the door invents nothing');

    // -------------------------------------------------------------------------
    // F. THE SETTINGS READ FAILS CLOSED. An unreadable setting is not permission to
    //    show a client an unfinished product.
    // -------------------------------------------------------------------------
    const realLoad = settingsStore.load;
    settingsStore.load = async () => { throw new Error('settings unavailable'); };
    try {
      const broken = await call(me);
      eq(broken.body.enabled, false, 'an unreadable setting reads as OFF, never as on');
      eq(broken.body.loans.length, 0, '…and shows the client nothing');
    } finally {
      settingsStore.load = realLoad;
    }
  } finally {
    if (switchedOn) {
      // Restore the DECLARED default (on), not a hard-coded false — leaving the
      // tenant switched off would be this suite quietly turning the product off.
      await settingsStore.save({ 'borrower.longTermVisible': true }, { actorId: null }).catch(() => {});
    }
    if (loanIds.length) {
      await db.query('DELETE FROM lt_loans WHERE id = ANY($1::uuid[])', [loanIds]).catch(() => {});
    }
    if (borrowerIds.length) {
      await db.query('DELETE FROM borrowers WHERE id = ANY($1::uuid[])', [borrowerIds]).catch(() => {});
    }
    await db.pool.end().catch(() => {});
    // AND THE RTL POOL. These suites require the app, which opens `src/db`'s pool
    // transitively; `db` here is the LONG-TERM one. Leaving the other open kept a
    // Postgres socket alive until its 30-second idle timeout, so the suite printed
    // its result and then sat there doing nothing. Across nine suites that was 270
    // of the 286 seconds the long-term database suites took.
    await require('../src/db').pool.end().catch(() => {});
  }

  console.log(`\n✓ lt borrower-switch (db): ${checks} assertions passed`);
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
