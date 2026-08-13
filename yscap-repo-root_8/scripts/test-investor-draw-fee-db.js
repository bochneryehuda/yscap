/* THE INVESTOR'S CUT OF OUR DRAW FEE — against a REAL database and the REAL route
 * (owner-directed 2026-08-13).
 *
 * The pure suite (scripts/test-investor-draw-fee-pure.js) proves the RULES. This one proves the
 * WIRING, because everything that could actually go wrong lives outside those rules:
 *
 *   1. recording a release on a file SOLD to CorrFirst fills the cut in by itself — the owner's own
 *      worked example, on the owner's own screenshot figures: $7,700 approved, our $299 fee, $95 to
 *      CorrFirst, $204 deposited to us;
 *   2. THE BORROWER'S MONEY NEVER MOVES. The same release still wires the borrower approved − fee,
 *      to the cent, whether the investor keeps part of our fee or not;
 *   3. the box is EDITABLE — a typed figure wins, in both directions — and a cut bigger than our own
 *      fee is refused rather than recorded;
 *   4. AN UNSOLD LOAN CARRIES NO INVESTOR FEE AT ALL and is released by US, whatever the file's
 *      setting says — the box is not offered, a fee typed against one is refused, and the draw
 *      desk's "process this file as sold" (with its confirmation) puts both back;
 *   5. Blue Lake keeps the whole $250, so that release banks nothing and the investor owes us
 *      nothing;
 *   6. the deposit is computed by the DATABASE, so nobody can type a ledger into disagreeing with
 *      itself;
 *   7. the draw desk carries the rule, so the box can fill itself in.
 *
 * DB-gated: needs DATABASE_URL with migrations applied; skips cleanly otherwise.
 * Run: DATABASE_URL=... node scripts/test-investor-draw-fee-db.js
 */
