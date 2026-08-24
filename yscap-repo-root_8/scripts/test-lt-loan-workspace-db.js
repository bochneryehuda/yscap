'use strict';
/**
 * PROOF, over real HTTP, of the LOAN WORKSPACE — the biggest screen in the
 * long-term product — and of the two security boundaries on its route.
 *
 * Fourth thread from the coverage sweep of every long-term suite. The workspace
 * route (`GET /api/lt/pipeline/:loanId`) assembles the file header, the milestone
 * stepper, the summary rail, the section menu and the contact list. One suite
 * touches that path, and it asks for a loan that IS NOT THERE — so the route
 * answers 404 at the row check and everything below it had never run once.
 *
 * TWO OF THE THINGS THAT HAD NEVER RUN ARE SECURITY BOUNDARIES:
 *
 *   · A FILE YOU MAY NOT SEE ANSWERS EXACTLY AS A FILE THAT DOES NOT EXIST.
 *     Not "403 with a polite message" — the same 404, the same words. Telling a
 *     scoped officer "this loan exists but is not yours" is itself a disclosure
 *     about the book: it turns the loan-id space into an oracle somebody can
 *     walk. This suite does not assert the status code; it asserts the two
 *     answers are INDISTINGUISHABLE, which is the actual property.
 *
 *   · THE REASSIGNMENT DOOR IS ADMIN-ONLY, AND THAT IS PRIVILEGE ESCALATION
 *     RATHER THAN COURTESY. The pipeline scope matches `override_staff_id`, so
 *     writing an override GRANTS access to a file. A scoped officer able to set
 *     their own could read any file in the book by naming themselves on it. That
 *     is proven here as the sequence it actually is: a stranger is refused the
 *     write, and the file stays invisible to them afterwards — and then the same
 *     write BY AN ADMIN is shown to genuinely hand the file over, which is what
 *     makes the refusal load-bearing.
 *
 * ALSO PINNED, because the workspace is where these become visible:
 *   · The file header carries the product stamp (CLAUDE.md §7) on the loan
 *     itself, so the screen renders what the row says rather than what screen it is.
 *   · Within one role slot the override REPLACES Encompass's person: the file
 *     genuinely moves, rather than being held by two people at once. Across slots
 *     nothing is taken away.
 *   · NOTHING IS WRITTEN TO ENCOMPASS. `staff_id` is byte-for-byte what it was
 *     before the reassignment; the override sits beside it.
 *   · Clearing the override by naming nobody returns the file to Encompass's person.
 *
 * DB-GATED: skips cleanly with no database, like every other suite in the chain.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const assert = require('assert');
const http = require('http');
const path = require('path');

async function main() {
  await require(path.join(__dirname, 'lib', 'db-gate')).skipUnlessDb('lt-loan-workspace');

  const app = require('../src/server');
  const crypto = require('../src/lib/crypto');
  const db = require('../src/db');
  const ltDb = require('../src/longterm/db');

  let checks = 0;
  const ok = (c, w) => { assert.ok(c, w); checks++; };
  const eq = (a, b, w) => { assert.strictEqual(a, b, w); checks++; };

  const stamp = `ltws-${Date.now().toString(36)}`;
  const madeLoans = [];
  const madeBorrowers = [];
  let server = null;

  const seed = async (role, name) => {
    const { rows } = await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active)
       VALUES ($1, $2, $3, true) RETURNING id, token_version`,
      [`${stamp}-${role}-${name.replace(/\W+/g, '')}@example.test`, name, role],
    );
    return {
      id: String(rows[0].id),
      token: crypto.signJwt({ sub: String(rows[0].id), kind: 'staff', role, tv: rows[0].token_version, sid: stamp }),
    };
  };

  try {
    const admin = await seed('super_admin', 'WS Admin');
    const named = await seed('loan_officer', 'WS Named Officer');
    const stranger = await seed('loan_officer', 'WS Stranger');
    const movedTo = await seed('processor', 'WS Moved To');

    // One real long-term file, with a borrower so the header has a name to carry
    // and the LEFT JOIN in the route is exercised rather than skipped.
    // `full_name` on borrowers is GENERATED from the two name columns, so it is
    // written by writing those — and read back below exactly as the header shows it.
    const { rows: bor } = await db.query(
      `INSERT INTO borrowers (first_name, last_name, email)
       VALUES ($1, $2, $3) RETURNING id, full_name`,
      [stamp, 'Borrower', `${stamp}-borrower@example.test`],
    );
    const borrowerName = bor[0].full_name;
    madeBorrowers.push(bor[0].id);

    const { rows: loans } = await ltDb.query(
      `INSERT INTO lt_loans (id, loan_number, encompass_loan_guid, milestone_name, stage_key, loan_folder, borrower_id)
       VALUES (gen_random_uuid(), $1, $1, 'Processing', 'underwriting', 'Pipeline', $2::uuid)
       RETURNING id`,
      [`${stamp}-1`, bor[0].id],
    );
    const loanId = String(loans[0].id);
    madeLoans.push(loanId);

    await ltDb.query(
      `INSERT INTO lt_loan_contacts (id, loan_id, role, encompass_name, staff_id)
       VALUES (gen_random_uuid(), $1::uuid, 'loan_officer', 'Encompass Named Officer', $2::uuid)`,
      [loanId, named.id],
    );

    // A loan id that is well-formed and belongs to nothing. The comparison below is
    // the whole point of it.
    const NO_LOAN = '00000000-0000-4000-8000-000000000000';

    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    const call = async (method, p, who, body) => {
      const res = await fetch(base + p, {
        method,
        headers: {
          authorization: `Bearer ${who.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const raw = await res.text();
      let out = null;
      try { out = JSON.parse(raw); } catch (_) { out = null; }
      return { status: res.status, body: out, raw };
    };

    // ── A. THE WORKSPACE ACTUALLY ASSEMBLES ───────────────────────────────
    // Everything below the row check had never executed in any suite, so this
    // half is not "it returns 200" — it is "each region the screen mounts is
    // present", because a screen that mounts an undefined rail renders blank
    // and says nothing about why.
    const asAdmin = await call('GET', `/api/lt/pipeline/${loanId}`, admin);
    eq(asAdmin.status, 200, 'the loan workspace opens for somebody who sees the whole book');
    ok(asAdmin.body && asAdmin.body.loan, '…and carries the loan itself');
    eq(String(asAdmin.body.loan.loan_number), `${stamp}-1`, '…the one that was asked for');
    eq(asAdmin.body.loan.borrower_name, borrowerName,
      '…with the borrower name the header shows, which comes from a JOIN that had never run');
    for (const region of ['sections', 'stepper', 'rail', 'contacts', 'milestoneClock']) {
      ok(asAdmin.body[region] !== undefined,
        `…and the screen's "${region}" region, which mounts blank if it arrives undefined`);
    }
    ok(Array.isArray(asAdmin.body.contacts) && asAdmin.body.contacts.length === 1,
      'the contact list holds the one role this file has');
    eq(asAdmin.body.contacts[0].role, 'loan_officer', '…named as the role Encompass gave it');

    // The FILE HEADER stamp (CLAUDE.md §7) rides on the payload, so the screen
    // renders which side the FILE is on rather than which screen it is.
    eq(asAdmin.body.product, 'long_term',
      'the file header is stamped long-term by the ROW, not by the screen it happens to be drawn on');

    const asNamed = await call('GET', `/api/lt/pipeline/${loanId}`, named);
    eq(asNamed.status, 200, 'and for the scoped officer Encompass named on the file');

    // ── A2. THE MILESTONE CLOCK IS MEASURED AGAINST THIS LOAN'S OWN LADDER
    //        (audit round 4, C1) ────────────────────────────────────────────
    //
    // `milestone_since` now means "when the last step COMPLETED" = when the wait
    // on the NEXT step began, so the bar is the AWAITED step's expected_days.
    // Deriving "the next step" from the COMPANY CATALOG is wrong: a real funded
    // loan's ladder runs "Docs Out → Funding" with WIRE ORDER ABSENT while the
    // catalog runs "Docs Out → Wire Order → Funding" — and Wire Order's
    // expected_days is 0, which describeClock reads as "no expectation set",
    // silently switching the stall alarm OFF on a genuinely stalled file.
    await db.query(
      `UPDATE lt_loans SET milestone_name = 'Docs Out', stage_key = 'closing',
              milestone_since = now() - interval '9 days', milestone_since_is_baseline = false
        WHERE id = $1::uuid`, [loanId]);
    // This loan's ladder SKIPS Wire Order, exactly as the live trace records.
    for (const [nm, pos, done] of [['Docs Out', 12, true], ['Funding', 13, false]]) {
      await db.query(
        `INSERT INTO lt_loan_milestones (loan_id, milestone_name, position, done)
         VALUES ($1::uuid, $2, $3, $4)
         ON CONFLICT (loan_id, milestone_name) DO UPDATE SET position = EXCLUDED.position, done = EXCLUDED.done`,
        [loanId, nm, pos, done]);
    }
    const clocked = await call('GET', `/api/lt/pipeline/${loanId}`, admin);
    const mc = clocked.body && clocked.body.milestoneClock;
    ok(mc, 'the clock rides on the payload');
    eq(mc.expectedDays, 1,
      "the bar is FUNDING's expectation (1) — the step this loan actually awaits, not the catalog's Wire Order (C1)");
    eq(mc.stalled, true,
      '…so a 9-day wait against a 1-day bar still reports STALLED — the alarm is not silently switched off');

    // Every step done → nothing is awaited, so there is NO bar. Measuring
    // against the FINISHED step would restart the alarm on a completed file.
    await db.query(
      `UPDATE lt_loan_milestones SET done = true WHERE loan_id = $1::uuid`, [loanId]);
    await db.query(
      `UPDATE lt_loans SET milestone_name = 'Funding' WHERE id = $1::uuid`, [loanId]);
    const doneClock = await call('GET', `/api/lt/pipeline/${loanId}`, admin);
    eq(doneClock.body.milestoneClock.expectedDays, null,
      'with every step done nothing is awaited, so no bar is claimed');
    eq(doneClock.body.milestoneClock.stalled, null,
      '…and a finished file is never reported stalled');
    await db.query('DELETE FROM lt_loan_milestones WHERE loan_id = $1::uuid', [loanId]);
    await db.query(
      `UPDATE lt_loans SET milestone_name = 'Submittal', stage_key = 'submitted',
              milestone_since = NULL WHERE id = $1::uuid`, [loanId]);

    // ── B. THE ONE THAT MATTERS: A FILE THAT IS NOT YOURS IS INDISTINGUISHABLE
    //       FROM ONE THAT DOES NOT EXIST ────────────────────────────────────
    //
    // Asserting "403" or even "404" would miss it. The property the route claims
    // is that the two answers CANNOT BE TOLD APART — because a different answer
    // for a real file turns every loan id into a question PILOT will answer about
    // a book the asker may not see.
    const forbidden = await call('GET', `/api/lt/pipeline/${loanId}`, stranger);
    const missing = await call('GET', `/api/lt/pipeline/${NO_LOAN}`, stranger);
    eq(forbidden.status, missing.status,
      'THE ONE THAT MATTERS: a file that is not yours answers with the same STATUS as a file that does not exist');
    eq(forbidden.raw, missing.raw,
      'THE ONE THAT MATTERS: …and the same BODY, byte for byte — so a loan id can never be used to ask whether a loan is real');
    eq(forbidden.status, 404,
      '…and the answer they share is the missing-file one, not a shared 403 that would leak just as much');

    // ── C. THE REASSIGNMENT DOOR IS AN ACCESS GRANT ───────────────────────
    // First the refusals, then the proof that the thing being refused is real.
    const selfGrant = await call(
      'POST', `/api/lt/pipeline/${loanId}/contacts/loan_officer/override`, stranger,
      { staffId: stranger.id, reason: 'mine now' },
    );
    eq(selfGrant.status, 403,
      'THE ONE THAT MATTERS: a scoped officer may not name themselves on a file — the pipeline scope matches the override, so this write IS a grant of access');
    ok(/administrator/i.test((selfGrant.body && selfGrant.body.error) || ''),
      '…and is told who can, rather than being silently ignored');

    const stillHidden = await call('GET', `/api/lt/pipeline/${loanId}`, stranger);
    eq(stillHidden.raw, missing.raw,
      '…and the file is still indistinguishable from a missing one afterwards, so the refused write left nothing behind');

    // The officer Encompass DID name is refused too. Being on the file is not the
    // same authority as deciding who is on it.
    const namedTries = await call(
      'POST', `/api/lt/pipeline/${loanId}/contacts/loan_officer/override`, named,
      { staffId: movedTo.id, reason: 'handing off' },
    );
    eq(namedTries.status, 403,
      'the officer who holds the file may not reassign it either — holding a file is not authority over who holds it');

    // Now the same write by an admin, and what it hands over.
    const grant = await call(
      'POST', `/api/lt/pipeline/${loanId}/contacts/loan_officer/override`, admin,
      { staffId: movedTo.id, reason: 'covering while out' },
    );
    eq(grant.status, 200, 'an administrator may reassign the role');
    ok(grant.body && grant.body.contact, '…and is answered with the contact as the screen will now draw it');

    const movedSees = await call('GET', `/api/lt/pipeline/${loanId}`, movedTo);
    eq(movedSees.status, 200,
      'THE ONE THAT MATTERS: the person named by the override can now open a file they could not see a moment ago — which is precisely why the door above is admin-only');

    const displacedTried = await call('GET', `/api/lt/pipeline/${loanId}`, named);
    eq(displacedTried.status, 404,
      'and within that one slot the override REPLACES Encompass\'s person, so the file genuinely moves rather than being held by two people at once');

    // AND IT MOVES IN THE BOOK, NOT ONLY THROUGH A DIRECT LINK.
    //
    // The two halves above go through `mayOpenLoan` — the rule expressed in JS for
    // rows already in hand. The pipeline LIST narrows in SQL instead, and the two
    // are separate expressions of one rule (access.js says so at length, and names
    // the drift as the thing it is guarding against). Asserting only the direct
    // link would leave the sentence this whole door rests on — "the pipeline scope
    // matches override_staff_id" — proven for the half that is not the scope. So
    // the list is asked too, and both halves have to agree.
    const inBook = async (who) => {
      const r = await call('GET', '/api/lt/pipeline?limit=200', who);
      eq(r.status, 200, 'the pipeline list answers');
      return (r.body.loans || []).some((l) => String(l.id) === loanId);
    };
    eq(await inBook(movedTo), true,
      'THE ONE THAT MATTERS: and the file is in their BOOK, not merely reachable by a direct link — the scope the list narrows by is the thing the override writes into');
    eq(await inBook(named), false,
      '…and has left the book of the person Encompass names, so the two readings of the rule agree');
    eq(await inBook(stranger), false, 'while somebody on neither side of it never saw the file at all');

    // NOTHING IS WRITTEN TO ENCOMPASS. The override sits BESIDE Encompass's own
    // column, which is left exactly as it was, so the file can keep showing both
    // sides and say plainly when they disagree.
    const { rows: after } = await ltDb.query(
      'SELECT staff_id, override_staff_id, override_by FROM lt_loan_contacts WHERE loan_id = $1::uuid AND role = $2',
      [loanId, 'loan_officer'],
    );
    eq(String(after[0].staff_id), named.id,
      'Encompass\'s own answer is untouched by the reassignment — PILOT writes nothing back and keeps both sides');
    eq(String(after[0].override_staff_id), movedTo.id, '…with the override recorded beside it');
    eq(String(after[0].override_by), admin.id, '…naming who made the decision, which is the audit half');

    // ── D. CLEARING IT GIVES THE FILE BACK ────────────────────────────────
    // An explicitly empty person is a CLEAR, and must not be read as "missing" —
    // a reassignment nobody can undo is a one-way door.
    const cleared = await call(
      'POST', `/api/lt/pipeline/${loanId}/contacts/loan_officer/override`, admin,
      { staffId: null, reason: 'back from leave' },
    );
    eq(cleared.status, 200, 'naming nobody CLEARS the reassignment rather than being read as a missing field');
    const backToNamed = await call('GET', `/api/lt/pipeline/${loanId}`, named);
    eq(backToNamed.status, 200, '…and the file returns to the person Encompass names');
    const movedNow = await call('GET', `/api/lt/pipeline/${loanId}`, movedTo);
    eq(movedNow.status, 404, '…and leaves the person it had been lent to');
  } finally {
    if (madeLoans.length) {
      await ltDb.query('DELETE FROM lt_loan_contacts WHERE loan_id = ANY($1::uuid[])', [madeLoans]).catch(() => {});
      await ltDb.query('DELETE FROM lt_loans WHERE id = ANY($1::uuid[])', [madeLoans]).catch(() => {});
    }
    if (madeBorrowers.length) {
      await db.query('DELETE FROM borrowers WHERE id = ANY($1::uuid[])', [madeBorrowers]).catch(() => {});
    }
    await db.query('DELETE FROM staff_users WHERE email LIKE $1', [`${stamp}%`]).catch(() => {});
    if (server) server.close();
    await db.pool.end().catch(() => {});
    await ltDb.pool.end().catch(() => {});
  }

  console.log(`\n✓ lt loan workspace (db): ${checks} assertions passed`);
}

main().catch((e) => {
  console.error('✗ lt loan workspace (db) FAILED');
  console.error(e);
  process.exit(1);
});
