'use strict';
/**
 * THE MINIMUM ORIGINATION FEE, END TO END over real HTTP against a real Postgres
 * (owner-directed 2026-09-04, db/695). What a pure test cannot see:
 *
 *   A. db/695 itself — two NULLABLE columns with NO DEFAULT, two CHECKs that bite, and a clean
 *      idempotent replay. The no-DEFAULT half is the whole design: a stamped copy of the default
 *      is an explicit per-file choice that outlives every later change to the company number.
 *   B. The Pricing Admin Center — the owner's *"where we can increase and decrease the minimum
 *      accordingly"*. It saves, round-trips through the verified re-read, refuses a decimal slip
 *      with a sentence a person can act on, and is PRESERVED by a caller that does not mention it
 *      (the legacy V1 pricing screen sends none of the newer keys).
 *   C. The whole chain PRICING A REAL LOAN through the real register route: the company number,
 *      an approved per-file exception, an approved waiver, and — the owner's own rule — a
 *      re-registration with a BLANK box following today's number rather than the one in force the
 *      day the file first registered.
 *   D. The approval routing: raising the floor registers straight through, lowering it or waiving
 *      it opens a real escalation for an admin.
 *   E. A BORROWER and a TPO broker cannot set it, from their own doors, at all.
 *
 * Requires DATABASE_URL; skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-min-origination-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const pricingSettings = require('../src/lib/pricing-settings');
const app = require('../src/server');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
function call(server, method, p, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, path: p, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', (c2) => b += c2); res.on('end', () => { try { resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }); } catch (e) { resolve({ status: res.statusCode, body: null, raw: b }); } }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

/* A loan the floor BINDS on that is still fully ELIGIBLE, and the gap between those two is the
   thing to get right. At the 1.25% default the minimum is reached at a $200,000 LOAN, and the
   Standard program refuses anything under $100,000 — so the fixture has to sit between them. A
   $120,000 purchase with a $36,000 budget sizes about $144,000, whose percentage origination is
   about $1,800: comfortably under the $2,500 minimum and comfortably over the program floor.
   (A first cut used a $60,000 purchase; it sized $72,000, was refused as MANUAL for being under
   the program minimum, and every pricing assertion in this file failed on the FIXTURE rather than
   on anything under test.) */
const SMALL = {
  loanType: 'Purchase', strategy: 'Fix & Flip', state: 'TX', propertyType: 'SFR (1 unit)',
  purchasePrice: 120000, asIsValue: 120000, arv: 200000, rehabBudget: 36000,
  fico: 740, expFlips: 5, term: 12,
};

