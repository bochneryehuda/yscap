/**
 * #150 — loan-officer branding in outbound email: per-message From display
 * name ("<Officer> — YS Capital <no-reply@…>"), officer contact block on the
 * invites, and the NEW borrower terms email on staff register (type
 * 'term_sheet', from/reply-to the assigned officer).
 * Run: node scripts/test-lo-branding.js
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://yscap:yscap@127.0.0.1:5432/yscap_test';
process.env.JWT_SECRET = 'test-secret-branding';
process.env.EMAIL_PROVIDER = 'none';
process.env.NODE_ENV = 'test';
process.env.NOTIFY_FROM = 'YS Capital Group <no-reply@yscapgroup.com>';

const http = require('http');
const crypto = require('crypto');
const REPO = __dirname + '/..';
const db = require(REPO + '/src/db');
const C = require(REPO + '/src/lib/crypto.js');
const PORT = 5693;
const uuid = () => crypto.randomUUID();
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL', m); } };

function api(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
      res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? (() => { try { return JSON.parse(b); } catch { return b; } })() : null })); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

async function main() {
  // (1) fromWithName unit checks.
  const email = require(REPO + '/src/lib/email');
  ok(email.fromWithName('Chaim Klein') === '"Chaim Klein — YS Capital" <no-reply@yscapgroup.com>',
    `fromWithName formats the branded From (got ${email.fromWithName('Chaim Klein')})`);
  ok(email.fromWithName('') === null && email.fromWithName(null) === null, 'empty name → null (default From)');
  const evil = email.fromWithName('Evil <spoof@x.com>');
  ok(/^"[^"<>]*" <no-reply@yscapgroup\.com>$/.test(evil), `angle brackets stripped from the display name (no header injection) — got ${evil}`);

  // (2) the invite builders carry the officer contact block.
  const mail = require(REPO + '/src/lib/email/catalog');
  const officer = { name: 'Chaim Klein', title: 'Senior Loan Officer', email: 'chaim@yscapgroup.com', phone: '929-555-0101', nmls: '1234567' };
  let built = mail.borrowerInvite({ firstName: 'B', inviter: 'Chaim Klein', acceptUrl: 'https://x/accept', officer });
  ok(built.html.includes('Chaim Klein') && built.html.includes('929-555-0101') && built.html.includes('NMLS #1234567'),
    'borrowerInvite carries the officer name + phone + NMLS');
  built = mail.coBorrowerInvite({ firstName: 'C', primaryName: 'B', acceptUrl: 'https://x/accept', officer });
  ok(built.html.includes('Chaim Klein') && built.html.includes('chaim@yscapgroup.com'), 'coBorrowerInvite carries the officer block');
  built = mail.borrowerInvite({ firstName: 'B', acceptUrl: 'https://x/accept' });
  ok(!/loan officer/i.test(built.html) || !built.html.includes('NMLS #'), 'no officer → no empty contact block');

  // (3) staff register sends the CLIENT a terms email from their officer.
  // Capture outbound email by stubbing the shared provider object (notify.js
  // holds the same module reference, so property lookup hits the stub).
  const sentMail = [];
  email.sendMail = async (msg) => { sentMail.push(msg); return { ok: true }; };
  const app = require(REPO + '/src/server.js');
  const server = app.listen(PORT);
  await require(REPO + '/src/migrate-boot').ensureSchema();
  const B = uuid(), APP = uuid(), LO = uuid();
  try {
    await db.query(`INSERT INTO staff_users (id,email,full_name,role,password_hash,is_active,phone,nmls,title) VALUES
      ($1,$2,'Brand Officer','loan_officer','x',true,'929-555-0199','7654321','Loan Officer')`, [LO, `brlo_${LO.slice(0, 8)}@x.test`]);
    await db.query(`INSERT INTO borrowers (id,first_name,last_name,email) VALUES ($1,'Brand','Borrower',$2)`, [B, `brb_${B.slice(0, 8)}@x.test`]);
    await db.query(`INSERT INTO applications (id,borrower_id,loan_officer_id,property_address,purchase_price,as_is_value,arv,rehab_budget,term,requested_exp_flips)
      VALUES ($1,$2,$3,$4,300000,300000,450000,50000,'12',2)`,
      [APP, B, LO, JSON.stringify({ line1: '7 Brand Blvd', city: 'Lakewood', state: 'NJ', zip: '08701' })]);
    const loTok = C.signJwt({ sub: LO, kind: 'staff', role: 'loan_officer', tv: 0 });
    const r = await api('POST', `/api/staff/applications/${APP}/pricing/register`, { program: 'standard', overrides: {
      strategy: 'Fix & Flip', state: 'NJ', propertyType: 'SFR (1 unit)', loanType: 'Purchase',
      purchasePrice: 300000, asIsValue: 300000, arv: 450000, rehabBudget: 50000, term: 12,
      expFlips: 2, manualPricing: false,
    } }, loTok);
    ok(r.status === 201, `register succeeds (got ${r.status})`);
    await new Promise((res2) => setTimeout(res2, 400));   // _emailRow is fire-and-forget
    const n = await db.query(
      `SELECT title, body FROM notifications
        WHERE application_id=$1 AND borrower_id=$2 AND type='term_sheet' ORDER BY created_at DESC LIMIT 1`, [APP, B]);
    ok(!!n.rows[0], 'the BORROWER got a terms notification on register');
    const borrowerEmail = sentMail.find((m) => [].concat(m.to || []).some((t) => String(t).startsWith('brb_')));
    ok(!!borrowerEmail, 'a terms EMAIL went to the borrower');
    if (borrowerEmail) {
      ok(String(borrowerEmail.from || '').includes('Brand Officer — YS Capital'), `email From is the OFFICER (got ${borrowerEmail.from})`);
      ok(String(borrowerEmail.replyTo || '').startsWith('brlo_'), 'replies go to the officer');
      ok(borrowerEmail.html.includes('Brand Officer') && borrowerEmail.html.includes('929-555-0199'), 'email body carries the officer name + phone');
      ok(/Standard Program/.test(borrowerEmail.html), 'borrower-safe program label');
      ok(!/BlueLake|Temple View|RCN|Churchill|Fidelis/i.test(borrowerEmail.html), 'no note-buyer names leak to the borrower');
    }
  } catch (e) { fail++; console.log('  ✗ EXCEPTION', e && e.stack ? e.stack : e); }
  finally {
    await db.query(`DELETE FROM notifications WHERE application_id=$1`, [APP]).catch(() => {});
    await db.query(`DELETE FROM audit_log WHERE entity_id=$1`, [APP]).catch(() => {});
    await db.query(`DELETE FROM product_registrations WHERE application_id=$1`, [APP]).catch(() => {});
    await db.query(`DELETE FROM checklist_items WHERE application_id=$1`, [APP]).catch(() => {});
    await db.query(`DELETE FROM conditions WHERE application_id=$1`, [APP]).catch(() => {});
    await db.query(`DELETE FROM applications WHERE id=$1`, [APP]).catch(() => {});
    await db.query(`DELETE FROM borrowers WHERE id=$1`, [B]).catch(() => {});
    await db.query(`DELETE FROM staff_users WHERE id=$1`, [LO]).catch(() => {});
  }
  server.close();
  console.log(`\nlo-branding: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main();
