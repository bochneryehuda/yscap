/* FINAL APPROVE FINISHES THE DRAW — against a REAL database (owner-directed 2026-08-09).
 *
 * The pure suite (scripts/test-draw-release-party-pure.js) proves the RULES; this one proves the
 * WIRING, because every consequence that matters lives in SQL a pure test cannot reach:
 *
 *   1. the three-level resolution reading real rows (this draw / this project / this capital
 *      provider / the company default), and reporting WHICH level decided;
 *   2. final approve on an investor-released draw writing EXACTLY ONE full ledger row carrying the
 *      fee we are owed — and writing NOTHING when we release, or when the delivery is manual;
 *   3. **the data tape seeing it.** This is the whole reason the row carries the full record rather
 *      than just the fee: src/lib/tapes/assemble.js reads released draws to work out a SOLD loan's
 *      current balance and current rehab, so before this an investor-released draw made every one
 *      of those tapes understate what had been drawn;
 *   4. a lien-waiver failure recording the row as HELD — never silently released, never silently
 *      dropped — and the tape correctly NOT counting it;
 *   5. a second final approve being a no-op, and the manual release route still refusing a duplicate;
 *   6. the fees-owed list, its ageing, and mark-received only ever moving 'owed' → 'received';
 *   7. the sold signal: a PA date makes the not-sold question go away, and only a PA date does.
 *
 * DB-gated: needs DATABASE_URL with migrations applied; skips cleanly otherwise.
 * Run: DATABASE_URL=... node scripts/test-draw-release-party-db.js
 */
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const eq = (name, got, exp) => { if (JSON.stringify(got) === JSON.stringify(exp)) pass++; else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`); } };

if (!process.env.DATABASE_URL) {
  console.log('SKIP test-draw-release-party-db (no DATABASE_URL)');
  process.exit(0);
}

const crypto = require('crypto');
const db = require('../src/db');
const RP = require('../src/sitewire/release-party');
const AR = require('../src/sitewire/auto-release');
const SE = require('../src/sitewire/stage-events');
const assemble = require('../src/lib/tapes/assemble');

const n = (x) => Number(x || 0);

(async () => {
  // ---- a funded file with one fully-inspected, finally-approved $33,450 draw ----
  const email = 'rp' + crypto.randomBytes(5).toString('hex') + '@example.com';
  const bor = (await db.query(`INSERT INTO borrowers(first_name,last_name,email) VALUES('Release','Party',$1) RETURNING id`, [email])).rows[0].id;
  const loan = 'RP' + crypto.randomBytes(3).toString('hex');
  const BUYER = 'Fidelis Investors LLC';
  const app = (await db.query(
    `INSERT INTO applications(borrower_id,status,ys_loan_number,lender,property_address,rehab_budget,loan_amount)
     VALUES($1,'funded',$2,$3,'{"oneLine":"825 Bishop St","city":"Scranton","state":"PA","zip":"18505"}',100000,400000) RETURNING id`,
    [bor, loan, BUYER])).rows[0].id;

  const BASE = 910000 + crypto.randomBytes(2).readUInt16BE(0) * 10;
  const DRAW = BASE, PROP = BASE + 2;
  const APPROVED = 3345000;

  await db.query(`INSERT INTO sitewire_property_links(application_id,sitewire_property_id,matched_by,state,pushed_at,inspection_method) VALUES($1,$2,'created','live',now(),'mobile')`, [app, PROP]);
  await db.query(`INSERT INTO sitewire_draws(application_id,sitewire_draw_id,number,status,total_requested_cents,total_approved_cents) VALUES($1,$2,1,'approved',5000000,$3)`, [app, DRAW, APPROVED]);
  await db.query(`INSERT INTO draw_findings(application_id,sitewire_draw_id,status,total_requested_cents,total_approved_cents,delivered_at,accepted_at) VALUES($1,$2,'accepted',5000000,$3,now(),now())`, [app, DRAW, APPROVED]);

  const setLevel = async (col, v) => db.query(`UPDATE sitewire_property_links SET ${col}=$2 WHERE application_id=$1`, [app, v]);
  const ledgerRows = async () => (await db.query(`SELECT * FROM draw_disbursements WHERE application_id=$1 ORDER BY id`, [app])).rows;
  const wipeLedger = async () => db.query(`DELETE FROM draw_disbursements WHERE application_id=$1`, [app]);

  // ======================================================================
  // 1. WHICH LEVEL DECIDED — against real rows
  // ======================================================================
  {
    const s0 = await RP.releaseStateFor(db, app);
    eq('1a with nothing set, the company default decides', s0.level, 'company');
    eq('1b …and the company default is the investor releasing', s0.mode, 'investor_direct');
    eq('1c the note buyer rides along for the desk (staff-only)', s0.noteBuyer, BUYER);

    await setLevel('investor_funding_mode', 'reimbursement');
    const s1 = await RP.releaseStateFor(db, app);
    eq('1d a project answer beats the company default', [s1.mode, s1.level], ['reimbursement', 'project']);

    await db.query(`UPDATE draw_findings SET funding_mode='investor_direct' WHERE application_id=$1`, [app]);
    const s2 = await RP.releaseStateFor(db, app, { sitewireDrawId: DRAW });
    eq('1e a per-draw answer beats the project', [s2.mode, s2.level], ['investor_direct', 'draw']);
    const s3 = await RP.releaseStateFor(db, app);
    eq('1f …and only for that draw — the project still governs the file', s3.level, 'project');

    // A TYPO MUST NEVER REDIRECT A WIRE, and there are two independent defences.
    // (a) The three COLUMN levels each carry their own CHECK, so a bad value cannot even be stored.
    for (const [table, col, where] of [
      ['sitewire_property_links', 'investor_funding_mode', 'application_id=$1'],
      ['draw_findings', 'funding_mode', 'application_id=$1'],
    ]) {
      let refused = false;
      try { await db.query(`UPDATE ${table} SET ${col}='INVESTOR' WHERE ${where}`, [app]); }
      catch (e) { refused = e && e.code === '23514'; }
      ok(`1g the database refuses a bad value in ${table}.${col}`, refused);
    }
    // (b) The COMPANY default is a jsonb setting with no CHECK — the one level where a typo really
    //     can live — and there the resolver's fall-through is what protects the wire. Every level
    //     below it is cleared first, or one of them would answer and the fall-through would never
    //     be exercised at all.
    await setLevel('investor_funding_mode', null);
    await db.query(`UPDATE draw_findings SET funding_mode=NULL WHERE application_id=$1`, [app]);
    const prevCompany = (await db.query(`SELECT value FROM sitewire_settings WHERE key='investor_funding_mode_default'`)).rows[0];
    await db.query(`INSERT INTO sitewire_settings(key,value) VALUES('investor_funding_mode_default','"INVESTOR"'::jsonb)
                    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`);
    const s4 = await RP.releaseStateFor(db, app);
    eq('1h a typo in the company default falls through — it is not honoured', s4.level, 'default');
    eq('1i …and it is reported as unanswered, matching how it was treated', s4.levels.company, null);
    eq('1j …landing on the built-in default rather than something invented', s4.mode, 'investor_direct');
    await db.query(`UPDATE sitewire_settings SET value=$1::jsonb WHERE key='investor_funding_mode_default'`,
      [JSON.stringify(prevCompany ? prevCompany.value : 'investor_direct')]);

    await setLevel('investor_funding_mode', null);
    await db.query(`UPDATE draw_findings SET funding_mode=NULL WHERE application_id=$1`, [app]);
  }

  // ======================================================================
  // 2. THE SOLD SIGNAL
  // ======================================================================
  {
    const before = await RP.releaseStateFor(db, app);
    ok('2a an investor-released draw on an unsold loan asks the question', !!before.warning);
    eq('2b …and the way out it offers is a real mode', before.warning.suggestMode, 'reimbursement');
    await db.query(`UPDATE applications SET purchase_advice_date='2026-03-04' WHERE id=$1`, [app]);
    const sold = await RP.releaseStateFor(db, app);
    eq('2c a purchase advice date means sold', sold.sold, 'sold');
    eq('2d …and the question goes away', sold.warning, null);
    await db.query(`UPDATE applications SET purchase_advice_date=NULL WHERE id=$1`, [app]);
    ok('2e clearing it brings the question back', !!(await RP.releaseStateFor(db, app)).warning);
  }

  // ======================================================================
  // 3. WE RELEASE / MANUAL → the automatic writer records NOTHING
  // ======================================================================
  {
    await setLevel('investor_funding_mode', 'reimbursement');
    const r1 = await AR.recordInvestorRelease(app, DRAW, {});
    eq('3a on a we-release file nothing is written', r1.skipped, 'not_investor_released');
    eq('3b …and the ledger is still empty', (await ledgerRows()).length, 0);

    await setLevel('investor_funding_mode', 'manual');
    const r2 = await AR.recordInvestorRelease(app, DRAW, {});
    eq('3c a manual delivery writes nothing either — PILOT did not witness that money move', r2.skipped, 'not_investor_released');
    eq('3d …and the ledger is still empty', (await ledgerRows()).length, 0);
  }

  // ======================================================================
  // 4. THE INVESTOR RELEASES → one full row, plus the fee we are owed
  // ======================================================================
  {
    await setLevel('investor_funding_mode', 'investor_direct');
    const r = await AR.recordInvestorRelease(app, DRAW, {});
    ok('4a the release is recorded', !!r.recorded);
    const rows = await ledgerRows();
    eq('4b exactly one row', rows.length, 1);
    const row = rows[0];
    eq('4c it carries the FULL record — the approved amount', n(row.approved_cents), APPROVED);
    eq('4d …the fee', n(row.fee_cents), 29900);
    eq('4e …and the net that reached the borrower', n(row.net_release_cents), APPROVED - 29900);
    eq('4f it is a released draw, which is what the data tape reads', [row.kind, row.funded_status], ['draw', 'released']);
    eq('4g the investor is recorded as the side that wired', row.release_party, 'investor');
    eq('4h our fee is a receivable', [n(row.fee_receivable_cents), row.fee_status], [29900, 'owed']);
    eq('4i …owed by a named investor', row.note_buyer_label, BUYER);
    ok('4j …keyed the way every other note-buyer lookup keys it', /^fidelis/.test(String(row.note_buyer_key || '')));
    ok('4k it is dated', !!row.release_date);
  }

  // ======================================================================
  // 5. THE DATA TAPE SEES IT — the reason the row carries the full record
  // ======================================================================
  {
    const tape = await assemble.assembleTapeLoan(app, db);
    eq('5a the seasoning reads exactly one released draw', (tape.releases || []).length, 1);
    eq('5b …for the full approved amount, in dollars', (tape.releases || [])[0].amount, APPROVED / 100);
  }

  // ======================================================================
  // 6. IDEMPOTENT — a second final approve, and the manual route
  // ======================================================================
  {
    const again = await AR.recordInvestorRelease(app, DRAW, {});
    eq('6a a second final approve writes nothing', again.skipped, 'already_recorded');
    eq('6b …and there is still exactly one row', (await ledgerRows()).length, 1);
    // The one-release-per-draw index is the belt-and-suspenders under both paths.
    let refused = false;
    try {
      await db.query(`INSERT INTO draw_disbursements(application_id,sitewire_draw_id,approved_cents,fee_cents,retainage_held_cents,net_release_cents,funded_status,kind,created_by) VALUES($1,$2,1,0,0,1,'released','draw',NULL)`, [app, DRAW]);
    } catch (e) { refused = e && e.code === '23505'; }
    ok('6c the database itself refuses a second release for one draw', refused);
  }

  // ======================================================================
  // 7. FEES OWED BY INVESTORS — a report, and mark-received
  // ======================================================================
  {
    const owed = await AR.feesOwed({ scopeWhere: ' AND a.id = $1', scopeParams: [app] });
    eq('7a the fee shows up as owed', owed.count, 1);
    eq('7b …for the right amount', owed.total_cents, 29900);
    eq('7c …grouped by the investor who owes it', owed.by_buyer.map((b) => b.label), [BUYER]);
    const aged = await AR.feesOwed({ scopeWhere: ' AND a.id = $1', scopeParams: [app], olderThanDays: 14 });
    eq('7d a fee owed since today is not yet overdue', aged.count, 0);

    // The "Fees owed by investors" card renders these per row, so a silently-null one would put a
    // dash where a coordinator expects to read which draw and whose money it is. `draw_number` comes
    // through a LEFT JOIN, so it is the one that can go null without anything erroring — and it is
    // the DRAW NUMBER, not the platform id, because "Draw 2" is what every other surface says.
    const r0 = owed.rows[0];
    eq('7h the row names WHICH DRAW, by its number', Number(r0.draw_number), 1);
    ok('7i …and the property, so it can be chased', !!(r0.address || r0.ys_loan_number));
    eq('7j …and the investor who owes it', r0.note_buyer_label, BUYER);
    eq('7k …and how long it has been outstanding, as a real number', Number.isFinite(Number(r0.days_outstanding)), true);
    ok('7l …never negative — a release dated today is 0 days out, not -1', Number(r0.days_outstanding) >= 0);
    eq('7m …and the fee itself', Number(r0.fee_receivable_cents), 29900);

    const id = (await ledgerRows())[0].id;
    eq('7e marking it received works', (await AR.markFeeReceived(id, {})).changed, true);
    eq('7f a second click changes nothing — it never re-dates a settled fee', (await AR.markFeeReceived(id, {})).changed, false);
    eq('7g …and it drops off the owed list', (await AR.feesOwed({ scopeWhere: ' AND a.id = $1', scopeParams: [app] })).count, 0);
  }

  // ======================================================================
  // 8. LIEN WAIVERS OUTSTANDING → recorded as HELD, named, never dropped
  // ======================================================================
  {
    await wipeLedger();
    await db.query(`UPDATE sitewire_property_links SET require_lien_waivers=true WHERE application_id=$1`, [app]);
    await db.query(`INSERT INTO draw_lien_waivers(application_id,sitewire_draw_id,kind,tier,party_name,status) VALUES($1,$2,'conditional','gc','Acme Build','required')`, [app, DRAW]);
    const r = await AR.recordInvestorRelease(app, DRAW, {});
    ok('8a the money that moved is still recorded — never silently dropped', !!r.recorded);
    eq('8b …but as HELD, not released', r.row.funded_status, 'held');
    eq('8c …and the outstanding waiver is named so somebody can go and get it', r.waiversMissing, ['gc Acme Build (conditional)']);
    const tape = await assemble.assembleTapeLoan(app, db);
    eq('8d the data tape correctly does NOT count a held draw as released', (tape.releases || []).length, 0);
    await db.query(`DELETE FROM draw_lien_waivers WHERE application_id=$1`, [app]);
    await db.query(`UPDATE sitewire_property_links SET require_lien_waivers=NULL WHERE application_id=$1`, [app]);
  }

  // ======================================================================
  // 9. A DRAW THAT IS NOT FINALLY APPROVED IS NEVER RECORDED
  // ======================================================================
  {
    await wipeLedger();
    await db.query(`UPDATE sitewire_draws SET status='inspecting' WHERE sitewire_draw_id=$1`, [DRAW]);
    const r = await AR.recordInvestorRelease(app, DRAW, {});
    eq('9a a draw still being inspected writes nothing', r.skipped, 'not_final_approved');
    // A reconcile that has not caught up would look like a $0 approval — and a $0 row would tell the
    // data tape this draw drew nothing.
    await db.query(`UPDATE sitewire_draws SET status='approved', total_approved_cents=0 WHERE sitewire_draw_id=$1`, [DRAW]);
    await db.query(`UPDATE draw_findings SET total_approved_cents=0 WHERE application_id=$1`, [app]);
    const r2 = await AR.recordInvestorRelease(app, DRAW, {});
    eq('9b a zero approval is never recorded as a release', r2.skipped, 'nothing_approved');
    await db.query(`UPDATE sitewire_draws SET total_approved_cents=$2 WHERE sitewire_draw_id=$1`, [DRAW, APPROVED]);
    await db.query(`UPDATE draw_findings SET total_approved_cents=$2 WHERE application_id=$1`, [app, APPROVED]);
  }

  // ======================================================================
  // 10. STAGE HISTORY — forward-only, and it never invents a past
  // ======================================================================
  {
    eq('10a nothing recorded yet means no history at all — never a fabricated day 0',
      SE.daysInCurrentStage(await SE.historyFor(app, { sitewireDrawId: DRAW })), null);
    ok('10b a stage is stamped when PILOT watches it', !!(await SE.record(app, { sitewireDrawId: DRAW }, 'final_approved', { detail: 'Final approval recorded' })).recorded);
    eq('10c the same stage twice in a row writes nothing', (await SE.record(app, { sitewireDrawId: DRAW }, 'final_approved', {})).skipped, 'already_in_stage');
    ok('10d a real advance is recorded', !!(await SE.record(app, { sitewireDrawId: DRAW }, 'released', { detail: 'Investor released' })).recorded);
    const hist = await SE.historyFor(app, { sitewireDrawId: DRAW });
    eq('10e the history reads in order', hist.map((h) => h.stage), ['final_approved', 'released']);
    eq('10f …and names the stage the draw is in now', SE.currentStage(hist), 'released');
    eq('10g …with a real day count once there is history', SE.daysInCurrentStage(hist), 0);
    // An amend genuinely sends a draw BACK — that rework is exactly what the speed report exists to find.
    ok('10h re-entering an earlier stage is recorded, not collapsed', !!(await SE.record(app, { sitewireDrawId: DRAW }, 'inspecting', { detail: 'Amended' })).recorded);
    eq('10i …so the history keeps the round trip', (await SE.historyFor(app, { sitewireDrawId: DRAW })).length, 3);
  }

  // ---- clean up ----
  await db.query(`DELETE FROM draw_stage_events WHERE application_id=$1`, [app]);
  await db.query(`DELETE FROM draw_disbursements WHERE application_id=$1`, [app]);
  await db.query(`DELETE FROM draw_findings WHERE application_id=$1`, [app]);
  await db.query(`DELETE FROM sitewire_draws WHERE application_id=$1`, [app]);
  await db.query(`DELETE FROM sitewire_property_links WHERE application_id=$1`, [app]);
  await db.query(`DELETE FROM applications WHERE id=$1`, [app]);
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [bor]);

  console.log(fail === 0
    ? `test-draw-release-party-db: all ${pass} checks passed.`
    : `test-draw-release-party-db: ${pass} passed, ${fail} FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('test-draw-release-party-db ERROR', e); process.exit(1); });
