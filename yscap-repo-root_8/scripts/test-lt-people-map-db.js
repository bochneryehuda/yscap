'use strict';
/**
 * LT test — the people map against a REAL database (db/552).
 *
 * The pure suite proves the POLICY. This proves the parts a pure suite structurally
 * cannot, and each one has already been a live bug on the RTL side:
 *
 *   · **Every column these queries name actually exists.** `staff_users` carries ONE
 *     `full_name` — it is the BORROWERS table that splits a person into first/last —
 *     and the roster pass wraps itself in a catch, so a phantom column would report a
 *     confident empty roster forever rather than an error. That is exactly how
 *     `b.full_name` went undetected in buildWholeLoanContext.
 *   · **The upsert's WHERE clause really does protect a decided link.** "The sync
 *     never touches a confirmed row" is a claim about `ON CONFLICT … WHERE`, which
 *     only Postgres can settle.
 *   · **One person, one login is enforced by the INDEX, not by our read.** Two admins
 *     confirming at once would each read "free"; only the partial unique index makes
 *     it true.
 *
 * Requires DATABASE_URL with migrations applied. Skips cleanly otherwise.
 * Everything runs in ONE transaction that is ROLLED BACK, so it leaves no rows.
 */
if (!process.env.DATABASE_URL) {
  console.log('SKIP test-lt-people-map-db (no DATABASE_URL)');
  process.exit(0);
}

const db = require('../src/longterm/db');
const roster = require('../src/longterm/people/roster');
const contacts = require('../src/longterm/people/contacts');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

let sp = 0;
async function refuses(c, fn, msg) {
  const name = `sp${sp += 1}`;
  await c.query(`SAVEPOINT ${name}`);
  try {
    await fn();
    await c.query(`RELEASE SAVEPOINT ${name}`);
    failures += 1;
    console.error(`  FAIL ${msg} (it was allowed)`);
  } catch {
    await c.query(`ROLLBACK TO SAVEPOINT ${name}`);
    console.log(`  ok   ${msg}`);
  }
}

