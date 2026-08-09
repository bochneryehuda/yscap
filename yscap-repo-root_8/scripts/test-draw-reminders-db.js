/* THE DRAW REMINDERS THAT DID NOT EXIST — against a REAL database
 * (owner-directed 2026-08-09).
 *
 * Each covers a stretch where a draw could sit silently with nobody chasing it. A reminder that
 * never fires is worse than none, so every one of these is proven to FIRE on the state it targets
 * AND to stay quiet on the state next to it — and, because a new sweep's SQL is exactly where this
 * repo's phantom-column bug lives (a wrong column name inside a swallowing catch reads as "nothing
 * to do, forever"), every query is executed against the real schema.
 *
 * DB-gated: needs DATABASE_URL with migrations applied; skips cleanly otherwise.
 * Run: DATABASE_URL=... node scripts/test-draw-reminders-db.js
 */
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const eq = (name, got, exp) => { if (JSON.stringify(got) === JSON.stringify(exp)) pass++; else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`); } };

if (!process.env.DATABASE_URL) {
  console.log('SKIP test-draw-reminders-db (no DATABASE_URL)');
  process.exit(0);
}

const crypto = require('crypto');
const db = require('../src/db');
const D = require('../src/lib/notification-digests');

const ACTIONS = {
  inspection_late: 'draw_inspection_late',
  unreviewed: 'draw_findings_unreviewed',
  unrecorded: 'draw_approved_unrecorded',
  fee_owed: 'investor_fee_owed_chase',
  retainage: 'retainage_releasable',
};

(async () => {
  const email = 'rm' + crypto.randomBytes(5).toString('hex') + '@example.com';
  const bor = (await db.query(`INSERT INTO borrowers(first_name,last_name,email) VALUES('Remind','Test',$1) RETURNING id`, [email])).rows[0].id;
  const loan = 'RM' + crypto.randomBytes(3).toString('hex');
  const app = (await db.query(
    `INSERT INTO applications(borrower_id,status,ys_loan_number,lender,property_address)
     VALUES($1,'funded',$2,'Fidelis Investors LLC','{"oneLine":"9 Reminder Way"}') RETURNING id`, [bor, loan])).rows[0].id;
  const BASE = 950000 + crypto.randomBytes(2).readUInt16BE(0) * 10;
  const DRAW = BASE;
  await db.query(`INSERT INTO sitewire_property_links(application_id,sitewire_property_id,matched_by,state,pushed_at) VALUES($1,$2,'created','live',now())`, [app, BASE + 2]);

  // Whether a sweep acted on OUR file is read from its own durable stamp — the same row the gate
  // reads, so this tests the real self-gating rather than a side effect.
  const stamped = async (action) => Number((await db.query(
    `SELECT count(*)::int c FROM audit_log WHERE action=$1 AND entity_id::text=$2::text`, [action, app])).rows[0].c);
  const clearStamps = async () => db.query(`DELETE FROM audit_log WHERE entity_id::text=$1::text`, [app]);
  const resetDraws = async () => {
    await db.query(`DELETE FROM draw_disbursements WHERE application_id=$1`, [app]);
    await db.query(`DELETE FROM draw_findings WHERE application_id=$1`, [app]);
    await db.query(`DELETE FROM sitewire_draws WHERE application_id=$1`, [app]);
    await db.query(`UPDATE sitewire_property_links SET lifecycle_state='active', investor_funding_mode=NULL WHERE application_id=$1`, [app]);
    await clearStamps();
  };

  // ======================================================================
  // A. INSPECTION ORDERED, NO REPORT
  // ======================================================================
  {
    await resetDraws();
    // A draw submitted well past the inspection SLA with no findings at all.
    await db.query(`INSERT INTO sitewire_draws(application_id,sitewire_draw_id,number,status,submitted_at) VALUES($1,$2,1,'inspecting', now() - interval '30 days')`, [app, DRAW]);
    await D.drawInspectionLateOnce();
    eq('A1 a late inspection is chased', await stamped(ACTIONS.inspection_late), 1);

    // …and it is SELF-GATING: a second pass inside the window sends nothing.
    await D.drawInspectionLateOnce();
    eq('A2 it never bombards — a second pass in the window is silent', await stamped(ACTIONS.inspection_late), 1);

    // It clears itself the moment the report lands.
    await clearStamps();
    await db.query(`INSERT INTO draw_findings(application_id,sitewire_draw_id,status,total_requested_cents,total_approved_cents) VALUES($1,$2,'delivered',100,100)`, [app, DRAW]);
    await D.drawInspectionLateOnce();
    eq('A3 once the report arrives the reminder stops on its own', await stamped(ACTIONS.inspection_late), 0);

    // A draw inside the SLA is not late.
    await resetDraws();
    await db.query(`INSERT INTO sitewire_draws(application_id,sitewire_draw_id,number,status,submitted_at) VALUES($1,$2,1,'inspecting', now() - interval '1 day')`, [app, DRAW]);
    await D.drawInspectionLateOnce();
    eq('A4 a draw inside the expected window is left alone', await stamped(ACTIONS.inspection_late), 0);
  }

  // ======================================================================
  // B. THE REPORT IS IN, NOBODY HAS READ IT
  // ======================================================================
  {
    // NOTE the state this actually targets. A draw_findings row is created BY the delivery
    // (reconcile.js inserts status='delivered', delivered_at=now()), so "findings exist but have
    // not gone to the borrower" is impossible — the real, worse state is that the results ALREADY
    // reached the borrower and nobody here confirmed they read the inspector's report.
    await resetDraws();
    await db.query(`INSERT INTO sitewire_draws(application_id,sitewire_draw_id,number,status,submitted_at) VALUES($1,$2,1,'inspecting', now() - interval '9 days')`, [app, DRAW]);
    await db.query(`INSERT INTO draw_findings(application_id,sitewire_draw_id,status,total_requested_cents,total_approved_cents,created_at,delivered_at)
                    VALUES($1,$2,'delivered',500000,450000, now() - interval '9 days', now() - interval '9 days')`, [app, DRAW]);
    await D.drawFindingsUnreviewedOnce();
    eq('B1 an inspection nobody here has read is chased', await stamped(ACTIONS.unreviewed), 1);

    // No clearStamps() here ON PURPOSE — the gate stamp is exactly what must stop the second pass.
    await D.drawFindingsUnreviewedOnce();
    eq('B2 it never bombards — a second pass in the window is silent', await stamped(ACTIONS.unreviewed), 1);

    await clearStamps();
    await db.query(`UPDATE draw_findings SET reviewed_at=now() WHERE application_id=$1`, [app]);
    await D.drawFindingsUnreviewedOnce();
    eq('B3 marking it reviewed stops it', await stamped(ACTIONS.unreviewed), 0);

    // A draw the borrower has already settled needs no retrospective review chase.
    await clearStamps();
    await db.query(`UPDATE draw_findings SET reviewed_at=NULL, status='accepted', accepted_at=now() WHERE application_id=$1`, [app]);
    await D.drawFindingsUnreviewedOnce();
    eq('B4 a draw the borrower already accepted is not chased for a review', await stamped(ACTIONS.unreviewed), 0);
  }

  // ======================================================================
  // C. DELIBERATELY ABSENT — "reviewed but not yet delivered" cannot happen.
  //    A draw_findings row is created BY the delivery, so a review stamp can only ever land on an
  //    already-delivered row. A sweep for that state would have run cleanly, matched nothing
  //    forever, and looked like a working reminder. Pinned here so nobody re-adds it blind.
  // ======================================================================
  {
    const impossible = Number((await db.query(
      `SELECT count(*)::int c FROM draw_findings WHERE reviewed_at IS NOT NULL AND delivered_at IS NULL`)).rows[0].c);
    eq('C1 no findings row anywhere is reviewed-but-undelivered', impossible, 0);
    eq('C2 …and the sweep for it does not exist', typeof D.drawReviewedUndeliveredOnce, 'undefined');
  }

  // ======================================================================
  // D. FINALLY APPROVED, MONEY NEVER RECORDED
  // ======================================================================
  {
    await resetDraws();
    await db.query(`INSERT INTO sitewire_draws(application_id,sitewire_draw_id,number,status,approved_at,total_approved_cents)
                    VALUES($1,$2,1,'approved', now() - interval '10 days', 500000)`, [app, DRAW]);
    await D.drawApprovedUnrecordedOnce();
    eq('D1 an approved draw with no ledger row is chased', await stamped(ACTIONS.unrecorded), 1);

    await clearStamps();
    await db.query(`INSERT INTO draw_disbursements(application_id,sitewire_draw_id,approved_cents,fee_cents,retainage_held_cents,net_release_cents,funded_status,kind,created_by)
                    VALUES($1,$2,500000,29900,0,470100,'released','draw',NULL)`, [app, DRAW]);
    await D.drawApprovedUnrecordedOnce();
    eq('D2 recording the money stops it', await stamped(ACTIONS.unrecorded), 0);

    // A MANUAL delivery moved the money outside PILOT on purpose — never nag about it.
    await resetDraws();
    await db.query(`UPDATE sitewire_property_links SET investor_funding_mode='manual' WHERE application_id=$1`, [app]);
    await db.query(`INSERT INTO sitewire_draws(application_id,sitewire_draw_id,number,status,approved_at,total_approved_cents)
                    VALUES($1,$2,1,'approved', now() - interval '10 days', 500000)`, [app, DRAW]);
    await D.drawApprovedUnrecordedOnce();
    eq('D3 a manual delivery is never nagged about', await stamped(ACTIONS.unrecorded), 0);

    // The accepted-findings path has its OWN overdue alert — do not double up.
    await resetDraws();
    await db.query(`INSERT INTO sitewire_draws(application_id,sitewire_draw_id,number,status,approved_at,total_approved_cents)
                    VALUES($1,$2,1,'approved', now() - interval '10 days', 500000)`, [app, DRAW]);
    await db.query(`INSERT INTO draw_findings(application_id,sitewire_draw_id,status,total_requested_cents,total_approved_cents,wire_due_at)
                    VALUES($1,$2,'accepted',500000,500000, now() - interval '5 days')`, [app, DRAW]);
    await D.drawApprovedUnrecordedOnce();
    eq('D4 a draw already covered by the overdue alert is not chased twice', await stamped(ACTIONS.unrecorded), 0);
  }

  // ======================================================================
  // E. AN INVESTOR STILL OWES US OUR FEE
  // ======================================================================
  {
    await resetDraws();
    await db.query(`INSERT INTO sitewire_draws(application_id,sitewire_draw_id,number,status) VALUES($1,$2,1,'approved')`, [app, DRAW]);
    await db.query(
      `INSERT INTO draw_disbursements(application_id,sitewire_draw_id,approved_cents,fee_cents,retainage_held_cents,net_release_cents,
                                      funded_status,kind,created_by,release_party,fee_receivable_cents,fee_status,note_buyer_label,release_date)
       VALUES($1,$2,500000,29900,0,470100,'released','draw',NULL,'investor',29900,'owed','Fidelis Investors LLC', CURRENT_DATE - 40)`, [app, DRAW]);
    await D.investorFeeOwedOnce();
    eq('E1 a fee owed past the chase window is chased', await stamped(ACTIONS.fee_owed), 1);

    await clearStamps();
    await db.query(`UPDATE draw_disbursements SET fee_status='received', fee_received_date=CURRENT_DATE WHERE application_id=$1`, [app]);
    await D.investorFeeOwedOnce();
    eq('E2 marking it received stops the chase', await stamped(ACTIONS.fee_owed), 0);

    // A fee owed since TODAY is not yet overdue.
    await clearStamps();
    await db.query(`UPDATE draw_disbursements SET fee_status='owed', fee_received_date=NULL, release_date=CURRENT_DATE WHERE application_id=$1`, [app]);
    await D.investorFeeOwedOnce();
    eq('E3 a fee owed since today is not chased yet', await stamped(ACTIONS.fee_owed), 0);
  }

  // ======================================================================
  // F. RETAINAGE IS RELEASABLE
  // ======================================================================
  {
    await resetDraws();
    await db.query(`INSERT INTO sitewire_draws(application_id,sitewire_draw_id,number,status) VALUES($1,$2,1,'approved')`, [app, DRAW]);
    await db.query(`INSERT INTO draw_disbursements(application_id,sitewire_draw_id,approved_cents,fee_cents,retainage_held_cents,net_release_cents,funded_status,kind,created_by)
                    VALUES($1,$2,500000,0,50000,450000,'released','draw',NULL)`, [app, DRAW]);

    // Still ACTIVE — the job is not done, so nothing is releasable yet.
    await D.retainageReleasableOnce();
    eq('F1 an active project is never told to release its retainage', await stamped(ACTIONS.retainage), 0);

    await db.query(`UPDATE sitewire_property_links SET lifecycle_state='finished', lifecycle_at=now() WHERE application_id=$1`, [app]);
    await D.retainageReleasableOnce();
    eq('F2 a finished project holding retainage is chased', await stamped(ACTIONS.retainage), 1);

    await clearStamps();
    await db.query(`INSERT INTO draw_disbursements(application_id,approved_cents,fee_cents,retainage_held_cents,net_release_cents,funded_status,kind,created_by)
                    VALUES($1,50000,0,0,50000,'released','retainage_release',NULL)`, [app]);
    await D.retainageReleasableOnce();
    eq('F3 once it is released the reminder stops', await stamped(ACTIONS.retainage), 0);

    // And never a reminder about $0.
    await resetDraws();
    await db.query(`UPDATE sitewire_property_links SET lifecycle_state='finished', lifecycle_at=now() WHERE application_id=$1`, [app]);
    await D.retainageReleasableOnce();
    eq('F4 a finished project holding nothing is left alone', await stamped(ACTIONS.retainage), 0);
  }

  // ======================================================================
  // G. EVERY SWEEP IS SCOPED TO A PILOT-MANAGED, ACTIVE PROJECT
  // ======================================================================
  {
    await resetDraws();
    await db.query(`UPDATE sitewire_property_links SET matched_by='manual' WHERE application_id=$1`, [app]);
    await db.query(`INSERT INTO sitewire_draws(application_id,sitewire_draw_id,number,status,submitted_at) VALUES($1,$2,1,'inspecting', now() - interval '30 days')`, [app, DRAW]);
    await D.drawInspectionLateOnce();
    eq('G1 a property PILOT did not CREATE is never chased (the go-forward-only rule)', await stamped(ACTIONS.inspection_late), 0);
    await db.query(`UPDATE sitewire_property_links SET matched_by='created' WHERE application_id=$1`, [app]);
  }

  // ---- clean up ----
  await db.query(`DELETE FROM audit_log WHERE entity_id::text=$1::text`, [app]);
  await db.query(`DELETE FROM draw_disbursements WHERE application_id=$1`, [app]);
  await db.query(`DELETE FROM draw_findings WHERE application_id=$1`, [app]);
  await db.query(`DELETE FROM sitewire_draws WHERE application_id=$1`, [app]);
  await db.query(`DELETE FROM sitewire_property_links WHERE application_id=$1`, [app]);
  await db.query(`DELETE FROM notifications WHERE application_id=$1`, [app]);
  await db.query(`DELETE FROM applications WHERE id=$1`, [app]);
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [bor]);

  console.log(fail === 0
    ? `test-draw-reminders-db: all ${pass} checks passed.`
    : `test-draw-reminders-db: ${pass} passed, ${fail} FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('test-draw-reminders-db ERROR', e); process.exit(1); });
