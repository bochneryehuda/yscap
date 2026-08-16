/* AUTOPILOT borrower delivery — the WIRING, end-to-end (owner-directed 2026-08-14).
 *
 * Proves maybeAutoDeliver -> deliverFindings -> persistDrawFindings against a real Postgres, with the
 * Sitewire client reads STUBBED (no network):
 *   1. a ready VIRTUAL draw with the inspector's amounts and no finding → auto-delivers (findings row,
 *      status 'delivered', total = the inspector sum), and the SAME borrower it would email is looped in;
 *   2. a second pass with nothing changed → skip (no duplicate finding);
 *   3. the inspector's amount moves while still 'delivered' → auto RE-SEND, and the stored total updates;
 *   4. a finding the borrower already ACCEPTED → never touched;
 *   5. the kill-switch DRAW_BORROWER_AUTODELIVER_ENABLED=0 → skip, nothing written;
 *   6. a TrustPoint file → skip (it delivers on its own mirror APPROVED transition);
 *   7. a PHYSICAL file → skip at 'pending' (wait for approval), deliver once 'approved';
 *   8. a file's first-ever reconcile → skip (go-forward only).
 * DB-gated: needs DATABASE_URL with migrations applied; skips cleanly otherwise.
 * Run: SITEWIRE_ENABLED=1 DATABASE_URL=... node scripts/test-draw-autodeliver-db.js
 */
process.env.SITEWIRE_ENABLED = '1';   // set BEFORE config loads so switches.on('SITEWIRE_ENABLED') is true
const path = require('path');
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };

// ---- part 1: the exports exist (pure — no DB needed) ----
{
  const df = require(path.join('..', 'src', 'sitewire', 'deliver-findings'));
  ok('exports maybeAutoDeliver', typeof df.maybeAutoDeliver === 'function');
  ok('exports deliverFindings', typeof df.deliverFindings === 'function');
  ok('exports autopilotEnabled', typeof df.autopilotEnabled === 'function');
}

if (!process.env.DATABASE_URL) {
  console.log(`\n(part 1 only — no DATABASE_URL) ${pass} passed`);
  console.log('SKIP test-draw-autodeliver DB parts (no DATABASE_URL)');
  process.exit(fail === 0 ? 0 : 1);
}

const db = require('../src/db');
const df = require('../src/sitewire/deliver-findings');
const client = require('../src/sitewire/client');
const crypto = require('crypto');

// STUB the two live Sitewire reads persistDrawFindings makes. Deterministic per draw so several
// draws can be delivered in one run without colliding on the globally-unique request id.
const REQOF = (drawId) => Number(drawId) + 900000;
const STUB_APPROVED = {};                                   // per-draw override
const apprOf = (drawId) => (STUB_APPROVED[drawId] != null ? STUB_APPROVED[drawId] : 1600000);
let JITEM;
client.getDraw = async (id) => ({ id: Number(id), status: 'pending', pdf_src: null,
  requests: [{ id: REQOF(id), requested_cents: 2000000, approved_cents: apprOf(id), job_item: { id: JITEM, name: 'Kitchen' } }] });
client.getRequest = async (rid) => ({ id: Number(rid), requested_cents: 2000000, approved_cents: apprOf(Number(rid) - 900000),
  job_item: { id: JITEM, name: 'Kitchen' }, inspections: [], inspector_comments: null, lender_comments: null });

const findingOf = async (draw) => (await db.query(`SELECT status, total_approved_cents FROM draw_findings WHERE sitewire_draw_id=$1`, [draw])).rows[0] || null;
const findingCount = async (draw) => Number((await db.query(`SELECT count(*)::int c FROM draw_findings WHERE sitewire_draw_id=$1`, [draw])).rows[0].c);

