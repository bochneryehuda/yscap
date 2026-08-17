'use strict';
/**
 * LT test — reassigning a long-term file locally, against a REAL database.
 *
 * The pure suite proves the policy. This proves the things a pure suite structurally
 * cannot, and every one of them has been a live bug somewhere in this repo:
 *
 *   · **The columns these queries name exist.** `reassign` reads `is_external` and
 *     `is_active` off `staff_users` and writes four override columns; a phantom name
 *     inside a route's catch-all becomes a confident "could not reassign this file"
 *     forever, or worse, a silent success.
 *   · **The reassignment actually MOVES THE FILE.** The whole point of an override is
 *     that the pipeline scope honours it. That is a claim about SQL — `onFileSql`
 *     matching `override_staff_id` — and only Postgres can settle it.
 *   · **A sync does not undo it.** "The upsert names no override column" is a source
 *     guard; that the row survives a real `writeContacts` is a fact about the database.
 *
 * Requires DATABASE_URL with migrations applied. Skips cleanly otherwise.
 * Everything runs in ONE transaction that is ROLLED BACK, so it leaves no rows.
 */
if (!process.env.DATABASE_URL) {
  console.log('SKIP test-lt-contact-override-db (no DATABASE_URL)');
  process.exit(0);
}

const db = require('../src/longterm/db');
const contacts = require('../src/longterm/people/contacts');
const access = require('../src/longterm/access');
const pipeline = require('../src/longterm/pipeline');
const roster = require('../src/longterm/people/roster');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

let sp = 0;
/** A refusal must be a refusal AND leave the transaction usable, so each attempt
 *  runs inside its own savepoint. */
async function refuses(c, fn, msg, expect) {
  const name = `sp${sp += 1}`;
  await c.query(`SAVEPOINT ${name}`);
  try {
    await fn();
    await c.query(`RELEASE SAVEPOINT ${name}`);
    failures += 1;
    console.error(`  FAIL ${msg} (it was allowed)`);
  } catch (e) {
    await c.query(`ROLLBACK TO SAVEPOINT ${name}`);
    if (expect && !expect.test(String((e && e.plain) || (e && e.message) || ''))) {
      failures += 1;
      console.error(`  FAIL ${msg} (refused, but said "${(e && e.plain) || e.message}")`);
    } else {
      console.log(`  ok   ${msg}`);
    }
  }
}

/** Does the pipeline scope hand this person this loan? The REAL fragment, run as
 *  the pipeline runs it — never a re-typed predicate, which would prove nothing
 *  about the query that actually decides. */
async function scopeSees(c, loanId, staffId) {
  const { rows } = await c.query(
    `SELECT 1 FROM lt_loans l WHERE l.id = $2::uuid AND ${access.onFileSql('$1')}`,
    [staffId, loanId],
  );
  return rows.length > 0;
}

