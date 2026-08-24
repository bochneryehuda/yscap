'use strict';
/**
 * PROOF, against a real Postgres, of the pass that brings the long-term book in —
 * and which no test had ever run.
 *
 * `sync/loans.js syncOnce` is the heart of the mirror: it discovers what Encompass
 * holds, writes each loan into `lt_loans`, then fully reads the ones that moved, up
 * to a budget. Every long-term screen is downstream of it. A coverage sweep of all
 * 121 long-term suites found it never executed — the worker suite stubs it out (it
 * is testing the worker, correctly), and nothing else called it.
 *
 * WHAT IS WORTH PINNING is not that it works on the happy path. It is the four
 * decisions inside it that are invisible when they are right and expensive when
 * they are wrong:
 *
 *   · AN EMPTY PIPELINE CHANGES NOTHING. An empty read is far more likely an
 *     outage or a changed filter than seven hundred loans vanishing, so a pass
 *     that discovers nothing must not deactivate, delete or blank a single row.
 *   · A DISCOVERY PASS MUST NOT CLOBBER A FIGURE IT DID NOT READ IN FULL. The
 *     upsert is deliberately asymmetric — the loan NUMBER takes the newest value,
 *     the loan AMOUNT keeps the one already stored — and an asymmetry that looks
 *     like a typo is exactly the kind of thing somebody tidies.
 *   · THE BUDGET BOUNDS THE PASS. Discovery is cheap and a loan read is not, so a
 *     pass reads at most `readBudget` and REPORTS what it left behind.
 *   · THE PEOPLE STEPS ARE BEST-EFFORT AND MAY NEVER COST THE MIRROR. The roster
 *     refresh reports an ordinary failure by RETURNING `{ok:false}` and an
 *     unexpected one by THROWING, and both have to be survived — and SAID, because
 *     a pass that reports a confident "0 officers proposed" when it never ran is
 *     worse than one that admits it.
 *
 * The Encompass client and the discovery call are stubbed through `require.cache`
 * (the pattern `test-lt-sync-worker-pure.js` uses) so the REAL pass runs end to
 * end; the database is real, because what is being proven is what lands in it.
 *
 * DB-GATED: skips cleanly with no database, like every other suite in the chain.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const assert = require('assert');
const path = require('path');

async function main() {
  await require(__dirname + '/lib/db-gate').skipUnlessDb('lt-loan-sync');

  const CLIENT = require.resolve('../src/longterm/encompass/client');
  const DISCOVER = require.resolve('../src/longterm/sync/discover');
  const ROSTER = require.resolve('../src/longterm/people/roster');
  const BLINKS = require.resolve('../src/longterm/borrower-links');
  const LOANS = require.resolve('../src/longterm/sync/loans');

  // What the stubs answer this run. Reassigned per case so one required module
  // serves every scenario — re-requiring loans.js per case would leave several
  // copies of it holding their own database pools.
  const stub = {
    configured: true,
    loans: [],
    truncated: false,
    discoverThrows: null,
    loanById: {},
    roster: async () => ({ ok: true, proposedNow: 0, unmatched: 0 }),
  };
  const put = (p, exports) => { require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

  put(CLIENT, {
    configured: () => stub.configured,
    getLoan: async (guid) => stub.loanById[guid] || { id: guid },
    fieldReader: async () => ({}),
    apiGet: async () => ({}),
  });
  put(DISCOVER, {
    discoverLoans: async () => {
      if (stub.discoverThrows) throw new Error(stub.discoverThrows);
      return { loans: stub.loans, pages: 1, truncated: stub.truncated };
    },
  });
  put(ROSTER, { syncRoster: async () => stub.roster() });
  put(BLINKS, { applyConfirmedLinks: async () => ({ linked: 0 }) });

  const db = require('../src/longterm/db');
  const sync = require(LOANS);

  let checks = 0;
  const ok = (c, w) => { assert.ok(c, w); checks++; };
  const eq = (a, b, w) => { assert.strictEqual(a, b, w); checks++; };

  const tag = `ls-${Date.now().toString(36)}`;
  const guid = (n) => `${tag}-${n}`;
  const discovered = (n, extra = {}) => ({
    encompassLoanGuid: guid(n),
    loanNumber: `LN-${n}`,
    loanAmount: 250000 + n,
    milestoneName: 'Started',
    loanFolder: 'DSCR',
    borrowerName: `Borrower ${n}`,
    encompassLastModified: new Date().toISOString(),
    ...extra,
  });
  const loanRow = async (n) => (await db.query(
    'SELECT * FROM lt_loans WHERE encompass_loan_guid = $1', [guid(n)])).rows[0] || null;

  try {
    // ── A. NOT CONNECTED IS A SENTENCE, NOT A CRASH ───────────────────────
    stub.configured = false;
    const unconfigured = await sync.syncOnce();
    eq(unconfigured.ok, false, 'with no Encompass credentials the pass does not run');
    ok(/not connected yet/i.test(unconfigured.reason || ''),
      '…and says so in words a screen can show, rather than throwing');
    stub.configured = true;

    // ── B. A PIPELINE WE CANNOT READ IS REPORTED, NOT SWALLOWED ───────────
    stub.discoverThrows = 'upstream exploded';
    const broke = await sync.syncOnce();
    eq(broke.ok, false, 'a discovery failure ends the pass');
    ok(/could not read the encompass pipeline/i.test(broke.reason || '')
      && /upstream exploded/.test(broke.reason || ''),
      '…naming what actually went wrong, because "sync failed" sends nobody anywhere');
    stub.discoverThrows = null;

    // ── C. THE MIRROR ─────────────────────────────────────────────────────
    stub.loans = [discovered(1), discovered(2)];
    const first = await sync.syncOnce({ readBudget: 0 });
    eq(first.ok, true, 'a pass over two discovered loans succeeds');
    eq(first.discovered, 2, '…and reports what it found');

    const one = await loanRow(1);
    ok(one, 'THE ONE THAT MATTERS: a discovered loan is in the mirror — every long-term screen is downstream of this row');
    eq(one.loan_number, 'LN-1', '…with its loan number');
    eq(one.borrower_name, 'Borrower 1',
      '…and the borrower NAME, which is the only thing an admin can recognise a loan by while deciding a link');
    eq(one.loan_folder, 'DSCR', '…and the folder it sits in');
    ok(one.stage_key, '…and a stage of ours, not just Encompass\'s milestone word');

    // ── D. THE BUDGET BOUNDS THE PASS, AND SAYS WHAT IT LEFT ──────────────
    //
    // Both loans are due a full read. A budget of one must read one and report
    // the other as remaining — a pass that silently dropped it would look
    // complete and leave the book half-mirrored for ever.
    stub.loanById[guid(1)] = { id: guid(1) };
    stub.loanById[guid(2)] = { id: guid(2) };
    const budgeted = await sync.syncOnce({ readBudget: 1 });
    eq(budgeted.due, 2, 'both loans are due a full read');
    eq(budgeted.read + budgeted.failed, 1, 'exactly one is read — discovery is cheap and a loan read is not');
    eq(budgeted.remaining, 1, '…and the one left behind is REPORTED, never silently dropped');

    // ── E. AN EMPTY PIPELINE CHANGES NOTHING ──────────────────────────────
    const before = await loanRow(1);
    stub.loans = [];
    const empty = await sync.syncOnce();
    eq(empty.ok, true, 'a pass that discovers nothing still succeeds');
    eq(empty.discovered, 0, '…and says it found nothing');
    ok(/no loans/i.test(empty.note || ''), '…explaining that nothing was changed');
    const after = await loanRow(1);
    ok(after, 'THE ONE THAT MATTERS: the loans already mirrored are still there — an empty read is far more likely an outage or a changed filter than seven hundred loans vanishing');
    eq(String(after.loan_number), String(before.loan_number), '…untouched');
    eq(String(after.stage_key), String(before.stage_key), '…including their stage');

    // ── F. A DISCOVERY PASS NEVER CLOBBERS A FIGURE IT DID NOT READ ───────
    //
    // The upsert is asymmetric ON PURPOSE: the loan NUMBER takes the newest value,
    // the AMOUNT keeps what is stored. Discovery carries a pipeline figure; the
    // full read carries the real one, and a later discovery must not overwrite it.
    await db.query('UPDATE lt_loans SET loan_amount = 999999 WHERE encompass_loan_guid = $1', [guid(1)]);
    stub.loans = [discovered(1, { loanNumber: 'LN-1-RENAMED', loanAmount: 111 })];
    await sync.syncOnce({ readBudget: 0 });
    const settled = await loanRow(1);
    eq(Number(settled.loan_amount), 999999,
      'THE ONE THAT MATTERS: a discovery pass leaves the stored loan amount alone — it carries a pipeline figure, and the full read carries the real one');
    eq(settled.loan_number, 'LN-1-RENAMED',
      '…while the loan NUMBER does take the newest value, which is the asymmetry the upsert is written for');

    // ── F2. …AND THE FULL READ IS WHAT CARRIES IT ─────────────────────────
    //
    // The sentence above has been in this suite since it shipped, and until
    // 2026-08-24 it was ASPIRATIONAL: `loan_amount` was written ONLY by the
    // discovery upsert, fill-only, so the figure was taken once when a loan was
    // first seen and never corrected — on the pipeline's own lagging copy. Every
    // other decision-bearing figure (rate, DSCR, the ARM terms, the expenses) is
    // refreshed by the application sync inside the full read; this one column was
    // missed. Owner-reported: *"The loan amounts always need to update."*
    //
    // Field 1109 is the authority, read BY NUMBER exactly as term (4) and program
    // (1401) are, because the same field number sits at a different JSON path from
    // loan to loan.
    stub.loanById[guid(1)] = { id: guid(1), _fieldValues: { 1109: '750000' } };
    stub.loans = [discovered(1)];
    // Force the loan DUE: `needsRead` turns on the freshness stamps, and by this
    // point in the suite the loan has already been read, so without this the
    // pass would legitimately skip it and the assertion would pass or fail for
    // a reason that has nothing to do with the amount.
    await db.query('UPDATE lt_loans SET encompass_synced_at = NULL WHERE encompass_loan_guid = $1', [guid(1)]);
    await sync.syncOnce({ readBudget: 5 });
    const repriced = await loanRow(1);
    eq(Number(repriced.loan_amount), 750000,
      'THE ONE THAT MATTERS: a full read CORRECTS the loan amount — before this it was written once at discovery and never again');

    // A read that could not see the amount must never blank one we hold. This is
    // the direction that costs money: a blanked amount is a mortgage with no
    // figure on the pipeline, the file screen and the ClickUp card at once.
    stub.loanById[guid(1)] = { id: guid(1) };
    stub.loans = [discovered(1)];
    // Force the loan DUE: `needsRead` turns on the freshness stamps, and by this
    // point in the suite the loan has already been read, so without this the
    // pass would legitimately skip it and the assertion would pass or fail for
    // a reason that has nothing to do with the amount.
    await db.query('UPDATE lt_loans SET encompass_synced_at = NULL WHERE encompass_loan_guid = $1', [guid(1)]);
    await sync.syncOnce({ readBudget: 5 });
    eq(Number((await loanRow(1)).loan_amount), 750000,
      '…and a read that saw no amount leaves the one we hold alone');

    // Junk states NOTHING rather than writing a 0 over a real amount.
    for (const bad of ['', '   ', 'not a number', '-5']) {
      stub.loanById[guid(1)] = { id: guid(1), _fieldValues: { 1109: bad } };
      stub.loans = [discovered(1)];
      // FORCE THE READ INSIDE THE LOOP TOO. Without this the loan is not due, no
      // read happens, and the assertion below passes because nothing ran — which
      // is exactly what it looked like until a mutation that made junk write 0
      // sailed through it. A test that cannot fail is not a test.
      await db.query('UPDATE lt_loans SET encompass_synced_at = NULL WHERE encompass_loan_guid = $1', [guid(1)]);
      const readBack = await sync.syncOnce({ readBudget: 5 });
      eq(readBack.read, 1, `…the loan really was re-read for ${JSON.stringify(bad)}`);
      eq(Number((await loanRow(1)).loan_amount), 750000,
        `…and an unreadable amount (${JSON.stringify(bad)}) never overwrites it`);
    }

    // A formatted figure is still a figure — Encompass hands these back as text.
    stub.loanById[guid(1)] = { id: guid(1), _fieldValues: { 1109: '$1,250,000.00' } };
    stub.loans = [discovered(1)];
    // Force the loan DUE: `needsRead` turns on the freshness stamps, and by this
    // point in the suite the loan has already been read, so without this the
    // pass would legitimately skip it and the assertion would pass or fail for
    // a reason that has nothing to do with the amount.
    await db.query('UPDATE lt_loans SET encompass_synced_at = NULL WHERE encompass_loan_guid = $1', [guid(1)]);
    await sync.syncOnce({ readBudget: 5 });
    eq(Number((await loanRow(1)).loan_amount), 1250000,
      '…while a formatted amount is read as the number it is');

    // ── G. THE PEOPLE STEPS MAY NEVER COST THE MIRROR ─────────────────────
    stub.loans = [discovered(3)];
    stub.roster = async () => { throw new Error('roster is down'); };
    const threw = await sync.syncOnce({ readBudget: 0 });
    eq(threw.ok, true, 'a roster refresh that THROWS does not fail the loan pass — the mirror is the job');
    ok(await loanRow(3), '…and the loan it discovered is mirrored anyway');
    ok(/roster is down/.test(threw.officerSyncReason || ''),
      '…while the reason is carried out, because a silent people failure is one nobody fixes');

    stub.roster = async () => ({ ok: false, reason: 'no credentials' });
    const refused = await sync.syncOnce({ readBudget: 0 });
    eq(refused.ok, true, 'and a roster refresh that REFUSES does not fail the pass either');
    eq(refused.officersProposed, 0, '…proposing nobody');
    ok(/no credentials/.test(refused.officerSyncReason || ''),
      'THE ONE THAT MATTERS: its refusal is reported rather than read as success — an ok:false treated as a caught error would print a confident "0 officers proposed" on a pass that never ran');
    stub.roster = async () => ({ ok: true, proposedNow: 2, unmatched: 1 });
    const proposed = await sync.syncOnce({ readBudget: 0 });
    eq(proposed.officersProposed, 2, 'a roster refresh that ran reports what it proposed');
    eq(proposed.officersUnmatched, 1, '…and how many logins it could not match at all');
    eq(proposed.officerSyncReason, null, '…with no reason, because there is nothing wrong');
  } finally {
    await db.query('DELETE FROM lt_loans WHERE encompass_loan_guid LIKE $1', [`${tag}%`]).catch(() => {});
    await db.pool.end().catch(() => {});
    // AND THE RTL POOL. These suites require the app, which opens `src/db`'s pool
    // transitively; `db` here is the LONG-TERM one. Leaving the other open kept a
    // Postgres socket alive until its 30-second idle timeout, so the suite printed
    // its result and then sat there doing nothing. Across nine suites that was 270
    // of the 286 seconds the long-term database suites took.
    await require('../src/db').pool.end().catch(() => {});
  }

  console.log(`\n✓ lt loan-sync (db): ${checks} assertions passed`);
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
