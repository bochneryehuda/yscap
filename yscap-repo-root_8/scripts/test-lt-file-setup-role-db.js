'use strict';
/**
 * LT test — THE FILE-SETUP ASSIGNMENT, against a REAL database.
 *
 * Owner-directed 2026-08-23: *"the workflow assignment on Encompass doesn't have
 * anyone for file setup. It has processors, it has closers, it has funders, and it
 * has officers. This one should be the starter of the file … the loan officer submits
 * it to the processor, it goes to her workflow to set it up, and she is setting up
 * the file."*
 *
 * THE ONE THAT MATTERS, AND IT IS THE REASON THIS SUITE IS A DATABASE SUITE.
 * `writeContacts` ends by DELETING every role Encompass did not name — which is right
 * (an unassigned closer must stop showing as the closer) and is fatal to a role
 * Encompass has never heard of. Without the guard, a file assigned on Monday is
 * unassigned by the next sync tick, silently, forever. Section B is that assertion,
 * run through the REAL `writeContacts` against a real table: a source comment saying
 * the DELETE spares it proves nothing about what Postgres does.
 *
 * THE SECOND ONE. This assignment GRANTS ACCESS — the pipeline scope matches
 * `staff_id` — so "resolve the default" is a security decision, not a lookup. It must
 * refuse rather than pick: nobody by that name, two people by that name, a
 * deactivated account and an outside broker all have to answer NOTHING. Section A.
 *
 * Requires DATABASE_URL with migrations applied. Skips cleanly otherwise.
 * Everything runs in ONE transaction that is ROLLED BACK, so it leaves no rows.
 */
if (!process.env.DATABASE_URL) {
  console.log('SKIP test-lt-file-setup-role-db (no DATABASE_URL)');
  process.exit(0);
}

const db = require('../src/longterm/db');
const contacts = require('../src/longterm/people/contacts');
const access = require('../src/longterm/access');
const registry = require('../src/longterm/settings/encompass-settings');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

/** Does the pipeline scope hand this person this loan? The REAL fragment. */
async function scopeSees(c, loanId, staffId) {
  const { rows } = await c.query(
    `SELECT 1 FROM lt_loans l WHERE l.id = $2::uuid AND ${access.onFileSql('$1')}`,
    [staffId, loanId],
  );
  return rows.length > 0;
}

const roleRow = async (c, loanId, role) => {
  const { rows } = await c.query(
    'SELECT * FROM lt_loan_contacts WHERE loan_id = $1::uuid AND role = $2', [loanId, role]);
  return rows[0] || null;
};

