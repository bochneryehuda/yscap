'use strict';
/**
 * A LOAN NUMBER IS A LABEL, NOT A KEY — and one loan that will not save must never
 * discard the book.
 *
 * WHAT THIS IS ABOUT. The owner pressed "Pull everything from Encompass" and the
 * long-term book stayed empty. The run log named the reason, which is the only
 * thing that made this findable at all:
 *
 *   The last pull did not work.
 *   Could not save the discovered loans: duplicate key value violates unique
 *   constraint "lt_loans_loan_number_key"
 *
 * TWO INDEPENDENT DEFECTS sat behind that one line, and either alone empties the
 * pipeline, so both are pinned here:
 *
 *   1. db/549 declared the human loan NUMBER unique, beside the Encompass GUID, as
 *      though both were identities. Two real Encompass loans sharing one number is
 *      an ordinary state of that system — a duplicated file, or a cancelled one
 *      re-created — so the mirror refused a book Encompass considers perfectly
 *      normal. db/617 makes it a plain index.
 *
 *   2. The whole discovered book was mirrored inside ONE transaction with the loop
 *      bare inside it, so the FIRST row Postgres refused aborted the transaction
 *      and the catch rolled back every loan in the pass. The count of loans
 *      actually at fault was one; the count lost was all of them.
 *
 * Section C is the one that would have caught this before it shipped, and it is
 * deliberately NOT written as "two loans with the same number save" — that only
 * tests db/617. It makes a row fail for a reason that has nothing to do with loan
 * numbers, and asserts the OTHERS still arrive. That is the property that matters:
 * a per-row failure is a per-row failure.
 */

const assert = require('assert');

