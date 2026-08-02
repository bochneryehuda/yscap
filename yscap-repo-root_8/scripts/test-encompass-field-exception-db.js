'use strict';
/**
 * SUPER-ADMIN ENCOMPASS FIELD EXCEPTIONS (owner-directed 2026-08-02).
 *
 * "Add the capability for any field that does not match or has no data to
 *  compare — a staffer can REQUEST an exception and escalate it to a super admin,
 *  and the super admin can make an exception for that particular field so it
 *  doesn't need to match (never a real block; always a way around it)."
 *
 * The invariants this suite holds:
 *   1. A PENDING request does NOT clear the gate — only a super-admin GRANT does.
 *   2. Only a SUPER ADMIN may decide (grant/deny/revoke); the request route is
 *      file-scoped (an off-file staffer is refused).
 *   3. A granted field passes the term-sheet gate AND is removed from the tape's
 *      blocking set (both read the same computeFindings→summarize path).
 *   4. It AUTO-VOIDS: the moment the underlying value moves off the snapshot the
 *      field re-blocks — an exception can never paper over a NEW disagreement —
 *      and re-honours itself if the exact granted values return.
 *   5. Works for BOTH a "doesn't match" field AND a "no data to compare" field.
 *   6. A grant lands in the policy-exception register (born approved, record-only).
 *
 * PURE part (always runs): the type contract, the route wiring, the migration,
 * and the notify-map registration.
 *
 * DB part (runs only with DATABASE_URL): boots the real Express app and drives the
 * real endpoints over HTTP as a super-admin, an on-file loan officer, and an
 * off-file loan officer. Cleans up every row it creates.
 *
 *   node scripts/test-encompass-field-exception-db.js
 *   DATABASE_URL=postgres://… node scripts/test-encompass-field-exception-db.js
 */
// Env defaults MUST be set before the first require that loads config (the pure
// section requires loan-exceptions → db → config, which reads env at load time).
// Fake Encompass creds make `configured()` TRUE so the tape gate is MEANINGFUL — it
// reads the pulled loan out of encompass_extra (NO network), and the sync worker
// self-gates on ENCOMPASS_ENABLED (unset here), so nothing ever calls Encompass.
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
process.env.ENCOMPASS_CLIENT_ID = process.env.ENCOMPASS_CLIENT_ID || 'test-client';
process.env.ENCOMPASS_CLIENT_SECRET = process.env.ENCOMPASS_CLIENT_SECRET || 'test-secret';
process.env.ENCOMPASS_INSTANCE_ID = process.env.ENCOMPASS_INSTANCE_ID || 'test-instance';
const fs = require('fs');
const path = require('path');
const R = path.resolve(__dirname, '..');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// ───────────────────────── PURE: the type + write-fn contract ───────────────
(function pureContract() {
  const recon = require(R + '/src/encompass/reconcile');
  assert(typeof recon.requestException === 'function', 'reconcile.requestException is exported');
  assert(typeof recon.decideException === 'function', 'reconcile.decideException is exported');

  const LE = require(R + '/src/lib/loan-exceptions');
  assert(LE.isExceptionType('encompass_mismatch'), 'encompass_mismatch is a registered exception type');
  const cfg = LE.typeConfig('encompass_mismatch');
  assert(cfg && cfg.subject === 'file', 'encompass_mismatch is a file-subject type');
  assert(cfg && cfg.recordOnly === true, 'encompass_mismatch is record-only (born approved on the grant, never decided from the box)');
  assert(typeof LE.recordEncompassException === 'function', 'recordEncompassException is exported');
  // Composes with #945 — the tape override type is untouched and still present.
  assert(LE.isExceptionType('tape_encompass_override'), 'the #945 tape override type still exists (no clobber)');
})();

// ───────────────────────── PURE: route wiring (auth shape) ──────────────────
(function pureRoutes() {
  const src = fs.readFileSync(R + '/src/routes/staff.js', 'utf8');
  // The request route is file-scoped (mounted under /applications/:id) and carries
  // NO requireRole — any assigned staffer may ask.
  const reqLine = src.split('\n').find((l) => l.includes("'/applications/:id/encompass/request-exception'"));
  assert(!!reqLine && !/requireRole/.test(reqLine), 'request-exception is file-scoped, any staff (no requireRole on the route line)');
  // The decide route is super-admin only.
  const decLine = src.split('\n').find((l) => l.includes("'/applications/:id/encompass/decide-exception'"));
  assert(!!decLine && /requireRole\('super_admin'\)/.test(decLine), "decide-exception is guarded by requireRole('super_admin')");
  // The grant records into the register (best-effort).
  assert(/recordEncompassException/.test(src), 'the decide route records the grant into the exception register');
})();

