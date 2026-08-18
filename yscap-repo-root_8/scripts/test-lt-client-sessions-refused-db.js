'use strict';
/**
 * PROOF that the long-term surface refuses the two CLIENT session kinds — a
 * borrower and a TPO (an outside broker) — on every door it has.
 *
 * WHY THIS SUITE EXISTS. The owner's hardest rule, in his own words
 * (2026-08-14, recorded at the top of src/longterm/audience.js):
 *
 *   "The client should not be able to see the investor name. Never ever! Not
 *    borrowers, not TPOs, only internal staff."
 *
 * The long-term side carries the investor in several places — the file screen's
 * investor section, the pricer's disqualified payload, lt_loan_investors. What
 * keeps a client away from ALL of them is not any of that code: it is ONE
 * expression at the mount seam in src/server.js, `requireStaff`, which is
 * `req.actor.kind === 'staff'`.
 *
 * That expression lives in RTL code, and a TPO IS A REAL staff_users ROW — it is
 * only the session `kind` that separates them. "A TPO is a staff row, so let it
 * through requireStaff" is a plausible-looking refactor somebody could make in
 * good faith, and if they did, every long-term door would open to an outside
 * broker and the investor name would go with them.
 *
 * `test-lt-investor-block.js` proves the SCRUBBER — the backstop for free text a
 * human typed. It does not prove the DOOR. And the smoke suite proves only that
 * an ANONYMOUS caller is refused, which is the easy case: a session with no
 * identity at all. The two kinds that carry a real, valid, signed session and
 * still must not pass had never been pointed at this surface by anything.
 *
 * THE SUITE IS DELIBERATELY TWO-SIDED. A suite that only asserted refusals would
 * stay green if the whole application stopped answering, so every refusal here
 * is paired with the door that SAME session is supposed to open:
 *   · a staff session gets through the long-term mount;
 *   · a borrower session gets through /api/lt/my, the client-facing half;
 *   · a TPO session gets through /api/tpo, its own front door.
 *
 * DB-GATED: skips cleanly with no database, like every other suite in the chain.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const assert = require('assert');
const http = require('http');
const path = require('path');

async function main() {
  await require(path.join(__dirname, 'lib', 'db-gate')).skipUnlessDb('lt-client-sessions');

  const app = require('../src/server');
  const C = require('../src/lib/crypto');
  const auth = require('../src/auth');
  const db = require('../src/db');

  let checks = 0;
  const ok = (c, w) => { assert.ok(c, w); checks++; };
  const eq = (a, b, w) => { assert.strictEqual(a, b, w); checks++; };

  const stamp = `ltclient-${Date.now().toString(36)}`;
  let server = null;
  const madeBorrowers = [];

  try {
    // ── The three session kinds this application has ────────────────────────
    const { rows: st } = await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active)
       VALUES ($1, 'LT Wall Staff', 'super_admin', true) RETURNING id, token_version`,
      [`${stamp}-staff@example.test`],
    );
    const staffTok = C.signJwt({ sub: String(st[0].id), kind: 'staff', role: 'super_admin', tv: st[0].token_version, sid: stamp });

    // A TPO is a REAL staff_users row — external, at a firm — and differs from the
    // staff member above ONLY in the `kind` its session carries. That is precisely
    // what makes the wall worth pinning.
    const { rows: firm } = await db.query(
      'INSERT INTO tpo_firms (name) VALUES ($1) RETURNING id', [`${stamp} Brokerage`],
    );
    const { rows: tp } = await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, is_external, tpo_firm_id)
       VALUES ($1, 'LT Wall Broker', 'tpo_officer', true, true, $2::uuid)
       RETURNING id, token_version`,
      [`${stamp}-tpo@example.test`, firm[0].id],
    );
    const tpoTok = C.signJwt({ sub: String(tp[0].id), kind: 'tpo', role: 'tpo_officer', tv: tp[0].token_version, sid: stamp });

    const { rows: bor } = await db.query(
      `INSERT INTO borrowers (first_name, last_name, email) VALUES ($1, 'Wall', $2) RETURNING id`,
      [stamp, `${stamp}-borrower@example.test`],
    );
    madeBorrowers.push(bor[0].id);
    // A REAL, LIVE borrower session — a login row and this borrower's CURRENT
    // token_version, minted the way the application mints one. The first cut of
    // this suite signed a token for a borrower with no login row, and every
    // refusal below went green because the session was REVOKED rather than
    // because a borrower is refused at a staff door. A wall that has only ever
    // been knocked on with a dead key has not been tested.
    await db.query(
      `INSERT INTO borrower_auth (borrower_id, password_hash, email_verified)
       VALUES ($1::uuid, 'x', true)
       ON CONFLICT (borrower_id) DO NOTHING`,
      [bor[0].id],
    );
    const borrowerTok = await auth.mintBorrowerSession(String(bor[0].id));
    ok(!!borrowerTok, 'the borrower session was really minted, so the refusals below are about the KIND and not a dead key');

    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    const call = async (p, tok, method = 'GET') => {
      const res = await fetch(base + p, {
        method,
        headers: tok ? { authorization: `Bearer ${tok}` } : {},
      });
      const raw = await res.text();
      let body = null;
      try { body = JSON.parse(raw); } catch (_) { body = null; }
      return { status: res.status, body, raw };
    };

    const NO_LOAN = '00000000-0000-4000-8000-000000000000';

    /**
     * Every long-term door, listed BY HAND rather than derived from the routers —
     * the point is to notice a door nobody listed, and a list derived from what the
     * application mounts would agree with whatever is there, including nothing.
     * The count below is asserted so this list cannot quietly shrink either.
     */
    const DOORS = [
      '/api/lt/health',
      '/api/lt/pipeline',
      `/api/lt/pipeline/${NO_LOAN}`,
      '/api/lt/book',
      '/api/lt/views',
      '/api/lt/people',
      '/api/lt/borrowers',
      '/api/lt/stages',
      '/api/lt/settings',
      '/api/lt/settings/me',
      '/api/lt/sync',
      '/api/lt/me',
      `/api/lt/conditions/${NO_LOAN}`,
      '/api/lt/encompass/milestones',
      '/api/lt/encompass/summary',
      '/api/lt/encompass/fields',
      '/api/lt/encompass/status',
      '/api/lt/encompass/terms',
      '/api/lt/encompass/programs',
      // The two that carry the investor most directly: the pricer's disqualified
      // payload names the investor per lender, and the PPE reads the same registry.
      '/api/lt/dscr/health',
      '/api/lt/ppe/health',
      '/api/lt/ppe/investors',
    ];
    // A guard on THIS FILE rather than on the application — no change to the
    // product can turn it red. It is here because the cheapest way to make this
    // suite pass is to delete the door that fails, and a list that can quietly
    // shrink proves less every time somebody is in a hurry.
    ok(DOORS.length >= 22, 'the door list is still the whole long-term surface rather than a sample somebody trimmed');

    // ── A. THE POSITIVE CONTROL ───────────────────────────────────────────
    // Without this, everything below would stay green if the application had
    // simply stopped answering.
    const staffIn = await call('/api/lt/health', staffTok);
    eq(staffIn.status, 200, 'a STAFF session opens the long-term side — the refusals below are about the session kind, not a broken fixture');

    // ── B. A BORROWER IS REFUSED AT EVERY DOOR ────────────────────────────
    const borrowerLetIn = [];
    for (const door of DOORS) {
      const r = await call(door, borrowerTok);
      if (r.status !== 401 && r.status !== 403) borrowerLetIn.push(`${door} → ${r.status}`);
    }
    eq(borrowerLetIn.length, 0,
      `THE ONE THAT MATTERS: a signed-in BORROWER is refused at every long-term door${borrowerLetIn.length ? `:\n       ${borrowerLetIn.join('\n       ')}` : ''}`);

    // ── C. A TPO IS REFUSED AT EVERY DOOR ─────────────────────────────────
    // The one the owner named twice. A TPO session is a real staff_users row and
    // differs from the staff session above only in its `kind`.
    const tpoLetIn = [];
    for (const door of DOORS) {
      const r = await call(door, tpoTok);
      if (r.status !== 401 && r.status !== 403) tpoLetIn.push(`${door} → ${r.status}`);
    }
    eq(tpoLetIn.length, 0,
      `THE ONE THAT MATTERS: an outside BROKER is refused at every long-term door — "Never ever! Not borrowers, not TPOs, only internal staff"${tpoLetIn.length ? `:\n       ${tpoLetIn.join('\n       ')}` : ''}`);

    // A refusal must be a refusal, not a payload with a sad status on it.
    for (const [who, tok] of [['borrower', borrowerTok], ['broker', tpoTok]]) {
      const r = await call('/api/lt/pipeline', tok);
      ok(!(r.body && r.body.loans),
        `and the ${who}'s refusal carries no book with it — a 403 with the loans attached is not a refusal`);
      ok(!(r.body && r.body.columns),
        `…nor the columns that describe it, which would tell a ${who} what our pipeline tracks`);
    }

    // ── D. THE MIRROR IMAGE, SO THIS IS A WALL AND NOT A BLANKET NO ───────
    // Each client kind opens its OWN door. Without these three, a build in which
    // nothing worked at all would pass every assertion above.
    const borrowerOwn = await call('/api/lt/my/loans', borrowerTok);
    ok(borrowerOwn.status !== 401 && borrowerOwn.status !== 403,
      'a borrower DOES reach their own long-term door (/api/lt/my/loans) — the client-facing half of the owner\'s switch, so the wall above is a wall and not a blanket no');
    const staffOnBorrowerDoor = await call('/api/lt/my/loans', staffTok);
    ok(staffOnBorrowerDoor.status === 401 || staffOnBorrowerDoor.status === 403,
      '…and it is a borrower door specifically: a staff session does not reach it either, so each front door admits exactly one kind');
    const tpoOwn = await call('/api/tpo/me', tpoTok);
    ok(tpoOwn.status !== 401 && tpoOwn.status !== 403,
      'and a broker DOES reach the TPO portal, so their refusal above is about WHICH surface rather than a dead session');
    const staffOnTpoDoor = await call('/api/tpo/me', staffTok);
    ok(staffOnTpoDoor.status === 401 || staffOnTpoDoor.status === 403,
      '…which a staff session does not, completing the three-way separation');

    // ── E. AND NO SESSION AT ALL ──────────────────────────────────────────
    const anon = await call('/api/lt/pipeline', null);
    ok(anon.status === 401 || anon.status === 403, 'a caller with no session is refused, as before');
  } finally {
    await db.query('DELETE FROM staff_users WHERE email LIKE $1', [`${stamp}%`]).catch(() => {});
    if (madeBorrowers.length) {
      await db.query('DELETE FROM borrowers WHERE id = ANY($1::uuid[])', [madeBorrowers]).catch(() => {});
    }
    await db.query('DELETE FROM tpo_firms WHERE name LIKE $1', [`${stamp}%`]).catch(() => {});
    if (server) server.close();
    await db.pool.end().catch(() => {});
  }

  console.log(`\n✓ lt client sessions refused (db): ${checks} assertions passed`);
}

main().catch((e) => {
  console.error('✗ lt client sessions refused (db) FAILED');
  console.error(e);
  process.exit(1);
});