async function main() {
  await require(`${__dirname}/lib/db-gate`).skipUnlessDb('lt-loan-number-label');

  const CLIENT = require.resolve('../src/longterm/encompass/client');
  const DISCOVER = require.resolve('../src/longterm/sync/discover');
  const ROSTER = require.resolve('../src/longterm/people/roster');
  const BLINKS = require.resolve('../src/longterm/borrower-links');
  const LOANS = require.resolve('../src/longterm/sync/loans');

  const stub = { loans: [], classifyFields: 'answered' };
  const put = (p, exports) => { require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  put(CLIENT, {
    configured: () => true,
    getLoan: async (guid) => ({ id: guid }),
    fieldReader: async () => ({}),
    apiGet: async () => ({}),
  });
  put(DISCOVER, {
    discoverLoans: async () => ({
      loans: stub.loans, pages: 1, truncated: false, classifyFields: stub.classifyFields,
    }),
  });
  put(ROSTER, { syncRoster: async () => ({ ok: true, proposedNow: 0, unmatched: 0 }) });
  put(BLINKS, { applyConfirmedLinks: async () => ({ linked: 0 }) });

  const db = require('../src/longterm/db');
  const sync = require(LOANS);

  let checks = 0;
  const ok = (c, w) => { assert.ok(c, w); console.log('  ok  ', w); checks++; };
  const eq = (a, b, w) => { assert.strictEqual(a, b, w); console.log('  ok  ', w); checks++; };

  const tag = `lnk-${Date.now().toString(36)}`;
  const found = (n, over = {}) => ({
    encompassLoanGuid: `${tag}-${n}`,
    loanNumber: `${tag}-LN-${n}`,
    loanAmount: 250000,
    milestoneName: 'Started',
    loanFolder: 'Pipeline active',
    borrowerName: `Borrower ${n}`,
    encompassLastModified: new Date().toISOString(),
    programName: 'DSCR 30 Year Fixed',
    termMonths: 360,
    ...over,
  });
  const countByNumber = async (num) => Number((await db.query(
    'SELECT count(*)::int AS n FROM lt_loans WHERE loan_number = $1', [num])).rows[0].n);
  const exists = async (guid) => Number((await db.query(
    'SELECT count(*)::int AS n FROM lt_loans WHERE encompass_loan_guid = $1', [guid])).rows[0].n) === 1;

  // ── A. the column is a label ───────────────────────────────────────────────
  console.log('\nA. the loan number is a LABEL — the database no longer treats it as a key');
  const idx = (await db.query(
    `SELECT i.indisunique FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = 'lt_loans_loan_number_key'`)).rows[0];
  ok(idx, 'the index still exists — searching the pipeline by loan number still has one');
  eq(idx.indisunique, false, '…and it is NOT unique any more');
  const guidIdx = (await db.query(
    `SELECT i.indisunique FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = 'lt_loans_encompass_loan_guid_key'`)).rows[0];
  eq(guidIdx && guidIdx.indisunique, true,
    'the GUID index IS still unique — identity did not move, only the label stopped pretending to be one');

  // ── B. the owner's exact failure ───────────────────────────────────────────
  console.log('\nB. the owner\'s own case: two Encompass loans carrying one loan number');
  const shared = `${tag}-SHARED`;
  stub.loans = [found('a', { loanNumber: shared }), found('b', { loanNumber: shared })];
  const twin = await sync.syncOnce({ readBudget: 0 });
  eq(twin.ok, true, 'the pass no longer fails outright — this is the line the owner was shown');
  eq(await countByNumber(shared), 2, '…and BOTH loans are in the book, not one and not none');

  // ── C. THE PROPERTY THAT MATTERS ───────────────────────────────────────────
  // A row is made to fail for a reason with nothing to do with loan numbers: an
  // amount too big for numeric(14,2). Testing only the duplicate would prove db/617
  // and leave the batch trap fully armed for the next constraint.
  console.log('\nC. one loan the database refuses does NOT discard the other loans');
  const huge = '9'.repeat(20);
  stub.loans = [found('c1'), found('bad', { loanAmount: huge }), found('c2')];
  const partial = await sync.syncOnce({ readBudget: 0 });
  eq(partial.ok, true, 'the pass reports success — most of the book genuinely arrived');
  ok(await exists(`${tag}-c1`), 'the loan BEFORE the bad one is in the book');
  ok(await exists(`${tag}-c2`), '…and so is the loan AFTER it — the transaction was not lost');
  ok(!(await exists(`${tag}-bad`)), '…while the loan that could not be saved is genuinely absent');

  // ── D. nothing is dropped silently ─────────────────────────────────────────
  console.log('\nD. the refused loan is COUNTED and NAMED — never a silent gap');
  eq(partial.refused, 1, 'the pass says how many it could not save');
  ok(Array.isArray(partial.refusedLoans) && partial.refusedLoans.length === 1,
    '…and carries them, so a screen can name them rather than only counting');
  eq(partial.refusedLoans[0].loanNumber, `${tag}-LN-bad`,
    '…by the loan number, which is what a person recognises a loan by');
  ok(/numeric|overflow|out of range/i.test(partial.refusedLoans[0].reason || ''),
    '…with the database\'s own reason kept, so it can be diagnosed without a re-run');

  // ── E. it survives the next deploy ─────────────────────────────────────────
  // db/549 replays on EVERY boot and re-asserts CREATE UNIQUE INDEX IF NOT EXISTS on
  // this very name. If db/617 had re-created the index under a NEW name, that
  // statement would find its name free, try to build a unique index over the
  // duplicates section B just created, and fail — rolling back the whole of db/549
  // on every boot forever. This asserts the converged state, not the intention.
  console.log('\nE. the next deploy does not undo it (db/549 replays every boot)');
  await require('../src/migrate-boot').ensureSchema();
  const after = (await db.query(
    `SELECT i.indisunique FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = 'lt_loans_loan_number_key'`)).rows[0];
  eq(after && after.indisunique, false, 'after a full migration replay the index is STILL not unique');
  eq(await countByNumber(shared), 2, '…and the two loans sharing a number are still both there');

  await db.query('DELETE FROM lt_loans WHERE encompass_loan_guid LIKE $1', [`${tag}-%`]);
  console.log(`\nall good — ${checks} checks`);
  process.exit(0);
}

main().catch((e) => { console.error('\nFAILED:', e && e.message); process.exit(1); });
