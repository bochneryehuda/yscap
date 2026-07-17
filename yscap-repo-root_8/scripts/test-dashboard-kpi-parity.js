/**
 * #145 — every dashboard KPI / exception tile drills into EXACTLY the files it
 * counts. Proves the count that renders a figure and the list its click applies
 * use the SAME predicate (the shared DASH_FILTER_SQL), so a figure can never show
 * a number you can't reproduce by clicking it.
 *
 * Core invariant tested for every flag: endpoint COUNT === filtered LIST length.
 * Plus targeted boundary checks for the two bugs this fixed:
 *   - stalled: >7 days (was drilling to >5), and
 *   - newintake: excludes clickup_backfill rows (a plain createdFrom did not).
 *
 * Run: node scripts/test-dashboard-kpi-parity.js
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://yscap:yscap@127.0.0.1:5432/yscap_test';
process.env.JWT_SECRET = 'test-secret-kpi-parity';
process.env.SSN_ENCRYPTION_KEY = 'test-ssn-key-for-verification-only-32bytes!!';
process.env.EMAIL_PROVIDER = 'none';
process.env.NODE_ENV = 'test';

const http = require('http');
const crypto = require('crypto');
const REPO = __dirname + '/..';
const db = require(REPO + '/src/db');
const C = require(REPO + '/src/lib/crypto.js');
const PORT = 5673;
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
const ids = [];
async function mkApp({ status = 'processing', officer = null, createdDaysAgo = 0, updatedDaysAgo = 0, source = 'portal' }) {
  const id = uuid(); ids.push(id);
  const b = uuid(); ids.push('b:' + b);
  await db.query(`INSERT INTO borrowers (id,first_name,last_name,email) VALUES ($1,'KP','Borrower',$2)`, [b, `kp_${b.slice(0, 8)}@x.test`]);
  await db.query(
    `INSERT INTO applications (id,borrower_id,loan_officer_id,status,source,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5, now() - ($6 || ' days')::interval, now() - ($7 || ' days')::interval)`,
    [id, b, officer, status, source, String(createdDaysAgo), String(updatedDaysAgo)]);
  return id;
}
async function addItem(appId, { audience = 'borrower', status = 'outstanding' }) {
  await db.query(`INSERT INTO checklist_items (application_id,scope,label,audience,status) VALUES ($1,'application','Item',$2,$3)`, [appId, audience, status]);
}

async function main() {
  const app = require(REPO + '/src/server.js');
  const server = app.listen(PORT);
  await require(REPO + '/src/migrate-boot').ensureSchema();
  const ADMIN = uuid();
  try {
    await db.query(`INSERT INTO staff_users (id,email,full_name,role,password_hash,is_active) VALUES ($1,$2,'KP Admin','super_admin','x',true)`, [ADMIN, `kp_admin_${ADMIN.slice(0, 8)}@x.test`]);
    const tok = C.signJwt({ sub: ADMIN, kind: 'staff', role: 'super_admin', tv: 0 });

    // --- seed one file per flag (+ the two boundary negatives) ---
    const fUnassigned = await mkApp({ status: 'processing', officer: null });
    const fIssue = await mkApp({ officer: ADMIN }); await addItem(fIssue, { status: 'issue' });
    const fReceived = await mkApp({ officer: ADMIN }); await addItem(fReceived, { status: 'received' });
    const fAwaitBorr = await mkApp({ officer: ADMIN }); await addItem(fAwaitBorr, { audience: 'borrower', status: 'outstanding' });
    const fOpenCond = await mkApp({ officer: ADMIN });
    await db.query(`INSERT INTO conditions (application_id,title,status) VALUES ($1,'Cond','open')`, [fOpenCond]);
    const fUnread = await mkApp({ officer: ADMIN });
    await db.query(`INSERT INTO messages (application_id,channel,sender_kind,body,read_at) VALUES ($1,'borrower','borrower','hi',NULL)`, [fUnread]);
    const fPostClose = await mkApp({ status: 'funded', officer: ADMIN });
    await db.query(`INSERT INTO post_closing_items (application_id,code,label,status) VALUES ($1,'note','Note','exception')`, [fPostClose]);
    const fStalled = await mkApp({ officer: ADMIN, updatedDaysAgo: 8 });   // > 7 days → stalled
    const fFreshUpd = await mkApp({ officer: ADMIN, updatedDaysAgo: 6 });  // 6 days → NOT stalled (was 5-day bug)
    const fNewIntake = await mkApp({ officer: ADMIN, createdDaysAgo: 1, source: 'portal' });
    const fBackfill = await mkApp({ officer: ADMIN, createdDaysAgo: 1, source: 'clickup_backfill' }); // NOT a new intake

    const listIds = async (flag) => {
      const r = await api('GET', `/api/staff/applications?flag=${flag}&limit=1000`, null, tok);
      return (r.body || []).map(x => x.id);
    };

    // --- exception-strip flags: /exceptions count === list length (the #145 invariant) ---
    const exc = (await api('GET', '/api/staff/exceptions', null, tok)).body;
    for (const key of ['unassigned', 'needs_correction', 'awaiting_borrower', 'awaiting_review', 'unread_messages', 'open_conditions', 'post_closing_exceptions']) {
      const list = await listIds(key);
      ok(exc[key] === list.length, `exception "${key}": count ${exc[key]} === drilled list ${list.length}`);
    }

    // --- KPI-grid flags: /dashboard count === list length ---
    const dash = (await api('GET', '/api/staff/dashboard', null, tok)).body;
    const stalledList = await listIds('stalled');
    ok(dash.stalled === stalledList.length, `KPI "stalled": count ${dash.stalled} === drilled list ${stalledList.length}`);
    const newList = await listIds('newintake');
    ok(dash.newThisWeek === newList.length, `KPI "New this week": count ${dash.newThisWeek} === drilled list ${newList.length}`);

    // --- targeted membership: each seeded file drills into the RIGHT flag ---
    ok((await listIds('unassigned')).includes(fUnassigned), 'unassigned file appears in flag=unassigned');
    ok((await listIds('needs_correction')).includes(fIssue), 'issue file appears in flag=needs_correction');
    ok((await listIds('awaiting_review')).includes(fReceived), 'received file appears in flag=awaiting_review');
    ok((await listIds('awaiting_borrower')).includes(fAwaitBorr), 'borrower-outstanding file appears in flag=awaiting_borrower');
    ok((await listIds('open_conditions')).includes(fOpenCond), 'open-condition file appears in flag=open_conditions');
    ok((await listIds('unread_messages')).includes(fUnread), 'unread-message file appears in flag=unread_messages');
    ok((await listIds('post_closing_exceptions')).includes(fPostClose), 'post-closing file appears in flag=post_closing_exceptions');

    // --- the two BUGS this fixed ---
    const st = await listIds('stalled');
    ok(st.includes(fStalled), 'stalled (8 days) file IS in flag=stalled');
    ok(!st.includes(fFreshUpd), 'a 6-day-idle file is NOT in flag=stalled (7-day boundary, not 5)');
    const ni = await listIds('newintake');
    ok(ni.includes(fNewIntake), 'a real intake this week IS in flag=newintake');
    ok(!ni.includes(fBackfill), 'a clickup_backfill row this week is NOT in flag=newintake');
  } catch (e) { fail++; console.log('  ✗ EXCEPTION', e && e.stack ? e.stack : e); }
  finally {
    for (const id of ids) {
      if (String(id).startsWith('b:')) continue;
    }
    // clean up children then apps/borrowers
    const appIds = ids.filter(i => !String(i).startsWith('b:'));
    const borIds = ids.filter(i => String(i).startsWith('b:')).map(i => i.slice(2));
    for (const a of appIds) {
      await db.query(`DELETE FROM checklist_items WHERE application_id=$1`, [a]).catch(() => {});
      await db.query(`DELETE FROM conditions WHERE application_id=$1`, [a]).catch(() => {});
      await db.query(`DELETE FROM messages WHERE application_id=$1`, [a]).catch(() => {});
      await db.query(`DELETE FROM post_closing_items WHERE application_id=$1`, [a]).catch(() => {});
      await db.query(`DELETE FROM applications WHERE id=$1`, [a]).catch(() => {});
    }
    for (const b of borIds) await db.query(`DELETE FROM borrowers WHERE id=$1`, [b]).catch(() => {});
    await db.query(`DELETE FROM staff_users WHERE id=$1`, [ADMIN]).catch(() => {});
  }
  server.close();
  console.log(`\ndashboard-kpi-parity: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main();