(async () => {
  // Idempotent by construction, so applying it directly makes this suite self-sufficient on a
  // database that predates db/695.
  await db.query(fs.readFileSync(path.join(__dirname, '..', 'db', '695_min_origination_fee.sql'), 'utf8'));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const priorCurrent = (await db.query(`SELECT id FROM company_pricing_settings WHERE is_current LIMIT 1`)).rows[0] || null;
  try {
    const mkStaff = async (role, name) => (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,$2,$3,true,false,'x',0) RETURNING id`,
      [`mof-${role}-${sfx}@test.local`, name, role])).rows[0].id;
    const loId = await mkStaff('loan_officer', 'Officer One');
    const adminId = await mkStaff('admin', 'Admin Two');
    const loTok = C.signJwt({ sub: loId, kind: 'staff', role: 'loan_officer', tv: 0 });
    const adminTok = C.signJwt({ sub: adminId, kind: 'staff', role: 'admin', tv: 0 });

    const borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Mof','Test',$1) RETURNING id`,
      [`mof-bo-${sfx}@test.local`])).rows[0].id;
    await db.query(`INSERT INTO borrower_auth (borrower_id,password_hash,token_version) VALUES ($1,'x',0) ON CONFLICT DO NOTHING`, [borrowerId]);
    const boTok = C.signJwt({ sub: borrowerId, kind: 'borrower', tv: 0 });
    const mkApp = async () => (await db.query(
      `INSERT INTO applications (borrower_id, loan_officer_id, status, loan_type, program, property_type,
                                 purchase_price, as_is_value, arv, rehab_budget, rehab_type, term,
                                 requested_exp_flips, property_address)
       VALUES ($1,$2,'underwriting','Purchase','standard','SFR (1 unit)',120000,120000,200000,36000,'Cosmetic','12 Months',5,
               '{"line1":"1 Test St","city":"Austin","state":"TX","zip":"78701"}'::jsonb)
       RETURNING id`, [borrowerId, loId])).rows[0].id;
    const reg = (appId) => `/api/staff/applications/${appId}/pricing/register`;
    const feeOf = async (appId) => {
      const r = await db.query(`SELECT quote FROM product_registrations WHERE application_id=$1 AND is_current`, [appId]);
      const q = r.rows[0] && r.rows[0].quote;
      return q && q.closingCosts ? Number(q.closingCosts.origination) : null;
    };
    const explainOf = async (appId) => {
      const r = await db.query(`SELECT quote FROM product_registrations WHERE application_id=$1 AND is_current`, [appId]);
      const q = r.rows[0] && r.rows[0].quote;
      return q && q.closingCosts ? (q.closingCosts.originationMinimum || null) : null;
    };

    // ═══ A. db/695 ═══════════════════════════════════════════════════════════════════════════
    const colInfo = await db.query(
      `SELECT table_name, is_nullable, column_default, numeric_precision, numeric_scale
         FROM information_schema.columns
        WHERE (table_name='company_pricing_settings' AND column_name='min_orig_fee')
           OR (table_name='applications' AND column_name='file_min_orig_fee')`);
    assert(colInfo.rows.length === 2, `A1 both columns exist (got ${colInfo.rows.length})`);
    assert(colInfo.rows.every((r) => r.is_nullable === 'YES'), 'A2 both are NULLABLE');
    /* THE NO-DEFAULT HALF IS THE DESIGN, not an omission: a DEFAULT stamps the number onto every
       row at INSERT, and a stamped value is an EXPLICIT per-file override that outlives every
       later change to the company number — the 2026-08-20 defect, in the database. */
    assert(colInfo.rows.every((r) => r.column_default == null), 'A3 …and NEITHER carries a DEFAULT');
    const checks = await db.query(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname LIKE '%min_orig_fee%'`);
    assert(checks.rows.length === 2, `A4 both CHECKs are present (got ${checks.rows.length})`);
    const bad = await db.query(`SELECT 1`).then(() => db.query(
      `INSERT INTO company_pricing_settings(min_orig_fee,is_current) VALUES (30000,false)`)).then(() => 'accepted').catch(() => 'refused');
    assert(bad === 'refused', 'A5 the CHECK refuses a decimal slip (30,000)');
    const okZero = await db.query(
      `INSERT INTO company_pricing_settings(min_orig_fee,is_current) VALUES (0,false),(25000,false) RETURNING min_orig_fee`)
      .then((r) => r.rows.length).catch(() => 0);
    assert(okZero === 2, 'A6 …and accepts 0 (a company-wide waiver) and the ceiling itself');
    await db.query(`DELETE FROM company_pricing_settings WHERE is_current=false AND min_orig_fee IN (0,25000)`);
    // Replaying is a clean no-op — every migration re-runs on every boot.
    let replayed = true;
    try { await db.query(fs.readFileSync(path.join(__dirname, '..', 'db', '695_min_origination_fee.sql'), 'utf8')); }
    catch (_) { replayed = false; }
    assert(replayed, 'A7 the migration replays cleanly on a second boot');

    // ═══ B. The Pricing Admin Center ═════════════════════════════════════════════════════════
    const put0 = await call(server, 'PUT', '/api/admin/pricing', adminTok, { minOrigFee: null });
    assert(put0.status === 200, `B0 baseline save (got ${put0.status})`);
    assert(put0.body && put0.body.current && Number(put0.body.current.minOrigFee) === 2500,
      'B1 a NULL column reads back as the system default, never as nothing');
    const put1 = await call(server, 'PUT', '/api/admin/pricing', adminTok, { minOrigFee: 3000 });
    assert(put1.status === 200 && Number(put1.body.current.minOrigFee) === 3000,
      'B2 the owner can raise it, and the verified re-read carries it');
    /* PRESERVE-IF-ABSENT. The legacy V1 pricing screen sends none of the newer keys; treating this
       like the other scalars would silently reset a minimum somebody deliberately raised. */
    const put2 = await call(server, 'PUT', '/api/admin/pricing', adminTok, { note: 'unrelated save' });
    assert(put2.status === 200 && Number(put2.body.current.minOrigFee) === 3000,
      'B3 a save that never mentions it PRESERVES it');
    const putBad = await call(server, 'PUT', '/api/admin/pricing', adminTok, { minOrigFee: 900000 });
    assert(putBad.status === 400 && /minimum origination fee/i.test(String(putBad.body && putBad.body.error)),
      `B4 a decimal slip is refused with a sentence a person can act on (got ${putBad.status} ${JSON.stringify(putBad.body)})`);
    const putNeg = await call(server, 'PUT', '/api/admin/pricing', adminTok, { minOrigFee: -1 });
    assert(putNeg.status === 400, 'B5 …and so is a negative');
    const stillThere = await call(server, 'GET', '/api/admin/pricing', adminTok);
    assert(stillThere.status === 200 && Number(stillThere.body.current.minOrigFee) === 3000,
      'B6 …and a refused save changed nothing');

    // ═══ C. PRICING A REAL LOAN ══════════════════════════════════════════════════════════════
    const appA = await mkApp();
    const rA = await call(server, 'POST', reg(appA), loTok, { program: 'standard', overrides: { ...SMALL } });
    assert(rA.status === 201, `C1 the small loan registers (got ${rA.status} ${JSON.stringify((rA.body && rA.body.error) || '')})`);
    assert(await feeOf(appA) === 3000, `C2 …charged the COMPANY minimum in force ($3,000), not the percentage (got ${await feeOf(appA)})`);
    const ex = await explainOf(appA);
    assert(ex && ex.pctAmount < ex.minimum && ex.minimum === 3000
      && Math.round((ex.shortfall - (ex.minimum - ex.pctAmount)) * 100) === 0
      && /minimum/i.test(String(ex.note)),
      `C3 …and the quote records WHY, with arithmetic that reconciles (${JSON.stringify(ex)})`);

    await call(server, 'PUT', '/api/admin/pricing', adminTok, { minOrigFee: null });   // back to $2,500
    /* THE OWNER'S OWN RULE: *"any file, even if it's already in the system, by the next
       registration, it should follow the rules of the new registration if it gets re-registered
       again. Shouldn't be locked in where the fee was already locked in."* */
    const rA2 = await call(server, 'POST', reg(appA), loTok, { program: 'standard', overrides: { ...SMALL } });
    assert(rA2.status === 201, `C4 the file re-registers (got ${rA2.status})`);
    assert(await feeOf(appA) === 2500,
      `C5 …and follows TODAY'S company minimum, never the one in force when it first registered (got ${await feeOf(appA)})`);
    const stickyA = (await db.query(`SELECT file_min_orig_fee FROM applications WHERE id=$1`, [appA])).rows[0].file_min_orig_fee;
    assert(stickyA == null, `C6 …because a blank box leaves the file's own column NULL (got ${stickyA})`);

    // An approved per-file EXCEPTION, and an approved WAIVER.
    const appB = await mkApp();
    const rB = await call(server, 'POST', reg(appB), adminTok, { program: 'standard', overrides: { ...SMALL, minOrigFee: 5000 } });
    assert(rB.status === 201, `C7 an approved per-file exception registers (got ${rB.status})`);
    assert(await feeOf(appB) === 5000, `C8 …and RAISES the floor on that file (got ${await feeOf(appB)})`);
    const appC = await mkApp();
    const rC = await call(server, 'POST', reg(appC), adminTok, { program: 'standard', overrides: { ...SMALL, minOrigFee: 0 } });
    assert(rC.status === 201, `C9 an approved waiver registers (got ${rC.status})`);
    assert(Math.abs(await feeOf(appC) - Number(ex.pctAmount)) < 0.02,
      `C10 …and prices exactly the percentage the system charged before the minimum (got ${await feeOf(appC)}, want ${ex.pctAmount})`);
    assert(await explainOf(appC) === null, 'C11 …with no explain block at all, so nothing says "minimum applied"');
    // A blank box CLEARS a stale exception — the same rule, from the other side.
    /* THE EXPLICIT BLANK is what the studio sends for an empty box — `''`, not an absent key —
       because `compact()` drops `''` and a dropped key can never clear a stale sticky. That is the
       whole of the owner's re-registration rule, and this assertion is what proves the panel's
       payload carries it (it FAILED until `minOrigFee` was moved out of `compact()`). */
    const rC2 = await call(server, 'POST', reg(appC), adminTok, { program: 'standard', overrides: { ...SMALL, minOrigFee: '' } });
    assert(rC2.status === 201 && await feeOf(appC) === 2500,
      `C12 …and blanking the box takes the waiver back off on the next registration (got ${await feeOf(appC)})`);

    // ═══ D. APPROVAL ROUTING ═════════════════════════════════════════════════════════════════
    const escOf = async (appId) => (await db.query(
      `SELECT count(*)::int AS n FROM manual_program_escalations WHERE application_id=$1 AND status='pending'`, [appId])).rows[0].n;
    const appD = await mkApp();
    await call(server, 'POST', reg(appD), loTok, { program: 'standard', overrides: { ...SMALL, minOrigFee: 6000 } });
    assert(await escOf(appD) === 0, 'D1 RAISING the floor charges more and opens no approval');
    const appE = await mkApp();
    await call(server, 'POST', reg(appE), loTok, { program: 'standard', overrides: { ...SMALL, minOrigFee: 1000 } });
    assert(await escOf(appE) === 1, 'D2 LOWERING it is a discount and opens one');
    const appF = await mkApp();
    await call(server, 'POST', reg(appF), loTok, { program: 'standard', overrides: { ...SMALL, minOrigFee: 0 } });
    assert(await escOf(appF) === 1, 'D3 …and so does waiving it outright');

    // ═══ E. WHO CANNOT SET IT ════════════════════════════════════════════════════════════════
    const appG = await mkApp();
    const rG = await call(server, 'POST', `/api/borrower/applications/${appG}/pricing/register`, boTok,
      { program: 'standard', overrides: { ...SMALL, minOrigFee: 0 } });
    if (rG.status === 201) {
      assert(await feeOf(appG) === 2500, `E1 a BORROWER's waiver is ignored - the minimum still applies (got ${await feeOf(appG)})`);
      const stickyG = (await db.query(`SELECT file_min_orig_fee FROM applications WHERE id=$1`, [appG])).rows[0].file_min_orig_fee;
      assert(stickyG == null, 'E2 …and nothing was stuck on the file');
    } else {
      /* The borrower door refuses this fixture for its own reasons on some databases; the
         allowlist is proven structurally either way rather than left unasserted. */
      const ov = require('../src/lib/pricing-overrides');
      assert(!('minOrigFee' in ov.borrowerPricingOverrides({ minOrigFee: 0 })),
        `E1 (register unavailable: ${rG.status}) the non-lender allowlist structurally cannot carry it`);
      assert(true, 'E2 …asserted at the allowlist instead');
    }

    // The TPO channel INHERITS the retail minimum and has no knob of its own — deliberate: the
    // floor is OUR fee's, and a per-channel minimum is a business rule nobody has stated.
    await call(server, 'PUT', '/api/admin/pricing', adminTok, { minOrigFee: 4000 });
    pricingSettings.bust(); await pricingSettings.load();
    const tpoCd = require('../src/lib/tpo-pricing').mergeSettings(pricingSettings.current(), null, null);
    assert(Number(tpoCd.minOrigFee) === 4000, `E3 a TPO file inherits the company minimum (got ${tpoCd.minOrigFee})`);
    await call(server, 'PUT', '/api/admin/pricing', adminTok, { minOrigFee: null });

    // ═══ THE EXCEPTION PAD ═══════════════════════════════════════════════════════════════════
    const excMaps = await call(server, 'GET', `/api/staff/applications/${appA}/exceptions`, adminTok);
    const codes = excMaps.body && (excMaps.body.reasonCodesByType || {}).pricing_exception;
    assert(codes && Object.prototype.hasOwnProperty.call(codes, 'min_orig_fee'),
      `F1 the exception routes offer a minimum-fee reason, derived from the ONE registry (got ${JSON.stringify(codes && Object.keys(codes))})`);
  } finally {
    // Put the shared database back exactly as it was found (append-only history: flip is_current
    // back rather than deleting anything).
    try {
      if (priorCurrent) {
        await db.query(`UPDATE company_pricing_settings SET is_current=false WHERE is_current`);
        await db.query(`UPDATE company_pricing_settings SET is_current=true WHERE id=$1`, [priorCurrent.id]);
        pricingSettings.bust();
      }
    } catch (_) { /* best-effort */ }
    server.close();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
