/**
 * #137 — staff (and borrower) can EDIT a file contact in place, not only remove.
 * Run: node scripts/test-contact-edit.js
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://yscap:yscap@127.0.0.1:5432/yscap_test';
process.env.JWT_SECRET = 'test-secret-contact';
process.env.EMAIL_PROVIDER = 'none';
process.env.NODE_ENV = 'test';

const http = require('http');
const crypto = require('crypto');
const REPO = __dirname + '/..';
const db = require(REPO + '/src/db');
const C = require(REPO + '/src/lib/crypto.js');
const PORT = 5641;
const uuid = () => crypto.randomUUID();
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL', m); } };
function api(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
      res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? (() => { try { return JSON.parse(b); } catch { return b; } })() : null })); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

async function main() {
  const app = require(REPO + '/src/server.js');
  const server = app.listen(PORT);
  await require(REPO + '/src/migrate-boot').ensureSchema();
  const B = uuid(), APP = uuid(), ADMIN = uuid();
  try {
    await db.query(`INSERT INTO staff_users (id,email,full_name,role,password_hash,is_active) VALUES ($1,$2,'CE Admin','admin','x',true)`, [ADMIN, `ce_${ADMIN.slice(0, 8)}@x.test`]);
    await db.query(`INSERT INTO borrowers (id,first_name,last_name,email) VALUES ($1,'CE','Borrower',$2)`, [B, `ceb_${B.slice(0, 8)}@x.test`]);
    await db.query(`INSERT INTO applications (id,borrower_id,loan_officer_id) VALUES ($1,$2,$3)`, [APP, B, ADMIN]);
    const tok = C.signJwt({ sub: ADMIN, kind: 'staff', role: 'admin', tv: 0 });

    // Add a title contact with a typo.
    let r = await api('POST', `/api/staff/applications/${APP}/file-contacts`, { contactType: 'title_company', companyName: 'Titel Co', email: 'wrong@x.test', phone: '5551234567' }, tok);
    ok(r.status === 201 && r.body.linkId, `add contact (got ${r.status})`);
    const linkId = r.body.linkId;

    // Edit it — fix the company name + email.
    r = await api('PATCH', `/api/staff/file-contacts/${linkId}`, { contactType: 'title_company', companyName: 'Title Co LLC', contactName: 'Jane Doe', email: 'jane@title.test', phone: '5559998888' }, tok);
    ok(r.status === 200, `edit contact returns 200 (got ${r.status}: ${JSON.stringify(r.body).slice(0, 100)})`);

    // Re-fetch and confirm persistence.
    r = await api('GET', `/api/staff/applications/${APP}/file-contacts`, null, tok);
    const c = (r.body || []).find(x => x.link_id === linkId);
    ok(c && c.company_name === 'Title Co LLC' && c.email === 'jane@title.test' && c.contact_name === 'Jane Doe', `edit PERSISTED (company=${c && c.company_name}, email=${c && c.email})`);

    // Empty edit is refused.
    r = await api('PATCH', `/api/staff/file-contacts/${linkId}`, { contactType: 'title_company' }, tok);
    ok(r.status === 400, `empty edit refused (got ${r.status})`);

    // Unknown link 404s.
    r = await api('PATCH', `/api/staff/file-contacts/${uuid()}`, { companyName: 'X' }, tok);
    ok(r.status === 404, `unknown contact 404s (got ${r.status})`);
  } catch (e) { fail++; console.log('  ✗ EXCEPTION', e && e.stack ? e.stack : e); }
  finally {
    await db.query(`DELETE FROM application_service_contacts WHERE application_id=$1`, [APP]).catch(() => {});
    await db.query(`DELETE FROM service_contacts WHERE borrower_id=$1`, [B]).catch(() => {});
    await db.query(`DELETE FROM applications WHERE id=$1`, [APP]).catch(() => {});
    await db.query(`DELETE FROM borrowers WHERE id=$1`, [B]).catch(() => {});
    await db.query(`DELETE FROM staff_users WHERE id=$1`, [ADMIN]).catch(() => {});
  }
  server.close();
  console.log(`\ncontact-edit: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main();
