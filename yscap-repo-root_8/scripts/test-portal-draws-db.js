/* Portal draw requests (phase 4, DB-gated; Sitewire client STUBBED — no network).
 * Covers: composer state/eligibility (platform + physical + setup + dedupe gates,
 * external excluded), composer lines with live remaining, createRequest (borrower +
 * staff, over-remaining refusal + staff allowOver, open-Sitewire-draw dedupe + staff
 * allowParallel, one-open-per-file), the coordinator task + notifications, the
 * TrustPoint tie (+ task auto-complete; never onto a Sitewire-tied draw), approval →
 * HISTORICAL close-out into Sitewire (owner rule: portal-originated only, only after
 * approval), cancel (frees the slot + folds the task/order/tie in), and the Trinity
 * path (order lifecycle + staff decision → close-out).
 * Run: DATABASE_URL=... node scripts/test-portal-draws-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-portal-draws-db (no DATABASE_URL)'); process.exit(0); }

const crypto = require('crypto');
const cfg = require('../src/config');
const db = require('../src/db');
const swClient = require('../src/sitewire/client');
const portalDraws = require('../src/lib/portal-draws');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const tag = crypto.randomBytes(4).toString('hex');

// ---- Sitewire client stubs (close-out path) ----
let createdHistorical = [], transitions = [];
let nextHistoricalId = 810000000 + crypto.randomBytes(2).readUInt16BE(0);
swClient.createHistoricalDraw = async (propertyId, requests) => {
  const id = ++nextHistoricalId;
  createdHistorical.push({ id, propertyId, requests });
  return { id, number: 9, status: 'pending' };
};
swClient.drawTransition = async (id, action) => { transitions.push({ id: Number(id), action }); return { id, status: 'approved' }; };

async function seedFile(lender) {
  const bor = (await db.query(`INSERT INTO borrowers(first_name,last_name,email) VALUES('P','D',$1) RETURNING id`,
    ['pd' + crypto.randomBytes(5).toString('hex') + '@example.com'])).rows[0].id;
  const lo = (await db.query(
    `INSERT INTO staff_users(email, full_name, role, is_active) VALUES ($1,'PD Officer','loan_officer',true) RETURNING id`,
    ['pdlo' + crypto.randomBytes(5).toString('hex') + '@example.com'])).rows[0].id;
  const app = (await db.query(
    `INSERT INTO applications(borrower_id,status,ys_loan_number,lender,rehab_budget,property_address,loan_officer_id)
     VALUES($1,'funded',$2,$3,1000,'{"oneLine":"9 Portal Pl, Testville, NY 10001","zip":"10001"}'::jsonb,$4) RETURNING id`,
    [bor, 'PD' + crypto.randomBytes(3).toString('hex').toUpperCase(), lender, lo])).rows[0].id;
  // the per-line ledger: two real lines, one media anchor, one deleted line (never pickable)
  const base = 900000000 + crypto.randomBytes(3).readUIntBE(0, 3);
  await db.query(
    `INSERT INTO sitewire_job_item_links (application_id, sitewire_budget_id, sitewire_job_item_id, sow_line_key, section_token, name, budgeted_cents, is_media_item, state)
     VALUES ($1,1,$2,'k1','kitchen','Unit 1 - Kitchen',60000,false,'live'),
            ($1,1,$3,'k2','roof','Unit 1 - Roof',40000,false,'live'),
            ($1,1,$4,'__media__1','media','Progress photos',0,true,'live'),
            ($1,1,$5,'k3','bath','Unit 1 - Bath',20000,false,'deleted')`,
    [app, base + 1, base + 2, base + 3, base + 4]);
  return { app, bor, lo, jidKitchen: base + 1, jidRoof: base + 2, jidMedia: base + 3 };
}
const cleanup = async (app, bor, lo) => {
  await db.query(`DELETE FROM notifications WHERE application_id=$1`, [app]).catch(() => {});
  await db.query(`DELETE FROM applications WHERE id=$1`, [app]);
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [bor]);
  if (lo) { await db.query(`DELETE FROM notifications WHERE staff_id=$1`, [lo]).catch(() => {}); await db.query(`DELETE FROM staff_users WHERE id=$1`, [lo]); }
};
const wfItems = async (app) => (await db.query(`SELECT * FROM workflow_items WHERE application_id=$1 ORDER BY created_at, id`, [app])).rows;
const notesFor = async (app, kind) => (await db.query(
  `SELECT * FROM notifications WHERE application_id=$1 AND recipient_kind=$2 ORDER BY created_at`, [app, kind])).rows;

(async () => {
  cfg.sitewireEnabled = true; cfg.sitewireOutboundEnabled = true; cfg.sitewireDryrun = false;
  const TP_LABEL = `BLTest${tag}`, TRIN_LABEL = `Trin${tag}`, EXT_LABEL = `Ext${tag}`;
  await db.query(
    `INSERT INTO sitewire_inspection_rules (partner_label, inspection_method, fee_cents_virtual, fee_cents_physical, allow_virtual, allow_physical, draw_platform)
     VALUES ($1,'traditional',29900,25000,false,true,'trustpoint'),
            ($2,'traditional',29900,49900,false,true,'sitewire'),
            ($3,'traditional',29900,25000,false,true,'external')
     ON CONFLICT (regexp_replace(lower(COALESCE(partner_label,'')), '[^a-z0-9]+', '', 'g'), COALESCE(program,'')) DO NOTHING`,
    [TP_LABEL, TRIN_LABEL, EXT_LABEL]);

  // ============ 1. composer state + lines ============
  const A = await seedFile(TP_LABEL);
  {
    const st = await portalDraws.composerState(A.app);
    ok('trustpoint file: physical + platform + eligible', st.eligible === true && st.physical === true && st.platform === 'trustpoint' && st.set_up === true);
    const lines = await portalDraws.composerLines(A.app);
    ok('composer lines: real lines only (no media, no deleted)', lines.length === 2 && lines.every((l) => [A.jidKitchen, A.jidRoof].includes(l.sitewire_job_item_id)));
    // an approved prior draw eats into remaining
    const priorDraw = 910000000 + crypto.randomBytes(2).readUInt16BE(0);
    await db.query(`INSERT INTO sitewire_draws (application_id, sitewire_draw_id, number, status, total_approved_cents) VALUES ($1,$2,1,'approved',10000)`, [A.app, priorDraw]);
    await db.query(`INSERT INTO sitewire_draw_requests (sitewire_draw_id, sitewire_request_id, sitewire_job_item_id, job_item_name, requested_cents, approved_cents, inspection_count)
                    VALUES ($1,$2,$3,'Unit 1 - Kitchen',10000,10000,0)`, [priorDraw, priorDraw + 1, A.jidKitchen]);
    const lines2 = await portalDraws.composerLines(A.app);
    const k = lines2.find((l) => l.sitewire_job_item_id === A.jidKitchen);
    ok('remaining = budgeted − approved-to-date', k && k.remaining_cents === 50000);
  }

  // ============ 2. createRequest gates ============
  {
    let err = null;
    try { await portalDraws.createRequest(A.app, [{ sitewire_job_item_id: A.jidKitchen, requested_cents: 60000 }], { source: 'borrower', borrowerId: A.bor }); }
    catch (e) { err = e; }
    ok('over-remaining refused for the borrower (422)', err && err.status === 422 && /only has/.test(err.message));
    let err2 = null;
    try { await portalDraws.createRequest(A.app, [{ sitewire_job_item_id: A.jidMedia, requested_cents: 1000 }], { source: 'borrower', borrowerId: A.bor }); }
    catch (e) { err2 = e; }
    ok('media anchor is not a pickable line', err2 && err2.status === 422);
    // an open Sitewire draw blocks the borrower, staff may deliberately go parallel
    const openDraw = 920000000 + crypto.randomBytes(2).readUInt16BE(0);
    await db.query(`INSERT INTO sitewire_draws (application_id, sitewire_draw_id, number, status) VALUES ($1,$2,2,'pending')`, [A.app, openDraw]);
    let err3 = null;
    try { await portalDraws.createRequest(A.app, [{ sitewire_job_item_id: A.jidRoof, requested_cents: 5000 }], { source: 'borrower', borrowerId: A.bor }); }
    catch (e) { err3 = e; }
    ok('open Sitewire draw blocks a borrower portal request (409)', err3 && err3.status === 409);
    await db.query(`DELETE FROM sitewire_draws WHERE sitewire_draw_id=$1`, [openDraw]);
  }

  // ============ 3. borrower happy path → task + notices ============
  let firstReqId = null;
  {
    const row = await portalDraws.createRequest(A.app, [
      { sitewire_job_item_id: A.jidKitchen, requested_cents: 30000 },
      { sitewire_job_item_id: A.jidRoof, requested_cents: 20000 },
    ], { source: 'borrower', borrowerId: A.bor, note: 'kitchen + roof done' });
    firstReqId = row.id;
    ok('request row created (submitted, $500)', row && row.status === 'submitted' && Number(row.total_requested_cents) === 50000 && row.platform === 'trustpoint');
    const items = await wfItems(A.app);
    const task = items.find((i) => i.submission_type === 'trustpoint_import');
    ok('coordinator task opened (trustpoint_import → draw_coordinator)', task && ['open', 'in_progress'].includes(task.status) && task.to_role === 'draw_coordinator');
    ok('task note carries the line amounts', task && /Kitchen: \$300\.00/.test(task.note));
    ok('borrower got a receipt', (await notesFor(A.app, 'borrower')).some((n) => /request was received/i.test(n.title)));
    ok('staff notified to enter it', (await notesFor(A.app, 'staff')).some((n) => /entered into TrustPoint/i.test(n.title)));
    const st = await portalDraws.composerState(A.app);
    ok('open request blocks a second composer run', st.eligible === false && st.open_portal_request && st.open_portal_request.id === firstReqId);
    let err = null;
    try { await portalDraws.createRequest(A.app, [{ sitewire_job_item_id: A.jidRoof, requested_cents: 1000 }], { source: 'staff', staffId: A.lo }); }
    catch (e) { err = e; }
    ok('one open portal request per file (409)', err && err.status === 409);
  }

  // ============ 4. TrustPoint tie + auto-complete ============
  const tpDrawId = `pdtp-${tag}`;
  {
    // a Sitewire-tied TP draw must never tie to the portal request
    const tiedElsewhere = `pdtp-else-${tag}`;
    await db.query(
      `INSERT INTO trustpoint_draws (application_id, tp_project_id, tp_draw_id, number, status, requested_cents, sitewire_draw_id)
       VALUES ($1,$2,$3,7,'IN_REVIEW',50000,930000001)`, [A.app, `pdproj-${tag}`, tiedElsewhere]);
    const rElse = await portalDraws.tieTrustpointDraw(A.app, (await db.query(`SELECT * FROM trustpoint_draws WHERE tp_draw_id=$1`, [tiedElsewhere])).rows[0]);
    ok('a Sitewire-tied draw never ties to a portal request', rElse.tied === false);
    await db.query(`DELETE FROM trustpoint_draws WHERE tp_draw_id=$1`, [tiedElsewhere]);

    await db.query(
      `INSERT INTO trustpoint_draws (application_id, tp_project_id, tp_draw_id, number, status, requested_cents)
       VALUES ($1,$2,$3,1,'IN_REVIEW',50050)`, [A.app, `pdproj-${tag}`, tpDrawId]);   // within the ±$1 tie window
    const tpRow = (await db.query(`SELECT * FROM trustpoint_draws WHERE tp_draw_id=$1`, [tpDrawId])).rows[0];
    const r = await portalDraws.tieTrustpointDraw(A.app, tpRow);
    ok('amount tie binds the entered draw to the request', r.tied === true && r.portalRequestId === firstReqId);
    const pr = (await db.query(`SELECT * FROM portal_draw_requests WHERE id=$1`, [firstReqId])).rows[0];
    ok('request advanced to entered + tp_draw_id recorded', pr.status === 'entered' && pr.tp_draw_id === tpDrawId);
    const task = (await wfItems(A.app)).find((i) => i.submission_type === 'trustpoint_import');
    ok('coordinator task auto-completed on the tie', task && task.status === 'returned' && task.outcome_label === 'Entered in TrustPoint');
  }

  // ============ 5. approval → historical close-out ============
  {
    // per-line approved amounts on the TP draw (the crosswalk lines)
    await db.query(`UPDATE trustpoint_draws SET status='APPROVED', approved_cents=45000 WHERE tp_draw_id=$1`, [tpDrawId]);
    await db.query(
      `INSERT INTO trustpoint_draw_lines (application_id, tp_draw_id, sitewire_job_item_id, sow_line_key, name, approved_cents, source)
       VALUES ($1,$2,$3,'k1','Unit 1 - Kitchen',27000,'manual'), ($1,$2,$4,'k2','Unit 1 - Roof',18000,'manual')`,
      [A.app, tpDrawId, A.jidKitchen, A.jidRoof]);
    // no created Sitewire property yet → close-out politely waits
    const tpRow = (await db.query(`SELECT * FROM trustpoint_draws WHERE tp_draw_id=$1`, [tpDrawId])).rows[0];
    let r = await portalDraws.onTrustpointApproval(A.app, tpRow);
    ok('close-out waits without a created Sitewire property', r.skipped === 'no_sitewire_property');
    const prMid = (await db.query(`SELECT * FROM portal_draw_requests WHERE id=$1`, [firstReqId])).rows[0];
    ok('request marked approved with the TrustPoint total', prMid.status === 'approved' && Number(prMid.approved_cents) === 45000);

    await db.query(
      `INSERT INTO sitewire_property_links (application_id, matched_by, state, sitewire_property_id)
       VALUES ($1,'created','live',940000001) ON CONFLICT (application_id) DO UPDATE SET matched_by='created', sitewire_property_id=940000001`, [A.app]);
    createdHistorical = []; transitions = [];
    r = await portalDraws.historicalCloseOut(A.app, firstReqId);
    ok('close-out ok', r.ok === true && r.sitewire_draw_id != null);
    const call = createdHistorical[0];
    ok('historical draw carries the lines + the $0 media anchor', call && call.requests.length === 3
      && call.requests.some((x) => x.job_item_id === A.jidKitchen && x.requested_cents === 30000 && x.pending_approved_cents === 27000)
      && call.requests.some((x) => x.job_item_id === A.jidRoof && x.requested_cents === 20000 && x.pending_approved_cents === 18000)
      && call.requests.some((x) => x.job_item_id === A.jidMedia && x.pending_approved_cents === 0));
    ok('draw approved after creation', transitions.some((t) => t.id === r.sitewire_draw_id && t.action === 'approve'));
    const mirrorRow = (await db.query(`SELECT * FROM sitewire_draws WHERE sitewire_draw_id=$1`, [r.sitewire_draw_id])).rows[0];
    ok('mirror row: historical + approved + echo-suppressed + import-task stamp', mirrorRow && mirrorRow.historical === true
      && mirrorRow.status === 'approved' && mirrorRow.status_synced === 'approved'
      && Number(mirrorRow.total_approved_cents) === 45000 && mirrorRow.tp_import_task_opened_at != null);
    const prDone = (await db.query(`SELECT * FROM portal_draw_requests WHERE id=$1`, [firstReqId])).rows[0];
    ok('request closed out + Sitewire draw recorded', prDone.status === 'closed_out' && Number(prDone.sitewire_draw_id) === r.sitewire_draw_id);
    const tpDone = (await db.query(`SELECT * FROM trustpoint_draws WHERE tp_draw_id=$1`, [tpDrawId])).rows[0];
    ok('TrustPoint draw stamped done (write-back sweep stops)', tpDone.writeback_at != null);
    const r2 = await portalDraws.historicalCloseOut(A.app, firstReqId);
    ok('close-out is idempotent', r2.skipped === 'already_closed_out');
    const st = await portalDraws.composerState(A.app);
    ok('closed-out request frees the composer slot', !st.open_portal_request);
  }

  // ============ 6. cancel frees everything ============
  {
    const row = await portalDraws.createRequest(A.app, [{ sitewire_job_item_id: A.jidRoof, requested_cents: 2000 }], { source: 'borrower', borrowerId: A.bor });
    const cancelled = await portalDraws.cancelRequest(A.app, row.id, { staffId: A.lo, reason: 'submitted by mistake' });
    ok('cancel lands with the reason', cancelled.status === 'cancelled' && /mistake/.test(cancelled.cancelled_reason));
    const tpItems = (await wfItems(A.app)).filter((i) => i.submission_type === 'trustpoint_import');
    ok('live coordinator task folded into the cancel',
      tpItems.some((i) => i.status === 'cancelled') && !tpItems.some((i) => ['open', 'in_progress'].includes(i.status)));
    ok('borrower told about the cancel', (await notesFor(A.app, 'borrower')).some((n) => /cancelled/i.test(n.title)));
    const st = await portalDraws.composerState(A.app);
    ok('cancel frees the slot', st.eligible === true && !st.open_portal_request);
  }
  await cleanup(A.app, A.bor, A.lo);

  // ============ 7. Trinity path ============
  {
    const B = await seedFile(TRIN_LABEL);
    const st = await portalDraws.composerState(B.app);
    ok('non-TrustPoint physical file routes to Trinity', st.physical === true && st.platform === 'trinity');
    const row = await portalDraws.createRequest(B.app, [
      { sitewire_job_item_id: B.jidKitchen, requested_cents: 30000 },
      { sitewire_job_item_id: B.jidRoof, requested_cents: 10000 },
    ], { source: 'staff', staffId: B.lo });
    const task = (await wfItems(B.app)).find((i) => i.submission_type === 'trinity_inspection_order');
    ok('Trinity task opened for the coordinator', task && ['open', 'in_progress'].includes(task.status));
    const order = (await db.query(`SELECT * FROM trinity_inspection_orders WHERE portal_draw_request_id=$1`, [row.id])).rows[0];
    ok('Trinity order record created (requested)', order && order.status === 'requested');

    const o2 = await portalDraws.advanceTrinityOrder(B.app, order.id, 'ordered', { staffId: B.lo, note: 'called Trinity' });
    ok('requested → ordered stamps who/when', o2.status === 'ordered' && o2.ordered_at != null && o2.ordered_by === B.lo && /called Trinity/.test(o2.note || ''));
    let err = null;
    try { await portalDraws.advanceTrinityOrder(B.app, order.id, 'entered', {}); }
    catch (e) { err = e; }
    ok('an out-of-order jump is refused (409)', err && err.status === 409);
    await portalDraws.advanceTrinityOrder(B.app, order.id, 'report_received', {});

    // the staff decision: over-requested refused; then a real per-line approval
    let err2 = null;
    try { await portalDraws.approveTrinityRequest(B.app, row.id, [{ sitewire_job_item_id: B.jidKitchen, approved_cents: 99000 }], { staffId: B.lo }); }
    catch (e) { err2 = e; }
    ok('approving above a requested line is refused', err2 && err2.status === 422);
    await db.query(
      `INSERT INTO sitewire_property_links (application_id, matched_by, state, sitewire_property_id)
       VALUES ($1,'created','live',940000002) ON CONFLICT (application_id) DO UPDATE SET matched_by='created', sitewire_property_id=940000002`, [B.app]);
    createdHistorical = []; transitions = [];
    const dec = await portalDraws.approveTrinityRequest(B.app, row.id, [
      { sitewire_job_item_id: B.jidKitchen, approved_cents: 25000 },
      { sitewire_job_item_id: B.jidRoof, approved_cents: 10000 },
    ], { staffId: B.lo });
    ok('decision recorded (approved $350)', dec.request.status === 'approved' && Number(dec.request.approved_cents) === 35000);
    ok('Trinity close-out created the historical draw from the request lines', dec.closeout && dec.closeout.ok === true
      && createdHistorical[0] && createdHistorical[0].requests.some((x) => x.job_item_id === B.jidKitchen && x.pending_approved_cents === 25000));
    const oDone = (await db.query(`SELECT * FROM trinity_inspection_orders WHERE id=$1`, [order.id])).rows[0];
    ok('order marked entered by the decision', oDone.status === 'entered');
    const tDone = (await wfItems(B.app)).find((i) => i.submission_type === 'trinity_inspection_order');
    ok('Trinity task completed by the decision', tDone && tDone.status === 'returned');
    ok('borrower told about the approval', (await notesFor(B.app, 'borrower')).some((n) => /reviewed/i.test(n.title)));
    await cleanup(B.app, B.bor, B.lo);
  }

  // ============ 7b. audit-4 hardening: dup lines, claim lease, resume, cancel guard, one-cycle ============
  {
    const D = await seedFile(TP_LABEL);
    let err = null;
    try {
      await portalDraws.createRequest(D.app, [
        { sitewire_job_item_id: D.jidKitchen, requested_cents: 5000 },
        { sitewire_job_item_id: D.jidKitchen, requested_cents: 5000 },
      ], { source: 'borrower', borrowerId: D.bor });
    } catch (e) { err = e; }
    ok('duplicate line entries are refused (422)', err && err.status === 422 && /entered twice/.test(err.message));

    // resume: a recorded-but-unfinished close-out finishes WITHOUT a second create
    const row = await portalDraws.createRequest(D.app, [{ sitewire_job_item_id: D.jidKitchen, requested_cents: 30000 }], { source: 'staff', staffId: D.lo });
    const tpId = `pd4-${tag}`;
    await db.query(`INSERT INTO trustpoint_draws (application_id, tp_project_id, tp_draw_id, number, status, requested_cents, approved_cents, portal_draw_request_id)
                    VALUES ($1,$2,$3,9,'APPROVED',30000,30000,$4)`, [D.app, `pd4p-${tag}`, tpId, row.id]);
    await db.query(`INSERT INTO trustpoint_draw_lines (application_id, tp_draw_id, sitewire_job_item_id, sow_line_key, name, approved_cents, source)
                    VALUES ($1,$2,$3,'k1','Unit 1 - Kitchen',30000,'manual')`, [D.app, tpId, D.jidKitchen]);
    await db.query(
      `INSERT INTO sitewire_property_links (application_id, matched_by, state, sitewire_property_id)
       VALUES ($1,'created','live',940000003) ON CONFLICT (application_id) DO UPDATE SET matched_by='created', sitewire_property_id=940000003`, [D.app]);
    const preRecorded = 960000000 + crypto.randomBytes(2).readUInt16BE(0);
    await db.query(`UPDATE portal_draw_requests SET status='approved', approved_cents=30000, tp_draw_id=$2, sitewire_draw_id=$3 WHERE id=$1`, [row.id, tpId, preRecorded]);
    createdHistorical = []; transitions = [];
    const res = await portalDraws.historicalCloseOut(D.app, row.id);
    ok('recorded close-out RESUMES: no second create, transition finishes it',
      res.ok === true && res.sitewire_draw_id === preRecorded && createdHistorical.length === 0
      && transitions.some((t) => t.id === preRecorded && t.action === 'approve')
      && (await db.query(`SELECT status FROM portal_draw_requests WHERE id=$1`, [row.id])).rows[0].status === 'closed_out');

    // claim lease: a fresh claim blocks an overlapping driver
    const row2 = (await db.query(
      `INSERT INTO portal_draw_requests (application_id, source, platform, lines, total_requested_cents, status, approved_cents, closeout_claimed_at)
       VALUES ($1,'staff','trustpoint','[]'::jsonb,30000,'approved',30000,now()) RETURNING id`, [D.app])).rows[0];
    await db.query(`UPDATE portal_draw_requests SET tp_draw_id=$2 WHERE id=$1`, [row2.id, tpId]);
    const res2 = await portalDraws.historicalCloseOut(D.app, row2.id);
    ok('an in-flight claim makes an overlapping driver skip', res2.skipped === 'close_out_in_flight');
    await db.query(`DELETE FROM portal_draw_requests WHERE id=$1`, [row2.id]);

    // cancel guard: a request whose Sitewire draw is already recorded can't be cancelled
    let err2 = null;
    try { await portalDraws.cancelRequest(D.app, row.id, { staffId: D.lo }); } catch (e) { err2 = e; }
    ok('a recorded/closed-out request refuses cancel (409)', err2 && err2.status === 409);
    await cleanup(D.app, D.bor, D.lo);
  }
  {
    // one draw = one cycle, both directions
    const E = await seedFile(TP_LABEL);
    const mirror = require('../src/trustpoint/mirror');
    const rowE = await portalDraws.createRequest(E.app, [{ sitewire_job_item_id: E.jidKitchen, requested_cents: 20000 }], { source: 'staff', staffId: E.lo });
    const tpE = `pd4e-${tag}`;
    await db.query(`INSERT INTO trustpoint_draws (application_id, tp_project_id, tp_draw_id, number, status, requested_cents, portal_draw_request_id)
                    VALUES ($1,$2,$3,1,'IN_REVIEW',20000,$4)`, [E.app, `pd4ep-${tag}`, tpE, rowE.id]);
    // an open Sitewire intake draw with the same amount must NOT intake-tie a portal-tied draw
    const swOpen = 965000000 + crypto.randomBytes(2).readUInt16BE(0);
    await db.query(`INSERT INTO sitewire_draws (application_id, sitewire_draw_id, number, status, total_requested_cents) VALUES ($1,$2,5,'pending',20000)`, [E.app, swOpen]);
    await mirror.linkToSitewireIntake(E.app, (await db.query(`SELECT * FROM trustpoint_draws WHERE tp_draw_id=$1`, [tpE])).rows[0]);
    ok('a portal-tied draw never intake-ties (one cycle, one home)',
      (await db.query(`SELECT sitewire_draw_id FROM trustpoint_draws WHERE tp_draw_id=$1`, [tpE])).rows[0].sitewire_draw_id == null);
    // and if a dual tie somehow existed, the close-out parks instead of double-drawing
    await db.query(`UPDATE trustpoint_draws SET sitewire_draw_id=$2, approved_cents=20000, status='APPROVED' WHERE tp_draw_id=$1`, [tpE, swOpen]);
    await db.query(`UPDATE portal_draw_requests SET status='approved', approved_cents=20000, tp_draw_id=$2 WHERE id=$1`, [rowE.id, tpE]);
    const resE = await portalDraws.historicalCloseOut(E.app, rowE.id);
    ok('a dual-tied draw parks the close-out (never a second Sitewire draw)', resE.parked === 'tied_to_live_sitewire_draw');
    await cleanup(E.app, E.bor, E.lo);
  }

  // ============ 8. external files never compose ============
  {
    const C = await seedFile(EXT_LABEL);
    const st = await portalDraws.composerState(C.app);
    ok('external platform: no composer', st.physical === false && st.eligible === false);
    await cleanup(C.app, C.bor, C.lo);
  }

  await db.query(`DELETE FROM sitewire_inspection_rules WHERE partner_label IN ($1,$2,$3)`, [TP_LABEL, TRIN_LABEL, EXT_LABEL]).catch(() => {});
  console.log(`test-portal-draws-db: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test-portal-draws-db crashed:', e); process.exit(1); });
