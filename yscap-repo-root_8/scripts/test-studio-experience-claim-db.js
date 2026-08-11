/**
 * The experience typed in the Term Sheet Studio is the file's CLAIM
 * (owner-directed 2026-08-06) — the DB half, over real HTTP against a real
 * Postgres.
 *
 * THE OWNER'S STORY, in order: *"they entered under Experience 10, Rentals
 * Stabilized, and on the condition it says that they don't need to verify
 * anything. If they entered any experience on the term sheet generated, they
 * should feed directly into the file, and the condition should require
 * verifying 10. You should not be able to sign it off till you verify 10."*
 *
 *   A. THE BUG, reproduced: with nothing fed, the track-record condition is
 *      NOT REQUIRED and signs off with nothing verified.
 *   B. Saving the studio scenario with 10 in "BRRRR / rentals stabilized"
 *      writes requested_exp_holds = 10 onto the FILE — no register needed.
 *   C. The condition turns REQUIRED and stops reading "no experience required".
 *   D. Sign-off is REFUSED (422) and the refusal says to verify 10 more holds.
 *   E. Ten VERIFIED holds on the track record let it sign off — nine do not.
 *   F. A blank studio field never zeroes a real claim; a typed 0 lowers it.
 *   G. A FROZEN file (funded) is never written by the autosave.
 *   H. Another tool's state save never feeds experience.
 *
 * Every assertion in A–E fails on the pre-fix code (A passes there and is the
 * bug; it is kept as the control that the fix is what changed the outcome).
 *
 * Requires DATABASE_URL; skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-studio-experience-claim-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const http = require('http');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const app = require('../src/server');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

function call(server, method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, path, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

/** The studio's saved scenario shape ({v, c}) — what studioStateFromFields writes. */
const studioState = (v) => ({ v: { propState: 'NJ', dealType: 'Fix & Hold (BRRRR)', ...v }, c: { isAssign: false } });

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  let staffId = null, borrowerId = null, borrowerI = null;
  try {
    staffId = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,'Owner','super_admin',true,false,'x',0) RETURNING id`,
      [`studioexp-${sfx}@test.local`])).rows[0].id;
    const tok = C.signJwt({ sub: staffId, kind: 'staff', role: 'super_admin', tv: 0 });

    // Verified track-record deals belong to the BORROWER, not the file, so a
    // section that measures a shortfall needs a borrower of its own — otherwise
    // the ten holds section E verifies would silently satisfy it.
    const mkBorrower = async (tag) => (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Studio',$2,$1) RETURNING id`,
      [`studioexp-${tag}-${sfx}@test.local`, tag])).rows[0].id;
    borrowerId = await mkBorrower('main');

    // A file with NO experience claimed — exactly the owner's starting state.
    const mkApp = async (status = 'underwriting', exp = [0, 0, 0], bid = borrowerId) => {
      const id = (await db.query(
        `INSERT INTO applications (borrower_id, loan_officer_id, status, loan_type, program, property_type,
                                   purchase_price, as_is_value, arv, rehab_budget, rehab_type, term,
                                   requested_exp_flips, requested_exp_holds, requested_exp_ground, property_address)
         VALUES ($1,$2,$3,'Purchase','standard','SFR (1 unit)',400000,400000,600000,80000,'Cosmetic','12 Months',$4,$5,$6,
                 '{"line1":"1 Studio St","city":"Newark","state":"NJ","zip":"07102"}'::jsonb)
         RETURNING id`, [bid, staffId, status, exp[0], exp[1], exp[2]])).rows[0].id;
      await require('../src/lib/conditions/ensure').ensureFileConditions(id, { reason: 'test' });
      return id;
    };
    const itemOf = async (appId, toolKey) => (await db.query(
      `SELECT id, status, is_required, tool_payload FROM checklist_items
        WHERE application_id=$1 AND tool_key=$2 ORDER BY created_at LIMIT 1`, [appId, toolKey])).rows[0];
    const expOf = async (appId) => (await db.query(
      `SELECT requested_exp_flips f, requested_exp_holds h, requested_exp_ground g FROM applications WHERE id=$1`,
      [appId])).rows[0];
    const stateUrl = (appId, itemId) => `/api/staff/applications/${appId}/checklist/${itemId}/tool-state`;
    // A completed, VERIFIED hold whose exit is inside the frozen 36-month window
    // (a hold exits on its rent/refi date — experience.js EXIT_DATE_SQL).
    let holdSeq = 0;
    const addVerifiedHold = async (n, bid = borrowerId) => {
      for (let i = 0; i < n; i++) {
        holdSeq++;
        const ins = await db.query(
          // The verification is a SEPARATE UPDATE, as production does it — db/485's guard
          // forbids a track record from being BORN verified, so asking for it in the
          // INSERT produced an unverified line and these VERIFIED-experience assertions
          // measured zero. A reviewer's click has always been an UPDATE.
          `INSERT INTO track_records (borrower_id, property_address, deal_type, rent_date)
           VALUES ($1, jsonb_build_object('line1', $2::text, 'city','Newark','state','NJ','zip','07102'),
                   'Fix & Hold (BRRRR)', CURRENT_DATE - INTERVAL '60 days')
           RETURNING id`,
          [bid, `${100 + holdSeq} Hold Ave`]);
        await db.query(
          `UPDATE track_records SET is_verified=true, verification_status='verified', verified_at=now() WHERE id=$1`,
          [ins.rows[0].id]);
      }
    };

    // ---------- A. THE BUG: nothing fed → nothing to verify ----------
    const appA = await mkApp();
    // The checklist GET is what recomputes the experience condition.
    await call(server, 'GET', `/api/staff/applications/${appA}/checklist`, tok);
    let trk = await itemOf(appA, 'track_record');
    assert(trk && trk.is_required === false,
      'A1 with no experience on the file the track-record condition is NOT required (the reported state)');
    assert(trk && trk.tool_payload && trk.tool_payload.notApplicable === true,
      'A2 …and it is stamped "no experience required on this file"');
    const signA = await call(server, 'PATCH', `/api/staff/checklist/${trk.id}`, tok, { signedOff: true });
    assert(signA.status === 200,
      `A3 …so it signs off with nothing verified — the bug (got ${signA.status})`);

    // ---------- B. The studio's 10 stabilized rentals feed the FILE ----------
    const appB = await mkApp();
    const pricingB = await itemOf(appB, 'product_pricing');
    const saveB = await call(server, 'PUT', stateUrl(appB, pricingB.id), tok,
      { state: studioState({ expBrrrr: '10' }) });
    assert(saveB.status === 200, `B1 the studio autosave is accepted (got ${saveB.status})`);
    let e = await expOf(appB);
    assert(e && Number(e.h) === 10,
      `B2 10 in "BRRRR / rentals stabilized" feeds the FILE as 10 holds, with no register (got ${e && e.h})`);
    assert(saveB.body && saveB.body.experienceClaim && saveB.body.experienceClaim.holds === 10,
      'B3 the save REPORTS the claim it fed (never a silent write)');
    assert(e && Number(e.f) === 0 && Number(e.g) === 0,
      'B4 the buckets the studio did not mention are untouched');
    const auditB = await db.query(
      `SELECT 1 FROM audit_log WHERE entity_id=$1::uuid AND action='studio_experience_claim'`, [appB]);
    assert(auditB.rows.length > 0, 'B5 the claim write is on the file\'s audit trail');

    // ---------- C + D. The condition requires it, and refuses sign-off ----------
    await call(server, 'GET', `/api/staff/applications/${appB}/checklist`, tok);
    trk = await itemOf(appB, 'track_record');
    assert(trk && trk.is_required === true,
      'C1 the track-record condition is now REQUIRED');
    assert(trk && trk.tool_payload && trk.tool_payload.notApplicable === false,
      'C2 …and no longer reads "no experience required"');
    assert(trk && trk.tool_payload && trk.tool_payload.gateNeed && trk.tool_payload.gateNeed.holds === 10,
      `C3 …and it shows the requirement as 10 holds (got ${trk && trk.tool_payload && JSON.stringify(trk.tool_payload.gateNeed)})`);

    const signB = await call(server, 'PATCH', `/api/staff/checklist/${trk.id}`, tok, { signedOff: true });
    assert(signB.status === 422, `D1 sign-off is REFUSED with nothing verified (got ${signB.status})`);
    const why = String((signB.body && signB.body.error) || '');
    assert(/10 hold/.test(why), `D2 the refusal names the 10 holds claimed — "${why}"`);
    assert(/Verify 10 more holds/.test(why), `D3 …and says exactly what to verify — "${why}"`);
    assert(!/Register a product first/.test(why),
      'D4 …and never dead-ends on "register a product first" (this is a track-record condition)');

    // ---------- E. Nine verified is still short; ten clears it ----------
    await addVerifiedHold(9);
    await call(server, 'GET', `/api/staff/applications/${appB}/checklist`, tok);
    trk = await itemOf(appB, 'track_record');
    const sign9 = await call(server, 'PATCH', `/api/staff/checklist/${trk.id}`, tok, { signedOff: true });
    assert(sign9.status === 422, `E1 nine VERIFIED holds is still short of ten (got ${sign9.status})`);
    assert(/Verify 1 more hold\b/.test(String((sign9.body && sign9.body.error) || '')),
      `E2 …and the shortfall counts down to 1 — "${(sign9.body && sign9.body.error) || ''}"`);
    await addVerifiedHold(1);
    await call(server, 'GET', `/api/staff/applications/${appB}/checklist`, tok);
    trk = await itemOf(appB, 'track_record');
    const sign10 = await call(server, 'PATCH', `/api/staff/checklist/${trk.id}`, tok, { signedOff: true });
    assert(sign10.status === 200,
      `E3 with all ten VERIFIED the condition signs off (got ${sign10.status} ${JSON.stringify(sign10.body)})`);

    // ---------- F. Blank states nothing; a typed 0 lowers ----------
    const appF = await mkApp('underwriting', [5, 5, 0]);
    const pricingF = await itemOf(appF, 'product_pricing');
    await call(server, 'PUT', stateUrl(appF, pricingF.id), tok, { state: studioState({ expFlips: '' }) });
    e = await expOf(appF);
    assert(Number(e.f) === 5, `F1 a BLANK studio field never zeroes a real claim (got ${e.f})`);
    await call(server, 'PUT', stateUrl(appF, pricingF.id), tok, { state: studioState({ expFlips: '0', expBrrrr: '5' }) });
    e = await expOf(appF);
    assert(Number(e.f) === 0, `F2 a typed 0 LOWERS the claim and sticks (got ${e.f})`);
    assert(Number(e.h) === 5, 'F3 …and an unchanged bucket stays put');

    // ---------- G. A frozen file is never written ----------
    const appG = await mkApp('funded', [2, 0, 0]);
    const pricingG = await itemOf(appG, 'product_pricing');
    const saveG = await call(server, 'PUT', stateUrl(appG, pricingG.id), tok,
      { state: studioState({ expFlips: '99' }) });
    assert(saveG.status === 200, 'G1 the autosave still succeeds on a frozen file (the draft is not the block)');
    e = await expOf(appG);
    assert(Number(e.f) === 2, `G2 …but a FUNDED file's experience claim is never rewritten by it (got ${e.f})`);
    assert(!saveG.body.experienceClaim, 'G3 …and the response does not claim it fed anything');

    // ---------- H. Only the pricing studio feeds experience ----------
    const appH = await mkApp('underwriting', [1, 0, 0]);
    const sow = await itemOf(appH, 'rehab_budget');
    if (sow) {
      await call(server, 'PUT', stateUrl(appH, sow.id), tok, { state: studioState({ expFlips: '42' }) });
      e = await expOf(appH);
      assert(Number(e.f) === 1, `H1 another tool's saved state never feeds the experience claim (got ${e.f})`);
    } else {
      assert(true, 'H1 skipped — no rehab_budget tool condition on this file');
    }
    // ---------- I. The GATE fix on its own ----------
    // A claim that came from the APPLICATION FORM, with nothing registered, used
    // to dead-end on "Register a product first" — advice nobody can act on from a
    // track-record condition. It must ask for the verification instead, and it
    // must still sign off once the claim IS verified without a registration (the
    // separate Products & Pricing condition is what requires one).
    borrowerI = await mkBorrower('gate');
    const appI = await mkApp('underwriting', [0, 3, 0], borrowerI);
    await call(server, 'GET', `/api/staff/applications/${appI}/checklist`, tok);
    let trkI = await itemOf(appI, 'track_record');
    const regRows = await db.query(
      `SELECT 1 FROM product_registrations WHERE application_id=$1 AND is_current`, [appI]);
    assert(regRows.rows.length === 0, 'I1 the file has no registered product (the isolating condition)');
    const signI = await call(server, 'PATCH', `/api/staff/checklist/${trkI.id}`, tok, { signedOff: true });
    assert(signI.status === 422, `I2 an unregistered file with a claim still blocks sign-off (got ${signI.status})`);
    const whyI = String((signI.body && signI.body.error) || '');
    assert(/Verify 3 more holds/.test(whyI), `I3 …asking for the verification, not a registration — "${whyI}"`);
    assert(!/Register a product first/.test(whyI), 'I4 …never the old dead-end advice');
    await addVerifiedHold(3, borrowerI);
    await call(server, 'GET', `/api/staff/applications/${appI}/checklist`, tok);
    trkI = await itemOf(appI, 'track_record');
    const signI2 = await call(server, 'PATCH', `/api/staff/checklist/${trkI.id}`, tok, { signedOff: true });
    assert(signI2.status === 200,
      `I5 …and a verified claim signs off without a registration (got ${signI2.status} ${JSON.stringify(signI2.body)})`);
  } catch (e) {
    console.error('FAIL unexpected error:', (e && e.stack) || e);
    failures++;
  } finally {
    for (const bid of [borrowerId, borrowerI].filter(Boolean)) {
      await db.query(`DELETE FROM track_records WHERE borrower_id=$1`, [bid]).catch(() => {});
      await db.query(`DELETE FROM applications WHERE borrower_id=$1`, [bid]).catch(() => {});
      await db.query(`DELETE FROM borrowers WHERE id=$1`, [bid]).catch(() => {});
    }
    if (staffId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [staffId]).catch(() => {});
    server.close();
    await db.pool.end().catch(() => {});
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})();