// ───────────────────────── PURE: migration widens the CHECKs ────────────────
(function pureMigration() {
  const file = fs.readdirSync(R + '/db').find((f) => /encompass_field_exceptions\.sql$/.test(f));
  assert(!!file, 'the field-exceptions migration exists');
  const sql = fs.readFileSync(R + '/db/' + file, 'utf8');
  // resolution CHECK gains the two exception states alongside the originals.
  assert(/encompass_sync_resolutions_resolution_chk/.test(sql), 'it re-asserts the resolution CHECK');
  assert(/'exception_requested'/.test(sql) && /'excepted'/.test(sql), 'the resolution CHECK allows exception_requested + excepted');
  assert(/'replaced'/.test(sql) && /'accepted'/.test(sql), 'the resolution CHECK keeps the original replaced/accepted');
  // loan_exceptions type CHECK: full list, incl. our new value AND the lower-numbered
  // tape_encompass_override (db/397) — dropping that would violate an existing row.
  assert(/encompass_mismatch/.test(sql), 'the type CHECK adds encompass_mismatch');
  assert(/tape_encompass_override/.test(sql), 'the type CHECK preserves tape_encompass_override (db/397) — no rollback of a lower migration');
  assert(/loan_exceptions_status_check[\s\S]*'requested'[\s\S]*'expired'/.test(sql), 're-asserts the status CHECK verbatim (incl. expired)');
  // The boot's FINAL word on the type CHECK must preserve encompass_mismatch (the
  // db/388 rollback-collateral rule) — an invariant, not a fixed number, so a later
  // session's own type-CHECK migration is caught if it ever drops this value.
  const typeCheckFiles = fs.readdirSync(R + '/db')
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .filter((f) => /loan_exceptions_exception_type_check/.test(fs.readFileSync(R + '/db/' + f, 'utf8')));
  const highest = typeCheckFiles.sort((a, b) => parseInt(b, 10) - parseInt(a, 10))[0];
  assert(/encompass_mismatch/.test(fs.readFileSync(R + '/db/' + highest, 'utf8')),
    `the highest-numbered loan_exceptions type-CHECK migration (${highest}) preserves encompass_mismatch — it survives boot`);
})();

// ───────────────────────── PURE: notify maps + ExceptionCard ────────────────
(function pureNotify() {
  const src = fs.readFileSync(R + '/src/lib/notify.js', 'utf8');
  const req = (src.match(/encompass_exception:/g) || []).length;
  const dec = (src.match(/encompass_exception_decided:/g) || []).length;
  assert(req >= 2, 'encompass_exception appears in both notify maps (kicker + category)');
  assert(dec >= 2, 'encompass_exception_decided appears in both notify maps');
  const card = fs.readFileSync(R + '/app-v2/src/components/ExceptionCard.jsx', 'utf8');
  assert(/encompass_mismatch\s*:/.test(card), 'ExceptionCard has a TYPE_META entry for encompass_mismatch');
})();

// ───────────────────────── DB + HTTP: the lifecycle ─────────────────────────
if (!process.env.DATABASE_URL) {
  console.log('SKIP the DB/HTTP lifecycle (no DATABASE_URL)');
  console.log(failures ? `\n${failures} pure assertion(s) failed` : '\nAll pure assertions passed (DB/HTTP skipped)');
  process.exit(failures ? 1 : 0);
}

const http = require('http');
const db = require(R + '/src/db');
const C = require(R + '/src/lib/crypto');
const app = require(R + '/src/server');