(async () => {
  const c = await db.getClient();
  try {
    await c.query('BEGIN');

    const stamp = `ltsetup${Date.now()}`;
    const { settings: base } = registry.resolve({});

    console.log('the people');
    const { rows: made } = await c.query(
      `INSERT INTO staff_users (email, full_name, role, is_active)
            VALUES ($1, $5, 'processor', true),
                   ($2, $6, 'processor', true),
                   ($3, 'Gone Setter', 'processor', false),
                   ($4, 'Admin Person', 'admin', true)
         RETURNING id, email, full_name`,
      [`${stamp}.setter@example.test`, `${stamp}.other@example.test`,
        `${stamp}.gone@example.test`, `${stamp}.admin@example.test`,
        `${stamp} Setter`, `${stamp} Other`],
    );
    const pick = (tag) => made.find((r) => r.email.includes(`.${tag}@`));
    const setter = pick('setter');
    const other = pick('other');
    const gone = pick('gone');
    const admin = pick('admin');

    const { rows: firms } = await c.query(
      'INSERT INTO tpo_firms (name) VALUES ($1) RETURNING id', [`${stamp} Brokerage`]);
    await c.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, is_external, tpo_firm_id)
            VALUES ($1, $2, 'loan_officer', true, true, $3::uuid)`,
      [`${stamp}.ext@example.test`, `${stamp} Broker`, firms[0].id],
    );

    // ── A. Resolving who sets files up ────────────────────────────────────────
    console.log('\nwho sets files up here');

    const byName = await contacts.resolveDefaultStaff(c, `${stamp} Setter`);
    check(String(byName.staffId) === String(setter.id), 'a full name resolves to that person');
    const byEmail = await contacts.resolveDefaultStaff(c, `${stamp}.setter@example.test`);
    check(String(byEmail.staffId) === String(setter.id), 'so does their email address');
    const spaced = await contacts.resolveDefaultStaff(c, `  ${stamp.toUpperCase()} SETTER `);
    check(String(spaced.staffId) === String(setter.id), 'casing and stray spaces do not matter');

    const nobody = await contacts.resolveDefaultStaff(c, 'Someone Who Does Not Work Here');
    check(nobody.staffId === null && /No active member of staff/.test(nobody.reason),
      'a name nobody has resolves to NOBODY, and says so — never a file quietly handed to the first row back');
    const deactivated = await contacts.resolveDefaultStaff(c, 'Gone Setter');
    check(deactivated.staffId === null,
      'a deactivated account resolves to nobody — routing a file to a closed login looks exactly like a real assignment');
    const brokerTry = await contacts.resolveDefaultStaff(c, `${stamp} Broker`);
    check(brokerTry.staffId === null,
      'an outside BROKER is never resolvable — this grants access to a long-term file');
    const blank = await contacts.resolveDefaultStaff(c, '   ');
    check(blank.staffId === null && /No default was set/.test(blank.reason),
      'an empty setting assigns nobody, and says that too');

    // Two people, one name — the case where picking either would be a disclosure.
    await c.query(
      `INSERT INTO staff_users (email, full_name, role, is_active)
            VALUES ($1, $2, 'processor', true)`,
      [`${stamp}.twin@example.test`, `${stamp} Setter`],
    );
    const twin = await contacts.resolveDefaultStaff(c, `${stamp} Setter`);
    check(twin.staffId === null && /More than one/.test(twin.reason),
      'TWO people of that name resolves to nobody and asks for an email — picking one would be a guess about access');
    await c.query('DELETE FROM staff_users WHERE email = $1', [`${stamp}.twin@example.test`]);

    // ── B. THE SYNC MUST NOT UNDO IT ──────────────────────────────────────────
    console.log('\nan Encompass sync leaves our own role alone');

    const { rows: loans } = await c.query(
      `INSERT INTO lt_loans (id, loan_number, encompass_loan_guid, loan_folder)
            VALUES (gen_random_uuid(), $1, $2, 'Active DSCR') RETURNING id`,
      [`${stamp}-1`, `${stamp}-guid`],
    );
    const loanId = String(loans[0].id);

    const settings = { ...base, 'contacts.fileSetupDefault': `${stamp} Setter` };
    const filled = await contacts.ensurePilotRoles(c, loanId, settings);
    check(filled.filled === 1, 'the file gains a setup assignment');
    const setup = await roleRow(c, loanId, contacts.FILE_SETUP_ROLE);
    check(setup && String(setup.staff_id) === String(setter.id), '…pointing at the person the setting names');
    check(setup.encompass_login_id === null && setup.encompass_name === null,
      '…and carrying no Encompass identity, because Encompass has none to give');
    check(await scopeSees(c, loanId, setter.id),
      'the file is now in her book — the pipeline scope honours it, which is what "her workflow" means');

    // The real writer, with the real Encompass-read team. THIS is the assertion the
    // whole suite exists for.
    const team = [
      { role: 'loan_officer', name: 'Shea Weiss', email: null, phone: null, loginId: 'sweiss', staffId: null },
      { role: 'processor', name: 'Rivka Green', email: null, phone: null, loginId: 'rgreen', staffId: null },
    ];
    const wrote = await contacts.writeContacts(c, loanId, team, contacts.pilotRoles(settings));
    check(wrote.written === 2, 'the Encompass team is written');
    check(await roleRow(c, loanId, contacts.FILE_SETUP_ROLE),
      'AND THE SETUP ASSIGNMENT SURVIVES — the removal that clears an unassigned closer must never reach a role Encompass has no word for');
    check(await scopeSees(c, loanId, setter.id), '…so the file is still hers after the sync');

    // A stale Encompass role IS still removed. The guard must not have turned the
    // removal off; it must only have narrowed it.
    await c.query(
      `INSERT INTO lt_loan_contacts (id, loan_id, role, encompass_name, encompass_login_id)
            VALUES (gen_random_uuid(), $1::uuid, 'closer', 'Old Closer', 'ocloser')`, [loanId]);
    await contacts.writeContacts(c, loanId, team, contacts.pilotRoles(settings));
    check(!(await roleRow(c, loanId, 'closer')),
      'a closer Encompass no longer names is STILL removed — the guard narrowed the removal, it did not disable it');

    // ── C. Fill-only, forever ────────────────────────────────────────────────
    console.log('\nit only ever fills an empty slot');

    const again = await contacts.ensurePilotRoles(c, loanId, settings);
    check(again.filled === 0, 'a second pass assigns nothing — the row is already there');

    // Somebody moves the file. The default must never take it back.
    await contacts.reassign(loanId, contacts.FILE_SETUP_ROLE, String(other.id), String(admin.id),
      'Chaya is away this week', c);
    const moved = await roleRow(c, loanId, contacts.FILE_SETUP_ROLE);
    check(String(moved.override_staff_id) === String(other.id), 'the file is reassigned to somebody else');
    check(moved.override_reason === 'Chaya is away this week', '…with the reason stamped on the row');

    await contacts.ensurePilotRoles(c, loanId, settings);
    await contacts.writeContacts(c, loanId, team, contacts.pilotRoles(settings));
    const after = await roleRow(c, loanId, contacts.FILE_SETUP_ROLE);
    check(String(after.override_staff_id) === String(other.id),
      'neither the default nor a full Encompass sync takes it back — a human\'s decision outlives both');
    check(await scopeSees(c, loanId, other.id), '…and the file is in the new person\'s book');

    // ── D. A default nobody can resolve assigns NOBODY ────────────────────────
    console.log('\na default that names nobody');

    const { rows: loans2 } = await c.query(
      `INSERT INTO lt_loans (id, loan_number, encompass_loan_guid, loan_folder)
            VALUES (gen_random_uuid(), $1, $2, 'Active DSCR') RETURNING id`,
      [`${stamp}-2`, `${stamp}-guid-2`],
    );
    const loan2 = String(loans2[0].id);
    const nothing = await contacts.ensurePilotRoles(c, loan2,
      { ...base, 'contacts.fileSetupDefault': 'Nobody At All' });
    check(nothing.filled === 0 && /No active member of staff/.test(nothing.reason || ''),
      'nothing is written, and the reason is reported rather than swallowed');
    check(!(await roleRow(c, loan2, contacts.FILE_SETUP_ROLE)),
      '…so the file simply has no setup assignment yet, which is the truth');

    // ── E. The back book: LIVE files only ────────────────────────────────────
    console.log('\nthe back book, and the files it deliberately leaves alone');

    const { rows: loans3 } = await c.query(
      `INSERT INTO lt_loans (id, loan_number, encompass_loan_guid, loan_folder)
            VALUES (gen_random_uuid(), $1, $2, 'Broker CLOSED'),
                   (gen_random_uuid(), $3, $4, 'Withdrawn files'),
                   (gen_random_uuid(), $5, $6, 'Training')
         RETURNING id, loan_folder`,
      [`${stamp}-c`, `${stamp}-g-c`, `${stamp}-w`, `${stamp}-g-w`, `${stamp}-t`, `${stamp}-g-t`],
    );
    const byFolder = (f) => String(loans3.find((r) => r.loan_folder === f).id);

    const sweep = await contacts.backfillPilotRoles({ db: c, settings, limit: 500 });
    check(sweep.ok === true, 'the sweep runs');
    check(!!(await roleRow(c, loan2, contacts.FILE_SETUP_ROLE)),
      'a LIVE file that had none gains one');
    check(!(await roleRow(c, byFolder('Broker CLOSED'), contacts.FILE_SETUP_ROLE)),
      'a CLOSED file gains none — writing one would state that this person set up a loan that closed years ago');
    check(!(await roleRow(c, byFolder('Withdrawn files'), contacts.FILE_SETUP_ROLE)),
      'nor a withdrawn one');
    check(!(await roleRow(c, byFolder('Training'), contacts.FILE_SETUP_ROLE)),
      'nor a file in a hidden folder');

    const sweptTwice = await contacts.backfillPilotRoles({ db: c, settings, limit: 500 });
    check(sweptTwice.filled === 0, 'a second sweep fills nothing — it is self-draining, so a caught-up book costs one statement');

    const noDefault = await contacts.backfillPilotRoles({
      db: c, settings: { ...base, 'contacts.fileSetupDefault': '' }, limit: 500 });
    check(noDefault.filled === 0 && /No default was set/.test(noDefault.reason || ''),
      'with no default set the sweep assigns nobody and says why');

    // ── F. What the screen is told ───────────────────────────────────────────
    console.log('\nwhat the file screen says about it');

    const described = contacts.describeContact(await roleRow(c, loan2, contacts.FILE_SETUP_ROLE), {
      labels: settings['contacts.roleLabels'],
      pilotRoleList: contacts.pilotRoles(settings),
      staffName: `${stamp} Setter`,
    });
    check(described.ours === true, 'the row is marked as ours');
    check(described.label === 'File setup', '…and labelled in plain words');
    check(/Encompass has no file-setup assignment/.test(described.note || ''),
      '…and says WHY there is no Encompass name beside it, so an empty column never reads as a broken sync');

    const encompassRow = contacts.describeContact(await roleRow(c, loanId, 'loan_officer'), {
      labels: settings['contacts.roleLabels'],
      pilotRoleList: contacts.pilotRoles(settings),
    });
    check(encompassRow.ours === false, 'an Encompass role is NOT marked as ours');

    await c.query('ROLLBACK');
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (_) { /* the original error is the one that matters */ }
    failures += 1;
    console.error('  FAIL threw:', (e && e.message) || e);
  } finally {
    c.release();
  }

  console.log(failures ? `\n${failures} failure(s)` : '\nall good');
  process.exit(failures ? 1 : 0);
})();
