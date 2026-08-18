#!/usr/bin/env node
'use strict';
/* PLANS & PERMITS — waivable on a purchase, re-enforced before the FIRST DRAW
 * (owner-directed 2026-08-18, db/576 + src/sitewire/plans-permits.js). What is pinned,
 * against a real database and the real HTTP waive door:
 *
 *   A. the db/576 template is LIVE and manual (the engine can never dump it on a file).
 *   B. the scope: ground-up files only, by the draw side's own classifier.
 *   C. the first-draw condition raises ONCE, PRE-FILLED with the closing-time plans
 *      document (a COPY, landing 'received' + review pending — the coordinator accepts
 *      and signs off afresh), and never on a file already past its first draw.
 *   D. the portal composer gate refuses until the coordinator signs off, then stands down.
 *   E. the investor-delivery blocker (pure) fires exactly when the raised condition is
 *      unsatisfied — never on a file where it was never raised (go-forward).
 *   F. the investor attachment list carries the ACCEPTED plans deduped by content hash
 *      (the pre-filled copy never ships beside its identical original).
 *   G. the waive door: 'Waive this condition' works directly on a PURCHASE even though
 *      the condition is required; a REFINANCE is refused (required before closing).
 *
 * DB-gated: needs DATABASE_URL with migrations applied; skips cleanly otherwise.
 */
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };

if (!process.env.DATABASE_URL) { console.log('SKIP test-plans-permits-draw-db (no DATABASE_URL)'); process.exit(0); }
process.env.RESEND_API_KEY = '';

const http = require('http');
const crypto = require('crypto');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const storage = require('../src/lib/storage');
const PP = require('../src/sitewire/plans-permits');
const ID = require('../src/sitewire/investor-delivery');
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

async function seedClosingPlansItem(appId) {
  return (await db.query(
    `INSERT INTO checklist_items (template_id, scope, application_id, label, borrower_label, audience, item_kind, status, is_required)
     SELECT id, 'application', $1, label, borrower_label, audience, item_kind, 'outstanding', true
       FROM checklist_templates WHERE code='rtl_p1_plans' RETURNING id`, [appId])).rows[0].id;
}

