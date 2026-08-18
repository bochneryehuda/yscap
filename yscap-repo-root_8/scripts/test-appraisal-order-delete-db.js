#!/usr/bin/env node
'use strict';
/* DELETING A DRAFT / FAILED APPRAISAL-ORDER ATTEMPT (owner-directed 2026-08-18:
 * "failed and draft attempts to place appraisal orders have no option to delete
 * them … all vendors … but not the successful ones"). What is pinned:
 *
 *   A. the shared decision (lib/appraisal/order-delete.mayDelete): only
 *      draft/error/dryrun; a vendor identifier means CANCEL-not-delete; money
 *      (paid, or a started/settled payment intent) refuses; a filed document
 *      refuses; cancelled/rejected stay; unknown vendor fails closed.
 *   B. the three real HTTP doors: an ERROR attempt deletes (children cascade,
 *      the payment-intent row goes with it, the audit row lands); a PLACED
 *      order refuses 422 whatever its status column says; an RV attempt that
 *      auto-recorded the no-XML waiver takes the waiver with it.
 *   C. file scope: a staffer with no file access is refused.
 *
 * DB-gated: needs DATABASE_URL with migrations applied; skips cleanly otherwise.
 */
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };

if (!process.env.DATABASE_URL) { console.log('SKIP test-appraisal-order-delete-db (no DATABASE_URL)'); process.exit(0); }
process.env.RESEND_API_KEY = '';

const http = require('http');
const crypto = require('crypto');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const del = require('../src/lib/appraisal/order-delete');
const app = require('../src/server');

