'use strict';
/**
 * PROOF, against a real Postgres, that confirming a borrower link actually PUTS
 * THE LOAN ON THE CLIENT'S LOGIN — and that undoing one actually takes it off.
 *
 * A pure test cannot prove either half. `lt_loans.borrower_id` is what a borrower's
 * own login reads; a decision that recorded but did not APPLY would look finished
 * on the screen and change nothing for the client, which is precisely the state
 * this whole change exists to end (the column has existed since db/549 and nothing
 * has ever written it). So the assertions below read the loan rows back.
 *
 * The other thing only a database can prove: the db/573 CHECK. A rejection must
 * never carry a borrower id, because the sync applies confirmed links BY ADDRESS
 * and a refusal that carried one would be a single typo away from being applied.
 *
 * DB-GATED: skips cleanly with no database, like every other suite in the chain.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const assert = require('assert');

async function main() {
  // Both CI jobs run the one chain and `test` has no database, so this must skip
  // rather than dial one. BEFORE anything that opens a connection.
  await require(__dirname + '/lib/db-gate').skipUnlessDb('lt-borrower-link');

  const db = require('../src/longterm/db');
  const links = require('../src/longterm/borrower-links');
  const match = require('../src/longterm/borrower-match');

  let checks = 0;
  const ok = (c, w) => { assert.ok(c, w); checks++; };
  const eq = (a, b, w) => { assert.strictEqual(a, b, w); checks++; };

  const tag = `bl-${Date.now().toString(36)}`;
  const email = `${tag}@example.com`;
  const otherEmail = `${tag}-two@example.com`;
  const loanIds = [];
  const borrowerIds = [];

  const seedLoan = async (n, mail, name) => {
    const { rows } = await db.query(
      `INSERT INTO lt_loans (id, encompass_loan_guid, loan_number, borrower_email, borrower_name)
       VALUES (gen_random_uuid(), $1, $1, $2, $3) RETURNING id`,
      [`${tag}-${n}`, mail, name],
    );
    loanIds.push(rows[0].id);
    return rows[0].id;
  };
  const seedBorrower = async (first, last, mail) => {
    const { rows } = await db.query(
      `INSERT INTO borrowers (id, first_name, last_name, email)
       VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id`,
      [first, last, mail],
    );
    borrowerIds.push(rows[0].id);
    return rows[0].id;
  };
  const loanBorrower = async (id) => (await db.query(
    'SELECT borrower_id FROM lt_loans WHERE id = $1::uuid', [id])).rows[0].borrower_id;

  try {
    const l1 = await seedLoan('a', email, 'Sam Fried');
    const l2 = await seedLoan('b', email, 'Fried  Sam'); // same person, spelled badly
    const person = await seedBorrower('Sam', 'Fried', email);

    // -----------------------------------------------------------------------
    // A. NOTHING IS LINKED UNTIL A HUMAN SAYS SO. The matcher can propose all it
    //    likes; the loans stay attached to nobody.
    // -----------------------------------------------------------------------
    eq(await loanBorrower(l1), null, 'a freshly mirrored loan belongs to nobody');
    const { rows: profiles } = await db.query(
      'SELECT id, email, NULLIF(full_name, \'\') AS full_name FROM borrowers WHERE email = $1', [email]);
    const proposal = match.matchBorrowers(
      [{ id: l1, borrower_email: email, borrower_name: 'Sam Fried' },
        { id: l2, borrower_email: email, borrower_name: 'Fried  Sam' }],
      profiles,
    );
    eq(proposal.suggestions.length, 1, 'the matcher proposes the one address');
    eq(String(proposal.suggestions[0].borrowerId), String(person), '…naming the real profile');
    eq(await loanBorrower(l1), null, '…and proposing changed nothing on the loan');

    // -----------------------------------------------------------------------
    // B. CONFIRMING PUTS THE LOAN ON THE CLIENT'S LOGIN. Both loans on the
    //    address, in one act — that is the point of keying on the address.
    // -----------------------------------------------------------------------
    const done = await links.confirmLink(email, person, null);
    eq(done.loansLinked, 2, 'confirming attaches every loan on the address');
    eq(String(await loanBorrower(l1)), String(person), 'the first loan now belongs to the borrower');
    eq(String(await loanBorrower(l2)), String(person), '…and so does the second');

    // Confirming twice is not an error and does not double anything.
    const again = await links.confirmLink(email, person, null);
    eq(again.loansLinked, 0, 'confirming again changes nothing — it is already done');

    // -----------------------------------------------------------------------
    // C. A DECISION REACHES A LOAN THAT ARRIVES LATER. Nobody is going to
    //    re-confirm an address they already answered, so a new loan carrying it
    //    must inherit the answer on the next sync pass.
    // -----------------------------------------------------------------------
    const l3 = await seedLoan('c', email, 'Sam Fried');
    eq(await loanBorrower(l3), null, 'a brand-new loan starts attached to nobody');
    const applied = await links.applyConfirmedLinks();
    ok(applied.ok, 'the apply pass runs');
    eq(String(await loanBorrower(l3)), String(person),
      'a loan that arrived AFTER the decision inherits it');

    // -----------------------------------------------------------------------
    // D. UNDOING IS AS COMPLETE AS DOING. Leaving `borrower_id` stamped would keep
    //    the file on the client's login while the screen showed nothing linked.
    // -----------------------------------------------------------------------
    const undone = await links.unlink(email);
    eq(undone.loansDetached, 3, 'undoing detaches every loan the link attached');
    eq(await loanBorrower(l1), null, 'the loan leaves the borrower\'s login again');
    const gone = await db.query('SELECT 1 FROM lt_borrower_links WHERE encompass_email = $1', [email]);
    eq(gone.rows.length, 0, '…and the decision itself is forgotten');

    // -----------------------------------------------------------------------
    // E. A REJECTION IS DURABLE AND CARRIES NOBODY.
    // -----------------------------------------------------------------------
    await links.rejectLink(email, null);
    const rej = (await db.query(
      'SELECT status, borrower_id FROM lt_borrower_links WHERE encompass_email = $1', [email])).rows[0];
    eq(rej.status, 'rejected', 'the refusal is recorded');
    eq(rej.borrower_id, null, '…and names nobody');
    eq(await loanBorrower(l1), null, '…and rejecting a suggestion attaches nothing');

    // THE DATABASE ITSELF refuses a rejection that names somebody — the guard that
    // stops a refusal ever being applied as a link.
    let refused = null;
    try {
      await db.query(
        `UPDATE lt_borrower_links SET borrower_id = $2::uuid WHERE encompass_email = $1`,
        [email, person]);
    } catch (e) { refused = e; }
    ok(refused, 'the database refuses a rejected link that names a borrower');

    // -----------------------------------------------------------------------
    // F. THE ROUTE-LEVEL GUARD: two different people on one mailbox is refused at
    //    the WRITE, not only in the suggestion. A screen is not a security
    //    boundary and this call can be reached directly.
    // -----------------------------------------------------------------------
    await seedLoan('d', otherEmail, 'Sam Fried');
    await seedLoan('e', otherEmail, 'Rivka Fried');
    const other = await seedBorrower('Sam', 'Fried', otherEmail);
    let blocked = null;
    try { await links.confirmLink(otherEmail, other, null); } catch (e) { blocked = e; }
    ok(blocked && blocked.status === 409,
      'confirming an address carrying two different names is REFUSED');
    ok(/more than one borrower name/i.test(String(blocked && blocked.plain)),
      '…in words the admin can act on');

    // …and a placeholder address can never be linked at all.
    let placeholder = null;
    try {
      await links.confirmLink('noemail+9@clickup.local', person, null);
    } catch (e) { placeholder = e; }
    ok(placeholder && placeholder.status === 400,
      'an address that identifies nobody is refused');

    // …and an address no long-term loan carries has nothing to link.
    let nothing = null;
    try { await links.confirmLink('stranger@example.com', person, null); } catch (e) { nothing = e; }
    ok(nothing && nothing.status === 404, 'an address on no loan is refused');

    // -----------------------------------------------------------------------
    // G. THE SHARED IDENTITY RECORD IS NEVER WRITTEN. Long-Term READS the person
    //    record and never rewrites it (charter §2). Proven on the source, because
    //    a behavioural test can only ever show that THIS run did not write one.
    // -----------------------------------------------------------------------
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../src/longterm/borrower-links.js'), 'utf8');
    ok(!/UPDATE\s+borrowers|INSERT\s+INTO\s+borrowers|DELETE\s+FROM\s+borrowers/i.test(src),
      'the link module never writes the shared borrower record');
  } finally {
    if (loanIds.length) {
      await db.query('DELETE FROM lt_loans WHERE id = ANY($1::uuid[])', [loanIds]).catch(() => {});
    }
    await db.query('DELETE FROM lt_borrower_links WHERE encompass_email = ANY($1::text[])',
      [[email, otherEmail]]).catch(() => {});
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

  console.log(`\n✓ lt borrower-link (db): ${checks} assertions passed`);
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
