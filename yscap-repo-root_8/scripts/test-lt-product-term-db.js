'use strict';
/**
 * PROOF, against a real Postgres, that the long/short rule and the census built on
 * it tell the truth about the book.
 *
 * Two things a pure test structurally cannot prove, and both have bitten this
 * repository before:
 *
 *   1. **THE SQL TWIN AGREES WITH THE JAVASCRIPT.** `product-term.js` states the
 *      rule twice — once for code, once for a query that must not drag the whole
 *      book through Node to filter it. A second copy of a rule drifts, and the one
 *      that drifts is the one that leaks (the `pilot_term_norm` /
 *      `pilot_property_type_norm` class). So both are RUN over the same rows and
 *      compared row for row.
 *   2. **EVERY COLUMN THIS CODE NAMES ACTUALLY EXISTS.** The census query is one
 *      SELECT over `lt_loans` joined to the shared identity tables. A phantom
 *      column there throws, and the throw would be reported as "no long-term
 *      files" — the exact `b.full_name` / `is_current` class this file warns about
 *      in two other places.
 *
 * DB-GATED: skips cleanly with no database, like every other suite in the chain.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const assert = require('assert');

async function main() {
  // Both CI jobs run the one chain and `test` has no database, so this must skip
  // rather than dial one. BEFORE anything that opens a connection.
  await require(__dirname + '/lib/db-gate').skipUnlessDb('lt-product-term');

  const db = require('../src/longterm/db');
  const productTerm = require('../src/longterm/product-term');
  const productBook = require('../src/longterm/product-book');

  let checks = 0;
  const ok = (c, w) => { assert.ok(c, w); checks++; };
  const eq = (a, b, w) => { assert.strictEqual(a, b, w); checks++; };

  const tag = `pt-${Date.now().toString(36)}`;
  const ids = [];
  const staffIds = [];

  // The cases: the owner's two sentences, the two answers we decline to give, and
  // a Flip program whose term contradicts it.
  const CASES = [
    { n: 'dscr-360', program: 'Investor DSCR 30 YEAR FRM', term: 360, want: 'long_term', folder: 'Open Loans', stage: 'submittal', ms: 'Submittal' },
    { n: 'dscr-480', program: 'DSCR I/O 40 Year FRM', term: 480, want: 'long_term', folder: 'Open Loans', stage: 'setup', ms: 'Loan Setup' },
    { n: 'flip-12', program: 'Fix & Flip Purchase + reno', term: 12, want: 'short_term', folder: 'Open Loans', stage: 'setup', ms: 'Loan Setup' },
    { n: 'flip-360', program: 'Fix & Flip Purchase + reno', term: 360, want: 'short_term', folder: 'Open Loans', stage: 'setup', ms: 'Loan Setup' },
    // A Flip program with NO term, and one with an unusable term. These are the
    // cases that ISOLATE the PRECEDENCE: with the program asked first they are
    // short-term, and with the term asked first they read as unknown. Without
    // them the twin-agreement check passes on a SQL twin whose case order is
    // reversed — proven by mutation, which is exactly why they are here.
    { n: 'flip-noterm', program: 'Fix & Flip Purchase + reno', term: null, want: 'short_term', folder: 'Open Loans', stage: 'setup', ms: 'Loan Setup' },
    { n: 'flip-zero', program: 'Fix & Flip Purchase + reno', term: 0, want: 'short_term', folder: 'Open Loans', stage: 'setup', ms: 'Loan Setup' },
    { n: 'blank-360', program: null, term: 360, want: 'long_term', folder: null, stage: null, ms: null },
    { n: 'blank-12', program: null, term: 12, want: 'short_term', folder: 'Closed', stage: 'closed', ms: 'Completion' },
    { n: 'exactly-36', program: 'Conventional Fixed', term: 36, want: 'boundary', folder: 'Open Loans', stage: 'setup', ms: 'Loan Setup' },
    { n: 'no-signal', program: null, term: null, want: 'unknown', folder: null, stage: null, ms: null },
    { n: 'zero-term', program: 'Conventional Fixed', term: 0, want: 'unknown', folder: 'Open Loans', stage: 'setup', ms: 'Loan Setup' },
  ];

  try {
    for (const c of CASES) {
      const r = await db.query(
        `INSERT INTO lt_loans (id, encompass_loan_guid, loan_number, loan_folder,
                               stage_key, milestone_name, term_months, program_name)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [`${tag}-${c.n}`, `${tag}-${c.n}`, c.folder, c.stage, c.ms, c.term, c.program],
      );
      ids.push(r.rows[0].id);
    }

    // -----------------------------------------------------------------------
    // A. THE SQL TWIN AND THE JAVASCRIPT AGREE — row for row, over real rows.
    // -----------------------------------------------------------------------
    const { rows } = await db.query(
      `SELECT loan_number, program_name, term_months,
              ${productTerm.productSql('program_name', 'term_months')} AS sql_product
         FROM lt_loans WHERE encompass_loan_guid LIKE $1 ORDER BY loan_number`,
      [`${tag}-%`],
    );
    eq(rows.length, CASES.length, 'every seeded loan is readable back');
    for (const row of rows) {
      const js = productTerm.classifyProduct({
        programName: row.program_name, termMonths: row.term_months,
      }).product;
      eq(row.sql_product, js,
        `the SQL twin and the JS agree on ${row.loan_number} (sql=${row.sql_product}, js=${js})`);
      const want = CASES.find((c) => row.loan_number === `${tag}-${c.n}`).want;
      eq(js, want, `${row.loan_number} classifies as ${want}`);
    }

    // -----------------------------------------------------------------------
    // B. THE CENSUS — every column real, every loan in exactly one bucket.
    // -----------------------------------------------------------------------
    const viewer = { access: { seesAll: true }, staffId: null };
    const book = await productBook.longTermBook(viewer, { db });

    const mine = (list) => list.filter((r) => String(r.loanNumber || '').startsWith(tag));
    eq(mine(book.longTerm).length, CASES.filter((c) => c.want === 'long_term').length,
      'the long-term list holds exactly the long-term loans');
    eq(mine(book.shortTerm).length, CASES.filter((c) => c.want === 'short_term').length,
      '…the short-term ones are counted and excluded, not dropped');
    eq(mine(book.boundary).length, 1, '…the 36-month file is listed for a decision');
    eq(mine(book.unknown).length, CASES.filter((c) => c.want === 'unknown').length,
      '…and the ones we cannot tell are reported as such');

    // NOTHING IS SILENTLY DROPPED: the four buckets partition the whole book.
    eq(book.counts.longTerm + book.counts.shortTerm + book.counts.boundary + book.counts.unknown,
      book.counts.read,
      'the four buckets account for every loan read — a census never loses a row');

    // The owner's four columns actually carry the file's own values.
    const one = mine(book.longTerm).find((r) => r.loanNumber === `${tag}-dscr-360`);
    ok(one, 'the DSCR file is on the long-term list');
    eq(one.folder, 'Open Loans', '…and states which folder it sits in');
    eq(one.status, 'submittal', '…which status it sits in');
    eq(one.milestone, 'Submittal', '…and which milestone it sits in');
    eq(one.termMonths, 360, '…with the term the verdict was made on');

    // The Flip-with-a-360-term contradiction is SHOWN, never swallowed.
    const odd = mine(book.disagreements);
    eq(odd.length, 1, 'the Flip program carrying a 360-month term is flagged as a disagreement');
    eq(odd[0].product, 'short_term', '…and is still classified short-term, per the owner\'s rule');

    // The grouping is derived from the same list, so the counts cannot disagree.
    const grouped = productBook.groupBook(mine(book.longTerm));
    const totalGrouped = grouped.reduce((s, f) => s + f.count, 0);
    eq(totalGrouped, mine(book.longTerm).length,
      'the by-folder grouping counts every long-term file exactly once');

    // -----------------------------------------------------------------------
    // C. THE MIRROR NEVER BLANKS WHAT IT ALREADY HOLDS.
    //    The sync writes term/program with COALESCE(new, old) — a read that could
    //    not see the term must leave the one we have alone, or a partial payload
    //    would erase the very facts this whole rule is built on.
    // -----------------------------------------------------------------------
    await db.query(
      `UPDATE lt_loans
          SET term_months = COALESCE($2, term_months),
              program_name = COALESCE($3, program_name)
        WHERE encompass_loan_guid = $1`,
      [`${tag}-dscr-360`, null, null],
    );
    const after = await db.query(
      'SELECT term_months, program_name FROM lt_loans WHERE encompass_loan_guid = $1',
      [`${tag}-dscr-360`],
    );
    eq(Number(after.rows[0].term_months), 360, 'a read with no term leaves the stored term alone');
    eq(after.rows[0].program_name, 'Investor DSCR 30 YEAR FRM',
      '…and leaves the stored program alone');

    // -----------------------------------------------------------------------
    // D. WHO THE OFFICER IS — the census must give the pipeline's answer.
    //    It used to join `staff_users` on `lt_loans.loan_officer_id`, a column
    //    nothing in the repository has ever written, so this whole section read
    //    "no loan officer" on every file while the pipeline showed one.
    // -----------------------------------------------------------------------
    console.log('\nwho the census says the officer is');

    const { rows: staff } = await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active)
            VALUES ($1, 'Encompass Officer', 'loan_officer', true),
                   ($2, 'Reassigned Officer', 'loan_officer', true)
         RETURNING id, full_name`,
      [`${tag}.a@example.test`, `${tag}.b@example.test`],
    );
    const encompassOfficer = staff.find((r) => r.full_name === 'Encompass Officer');
    const localOfficer = staff.find((r) => r.full_name === 'Reassigned Officer');
    staffIds.push(...staff.map((r) => r.id));

    const subject = (await db.query(
      'SELECT id FROM lt_loans WHERE encompass_loan_guid = $1', [`${tag}-dscr-360`],
    )).rows[0].id;

    const censusRow = async () => {
      const b2 = await productBook.longTermBook(viewer, { db });
      return [...b2.longTerm, ...b2.shortTerm, ...b2.boundary, ...b2.unknown]
        .find((r) => r.loanNumber === `${tag}-dscr-360`);
    };

    const before = await censusRow();
    eq(before.officerLinked, false, 'a loan with no loan team says so — nobody is on it yet');

    // Encompass names somebody we have NOT matched to a PILOT account.
    await db.query(
      `INSERT INTO lt_loan_contacts (id, loan_id, role, encompass_name, updated_at)
       VALUES (gen_random_uuid(), $1::uuid, 'loan_officer', 'Someone In Encompass', now())`,
      [subject],
    );
    const unmatched = await censusRow();
    ok(unmatched, 'a loan whose officer we cannot match is still LISTED — the join never drops the row it exists to report');
    eq(unmatched.officerLinked, false,
      '…and counts as unlinked, which is exactly the mapping work this census was built to surface');
    eq(unmatched.officerName, 'Someone In Encompass',
      '…while still SAYING WHO IT IS, in Encompass\'s own wording: a census whose whole job is "these files need somebody matched" that answers "no officer" on a file Encompass plainly names an officer on is telling the reader to go and look it up somewhere else');

    // Now Encompass's person IS one of ours.
    await db.query(
      `UPDATE lt_loan_contacts SET staff_id = $2::uuid WHERE loan_id = $1::uuid AND role = 'loan_officer'`,
      [subject, encompassOfficer.id],
    );
    const matched = await censusRow();
    eq(matched.officerLinked, true, 'once the person is matched the census says the file has an officer');
    eq(matched.officerName, 'Encompass Officer', '…and names them');

    // A LOCAL REASSIGNMENT. This is the case the whole one-expression rule exists
    // for: the pipeline, the file screen and the officer filter all moved the file
    // when this was set, and the census used to be blind to it.
    await db.query(
      `UPDATE lt_loan_contacts SET override_staff_id = $2::uuid
        WHERE loan_id = $1::uuid AND role = 'loan_officer'`,
      [subject, localOfficer.id],
    );
    const reassigned = await censusRow();
    eq(reassigned.officerName, 'Reassigned Officer',
      'THE ONE THAT MATTERS: a locally reassigned file names the NEW person on the census, the same person the pipeline\'s officer filter now returns — one question, one answer, on every screen that asks it');
    eq(reassigned.officerLinked, true, '…and still counts as linked');

    // A second ROLE must not turn one loan into two census rows.
    const rowsBefore = (await productBook.longTermBook(viewer, { db })).counts.read;
    await db.query(
      `INSERT INTO lt_loan_contacts (id, loan_id, role, encompass_name, staff_id, updated_at)
       VALUES (gen_random_uuid(), $1::uuid, 'processor', 'A Processor', $2::uuid, now())`,
      [subject, encompassOfficer.id],
    );
    const rowsAfter = (await productBook.longTermBook(viewer, { db })).counts.read;
    eq(rowsAfter, rowsBefore,
      'adding a SECOND role leaves the census the same length — lt_loan_contacts holds one row per role, and a plain join would have counted this loan twice and every six-role loan six times');
    eq((await censusRow()).officerName, 'Reassigned Officer',
      '…and the officer column still names the officer, not whichever contact row came back first');
  } finally {
    if (ids.length) {
      // One DELETE: the loan team cascades from the loan.
      await db.query('DELETE FROM lt_loans WHERE id = ANY($1::uuid[])', [ids]).catch(() => {});
    }
    if (staffIds.length) {
      await db.query('DELETE FROM staff_users WHERE id = ANY($1::uuid[])', [staffIds]).catch(() => {});
    }
    await db.pool.end().catch(() => {});
  }

  console.log(`\n✓ lt product-term (db): ${checks} assertions passed`);
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