'use strict';
const http = require('http');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const eq = (name, got, exp) => {
  if (JSON.stringify(got) === JSON.stringify(exp)) pass++;
  else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`); }
};

if (!process.env.DATABASE_URL) {
  console.log('SKIP test-investor-draw-fee-db (no DATABASE_URL)');
  process.exit(0);
}

const crypto = require('crypto');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const app = require('../src/server');

const n = (x) => Number(x || 0);

function call(server, method, p, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(data ? { 'content-length': Buffer.byteLength(data) } : {}),
    };
    const r = http.request({ method, path: p, port: server.address().port, host: '127.0.0.1', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, body: buf.length ? JSON.parse(buf.toString('utf8')) : null });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const BASE = 960000 + crypto.randomBytes(2).readUInt16BE(0) * 4;
  let bad = 0;
  try {
    const staff = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, mfa_enabled, password_hash, token_version)
       VALUES ($1,'Ledger Admin','super_admin',true,false,'x',0) RETURNING id`, [`inv-fee-${sfx}@test.local`])).rows[0].id;
    const token = C.signJwt({ sub: staff, kind: 'staff', role: 'super_admin', tv: 0 });
    const bor = (await db.query(
      `INSERT INTO borrowers(first_name,last_name,email) VALUES('Inv','Fee',$1) RETURNING id`,
      [`inv-fee-bo-${sfx}@test.local`])).rows[0].id;

    // A funded file, its Sitewire property, and `count` finally-approved draws of `approvedCents`.
    // `paDate` is the SOLD signal — the file's purchase advice date, exactly as Encompass leaves it.
    let seq = 0;
    async function mkFile({ buyer, paDate, approvedCents, count = 1 }) {
      const appId = (await db.query(
        `INSERT INTO applications(borrower_id,status,ys_loan_number,lender,purchase_advice_date,encompass_last_pulled_at,property_address,rehab_budget,loan_amount)
         VALUES($1,'funded',$2,$3,$4,now(),'{"oneLine":"109 Chapel St","city":"New Haven","state":"CT","zip":"06511"}',100000,400000) RETURNING id`,
        [bor, `IF${sfx.slice(-6)}${seq}`, buyer, paDate])).rows[0].id;
      await db.query(
        `INSERT INTO sitewire_property_links(application_id,sitewire_property_id,matched_by,state,pushed_at,inspection_method)
         VALUES($1,$2,'created','live',now(),'mobile')`, [appId, BASE + (seq * 20) + 19]);
      const drawIds = [];
      for (let i = 0; i < count; i++) {
        const drawId = BASE + (seq * 20) + i;
        await db.query(
          `INSERT INTO sitewire_draws(application_id,sitewire_draw_id,number,status,total_requested_cents,total_approved_cents)
           VALUES($1,$2,$3,'approved',$4,$4)`, [appId, drawId, i + 1, approvedCents]);
        drawIds.push(drawId);
      }
      seq++;
      return { appId, drawIds };
    }
    const record = (appId, drawId, body) => call(server, 'POST', '/api/sitewire/disbursements', token, {
      application_id: appId, sitewire_draw_id: String(drawId), funded_status: 'held', ...body,
    });
    const rowFor = async (drawId) =>
      (await db.query(`SELECT * FROM draw_disbursements WHERE sitewire_draw_id=$1`, [drawId])).rows[0] || null;

    // The owner's own figures, off their own screen: $7,700 approved, our $299 draw fee.
    const APPROVED = 770000, FEE = 29900, CORR_CUT = 9500;

    // ======================================================================
    // 1. SOLD TO CORRFIRST — the cut fills itself in, and the borrower is untouched
    // ======================================================================
    const corr = await mkFile({ buyer: 'CorrFirst', paDate: '2026-05-04', approvedCents: APPROVED, count: 4 });
    {
      const r = await record(corr.appId, corr.drawIds[0], { approved_cents: APPROVED, fee_cents: FEE });
      eq('1a the release records', r.status, 200);
      const row = await rowFor(corr.drawIds[0]);
      eq('1b CorrFirst keeps $95 of our fee, filled in by the rule', n(row.investor_fee_cents), CORR_CUT);
      eq('1c …so $204 is deposited to us', n(row.net_fee_cents), FEE - CORR_CUT);
      eq('1d …and the ledger names who kept it', row.investor_fee_key, 'corrfirst');
      // THE POINT OF THE WHOLE FEATURE: our fee as CHARGED is unchanged, and so is the wire.
      eq('1e the fee charged out of the draw is still the whole $299', n(row.fee_cents), FEE);
      eq('1f …and the borrower still nets approved − fee, to the cent', n(row.net_release_cents), APPROVED - FEE);
      eq('1g …out of the same approved amount', n(row.approved_cents), APPROVED);
    }

    // ======================================================================
    // 2. THE BOX IS EDITABLE — a typed figure wins, both ways
    // ======================================================================
    {
      const zero = await record(corr.appId, corr.drawIds[1], { approved_cents: APPROVED, fee_cents: FEE, investor_fee_cents: 0 });
      eq('2a a typed $0 records', zero.status, 200);
      const row0 = await rowFor(corr.drawIds[1]);
      eq('2b …and beats the rule — we keep the whole fee on this one', [n(row0.investor_fee_cents), n(row0.net_fee_cents)], [0, FEE]);
      eq('2c …and the borrower is STILL untouched by the difference', n(row0.net_release_cents), APPROVED - FEE);

      const more = await record(corr.appId, corr.drawIds[2], { approved_cents: APPROVED, fee_cents: FEE, investor_fee_cents: 15000 });
      eq('2d a bigger typed cut records', more.status, 200);
      const row1 = await rowFor(corr.drawIds[2]);
      eq('2e …and our deposit goes down by exactly that much', [n(row1.investor_fee_cents), n(row1.net_fee_cents)], [15000, FEE - 15000]);

      // …but never more than we charged: that would report a deposit that never arrives.
      const over = await record(corr.appId, corr.drawIds[3], { approved_cents: APPROVED, fee_cents: FEE, investor_fee_cents: FEE + 100 });
      eq('2f a cut bigger than our own fee is refused', over.status, 422);
      ok('2g …saying why, in money', /more than our/.test((over.body && over.body.error) || ''));
      eq('2h …and NOTHING was recorded for that draw', await rowFor(corr.drawIds[3]), null);

      const nan = await record(corr.appId, corr.drawIds[3], { approved_cents: APPROVED, fee_cents: FEE, investor_fee_cents: 'abc' });
      eq('2i a garbage cut is refused too — never coerced to $0 income', nan.status, 400);
      const neg = await record(corr.appId, corr.drawIds[3], { approved_cents: APPROVED, fee_cents: FEE, investor_fee_cents: -500 });
      eq('2j …and so is a negative one', neg.status, 400);
      eq('2k …with still nothing recorded', await rowFor(corr.drawIds[3]), null);
    }

    // ======================================================================
    // 3. NOT SOLD YET → NO INVESTOR FEE AT ALL, and WE release
    //    (owner-directed 2026-08-13)
    // ======================================================================
    {
      const unsold = await mkFile({ buyer: 'CorrFirst', paDate: null, approvedCents: APPROVED, count: 3 });
      // The file is set to "the investor releases" — and it makes no difference until it is sold.
      await db.query(`UPDATE sitewire_property_links SET investor_funding_mode='investor_direct' WHERE application_id=$1`, [unsold.appId]);

      const desk = await call(server, 'GET', `/api/sitewire/files/${unsold.appId}/rollup`, token);
      eq('3a the desk answers', desk.status, 200);
      eq('3b an unsold loan is released by US, whatever the file says',
        [desk.body.release.mode, desk.body.release.party], ['reimbursement', 'us']);
      eq('3c …with the file’s own setting still reported, ready to resume', desk.body.release.configuredMode, 'investor_direct');
      eq('3d …and the file carries the "not sold yet" badge', desk.body.release.badge.code, 'not_sold_yet');
      eq('3e …and NO investor-fee box is offered — nobody is charging anything',
        [desk.body.investor_fee.offer, desk.body.investor_fee.applies], [false, false]);

      const r = await record(unsold.appId, unsold.drawIds[0], { approved_cents: APPROVED, fee_cents: FEE });
      eq('3f the release still records', r.status, 200);
      const row = await rowFor(unsold.drawIds[0]);
      eq('3g …with no investor fee, and the whole $299 ours',
        [n(row.investor_fee_cents), n(row.net_fee_cents)], [0, FEE]);
      eq('3h …nobody named as having kept anything', row.investor_fee_key, null);
      eq('3i …and OUR wire recorded, not the investor’s', row.release_party, 'us');

      // Typing one in anyway is a mistake worth naming, not a figure worth recording.
      const typed = await record(unsold.appId, unsold.drawIds[1], { approved_cents: APPROVED, fee_cents: FEE, investor_fee_cents: CORR_CUT });
      eq('3j an investor fee typed on an unsold loan is refused', typed.status, 422);
      ok('3k …explaining that they are not charging on this draw yet', /hasn.t been sold to them yet/.test((typed.body && typed.body.error) || ''));
      eq('3l …and nothing was recorded', await rowFor(unsold.drawIds[1]), null);

      // ---- the draw coordinator processes the file as sold (the double warning's second half) ----
      const noConfirm = await call(server, 'POST', `/api/sitewire/files/${unsold.appId}/treat-as-sold`, token, { on: true });
      eq('3m processing a file as sold without confirming is refused', noConfirm.status, 400);

      const flip = await call(server, 'POST', `/api/sitewire/files/${unsold.appId}/treat-as-sold`, token, { on: true, confirm: true, note: 'Investor confirmed the purchase by email' });
      eq('3n …and with the confirmation it is set', flip.status, 200);
      eq('3o the money now reads the file as sold', flip.body.release.soldEffective, 'sold');
      eq('3p …while the FACT about the loan is untouched', flip.body.release.sold, 'not_sold');
      eq('3q …the file’s own setting governs again', flip.body.release.mode, 'investor_direct');

      const desk2 = await call(server, 'GET', `/api/sitewire/files/${unsold.appId}/rollup`, token);
      eq('3r …and the investor fee now applies, at their rate',
        [desk2.body.investor_fee.offer, desk2.body.investor_fee.suggested_cents], [true, CORR_CUT]);

      const after = await record(unsold.appId, unsold.drawIds[1], { approved_cents: APPROVED, fee_cents: FEE });
      eq('3s a release recorded now takes the cut', after.status, 200);
      const row2 = await rowFor(unsold.drawIds[1]);
      eq('3t …$95 to CorrFirst, $204 ours', [n(row2.investor_fee_cents), n(row2.net_fee_cents)], [CORR_CUT, FEE - CORR_CUT]);
      eq('3u …and the investor recorded as the side that wired', row2.release_party, 'investor');

      // …and it is reversible, straight back to what Encompass says.
      const undo = await call(server, 'POST', `/api/sitewire/files/${unsold.appId}/treat-as-sold`, token, { on: false });
      eq('3v it can be turned back off', undo.status, 200);
      eq('3w …and the file is released by us again, with no fee offered',
        [undo.body.release.mode, undo.body.release.soldEffective], ['reimbursement', 'not_sold']);
    }

    // ======================================================================
    // 4. BLUE LAKE KEEPS THE WHOLE $250 — we bank nothing
    // ======================================================================
    {
      const BL_FEE = 25000;
      const blue = await mkFile({ buyer: 'BlueLake', paDate: '2026-04-01', approvedCents: APPROVED });
      const r = await record(blue.appId, blue.drawIds[0], { approved_cents: APPROVED, fee_cents: BL_FEE });
      eq('4a the release records', r.status, 200);
      const row = await rowFor(blue.drawIds[0]);
      eq('4b Blue Lake keeps the entire draw fee', n(row.investor_fee_cents), BL_FEE);
      eq('4c …so nothing is deposited to us', n(row.net_fee_cents), 0);
      eq('4d …while the borrower still nets approved − the same fee', n(row.net_release_cents), APPROVED - BL_FEE);
    }

    // ======================================================================
    // 5. A BUYER WITH NO SUCH DEAL IS COMPLETELY UNCHANGED
    // ======================================================================
    {
      const fid = await mkFile({ buyer: 'Fidelis Investors', paDate: '2026-04-01', approvedCents: APPROVED });
      const r = await record(fid.appId, fid.drawIds[0], { approved_cents: APPROVED, fee_cents: FEE });
      eq('5a the release records', r.status, 200);
      const row = await rowFor(fid.drawIds[0]);
      eq('5b a sold Fidelis file keeps the whole fee — no rule, no cut',
        [n(row.investor_fee_cents), n(row.net_fee_cents), row.investor_fee_key], [0, FEE, null]);
    }

    // ======================================================================
    // 6. THE DEPOSIT IS THE DATABASE'S OWN ARITHMETIC
    // ======================================================================
    {
      let refusedWrite = false;
      try { await db.query(`UPDATE draw_disbursements SET net_fee_cents=999999 WHERE sitewire_draw_id=$1`, [corr.drawIds[0]]); }
      catch (e) { refusedWrite = !!e; }
      ok('6a nobody can type a deposit into the ledger — it is generated', refusedWrite);

      let refusedCut = false;
      try { await db.query(`UPDATE draw_disbursements SET investor_fee_cents=fee_cents+1 WHERE sitewire_draw_id=$1`, [corr.drawIds[0]]); }
      catch (e) { refusedCut = e && e.code === '23514'; }
      ok('6b …and the database itself refuses a cut bigger than the fee', refusedCut);

      // It tracks the fee, not a snapshot: correct the fee and the deposit follows on its own.
      await db.query(`UPDATE draw_disbursements SET fee_cents=49900 WHERE sitewire_draw_id=$1`, [corr.drawIds[0]]);
      const row = await rowFor(corr.drawIds[0]);
      eq('6c correcting the fee re-derives the deposit with no second write', n(row.net_fee_cents), 49900 - CORR_CUT);
      await db.query(`UPDATE draw_disbursements SET fee_cents=$2 WHERE sitewire_draw_id=$1`, [corr.drawIds[0], FEE]);
    }

    // ======================================================================
    // 7. THE DESK CARRIES THE RULE, so the box can fill itself in
    // ======================================================================
    {
      const desk = await call(server, 'GET', `/api/sitewire/files/${corr.appId}/rollup`, token);
      eq('7a the draw desk answers', desk.status, 200);
      const r = desk.body && desk.body.investor_fee;
      ok('7b …and carries the investor-fee rule for this file', !!r);
      eq('7c …naming the buyer and their rate', [r.buyer_key, r.rule_cents], ['corrfirst', CORR_CUT]);
      eq('7d …and that it applies, because this loan is sold to them', [r.applies, r.sold], [true, 'sold']);
      // OUR income on the project, split — the ledger tiles read these.
      const fees = desk.body.rollup && desk.body.rollup.fees;
      ok('7e the project fee totals carry the split', fees && fees.investor_cents != null && fees.net_cents != null);
      eq('7f …and it balances: charged − kept = deposited',
        n(fees.charged_cents) - n(fees.investor_cents), n(fees.net_cents));
    }

    bad = fail;
  } finally {
    await db.query(`DELETE FROM applications WHERE ys_loan_number LIKE $1`, [`IF${sfx.slice(-6)}%`]).catch(() => {});
    await db.query(`DELETE FROM staff_users WHERE email=$1`, [`inv-fee-${sfx}@test.local`]).catch(() => {});
    await db.query(`DELETE FROM borrowers WHERE email=$1`, [`inv-fee-bo-${sfx}@test.local`]).catch(() => {});
    server.close();
  }
  console.log(`test-investor-draw-fee-db: ${pass} passed, ${fail} failed.`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
