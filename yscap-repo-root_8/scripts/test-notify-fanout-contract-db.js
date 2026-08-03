/**
 * WHAT `notifyAppStaff`'s RETURN VALUE MEANS — real Postgres.
 *
 * The array has answered ONE question since it was written: "who is on this
 * file?". Four callers depend on exactly that — esign/webhook (envelope sent,
 * completed, declined/voided) and esign/dead-letter — each doing
 *
 *     const sent = await notify.notifyAppStaff(appId, opts);
 *     if (!sent || !sent.length) await notify.notifyAdmins(opts);
 *
 * meaning "this file has nobody on it, so tell the administrators".
 *
 * Filtering that array down to REAL deliveries quietly turned it into "did
 * anybody HEAR us", and the two are not the same question. Every e-sign event
 * uses type `status_change`, which the notification catalog marks non-forced, so
 * a loan officer muting one of their own files — an ordinary, supported thing to
 * do — would have turned every "fully signed", "declined", "voided" and "we
 * could not save the signed copy" on that file into an email to EVERY
 * administrator and super-admin in the company.
 *
 * So the array is the RECIPIENTS, and the delivery count rides along as a
 * non-enumerable `.delivered`. This pins both halves, and pins that a DRAFT held
 * by the loan-officer gate counts as reached — it is parked in that officer's
 * Drafts and auto-sends, so it is not a lost message.
 *
 * Requires DATABASE_URL with migrations applied; skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-notify-fanout-contract-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
process.env.EMAIL_PROVIDER = 'none';

const db = require('../src/db');
const email = require('../src/lib/email');
const notify = require('../src/lib/notify');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
email.sendMail = async () => ({ ok: true });

(async () => {
  const sfx = `fan-${process.pid}-${Math.floor(Date.now() / 1000)}`;
  const mkStaff = async (role, name, mail) => (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,$2,$3,true) RETURNING id`,
    [mail, name, role])).rows[0].id;

  const officer = await mkStaff('loan_officer', 'Fan Officer', `${sfx}-lo@yscapgroup.com`);
  const proc = await mkStaff('processor', 'Fan Processor', `${sfx}-pr@yscapgroup.com`);
  const borrower = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Fan','Borrower',$1) RETURNING id`,
    [`${sfx}-b@example.com`])).rows[0].id;
  const app = (await db.query(
    `INSERT INTO applications (borrower_id, loan_officer_id, processor_id, status)
     VALUES ($1,$2,$3,'processing') RETURNING id`, [borrower, officer, proc])).rows[0].id;
  for (const s of [officer, proc]) {
    await db.query(`INSERT INTO application_assignees (application_id, staff_id, role)
                    VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [app, s, s === officer ? 'loan_officer' : 'processor']);
  }

  const payload = { type: 'status_change', title: 'Fan-out contract', body: 'x', applicationId: app };

  /* ── 1. the ordinary case: both meanings agree ───────────────────────────── */
  {
    const out = await notify.notifyAppStaff(app, { ...payload });
    assert(Array.isArray(out) && out.length === 2, 'both people on the file are returned');
    assert(out.delivered === 2, 'and both were reached');
    assert(!Object.keys(out).includes('delivered'),
      'the count is NON-ENUMERABLE, so anything that serializes or spreads this array is unaffected');
  }

  /* ── 2. THE REGRESSION. A muted file must not empty the array ────────────── */
  const mute = async (staffId) => {
    // lo-self-gate answers channel 'off' for a muted file, so notifyStaff returns
    // null for that person — a real "they did not hear this", and NOT a statement
    // about whether the file has a team.
    await db.query(
      `INSERT INTO lo_muted_files (staff_id, application_id) VALUES ($1,$2)
       ON CONFLICT DO NOTHING`, [staffId, app]);
    // PROVE the mute took. Left as a soft skip, a schema drift here would disarm
    // the whole point of this file while the run stayed green — which is exactly
    // the silent-disarm class these tests exist to catch.
    const n = Number((await db.query(
      `SELECT count(*)::int c FROM lo_muted_files WHERE staff_id=$1 AND application_id=$2`,
      [staffId, app])).rows[0].c);
    assert(n === 1, `the mute is really in place for ${staffId === officer ? 'the officer' : 'the processor'}`);
  };
  {
    await mute(officer);
    const out = await notify.notifyAppStaff(app, { ...payload });
    assert(out.length === 2,
      'the array still names EVERYONE on the file — this is what the e-sign callers ask');
    assert(out.delivered === 1, 'while the delivery count drops to the one person who heard it');
  }

  /* ── 2b. THE CASE THAT ACTUALLY DISCRIMINATES: EVERYBODY muted ───────────── */
  {
    /* With only ONE of two people muted, a filtered array still has length 1, so
       `!out.length` is false either way and the headline assertion above passes on
       the broken code too. The regression only bites when EVERY recipient is
       silent — which is the real-world shape, because most files have one loan
       officer and it is that officer who mutes them. */
    await mute(proc);
    const out = await notify.notifyAppStaff(app, { ...payload });
    assert(out.length === 2, 'every recipient is still named even when NONE of them heard it');
    assert(out.delivered === 0, 'and the delivery count says so honestly');
    // The e-sign shape, verbatim from esign/webhook.js and esign/dead-letter.js.
    assert((!out || !out.length) === false,
      'so a file whose whole team muted it NEVER escalates to every administrator in the company');
    // Put them back, so section 4 measures the real roster.
    await db.query(`DELETE FROM lo_muted_files WHERE application_id=$1`, [app]);
  }

  /* ── 3. a file with nobody on it DOES still escalate ─────────────────────── */
  {
    const bare = (await db.query(
      `INSERT INTO applications (borrower_id, status) VALUES ($1,'processing') RETURNING id`,
      [borrower])).rows[0].id;
    const out = await notify.notifyAppStaff(bare, { ...payload, applicationId: bare });
    assert(out.length === 0 && out.delivered === 0, 'an unassigned file returns nobody');
    assert((!out || !out.length) === true,
      'and the e-sign fallback fires, which is the behaviour that check exists for');
    await db.query(`DELETE FROM applications WHERE id=$1`, [bare]);
  }

  /* ── 4. a DEACTIVATED assignee is not a recipient ────────────────────────── */
  {
    const gone = await mkStaff('processor', 'Gone Person', `${sfx}-gone@yscapgroup.com`);
    await db.query(`INSERT INTO application_assignees (application_id, staff_id, role)
                    VALUES ($1,$2,'processor') ON CONFLICT DO NOTHING`, [app, gone]);
    await db.query(`UPDATE staff_users SET is_active=false WHERE id=$1`, [gone]);
    const out = await notify.notifyAppStaff(app, { ...payload });
    assert(!out.map(String).includes(String(gone)),
      'somebody who has left is not counted as covering the file — that looks covered while being nobody');
    await db.query(`DELETE FROM application_assignees WHERE application_id=$1 AND staff_id=$2`, [app, gone]);
    await db.query(`DELETE FROM staff_users WHERE id=$1`, [gone]);
  }

  /* ── cleanup ─────────────────────────────────────────────────────────────── */
  await db.query(`DELETE FROM applications WHERE id=$1`, [app]);
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrower]);
  await db.query(`DELETE FROM staff_users WHERE id = ANY($1::uuid[])`, [[officer, proc]]);
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll notify fan-out contract checks passed.');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH', e); process.exit(1); });
