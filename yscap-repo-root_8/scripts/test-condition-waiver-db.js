'use strict';
/**
 * DB + HTTP test — the "request a waiver of a condition" round-trip
 * (owner-directed 2026-08-04).
 *
 *   node scripts/test-condition-waiver-db.js
 *   DATABASE_URL=postgres://… node scripts/test-condition-waiver-db.js
 *
 * The whole owner ask, end to end: any staffer on the file requests a waiver of a
 * SPECIFIC condition; an admin decides it in the Exceptions box; APPROVAL marks
 * that one condition waived; DENIAL leaves it standing. Plus the invariants that
 * keep it safe — a file may carry several open waivers (one per condition), a
 * second request for the SAME condition supersedes only that one, a cleared
 * condition can't be requested, and the waive is scoped to its own file.
 *
 * DB-gated like every other *-db suite: SKIPS cleanly with no DATABASE_URL.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres@127.0.0.1:5433/yscap';
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
process.env.EMAIL_PROVIDER = 'none';
process.env.NODE_ENV = 'test';

const http = require('http');
const REPO = __dirname + '/..';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL', m); } };

function call(server, method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, path, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: res.statusCode, body: b, json: j }); }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  let db;
  try { db = require(REPO + '/src/db'); await db.query('SELECT 1'); }
  catch (e) { console.log('condition-waiver (DB): SKIPPED — no database (' + (e && e.message) + ')'); process.exit(0); }
  await require(REPO + '/src/migrate-boot').ensureSchema();

  const C = require(REPO + '/src/lib/crypto');
  const app = require(REPO + '/src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;

  // A checklist_item on this file (outstanding, not cleared) — mirrors the override
  // suite's mkItem: a real template row instantiated onto the application.
  async function mkItem(appId, code) {
    const t = (await db.query(`SELECT id, item_kind, tool_key, is_required, label FROM checklist_templates WHERE code=$1`, [code])).rows[0];
    return (await db.query(
      `INSERT INTO checklist_items (template_id, scope, application_id, label, status, item_kind, tool_key, is_required)
       VALUES ($1,'application',$2,$3,'received',$4,$5,$6) RETURNING id`,
      [t.id, appId, t.label, t.item_kind, t.tool_key, t.is_required])).rows[0].id;
  }
  const itemRow = async (id) => (await db.query(
    `SELECT status, signed_off_at, waived_at, waived_by, notes FROM checklist_items WHERE id=$1`, [id])).rows[0];

  try {
    const loId = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, mfa_enabled, password_hash, token_version)
       VALUES ($1,'CW LO','loan_officer',true,false,'x',0) RETURNING id`, [`cw-lo-${sfx}@test.local`])).rows[0].id;
    const adminId = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, mfa_enabled, password_hash, token_version)
       VALUES ($1,'CW Admin','admin',true,false,'x',0) RETURNING id`, [`cw-admin-${sfx}@test.local`])).rows[0].id;
    const loTok = C.signJwt({ sub: loId, kind: 'staff', role: 'loan_officer', tv: 0 });
    const adTok = C.signJwt({ sub: adminId, kind: 'staff', role: 'admin', tv: 0 });
    const bId = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('CW','Test',$1) RETURNING id`, [`cw-bo-${sfx}@test.local`])).rows[0].id;
    // Assign the LO to the file so their file-scoped request passes the /applications/:id guard.
    // A rehab_budget is set so the SOW budget guard (db/069/db/282) is ARMED for the
    // budget-condition case below — proving db/471 lets a waive past it.
    const appId = (await db.query(`INSERT INTO applications (borrower_id, loan_officer_id, status, rehab_budget) VALUES ($1,$2,'processing',50000) RETURNING id`, [bId, loId])).rows[0].id;

    // Two independent conditions on the file (checklist_items has no
    // one-per-template constraint by design — db/401 — so two instances of one
    // template are fine, and the waiver targets by item id, not template).
    const item1 = await mkItem(appId, 'rtl_p1_id');
    const item2 = await mkItem(appId, 'rtl_p1_id');

    const reqWaiver = (itemId, token, body) => call(server, 'POST', `/api/staff/applications/${appId}/conditions/${itemId}/request-waiver`, token, body);
    const decide = (eid, token, body) => call(server, 'POST', `/api/admin/exceptions/${eid}/decide`, token, body);

    // ---- (1) a request needs a reason -------------------------------------
    ok((await reqWaiver(item1, loTok, {})).status === 400, 'a waiver request with no reason is refused (400)');

    // ---- (2) the LO files a real request ----------------------------------
    const r1 = await reqWaiver(item1, loTok, { reasonNote: 'Provided in the closing package' });
    ok(r1.status === 200 && r1.json && r1.json.ok, 'the loan officer can request a waiver of a condition');
    const exc1 = r1.json.exception;
    ok(exc1 && exc1.exception_type === 'condition_waiver' && exc1.status === 'requested', 'it creates a requested condition_waiver row');
    ok(String(exc1.target_checklist_item_id) === String(item1), 'the request names the target condition');

    // ---- (3) a SECOND condition can be requested at the same time ----------
    const r2 = await reqWaiver(item2, loTok, { reasonNote: 'Not applicable to this deal' });
    ok(r2.status === 200 && r2.json.ok, 'a SECOND condition’s waiver can be open at the same time (one-per-condition, not one-per-file)');
    const openCount = Number((await db.query(
      `SELECT count(*) n FROM loan_exceptions WHERE application_id=$1 AND exception_type='condition_waiver' AND status='requested'`, [appId])).rows[0].n);
    ok(openCount === 2, 'both requests are open on the file at once');

    // ---- (4) a second request for the SAME condition supersedes only IT ----
    const r1b = await reqWaiver(item1, loTok, { reasonNote: 'Restating the ask for item 1' });
    ok(r1b.status === 200 && r1b.json.ok, 'a fresh request for the same condition is accepted');
    ok((await db.query(`SELECT status FROM loan_exceptions WHERE id=$1`, [exc1.id])).rows[0].status === 'withdrawn',
      'the prior request for THAT condition is superseded (withdrawn)');
    ok((await db.query(`SELECT status FROM loan_exceptions WHERE id=$1`, [r2.json.exception.id])).rows[0].status === 'requested',
      'the OTHER condition’s request is untouched');
    const exc1b = r1b.json.exception;

    // ---- (5) requester != approver: a NON-manage_pricing role can't decide -
    ok((await decide(exc1b.id, loTok, { decision: 'approved', note: 'me approving my own' })).status === 403,
      'the loan officer (no manage_pricing) cannot decide it');

    // ---- (6) an admin APPROVES → the condition is marked WAIVED ------------
    const okDecide = await decide(exc1b.id, adTok, { decision: 'approved', note: 'Fine to waive — provided elsewhere.' });
    ok(okDecide.status === 200 && okDecide.json.ok, 'an admin approves the waiver');
    const it1 = await itemRow(item1);
    ok(it1.status === 'satisfied' && it1.waived_at != null && String(it1.waived_by) === String(adminId),
      'APPROVAL marks that condition waived (satisfied + waived stamps by the approver)');
    ok(it1.notes && /Waived by approved exception EX-/.test(it1.notes),
      'the condition records that an approved exception cleared it');

    // ---- (7) a DENIAL leaves the other condition standing -----------------
    const denyRes = await decide(r2.json.exception.id, adTok, { decision: 'denied', note: 'Still need it.' });
    ok(denyRes.status === 200 && denyRes.json.ok, 'an admin can deny a waiver');
    const it2 = await itemRow(item2);
    ok(it2.status !== 'satisfied' && it2.waived_at == null, 'a DENIED waiver leaves the condition unmet');

    // ---- (8) can't request a waiver of an already-cleared condition --------
    ok((await reqWaiver(item1, loTok, { reasonNote: 'again' })).status === 409,
      'a waiver of an already-cleared condition is refused (409)');

    // ---- (9) the SOW BUDGET condition can be waived (db/471) ----------------
    // The rehab-budget condition's DB guard (trg_sow_budget_guard) refuses a
    // satisfied-write unless the SOW balances to the cent. A WAIVE is a deliberate
    // decision to clear it WITHOUT that — db/471 lets a waive/override past the
    // guard. Without db/471 this approval 500s and leaves the condition un-waived.
    const budgetItem = await mkItem(appId, 'rtl_p1_budget');  // tool_key rehab_budget; no balanced SOW payload
    const rb = await reqWaiver(budgetItem, loTok, { reasonNote: 'SOW handled outside PILOT' });
    ok(rb.status === 200 && rb.json.ok, 'a waiver of the SOW budget condition can be requested');
    const rbDecide = await decide(rb.json.exception.id, adTok, { decision: 'approved', note: 'Waive the budget match.' });
    ok(rbDecide.status === 200 && rbDecide.json.ok,
      'approving a SOW-budget waiver SUCCEEDS (db/471 lets the waive past the budget guard — it 500s without it)');
    const bi = await itemRow(budgetItem);
    ok(bi.status === 'satisfied' && bi.waived_at != null,
      'the SOW budget condition is marked waived');
  } finally {
    server.close();
    try { await db.pool.end(); } catch (_) {}
  }

  console.log(`condition-waiver (DB): ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
