/**
 * One borrower verdict email per checklist item, not one per saved FORMAT
 * (src/routes/staff.js POST /documents/:id/review claimItemVerdictEmail).
 *
 * Owner-reported 2026-07-20: a tool submission (Scope of Work) saves the SAME
 * logical document in 3 formats — HTML + XML + PDF — as separate `documents`
 * rows on one checklist item, so rejecting it sent THREE identical "needs a new
 * document" emails. Now the first format's verdict notifies the borrower and the
 * sibling formats update silently (one email per item per verdict, short window).
 *
 * Boots the real Express app as a super_admin and drives the real review
 * endpoint. Requires DATABASE_URL; skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-notification-doc-verdict-dedup (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
process.env.EMAIL_PROVIDER = 'none';

const http = require('http');
const assert = require('assert');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const email = require('../src/lib/email');
const app = require('../src/server');

let n = 0; const ok = (m) => { n++; console.log('  ok -', m); };
let sent = [];
email.sendMail = async (m) => { sent.push(m); return { ok: true }; };
const mailedTo = (addr) => sent.filter((m) => (Array.isArray(m.to) ? m.to : [m.to]).includes(addr)).length;

function call(server, method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, path, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Date.now() / 1000)}`;
  const bEmail = `verdict-b-${sfx}@example.com`;
  let adminId, borrowerId, appId, item1, item2;
  try {
    adminId = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, mfa_enabled, password_hash, token_version)
       VALUES ($1,'Verdict Admin','super_admin',true,false,'x',0) RETURNING id`, [`verdict-a-${sfx}@test.local`])).rows[0].id;
    const token = C.signJwt({ sub: adminId, kind: 'staff', role: 'super_admin', tv: 0 });
    borrowerId = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Verdict','Test',$1) RETURNING id`, [bEmail])).rows[0].id;
    appId = (await db.query(`INSERT INTO applications (borrower_id, loan_officer_id, status) VALUES ($1,$2,'processing') RETURNING id`, [borrowerId, adminId])).rows[0].id;
    const tpl = (await db.query(`SELECT id FROM checklist_templates LIMIT 1`)).rows[0].id;
    const mkItem = async () => (await db.query(
      `INSERT INTO checklist_items (template_id, scope, application_id, label, status, item_kind, is_required)
       VALUES ($1,'application',$2,'Construction / rehab budget','received','document',true) RETURNING id`, [tpl, appId])).rows[0].id;
    item1 = await mkItem();
    item2 = await mkItem();
    const mkExport = async (itemId, filename) => (await db.query(
      `INSERT INTO documents (checklist_item_id, application_id, borrower_id, filename, storage_provider, review_status, source_type, visibility, is_current, doc_kind)
       VALUES ($1,$2,$3,$4,'local','pending','system','borrower',true,'rehab_budget_export') RETURNING id`,
      [itemId, appId, borrowerId, filename])).rows[0].id;

    // The SOW saved in 3 formats on ONE checklist item.
    const html = await mkExport(item1, '54_Ave_C_SOW.html');
    const xml = await mkExport(item1, '54_Ave_C_SOW.xml');
    const pdf = await mkExport(item1, '54_Ave_C_SOW.pdf');

    const countInApp = async (type) => Number((await db.query(
      `SELECT count(*) c FROM notifications WHERE application_id=$1 AND recipient_kind='borrower' AND type=$2`, [appId, type])).rows[0].c);

    // Reject all three formats (whether the UI sends 3 calls or a cascade — same result).
    sent = [];
    for (const id of [html, xml, pdf]) {
      const r = await call(server, 'POST', `/api/staff/documents/${id}/review`, token, { action: 'reject', reason: 'nothing in it' });
      assert.strictEqual(r.status, 200, 'reject returns 200');
    }
    assert.strictEqual(mailedTo(bEmail), 1, 'the borrower gets EXACTLY ONE rejection email for the 3-format export set (not three)');
    assert.strictEqual(await countInApp('doc_rejected'), 1, 'exactly ONE in-app rejection notification too');
    ok('rejecting a Scope of Work saved as HTML + XML + PDF sends ONE email, not three (no bombardment)');

    // A DIFFERENT checklist item is a DIFFERENT logical thing — it still notifies.
    const other = await mkExport(item2, 'Other_Condition.pdf');
    sent = [];
    await call(server, 'POST', `/api/staff/documents/${other}/review`, token, { action: 'reject', reason: 'blurry' });
    assert.strictEqual(mailedTo(bEmail), 1, 'a rejection on a DIFFERENT item still emails (dedup is per item, not global)');
    ok('a different checklist item still notifies — the dedup is scoped to one logical document');

    console.log(`\nAll ${n} verdict-dedup checks passed.`);
  } finally {
    if (appId) {
      await db.query(`DELETE FROM notifications WHERE application_id=$1`, [appId]).catch(() => {});
      await db.query(`DELETE FROM documents WHERE application_id=$1`, [appId]).catch(() => {});
      await db.query(`DELETE FROM checklist_items WHERE application_id=$1`, [appId]).catch(() => {});
      await db.query(`DELETE FROM audit_log WHERE entity_id=$1 OR entity_id=$2`, [item1, item2]).catch(() => {});
      await db.query(`DELETE FROM application_assignees WHERE application_id=$1`, [appId]).catch(() => {});
      await db.query(`DELETE FROM applications WHERE id=$1`, [appId]).catch(() => {});
    }
    if (borrowerId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]).catch(() => {});
    if (adminId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [adminId]).catch(() => {});
    await new Promise((r) => server.close(r));
    await db.pool.end();
  }
})().catch((e) => { console.error('FAIL:', e.message, e.stack); process.exit(1); });
