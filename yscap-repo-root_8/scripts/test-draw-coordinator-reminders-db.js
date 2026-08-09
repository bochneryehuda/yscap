/**
 * Draw workflow — Increment C: the four per-status COORDINATOR reminders
 * (src/lib/notification-digests.js; owner-directed 2026-08-04, blueprint
 * docs/DRAW-WORKFLOW-STATUS-RESEARCH.md).
 *
 * Every stage of the draw workflow that WAITS ON US / the draw coordinator now has a
 * self-gated nudge, so a draw never sits silently between the borrower approving and
 * the money moving:
 *   7)  order_trustpoint         — a submitted draw not yet entered into TrustPoint (daily)
 *   8)  order_trinity            — a physical inspection requested but not ordered on Trinity (daily)
 *   9)  investor_pending_delivery — the borrower approved, not yet delivered to the investor (2 days)
 *   10) with_investor            — delivered to the investor, +48h then every 2 days until funded
 *
 * This exercises the REAL columns each sweep keys on (a phantom column would silently
 * disable a sweep from inside its swallowing catch — the #248 class — and a pure test
 * could never catch it). Requires DATABASE_URL with migrations applied; skips otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-draw-coordinator-reminders (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
process.env.EMAIL_PROVIDER = 'none';

const assert = require('assert');
const db = require('../src/db');
const email = require('../src/lib/email');
const D = require('../src/lib/notification-digests');

let n = 0; const ok = (m) => { n++; console.log('  ok -', m); };
const sent = [];
email.sendMail = async (m) => { sent.push(m); return { ok: true }; };
const reset = () => { sent.length = 0; };
const to = (e) => sent.find((x) => (Array.isArray(x.to) ? x.to : [x.to]).includes(e));
const PARTNERS = ['BlueLake', 'Blue Lake', 'Fidelis', 'Churchill', 'RCN', 'Temple View', 'CorrFirst'];

(async () => {
  const suffix = Date.now();
  const bemail = `dc-borrower-${suffix}@example.com`;
  const cemail = `dc-coord-${suffix}@example.com`;
  const DRAW = 700000000 + (suffix % 200000000);        // globally-unique sitewire_draw_id

  const br = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Draw','Coord',$1) RETURNING id`, [bemail])).rows[0];
  const app = (await db.query(
    `INSERT INTO applications (borrower_id, ys_loan_number, property_address, program, loan_type, status)
     VALUES ($1,$2,$3,'gold','purchase','funded') RETURNING id`,
    [br.id, `DC-${suffix}`, JSON.stringify({ line1: '9 Draw St', oneLine: '9 Draw St, Brooklyn, NY' })])).rows[0];
  // The draw coordinator: an active staff member recorded as who "started the draw" — precedence #1
  // in drawCoordinatorsForFile, so coordinatorsOrDesk resolves to exactly this person.
  const coord = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Coordinator Katz','draw_coordinator',true) RETURNING id`, [cemail])).rows[0];
  await db.query(
    `INSERT INTO sitewire_property_links (application_id, sitewire_property_id, matched_by, state, lifecycle_state, pushed_at, draw_setup_started_by)
     VALUES ($1,$2,'created','live','active',now(),$3)`, [app.id, DRAW + 5, coord.id]);

  const clearStamp = (action) => db.query(`DELETE FROM audit_log WHERE action=$1 AND entity_id=$2`, [action, app.id]).catch(() => {});
  // The investor reminders speak of "the investor" — a STAFF surface that must still never print the
  // capital-partner (note-buyer) name in its body.
  const noPartner = (m) => PARTNERS.forEach((p) => assert.ok(!String(m.html || '').includes(p),
    `an investor coordinator reminder must not print a capital-partner name: ${p}`));

  /* ── 7) order_trustpoint (blueprint 2b) ── */
  await db.query(
    `INSERT INTO portal_draw_requests (application_id, source, status, platform, lines, total_requested_cents)
     VALUES ($1,'staff','submitted','trustpoint','[{"name":"Roof","requested_cents":500000}]'::jsonb,500000)`, [app.id]);
  reset(); const cTp = await D.orderTrustpointOnce();
  let m = to(cemail);
  assert.ok(cTp >= 1 && m, 'trustpoint: reminder sent to the draw coordinator');
  assert.ok(/TrustPoint/i.test(m.subject), 'trustpoint: subject names the platform');
  reset(); await D.orderTrustpointOnce();
  assert.ok(!to(cemail), 'trustpoint: gated on the 2nd run (once / day)');
  // Once the coordinator enters it (status leaves 'submitted' / tp_draw_id set) → the nudge stops.
  await clearStamp('order_trustpoint_reminder');
  await db.query(`UPDATE portal_draw_requests SET status='entered', tp_draw_id='TP-1' WHERE application_id=$1`, [app.id]);
  reset(); const cTp2 = await D.orderTrustpointOnce();
  assert.ok(cTp2 === 0 && !to(cemail), 'trustpoint: an entered draw raises no reminder');
  await db.query(`DELETE FROM portal_draw_requests WHERE application_id=$1`, [app.id]);
  await clearStamp('order_trustpoint_reminder');
  ok('order_trustpoint: submitted-not-entered nudges the coordinator daily; entering it stops the nudge');

  /* ── 8) order_trinity (blueprint 2p) ── */
  await db.query(`INSERT INTO trinity_inspection_orders (application_id, status) VALUES ($1,'requested')`, [app.id]);
  reset(); const cTr = await D.orderTrinityOnce();
  m = to(cemail);
  assert.ok(cTr >= 1 && m, 'trinity: reminder sent to the draw coordinator');
  assert.ok(/Trinity/i.test(m.subject), 'trinity: subject names the platform');
  reset(); await D.orderTrinityOnce();
  assert.ok(!to(cemail), 'trinity: gated on the 2nd run (once / day)');
  await clearStamp('order_trinity_reminder');
  await db.query(`UPDATE trinity_inspection_orders SET status='ordered' WHERE application_id=$1`, [app.id]);
  reset(); const cTr2 = await D.orderTrinityOnce();
  assert.ok(cTr2 === 0 && !to(cemail), 'trinity: an ordered inspection raises no reminder');
  await db.query(`DELETE FROM trinity_inspection_orders WHERE application_id=$1`, [app.id]);
  await clearStamp('order_trinity_reminder');
  ok('order_trinity: requested-not-ordered nudges the coordinator daily; ordering it stops the nudge');

  /* ── 9) investor_pending_delivery (blueprint 7a) ── */
  // An accepted finding with NO note buyer set → there is no investor to deliver to, so no nudge.
  await db.query(
    `INSERT INTO draw_findings (application_id, sitewire_draw_id, status, accepted_at, delivered_at)
     VALUES ($1,$2,'accepted', now()-interval '1 day', now()-interval '2 days')`, [app.id, DRAW]);
  reset(); await D.investorPendingDeliveryOnce();
  // SCOPED TO THIS FILE, not to the sweep's RETURN COUNT. The count is global — it answers "did
  // any file anywhere in this database need a nudge?" — so asserting it is 0 quietly required the
  // whole test database to hold no other deliverable draw. It held only while no other suite left
  // one, and a suite added later (the table-funding one, whose fixtures are legitimately accepted-
  // but-undelivered draws) made it fail with nothing wrong on either side. `cemail` is unique to
  // this run, so the recipient check is the assertion that was always meant, and the stamp check
  // proves the sweep did not act on THIS application either.
  assert.ok(!to(cemail), 'investor-pending: a file with no note buyer raises no deliver-to-investor nudge');
  assert.ok(!(await db.query(
    `SELECT 1 FROM audit_log WHERE action='investor_pending_delivery' AND entity_id=$1 LIMIT 1`, [app.id])).rows[0],
  'investor-pending: …and the sweep left no stamp on this file');
  // Set the note buyer → the coordinator is reminded to deliver.
  await db.query(`UPDATE applications SET lender='Fidelis' WHERE id=$1`, [app.id]);
  reset(); const cPend = await D.investorPendingDeliveryOnce();
  m = to(cemail);
  assert.ok(cPend >= 1 && m, 'investor-pending: with a note buyer, the coordinator is reminded to deliver');
  assert.ok(/investor/i.test(m.subject), 'investor-pending: subject speaks of the investor, not the note buyer');
  noPartner(m);   // a STAFF reminder speaks of "the investor" — it must not print the capital-partner name
  assert.ok(!to(bemail), 'investor-pending: the borrower is never a recipient (coordinator-only)');
  reset(); await D.investorPendingDeliveryOnce();
  assert.ok(!to(cemail), 'investor-pending: gated on the 2nd run (once / 2 days)');
  // A FINAL-approved draw is done — even accepted + no delivery, it must not nudge.
  await clearStamp('investor_pending_delivery');
  await db.query(`INSERT INTO sitewire_draws (application_id, sitewire_draw_id, status) VALUES ($1,$2,'approved')`, [app.id, DRAW]);
  reset(); const cFinal = await D.investorPendingDeliveryOnce();
  assert.ok(cFinal === 0 && !to(cemail), 'investor-pending: a final-approved draw is done — no deliver nudge');
  await db.query(`UPDATE sitewire_draws SET status='inspecting' WHERE sitewire_draw_id=$1`, [DRAW]);
  // A SENT delivery stops the pending nudge; an ERRORED delivery does NOT (still needs delivering).
  await clearStamp('investor_pending_delivery');
  await db.query(
    `INSERT INTO draw_investor_deliveries (application_id, sitewire_draw_id, funding_mode, status, sent_at)
     VALUES ($1,$2,'reimbursement','error', now())`, [app.id, DRAW]);
  reset(); const cErr = await D.investorPendingDeliveryOnce();
  assert.ok(cErr >= 1 && to(cemail), 'investor-pending: an ERRORED delivery still counts as pending — nudge again');
  await clearStamp('investor_pending_delivery');
  await db.query(`UPDATE draw_investor_deliveries SET status='sent', sent_at=now() WHERE application_id=$1`, [app.id]);
  reset(); const cSent = await D.investorPendingDeliveryOnce();
  assert.ok(cSent === 0 && !to(cemail), 'investor-pending: once a delivery is SENT, the pending nudge stops');
  ok('investor_pending_delivery: fires only on an approved draw with a note buyer and no sent delivery; errored delivery still pending; final-approved is done');

  /* ── 10) with_investor (blueprint 7b) — the SAME sent delivery, aged past +48h ── */
  // Fresh (< 48h) delivery → NOT yet reminded.
  reset(); const cFresh = await D.withInvestorOnce();
  assert.ok(cFresh === 0 && !to(cemail), 'with-investor: a delivery under 48h old is not chased yet (+48h rule)');
  // Age it past 48h → the coordinator is reminded to chase the investor.
  await db.query(`UPDATE draw_investor_deliveries SET sent_at=now()-interval '3 days' WHERE application_id=$1`, [app.id]);
  reset(); const cWith = await D.withInvestorOnce();
  m = to(cemail);
  assert.ok(cWith >= 1 && m, 'with-investor: a delivery older than 48h chases the investor');
  assert.ok(/investor/i.test(m.subject), 'with-investor: subject speaks of the investor');
  noPartner(m);
  assert.ok(!to(bemail), 'with-investor: the borrower is never a recipient (coordinator-only)');
  reset(); await D.withInvestorOnce();
  assert.ok(!to(cemail), 'with-investor: gated on the 2nd run (every 2 days)');
  // MULTI-DRAW (regression, audit 2026-08-05): a fresh delivery must NOT mask an OLDER overdue draw on
  // the same file. DRAW's delivery is aged 3 days; add DRAW2 with a delivery sent 2h ago. with_investor
  // must STILL fire for DRAW, and count ONLY the overdue draw (the +48h test is per-draw, not per-file).
  const DRAW2 = DRAW + 1;
  await clearStamp('draw_with_investor_reminder');
  await db.query(`INSERT INTO sitewire_draws (application_id, sitewire_draw_id, status) VALUES ($1,$2,'inspecting')`, [app.id, DRAW2]);
  await db.query(
    `INSERT INTO draw_findings (application_id, sitewire_draw_id, status, accepted_at, delivered_at)
     VALUES ($1,$2,'accepted', now()-interval '1 day', now()-interval '2 days')`, [app.id, DRAW2]);
  await db.query(
    `INSERT INTO draw_investor_deliveries (application_id, sitewire_draw_id, funding_mode, status, sent_at)
     VALUES ($1,$2,'reimbursement','sent', now()-interval '2 hours')`, [app.id, DRAW2]);
  reset(); const cMulti = await D.withInvestorOnce();
  m = to(cemail);
  assert.ok(cMulti >= 1 && m, 'with-investor: a fresh draw does NOT mask an overdue draw on a multi-draw file');
  assert.ok(/A draw is with the investor/i.test(m.subject), 'with-investor: only the OVERDUE draw is counted (singular) — the fresh one is not chased yet');
  await db.query(`DELETE FROM draw_investor_deliveries WHERE application_id=$1 AND sitewire_draw_id=$2`, [app.id, DRAW2]);
  await db.query(`DELETE FROM draw_findings WHERE application_id=$1 AND sitewire_draw_id=$2`, [app.id, DRAW2]);
  await db.query(`DELETE FROM sitewire_draws WHERE sitewire_draw_id=$1`, [DRAW2]);
  // Lifecycle exclusion for 7b SPECIFICALLY: the aged delivery is still present, so absent the paid-off
  // guard it WOULD fire — this proves the guard rather than a trivially-empty state.
  await clearStamp('draw_with_investor_reminder');
  await db.query(`UPDATE sitewire_property_links SET lifecycle_state='paid_off' WHERE application_id=$1`, [app.id]);
  reset(); const cWithClosed = await D.withInvestorOnce();
  assert.ok(cWithClosed === 0 && !to(cemail), 'with-investor: a paid-off project is excluded even with a live aged delivery');
  await db.query(`UPDATE sitewire_property_links SET lifecycle_state='active' WHERE application_id=$1`, [app.id]);
  // Final approval lands → the draw is done, the chase stops.
  await clearStamp('draw_with_investor_reminder');
  await db.query(`UPDATE sitewire_draws SET status='approved' WHERE sitewire_draw_id=$1`, [DRAW]);
  reset(); const cWithDone = await D.withInvestorOnce();
  assert.ok(cWithDone === 0 && !to(cemail), 'with-investor: a final-approved draw stops the chase');
  await db.query(`UPDATE sitewire_draws SET status='inspecting' WHERE sitewire_draw_id=$1`, [DRAW]);
  // MANUAL funding mode (#11): the delivery is still present and aged past +48h, so absent the manual
  // exclusion it WOULD chase — this exercises the REAL query (with notThrottled/activeManagedLink), so it
  // also guards the 7b alias-collision class (a thrown query is swallowed to 0, which the flip-back catches).
  await clearStamp('draw_with_investor_reminder');
  await db.query(`UPDATE draw_investor_deliveries SET funding_mode='manual' WHERE application_id=$1 AND sitewire_draw_id=$2`, [app.id, DRAW]);
  reset(); const cManual = await D.withInvestorOnce();
  assert.ok(cManual === 0 && !to(cemail), 'with-investor: a MANUAL delivery is handled off-platform — never chased');
  // Flip back to an emailed mode → it chases again, proving the exclusion did the work (not a thrown query).
  await clearStamp('draw_with_investor_reminder');
  await db.query(`UPDATE draw_investor_deliveries SET funding_mode='reimbursement' WHERE application_id=$1 AND sitewire_draw_id=$2`, [app.id, DRAW]);
  reset(); const cBack = await D.withInvestorOnce();
  assert.ok(cBack >= 1 && to(cemail), 'with-investor: switching the mode back off manual resumes the chase');
  ok('with_investor: chases only after +48h, every 2 days, until final approval; a manual delivery is never chased');

  /* ── 11) lifecycle guard (CLAUDE.md Sitewire rule 10): a finished/paid-off project is excluded ──
     Re-arm every sweep's trigger, flip the link to paid_off, and assert all four stay silent. */
  await Promise.all([
    clearStamp('order_trustpoint_reminder'), clearStamp('order_trinity_reminder'),
    clearStamp('investor_pending_delivery'), clearStamp('draw_with_investor_reminder'),
  ]);
  await db.query(`UPDATE sitewire_property_links SET lifecycle_state='paid_off' WHERE application_id=$1`, [app.id]);
  await db.query(
    `INSERT INTO portal_draw_requests (application_id, source, status, platform, lines, total_requested_cents)
     VALUES ($1,'staff','submitted','trustpoint','[{"name":"Roof","requested_cents":500000}]'::jsonb,500000)`, [app.id]);
  await db.query(`INSERT INTO trinity_inspection_orders (application_id, status) VALUES ($1,'requested')`, [app.id]);
  await db.query(`DELETE FROM draw_investor_deliveries WHERE application_id=$1`, [app.id]);   // 7a would fire (accepted, no sent delivery)
  reset();
  const closed = (await D.orderTrustpointOnce()) + (await D.orderTrinityOnce())
    + (await D.investorPendingDeliveryOnce()) + (await D.withInvestorOnce());
  assert.ok(closed === 0 && !to(cemail), 'a paid-off project raises none of the four coordinator reminders (rule 10)');
  ok('finished/paid-off project excluded from all four Increment-C reminders');

  // cleanup (best-effort, FK-safe order)
  await db.query(`DELETE FROM draw_investor_deliveries WHERE application_id=$1`, [app.id]).catch(() => {});
  await db.query(`DELETE FROM draw_findings WHERE application_id=$1`, [app.id]).catch(() => {});
  await db.query(`DELETE FROM sitewire_draws WHERE sitewire_draw_id=$1`, [DRAW]).catch(() => {});
  await db.query(`DELETE FROM portal_draw_requests WHERE application_id=$1`, [app.id]).catch(() => {});
  await db.query(`DELETE FROM trinity_inspection_orders WHERE application_id=$1`, [app.id]).catch(() => {});
  await db.query(`DELETE FROM sitewire_property_links WHERE application_id=$1`, [app.id]).catch(() => {});
  await db.query(`DELETE FROM audit_log WHERE entity_id=$1`, [app.id]).catch(() => {});
  await db.query(`DELETE FROM applications WHERE id=$1`, [app.id]).catch(() => {});
  await db.query(`DELETE FROM staff_users WHERE id=$1`, [coord.id]).catch(() => {});
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [br.id]).catch(() => {});

  console.log(`\nAll ${n} draw-coordinator-reminder checks passed.`);
  await db.pool.end();
})().catch((e) => { console.error('FAIL:', e.message, e.stack); process.exit(1); });