(async () => {
  const c = await db.getClient();
  try {
    await c.query('BEGIN');

    // ── The identity zone read ──────────────────────────────────────────────
    console.log('the columns are real');

    const stamp = `ltpeople${Date.now()}`;
    const { rows: made } = await c.query(
      `INSERT INTO staff_users (email, full_name, role, is_active)
            VALUES ($1, 'Shea Weiss', 'loan_officer', true),
                   ($2, 'Malky Katz', 'admin', true)
         RETURNING id, email`,
      [`${stamp}.a@example.test`, `${stamp}.b@example.test`],
    );
    const shea = made.find((r) => r.email.includes('.a@'));
    const malky = made.find((r) => r.email.includes('.b@'));

    // THE ASSERTION THIS FILE EXISTS FOR: the real query, against the real table.
    const staff = await roster._internals.loadStaff(c);
    const mine = staff.filter((s) => String(s.email).startsWith(stamp));
    check(mine.length === 2, 'loadStaff reads staff_users without naming a column that does not exist');
    check(mine.every((s) => s.full_name && s.id && 'is_active' in s),
      '…and returns the name, the id and the active flag the matcher needs');

    // An outside broker must never be linkable to an Encompass login.
    //
    // The firm is not decoration: db/523's `staff_users_external_firm_check` makes
    // an external account with no firm structurally unwritable, so a broker fixture
    // without one does not test the exclusion — it fails to exist.
    const { rows: firms } = await c.query(
      `INSERT INTO tpo_firms (name) VALUES ($1) RETURNING id`, [`${stamp} Brokerage`],
    );
    await c.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, is_external, tpo_firm_id)
            VALUES ($1, 'Outside Broker', 'loan_officer', true, true, $2::uuid)`,
      [`${stamp}.ext@example.test`, firms[0].id],
    );
    const withExt = await roster._internals.loadStaff(c);
    check(!withExt.some((s) => String(s.email) === `${stamp}.ext@example.test`),
      'an EXTERNAL account (a TPO broker) is excluded — a broker may never be handed a long-term pipeline');

    // ── The roster mirror ───────────────────────────────────────────────────
    console.log('\nthe roster mirror');

    const rows = [
      { login_id: `${stamp}-sweiss`, full_name: 'Shea Weiss', email: `${stamp}.a@example.test`, phone: null, personas: ['Loan Coordinator'], role_names: [], is_active: true },
      { login_id: `${stamp}-mkatz`, full_name: 'Malky Katz', email: `${stamp}.b@example.test`, phone: null, personas: [], role_names: [], is_active: true },
    ];
    const wrote = await roster._internals.writeRoster(c, rows);
    check(wrote.written === 2, 'the roster writes every user it read');

    const { rows: back } = await c.query(
      'SELECT * FROM lt_encompass_users WHERE login_id = $1', [`${stamp}-sweiss`],
    );
    check(back.length === 1 && back[0].email === `${stamp}.a@example.test`,
      'a mirrored user reads back with its email');
    check(Array.isArray(back[0].personas) && back[0].personas[0] === 'Loan Coordinator',
      'personas round-trip as a text array');
    check(back[0].encompass_synced_at != null, 'the freshness stamp is written, so a screen can say when');

    // Re-running must be an update, never a duplicate.
    await roster._internals.writeRoster(c, rows);
    const { rows: dup } = await c.query(
      'SELECT count(*)::int AS n FROM lt_encompass_users WHERE login_id LIKE $1', [`${stamp}-%`],
    );
    check(dup[0].n === 2, 'a second sync updates rather than duplicates');

    // ── The suggestions, and what the sync may not touch ────────────────────
    console.log('\nproposals, and the decisions the sync may not touch');

    const proposed = await roster._internals.writeSuggestions(c, [
      { loginId: `${stamp}-sweiss`, staffId: String(shea.id), method: 'email' },
    ]);
    check(proposed === 1, 'a proposal is written as a suggestion');
    const { rows: sug } = await c.query(
      'SELECT * FROM lt_staff_links WHERE encompass_login_id = $1', [`${stamp}-sweiss`],
    );
    check(sug[0].status === 'suggested' && String(sug[0].staff_id) === String(shea.id),
      '…pointing at the proposed person, and NOT confirmed — a human still has to say yes');

    // Confirm it, then try to re-propose somebody else onto the same login.
    await c.query(
      `UPDATE lt_staff_links SET status = 'confirmed', confirmed_at = now()
        WHERE encompass_login_id = $1`, [`${stamp}-sweiss`],
    );
    await roster._internals.writeSuggestions(c, [
      { loginId: `${stamp}-sweiss`, staffId: String(malky.id), method: 'email' },
    ]);
    const { rows: after } = await c.query(
      'SELECT * FROM lt_staff_links WHERE encompass_login_id = $1', [`${stamp}-sweiss`],
    );
    check(after[0].status === 'confirmed' && String(after[0].staff_id) === String(shea.id),
      'THE ONE THAT MATTERS: a CONFIRMED link is untouched by the next sync — the ON CONFLICT WHERE is what proves it');

    // A rejection is equally final.
    await c.query(
      `INSERT INTO lt_staff_links (encompass_login_id, staff_id, status)
            VALUES ($1, NULL, 'rejected')`, [`${stamp}-mkatz`],
    );
    await roster._internals.writeSuggestions(c, [
      { loginId: `${stamp}-mkatz`, staffId: String(malky.id), method: 'email' },
    ]);
    const { rows: rej } = await c.query(
      'SELECT * FROM lt_staff_links WHERE encompass_login_id = $1', [`${stamp}-mkatz`],
    );
    check(rej[0].status === 'rejected' && rej[0].staff_id === null,
      'a REJECTED link is not quietly re-proposed by the next sync');

    // ── One person, one login ───────────────────────────────────────────────
    console.log('\none person, one login');

    await c.query(
      `INSERT INTO lt_encompass_users (login_id, full_name, is_active) VALUES ($1, 'Second Login', true)`,
      [`${stamp}-second`],
    );
    await refuses(c, () => c.query(
      `INSERT INTO lt_staff_links (encompass_login_id, staff_id, status, confirmed_at)
            VALUES ($1, $2::uuid, 'confirmed', now())`,
      [`${stamp}-second`, String(shea.id)],
    ), 'the DATABASE refuses a second CONFIRMED link for one person — not our read, the index');

    // A suggestion for the same person is fine: the index is partial on purpose, so
    // proposing does not have to wait for another proposal to be decided.
    await c.query(
      `INSERT INTO lt_staff_links (encompass_login_id, staff_id, status)
            VALUES ($1, $2::uuid, 'suggested')
       ON CONFLICT (encompass_login_id) DO UPDATE SET staff_id = EXCLUDED.staff_id`,
      [`${stamp}-second`, String(malky.id)],
    );
    const { rows: both } = await c.query(
      `SELECT count(*)::int AS n FROM lt_staff_links WHERE staff_id = $1::uuid`, [String(malky.id)],
    );
    check(both[0].n >= 1, 'a SUGGESTION is not blocked by the index — only a confirmed one is');

    // ── Deactivation, never deletion ────────────────────────────────────────
    console.log('\ngone from Encompass');

    await roster._internals.writeRoster(c, [rows[0]]);
    const { rows: gone } = await c.query(
      'SELECT login_id, is_active FROM lt_encompass_users WHERE login_id = $1', [`${stamp}-mkatz`],
    );
    check(gone.length === 1 && gone[0].is_active === false,
      'a user missing from the roster is DEACTIVATED, never deleted — their login id is on historical loans');

    // ── The loan team, and the one thing a sync may never undo ──────────────
    console.log('\nthe loan team');

    const { rows: loans } = await c.query(
      `INSERT INTO lt_loans (id, loan_number, encompass_loan_guid)
            VALUES (gen_random_uuid(), $1, $2) RETURNING id`,
      [`${stamp}-L1`, `${stamp}-guid`],
    );
    const loanId = loans[0].id;

    await contacts.writeContacts(c, loanId, [
      { role: 'loan_officer', name: 'Solomon Weiss', email: `${stamp}.a@example.test`, phone: null, loginId: `${stamp}-sweiss`, staffId: String(shea.id) },
      { role: 'closer', name: 'Malky Katz', email: null, phone: null, loginId: `${stamp}-mkatz`, staffId: null },
    ]);
    const { rows: team } = await c.query(
      'SELECT * FROM lt_loan_contacts WHERE loan_id = $1::uuid ORDER BY role', [loanId],
    );
    check(team.length === 2, 'both contacts are written, one row per role');
    check(String(team.find((t) => t.role === 'loan_officer').staff_id) === String(shea.id),
      'a contact whose login is CONFIRMED is attributed to that PILOT person');
    check(team.find((t) => t.role === 'closer').staff_id === null
       && team.find((t) => t.role === 'closer').encompass_name === 'Malky Katz',
      'an unlinked contact is stored by NAME and attributed to nobody');

    // Somebody reassigns the file locally.
    await contacts.setOverride(loanId, 'loan_officer', String(malky.id), String(malky.id), 'covering while he is away', c);
    // …and then Encompass is read again, saying exactly what it said before.
    await contacts.writeContacts(c, loanId, [
      { role: 'loan_officer', name: 'Solomon Weiss', email: `${stamp}.a@example.test`, phone: null, loginId: `${stamp}-sweiss`, staffId: String(shea.id) },
      { role: 'closer', name: 'Malky Katz', email: null, phone: null, loginId: `${stamp}-mkatz`, staffId: null },
    ]);
    const { rows: afterSync } = await c.query(
      `SELECT * FROM lt_loan_contacts WHERE loan_id = $1::uuid AND role = 'loan_officer'`, [loanId],
    );
    check(String(afterSync[0].override_staff_id) === String(malky.id),
      'THE ONE THAT MATTERS: a re-sync from Encompass does NOT undo a local reassignment');
    check(String(afterSync[0].staff_id) === String(shea.id),
      '…while still refreshing what Encompass says, because they are separate columns');
    check(afterSync[0].override_reason === 'covering while he is away',
      'the reason a file was reassigned survives the sync too');

    // Clearing the override is how "Encompass was right after all" is expressed.
    await contacts.setOverride(loanId, 'loan_officer', null, String(malky.id), null, c);
    const { rows: cleared } = await c.query(
      `SELECT * FROM lt_loan_contacts WHERE loan_id = $1::uuid AND role = 'loan_officer'`, [loanId],
    );
    check(cleared[0].override_staff_id === null && cleared[0].override_by === null
       && cleared[0].override_at === null && cleared[0].override_reason === null,
      'clearing an override clears every trace of it, not just the pointer');

    // A role Encompass stops naming must stop showing.
    await contacts.writeContacts(c, loanId, [
      { role: 'loan_officer', name: 'Solomon Weiss', email: null, phone: null, loginId: `${stamp}-sweiss`, staffId: String(shea.id) },
    ]);
    const { rows: left } = await c.query(
      'SELECT role FROM lt_loan_contacts WHERE loan_id = $1::uuid', [loanId],
    );
    check(left.length === 1 && left[0].role === 'loan_officer',
      'a role Encompass no longer names is removed — an unassigned closer must stop showing as the closer');

    // ── Confirming a link is retroactive ────────────────────────────────────
    console.log('\nconfirming a link reaches the files that login is already on');

    await c.query(
      `INSERT INTO lt_loan_contacts (id, loan_id, role, encompass_login_id, encompass_name)
            VALUES (gen_random_uuid(), $1::uuid, 'closer', $2, 'Malky Katz')`,
      [loanId, `${stamp}-mkatz`],
    );
    // mkatz was REJECTED earlier in this test, so nothing should attribute yet.
    await contacts.reattributeAll(c);
    const { rows: stillNone } = await c.query(
      `SELECT staff_id FROM lt_loan_contacts WHERE loan_id = $1::uuid AND role = 'closer'`, [loanId],
    );
    check(stillNone[0].staff_id === null,
      'a REJECTED login attributes nothing, however many files it appears on');

    await c.query(
      `UPDATE lt_staff_links SET status = 'confirmed', staff_id = $2::uuid, confirmed_at = now()
        WHERE encompass_login_id = $1`, [`${stamp}-mkatz`, String(malky.id)],
    );
    const re = await contacts.reattributeAll(c);
    const { rows: nowMine } = await c.query(
      `SELECT staff_id FROM lt_loan_contacts WHERE loan_id = $1::uuid AND role = 'closer'`, [loanId],
    );
    check(String(nowMine[0].staff_id) === String(malky.id) && re.attributed >= 1,
      'confirming a link makes every file that login is already on theirs — no Encompass call, no re-sync');

    // …and undoing it takes them back off, or a file stays in the pipeline of
    // somebody the admin just unlinked.
    await c.query('DELETE FROM lt_staff_links WHERE encompass_login_id = $1', [`${stamp}-mkatz`]);
    const undone = await contacts.reattributeAll(c);
    const { rows: gone2 } = await c.query(
      `SELECT staff_id FROM lt_loan_contacts WHERE loan_id = $1::uuid AND role = 'closer'`, [loanId],
    );
    check(gone2[0].staff_id === null && undone.cleared >= 1,
      'unlinking takes the files back off them again');

    await c.query('ROLLBACK');
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (_) { /* the original error is the one that matters */ }
    failures += 1;
    console.error('  FAIL unexpected error:', (e && e.message) || e);
  } finally {
    c.release();
    await db.pool.end().catch(() => {});
  }

  console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
  process.exit(failures ? 1 : 0);
})();
