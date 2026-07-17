/**
 * #153 — public-lead bot-spam defense: form token (proof-of-page-visit + dwell),
 * honeypot, 30-day email+tool dedup, suppressed subscribe confirmation
 * (backscatter), and the admin bulk-archive cleanup. Bots get a fake 201 and
 * leave no row and no email.
 * Run: node scripts/test-leads-antispam.js
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://yscap:yscap@127.0.0.1:5432/yscap_test';
process.env.JWT_SECRET = 'test-secret-antispam';
process.env.EMAIL_PROVIDER = 'none';
process.env.NODE_ENV = 'test';
process.env.LEADS_TOKEN_MIN_MS = '50';       // human-dwell floor, shrunk for the test
process.env.LEADS_MX_CHECK = '0';            // no DNS in the test env

const http = require('http');
const crypto = require('crypto');
const REPO = __dirname + '/..';
const db = require(REPO + '/src/db');
const C = require(REPO + '/src/lib/crypto.js');
const PORT = 5683;
const uuid = () => crypto.randomUUID();
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function api(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
      res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? (() => { try { return JSON.parse(b); } catch { return b; } })() : null })); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
// Mirror of the server's signer, for crafting an EXPIRED token.
function signFormToken(ts) {
  return ts + '.' + crypto.createHmac('sha256', process.env.JWT_SECRET).update('leadform|' + ts).digest('hex').slice(0, 32);
}
const leadCount = async (email) => (await db.query(`SELECT count(*)::int AS n FROM leads WHERE email=$1`, [email])).rows[0].n;

async function main() {
  const app = require(REPO + '/src/server.js');
  const server = app.listen(PORT);
  await require(REPO + '/src/migrate-boot').ensureSchema();
  const tag = uuid().slice(0, 8);
  const E1 = `bot_${tag}@spam.test`, E2 = `hp_${tag}@spam.test`, E3 = `real_${tag}@ok.test`, E4 = `contact_${tag}@ok.test`;
  const ADMIN = uuid(), LO = uuid();
  try {
    // (1) subscribe WITHOUT a form token → fake-accepted, nothing stored.
    let r = await api('POST', '/api/leads', { tool: 'subscribe', email: E1 });
    ok(r.status === 201 && r.body.leadId == null, `tokenless subscribe fake-accepted (201, leadId null) — got ${r.status}/${r.body && r.body.leadId}`);
    ok((await leadCount(E1)) === 0, 'tokenless subscribe stored NO lead row');

    // (2) an EXPIRED token (a scraped page replayed days later) is dropped too.
    const old = signFormToken(String(Date.now() - 3 * 60 * 60 * 1000));
    r = await api('POST', '/api/leads', { tool: 'subscribe', email: E1, formToken: old });
    ok(r.status === 201 && r.body.leadId == null && (await leadCount(E1)) === 0, 'expired-token subscribe dropped');

    // (3) honeypot filled → dropped for ANY tool, even with a valid token.
    r = await api('GET', '/api/leads/token');
    ok(r.status === 200 && /^\d+\.[0-9a-f]{32}$/.test(r.body.t || ''), 'token endpoint issues a signed token');
    let tok = r.body.t;
    await sleep(80);
    r = await api('POST', '/api/leads', { tool: 'contact', email: E2, formToken: tok, website: 'http://spam.example' });
    ok(r.status === 201 && r.body.leadId == null && (await leadCount(E2)) === 0, 'honeypot-filled submission dropped (any tool)');

    // (4) a REAL subscribe (valid token, dwelled) stores the lead...
    r = await api('POST', '/api/leads', { tool: 'subscribe', email: E3, formToken: tok });
    ok(r.status === 201 && r.body.leadId, `real subscribe accepted (leadId ${r.body && String(r.body.leadId).slice(0, 8)}…)`);
    const realId = r.body.leadId;
    ok((await leadCount(E3)) === 1, 'real subscribe stored exactly one lead row');
    // ...but never emails the submitted address (backscatter suppression).
    let row = (await db.query(`SELECT emailed_submitter FROM leads WHERE id=$1`, [realId])).rows[0];
    ok(row && row.emailed_submitter !== true, 'subscribe sends NO confirmation to the submitted address (no backscatter)');

    // (5) the same email+tool again is deduped — same lead, no second row.
    r = await api('POST', '/api/leads', { tool: 'subscribe', email: E3, formToken: tok });
    ok(r.status === 201 && r.body.leadId === realId, 'duplicate subscribe returns the SAME lead (deduped)');
    ok((await leadCount(E3)) === 1, 'duplicate stored no second row');

    // (6) the real marketing tools keep working WITHOUT a token (unchanged).
    r = await api('POST', '/api/leads', { tool: 'contact', email: E4, name: 'Real Person' });
    ok(r.status === 201 && r.body.leadId, 'contact tool works without a token (non-subscribe tools unchanged)');

    // (7) bulk-archive: admin sweeps the junk; converted leads survive; LOs 403.
    await db.query(`INSERT INTO staff_users (id,email,full_name,role,password_hash,is_active) VALUES
      ($1,$2,'AS Admin','admin','x',true), ($3,$4,'AS LO','loan_officer','x',true)`,
      [ADMIN, `asadm_${tag}@x.test`, LO, `aslo_${tag}@x.test`]);
    await db.query(`UPDATE leads SET status='converted' WHERE id=$1`, [realId]);
    const admTok = C.signJwt({ sub: ADMIN, kind: 'staff', role: 'admin', tv: 0 });
    const loTok = C.signJwt({ sub: LO, kind: 'staff', role: 'loan_officer', tv: 0 });
    r = await api('POST', '/api/staff/leads/bulk-archive', { tool: 'subscribe' }, loTok);
    ok(r.status === 403, `bulk-archive is admin-only (LO got ${r.status})`);
    r = await api('POST', '/api/staff/leads/bulk-archive', {}, admTok);
    ok(r.status === 400, `bulk-archive with NO filter is refused (got ${r.status})`);
    r = await api('POST', '/api/staff/leads/bulk-archive', { tool: 'subscribe' }, admTok);
    ok(r.status === 200, `admin bulk-archive succeeds (archived ${r.body && r.body.archived})`);
    row = (await db.query(`SELECT status FROM leads WHERE id=$1`, [realId])).rows[0];
    ok(row.status === 'converted', 'a CONVERTED lead is never bulk-archived');
  } catch (e) { fail++; console.log('  ✗ EXCEPTION', e && e.stack ? e.stack : e); }
  finally {
    await db.query(`DELETE FROM leads WHERE email LIKE $1`, [`%_${tag}@%`]).catch(() => {});
    await db.query(`DELETE FROM audit_log WHERE action='leads_bulk_archive'`).catch(() => {});
    await db.query(`DELETE FROM staff_users WHERE id IN ($1,$2)`, [ADMIN, LO]).catch(() => {});
  }
  server.close();
  console.log(`\nleads-antispam: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main();
