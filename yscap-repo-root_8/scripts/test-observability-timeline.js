/**
 * #147 — the per-file observability timeline merges every event stream (portal
 * audit + outbound ClickUp writes + sync-review queue + SharePoint mirror) into
 * one time-ordered feed, scoped by the file's own access.
 *
 * Run: node scripts/test-observability-timeline.js
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://yscap:yscap@127.0.0.1:5432/yscap_test';
process.env.JWT_SECRET = 'test-secret-observability';
process.env.SSN_ENCRYPTION_KEY = 'test-ssn-key-for-verification-only-32bytes!!';
process.env.EMAIL_PROVIDER = 'none';
process.env.NODE_ENV = 'test';

const http = require('http');
const crypto = require('crypto');
const REPO = __dirname + '/..';
const db = require(REPO + '/src/db');
const C = require(REPO + '/src/lib/crypto.js');
const PORT = 5679;
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
  const LO = uuid(), OTHER = uuid(), B = uuid(), APP = uuid(), DOC = uuid();
  try {
    await db.query(`INSERT INTO staff_users (id,email,full_name,role,password_hash,is_active) VALUES ($1,$2,'OB Officer','loan_officer','x',true)`, [LO, `ob_${LO.slice(0, 8)}@x.test`]);
    await db.query(`INSERT INTO staff_users (id,email,full_name,role,password_hash,is_active) VALUES ($1,$2,'OB Other','loan_officer','x',true)`, [OTHER, `obo_${OTHER.slice(0, 8)}@x.test`]);
    await db.query(`INSERT INTO borrowers (id,first_name,last_name,email) VALUES ($1,'OB','Borrower',$2)`, [B, `obb_${B.slice(0, 8)}@x.test`]);
    await db.query(`INSERT INTO applications (id,borrower_id,loan_officer_id,status,source) VALUES ($1,$2,$3,'processing','portal')`, [APP, B, LO]);

    // One event in EACH stream, staggered in time (oldest → newest).
    await db.query(`INSERT INTO audit_log (actor_kind,actor_id,action,entity_type,entity_id,created_at) VALUES ('staff',$1,'update_application','application',$2, now() - interval '40 minutes')`, [LO, APP]);
    await db.query(`INSERT INTO clickup_write_log (application_id,task_id,field_key,changed,blocked,source,created_at) VALUES ($1,'T-1','status',true,false,'scoped_push', now() - interval '30 minutes')`, [APP]);
    await db.query(`INSERT INTO sync_review_queue (application_id,direction,field_key,reason,status,created_at) VALUES ($1,'inbound','date_of_birth','dob_disagrees','open', now() - interval '20 minutes')`, [APP]);
    await db.query(`INSERT INTO documents (id,application_id,filename,sharepoint_backed_up_at,sharepoint_verified_at,sharepoint_integrity) VALUES ($1,$2,'appraisal.pdf', now() - interval '10 minutes', now() - interval '9 minutes','ok')`, [DOC, APP]);
    // A guard-BLOCKED ClickUp write must also appear (nothing goes dark).
    await db.query(`INSERT INTO clickup_write_log (application_id,task_id,field_key,changed,blocked,source,created_at) VALUES ($1,'T-1','date_of_birth',false,true,'scoped_push', now() - interval '5 minutes')`, [APP]);

    const tok = C.signJwt({ sub: LO, kind: 'staff', role: 'loan_officer', tv: 0 });
    const otherTok = C.signJwt({ sub: OTHER, kind: 'staff', role: 'loan_officer', tv: 0 });

    // (1) the file's LO gets a merged, time-ordered feed across all 4 sources.
    let r = await api('GET', `/api/staff/applications/${APP}/observability`, null, tok);
    ok(r.status === 200 && r.body && Array.isArray(r.body.events), `observability 200 (got ${r.status})`);
    const ev = (r.body && r.body.events) || [];
    const srcs = new Set(ev.map(e => e.source));
    ok(srcs.has('portal'), 'feed includes a PORTAL event');
    ok(srcs.has('clickup'), 'feed includes a CLICKUP event');
    ok(srcs.has('sync'), 'feed includes a SYNC-review event');
    ok(srcs.has('sharepoint'), 'feed includes a SHAREPOINT event');
    ok(r.body.counts && r.body.counts.clickup === 2, `both ClickUp writes counted (got ${r.body.counts && r.body.counts.clickup})`);
    ok(ev.some(e => /BLOCKED/i.test(e.summary || '')), 'the guard-BLOCKED ClickUp write is surfaced (nothing goes dark)');

    // (2) newest-first ordering.
    const ordered = ev.every((e, i) => i === 0 || new Date(ev[i - 1].ts) >= new Date(e.ts));
    ok(ordered, 'events are time-ordered (newest first)');

    // (3) no raw values leak — the feed carries field KEYS + outcomes, not SSNs.
    ok(!JSON.stringify(r.body).match(/\d{3}-\d{2}-\d{4}/), 'no SSN-shaped value in the feed');

    // (4) sources filter narrows the feed.
    r = await api('GET', `/api/staff/applications/${APP}/observability?sources=sharepoint`, null, tok);
    ok(r.status === 200 && (r.body.events || []).every(e => e.source === 'sharepoint'), 'sources=sharepoint returns only SharePoint events');

    // (5) a staffer NOT on the file is denied (path scope).
    r = await api('GET', `/api/staff/applications/${APP}/observability`, null, otherTok);
    ok(r.status === 403 || r.status === 404, `off-file staffer is denied (got ${r.status})`);
  } catch (e) { fail++; console.log('  ✗ EXCEPTION', e && e.stack ? e.stack : e); }
  finally {
    await db.query(`DELETE FROM clickup_write_log WHERE application_id=$1`, [APP]).catch(() => {});
    await db.query(`DELETE FROM sync_review_queue WHERE application_id=$1`, [APP]).catch(() => {});
    await db.query(`DELETE FROM audit_log WHERE entity_id=$1`, [APP]).catch(() => {});
    await db.query(`DELETE FROM documents WHERE application_id=$1`, [APP]).catch(() => {});
    await db.query(`DELETE FROM applications WHERE id=$1`, [APP]).catch(() => {});
    await db.query(`DELETE FROM borrowers WHERE id=$1`, [B]).catch(() => {});
    await db.query(`DELETE FROM staff_users WHERE id IN ($1,$2)`, [LO, OTHER]).catch(() => {});
  }
  server.close();
  console.log(`\nobservability-timeline: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main();