function call(server, method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, path, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  let superId, loId, otherLoId, borrowerId, appId;
  try {
    const mkStaff = async (tag, role, name) => (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, mfa_enabled, password_hash, token_version)
       VALUES ($1,$2,$3,true,false,'x',0) RETURNING id`, [`encx-${tag}-${sfx}@test.local`, name, role])).rows[0].id;
    superId = await mkStaff('super', 'super_admin', 'Encx Super');
    loId = await mkStaff('onfile', 'loan_officer', 'Encx OnFile');
    otherLoId = await mkStaff('offfile', 'loan_officer', 'Encx OffFile');
    const sToken = C.signJwt({ sub: superId, kind: 'staff', role: 'super_admin', tv: 0 });
    const loToken = C.signJwt({ sub: loId, kind: 'staff', role: 'loan_officer', tv: 0 });
    const otherToken = C.signJwt({ sub: otherLoId, kind: 'staff', role: 'loan_officer', tv: 0 });

    borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email,date_of_birth,cell_phone)
         VALUES ('Enc','Except',$1,'1984-02-20','555-222-3344') RETURNING id`, [`encx-bo-${sfx}@test.local`])).rows[0].id;

    // A pulled Encompass loan that AGREES on everything (borrower identity + subject
    // address + economics) — so once we flip ONE field, that field is the sole blocker.
    const email = `encx-bo-${sfx}@test.local`;
    const loan = {
      baseLoanAmount: '525450.0000', purchasePriceAmount: '450500.0000',
      propertyAppraisedValueAmount: '750000.0000', loanAmortizationTermMonths: 12,
      requestedInterestRatePercent: '8.0', loanNumber: `YS-ENCX-${sfx}`,
      property: { propertyType: 'Single Family', financedNumberOfUnits: 2, streetAddress: '12 Main St', city: 'Brooklyn', state: 'NY', postalCode: '11230' },
      applications: [{
        borrower: { firstName: 'Enc', lastName: 'Except', birthDate: '1984-02-20', emailAddressText: email, mobilePhone: '(555) 222-3344' },
      }],
      customFields: [
        { fieldName: 'CX.REHABBUDGET', value: '120000.0000' },
        { fieldName: 'CX.ASISVALUE', value: '500000.0000' },
        { fieldName: 'CX.DEALPROJECTTYPE', value: 'Fix and Flip' },
        { fieldName: 'CX.ACCRUALTYPE', value: 'Drawn' },
      ],
    };
    appId = (await db.query(
      `INSERT INTO applications
         (borrower_id, loan_officer_id, ys_loan_number, property_address, units, program, loan_type,
          loan_amount, purchase_price, as_is_value, arv, rehab_budget, rate_pct, term,
          property_type, rehab_type, accrual_type, status, encompass_extra, encompass_last_pulled_at)
       VALUES ($1,$2,$3,'{"street":"12 Main St","city":"Brooklyn","state":"NY","zip":"11230"}'::jsonb, 2,
               'Fix & Flip w/ Construction','Purchase',
               525450, 450500, 500000, 750000, 120000, 8.0, '12',
               'SFR', 'Cosmetic', 'non_dutch', 'processing', $4::jsonb, now())
       RETURNING id`, [borrowerId, loId, `YS-ENCX-${sfx}`, JSON.stringify(loan)])).rows[0].id;

    const findings = async (token) => call(server, 'GET', `/api/staff/applications/${appId}/encompass/findings`, token);
    const fieldOf = (bodyStr, key) => (JSON.parse(bodyStr).fields || []).find((f) => f.key === key);
    const summaryOf = (bodyStr) => JSON.parse(bodyStr).summary;

    // 0. Flip purchase_price so it is the sole blocking mismatch.
    await db.query(`UPDATE applications SET purchase_price = 999999 WHERE id = $1`, [appId]);

    // 1. Baseline — the file is in Encompass, purchase_price blocks, gate not clear.
    let g = await findings(loToken);
    assert(g.status === 200, 'an on-file loan officer can read the Encompass findings');
    assert(fieldOf(g.body, 'purchase_price').status === 'mismatch', 'purchase_price is a mismatch (ours 999999 vs Encompass 450500)');
    assert(summaryOf(g.body).openBlockingKeys.includes('purchase_price'), 'purchase_price is in the blocking set');
    assert(summaryOf(g.body).clear === false, 'the section is not clear while a field mismatches');

    // 2. File scope — an OFF-file loan officer is refused (403) on the file's endpoints.
    assert((await findings(otherToken)).status === 403, 'an off-file loan officer is refused the findings (file scope)');
    assert((await call(server, 'POST', `/api/staff/applications/${appId}/encompass/request-exception`, otherToken,
      { fieldKey: 'purchase_price', reason: 'x' })).status === 403, 'an off-file loan officer cannot request an exception (file scope)');

    // 3. Request — validation + the request itself. A PENDING request does NOT clear.
    assert((await call(server, 'POST', `/api/staff/applications/${appId}/encompass/request-exception`, loToken,
      { fieldKey: 'purchase_price' })).status === 400, 'a request with no reason is refused (400)');
    const reqRes = await call(server, 'POST', `/api/staff/applications/${appId}/encompass/request-exception`, loToken,
      { fieldKey: 'purchase_price', reason: 'Encompass has the seller price; ours is the all-in — verified.' });
    assert(reqRes.status === 200 && JSON.parse(reqRes.body).ok === true, 'an on-file loan officer can request an exception');
    g = await findings(loToken);
    assert(fieldOf(g.body, 'purchase_price').exceptionRequested === true, 'the field shows a pending exception request');
    assert(fieldOf(g.body, 'purchase_price').excepted !== true, 'a pending request is NOT yet excepted');
    assert(summaryOf(g.body).openBlockingKeys.includes('purchase_price'), 'a PENDING request still blocks the gate');
    assert(summaryOf(g.body).clear === false, 'the section is still not clear on a pending request');

    // 4. Decide auth — only a super admin may decide; validation on the decision.
    assert((await call(server, 'POST', `/api/staff/applications/${appId}/encompass/decide-exception`, loToken,
      { fieldKey: 'purchase_price', decision: 'grant', reason: 'ok' })).status === 403, 'a loan officer cannot decide (super-admin only)');
    assert((await call(server, 'POST', `/api/staff/applications/${appId}/encompass/decide-exception`, sToken,
      { fieldKey: 'purchase_price', decision: 'sideways' })).status === 400, 'an unknown decision is refused (400)');
    assert((await call(server, 'POST', `/api/staff/applications/${appId}/encompass/decide-exception`, sToken,
      { fieldKey: 'purchase_price', decision: 'grant' })).status === 400, 'a grant with no reason is refused (400)');

    // 5. Grant — the field passes the gate; the register records it; a re-request is refused.
    const grant = await call(server, 'POST', `/api/staff/applications/${appId}/encompass/decide-exception`, sToken,
      { fieldKey: 'purchase_price', decision: 'grant', reason: 'Reviewed against the closing package — the difference is expected.' });
    assert(grant.status === 200 && JSON.parse(grant.body).ok === true, 'a super admin grants the exception');
    g = await findings(loToken);
    assert(fieldOf(g.body, 'purchase_price').excepted === true, 'the granted field is now excepted');
    assert(summaryOf(g.body).exceptedKeys.includes('purchase_price'), 'the field is reported in exceptedKeys');
    assert(!summaryOf(g.body).openBlockingKeys.includes('purchase_price'), 'the granted field is removed from the blocking set');

    const reg = (await db.query(
      `SELECT status, exception_type FROM loan_exceptions
        WHERE application_id=$1 AND exception_type='encompass_mismatch' ORDER BY created_at DESC LIMIT 1`, [appId])).rows[0];
    assert(!!reg && reg.status === 'approved', 'the grant lands in the policy-exception register, born approved');

    const reReq = await call(server, 'POST', `/api/staff/applications/${appId}/encompass/request-exception`, loToken,
      { fieldKey: 'purchase_price', reason: 'again' });
    assert(reReq.status === 400 && JSON.parse(reReq.body).reason === 'already_excepted', 'a request on an already-granted field is refused (already_excepted)');

    // 6. AUTO-VOID — move the value off the snapshot → the field re-blocks; restore → re-honoured.
    await db.query(`UPDATE applications SET purchase_price = 888888 WHERE id = $1`, [appId]);
    g = await findings(loToken);
    assert(fieldOf(g.body, 'purchase_price').excepted !== true, 'the exception auto-voids when the value moves off the snapshot');
    assert(summaryOf(g.body).openBlockingKeys.includes('purchase_price'), 'the field re-blocks after the value moves (never hides a NEW disagreement)');
    await db.query(`UPDATE applications SET purchase_price = 999999 WHERE id = $1`, [appId]);
    g = await findings(loToken);
    assert(fieldOf(g.body, 'purchase_price').excepted === true, 'restoring the exact granted values re-honours the exception (snapshot-hold)');

    // 7. Guard — a field that already MATCHES cannot be excepted.
    const onMatch = await call(server, 'POST', `/api/staff/applications/${appId}/encompass/request-exception`, loToken,
      { fieldKey: 'loan_amount', reason: 'unnecessary' });
    assert(onMatch.status === 400 && JSON.parse(onMatch.body).reason === 'already_passing', 'a matching field cannot be excepted (already_passing)');

    // 8. "NO DATA TO COMPARE" — the headline case. Remove Encompass's as-is value so
    //    as_is_value is incomparable (no data), then a super admin excepts it too.
    const loanNoAsIs = JSON.parse(JSON.stringify(loan));
    loanNoAsIs.customFields = loanNoAsIs.customFields.filter((c) => c.fieldName !== 'CX.ASISVALUE');
    await db.query(`UPDATE applications SET encompass_extra=$2::jsonb WHERE id=$1`, [appId, JSON.stringify(loanNoAsIs)]);
    g = await findings(loToken);
    assert(fieldOf(g.body, 'as_is_value').status === 'incomparable', 'as_is_value now reads "no data to compare" (Encompass value removed)');
    assert(summaryOf(g.body).openBlockingKeys.includes('as_is_value'), 'the no-data field blocks the gate');
    const grantAsIs = await call(server, 'POST', `/api/staff/applications/${appId}/encompass/decide-exception`, sToken,
      { fieldKey: 'as_is_value', decision: 'grant', reason: 'As-is confirmed on the appraisal; Encompass field not populated.' });
    assert(grantAsIs.status === 200, 'a super admin can except a "no data to compare" field too');
    g = await findings(loToken);
    assert(fieldOf(g.body, 'as_is_value').excepted === true, 'the no-data field is now excepted');
    assert(!summaryOf(g.body).openBlockingKeys.includes('as_is_value'), 'the excepted no-data field no longer blocks');

    // 8b. THE WAY AROUND THE BLOCK — except EVERY remaining blocking field and the
    //     term-sheet gate fully OPENS. This is the owner's core ask: a super admin can
    //     make a not-matching / no-data file issuable when nothing is left to reconcile.
    //     (The fixture leaves many Encompass field-number values unpopulated → naturally
    //     incomparable; excepting each proves the gate clears regardless of the field.)
    const recon = require(R + '/src/encompass/reconcile');
    assert((await recon.issuanceGate(appId)).block === true, 'with blockers still open, the issuance gate blocks');
    assert((await recon.tapeGate(appId)).block === true, 'with blockers still open, the tape gate blocks too (Encompass configured)');
    let guard = 0;
    for (;;) {
      const keys = summaryOf((await findings(loToken)).body).openBlockingKeys;
      if (!keys.length || guard++ > 60) break;
      for (const key of keys) {
        await call(server, 'POST', `/api/staff/applications/${appId}/encompass/decide-exception`, sToken,
          { fieldKey: key, decision: 'grant', reason: 'Reviewed — super-admin exception.' });
      }
    }
    g = await findings(loToken);
    assert(summaryOf(g.body).clear === true, 'once every field is matched or excepted, the section is CLEAR');
    assert(summaryOf(g.body).openBlockingKeys.length === 0, 'nothing is left in the blocking set');
    assert((await recon.issuanceGate(appId)).block === false, 'the term-sheet issuance gate now passes');
    assert((await recon.tapeGate(appId)).block === false, 'the tape export gate now passes too (same isClear path)');

    // 9. REVOKE — a super admin can remove a granted exception; the field re-blocks AND
    //    the gate closes again (the exception is genuinely what was holding it open).
    const revoke = await call(server, 'POST', `/api/staff/applications/${appId}/encompass/decide-exception`, sToken,
      { fieldKey: 'purchase_price', decision: 'revoke' });
    assert(revoke.status === 200, 'a super admin can revoke a granted exception');
    g = await findings(loToken);
    assert(fieldOf(g.body, 'purchase_price').excepted !== true, 'the revoked field is no longer excepted');
    assert(summaryOf(g.body).openBlockingKeys.includes('purchase_price'), 'the revoked field blocks the gate again');
    assert(summaryOf(g.body).clear === false, 'revoking one exception closes the gate again');
    assert((await recon.issuanceGate(appId)).block === true, 'the issuance gate blocks again after the revoke');

    console.log(failures ? `\n${failures} assertion(s) failed` : '\nAll Encompass field-exception assertions passed');
  } catch (e) {
    console.error('ERROR', e); failures++;
  } finally {
    // Clean up every row this run created, in dependency order. applications.borrower_id
    // is ON DELETE RESTRICT, so the APPLICATION must go before the borrower; and the app
    // holds loan_officer_id, so it must go before the staff. encompass_sync_resolutions
    // cascades off the application (db/311); loan_exceptions + notifications are cleared
    // explicitly (they only SET NULL / do not cascade the app away).
    try { if (appId) await db.query(`DELETE FROM loan_exceptions WHERE application_id=$1`, [appId]); } catch (_) {}
    try { if (appId) await db.query(`DELETE FROM notifications WHERE application_id=$1`, [appId]); } catch (_) {}
    try { if (appId) await db.query(`DELETE FROM applications WHERE id=$1`, [appId]); } catch (_) {}
    try { if (borrowerId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]); } catch (_) {}
    for (const id of [superId, loId, otherLoId]) { try { if (id) await db.query(`DELETE FROM staff_users WHERE id=$1`, [id]); } catch (_) {} }
    server.close();
  }
  process.exit(failures ? 1 : 0);
})();
