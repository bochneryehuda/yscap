/**
 * Borrower-email component scrub (src/lib/notify.js notifyBorrower).
 *
 * FROZEN RULE: a note-buyer / capital-partner name must NEVER reach a borrower.
 * The premium redesign (2026-07-20) added component objects (callout/hero/badge)
 * whose text can be STAFF-TYPED (e.g. a rejection reason in a callout). This test
 * proves every such field is scrubbed by the single notifyBorrower chokepoint —
 * not just the flat title/body/lines.
 *
 * Requires DATABASE_URL with migrations applied; skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-notification-scrub (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
process.env.EMAIL_PROVIDER = 'none';

const assert = require('assert');
const db = require('../src/db');
const email = require('../src/lib/email');
const notify = require('../src/lib/notify');

let n = 0; const ok = (m) => { n++; console.log('  ok -', m); };
const sent = [];
email.sendMail = async (m) => { sent.push(m); return { ok: true }; };

(async () => {
  const suffix = Date.now();
  const br = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Scrub','Tester',$1) RETURNING id`, ['scrub-' + suffix + '@example.com'])).rows[0];
  const app = (await db.query(
    `INSERT INTO applications (borrower_id, ys_loan_number, property_address, program, status)
     VALUES ($1,$2,$3,'gold','processing') RETURNING id`,
    [br.id, 'SC-' + suffix, JSON.stringify({ oneLine: '1 Test St, Brooklyn, NY', street: '1 Test St' })])).rows[0];

  // Every partner name below (in EVERY component slot) must be gone from the email.
  await notify.notifyBorrower(br.id, {
    type: 'doc_rejected',
    title: 'Fidelis wants "Bank statements" redone',
    badge: { text: 'RCN action', tone: 'action' },
    hero: { label: 'From Kiavi', value: 'BlueLake review', sub: 'per Churchill' },
    body: 'Churchill needs a new version.',
    lines: ['Temple View requires all pages.'],
    callout: { title: 'Why CorrFirst sent it back', body: 'BlueLake and Fidelis require the summary page from RCN.' },
    applicationId: app.id, link: `/app/${app.id}`, ctaLabel: 'Fix it', major: true });

  const m = sent[sent.length - 1];
  assert.ok(m, 'email sent');
  ['BlueLake', 'Blue Lake', 'Fidelis', 'Churchill', 'RCN', 'Temple View', 'CorrFirst', 'Kiavi'].forEach((name) =>
    assert.ok(!new RegExp(name, 'i').test(m.html), 'partner name "' + name + '" scrubbed from the whole email (incl. callout/hero/badge)'));
  assert.ok(!/BlueLake|Fidelis|Churchill|RCN|Kiavi|Temple View|CorrFirst/i.test(m.subject), 'subject clean');
  // Content still renders — just with the program name substituted.
  assert.ok(/Gold Standard program/.test(m.html), 'partner names replaced with the program name');
  assert.ok(/Why .* sent it back/.test(m.html) && /require the summary page/.test(m.html), 'callout still renders (scrubbed, not dropped)');
  ok('borrower email scrubs partner names in title, body, lines, callout, hero, and badge');

  await db.query(`DELETE FROM notifications WHERE application_id=$1`, [app.id]).catch(() => {});
  await db.query(`DELETE FROM applications WHERE id=$1`, [app.id]).catch(() => {});
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [br.id]).catch(() => {});

  console.log(`\nAll ${n} notification-scrub checks passed.`);
  await db.pool.end();
})().catch((e) => { console.error('FAIL:', e.message, e.stack); process.exit(1); });
