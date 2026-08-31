'use strict';
/**
 * LT — THE OFFICER'S BRANDING ACTUALLY REACHES THE TERM SHEET (owner-directed
 * 2026-08-31: *"We need to add loan officer branding on the term sheets ... their
 * contact information, their name, their phone numbers, their emails, and their
 * own branding on all the term sheets that they issue and all the comparison PDFs
 * that they issue."*).
 *
 * ⛔ THIS SUITE EXISTS BECAUSE THE LAYOUT WAS NEVER THE BROKEN HALF. The snapshot
 * has accepted the five officer fields since it shipped, `layout.recipientBlock`
 * assembles them, and `pdf.js` draws them — so a test of any of those would have
 * passed all along while every issued sheet went out with no officer on it. The
 * break was one step earlier: `preparedFrom` read the officer off `req.actor`, and
 * `authenticate` puts only `{id, kind, role, sid}` there, so all five resolved to
 * null and the column filtered to empty. An empty column draws nothing and reads
 * as a design choice, which is why it survived.
 *
 * So this drives the two functions the defect lived BETWEEN, against a real
 * roster row, and then follows the values all the way onto the drawn page.
 *
 * DB-GATED: with no DATABASE_URL it SKIPS and says so.
 */

if (!process.env.DATABASE_URL) {
  console.log('SKIP test-lt-officer-branding-db — no DATABASE_URL');
  process.exit(0);
}

const db = require('../src/longterm/db');
const route = require('../src/longterm/routes/term-sheet');
const layout = require('../src/longterm/termsheet/layout');
const { ensureSchema } = require('../src/migrate-boot');

const { loadOfficer, preparedFrom } = route._internals;

let bad = 0;
const ok = (c, m) => { if (c) console.log(`  ok   ${m}`); else { bad += 1; console.error(`  FAIL ${m}`); } };
const section = (t) => console.log(`\n${t}`);

const U = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const OFFICER = {
  full_name: 'Sara Klein', title: 'Senior Loan Officer',
  phone: '(732) 555-0142', nmls: '1234567',
};

(async () => {
  await ensureSchema();

  const email = `lt-brand-${U}@yscapgroup.com`;
  const id = (await db.query(
    `INSERT INTO staff_users (id, email, full_name, role, title, phone, nmls)
     VALUES (gen_random_uuid(), $1, $2, 'loan_officer', $3, $4, $5) RETURNING id`,
    [email, OFFICER.full_name, OFFICER.title, OFFICER.phone, OFFICER.nmls],
  )).rows[0].id;

  // ==========================================================================
  section('A. the roster read — the half that did not exist');
  // ==========================================================================
  const req = { actor: { id, kind: 'staff', role: 'loan_officer' } };
  const row = await loadOfficer(req);
  ok(row.full_name === OFFICER.full_name, `A1 the officer's name comes back (${row.full_name})`);
  ok(row.title === OFFICER.title && row.phone === OFFICER.phone, 'A2 …with their title and phone');
  ok(row.nmls === OFFICER.nmls && row.email === email, 'A3 …their NMLS and their email');

  /* ⛔ THE ACTOR ALONE PROVES THE BUG. Exactly what the route had before: an actor
     carrying only what `authenticate` puts on it, and nothing else. */
  const beforeFix = preparedFrom(req, { settings: {} }, {}, null, {});
  ok(beforeFix.officerName == null && beforeFix.officerPhone == null && beforeFix.officerNmls == null,
    'A4 ⛔ with only the actor — the state every sheet shipped in — the officer is entirely blank');

  const afterFix = preparedFrom(req, { settings: {} }, {}, null, row);
  ok(afterFix.officerName === OFFICER.full_name, 'A5 …and with the roster row it is filled');
  ok(afterFix.officerTitle === OFFICER.title && afterFix.officerPhone === OFFICER.phone
    && afterFix.officerNmls === OFFICER.nmls && afterFix.officerEmail === email,
    'A6 …every one of the five the owner named');

  // ==========================================================================
  section('B. it is the ROSTER that wins, never the client');
  // ==========================================================================
  {
    /* A term sheet naming somebody else as the officer is a document we cannot
       stand behind, so a body that tries is ignored — the original contract, now
       actually reachable because the roster finally supplies a value to prefer. */
    const forged = preparedFrom(req, { settings: {} },
      { prepared: { officerName: 'Somebody Else', officerNmls: '9999999', officerPhone: '(000) 000-0000' } },
      null, row);
    ok(forged.officerName === OFFICER.full_name, 'B1 ⛔ a name posted by the client does not become the officer');
    ok(forged.officerNmls === OFFICER.nmls && forged.officerPhone === OFFICER.phone,
      'B2 …nor their NMLS or their phone');
  }

  // ==========================================================================
  section('C. an unreadable roster costs the letterhead and nothing else');
  // ==========================================================================
  {
    const gone = await loadOfficer({ actor: { id: '00000000-0000-0000-0000-000000000000' } });
    ok(gone && typeof gone === 'object' && gone.full_name === undefined,
      'C1 an officer who is not on the roster answers an empty object, never a throw');
    ok((await loadOfficer({ actor: { id: 'not-a-uuid' } })).full_name === undefined,
      'C2 …and junk is caught rather than raised — a sheet is never refused over its letterhead');
    ok((await loadOfficer({})).full_name === undefined, 'C3 …nor is a request with no actor at all');
  }

  // ==========================================================================
  section('D. and it reaches the PAPER, which is the only thing the owner sees');
  // ==========================================================================
  {
    const snap = {
      docKind: 'term_sheet',
      prepared: afterFix,
      members: [{ scenario: { propertyType: 'Single family', value: 500000 } }],
    };
    const blocks = layout.buildLayout(snap, { expiryHours: 24 }).blocks;
    const recipient = blocks.find((b) => b.t === 'recipient');
    ok(!!recipient, 'D1 the document has a recipient block');
    const officerLines = (recipient && recipient.officer) || [];
    const joined = officerLines.join(' | ');
    ok(officerLines.length > 0, `D2 …carrying an officer column (${officerLines.length} lines)`);
    ok(joined.includes(OFFICER.full_name), 'D3 the officer is NAMED on the sheet');
    ok(joined.includes(OFFICER.title), 'D4 …with their title');
    ok(joined.includes(OFFICER.phone) && joined.includes(email), 'D5 …their phone and their email');
    ok(/NMLS #1234567/.test(joined), 'D6 …and their NMLS, written as an NMLS number');

    /* ⛔ THE CONTROL. The same layout, on the blank officer the route produced
       before the fix, must draw NOTHING — otherwise D2–D6 would pass on a sheet
       that had lost the officer and nobody would know. */
    const blank = layout.buildLayout(
      { docKind: 'term_sheet', prepared: beforeFix, members: snap.members }, { expiryHours: 24 },
    ).blocks.find((b) => b.t === 'recipient');
    ok(((blank && blank.officer) || []).length === 0,
      'D7 ⛔ CONTROL — before the fix the same layout draws an EMPTY officer column, silently');
  }

  await db.query('DELETE FROM staff_users WHERE id = $1::uuid', [id]);
  console.log('');
  if (bad) { console.error(`${bad} FAILED`); process.exit(1); }
  console.log('ALL PASSED');
  process.exit(0);
})().catch((e) => { console.error('crashed:', e); process.exit(1); });
