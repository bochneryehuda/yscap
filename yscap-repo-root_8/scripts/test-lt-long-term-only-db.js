'use strict';
/**
 * LT test — ONLY OUR OWN LOANS, against a REAL database.
 *
 * The pure suite proves the decisions. This proves the two things a pure suite
 * structurally cannot:
 *
 *   · **The mirror does not WRITE a short-term loan.** That is a claim about what
 *     lands in `lt_loans` after a real pass, and only Postgres can settle it — and
 *     it is the claim the owner actually made ("only long-term files").
 *   · **The pipeline's filter is real SQL that Postgres accepts and that hides the
 *     right rows.** A `CASE` expression that referenced a column that does not exist
 *     would be a 500 on the pipeline, or — inside a catch — an empty screen, which
 *     is exactly the complaint this change answers.
 *
 * AND THE ONE THAT WOULD BE EASY TO GET BACKWARDS: the census must STILL count the
 * short-term loans it can see. Hiding them from the pipeline is a screen decision;
 * dropping them from the census would break the reconciliation against Encompass and
 * make files disappear with nothing saying so.
 *
 * DB-GATED: skips cleanly with no database.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const assert = require('assert');

async function main() {
  await require(`${__dirname}/lib/db-gate`).skipUnlessDb('lt-long-term-only');

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
  const pipeline = require('../src/longterm/pipeline');
  const productBook = require('../src/longterm/product-book');

  let checks = 0;
  const ok = (c, w) => { assert.ok(c, w); checks++; };
  const eq = (a, b, w) => { assert.strictEqual(a, b, w); checks++; };

  const tag = `lto-${Date.now().toString(36)}`;
  const guid = (n) => `${tag}-${n}`;
  const found = (n, programName, termMonths) => ({
    encompassLoanGuid: guid(n),
    loanNumber: `${tag}-LN-${n}`,
    loanAmount: 250000,
    milestoneName: 'Started',
    loanFolder: 'Pipeline active',
    borrowerName: `Borrower ${n}`,
    encompassLastModified: new Date().toISOString(),
    programName,
    termMonths,
  });
  const row = async (n) => (await db.query(
    'SELECT * FROM lt_loans WHERE encompass_loan_guid = $1', [guid(n)])).rows[0] || null;

  try {
    // ── A. A short-term loan is never written ─────────────────────────────
    stub.loans = [
      found(1, 'DSCR 30 Year FRM', 360),          // ours
      found(2, 'Fix & Flip Purchase + reno', 12), // RTL's
      found(3, null, 36),                         // exactly 36 — a boundary case
      found(4, null, null),                       // no program, no term
    ];
    const pass = await sync.syncOnce({ readBudget: 0 });
    eq(pass.ok, true, 'the pass runs');
    eq(pass.discovered, 4, 'Encompass offered four loans');
    eq(pass.skippedShortTerm, 1,
      'THE ONE THAT MATTERS: exactly one was left where it belongs, and the pass SAYS how many');

    ok(await row(1), 'the DSCR loan is mirrored');
    ok(!(await row(2)),
      'the fix & flip is NOT — never written, and no Encompass call spent reading it');
    ok(await row(3), 'a 36-month boundary loan IS mirrored — a file we cannot place must not vanish');
    ok(await row(4), 'so is one with no program and no term');

    // ── B. "We could not ask" never reads as "short-term" ─────────────────
    stub.classifyFields = 'refused';
    stub.loans = [found(5, 'Fix & Flip Purchase + reno', 12)];
    const blind = await sync.syncOnce({ readBudget: 0 });
    eq(blind.skippedShortTerm, 0, 'with the classifying fields refused, nothing is skipped');
    eq(blind.classifyFields, 'refused', '…and the pass reports that it could not tell');
    ok(await row(5),
      'THE OTHER ONE THAT MATTERS: the loan is mirrored — mirroring too much is recoverable, dropping a real file is not');
    stub.classifyFields = 'answered';

    // ── C. The pipeline hides what is already in ──────────────────────────
    //
    // Loan 5 is in the book and is provably short-term — exactly the state a book
    // pulled before this rule existed is in.
    // The REAL viewer shape, from the real function. A hand-typed `{scope:'all'}`
    // is missing `seesAll` and quietly scopes the query to nobody — which is how the
    // first cut of this test "failed" on a filter that was working perfectly.
    const access = require('../src/longterm/access');
    const registry = require('../src/longterm/settings/encompass-settings');
    const viewer = access.accessFor({ id: null, role: 'super_admin' }, registry.resolve({}).settings);
    const books = { closed: [], withdrawn: [], excluded: [] };
    // Compared on the LOAN NUMBER, because that is a column the pipeline actually
    // selects. The first cut of this read `encompass_loan_guid` — which the pipeline
    // does not return — so every row compared as `undefined` and the suite reported a
    // failure about itself rather than about the filter. A test that asserts on a
    // field the query never returns proves nothing in either direction.
    const listed = async (hide) => {
      const q = pipeline.buildPipelineQuery(viewer, null, { search: tag }, { books, hideShortTerm: hide });
      const { rows } = await db.query(q.sql, q.params);
      return rows.map((r) => r.loan_number).filter(Boolean).sort();
    };
    const num = (n) => `${tag}-LN-${n}`;

    const shown = await listed(true);
    ok(!shown.includes(num(5)),
      'THE ONE THAT MATTERS HERE: the short-term loan already in the book is no longer listed');
    ok(shown.includes(num(1)), 'the DSCR loan still is');
    ok(shown.includes(num(3)) && shown.includes(num(4)),
      '…and so are the boundary and unknown ones — hidden means PROVABLY not ours, nothing else');

    const all = await listed(false);
    ok(all.includes(num(5)),
      'a tenant who turns the setting off sees it again — the switch genuinely switches');

    // ── D. The census still counts it ─────────────────────────────────────
    const census = await productBook.longTermBook({ access: viewer, staffId: null });
    const inCensus = (g) => [...census.longTerm, ...census.shortTerm, ...census.boundary, ...census.unknown]
      .some((r) => r.encompassLoanGuid === g);
    ok(inCensus(guid(5)),
      'THE ONE THAT WOULD BE EASY TO GET BACKWARDS: the census STILL counts it — hiding it from a screen '
      + 'must never drop it from the reconciliation against Encompass');
    ok(census.counts.longTerm + census.counts.shortTerm + census.counts.boundary + census.counts.unknown
      === census.counts.read, 'and the four buckets still account for every row read');

    console.log(`  ok   ${checks} checks`);
  } finally {
    await db.query('DELETE FROM lt_loans WHERE encompass_loan_guid LIKE $1', [`${tag}-%`]).catch(() => {});
  }
}

main().then(() => { console.log('\nall good'); process.exit(0); })
  .catch((e) => { console.error('  FAIL', (e && e.message) || e); process.exit(1); });
