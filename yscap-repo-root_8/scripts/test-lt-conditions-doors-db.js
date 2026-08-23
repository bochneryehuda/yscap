'use strict';
/**
 * PROOF, over real HTTP with the Condition Center SWITCHED ON, that its three
 * doors answer.
 *
 * WHY THIS SUITE EXISTS. Two of the three returned 500 for every loan, on every
 * request, from the day they shipped. `openable()` loaded the settings into its
 * own scope and returned the loan alone; the handlers for the CENTRE and for the
 * eFolder NEEDS LIST then passed a bare `settings` to their reader — a free
 * variable that did not exist there. Each threw a ReferenceError into its own
 * catch and answered `{"error":"server error"}`.
 *
 * It survived because the Condition Center ships OFF. With `conditions.enabled`
 * unset, `openable` answers `{enabled:false}` and returns before the broken line
 * is ever reached, so every existing test — and every human — saw the switched-off
 * path. The two dead doors were reachable only by the one tenant setting nobody
 * had turned on yet, which is to say: they would have failed on the day the owner
 * turned the feature on, and not one moment before.
 *
 * A test DID guard the broken line. `test-lt-settings-wired-pure.js` asserts that
 * `centerForLoan(loan.id, { audience: 'internal', settings })` appears in this
 * file — by regular expression, against the source text. It proved the characters
 * were present. It could not have noticed that the line throws, because it never
 * ran it. That is the difference this suite exists to close, and it is why every
 * assertion below goes through the actual door.
 *
 * DB-GATED: skips cleanly with no database, like every other suite in the chain.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const assert = require('assert');
const http = require('http');
const path = require('path');

async function main() {
  await require(path.join(__dirname, 'lib', 'db-gate')).skipUnlessDb('lt-conditions-doors');

  const app = require('../src/server');
  const C = require('../src/lib/crypto');
  const db = require('../src/db');
  const ltDb = require('../src/longterm/db');
  const settingsStore = require('../src/longterm/settings/store');

  let checks = 0;
  const ok = (c, w) => { assert.ok(c, w); checks++; };
  const eq = (a, b, w) => { assert.strictEqual(a, b, w); checks++; };

  const stamp = `ltcd-${Date.now().toString(36)}`;
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
  const setEnabled = async (on) => {
    if (on) {
      await ltDb.query(
        `INSERT INTO lt_settings (scope, key, value, updated_at)
         VALUES ('company', 'conditions.enabled', 'true'::jsonb, now())
         ON CONFLICT (scope, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`);
    } else {
      await ltDb.query(`DELETE FROM lt_settings WHERE scope = 'company' AND key = 'conditions.enabled'`);
    }
    settingsStore.bust();
  };

  try {
    const admin = await seedStaff('super_admin', 'LT Cond Admin');
    const stranger = await seedStaff('loan_officer', 'LT Cond Stranger');

    const { rows: ln } = await ltDb.query(
      `INSERT INTO lt_loans (id, loan_number, encompass_loan_guid, milestone_name, stage_key, loan_folder)
       VALUES (gen_random_uuid(), $1, $1, 'Processing', 'underwriting', 'Pipeline') RETURNING id`,
      [`${stamp}-1`]);
    const loanId = String(ln[0].id);
    madeLoans.push(loanId);
    const NO_LOAN = '00000000-0000-4000-8000-000000000000';

    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (p, who) => {
      const r = await fetch(base + p, { headers: { authorization: `Bearer ${who.token}` } });
      const raw = await r.text();
      let body = null;
      try { body = JSON.parse(raw); } catch (_) { body = null; }
      return { status: r.status, body, raw };
    };

    const DOORS = [
      ['the centre', `/api/lt/conditions/${loanId}`],
      ['the conditions', `/api/lt/conditions/${loanId}/conditions`],
      ['the eFolder needs list', `/api/lt/conditions/${loanId}/documents`],
    ];

    // ── A. SWITCHED OFF IS A STATE, NOT A FAILURE ─────────────────────────
    await setEnabled(false);
    for (const [what, door] of DOORS) {
      const r = await call(door, admin);
      eq(r.status, 200, `with the Condition Center off, ${what} answers 200 — a 404 would send the screen down its "something is broken" path for a deliberate configuration`);
      eq(r.body.enabled, false, `…saying plainly that it is off`);
      ok(r.body.why, '…and why, in words a person can read');
    }

    // ── B. THE ONE THAT MATTERS — SWITCHED ON, ALL THREE ANSWER ───────────
    // Two of these returned 500 on every request from the day they shipped, and
    // nothing noticed because nothing had ever turned the feature on.
    await setEnabled(true);
    for (const [what, door] of DOORS) {
      const r = await call(door, admin);
      eq(r.status, 200,
        `THE ONE THAT MATTERS: with the Condition Center ON, ${what} answers — this is the door that returned {"error":"server error"} for every loan, and it would have failed on the day the owner turned the feature on and not one moment before`);
      eq(r.body.enabled, true, `…and reports itself enabled`);
      ok(!r.body.error, `…with no error hidden in the body`);
    }

    // Each door carries the half it exists for, so "answers 200" is not the claim.
    const centre = (await call(`/api/lt/conditions/${loanId}`, admin)).body;
    eq(centre.loanId, loanId, 'the centre names the loan it is for');
    eq(centre.loanNumber, `${stamp}-1`, '…by number, which is what a human recognises');
    const conds = (await call(`/api/lt/conditions/${loanId}/conditions`, admin)).body;
    ok(Array.isArray(conds.items) && typeof conds.open === 'number' && typeof conds.total === 'number',
      'the conditions door carries the items and both counts');
    const docs = (await call(`/api/lt/conditions/${loanId}/documents`, admin)).body;
    ok(Array.isArray(docs.items) && typeof docs.outstanding === 'number' && typeof docs.total === 'number',
      'the eFolder door carries the needs list and its outstanding count');

    // ── C. THE ACCESS RULE HOLDS ON ALL THREE ─────────────────────────────
    // Same rule as the loan workspace: a file you may not see is answered exactly
    // as one that does not exist.
    for (const [what, door] of DOORS) {
      const forbidden = await call(door, stranger);
      const missing = await call(door.replace(loanId, NO_LOAN), stranger);
      eq(forbidden.raw, missing.raw,
        `${what}: a file that is not yours answers exactly as one that does not exist, byte for byte — a different answer would turn the loan-id space into an oracle`);
      eq(forbidden.status, 404, '…and that shared answer is the missing-file one');
    }
  } finally {
    await setEnabled(false).catch(() => {});
    if (madeLoans.length) {
      await ltDb.query('DELETE FROM lt_loans WHERE id = ANY($1::uuid[])', [madeLoans]).catch(() => {});
    }
    await db.query('DELETE FROM staff_users WHERE email LIKE $1', [`${stamp}%`]).catch(() => {});
    if (server) server.close();
    await Promise.race([
      Promise.all([db.pool.end().catch(() => {}), ltDb.pool.end().catch(() => {})]),
      new Promise((r) => setTimeout(r, 3000).unref()),
    ]);
  }

  console.log(`\n✓ lt conditions doors (db): ${checks} assertions passed`);
}

main().catch((e) => {
  console.error('✗ lt conditions doors (db) FAILED');
  console.error(e);
  process.exit(1);
});
