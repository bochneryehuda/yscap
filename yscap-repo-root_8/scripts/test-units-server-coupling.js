/**
 * Units are coupled to property_type on the SERVER write paths too, not just the
 * intake forms (src/lib/units.js unitsForPropertyType).
 *
 * The borrower completeness panel (POST /borrower/applications/:id/complete-fields)
 * doesn't collect units at all, and the staff PATCH /applications/:id/details can
 * be called with property_type but no units. Both must still behave like the form:
 * a single-family type auto-fills "1 unit"; switching to a multi type drops a stale
 * single "1"; an unknown ("open") type is left alone.
 *
 * Pure assertions always run; the HTTP portion needs DATABASE_URL (skips otherwise).
 */
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const { unitsForPropertyType, unitsMode } = require('../src/lib/units');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// ---- pure ----
assert(unitsMode('SFR') === 'single' && unitsMode('New Construction') === 'open', 'unitsMode mirrors the frontend');
assert(unitsForPropertyType('SFR', 3) === 1, 'single-family forces 1 unit');
assert(unitsForPropertyType('Multi 2-4', 1) === null, 'switching to multi drops a stale single "1"');
assert(unitsForPropertyType('Multi 2-4', 3) === 3, 'multi keeps a real count');
assert(unitsForPropertyType('New Construction', 4) === 4, 'unknown type keeps its count');
assert(unitsForPropertyType('', 3) === 3, 'blank type leaves units alone');

(async () => {
  if (!process.env.DATABASE_URL) {
    console.log('SKIP http portion (no DATABASE_URL)');
    console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL units-server-coupling (pure) assertions passed');
    process.exit(failures ? 1 : 0);
  }
  const http = require('http');
  const db = require('../src/db');
  const C = require('../src/lib/crypto');
  const app = require('../src/server');
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const call = (method, path, token, body) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, path, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
  const unitsOf = async (id) => (await db.query(`SELECT units FROM applications WHERE id=$1`, [id])).rows[0].units;
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  let borrowerId, staffId;
  try {
    // --- borrower completeness panel ---
    borrowerId = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('U','C',$1) RETURNING id`, [`uc-bo-${sfx}@test.local`])).rows[0].id;
    await db.query(`INSERT INTO borrower_auth (borrower_id,password_hash,token_version) VALUES ($1,'x',0)`, [borrowerId]);
    const boTok = C.signJwt({ sub: borrowerId, kind: 'borrower', role: 'borrower', tv: 0 });
    const appId = (await db.query(`INSERT INTO applications (borrower_id, status, property_type, units) VALUES ($1,'processing','Multi 2-4',3) RETURNING id`, [borrowerId])).rows[0].id;

    let r = await call('POST', `/api/borrower/applications/${appId}/complete-fields`, boTok, { property_type: 'SFR' });
    assert(r.status >= 200 && r.status < 300, 'complete-fields SFR accepted');
    assert((await unitsOf(appId)) === 1, 'completeness: switching to SFR auto-fills 1 unit');

    await call('POST', `/api/borrower/applications/${appId}/complete-fields`, boTok, { property_type: 'Multi 2-4' });
    assert((await unitsOf(appId)) === null, 'completeness: switching back to Multi 2-4 drops the stale single "1"');

    // --- staff PATCH details ---
    staffId = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, mfa_enabled, password_hash, token_version)
       VALUES ($1,'U C Admin','super_admin',true,false,'x',0) RETURNING id`, [`uc-admin-${sfx}@test.local`])).rows[0].id;
    const stTok = C.signJwt({ sub: staffId, kind: 'staff', role: 'super_admin', tv: 0 });
    const appId2 = (await db.query(`INSERT INTO applications (borrower_id, status, property_type, units) VALUES ($1,'processing','Multi 2-4',3) RETURNING id`, [borrowerId])).rows[0].id;

    await call('PATCH', `/api/staff/applications/${appId2}/details`, stTok, { propertyType: 'SFR' });
    assert((await unitsOf(appId2)) === 1, 'staff PATCH: property_type→SFR with no units sent auto-fills 1 unit');

    await call('PATCH', `/api/staff/applications/${appId2}/details`, stTok, { propertyType: 'New Construction' });
    assert((await unitsOf(appId2)) === 1, 'staff PATCH: an unknown (open) type leaves units untouched');

    console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL units-server-coupling assertions passed');
  } catch (e) {
    console.error('ERROR', e); failures++;
  } finally {
    try { if (borrowerId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]); } catch (_) {}
    try { if (staffId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [staffId]); } catch (_) {}
    server.close();
  }
  process.exit(failures ? 1 : 0);
})();
