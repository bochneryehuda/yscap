/**
 * Email SUBJECT never doubles the loan number (or any file-tag segment), and the
 * subject tag follows the owner's preferred layout: loan number · borrower name ·
 * property (src/lib/email/template.js dedup guard + src/lib/notify.js fileContext).
 *
 * Owner-reported 2026-07-20 ("MAJOR issue"): subjects like
 *   "Product registered on YSCAP258134728 · YSCAP258134728 · 27 Beacon St"
 * showed the loan number TWICE — the title hand-embedded it and the auto subject
 * tag appended it again. Fixed structurally: the subject appends only the tag
 * segments not already present in the title, so nothing is ever doubled; the tag
 * is loan# · borrower name · street for staff (borrower's own email drops the name).
 *
 * The template checks need no DB; the fileContext checks require DATABASE_URL.
 */
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
process.env.EMAIL_PROVIDER = 'none';

const assert = require('assert');
const tpl = require('../src/lib/email/template');

let n = 0; const ok = (m) => { n++; console.log('  ok -', m); };

// ---- Template dedup guard (no DB) ----
(function () {
  // A title that ALREADY embeds the loan number must not repeat it.
  let s = tpl.render({ title: 'Product registered on YSCAP258134728', subjectTag: 'YSCAP258134728 · John Doe · 27 Beacon St' }).subject;
  assert.strictEqual((s.match(/YSCAP258134728/g) || []).length, 1, 'the loan number appears exactly ONCE in the subject');
  assert.ok(s.includes('John Doe') && s.includes('27 Beacon St'), 'the borrower name + property are still appended');
  ok('a title embedding the loan number does not double it (' + s + ')');

  // A clean title gets the full preferred layout appended.
  s = tpl.render({ title: 'Product registered', subjectTag: 'YSCAP258134728 · John Doe · 27 Beacon St' }).subject;
  assert.strictEqual(s, 'Product registered · YSCAP258134728 · John Doe · 27 Beacon St', 'clean title → loan# · name · property');
  ok('a clean title yields the preferred layout: loan# · name · property');

  // A borrower-name already in the title (e.g. "John Doe answered …") isn't doubled.
  s = tpl.render({ title: 'John Doe answered "Bank statements"', subjectTag: 'YSCAP258134728 · John Doe · 27 Beacon St' }).subject;
  assert.strictEqual((s.match(/John Doe/g) || []).length, 1, 'the borrower name is not doubled either');
  ok('any repeated segment (name/street/loan#) is de-duplicated, not just the loan number');

  // No subject tag → just the title (unchanged back-compat).
  assert.strictEqual(tpl.render({ title: 'Hello', subjectTag: '' }).subject, 'Hello', 'no tag → plain title');
  ok('an email with no subject tag is byte-identical to before');
})();

// ---- fileContext subject-tag layout (DB) ----
if (!process.env.DATABASE_URL) { console.log(`\nSKIP fileContext layout checks (no DATABASE_URL). ${n} template checks passed.`); process.exit(0); }
const db = require('../src/db');
const notify = require('../src/lib/notify');

(async () => {
  const sfx = `${process.pid}-${Math.floor(Date.now() / 1000)}`;
  const loanNo = `YSCAP-DEDUP-${sfx}`;
  let br, app;
  try {
    br = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Jane','Roe',$1) RETURNING id`, [`dedup-b-${sfx}@example.com`])).rows[0].id;
    app = (await db.query(
      `INSERT INTO applications (borrower_id, ys_loan_number, property_address, status)
       VALUES ($1,$2,$3,'processing') RETURNING id`,
      [br, loanNo, JSON.stringify({ oneLine: '27 Beacon St, Boston, MA', street: '27 Beacon St' })])).rows[0].id;

    const ctx = await notify.fileContext(app);
    assert.ok(ctx, 'fileContext resolves');
    assert.strictEqual(ctx.subjectTag, `${loanNo} · Jane Roe · 27 Beacon St`, 'STAFF subject tag = loan# · borrower name · street');
    assert.strictEqual(ctx.borrowerSubjectTag, `${loanNo} · 27 Beacon St`, 'BORROWER subject tag drops their own name = loan# · street');
    ok('staff tag is loan# · name · property; the borrower\'s own email drops their name');

    // End-to-end: a staff email whose title embeds the loan number shows it once.
    const email = require('../src/lib/email');
    const sent = [];
    email.sendMail = async (m) => { sent.push(m); return { ok: true }; };
    const st = (await db.query(`INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Dedup Admin','admin',true) RETURNING id`, [`dedup-a-${sfx}@yscapgroup.com`])).rows[0].id;
    await db.query(`INSERT INTO application_assignees (application_id, staff_id, role, is_primary) VALUES ($1,$2,'loan_officer',true) ON CONFLICT DO NOTHING`, [app, st]).catch(() => {});
    await notify.notifyStaff(st, { type: 'product_registered', title: `Product registered on ${loanNo}`, applicationId: app, emailTo: `dedup-a-${sfx}@yscapgroup.com` });
    const m = sent.find((x) => (Array.isArray(x.to) ? x.to : [x.to]).includes(`dedup-a-${sfx}@yscapgroup.com`));
    assert.ok(m, 'staff email sent');
    assert.strictEqual((m.subject.match(new RegExp(loanNo, 'g')) || []).length, 1, 'end-to-end: the loan number is in the subject exactly once');
    ok('end-to-end staff email never doubles the loan number in the subject');
    await db.query(`DELETE FROM notifications WHERE staff_id=$1`, [st]).catch(() => {});
    await db.query(`DELETE FROM staff_users WHERE id=$1`, [st]).catch(() => {});

    console.log(`\nAll ${n} subject-dedup checks passed.`);
  } finally {
    if (app) { await db.query(`DELETE FROM notifications WHERE application_id=$1`, [app]).catch(() => {});
      await db.query(`DELETE FROM application_assignees WHERE application_id=$1`, [app]).catch(() => {});
      await db.query(`DELETE FROM applications WHERE id=$1`, [app]).catch(() => {}); }
    if (br) await db.query(`DELETE FROM borrowers WHERE id=$1`, [br]).catch(() => {});
    await db.pool.end();
  }
})().catch((e) => { console.error('FAIL:', e.message, e.stack); process.exit(1); });
