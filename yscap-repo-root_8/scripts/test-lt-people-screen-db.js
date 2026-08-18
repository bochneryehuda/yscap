'use strict';
/**
 * PROOF of the PEOPLE screen — what an admin actually reads before deciding that
 * an Encompass login belongs to a particular person at this company.
 *
 * Ninth thread from the coverage sweep. `roster.listPeople` assembles that whole
 * screen and had never executed in any suite. Its siblings are covered — the
 * roster sync and both link writers were pinned earlier on this branch — but the
 * READ that a human looks at was not.
 *
 * That decision is not cosmetic. A confirmed link is what decides whose pipeline
 * every long-term file lands in, so what this screen shows is the evidence the
 * decision is made on. Three things on it were written by the sync and read by
 * NOTHING until they were put here, which means each one can vanish without a
 * single test noticing:
 *
 *   · THE ROLES. "Is this Nussbaum the loan officer or the closer?" is answered by
 *     what Encompass says they DO. Without them a reviewer is matching on a name
 *     alone, and this tenant has several people who share one.
 *   · WHY A ROW HAS NO PROPOSAL. A row that is simply blank tells an admin
 *     nothing and invites them to guess. It must say why the machine would not
 *     propose — and it must be null on a row that IS linked, or every linked row
 *     carries a stale explanation of a state it is no longer in.
 *   · WHO CONFIRMED IT, and when. The same class of record as a file
 *     reassignment. An id we can no longer put a name to travels AS THE ID rather
 *     than as a blank — somebody leaving the company must not erase who made a
 *     decision.
 *
 * DB-GATED: skips cleanly with no database, like every other suite in the chain.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const assert = require('assert');
const path = require('path');

async function main() {
  await require(path.join(__dirname, 'lib', 'db-gate')).skipUnlessDb('lt-people-screen');

  const db = require('../src/db');
  const ltDb = require('../src/longterm/db');
  const roster = require('../src/longterm/people/roster');

  let checks = 0;
  const ok = (c, w) => { assert.ok(c, w); checks++; };
  const eq = (a, b, w) => { assert.strictEqual(a, b, w); checks++; };
  // A deep comparison that carries its OWN sentence. Without it the first draft of
  // this suite put `assert.deepStrictEqual(...)` on one line and `ok(true, '…')` on
  // the next — so the check that could fail had no words, and the words were
  // attached to a check that could not. A label on a tautology is worse than no
  // label: it reads, and counts, as proof of something nothing verified.
  const same = (a, b, w) => { assert.deepStrictEqual(a, b, w); checks++; };

  const stamp = `ltps-${Date.now().toString(36)}`;
  const logins = [];
  const staffIds = [];

  const seedStaff = async (name, role, { active = true, external = false } = {}) => {
    const { rows } = await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [`${stamp}-${name.replace(/\W+/g, '')}@example.test`, name, role, active],
    );
    staffIds.push(rows[0].id);
    return String(rows[0].id);
  };

  const seedLogin = async (loginId, fullName, { roles = [], active = true } = {}) => {
    await ltDb.query(
      `INSERT INTO lt_encompass_users (login_id, full_name, email, personas, role_names, is_active, encompass_synced_at)
       VALUES ($1, $2, $3, $4::text[], $5::text[], $6, now())`,
      [loginId, fullName, `${loginId}@example.test`, ['Loan Officer'], roles, active],
    );
    logins.push(loginId);
    return loginId;
  };

  try {
    const decider = await seedStaff('WS Screen Decider', 'super_admin');
    const linked = await seedStaff('WS Screen Linked', 'loan_officer');
    const departed = await seedStaff('WS Screen Departed', 'loan_officer');
    // A SECOND linked person, because lt_staff_links_confirmed_staff_uk allows one
    // PILOT person exactly one confirmed Encompass login — reusing the first here
    // is not a fixture detail, it is the rule saying no.
    const linked2 = await seedStaff('WS Screen Linked Two', 'processor');

    // 1. A login CONFIRMED to a person, by a decider we can still name.
    const confirmedLogin = await seedLogin(`${stamp}-confirmed`, 'A Confirmed Person',
      { roles: ['Loan Officer', 'Closer'] });
    await ltDb.query(
      `INSERT INTO lt_staff_links (encompass_login_id, staff_id, status, match_method, confirmed_by, confirmed_at)
       VALUES ($1, $2::uuid, 'confirmed', 'manual', $3::uuid, now())`,
      [confirmedLogin, linked, decider],
    );

    // 2. A login confirmed by somebody who has since LEFT — deactivated, which is
    //    what this application actually does to a departing member of staff. It
    //    never hard-deletes one, and that matters here: `confirmed_by` is
    //    ON DELETE SET NULL, so a real deletion would take the id away before the
    //    screen ever saw it.
    const orphanLogin = await seedLogin(`${stamp}-orphan`, 'A Decision By Somebody Gone', { roles: ['Funder'] });
    await ltDb.query(
      `INSERT INTO lt_staff_links (encompass_login_id, staff_id, status, match_method, confirmed_by, confirmed_at)
       VALUES ($1, $2::uuid, 'confirmed', 'manual', $3::uuid, now())`,
      [orphanLogin, linked2, departed],
    );

    // 3. A login nobody has decided anything about, whose name matches NOBODY.
    const strangerLogin = await seedLogin(`${stamp}-stranger`, 'Nobody Of That Name At All',
      { roles: ['Underwriter'] });

    // The decider leaves the company AFTER making their decision.
    await db.query('UPDATE staff_users SET is_active = false WHERE id = $1::uuid', [departed]);

    const out = await roster.listPeople();
    const by = new Map(out.people.map((p) => [p.loginId, p]));

    ok(out && Array.isArray(out.people), 'the screen assembles at all');
    ok(out.total === out.people.length, 'the total is the list it is a total of');

    // ── A. THE ROLES — THE EVIDENCE THE DECISION IS MADE ON ───────────────
    const confirmed = by.get(confirmedLogin);
    ok(confirmed, 'the confirmed login is on the screen');
    same(confirmed.roles, ['Loan Officer', 'Closer'],
      'THE ONE THAT MATTERS: what Encompass says this person DOES reaches the screen — "is this the loan officer or the closer?" is answered by the roles, and without them a reviewer is matching on a name alone');
    same(by.get(strangerLogin).roles, ['Underwriter'],
      '…on an undecided row too, which is the row where a reviewer needs it most');

    // ── B. WHO DECIDED, AND WHAT HAPPENS WHEN THEY LEAVE ──────────────────
    eq(confirmed.confirmedBy, decider, 'the person who confirmed the link is recorded');
    ok(confirmed.confirmedByName && /Decider/.test(confirmed.confirmedByName),
      '…and NAMED, because an id is not something a human reads');
    ok(confirmed.confirmedAt, '…with when they decided it');

    const orphan = by.get(orphanLogin);
    eq(orphan.confirmedBy, departed,
      'THE ONE THAT MATTERS: a decision made by somebody who has since left still carries their id — who made a decision does not change when they go');
    ok(orphan.confirmedByName && /Departed/.test(orphan.confirmedByName),
      'THE ONE THAT MATTERS: …and they are still NAMED. The staff list this resolves against filters on external accounts only, never on active, so deactivating somebody does not turn every decision they ever made into an unreadable id');

    // ── C. WHY A ROW HAS NO PROPOSAL ──────────────────────────────────────
    const stranger = by.get(strangerLogin);
    eq(stranger.status, 'none', 'a login nobody has decided anything about has no status');
    ok(stranger.whyNoMatch,
      'THE ONE THAT MATTERS: …and the screen SAYS why the machine would not propose anybody — a blank row tells an admin nothing and invites them to guess');
    eq(confirmed.whyNoMatch, null,
      '…while a row that IS linked carries no explanation, so no linked row shows a stale reason for a state it is not in');

    // ── D. THE LINKED PERSON IS RESOLVED, NOT JUST REFERENCED ─────────────
    ok(confirmed.staff && confirmed.staff.id === linked, 'a confirmed row names the PILOT person it points at');
    ok(confirmed.staff.name && confirmed.staff.email, '…with enough to recognise them without a second lookup');
    eq(stranger.staff, null, 'and an undecided row points at nobody rather than at a guess');

    // ── E. THE PICKABLE LIST ──────────────────────────────────────────────
    ok(Array.isArray(out.staff) && out.staff.length > 0,
      'the people who may be picked ride along, so offering a manual link costs no second call');
    ok(out.staff.some((s) => s.id === linked), '…including an ordinary active member of staff');
    ok(!out.staff.some((s) => s.id === departed),
      'THE ONE THAT MATTERS: …and never somebody who has been deactivated, who would route files to nobody while looking like a real assignment on screen — note this is the OPPOSITE rule from naming them above, and deliberately so: you may not PICK somebody who has left, but you must still be able to READ what they decided');

    // ── F. THE COUNTS ARE OF THE LIST ITSELF ──────────────────────────────
    const summed = Object.values(out.counts).reduce((a, b) => a + b, 0);
    eq(summed, out.total,
      'the counts add up to the list — a summary that disagrees with the rows beneath it is worse than no summary');
    ok((out.counts.confirmed || 0) >= 2, '…with both confirmed rows counted as confirmed');
  } finally {
    if (logins.length) {
      await ltDb.query('DELETE FROM lt_staff_links WHERE encompass_login_id = ANY($1::text[])', [logins]).catch(() => {});
      await ltDb.query('DELETE FROM lt_encompass_users WHERE login_id = ANY($1::text[])', [logins]).catch(() => {});
    }
    if (staffIds.length) {
      await db.query('DELETE FROM staff_users WHERE id = ANY($1::uuid[])', [staffIds]).catch(() => {});
    }
    await Promise.race([
      Promise.all([db.pool.end().catch(() => {}), ltDb.pool.end().catch(() => {})]),
      new Promise((r) => setTimeout(r, 3000).unref()),
    ]);
  }

  console.log(`\n✓ lt people screen (db): ${checks} assertions passed`);
}

main().catch((e) => {
  console.error('✗ lt people screen (db) FAILED');
  console.error(e);
  process.exit(1);
});
