'use strict';
/**
 * PROOF, against a real Postgres, of the pass that PROPOSES who somebody is — and
 * of the one line that stops it deciding.
 *
 * `people/roster.js syncRoster` mirrors the Encompass user list and proposes
 * matches against PILOT's own people. `people/links.js` then lets an admin confirm
 * one, and a confirmed link decides whose pipeline every long-term file lands in.
 * The owner-directed shape is **auto-match by email, admin confirms** — so the
 * whole safety of the people map rests on the proposer never overwriting a
 * decision a human already made.
 *
 * THAT RULE IS ENFORCED TWICE, AND BOTH HALVES ARE ASKED HERE — separately,
 * because the first cut of this suite could not tell them apart. `matchRoster`
 * refuses to PROPOSE for a login already decided, and `writeSuggestions` refuses
 * to WRITE over one (`WHERE lt_staff_links.status = 'suggested'`). Running the
 * whole pass only ever exercises the first: the proposal never reaches the second,
 * so removing that WHERE clause left this suite green until the inner writer was
 * called directly. A belt-and-braces guard that no test can reach is decoration,
 * and a suite that claims to protect one is worse than one that admits it does
 * not. A coverage sweep of all 122 long-term suites found this module never
 * executed at all, so neither half had ever been tested.
 *
 * The other half is the deactivation guard: a roster read that comes back empty is
 * an outage, not the entire company resigning. `writeRoster` only ever deactivates
 * against a roster it actually read, and `syncRoster` refuses an empty one outright
 * — and NOTHING here is ever deleted (charter rule 2), only deactivated.
 *
 * The Encompass client is stubbed through `require.cache`; the database is real,
 * because what is being proven is what lands in it.
 *
 * DB-GATED: skips cleanly with no database, like every other suite in the chain.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const assert = require('assert');

async function main() {
  await require(__dirname + '/lib/db-gate').skipUnlessDb('lt-roster-sync');

  const CLIENT = require.resolve('../src/longterm/encompass/client');
  const stub = { configured: true, users: [], throws: null };
  require.cache[CLIENT] = {
    id: CLIENT, filename: CLIENT, loaded: true,
    exports: {
      configured: () => stub.configured,
      apiGet: async () => {
        if (stub.throws) throw new Error(stub.throws);
        return stub.users;          // one page; fewer than PAGE ends the loop
      },
    },
  };

  const db = require('../src/longterm/db');
  const roster = require('../src/longterm/people/roster');

  let checks = 0;
  const ok = (c, w) => { assert.ok(c, w); checks++; };
  const eq = (a, b, w) => { assert.strictEqual(a, b, w); checks++; };

  const tag = `rs-${Date.now().toString(36)}`;
  const login = (n) => `${tag}-${n}`;
  const staffIds = [];

  const encUser = (n, email) => ({
    id: login(n), userId: login(n), fullName: `Person ${n}`, email,
    lastName: `${n}`, firstName: 'Person', personas: [], roles: [], working: true,
  });
  const seedStaff = async (name, email) => {
    const { rows } = await db.query(
      `INSERT INTO staff_users (id, email, full_name, role, is_active)
       VALUES (gen_random_uuid(), $1, $2, 'loan_officer', true) RETURNING id`,
      [email, name],
    );
    staffIds.push(rows[0].id);
    return rows[0].id;
  };
  const linkRow = async (n) => (await db.query(
    'SELECT * FROM lt_staff_links WHERE encompass_login_id = $1', [login(n)])).rows[0] || null;
  const userRow = async (n) => (await db.query(
    'SELECT * FROM lt_encompass_users WHERE login_id = $1', [login(n)])).rows[0] || null;

  try {
    const mail1 = `${tag}-one@example.com`;
    const person1 = await seedStaff('Person 1', mail1);
    const person2 = await seedStaff('Person 2', `${tag}-two@example.com`);

    // ── A. REFUSALS ARE SENTENCES ─────────────────────────────────────────
    stub.configured = false;
    const unconfigured = await roster.syncRoster();
    eq(unconfigured.ok, false, 'with no Encompass credentials the roster pass does not run');
    ok(/not connected yet/i.test(unconfigured.reason || ''), '…and says so in words');
    stub.configured = true;

    stub.throws = 'roster endpoint exploded';
    const broke = await roster.syncRoster();
    eq(broke.ok, false, 'a roster read that fails ends the pass');
    ok(/could not read the encompass roster/i.test(broke.reason || ''), '…naming what went wrong');
    stub.throws = null;

    // ── B. AN EMPTY ROSTER IS AN OUTAGE, NOT A RESIGNATION ────────────────
    stub.users = [];
    const empty = await roster.syncRoster();
    eq(empty.ok, false,
      'THE ONE THAT MATTERS: an empty roster is REFUSED — treating it as "everybody left" would deactivate the whole company');
    ok(/no users/i.test(empty.reason || ''), '…and says nothing was changed');

    // ── C. THE MIRROR AND THE PROPOSAL ────────────────────────────────────
    stub.users = [encUser(1, mail1), encUser(2, `${tag}-nobody@example.com`)];
    const ran = await roster.syncRoster();
    eq(ran.ok, true, 'a real roster read succeeds');
    ok(ran.users >= 2, '…mirroring the Encompass users');
    ok(await userRow(1), 'the login is in the people mirror');

    const proposed = await linkRow(1);
    ok(proposed, 'and the login whose email matches a PILOT person gets a proposal');
    eq(proposed.status, 'suggested',
      'THE ONE THAT MATTERS: the machine only ever SUGGESTS — the owner-directed shape is auto-match by email, admin confirms');
    eq(String(proposed.staff_id), String(person1), '…pointing at the person it matched');
    eq(await linkRow(2), null, 'while a login matching nobody is left alone rather than guessed at');

    // ── D. A DECISION A HUMAN MADE IS NEVER OVERWRITTEN ───────────────────
    //
    // This is the whole safety of the people map, and it is one WHERE clause.
    await db.query(
      `UPDATE lt_staff_links SET status = 'confirmed', staff_id = $2::uuid, confirmed_at = now()
        WHERE encompass_login_id = $1`, [login(1), person2]);
    stub.users = [encUser(1, mail1)];           // the machine still likes person1
    await roster.syncRoster();
    const afterConfirm = await linkRow(1);
    eq(afterConfirm.status, 'confirmed', 'a CONFIRMED link survives a roster pass');
    eq(String(afterConfirm.staff_id), String(person2),
      'THE ONE THAT MATTERS: and still points at the person the human chose — not at the one the machine would propose. Drop the `WHERE status = suggested` and every pass silently re-points confirmed links, handing people each other\'s books');

    await db.query(
      `UPDATE lt_staff_links SET status = 'rejected', staff_id = NULL WHERE encompass_login_id = $1`,
      [login(1)]);
    await roster.syncRoster();
    const afterReject = await linkRow(1);
    eq(afterReject.status, 'rejected',
      'and a REJECTED link is never re-proposed — a suggestion that comes back every pass is how a review screen becomes noise people click past');
    eq(afterReject.staff_id, null, '…still pointing at nobody');

    // ── D2. THE SECOND LINE, REACHED DIRECTLY ────────────────────────────
    //
    // The pass above proves the matcher will not propose over a decision. It says
    // nothing about the writer, because the proposal never gets that far. So the
    // writer is handed the thing it exists to refuse — a suggestion aimed at a
    // login a human has already confirmed — and asked directly.
    await db.query(
      `UPDATE lt_staff_links SET status = 'confirmed', staff_id = $2::uuid WHERE encompass_login_id = $1`,
      [login(1), person2]);
    const dbc = await db.getClient();
    try {
      const wrote = await roster._internals.writeSuggestions(dbc, [
        { loginId: login(1), staffId: person1, method: 'email' },
      ]);
      eq(wrote, 0, 'the writer refuses a suggestion aimed at a CONFIRMED link outright');
    } finally { dbc.release(); }
    const stillTheirs = await linkRow(1);
    eq(String(stillTheirs.staff_id), String(person2),
      'THE ONE THAT MATTERS: and the link still points at the person the human chose — drop `WHERE status = suggested` and every pass silently re-points confirmed links, handing people each other\'s books with nothing on any screen to say so');
    eq(stillTheirs.status, 'confirmed', '…and is still confirmed');

    // ── D3. AND THE DEACTIVATION GUARD, ALSO REACHED DIRECTLY ────────────
    //
    // `syncRoster` refuses an empty roster before the writer is ever called, so
    // the `if (seen.length)` guard inside it is likewise unreachable through the
    // pass. It is the one that matters if that outer refusal is ever relaxed.
    const dbc2 = await db.getClient();
    try {
      const before = (await db.query(
        'SELECT count(*)::int AS n FROM lt_encompass_users WHERE is_active = true')).rows[0].n;
      await roster._internals.writeRoster(dbc2, []);
      const after = (await db.query(
        'SELECT count(*)::int AS n FROM lt_encompass_users WHERE is_active = true')).rows[0].n;
      eq(after, before,
        'THE ONE THAT MATTERS: handed an empty roster the writer deactivates NOBODY — an empty read is an outage, and treating it as "everybody left" would deactivate the whole company');
    } finally { dbc2.release(); }

    // Put the link back to suggested so section E reads the state it expects.
    await db.query(
      `UPDATE lt_staff_links SET status = 'rejected', staff_id = NULL WHERE encompass_login_id = $1`,
      [login(1)]);

    // ── E. GONE FROM ENCOMPASS IS DEACTIVATED, NEVER DELETED ──────────────
    stub.users = [encUser(2, `${tag}-nobody@example.com`)];   // login 1 has left
    const shrunk = await roster.syncRoster();
    eq(shrunk.ok, true, 'a roster that lost somebody still succeeds');
    const gone = await userRow(1);
    ok(gone, 'THE ONE THAT MATTERS: the person who left is still in the mirror — nothing on this side is ever deleted (charter rule 2)');
    eq(gone.is_active, false, '…they are DEACTIVATED, which is what a screen reads to stop offering them');
    eq((await userRow(2)).is_active, true, '…while everybody still on the roster stays active');

    // ── F. SEPARATION ─────────────────────────────────────────────────────
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../src/longterm/people/roster.js'), 'utf8');
    ok(!/UPDATE\s+staff_users|INSERT\s+INTO\s+staff_users|DELETE\s+FROM\s+staff_users/i.test(src),
      'the roster never writes the shared staff record — it READS it to propose against');
    const written = [...src.matchAll(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?!SET\b)([A-Za-z_][A-Za-z0-9_]*)/gi)].map((m) => m[1]);
    ok(written.length > 0 && written.every((t) => /^lt_/.test(t)),
      `and every table it writes is a long-term one (${[...new Set(written)].join(', ')})`);
    ok(!/DELETE\s+FROM\s+lt_encompass_users/i.test(src),
      'and it never deletes a person from the mirror, only deactivates them');
  } finally {
    await db.query('DELETE FROM lt_staff_links WHERE encompass_login_id LIKE $1', [`${tag}%`]).catch(() => {});
    await db.query('DELETE FROM lt_encompass_users WHERE login_id LIKE $1', [`${tag}%`]).catch(() => {});
    if (staffIds.length) {
      await db.query('DELETE FROM staff_users WHERE id = ANY($1::uuid[])', [staffIds]).catch(() => {});
    }
    await db.pool.end().catch(() => {});
    // AND THE RTL POOL. These suites require the app, which opens `src/db`'s pool
    // transitively; `db` here is the LONG-TERM one. Leaving the other open kept a
    // Postgres socket alive until its 30-second idle timeout, so the suite printed
    // its result and then sat there doing nothing. Across nine suites that was 270
    // of the 286 seconds the long-term database suites took.
    await require('../src/db').pool.end().catch(() => {});
  }

  console.log(`\n✓ lt roster-sync (db): ${checks} assertions passed`);
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