(async () => {
  const c = await db.getClient();
  try {
    await c.query('BEGIN');

    const stamp = `ltovr${Date.now()}`;
    console.log('the people and the file');

    const { rows: made } = await c.query(
      `INSERT INTO staff_users (email, full_name, role, is_active)
            VALUES ($1, 'Shea Weiss', 'loan_officer', true),
                   ($2, 'Rivka Green', 'loan_officer', true),
                   ($3, 'Malky Katz', 'admin', true),
                   ($4, 'Gone Person', 'loan_officer', false)
         RETURNING id, email`,
      [`${stamp}.a@example.test`, `${stamp}.b@example.test`,
        `${stamp}.admin@example.test`, `${stamp}.off@example.test`],
    );
    const pick = (tag) => made.find((r) => r.email.includes(`.${tag}@`));
    const shea = pick('a');
    const rivka = pick('b');
    const admin = pick('admin');
    const deactivated = pick('off');

    // A TPO broker is an external staff_users row. db/523 makes one with no firm
    // structurally unwritable, so the firm is part of the fixture rather than
    // decoration — without it the broker does not exist and the exclusion is untested.
    const { rows: firms } = await c.query(
      'INSERT INTO tpo_firms (name) VALUES ($1) RETURNING id', [`${stamp} Brokerage`],
    );
    const { rows: brokers } = await c.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, is_external, tpo_firm_id)
            VALUES ($1, 'Outside Broker', 'loan_officer', true, true, $2::uuid)
         RETURNING id`,
      [`${stamp}.ext@example.test`, firms[0].id],
    );
    const broker = brokers[0];

    const { rows: loans } = await c.query(
      `INSERT INTO lt_loans (id, loan_number, encompass_loan_guid)
            VALUES (gen_random_uuid(), $1, $2) RETURNING id`,
      [`${stamp}-1`, `${stamp}-guid`],
    );
    const loanId = String(loans[0].id);

    // Encompass names Shea, and the people map has resolved that to Shea in PILOT.
    await c.query(
      `INSERT INTO lt_loan_contacts
         (id, loan_id, role, encompass_name, encompass_email, encompass_login_id, staff_id, encompass_synced_at)
       VALUES (gen_random_uuid(), $1::uuid, 'loan_officer', 'Shea Weiss', $2, $3, $4::uuid, now())`,
      [loanId, `${stamp}.a@example.test`, `${stamp}-sweiss`, shea.id],
    );

    check(await scopeSees(c, loanId, shea.id), 'the file starts in Shea\'s book, because Encompass names her');
    check(!(await scopeSees(c, loanId, rivka.id)), '…and not in Rivka\'s');

    // ── Reassigning it ────────────────────────────────────────────────────────
    console.log('\nreassigning the file to somebody else');

    const row = await contacts.reassign(loanId, 'loan_officer', String(rivka.id), String(admin.id),
      'Rivka took this file over in March', c);

    check(String(row.override_staff_id) === String(rivka.id), 'the override names the new person');
    check(String(row.override_by) === String(admin.id), '…and who decided it');
    check(row.override_at != null, '…and when');
    check(row.override_reason === 'Rivka took this file over in March', '…and why, in their own words');

    // THE ASSERTION THIS FEATURE EXISTS FOR.
    check(await scopeSees(c, loanId, rivka.id),
      'the file is now genuinely in Rivka\'s pipeline — the scope honours the override, which is the whole point of allowing one');
    // AND THE PERSON ENCOMPASS NAMES KEEPS THEIR ACCESS. This is asserted rather than
    // assumed because it is the ONE thing about this feature nobody here may decide,
    // and it is genuinely surprising: everything else in the codebase that answers
    // "whose file is this" reads the EFFECTIVE person — `pipeline.officerIsSql`,
    // `UNASSIGNED_SQL`, the row's own `staffId`, `describeContact.effectiveStaffId` —
    // all `COALESCE(override_staff_id, staff_id)`. Only the ACCESS scope
    // (`access.onFileSql`) reads `staff_id = me OR override_staff_id = me`, so a
    // reassigned file leaves the previous officer's OFFICER FILTER while staying in
    // their own pipeline and remaining openable by them.
    //
    // That was never a decision: until this feature existed nothing could set an
    // override, so the case could not arise, and the OR was simply the safe way to
    // make the new person's access work. It matters now — reassigning cannot take a
    // file away from anybody, so an officer who leaves the team keeps every file they
    // were ever named on. WHO KEEPS ACCESS AFTER A REASSIGNMENT IS A BUSINESS RULE
    // and belongs to the owner, so the behaviour is pinned here exactly as it is and
    // flagged rather than quietly changed. If the answer comes back "the file leaves
    // them", this assertion is the one that flips, and `onFileSql` becomes the same
    // COALESCE the other four already use.
    check(await scopeSees(c, loanId, shea.id),
      'the person Encompass names KEEPS their access today — pinned, not endorsed: it is the open question this feature raises, and the owner\'s to answer');

    // The other half of the two-source model: Encompass's answer is untouched, so
    // the screen can show both and say plainly that they disagree.
    check(row.encompass_name === 'Shea Weiss' && row.encompass_login_id === `${stamp}-sweiss`
      && String(row.staff_id) === String(shea.id),
      'what Encompass says is left exactly as it was — nothing was overwritten, and nothing was sent back');

    const described = contacts.describeContact(row, { staffName: 'Shea Weiss', overrideName: 'Rivka Green' });
    check(described.overridden === true && described.effectiveStaffId === String(rivka.id),
      'the screen is told it is an override, and who the file actually belongs to');
    check(/reassigned in pilot/i.test(described.note || '') && /nothing was written back/i.test(described.note || ''),
      '…with a sentence saying Encompass still names the other person and was not told');

    // ── A sync must not undo it ───────────────────────────────────────────────
    console.log('\nthe next sync refreshes Encompass\'s side and leaves ours alone');

    await contacts.writeContacts(c, loanId, [{
      role: 'loan_officer', name: 'Shea Weiss', email: `${stamp}.a@example.test`,
      phone: '555-0100', loginId: `${stamp}-sweiss`, staffId: String(shea.id),
    }]);
    const { rows: afterSync } = await c.query(
      'SELECT * FROM lt_loan_contacts WHERE loan_id = $1::uuid AND role = $2', [loanId, 'loan_officer'],
    );
    check(String(afterSync[0].override_staff_id) === String(rivka.id),
      'a full re-sync leaves the reassignment standing — the override columns are separate for exactly this reason');
    check(afterSync[0].override_reason === 'Rivka took this file over in March',
      '…reason and all');
    check(afterSync[0].encompass_phone === '555-0100',
      '…while Encompass\'s own side really was refreshed, so this is not passing because the sync did nothing');
    check(await scopeSees(c, loanId, rivka.id), '…and the file is still Rivka\'s afterwards');

    // ── What is refused ───────────────────────────────────────────────────────
    console.log('\nwhat cannot be done');

    await refuses(c, () => contacts.reassign(loanId, 'loan_officer', String(broker.id), String(admin.id), 'they handle it', c),
      'an outside broker cannot be given a long-term file — an override puts them in the pipeline, and a TPO account is not staff',
      /outside broker/i);

    await refuses(c, () => contacts.reassign(loanId, 'loan_officer', String(deactivated.id), String(admin.id), 'they handle it', c),
      'a deactivated person cannot be given one — it routes the file to nobody while looking like a real assignment',
      /deactivated/i);

    await refuses(c, () => contacts.reassign(loanId, 'loan_officer', '00000000-0000-0000-0000-000000000000', String(admin.id), 'a reason', c),
      'a person who does not exist is refused', /does not exist/i);

    await refuses(c, () => contacts.reassign(loanId, 'closer', String(rivka.id), String(admin.id), 'a reason', c),
      'a role that is not on this file is refused IN WORDS, rather than answered with a silent success',
      /not on this file/i);

    await refuses(c, () => contacts.reassign('00000000-0000-0000-0000-000000000000', 'loan_officer', String(rivka.id), String(admin.id), 'a reason', c),
      'a loan that does not exist is refused', /no such/i);

    await refuses(c, () => contacts.reassign(loanId, 'loan_officer', String(shea.id), String(admin.id), '', c),
      'naming somebody with no reason is refused before the database is touched at all', /why/i);

    // The refusals must not have changed anything.
    const { rows: still } = await c.query(
      'SELECT * FROM lt_loan_contacts WHERE loan_id = $1::uuid AND role = $2', [loanId, 'loan_officer'],
    );
    check(String(still[0].override_staff_id) === String(rivka.id),
      'after every refusal the file is exactly where it was — a refused reassignment writes nothing');

    // ── Undoing it ────────────────────────────────────────────────────────────
    console.log('\nundoing a reassignment');

    const cleared = await contacts.reassign(loanId, 'loan_officer', null, String(admin.id), null, c);
    check(cleared.override_staff_id === null, 'clearing takes the person off');
    check(cleared.override_by === null && cleared.override_at === null && cleared.override_reason === null,
      '…and the whole stamp with them, so the file does not read as reassigned to nobody');
    check(String(cleared.staff_id) === String(shea.id),
      '…leaving Encompass\'s own answer intact underneath');
    check(await scopeSees(c, loanId, shea.id), 'the file goes back to Shea');
    check(!(await scopeSees(c, loanId, rivka.id)),
      '…and genuinely LEAVES Rivka\'s book, so an override that was a mistake can be fully undone');

    // The two halves of the open question above, side by side on the same file: the
    // officer FILTER already treats a reassigned file as the new person's alone.
    await contacts.reassign(loanId, 'loan_officer', String(rivka.id), String(admin.id), 'again, to compare', c);
    const officerIs = async (staffId) => {
      // The REAL fragment the pipeline filters with — re-typing it would prove
      // nothing about the query that actually decides.
      const { rows } = await c.query(
        `SELECT 1 FROM lt_loans l WHERE l.id = $2::uuid AND ${pipeline._internals.officerIsSql('$1')}`,
        [staffId, loanId],
      );
      return rows.length > 0;
    };
    check(await officerIs(rivka.id), 'filtering the pipeline by officer finds the file under Rivka');
    check(!(await officerIs(shea.id)),
      '…and NOT under Shea — which is the same file answering "whose is it?" two different ways, and why this is worth one question to the owner');
    await contacts.reassign(loanId, 'loan_officer', null, String(admin.id), null, c);

    // ── The pickable list ─────────────────────────────────────────────────────
    console.log('\nwho the screen may offer');

    const pickable = await roster.pickableStaff(c);
    const mine = pickable.filter((s) => String(s.email || '').startsWith(stamp));
    check(mine.some((s) => String(s.id) === String(rivka.id)), 'an active member of staff is offered');
    check(!mine.some((s) => String(s.id) === String(broker.id)),
      'an outside broker is NOT offered — the refusal above is the backstop, not the only defence');
    check(!mine.some((s) => String(s.id) === String(deactivated.id)),
      'nor is a deactivated person');
    check(mine.every((s) => s.name && s.id), 'each one carries the name the picker shows');

    await c.query('ROLLBACK');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    failures += 1;
    console.error('  FAIL threw:', (e && e.stack) || e);
  } finally {
    c.release();
    await db.pool.end().catch(() => {});
  }

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
