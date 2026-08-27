#!/usr/bin/env node
'use strict';
/**
 * LT test — INVESTOR GROUPS + the white-label roster, against a real database,
 * over real HTTP (owner-directed 2026-08-27; db/634).
 *
 * What matters most here:
 *   • a group is PERSONAL — one person's groups are invisible to the next, and
 *     a delete of somebody else's answers 404, not a delete;
 *   • the same NAME is an EDIT, never a twin a picker cannot tell apart;
 *   • a key the white-label sheet does not carry is REFUSED BY NAME (`dropped`),
 *     never stored and never silently missing;
 *   • the roster endpoint serves the whole sheet — the not-yet-live investors
 *     included — behind the staff gate;
 *   • none of it exists on the secret diagnostics mount, where there is no
 *     signed-in person to own a group.
 *
 * Requires DATABASE_URL with migrations applied. Skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) {
  console.log('SKIP test-lt-pricer-groups-db (no DATABASE_URL)');
  process.exit(0);
}
process.env.JWT_SECRET = process.env.JWT_SECRET || 'lt-pricer-groups-test-secret';

const db = require('../src/db');
const auth = require('../src/auth');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

const made = { staff: [] };

(async () => {
  const app = require('../src/server');
  // The server kicks its migrations off asynchronously — a suite that writes
  // straight away races a brand-new table into existence (the standing lesson).
  await require('../src/migrate-boot').ensureSchema();
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const stamp = `ltig${Date.now()}`;

  const call = async (method, path, token, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    return { status: res.status, json };
  };

  try {
    console.log('LT — investor groups + the white-label roster (db/634)');

    const { rows: people } = await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active)
            VALUES ($1, 'Group Officer', 'loan_officer', true),
                   ($2, 'Other Officer', 'loan_officer', true)
         RETURNING id, full_name`,
      [`${stamp}.one@example.test`, `${stamp}.two@example.test`],
    );
    made.staff = people.map((p) => p.id);
    const one = people.find((p) => p.full_name === 'Group Officer');
    const two = people.find((p) => p.full_name === 'Other Officer');
    const tokOne = await auth.mintStaffSession(one.id);
    const tokTwo = await auth.mintStaffSession(two.id);

    // ── the table itself, per db/634 ─────────────────────────────────────────
    const { rows: cols } = await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'lt_pricer_investor_groups'`,
    );
    const colSet = new Set(cols.map((c) => c.column_name));
    check(['id', 'staff_id', 'name', 'investors', 'sort_order', 'created_at', 'updated_at']
      .every((c) => colSet.has(c)), 'db/634 built the table with every declared column');

    // ── the roster ───────────────────────────────────────────────────────────
    const roster = await call('GET', '/api/lt/dscr/investors', tokOne);
    check(roster.status === 200 && Array.isArray(roster.json.investors) && roster.json.investors.length === 24,
      `the roster serves the whole white-label sheet (${roster.json.investors ? roster.json.investors.length : 0} of 24)`);
    check(roster.json.investors.some((r) => r.key === 'corrfirst' && r.whiteLabel === 'Prime'),
      '…including an investor not yet live in Lender Price — "when they come up, they should be there"');
    const noAuth = await call('GET', '/api/lt/dscr/investors', null);
    check(noAuth.status === 401 || noAuth.status === 403,
      `…and it sits behind the staff gate (${noAuth.status} without a session)`);

    // ── groups: the empty start, the refusals, the save ──────────────────────
    const empty = await call('GET', '/api/lt/dscr/investor-groups', tokOne);
    check(empty.status === 200 && Array.isArray(empty.json.groups) && empty.json.groups.length === 0,
      'a fresh person has no groups');

    const noName = await call('POST', '/api/lt/dscr/investor-groups', tokOne, { name: '  ', investors: ['verus'] });
    check(noName.status === 400, 'a group with no name is refused with a reason');
    const nobody = await call('POST', '/api/lt/dscr/investor-groups', tokOne, { name: 'Empty', investors: [] });
    check(nobody.status === 400, 'a group of NOBODY is refused — it would filter the board to nothing');
    const junkOnly = await call('POST', '/api/lt/dscr/investor-groups', tokOne, { name: 'Junk', investors: ['not_a_key'] });
    check(junkOnly.status === 400, 'a group of only unknown keys is refused too');

    const saved = await call('POST', '/api/lt/dscr/investor-groups', tokOne,
      { name: 'My Three', investors: ['verus', 'deephaven', 'acra', 'ghost_key', 'verus'] });
    check(saved.status === 200 && saved.json.ok === true, 'a real group saves');
    check(JSON.stringify(saved.json.investors) === JSON.stringify(['verus', 'deephaven', 'acra']),
      '…keeping the valid keys once each, in the order the person arranged them');
    check(Array.isArray(saved.json.dropped) && saved.json.dropped.includes('ghost_key'),
      '…and NAMING the refused key — never silently missing');

    // ── the same NAME is an edit, case-insensitively ─────────────────────────
    const again = await call('POST', '/api/lt/dscr/investor-groups', tokOne,
      { name: 'my three', investors: ['pennymac'] });
    check(again.status === 200, 'saving the same name again succeeds');
    const listOne = await call('GET', '/api/lt/dscr/investor-groups', tokOne);
    check(listOne.json.groups.length === 1
      && JSON.stringify(listOne.json.groups[0].investors) === JSON.stringify(['pennymac']),
    '…as an EDIT of the one group, never a twin ("My Three" and "my three" are the same name to a human)');

    // ── personal means personal ──────────────────────────────────────────────
    const listTwo = await call('GET', '/api/lt/dscr/investor-groups', tokTwo);
    check(listTwo.status === 200 && listTwo.json.groups.length === 0,
      'the second person sees NONE of the first person\'s groups');
    const stealDelete = await call('DELETE', `/api/lt/dscr/investor-groups/${listOne.json.groups[0].id}`, tokTwo);
    check(stealDelete.status === 404, 'deleting somebody else\'s group answers 404 — not theirs to remove');

    const ownDelete = await call('DELETE', `/api/lt/dscr/investor-groups/${listOne.json.groups[0].id}`, tokOne);
    check(ownDelete.status === 200, 'the owner removes their own group');
    const after = await call('GET', '/api/lt/dscr/investor-groups', tokOne);
    check(after.json.groups.length === 0, '…and it is gone');

    // ── no session, no groups ────────────────────────────────────────────────
    const anon = await call('GET', '/api/lt/dscr/investor-groups', null);
    check(anon.status === 401 || anon.status === 403, `no session is refused (${anon.status})`);

    // ── the diagnostics mount carries NO group door ──────────────────────────
    // makeRouter is what the secret seam mounts; the groups router must not be
    // inside it, or a diag token would reach a person-owned store with nobody
    // signed in. Asserted structurally: the dscr router has no such route.
    const dscr = require('../src/longterm/routes/dscr-pricer');
    const stack = dscr.makeRouter().stack.map((l) => (l.route && l.route.path) || '').filter(Boolean);
    check(!stack.some((p) => /investor-groups/.test(p)),
      `the diagnostics-mountable router carries no group route (${stack.join(', ')})`);
    check(stack.includes('/investors'), '…while the roster read IS there — it is a read of a committed sheet');
  } catch (e) {
    failures += 1;
    console.error('  FAIL suite threw:', (e && e.stack) || e);
  } finally {
    try {
      if (made.staff.length) {
        await db.query('DELETE FROM lt_pricer_investor_groups WHERE staff_id = ANY($1::uuid[])', [made.staff]);
        await db.query('DELETE FROM staff_users WHERE id = ANY($1::uuid[])', [made.staff]);
      }
    } catch (e) { console.error('  cleanup failed:', (e && e.message) || e); }
    process.exit(failures ? 1 : 0);
  }
})();