function call(server, method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, path, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => { try { resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }); } catch (_) { resolve({ status: res.statusCode, body: null }); } }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  // ---- A. the pure decision --------------------------------------------------------------
  ok('A1 an error attempt may go', del.mayDelete('amc', { status: 'error' }).ok === true);
  ok('A2 a draft may go', del.mayDelete('rv', { status: 'draft' }).ok === true);
  ok('A3 a dryrun may go', del.mayDelete('class', { status: 'dryrun' }).ok === true);
  ok('A4 a placed order never deletes', del.mayDelete('amc', { status: 'ordered' }).ok === false);
  ok('A5 cancelled/rejected are records and stay', del.mayDelete('amc', { status: 'cancelled' }).ok === false
    && del.mayDelete('class', { status: 'rejected' }).ok === false);
  ok('A6 a vendor identifier wins over the status column', del.mayDelete('amc', { status: 'error', sp_order_number: 'SP-1' }).ok === false
    && del.mayDelete('class', { status: 'error', class_order_id: 'C-1' }).ok === false
    && del.mayDelete('rv', { status: 'error', intake_token: 'tok' }).ok === false);
  ok('A7 money refuses — paid on the row', del.mayDelete('class', { status: 'error', paid_at: '2026-08-01' }).ok === false);
  ok('A8 money refuses — a started charge on the intent', del.mayDelete('rv', { status: 'error' }, { paymentIntent: { charge_started_at: 'x' } }).ok === false);
  ok('A9 a filed document refuses', del.mayDelete('amc', { status: 'error' }, { filedDocuments: 1 }).ok === false);
  ok('A10 unknown vendor fails closed', del.mayDelete('nope', { status: 'error' }).ok === false);
  ok('A11 a missing row fails closed', del.mayDelete('amc', null).ok === false);

  // ---- fixtures --------------------------------------------------------------------------
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = crypto.randomBytes(4).toString('hex');
  let superId, outsiderId, borId, appId;
  try {
    superId = (await db.query(`INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version) VALUES ($1,'Super','super_admin',true,false,'x',0) RETURNING id`, [`aod-super-${sfx}@test.local`])).rows[0].id;
    outsiderId = (await db.query(`INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version) VALUES ($1,'Out','loan_officer',true,false,'x',0) RETURNING id`, [`aod-out-${sfx}@test.local`])).rows[0].id;
    const tok = C.signJwt({ sub: superId, kind: 'staff', role: 'super_admin', tv: 0 });
    const outTok = C.signJwt({ sub: outsiderId, kind: 'staff', role: 'loan_officer', tv: 0 });
    borId = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Ord','Del',$1) RETURNING id`, [`aod-bo-${sfx}@test.local`])).rows[0].id;
    appId = (await db.query(`INSERT INTO applications (borrower_id,status,property_address) VALUES ($1,'underwriting','{"oneLine":"4 Del Dr"}') RETURNING id`, [borId])).rows[0].id;

    // ---- B1. AMC: an error attempt deletes, children + intent go, audit lands -----------
    const amcId = (await db.query(
      `INSERT INTO amc_orders (application_id, status, last_error) VALUES ($1,'error','gateway said no') RETURNING id`, [appId])).rows[0].id;
    await db.query(`INSERT INTO amc_order_comments (order_id, direction, body) VALUES ($1,'out','hello')`, [amcId]).catch(() => null);
    await db.query(`INSERT INTO appraisal_payment_intents (application_id, vendor, vendor_order_id, method) VALUES ($1,'nan',$2,'PAYMENT_LINK')`, [appId, amcId]);
    const d1 = await call(server, 'DELETE', `/api/amc/orders/${amcId}`, tok);
    ok('B1 the AMC error attempt deletes', d1.status === 200 && d1.body.ok === true);
    ok('B2 the row and its payment intent are gone',
      (await db.query(`SELECT count(*)::int n FROM amc_orders WHERE id=$1`, [amcId])).rows[0].n === 0
      && (await db.query(`SELECT count(*)::int n FROM appraisal_payment_intents WHERE vendor='nan' AND vendor_order_id=$1`, [amcId])).rows[0].n === 0);
    const aud = (await db.query(`SELECT count(*)::int n FROM audit_log WHERE entity_id=$1 AND action='appraisal_order_attempt_deleted'`, [appId])).rows[0].n;
    ok('B3 the deletion is audited', aud >= 1);

    // ---- B2. AMC: a PLACED order refuses whatever its status says ------------------------
    const placedId = (await db.query(
      `INSERT INTO amc_orders (application_id, status, sp_order_number) VALUES ($1,'error','SP-99') RETURNING id`, [appId])).rows[0].id;
    const d2 = await call(server, 'DELETE', `/api/amc/orders/${placedId}`, tok);
    ok('B4 an attempt the vendor has refuses 422 with a plain message', d2.status === 422 && /cancel/i.test((d2.body && d2.body.message) || ''));

    // ---- B3. Class -----------------------------------------------------------------------
    const clsId = (await db.query(
      `INSERT INTO class_orders (application_id, status, last_error) VALUES ($1,'error','declined') RETURNING id`, [appId])).rows[0].id;
    const d3 = await call(server, 'DELETE', `/api/class/files/${appId}/orders/${clsId}`, tok);
    ok('B5 the Class error attempt deletes', d3.status === 200
      && (await db.query(`SELECT count(*)::int n FROM class_orders WHERE id=$1`, [clsId])).rows[0].n === 0);
    const clsPaid = (await db.query(
      `INSERT INTO class_orders (application_id, status, paid_at) VALUES ($1,'error',now()) RETURNING id`, [appId])).rows[0].id;
    const d4 = await call(server, 'DELETE', `/api/class/files/${appId}/orders/${clsPaid}`, tok);
    ok('B6 money on a Class attempt refuses', d4.status === 422);

    // ---- B4. RV: the auto-recorded no-XML waiver goes with the attempt -------------------
    const rvId = (await db.query(
      `INSERT INTO rv_orders (application_id, report_type, status, last_error, xml_waiver_applied) VALUES ($1,'hybrid','error','bad zip',true) RETURNING id`, [appId])).rows[0].id;
    await db.query(
      `INSERT INTO appraisal_xml_waivers (application_id, reason) VALUES ($1,'hybrid_appraisal') ON CONFLICT DO NOTHING`, [appId]).catch(() => null);
    const hadWaiver = (await db.query(`SELECT count(*)::int n FROM appraisal_xml_waivers WHERE application_id=$1 AND reason='hybrid_appraisal'`, [appId])).rows[0].n === 1;
    const d5 = await call(server, 'DELETE', `/api/richer-value/orders/${rvId}`, tok);
    ok('B7 the RV error attempt deletes', d5.status === 200
      && (await db.query(`SELECT count(*)::int n FROM rv_orders WHERE id=$1`, [rvId])).rows[0].n === 0);
    ok('B8 its auto-recorded no-XML waiver is withdrawn with it', !hadWaiver
      || (await db.query(`SELECT count(*)::int n FROM appraisal_xml_waivers WHERE application_id=$1 AND reason='hybrid_appraisal'`, [appId])).rows[0].n === 0);

    // ---- C. file scope -------------------------------------------------------------------
    const scoped = (await db.query(
      `INSERT INTO amc_orders (application_id, status) VALUES ($1,'draft') RETURNING id`, [appId])).rows[0].id;
    const d6 = await call(server, 'DELETE', `/api/amc/orders/${scoped}`, outTok);
    ok('C1 a staffer with no file access is refused', d6.status === 403);
    const d7 = await call(server, 'DELETE', `/api/amc/orders/${scoped}`, tok);
    ok('C2 …and the draft still deletes for someone on the file', d7.status === 200);
  } finally {
    try {
      if (appId) await db.query(`DELETE FROM applications WHERE id=$1`, [appId]);
      if (borId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borId]);
      await db.query(`DELETE FROM staff_users WHERE id = ANY($1::uuid[])`, [[superId, outsiderId].filter(Boolean)]);
    } catch (_) { /* best-effort cleanup */ }
    server.close();
  }

  console.log(`test-appraisal-order-delete-db: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
