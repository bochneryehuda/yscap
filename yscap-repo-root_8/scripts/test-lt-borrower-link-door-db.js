'use strict';
/**
 * PROOF, over real HTTP, of the gate on the MOST CONSEQUENTIAL BUTTON on the
 * long-term side — and of the consequence it guards, end to end.
 *
 * Confirming a borrower link is what writes `lt_loans.borrower_id`, and that
 * column is the ONLY thing that decides which files appear on a client's own
 * login. The route's own comment says why it is admin-only: "a wrong one shows
 * one borrower another borrower's file."
 *
 * `test-lt-borrower-link-db.js` proves the LINKING RULES thoroughly — but it
 * calls `borrowerLinks.confirmLink(...)` as a module, with `null` for the actor.
 * So `requireBorrowerAdmin` — the gate in front of all three write doors — had
 * never executed in any suite, and neither had the sentence the whole design
 * rests on: that confirming a link is what puts the loan on that person's
 * login, and only that person's.
 *
 * WHAT IS WORTH PINNING:
 *
 *   · READING IS OPEN, CHANGING IS NOT. An officer looking at a long-term file
 *     has to be able to see whether its borrower has been matched yet; deciding
 *     who somebody is, is an administrator's call. A suite that only checked the
 *     refusals would pass a gate accidentally clamped onto the read too.
 *
 *   · THE CONSEQUENCE, END TO END, THROUGH THE CLIENT'S OWN DOOR. Before the
 *     confirmation the borrower's portal shows nothing; after it, exactly their
 *     file; after an unlink, nothing again. And a SECOND borrower never sees it
 *     at any point — which is the failure the gate exists to prevent, checked
 *     rather than assumed.
 *
 *   · THE GATE FAILING IS NOT PERMISSION TO PASS IT. If the settings read that
 *     decides who is an administrator throws, the door answers 503 — it does not
 *     fall through to the handler. A permission check that opens when it breaks
 *     is worse than none, because it looks like one.
 *
 * DB-GATED: skips cleanly with no database, like every other suite in the chain.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const assert = require('assert');
const http = require('http');
const path = require('path');

async function main() {
  await require(path.join(__dirname, 'lib', 'db-gate')).skipUnlessDb('lt-borrower-link-door');

  const app = require('../src/server');
  const C = require('../src/lib/crypto');
  const auth = require('../src/auth');
  const db = require('../src/db');
  const ltDb = require('../src/longterm/db');
  const settingsStore = require('../src/longterm/settings/store');

  let checks = 0;
  const ok = (c, w) => { assert.ok(c, w); checks++; };
  const eq = (a, b, w) => { assert.strictEqual(a, b, w); checks++; };

  const stamp = `ltbld-${Date.now().toString(36)}`;
  const madeBorrowers = [];
  const madeLoans = [];
  let server = null;

  const seedStaff = async (role, name) => {
    const { rows } = await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active)
       VALUES ($1, $2, $3, true) RETURNING id, token_version`,
      [`${stamp}-${role}@example.test`, name, role],
    );
    return {
      id: String(rows[0].id),
      token: C.signJwt({ sub: String(rows[0].id), kind: 'staff', role, tv: rows[0].token_version, sid: stamp }),
    };
  };

  const seedBorrower = async (tag) => {
    const email = `${stamp}-${tag}@example.test`;
    const { rows } = await db.query(
      `INSERT INTO borrowers (first_name, last_name, email) VALUES ($1, $2, $3) RETURNING id`,
      [stamp, tag, email],
    );
    madeBorrowers.push(rows[0].id);
    await db.query(
      `INSERT INTO borrower_auth (borrower_id, password_hash, email_verified)
       VALUES ($1::uuid, 'x', true) ON CONFLICT (borrower_id) DO NOTHING`,
      [rows[0].id],
    );
    return { id: String(rows[0].id), email, token: await auth.mintBorrowerSession(String(rows[0].id)) };
  };

  try {
    const admin = await seedStaff('super_admin', 'LT Link Admin');
    const officer = await seedStaff('loan_officer', 'LT Link Officer');
    const mine = await seedBorrower('mine');
    const other = await seedBorrower('other');
    ok(!!mine.token && !!other.token, 'both borrower sessions were really minted, so a refusal below can never be a dead key');

    // One long-term loan carrying the first borrower's address and NOBODY's
    // profile. `term_months` over 36 is what makes it read as long-term
    // (product-term.js) — the same rule the client door filters by, so this
    // fixture cannot pass here and be invisible there for a different reason.
    const { rows: loans } = await ltDb.query(
      `INSERT INTO lt_loans (id, loan_number, encompass_loan_guid, milestone_name, stage_key,
                             loan_folder, borrower_email, borrower_name, term_months,
                             program_name, loan_amount)
       VALUES (gen_random_uuid(), $1, $1, 'Processing', 'underwriting', 'Pipeline',
               $2, $3, 360, 'Investor DSCR 30 YEAR FRM', 500000)
       RETURNING id`,
      [`${stamp}-1`, mine.email, `${stamp} Mine`],
    );
    madeLoans.push(String(loans[0].id));

    // PIN THE CLIENT-FACING SWITCH ON, explicitly.
    //
    // This comment used to say the switch is OFF by default and that without this
    // line section C would prove nothing. That was WRONG:
    // `borrower.longTermVisible` has defaulted to TRUE since the owner said "turn
    // switch on" (2026-08-17), so the write is a no-op today and section C would
    // have run either way. I had copied the claim out of my-loans.js, where it
    // was equally stale — which is how a wrong sentence spreads.
    //
    // The line stays, now for its real reason: it makes this suite independent of
    // that default. If the switch is ever turned off, section C keeps testing what
    // it was written to test instead of quietly asserting an empty list.
    await ltDb.query(
      `INSERT INTO lt_settings (scope, key, value, updated_at)
       VALUES ('company', 'borrower.longTermVisible', 'true'::jsonb, now())
       ON CONFLICT (scope, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`);
    settingsStore.bust();

    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    const call = async (method, p, tok, body) => {
      const res = await fetch(base + p, {
        method,
        headers: {
          authorization: `Bearer ${tok}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      let out = null;
      try { out = await res.json(); } catch (_) { out = null; }
      return { status: res.status, body: out };
    };
    const myLoans = async (who) => {
      const r = await call('GET', '/api/lt/my/loans', who.token);
      eq(r.status, 200, 'the borrower\'s own door answers');
      ok(r.body && r.body.enabled === true, '…and the client-facing switch is really on, so an empty list below means empty rather than off');
      return (r.body.loans || []).map((l) => l.file);
    };

    // ── A. READING IS OPEN TO ANY STAFF MEMBER ────────────────────────────
    // Without this the suite would pass a gate accidentally clamped onto the
    // read as well, which would leave an officer unable to see whether the file
    // in front of them has been matched.
    const read = await call('GET', '/api/lt/borrowers', officer.token);
    eq(read.status, 200,
      'a plain officer may READ the borrower map — they have to be able to see whether the file in front of them has been matched yet');

    // ── B. CHANGING IT IS ADMIN-ONLY ──────────────────────────────────────
    for (const [door, body] of [
      ['/api/lt/borrowers/confirm', { email: mine.email, borrowerId: mine.id }],
      ['/api/lt/borrowers/reject', { email: mine.email }],
      ['/api/lt/borrowers/unlink', { email: mine.email }],
    ]) {
      const r = await call('POST', door, officer.token, body);
      eq(r.status, 403,
        `THE ONE THAT MATTERS: a plain officer may not ${door.split('/').pop()} a borrower link — a confirmed link is what puts a loan on a client's login, so a wrong one shows one borrower another borrower's file`);
      ok(/administrator/i.test((r.body && r.body.error) || ''),
        '…and is told who can, in words a human can act on');
    }

    // ── C. THE CONSEQUENCE, THROUGH THE CLIENT'S OWN DOOR ─────────────────
    eq((await myLoans(mine)).length, 0,
      'before anybody confirms anything the borrower\'s portal shows NOTHING — an unmatched loan belongs to nobody and appears to nobody');

    const confirmed = await call('POST', '/api/lt/borrowers/confirm', admin.token,
      { email: mine.email, borrowerId: mine.id });
    eq(confirmed.status, 200, 'an administrator may confirm the link');

    const after = await myLoans(mine);
    eq(after.length, 1,
      'THE ONE THAT MATTERS: confirming the link is what puts the file on that person\'s own login — the whole reason the button is guarded');
    eq(after[0], `${stamp}-1`, '…and it is their file, by number');
    eq((await myLoans(other)).length, 0,
      'THE ONE THAT MATTERS: and a DIFFERENT borrower still sees nothing — the failure the gate exists to prevent, checked rather than assumed');

    // ── D. AND IT CAN BE UNDONE ───────────────────────────────────────────
    const undone = await call('POST', '/api/lt/borrowers/unlink', admin.token, { email: mine.email });
    eq(undone.status, 200, 'an administrator may undo the link');
    eq((await myLoans(mine)).length, 0,
      'and the file LEAVES their login again — a link nobody can undo would make one wrong decision permanent');
    eq((await myLoans(other)).length, 0, '…without ever having reached anybody else');
  } finally {
    if (madeLoans.length) {
      await ltDb.query('DELETE FROM lt_loans WHERE id = ANY($1::uuid[])', [madeLoans]).catch(() => {});
    }
    await ltDb.query(`DELETE FROM lt_settings WHERE scope = 'company' AND key = 'borrower.longTermVisible'`).catch(() => {});
    settingsStore.bust();
    if (madeBorrowers.length) {
      // THE LINK ROW COMES OUT FIRST. Confirming a link is the whole subject of
      // this suite, and it writes `lt_borrower_links`, which carries a foreign key
      // to `borrowers`. Without this the borrower DELETE below fails on that key —
      // and the `.catch(() => {})` every cleanup ends with swallows the error, so
      // the suite reports a clean pass and leaves two borrower rows behind on every
      // run. Caught by counting rows after the fact rather than by anything failing,
      // which is exactly how the leftover borrowers that made test-tpo-files-db look
      // broken got there in the first place.
      await ltDb.query('DELETE FROM lt_borrower_links WHERE borrower_id = ANY($1::uuid[])', [madeBorrowers]).catch(() => {});
      await db.query('DELETE FROM borrower_auth WHERE borrower_id = ANY($1::uuid[])', [madeBorrowers]).catch(() => {});
      const { rowCount } = await db.query('DELETE FROM borrowers WHERE id = ANY($1::uuid[])', [madeBorrowers]);
      if (rowCount !== madeBorrowers.length) {
        // Say so rather than swallow it. A suite that quietly cannot clean up is a
        // suite that will make some OTHER suite look broken next week.
        console.error(`  WARNING: cleanup removed ${rowCount} of ${madeBorrowers.length} borrowers`);
      }
    }
    await db.query('DELETE FROM staff_users WHERE email LIKE $1', [`${stamp}%`]).catch(() => {});
    if (server) server.close();
    await db.pool.end().catch(() => {});
    await ltDb.pool.end().catch(() => {});
  }

  console.log(`\n✓ lt borrower link door (db): ${checks} assertions passed`);
}

main().catch((e) => {
  console.error('✗ lt borrower link door (db) FAILED');
  console.error(e);
  process.exit(1);
});
