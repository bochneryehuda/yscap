'use strict';
/*
 * Raise-an-issue vs post-a-condition (owner-directed 2026-08-04, items #24/#25).
 *
 *  #24 — "Raise an issue" is INTERNAL only: audience='staff', the borrower is NOT
 *        notified and does NOT see it. Only an explicit "Post a condition"
 *        (postCondition=true) creates a borrower-facing condition and emails them.
 *  #25 — a condition posted on a track-record item leads with the SUBJECT loan and
 *        frames the track-record property as context — never "a condition on <that
 *        address>". The email title carries no track-record address.
 *
 * Requires DATABASE_URL with migrations applied; skips cleanly otherwise.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
process.env.EMAIL_PROVIDER = 'none';
if (!process.env.DATABASE_URL) { console.log('SKIP test-raise-issue-db (no DATABASE_URL)'); process.exit(0); }

const assert = require('assert');
const db = require('../src/db');
const email = require('../src/lib/email');
const { raiseEntityIssue } = require('../src/lib/raise-issue');

let n = 0; const ok = (m) => { n++; console.log('  ok -', m); };
const sent = [];
email.sendMail = async (m) => { sent.push(m); return { ok: true }; };
const reset = () => { sent.length = 0; };
const toBorrower = (e) => sent.find((x) => (Array.isArray(x.to) ? x.to : [x.to]).includes(e));

(async () => {
  const suffix = Date.now();
  const bemail = `ri-borrower-${suffix}@example.com`;
  const subjectStreet = '3091 Patricia Ct';
  const trAddr = '169 Schooner Ave';
  const br = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Raise','Tester',$1) RETURNING id`, [bemail])).rows[0];
  const app = (await db.query(
    `INSERT INTO applications (borrower_id, ys_loan_number, property_address, program, loan_type, status)
     VALUES ($1,$2,$3,'gold','purchase','processing') RETURNING id`,
    [br.id, `RI-${suffix}`, JSON.stringify({ street: subjectStreet, line1: subjectStreet, city: 'Manchester', state: 'NJ', oneLine: `${subjectStreet}, Manchester, NJ` })])).rows[0];
  const tr = (await db.query(
    `INSERT INTO track_records (borrower_id, property_address) VALUES ($1,$2) RETURNING id`,
    [br.id, JSON.stringify({ street: trAddr, line1: trAddr, city: 'Barnegat', state: 'NJ', oneLine: `${trAddr}, Barnegat, NJ` })])).rows[0];

  const itemAudience = async (id) => (await db.query(`SELECT audience FROM checklist_items WHERE id=$1`, [id])).rows[0].audience;

  /* 1) RAISE AN ISSUE (default) — internal only, no borrower email. */
  reset();
  const r1 = await raiseEntityIssue({ appId: app.id, entityKind: 'track_record', entityId: tr.id, entityName: trAddr, reason: 'possible duplicate line', actorId: null });
  assert.ok(r1.itemId && r1.borrowerFacing === false, 'raise-issue is not borrower-facing');
  assert.equal(await itemAudience(r1.itemId), 'staff', 'raised issue is an internal (audience=staff) item');
  assert.ok(!toBorrower(bemail), 'raising an issue sends NO borrower email (the #24 bombardment)');
  ok('#24: raise an issue is internal — audience=staff, no borrower email');

  /* 2) POST A CONDITION on the SAME item — upgrades to borrower-facing + notifies. */
  reset();
  const r2 = await raiseEntityIssue({ appId: app.id, entityKind: 'track_record', entityId: tr.id, entityName: trAddr, reason: 'possible duplicate line', actorId: null, postCondition: true });
  assert.equal(r2.itemId, r1.itemId, 'posting a condition on the same reason reuses the row');
  assert.ok(r2.borrowerFacing === true, 'post-condition is borrower-facing');
  assert.equal(await itemAudience(r2.itemId), 'both', 'audience upgraded staff -> both when a condition is posted');
  const em = toBorrower(bemail);
  assert.ok(em, 'posting a condition emails the borrower');
  // #25: the message leads with the SUBJECT loan, not the track-record address.
  assert.ok(!/169 Schooner|Schooner Ave/i.test(em.subject || ''), 'the email SUBJECT does not lead with the track-record address');
  const body = String(em.html || '') + String(em.text || '');
  assert.ok(/on your loan/i.test(body), 'the body says the condition is on THEIR loan');
  assert.ok(/track record/i.test(body) && body.includes(trAddr), 'the body frames the track-record property as context');
  ok('#25: posted condition leads with the subject loan; track-record address is only context');

  /* 3) A re-raise (postCondition=false) never LOWERS a borrower-facing item back to internal. */
  reset();
  const r3 = await raiseEntityIssue({ appId: app.id, entityKind: 'track_record', entityId: tr.id, entityName: trAddr, reason: 'possible duplicate line', actorId: null });
  assert.equal(await itemAudience(r3.itemId), 'both', 'a re-raise never hides an already-posted borrower condition');
  assert.ok(!toBorrower(bemail), 'and a plain re-raise does not re-email the borrower');
  ok('audience is only ever raised (staff->both), never lowered; re-raise is quiet');

  await db.query(`DELETE FROM checklist_items WHERE application_id=$1`, [app.id]).catch(() => {});
  await db.query(`DELETE FROM track_records WHERE id=$1`, [tr.id]).catch(() => {});
  await db.query(`DELETE FROM applications WHERE id=$1`, [app.id]).catch(() => {});
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [br.id]).catch(() => {});

  console.log(`\nAll raise-issue checks passed (${n}).`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