(async () => {
  const email = 'auto' + crypto.randomBytes(5).toString('hex') + '@example.com';
  const bor = (await db.query(`INSERT INTO borrowers(first_name,last_name,email) VALUES('Auto','Deliver',$1) RETURNING id`, [email])).rows[0].id;
  const loan = 'AU' + crypto.randomBytes(3).toString('hex');
  const app = (await db.query(`INSERT INTO applications(borrower_id,status,ys_loan_number,property_address) VALUES($1,'funded',$2,'{"oneLine":"9 Test St","city":"Lakewood","state":"NJ","zip":"08701"}') RETURNING id`, [bor, loan])).rows[0].id;
  const R = crypto.randomBytes(2).readUInt16BE(0);
  const DRAW = Number('61' + R), DRAW2 = DRAW + 1, DRAW3 = DRAW + 2;
  const BUDGET = DRAW + 500; JITEM = DRAW + 100;
  await db.query(`INSERT INTO sitewire_property_links(application_id,sitewire_property_id,matched_by,state,pushed_at) VALUES($1,$2,'created','live',now())`, [app, DRAW + 700]);
  await db.query(`INSERT INTO sitewire_job_item_links(application_id,sitewire_budget_id,sow_line_key,section_token,sitewire_job_item_id,name,budgeted_cents,state) VALUES($1,$2,'cat:0','all',$3,'Kitchen',5000000,'live')`, [app, BUDGET, JITEM]);
  // three draws, all mirrored at status 'pending' with the inspector's amount on the request line.
  for (const draw of [DRAW, DRAW2, DRAW3]) {
    await db.query(`INSERT INTO sitewire_draws(application_id,sitewire_draw_id,number,status,total_requested_cents,total_approved_cents) VALUES($1,$2,$3,'pending',2000000,0)`, [app, draw, draw - DRAW + 1]);
    await db.query(`INSERT INTO sitewire_draw_requests(sitewire_draw_id,sitewire_request_id,sitewire_job_item_id,job_item_name,requested_cents,approved_cents) VALUES($1,$2,$3,'Kitchen',2000000,1600000)`, [draw, REQOF(draw), JITEM]);
  }
  const SW = { platform: 'sitewire', method: 'mobile' };

  // ---- 1. FIRST delivery ----
  const r1 = await df.maybeAutoDeliver(app, DRAW, SW, {});
  ok('1a first pass → deliver', r1.action === 'deliver' && r1.reason === 'first_delivery');
  const f1 = await findingOf(DRAW);
  ok('1b finding created, status delivered', f1 && f1.status === 'delivered');
  ok('1c finding total = inspector sum (1600000)', f1 && Number(f1.total_approved_cents) === 1600000);
  ok('1d reports back a delivery summary', r1.delivered && r1.delivered.finding_id != null);

  // ---- 2. unchanged → skip, no duplicate ----
  const r2 = await df.maybeAutoDeliver(app, DRAW, SW, {});
  ok('2a unchanged → skip', r2.action === 'skip' && r2.reason === 'unchanged');
  ok('2b still exactly one finding', (await findingCount(DRAW)) === 1);

  // ---- 3. inspector amount moves (re-inspection) → auto re-send ----
  STUB_APPROVED[DRAW] = 1700000;
  await db.query(`UPDATE sitewire_draw_requests SET approved_cents=1700000 WHERE sitewire_draw_id=$1`, [DRAW]);
  const r3 = await df.maybeAutoDeliver(app, DRAW, SW, {});
  ok('3a amount changed → resend', r3.action === 'resend' && r3.reason === 'amount_changed');
  const f3 = await findingOf(DRAW);
  ok('3b finding total updated to new amount (1700000)', f3 && Number(f3.total_approved_cents) === 1700000);
  ok('3c still one finding (re-send updates, never duplicates)', (await findingCount(DRAW)) === 1);
  ok('3d still delivered (borrower has not acted)', f3 && f3.status === 'delivered');

  // ---- 4. borrower ACCEPTED → never touched again ----
  await db.query(`UPDATE draw_findings SET status='accepted', accepted_at=now(), accepted_via='portal' WHERE sitewire_draw_id=$1`, [DRAW]);
  STUB_APPROVED[DRAW] = 1800000;
  await db.query(`UPDATE sitewire_draw_requests SET approved_cents=1800000 WHERE sitewire_draw_id=$1`, [DRAW]);
  const r4 = await df.maybeAutoDeliver(app, DRAW, SW, {});
  ok('4a accepted finding → skip (finding_accepted)', r4.action === 'skip' && r4.reason === 'finding_accepted');
  const f4 = await findingOf(DRAW);
  ok('4b accepted finding untouched (still accepted, old amount)', f4 && f4.status === 'accepted' && Number(f4.total_approved_cents) === 1700000);

  // ---- 5. kill-switch off → skip, nothing written (fresh draw DRAW2) ----
  process.env.DRAW_BORROWER_AUTODELIVER_ENABLED = '0';
  const r5 = await df.maybeAutoDeliver(app, DRAW2, SW, {});
  ok('5a kill-switch off → skip (autopilot_off)', r5.action === 'skip' && r5.reason === 'autopilot_off');
  ok('5b kill-switch: no finding created', (await findingCount(DRAW2)) === 0);
  delete process.env.DRAW_BORROWER_AUTODELIVER_ENABLED;

  // ---- 6. TrustPoint platform → skip (its own mirror delivers) ----
  const r6 = await df.maybeAutoDeliver(app, DRAW2, { platform: 'trustpoint', method: null }, {});
  ok('6a trustpoint → skip (not_sitewire)', r6.action === 'skip' && r6.reason === 'not_sitewire');
  ok('6b trustpoint: no finding created', (await findingCount(DRAW2)) === 0);

  // ---- 7. PHYSICAL: skip at 'pending', deliver once 'approved' ----
  const PHYS = { platform: 'sitewire', method: 'traditional' };
  const r7 = await df.maybeAutoDeliver(app, DRAW2, PHYS, {});
  ok('7a physical pending → skip (not_ready)', r7.action === 'skip' && r7.reason === 'not_ready');
  ok('7b physical pending: no finding', (await findingCount(DRAW2)) === 0);
  await db.query(`UPDATE sitewire_draws SET status='approved' WHERE sitewire_draw_id=$1`, [DRAW2]);
  const r8 = await df.maybeAutoDeliver(app, DRAW2, PHYS, {});
  ok('7c physical approved → deliver', r8.action === 'deliver');
  ok('7d physical approved: finding created', (await findingCount(DRAW2)) === 1);

  // ---- 8. first-ever reconcile → skip (go-forward only) ----
  const r9 = await df.maybeAutoDeliver(app, DRAW3, SW, { firstReconcile: true });
  ok('8a firstReconcile → skip', r9.action === 'skip' && r9.reason === 'first_reconcile');
  ok('8b firstReconcile: no finding', (await findingCount(DRAW3)) === 0);

  // ---- 9. AUTO RE-SEND never LOOPS when the mirror undercounts the getRequest fallback ----
  // The borrower's finding total is stored from fetchDrawFindings (getDraw + the per-request
  // GET /requests/:id fallback). The live request mirror is getDraw-ONLY, so a draw payload that omits
  // a per-request approved amount which getRequest still supplies leaves the mirror sum permanently
  // BELOW the finding total. The re-send must NOT fire on that gap — it re-reads authoritatively and
  // compares like-for-like. Pre-merge audit 2026-08-14: without the authoritative re-read decideAutoDeliver
  // returned 'resend' EVERY poll → re-emailed the borrower and reset delivered_at (the wire clock).
  const r10 = await df.maybeAutoDeliver(app, DRAW3, SW, {});   // real first delivery (mirror == finding == 1.6M)
  ok('9a DRAW3 first delivery', r10.action === 'deliver' && r10.reason === 'first_delivery');
  const f10 = await findingOf(DRAW3);
  ok('9b finding total = 1600000', f10 && Number(f10.total_approved_cents) === 1600000);
  const deliveredAt0 = (await db.query(`SELECT delivered_at FROM draw_findings WHERE sitewire_draw_id=$1`, [DRAW3])).rows[0].delivered_at;
  // Drop ONLY the mirror below the finding total — the REAL inspector value is unchanged (getDraw and
  // getRequest still say 1.6M), exactly as when the draw payload omits an amount getRequest carries.
  await db.query(`UPDATE sitewire_draw_requests SET approved_cents=1000000 WHERE sitewire_draw_id=$1`, [DRAW3]);
  const r11 = await df.maybeAutoDeliver(app, DRAW3, SW, {});
  ok('9c mirror below finding, real value unchanged → skip unchanged (NO loop)', r11.action === 'skip' && r11.reason === 'unchanged');
  ok('9d still exactly one finding', (await findingCount(DRAW3)) === 1);
  const deliveredAt1 = (await db.query(`SELECT delivered_at FROM draw_findings WHERE sitewire_draw_id=$1`, [DRAW3])).rows[0].delivered_at;
  ok('9e delivered_at NOT reset (wire clock intact)', String(deliveredAt0) === String(deliveredAt1));
  // A GENUINE re-inspection still re-sends: move the real inspector value (stub + mirror) up.
  STUB_APPROVED[DRAW3] = 1750000;
  await db.query(`UPDATE sitewire_draw_requests SET approved_cents=1750000 WHERE sitewire_draw_id=$1`, [DRAW3]);
  const r12 = await df.maybeAutoDeliver(app, DRAW3, SW, {});
  ok('9f real inspector change → resend', r12.action === 'resend' && r12.reason === 'amount_changed');
  ok('9g finding total updated to 1750000', Number((await findingOf(DRAW3)).total_approved_cents) === 1750000);

  console.log(`\n${fail === 0 ? 'ALL' : fail + ' FAILED,'} ${pass} auto-deliver wiring assertions ${fail === 0 ? 'passed' : ''}`);

  // Let the borrower fan-out this test just triggered finish before tearing the file
  // down. `notify._emailRow` is deliberately FIRE-AND-FORGET, so its `sent_emails`
  // INSERT can still be in flight here — and the cleanup DELETE cascades into
  // `notifications`, which is the same parent that insert is holding. The two grab the
  // rows in opposite orders and Postgres kills one of them (40P01). The INSERT side
  // already retries a deadlock; the DELETE side is the victim and does not, so the
  // test dies AFTER every assertion has passed. `drainEmails()` is the test-only
  // helper built for exactly this — notify.js's own comment names this failure — and
  // the sibling draw suite (test-draw-loop-in-db.js) already uses it.
  await require('../src/lib/notify').drainEmails().catch(() => {});

  await db.query(`DELETE FROM applications WHERE id=$1`, [app]);
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [bor]);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('THREW', e); process.exit(1); });