(async () => {
  // ---- A. the template ------------------------------------------------------------------
  const tpl = (await db.query(
    `SELECT auto_apply, category, audience, item_kind, is_required, is_gate, tpr_exclude, is_active
       FROM checklist_templates WHERE code='draw_cond_plans_permits'`)).rows[0];
  ok('A1 the first-draw template is live', !!tpl && tpl.is_active === true);
  ok('A2 …manual + draw-phase (the engine never touches it)', tpl.auto_apply === 'manual' && tpl.category === 'draw');
  ok('A3 …required, a gate, both audiences, tpr-excluded (the COPY never doubles the TPR package)',
    tpl.is_required === true && tpl.is_gate === true && tpl.audience === 'both' && tpl.tpr_exclude === true);

  // ---- fixtures -------------------------------------------------------------------------
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = crypto.randomBytes(4).toString('hex');
  let superId, borId, guId, flipId, refiId;
  try {
    superId = (await db.query(`INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version) VALUES ($1,'Super','super_admin',true,false,'x',0) RETURNING id`, [`pp-super-${sfx}@test.local`])).rows[0].id;
    const tok = C.signJwt({ sub: superId, kind: 'staff', role: 'super_admin', tv: 0 });
    borId = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Plan','Permit',$1) RETURNING id`, [`pp-bo-${sfx}@test.local`])).rows[0].id;
    guId = (await db.query(
      `INSERT INTO applications (borrower_id,loan_officer_id,status,loan_type,property_address)
       VALUES ($1,$2,'funded','Ground Up Construction','{"oneLine":"7 Build Blvd"}') RETURNING id`, [borId, superId])).rows[0].id;
    flipId = (await db.query(
      `INSERT INTO applications (borrower_id,status,loan_type,rehab_type,property_address)
       VALUES ($1,'funded','Fix & Flip','Light Rehab','{"oneLine":"8 Flip St"}') RETURNING id`, [borId])).rows[0].id;
    refiId = (await db.query(
      `INSERT INTO applications (borrower_id,loan_officer_id,status,loan_type,property_address)
       VALUES ($1,$2,'underwriting','Refinance - Cash-Out Ground Up','{"oneLine":"9 Refi Rd"}') RETURNING id`, [borId, superId])).rows[0].id;

    // ---- B. scope -----------------------------------------------------------------------
    ok('B1 a ground-up file applies', await PP.appliesTo(guId) === true);
    ok('B2 a fix & flip never does', await PP.appliesTo(flipId) === false);

    // ---- C. raise + pre-fill ------------------------------------------------------------
    const closingItem = (await db.query(
      `SELECT ci.id FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
        WHERE ci.application_id=$1 AND t.code='rtl_p1_plans' LIMIT 1`, [guId])).rows[0]
      || { id: await seedClosingPlansItem(guId) };
    const saved = await storage.save(Buffer.from('%PDF-1.4 approved plans ' + sfx), { filename: 'approved-plans.pdf' });
    const closingDocId = (await db.query(
      `INSERT INTO documents (application_id, checklist_item_id, borrower_id, filename, content_type, size_bytes,
                              storage_provider, storage_ref, uploaded_by_kind, uploaded_by_id, review_status, reviewed_at, is_current, sha256)
       VALUES ($1,$2,$3,'approved-plans.pdf','application/pdf',30,$4,$5,'staff',$6,'accepted',now(),true,$7) RETURNING id`,
      [guId, closingItem.id, borId, saved.provider, saved.ref,
       superId, crypto.createHash('sha256').update('%PDF-1.4 approved plans ' + sfx).digest('hex')])).rows[0].id;

    const r1 = await PP.ensureDrawPlansCondition(guId, { actorId: superId });
    ok('C1 the first-draw condition is raised on a ground-up file', !!r1.itemId && r1.created === true);
    ok('C2 …pre-filled with the closing-time document', r1.prefilled >= 1);
    const copied = (await db.query(
      `SELECT d.source_document_id, COALESCE(d.review_status,'pending') AS rs, ci.status
         FROM documents d JOIN checklist_items ci ON ci.id=d.checklist_item_id
        WHERE d.checklist_item_id=$1 AND d.is_current`, [r1.itemId])).rows;
    ok('C3 the copy points at its source and awaits a FRESH review (the coordinator signs off again)',
      copied.length === 1 && String(copied[0].source_document_id) === String(closingDocId) && copied[0].rs === 'pending');
    const r2 = await PP.ensureDrawPlansCondition(guId, { actorId: superId });
    ok('C4 raising again is a no-op (no second condition, no second copy)',
      r2.created === false && String(r2.itemId) === String(r1.itemId)
      && (await db.query(`SELECT count(*)::int n FROM documents WHERE checklist_item_id=$1 AND is_current`, [r1.itemId])).rows[0].n === 1);
    const r3 = await PP.ensureDrawPlansCondition(flipId, {});
    ok('C5 never raised on a non-ground-up file', r3.itemId == null && r3.reason === 'not_ground_up');
    // a file past its first draw is left alone (go-forward)
    await db.query(`INSERT INTO draw_disbursements (application_id, approved_cents, fee_cents, wired_at) VALUES ($1, 100000, 0, now())`, [flipId]).catch(async () => {
      await db.query(`INSERT INTO draw_disbursements (application_id, approved_cents) VALUES ($1, 100000)`, [flipId]).catch(() => null);
    });
    ok('C6 pastFirstDraw reads a recorded release', await PP.pastFirstDraw(flipId) === true);

    // ---- D. the composer gate -----------------------------------------------------------
    const refusal = await PP.firstDrawGate(guId, {});
    ok('D1 the first draw is refused while the condition is unsatisfied',
      typeof refusal === 'string' && /signed off/.test(refusal));
    const st1 = await PP.status(guId);
    ok('D2 status reads the raised, unsatisfied condition', st1.applies && !!st1.itemId && st1.satisfied === false);
    await db.query(`UPDATE checklist_items SET status='satisfied', signed_off_by=$2, signed_off_at=now() WHERE id=$1`, [r1.itemId, superId]);
    ok('D3 the gate stands down once the coordinator signs off', (await PP.firstDrawGate(guId, {})) == null);
    ok('D4 …and status agrees', (await PP.status(guId)).satisfied === true);

    // ---- E. the delivery blocker (pure) --------------------------------------------------
    const base = { finding: { status: 'accepted' }, investorContacts: [{ email: 'x@y.z' }], noteBuyer: 'Fidelis Investors LLC', mode: 'reimbursement', wireForm: { present: true, accepted: true } };
    ok('E1 an unsatisfied raised condition blocks the delivery',
      ID.deliveryBlockers({ ...base, plansPermits: { applies: true, itemId: 'x', satisfied: false } }).some((b) => /plans & permits/i.test(b)));
    ok('E2 a signed-off condition never blocks',
      !ID.deliveryBlockers({ ...base, plansPermits: { applies: true, itemId: 'x', satisfied: true } }).some((b) => /plans/i.test(b)));
    ok('E3 a file where it was never raised never blocks (go-forward)',
      !ID.deliveryBlockers({ ...base, plansPermits: { applies: true, itemId: null, satisfied: true } }).some((b) => /plans/i.test(b)));
    ok('E4 null (back-compat callers) never blocks',
      !ID.deliveryBlockers({ ...base }).some((b) => /plans/i.test(b)));

    // ---- F. the investor attachment list -------------------------------------------------
    // accept the pre-filled copy (identical bytes → same sha) — the list must dedupe to ONE
    await db.query(`UPDATE documents SET review_status='accepted', reviewed_at=now() WHERE checklist_item_id=$1`, [r1.itemId]);
    const plans = await PP.acceptedPlansForInvestor(guId);
    ok('F1 the accepted plans travel, deduped by content hash (copy never beside its original)',
      plans.length === 1 && plans[0].filename === 'approved-plans.pdf');
    ok('F2 a non-ground-up file reports nothing at all', (await PP.acceptedPlansForInvestor(flipId)).length === 0);

    // ---- G. the waive door ---------------------------------------------------------------
    const tok2 = tok;
    // purchase: waivable directly even though required
    const purchaseItem = closingItem.id;
    const w1 = await call(server, 'PATCH', `/api/staff/checklist/${purchaseItem}`, tok2, { waived: true });
    const w1row = (await db.query(`SELECT waived_at, status FROM checklist_items WHERE id=$1`, [purchaseItem])).rows[0];
    ok('G1 plans & permits on a PURCHASE waive directly', w1.status === 200 && !!w1row.waived_at && w1row.status === 'satisfied');
    // refinance: the required-condition rule stands
    const refiItem = await seedClosingPlansItem(refiId);
    const w2 = await call(server, 'PATCH', `/api/staff/checklist/${refiItem}`, tok2, { waived: true });
    ok('G2 on a REFINANCE the waive is refused (required before closing)',
      w2.status === 422 && /optional/i.test((w2.body && w2.body.error) || ''));
    // ---- H. the wiring (source guards — the enforcement points are routes/IO the module
    //         tests above cannot exercise; a refactor that drops one silently re-arms the
    //         unenforced first draw there) --------------------------------------------------
    const fs = require('fs');
    const path = require('path');
    const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
    const portal = read('src/lib/portal-draws.js');
    const routes = read('src/routes/sitewire.js');
    const recon = read('src/sitewire/reconcile.js');
    const send = read('src/sitewire/investor-delivery-send.js');
    ok('H1 the portal composer refuses through firstDrawGate (422)',
      /firstDrawGate\(appId/.test(portal) && /throw err\(422, plansRefusal\)/.test(portal));
    ok('H2 Start-draw raises the condition at setup',
      /plans-permits'\)\.ensureDrawPlansCondition\(appId/.test(routes));
    ok('H3 the reconcile raises + cues the desk on a Sitewire-submitted first draw',
      /ensureOnFirstSitewireDraw\(appId, draws\.length, addrText\)/.test(recon));
    ok('H4 the delivery preview reads the status AND carries it to the send re-check',
      /plans-permits'\)\.status\(appId\)/.test(send) && /plans_permits: plansPermits/.test(send)
      && /plansPermits: pre\.plans_permits \|\| null/.test(send));
    ok('H5 the accepted plans ride the investor delivery (section 7)',
      /acceptedPlansForInvestor\(appId\)/.test(send) && /what: 'Plans & permits'/.test(send));
    ok('H6 the waive door carve-out is purchase-only and reads the ONE refi test',
      /isPlansOnPurchase = cur\.rows\[0\]\.template_code === 'rtl_p1_plans'/.test(read('src/routes/staff.js'))
      && /refiKind\(cur\.rows\[0\]\.loan_type\) === require\('\.\.\/lib\/payoff'\)\.KIND\.PURCHASE/.test(read('src/routes/staff.js')));
  } finally {
    try {
      await db.query(`DELETE FROM applications WHERE id = ANY($1::uuid[])`, [[guId, flipId, refiId].filter(Boolean)]);
      if (borId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borId]);
      if (superId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [superId]);
    } catch (_) { /* best-effort cleanup */ }
    server.close();
  }

  console.log(`test-plans-permits-draw-db: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
