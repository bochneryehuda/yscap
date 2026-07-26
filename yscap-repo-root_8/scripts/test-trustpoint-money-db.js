/* TrustPoint money mirror (phase 5, DB-gated; no network). Covers: the observed-
 * disbursement mirror row (insert-once claim → ONE borrower NET email, staff in-app
 * note), baseline silence, manual-row adoption (never a duplicate, never a
 * re-announce), the dormant markup knob reducing the SHOWN net (D9), the once-per-
 * draw fee verification vs the rule's agreed fee (D6 — alert on mismatch, silence
 * on match, skip on absent data), retainage precedence (D7 — PILOT's own retainage
 * % is 0 on administered files), and the approved-but-unreleased staff nudge (§5C).
 * Run: DATABASE_URL=... node scripts/test-trustpoint-money-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-trustpoint-money-db (no DATABASE_URL)'); process.exit(0); }

const crypto = require('crypto');
const db = require('../src/db');
const mirror = require('../src/trustpoint/mirror');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const tag = crypto.randomBytes(4).toString('hex');

async function seedFile(lender) {
  const bor = (await db.query(`INSERT INTO borrowers(first_name,last_name,email) VALUES('M','M',$1) RETURNING id`,
    ['mm' + crypto.randomBytes(5).toString('hex') + '@example.com'])).rows[0].id;
  const lo = (await db.query(
    `INSERT INTO staff_users(email, full_name, role, is_active) VALUES ($1,'MM Officer','loan_officer',true) RETURNING id`,
    ['mmlo' + crypto.randomBytes(5).toString('hex') + '@example.com'])).rows[0].id;
  const app = (await db.query(
    `INSERT INTO applications(borrower_id,status,ys_loan_number,lender,property_address,loan_officer_id)
     VALUES($1,'funded',$2,$3,'{"oneLine":"5 Money Way, Testville, NY 10001"}'::jsonb,$4) RETURNING id`,
    [bor, 'MM' + crypto.randomBytes(3).toString('hex').toUpperCase(), lender, lo])).rows[0].id;
  return { app, bor, lo };
}
const cleanup = async (app, bor, lo) => {
  await db.query(`DELETE FROM notifications WHERE application_id=$1`, [app]).catch(() => {});
  await db.query(`DELETE FROM applications WHERE id=$1`, [app]);
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [bor]);
  if (lo) { await db.query(`DELETE FROM notifications WHERE staff_id=$1`, [lo]).catch(() => {}); await db.query(`DELETE FROM staff_users WHERE id=$1`, [lo]); }
};
const notesFor = async (app, kind) => (await db.query(
  `SELECT * FROM notifications WHERE application_id=$1 AND recipient_kind=$2 ORDER BY created_at`, [app, kind])).rows;

async function seedTpDraw(app, over = {}) {
  const tpDrawId = over.tp_draw_id || `mm-${tag}-${crypto.randomBytes(3).toString('hex')}`;
  await db.query(
    `INSERT INTO trustpoint_draws (application_id, tp_project_id, tp_draw_id, number, status, requested_cents, approved_cents,
        to_disburse_cents, disbursed_cents, disbursed_at, fees, sitewire_draw_id, portal_draw_request_id, approved_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14)`,
    [app, `mmp-${tag}`, tpDrawId, over.number ?? 1, over.status || 'COMPLETED', over.requested_cents ?? 80000, over.approved_cents ?? 75000,
     over.to_disburse_cents !== undefined ? over.to_disburse_cents : 50000,
     over.disbursed_cents !== undefined ? over.disbursed_cents : 50000,
     over.disbursed_at !== undefined ? over.disbursed_at : new Date().toISOString(),
     over.fees !== undefined ? over.fees : JSON.stringify([{ name: 'Draw fee', amount: 250.0 }]),
     over.sitewire_draw_id ?? null, over.portal_draw_request_id ?? null, over.approved_at ?? null]);
  return (await db.query(`SELECT * FROM trustpoint_draws WHERE tp_draw_id=$1`, [tpDrawId])).rows[0];
}

(async () => {
  // ---- fee-line extraction (pure) ----
  ok('fees: object amounts extract', JSON.stringify(mirror._feeLinesCents([{ amount: 250.0 }, { fee_amount: '10.50' }])) === JSON.stringify([25000, 1050]));
  ok('fees: bare numbers/strings extract', JSON.stringify(mirror._feeLinesCents([250, '5.25'])) === JSON.stringify([25000, 525]));
  ok('fees: empty/absent/garbage → null (never $0)', mirror._feeLinesCents([]) === null && mirror._feeLinesCents(null) === null && mirror._feeLinesCents([{ note: 'x' }]) === null);
  ok('fees: json string payload parses', JSON.stringify(mirror._feeLinesCents('[{"amount": 250}]')) === JSON.stringify([25000]));

  const RULE = `Money${tag}`;
  await db.query(
    `INSERT INTO sitewire_inspection_rules (partner_label, inspection_method, fee_cents_virtual, fee_cents_physical, allow_virtual, allow_physical, draw_platform)
     VALUES ($1,'traditional',29900,25000,false,true,'trustpoint')
     ON CONFLICT (regexp_replace(lower(COALESCE(partner_label,'')), '[^a-z0-9]+', '', 'g'), COALESCE(program,'')) DO NOTHING`, [RULE]);

  // ============ 1. observed disbursement → one mirror row + ONE borrower NET email ============
  {
    const { app, bor, lo } = await seedFile(RULE);
    const row = await seedTpDraw(app);
    const r1 = await mirror.mirrorDisbursement(app, row, { addr: '5 Money Way' });
    ok('mirror recorded (net = to_disburse)', r1.ok === true && r1.net === 50000);
    const dd = (await db.query(`SELECT * FROM draw_disbursements WHERE trustpoint_draw_id=$1`, [row.tp_draw_id])).rows[0];
    ok('ledger row: source trustpoint, released, fee mirrored', dd && dd.source === 'trustpoint' && dd.funded_status === 'released'
      && Number(dd.net_release_cents) === 50000 && Number(dd.fee_cents) === 25000 && Number(dd.approved_cents) === 75000 && dd.release_date != null);
    const bn = await notesFor(app, 'borrower');
    ok('ONE borrower NET email ($500.00)', bn.length === 1 && /released/i.test(bn[0].title) && /\$500\.00/.test(bn[0].body));
    ok('staff in-app note written', (await notesFor(app, 'staff')).some((n) => /funds released/i.test(n.title)));
    const r2 = await mirror.mirrorDisbursement(app, row, { addr: '5 Money Way' });
    ok('re-read never double-records or re-announces', r2.skipped === 'already_recorded'
      && (await notesFor(app, 'borrower')).length === 1
      && Number((await db.query(`SELECT count(*)::int c FROM draw_disbursements WHERE trustpoint_draw_id=$1`, [row.tp_draw_id])).rows[0].c) === 1);
    ok('fee matches the rule → checked silently (no fee alert)',
      (await db.query(`SELECT fee_check_at FROM trustpoint_draws WHERE tp_draw_id=$1`, [row.tp_draw_id])).rows[0].fee_check_at != null
      && !(await notesFor(app, 'staff')).some((n) => /fee/i.test(n.title)));
    await cleanup(app, bor, lo);
  }

  // ============ 2. not disbursed → nothing; baseline → silent row ============
  {
    const { app, bor, lo } = await seedFile(RULE);
    const quiet = await seedTpDraw(app, { status: 'APPROVED', disbursed_at: null, disbursed_cents: null, to_disburse_cents: 50000 });
    const r0 = await mirror.mirrorDisbursement(app, quiet, {});
    ok('approved-but-unreleased mirrors nothing', r0.skipped === 'not_disbursed');
    const hist = await seedTpDraw(app, { number: 2 });
    const rb = await mirror.mirrorDisbursement(app, hist, { baseline: true });
    ok('baseline (history) records the row silently', rb.ok === true && rb.silent === true
      && (await notesFor(app, 'borrower')).length === 0
      && (await db.query(`SELECT 1 FROM draw_disbursements WHERE trustpoint_draw_id=$1`, [hist.tp_draw_id])).rows.length === 1);
    await cleanup(app, bor, lo);
  }

  // ============ 3. a staff manual row is adopted, never duplicated ============
  {
    const { app, bor, lo } = await seedFile(RULE);
    const swDrawId = 950000000 + crypto.randomBytes(2).readUInt16BE(0);
    await db.query(`INSERT INTO sitewire_draws (application_id, sitewire_draw_id, number, status) VALUES ($1,$2,3,'approved')`, [app, swDrawId]);
    await db.query(
      `INSERT INTO draw_disbursements (application_id, sitewire_draw_id, approved_cents, fee_cents, net_release_cents, funded_status, kind)
       VALUES ($1,$2,75000,25000,50000,'released','draw')`, [app, swDrawId]);
    const row = await seedTpDraw(app, { number: 3, sitewire_draw_id: swDrawId });
    const r = await mirror.mirrorDisbursement(app, row, {});
    const dd = (await db.query(`SELECT * FROM draw_disbursements WHERE application_id=$1 AND kind='draw'`, [app])).rows;
    ok('manual row adopted (tp linkage stamped, one row, no borrower email)',
      r.skipped === 'already_recorded' && dd.length === 1 && dd[0].trustpoint_draw_id === row.tp_draw_id
      && (await notesFor(app, 'borrower')).length === 0);
    await cleanup(app, bor, lo);
  }

  // ============ 4. the dormant markup knob reduces the SHOWN net (D9) ============
  {
    const MK = `Markup${tag}`;
    await db.query(
      `INSERT INTO sitewire_inspection_rules (partner_label, inspection_method, fee_cents_virtual, fee_cents_physical, allow_virtual, allow_physical, draw_platform, markup_cents)
       VALUES ($1,'traditional',29900,25000,false,true,'trustpoint',5000)
       ON CONFLICT (regexp_replace(lower(COALESCE(partner_label,'')), '[^a-z0-9]+', '', 'g'), COALESCE(program,'')) DO NOTHING`, [MK]);
    const { app, bor, lo } = await seedFile(MK);
    const row = await seedTpDraw(app);
    await mirror.mirrorDisbursement(app, row, {});
    const bn = await notesFor(app, 'borrower');
    ok('borrower NET honors the markup ($450, not $500)', bn.length === 1 && /\$450\.00/.test(bn[0].body) && !/\$500\.00/.test(bn[0].body));
    const dd = (await db.query(`SELECT net_release_cents FROM draw_disbursements WHERE trustpoint_draw_id=$1`, [row.tp_draw_id])).rows[0];
    ok('the LEDGER keeps the administrator’s real number', Number(dd.net_release_cents) === 50000);
    await cleanup(app, bor, lo);
    await db.query(`DELETE FROM sitewire_inspection_rules WHERE partner_label=$1`, [MK]);
  }

  // ============ 5. fee verification (D6): mismatch alerts once; absent data never guesses ============
  {
    const { app, bor, lo } = await seedFile(RULE);
    const bad = await seedTpDraw(app, { number: 4, fees: JSON.stringify([{ name: 'Draw fee', amount: 100.0 }]), disbursed_at: null, disbursed_cents: null, status: 'APPROVED' });
    const r = await mirror.verifyPartnerFee(app, bad);
    ok('wrong fee → staff alert + stamped', r.alerted === true
      && (await notesFor(app, 'staff')).some((n) => /fee/i.test(n.title))
      && (await db.query(`SELECT fee_check_at FROM trustpoint_draws WHERE tp_draw_id=$1`, [bad.tp_draw_id])).rows[0].fee_check_at != null);
    const again = await mirror.verifyPartnerFee(app, (await db.query(`SELECT * FROM trustpoint_draws WHERE tp_draw_id=$1`, [bad.tp_draw_id])).rows[0]);
    ok('fee check runs once per draw', again.skipped === 'checked');
    const noData = await seedTpDraw(app, { number: 5, fees: null, disbursed_at: null, disbursed_cents: null, status: 'APPROVED' });
    const r2 = await mirror.verifyPartnerFee(app, noData);
    ok('absent fee data skips WITHOUT stamping (checked later when data arrives)', r2.skipped === 'no_fee_data'
      && (await db.query(`SELECT fee_check_at FROM trustpoint_draws WHERE tp_draw_id=$1`, [noData.tp_draw_id])).rows[0].fee_check_at == null);
    await cleanup(app, bor, lo);
  }

  // ============ 6. retainage precedence (D7): PILOT holds 0% on administered files ============
  {
    const swRoutes = require('../src/routes/sitewire');
    const { app, bor, lo } = await seedFile(RULE);
    await db.query(
      `INSERT INTO sitewire_property_links (application_id, matched_by, state, retainage_pct)
       VALUES ($1,'created','live',10) ON CONFLICT (application_id) DO UPDATE SET retainage_pct=10`, [app]);
    ok('trustpoint file: PILOT retainage forced to 0 (even with a 10% override)', (await swRoutes._retainagePctFor(app)) === 0);
    const { app: app2, bor: bor2, lo: lo2 } = await seedFile(`Plain${tag}`);
    await db.query(
      `INSERT INTO sitewire_property_links (application_id, matched_by, state, retainage_pct)
       VALUES ($1,'created','live',10) ON CONFLICT (application_id) DO UPDATE SET retainage_pct=10`, [app2]);
    ok('non-administered file keeps its own retainage %', (await swRoutes._retainagePctFor(app2)) === 10);
    await cleanup(app, bor, lo); await cleanup(app2, bor2, lo2);
  }

  // ============ 7. approved-but-unreleased nudge (§5C) ============
  {
    const digests = require('../src/lib/notification-digests');
    const { app, bor, lo } = await seedFile(RULE);
    await seedTpDraw(app, { number: 6, status: 'APPROVED', disbursed_at: null, disbursed_cents: null, approved_at: new Date(Date.now() - 7 * 86400000).toISOString() });
    const sent = await digests.trustpointUnreleasedOnce();
    ok('stale approved draw nudges the team', sent >= 1 && (await notesFor(app, 'staff')).some((n) => /not released yet/i.test(n.title)));
    const sent2 = await digests.trustpointUnreleasedOnce();
    ok('the nudge self-gates (no second send)', sent2 === 0 || !((await notesFor(app, 'staff')).filter((n) => /not released yet/i.test(n.title)).length > 1));
    await cleanup(app, bor, lo);
  }

  // ============ 8. audit-5 hardening: stale history, late-tie repair, split-ledger park ============
  {
    const { app, bor, lo } = await seedFile(RULE);
    // a weeks-old wire is HISTORY — the row lands, nobody is emailed
    const old = await seedTpDraw(app, { number: 7, disbursed_at: new Date(Date.now() - 30 * 86400000).toISOString() });
    const rOld = await mirror.mirrorDisbursement(app, old, {});
    ok('a weeks-old wire records silently (no borrower email)', rOld.ok === true && rOld.silent === true
      && (await notesFor(app, 'borrower')).length === 0
      && (await db.query(`SELECT 1 FROM draw_disbursements WHERE trustpoint_draw_id=$1`, [old.tp_draw_id])).rows.length === 1);

    // a LATE tie retro-ties the SAME mirror row — never a second row
    const sw2 = 955000000 + crypto.randomBytes(2).readUInt16BE(0);
    await db.query(`INSERT INTO sitewire_draws (application_id, sitewire_draw_id, number, status) VALUES ($1,$2,8,'approved')`, [app, sw2]);
    const late = await seedTpDraw(app, { number: 8 });
    await mirror.mirrorDisbursement(app, late, {});
    await db.query(`UPDATE trustpoint_draws SET sitewire_draw_id=$2 WHERE tp_draw_id=$1`, [late.tp_draw_id, sw2]);
    const r2 = await mirror.mirrorDisbursement(app, (await db.query(`SELECT * FROM trustpoint_draws WHERE tp_draw_id=$1`, [late.tp_draw_id])).rows[0], {});
    const rows2 = (await db.query(`SELECT * FROM draw_disbursements WHERE trustpoint_draw_id=$1`, [late.tp_draw_id])).rows;
    ok('late tie retro-ties the SAME mirror row (one row, now draw-linked)',
      r2.skipped === 'already_recorded' && rows2.length === 1 && Number(rows2[0].sitewire_draw_id) === sw2);

    // a manual row holding the draw slot + an untied mirror row = split ledger → parked for review
    const sw3 = 956000000 + crypto.randomBytes(2).readUInt16BE(0);
    await db.query(`INSERT INTO sitewire_draws (application_id, sitewire_draw_id, number, status) VALUES ($1,$2,9,'approved')`, [app, sw3]);
    await db.query(
      `INSERT INTO draw_disbursements (application_id, sitewire_draw_id, approved_cents, fee_cents, net_release_cents, funded_status, kind)
       VALUES ($1,$2,75000,25000,50000,'released','draw')`, [app, sw3]);
    const dup = await seedTpDraw(app, { number: 9 });
    await mirror.mirrorDisbursement(app, dup, {});   // lands untied (no sw known yet)
    await db.query(`UPDATE trustpoint_draws SET sitewire_draw_id=$2 WHERE tp_draw_id=$1`, [dup.tp_draw_id, sw3]);
    await mirror.mirrorDisbursement(app, (await db.query(`SELECT * FROM trustpoint_draws WHERE tp_draw_id=$1`, [dup.tp_draw_id])).rows[0], {});
    const parked = (await db.query(
      `SELECT 1 FROM sync_review_queue WHERE task_id LIKE 'sitewire:' || $1 || ':sitewire_money_duplicate%' AND status='open'`, [app])).rows;
    ok('a split ledger (mirror + manual rows for one wire) parks a review row', parked.length === 1);
    await db.query(`UPDATE sync_review_queue SET status='dismissed' WHERE task_id LIKE 'sitewire:' || $1 || '%'`, [app]).catch(() => {});
    await cleanup(app, bor, lo);
  }

  await db.query(`DELETE FROM sitewire_inspection_rules WHERE partner_label=$1`, [RULE]).catch(() => {});
  console.log(`test-trustpoint-money-db: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test-trustpoint-money-db crashed:', e); process.exit(1); });
