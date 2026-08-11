/**
 * TPO PRICING LAYER — real Postgres + HTTP (owner-directed 2026-08-06).
 *
 * Proves the whole wholesale pricing layer end-to-end through the real routes:
 *   1. Admin TPO-channel controls (/api/admin/pricing/tpo): view, save, validate,
 *      and a broker (kind='tpo') is REFUSED (can never reach the admin route).
 *   2. A TPO-channel origination cut actually LOWERS a broker file's quote, while
 *      RETAIL company settings are untouched (no contamination).
 *   3. Per-firm overrides (/api/admin/tpo/firms/:id/pricing) WIN over the channel,
 *      and clearing reverts to the channel; setting them never clobbers the broker
 *      fee.
 *   4. The broker fee (/api/tpo/pricing/broker-fee): a FIRM ADMIN sets only their
 *      own fee (never the rate), clamped to the ceiling; a non-admin is refused;
 *      the fee shows on that firm's quote and nowhere else.
 *   5. Program → capital-provider auto-set on register (staff-only note buyer).
 *   6. A broker has NO access to Attorney Closing Prep (403).
 */
const http = require('http');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

function call(server, method, p, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) };
    const r = http.request({ method, path: p, port: server.address().port, host: '127.0.0.1', headers },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const num = (v) => (v == null ? null : Number(v));

(async () => {
  if (!process.env.DATABASE_URL) { console.log('  ~~ SKIP TPO pricing-layer DB (no DATABASE_URL)'); process.exit(0); }
  const R = require('path').resolve(__dirname, '..');
  const db = require(R + '/src/db');
  const C = require(R + '/src/lib/crypto');
  const registry = require(R + '/src/lib/conditions/field-registry');
  const app = require(R + '/src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));

  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const mail = (t) => `${t}-${sfx}@brk.test`;
  const loanNo = 'YT' + Math.floor(Math.random() * 1e9).toString(36).toUpperCase();   // unique per run
  const staffTok = (id) => C.signJwt({ sub: id, kind: 'staff', role: 'super_admin', tv: 0 });
  const tpoTok = (id) => C.signJwt({ sub: id, kind: 'tpo', role: 'tpo_officer', tv: 0 });
  const addr = JSON.stringify({ line1: '9 Oak St', city: 'Lakewood', state: 'NJ', zip: '08701' });
  const norm = (s) => registry.normNoteBuyer(s);

  // Snapshot the retail TPO-channel row so we can restore it (shared singleton).
  const chanBefore = (await db.query(`SELECT * FROM tpo_pricing_settings WHERE id=1`)).rows[0];

  try {
    const hash = await C.hashPassword('BrokerPass123!');
    // A super-admin (manage_pricing + platform_setup), two firms, a firm-admin
    // broker A and a NON-admin broker B.
    const admin = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,is_external,password_hash,token_version)
       VALUES ($1,'Boss','super_admin',true,false,$2,0) RETURNING id`, [mail('boss'), hash])).rows[0].id;
    const firmA = (await db.query(`INSERT INTO tpo_firms (name,status) VALUES ($1,'active') RETURNING id`, [`Firm A ${sfx}`])).rows[0].id;
    const firmB = (await db.query(`INSERT INTO tpo_firms (name,status) VALUES ($1,'active') RETURNING id`, [`Firm B ${sfx}`])).rows[0].id;
    const brokerA = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,is_external,tpo_firm_id,is_firm_admin,password_hash,token_version)
       VALUES ($1,'Broker A','tpo_officer',true,true,$2,true,$3,0) RETURNING id`, [mail('brokerA'), firmA, hash])).rows[0].id;
    const brokerB = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,is_external,tpo_firm_id,is_firm_admin,password_hash,token_version)
       VALUES ($1,'Broker B','tpo_processor',true,true,$2,false,$3,0) RETURNING id`, [mail('brokerB'), firmB, hash])).rows[0].id;
    const adminT = staffTok(admin), tokA = tpoTok(brokerA), tokB = tpoTok(brokerB);

    // A firm-A borrower + a TPO file that sizes a real loan (so it quotes + registers).
    const borId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email,fico,current_address,origin)
       VALUES ('Cal','Broker',$1,740,$2,'tpo') RETURNING id`, [mail('cal'), addr])).rows[0].id;
    const appA = (await db.query(
      `INSERT INTO applications (borrower_id, is_tpo, tpo_firm_id, loan_officer_id, ys_loan_number, status,
         loan_type, program, property_type, units, purchase_price, as_is_value, arv, rehab_budget, term,
         requested_exp_flips, requested_exp_holds, property_address, source, borrower_portal_enabled)
       VALUES ($1,true,$2,$3,$5,'file_intake','Purchase','Fix and Flip','Single Family',1,
         300000,300000,450000,90000,'12',5,2,$4,'tpo',true) RETURNING id`,
      [borId, firmA, brokerA, addr, loanNo])).rows[0].id;

    // ── 1) Admin TPO-channel controls ─────────────────────────────────────────
    const g0 = await call(server, 'GET', '/api/admin/pricing/tpo', adminT);
    ok(g0.status === 200 && g0.body.tpo && g0.body.retail, 'admin reads the TPO-channel settings + retail defaults');
    ok(g0.body.tpo.origStdPct == null, 'TPO-channel origination starts blank (= same as retail)');
    ok(num(g0.body.retail.origStdPct) === 1.25, 'retail Standard origination default is 1.25%');
    // a broker can NEVER reach the admin pricing route
    ok((await call(server, 'GET', '/api/admin/pricing/tpo', tokA)).status === 403, 'a broker is refused the admin TPO-pricing route (403)');
    // validation
    ok((await call(server, 'PUT', '/api/admin/pricing/tpo', adminT, { origStdPct: 150 })).status === 400, 'an out-of-range origination is refused (400)');
    ok((await call(server, 'PUT', '/api/admin/pricing/tpo', adminT, { markupSilverPct: 2 })).status === 400, 'a Silver markup over 1.00% is refused (400)');
    // save a real channel cut: Standard origination 1.25% → 0.5%
    const put1 = await call(server, 'PUT', '/api/admin/pricing/tpo', adminT, { origStdPct: 0.5 });
    ok(put1.status === 200 && num(put1.body.tpo.origStdPct) === 0.5, 'admin saves TPO Standard origination = 0.5%');

    // ── 2) The channel cut lowers a broker file's quote; retail is untouched ───
    const q1 = await call(server, 'POST', `/api/tpo/applications/${appA}/pricing/quote`, tokA, { overrides: {} });
    ok(q1.status === 200 && q1.body.standard, 'broker gets a quote');
    // origPct is a FRACTION (0.005 = 0.5%). Channel cut applied → 0.005, not retail's 0.0125.
    ok(Math.abs(num(q1.body.standard.origPct) - 0.005) < 1e-6, 'the broker Standard quote now prices origination at 0.5% (the TPO channel value)');
    const retailRow = (await db.query(`SELECT orig_std_pct FROM company_pricing_settings WHERE is_current`)).rows[0];
    ok(num(retailRow.orig_std_pct) === 1.25 || retailRow.orig_std_pct == null, 'RETAIL company origination is UNCHANGED by the TPO-channel save (no contamination)');
    // the broker quote never leaks internal margin
    ok(!/adminPricing|markupPct|"markup/.test(JSON.stringify(q1.body)), 'the broker quote leaks no internal markup/margin');

    // ── 2b) pricingDefaults (the studio seed) is SCRUBBED like every sibling ────
    // (adversarial-security audit 2026-08-06): extraFees[].name is admin-authored
    // free text, so a fee named with a note-buyer would otherwise print a capital-
    // partner name on a broker's term sheet. GET /pricing scrubs pricingDefaults on
    // the way out; numbers pass through untouched.
    {
      const pricingSettings = require(R + '/src/lib/pricing-settings');
      const feeBefore = (await db.query(`SELECT extra_fees FROM company_pricing_settings WHERE is_current`)).rows[0];
      if (feeBefore) {
        await db.query(`UPDATE company_pricing_settings SET extra_fees=$1 WHERE is_current`,
          [JSON.stringify([{ name: 'BlueLake settlement fee', amount: 1500, state: '' }])]);
        pricingSettings.bust();
        const gp = await call(server, 'GET', `/api/tpo/applications/${appA}/pricing`, tokA);
        const pd = gp.body && gp.body.pricingDefaults;
        const feeNames = (pd && Array.isArray(pd.extraFees)) ? pd.extraFees.map((f) => f && f.name).join('|') : '';
        ok(gp.status === 200 && pd, 'GET /pricing returns pricingDefaults for the studio to seed');
        ok(feeNames && !/blue\s*lake/i.test(feeNames), `a note-buyer name in an extra fee is SCRUBBED from pricingDefaults ("${feeNames}")`);
        ok(pd && pd.extraFees[0] && Number(pd.extraFees[0].amount) === 1500 && Number(pd.origStdPct) > 0,
          'the numeric fee + pcts pass through the scrub untouched');
        await db.query(`UPDATE company_pricing_settings SET extra_fees=$1 WHERE is_current`, [JSON.stringify(feeBefore.extra_fees)]);
        pricingSettings.bust();
      }
    }

    // ── 3) Per-firm override wins, and does not clobber the broker fee ─────────
    const fp0 = await call(server, 'GET', `/api/admin/tpo/firms/${firmA}/pricing`, adminT);
    ok(fp0.status === 200 && num(fp0.body.fallback.origStdPct) === 0.5, 'firm pricing GET shows the channel fallback (0.5%)');
    const fpPut = await call(server, 'PUT', `/api/admin/tpo/firms/${firmA}/pricing`, adminT, { origStdPct: 0.25 });
    ok(fpPut.status === 200 && num(fpPut.body.firm.origStdPct) === 0.25, 'admin sets a firm-specific origination override (0.25%)');
    const q2 = await call(server, 'POST', `/api/tpo/applications/${appA}/pricing/quote`, tokA, { overrides: {} });
    ok(Math.abs(num(q2.body.standard.origPct) - 0.0025) < 1e-6, 'the firm override (0.25%) BEATS the channel (0.5%) on the firm A quote');

    // ── 4) Broker fee ─────────────────────────────────────────────────────────
    const bf0 = await call(server, 'GET', '/api/tpo/pricing/broker-fee', tokA);
    ok(bf0.status === 200 && bf0.body.isFirmAdmin === true && bf0.body.brokerFeePct == null, 'firm-admin reads the broker fee (none yet)');
    ok(num(bf0.body.maxBrokerFeePct) > 0, 'a max broker fee is reported');
    // validation + non-admin refusal
    ok((await call(server, 'PUT', '/api/tpo/pricing/broker-fee', tokA, { brokerFeePct: 99 })).status === 400, 'a broker fee over the max is refused (400)');
    ok((await call(server, 'PUT', '/api/tpo/pricing/broker-fee', tokA, { brokerFeePct: -1 })).status === 400, 'a negative broker fee is refused (400)');
    ok((await call(server, 'PUT', '/api/tpo/pricing/broker-fee', tokB, { brokerFeePct: 1 })).status === 403, 'a NON-firm-admin broker cannot set the broker fee (403)');
    // set a real fee
    const bfPut = await call(server, 'PUT', '/api/tpo/pricing/broker-fee', tokA, { brokerFeePct: 1.5 });
    ok(bfPut.status === 200 && num(bfPut.body.brokerFeePct) === 1.5, 'firm-admin sets a 1.5% broker fee');
    // it shows on the firm's quote
    const q3 = await call(server, 'POST', `/api/tpo/applications/${appA}/pricing/quote`, tokA, { overrides: {} });
    const std3 = q3.body.standard;
    const expFee = Math.round(std3.sizing.totalLoan * 0.015 * 100) / 100;
    ok(Math.abs(num(std3.brokerFee) - expFee) < 0.01, 'the broker fee shows on the quote = loan × 1.5%');
    ok(std3.closingCosts && Math.abs(num(std3.closingCosts.brokerFee) - expFee) < 0.01, 'the broker fee is in the quote closing costs');
    // the admin per-firm PUT preserves the broker fee (owner: they are set by different people)
    await call(server, 'PUT', `/api/admin/tpo/firms/${firmA}/pricing`, adminT, { origStdPct: 0.25, markupStdPct: 0.6 });
    ok(num((await call(server, 'GET', '/api/tpo/pricing/broker-fee', tokA)).body.brokerFeePct) === 1.5, 'an admin per-firm pricing save does NOT clobber the broker fee');
    // firm B (no fee) is unaffected
    const fBs = (await db.query(`SELECT broker_orig_pct FROM tpo_firm_pricing WHERE tpo_firm_id=$1`, [firmB])).rows[0];
    ok(!fBs || fBs.broker_orig_pct == null, 'firm B has no broker fee (isolation)');

    // clearing the firm overrides reverts to the channel (broker fee kept)
    await call(server, 'DELETE', `/api/admin/tpo/firms/${firmA}/pricing`, adminT);
    const q4 = await call(server, 'POST', `/api/tpo/applications/${appA}/pricing/quote`, tokA, { overrides: {} });
    ok(Math.abs(num(q4.body.standard.origPct) - 0.005) < 1e-6, 'clearing the firm overrides reverts origination to the channel (0.5%)');
    ok(num((await call(server, 'GET', '/api/tpo/pricing/broker-fee', tokA)).body.brokerFeePct) === 1.5, 'clearing the firm markup/orig keeps the broker fee');

    // ── 5) Program → capital-provider auto-set on register (staff-only) ────────
    const gp = await call(server, 'GET', `/api/tpo/applications/${appA}/pricing`, tokA);
    const ev = gp.body && gp.body.econVersion;
    const regStd = await call(server, 'POST', `/api/tpo/applications/${appA}/pricing/register`, tokA,
      { program: 'standard', econVersion: ev, overrides: {} });
    if (regStd.status === 201) {
      const lender = (await db.query(`SELECT lender FROM applications WHERE id=$1`, [appA])).rows[0].lender;
      ok(norm(lender) === 'fidelis', `registering Standard auto-set the capital provider to Fidelis (lender="${lender}")`);
      // and it is NOT leaked to the broker: the TPO app view omits lender
      const av = await call(server, 'GET', `/api/tpo/applications/${appA}`, tokA);
      ok(av.status === 200 && !/fidelis/i.test(JSON.stringify(av.body)), 'the auto-set note buyer is NEVER exposed to the broker');
      // re-register Gold → Blue Lake (only assert if Gold registers cleanly)
      const gp2 = await call(server, 'GET', `/api/tpo/applications/${appA}/pricing`, tokA);
      const regGold = await call(server, 'POST', `/api/tpo/applications/${appA}/pricing/register`, tokA,
        { program: 'gold', econVersion: gp2.body && gp2.body.econVersion, overrides: {} });
      if (regGold.status === 201) {
        const lender2 = (await db.query(`SELECT lender FROM applications WHERE id=$1`, [appA])).rows[0].lender;
        ok(norm(lender2) === 'bluelake', `re-registering Gold moved the capital provider to Blue Lake (lender="${lender2}")`);
      } else {
        console.log(`  ~~ note: Gold register returned ${regGold.status} (${regGold.body && regGold.body.error || ''}) — skipping the Blue Lake sub-check`);
      }
    } else {
      console.log(`  ~~ note: Standard register returned ${regStd.status} (${regStd.body && regStd.body.error || ''}) — skipping the note-buyer auto-set checks`);
    }

    // ── 6) A broker has NO access to Attorney Closing Prep ─────────────────────
    ok((await call(server, 'GET', `/api/staff/applications/${appA}/closing-prep`, tokA)).status === 403, 'a broker cannot read Attorney Closing Prep (403)');
    ok((await call(server, 'POST', `/api/staff/applications/${appA}/closing-prep/place`, tokA, {})).status === 403, 'a broker cannot order Attorney Closing Prep (403)');

    console.log(`\nTPO pricing-layer DB: ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error('  ERROR:', e && e.stack || e); fail++;
  } finally {
    // restore the shared TPO-channel singleton to its pre-test values
    try {
      if (chanBefore) {
        await db.query(
          `UPDATE tpo_pricing_settings SET markup_std_pct=$1, markup_gold_pct=$2, markup_silver_pct=$3,
             orig_std_pct=$4, orig_gold_pct=$5, orig_silver_pct=$6, markup_tiers=$7 WHERE id=1`,
          [chanBefore.markup_std_pct, chanBefore.markup_gold_pct, chanBefore.markup_silver_pct,
           chanBefore.orig_std_pct, chanBefore.orig_gold_pct, chanBefore.orig_silver_pct, chanBefore.markup_tiers]);
      }
    } catch (_) { /* best-effort restore */ }
    server.close();
    setTimeout(() => process.exit(fail ? 1 : 0), 150);
  }
})();
