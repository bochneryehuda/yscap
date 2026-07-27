/**
 * A super-admin UNLOCK of a Clear-to-Close file must actually let the file be
 * corrected (owner-reported 2026-07-27).
 *
 * Two freezes guard a file's structure (src/lib/file-lock.js): the STATUS freeze
 * (#84 — clear-to-close / funded / declined / withdrawn) and the TERM-SHEET-SENT
 * freeze (2026-07-22). The unlock only ever lifted the first one, and EVERY file
 * that reaches Clear to Close has a fully-signed ('completed') Term Sheet
 * package — so the second freeze kept refusing the write. Unlocking a cleared-
 * to-close file, changing the rehab type and adding an assignment fee, then
 * hitting Save did nothing; the 409 told you to "clear the Term Sheet package",
 * which on a CTC file would void a signed term sheet and reopen its conditions.
 *
 * What must hold:
 *   · CTC + signed term sheet, NOT unlocked      → frozen (both freezes intact)
 *   · CTC + signed term sheet, super_admin unlock → the correction SAVES
 *   · same unlocked file, a regular admin         → still frozen (super-only)
 *   · same unlocked file, no actor (borrower)     → still frozen
 *   · re-locked                                   → frozen again
 *   · BEFORE Clear to Close, term sheet in flight → still frozen even with the
 *     unlock column set: there the package is genuinely live and clearing it is
 *     the cheap, correct action (2026-07-22 rule untouched)
 *
 * Requires DATABASE_URL; skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-ctc-unlock-edit (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const http = require('http');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const lock = require('../src/lib/file-lock');
const app = require('../src/server');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
function call(server, method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, path, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  let superId, adminId, borrowerId;
  try {
    superId = (await db.query(`INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version) VALUES ($1,'Super','super_admin',true,false,'x',0) RETURNING id`, [`cue-super-${sfx}@test.local`])).rows[0].id;
    adminId = (await db.query(`INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version) VALUES ($1,'Admin','admin',true,false,'x',0) RETURNING id`, [`cue-admin-${sfx}@test.local`])).rows[0].id;
    const superTok = C.signJwt({ sub: superId, kind: 'staff', role: 'super_admin', tv: 0 });
    const adminTok = C.signJwt({ sub: adminId, kind: 'staff', role: 'admin', tv: 0 });
    const superActor = { kind: 'staff', role: 'super_admin', id: superId };
    const adminActor = { kind: 'staff', role: 'admin', id: adminId };
    borrowerId = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Cue','Test',$1) RETURNING id`, [`cue-bo-${sfx}@test.local`])).rows[0].id;

    // A cleared-to-close purchase, with the fully-signed Term Sheet package every
    // real CTC file carries.
    const appId = (await db.query(
      `INSERT INTO applications (borrower_id, loan_officer_id, status, loan_type, purchase_price, rehab_type, is_assignment)
       VALUES ($1,$2,'clear_to_close','Purchase',400000,'Cosmetic',false) RETURNING id`, [borrowerId, superId])).rows[0].id;
    await db.query(`INSERT INTO esign_envelopes (application_id, purpose, status) VALUES ($1,'term_sheet_package','completed')`, [appId]);

    const setLock = (tok, unlocked) => call(server, 'POST', `/api/staff/applications/${appId}/structural-lock`, tok, { unlocked, reason: 'correcting the rehab type' });
    const patch = (tok) => call(server, 'PATCH', `/api/staff/applications/${appId}/details`, tok,
      { rehabType: 'Heavy / gut rehab', isAssignment: true, underlyingContractPrice: '350000', assignmentFee: 50000 });
    const fileNow = async () => (await db.query(`SELECT rehab_type, is_assignment, assignment_fee FROM applications WHERE id=$1`, [appId])).rows[0];

    // ---- Still LOCKED until someone deliberately unlocks it --------------------
    const r0 = await patch(superTok);
    assert(r0.status === 409, 'clear-to-close + signed term sheet, not unlocked → PATCH /details is refused (409)');
    assert((await fileNow()).rehab_type === 'Cosmetic', 'the frozen rehab type did not change');

    // ---- The owner's exact sequence: unlock, then correct the file -------------
    assert((await setLock(superTok, true)).status === 200, 'a super_admin can unlock the cleared-to-close file');
    const r1 = await patch(superTok);
    assert(r1.status === 200, 'ONCE UNLOCKED the correction SAVES — it used to 409 on "clear the Term Sheet package"');
    const saved = await fileNow();
    assert(saved.rehab_type === 'Heavy / gut rehab', 'the new rehab type persisted');
    assert(saved.is_assignment === true && Number(saved.assignment_fee) === 50000, 'the assignment + its fee persisted');

    // ---- The unlock is SUPER-ADMIN-only, and never reaches the borrower --------
    assert(!!(await lock.structuralLockReason(appId, db, { actor: adminActor })),
      'the same unlocked file is still frozen for a regular admin (the unlock is super-admin-only)');
    assert((await call(server, 'PATCH', `/api/staff/applications/${appId}/details`, adminTok, { purchasePrice: 111111 })).status === 409,
      'a regular admin still gets a 409 on the unlocked file');
    assert(!!(await lock.structuralLockReason(appId, db)),
      'with NO actor (every borrower write path) the file stays frozen');

    // ---- Re-locking closes it again -------------------------------------------
    assert((await setLock(superTok, false)).status === 200, 'the super_admin can re-lock the file');
    assert((await patch(superTok)).status === 409, 're-locked → the editor is refused again');
    assert(!!(await lock.structuralLockReason(appId, db, { actor: superActor })), 're-locked → structuralLockReason is non-null for a super_admin');

    // ---- BEFORE Clear to Close nothing changed (2026-07-22 rule intact) --------
    // The package is genuinely in flight there and clearing + re-sending it is the
    // cheap, correct action — so even the unlock column must not open the file.
    await db.query(`UPDATE applications SET status='processing', structural_unlocked_at=now(), structural_unlocked_by=$2 WHERE id=$1`, [appId, superId]);
    await db.query(`UPDATE esign_envelopes SET status='sent' WHERE application_id=$1`, [appId]);
    const preCtc = await lock.structuralLockReason(appId, db, { actor: superActor });
    assert(!!preCtc && /clear the term sheet package/i.test(preCtc),
      'BEFORE Clear to Close a live term sheet still freezes the file — even for an unlocked super_admin — with the clear-the-package message');
    assert((await patch(superTok)).status === 409, 'pre-CTC + term sheet in flight → PATCH /details still refused');

    // …and the freeze still lifts the moment that package is actually cleared.
    await db.query(`UPDATE esign_envelopes SET status='voided' WHERE application_id=$1`, [appId]);
    assert((await lock.structuralLockReason(appId, db, { actor: superActor })) === null,
      'clearing (voiding) the package still lifts the term-sheet freeze on its own');

    console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL clear-to-close unlock assertions passed');
  } catch (e) {
    console.error('ERROR', e); failures++;
  } finally {
    try { if (borrowerId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]); } catch (_) {}
    try { if (superId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [superId]); } catch (_) {}
    try { if (adminId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [adminId]); } catch (_) {}
    server.close();
  }
  process.exit(failures ? 1 : 0);
})();
