#!/usr/bin/env node
'use strict';

/**
 * THE FILE AUDIT LOG + THE DOCUMENT DOSSIER, against a REAL Postgres.
 *
 * Owner-directed 2026-08-02. This exists because of a specific, repeated bug
 * class in this repo: BOTH surfaces read a couple of dozen side tables, and
 * BOTH deliberately guard every read so that one unreadable table shortens the
 * output instead of breaking the page. That guard is right in production and
 * lethal in testing — a query naming a column that does not exist reports
 * "nothing happened" rather than an error, forever, and no pure test can catch
 * it (a pure test mocks `db.query`, so it proves nothing about the schema).
 *
 * So: every query is run against a real database with the real migrations
 * applied, and a source that returns an error is a FAILURE here, even though it
 * is merely a shorter log in production.
 *
 * Skips (exit 0) when there is no DATABASE_URL, like every other *-db test.
 */
const assert = require('assert');

if (!process.env.DATABASE_URL) {
  console.log('SKIP test-file-audit-log-db — no DATABASE_URL');
  process.exit(0);
}

const db = require('../src/db');
const activity = require('../src/lib/activity');

let failures = 0;
const bad = (m) => { failures++; console.log(`  FAIL  ${m}`); };
const ok = (m) => console.log(`  ok    ${m}`);

const FAKE = '00000000-0000-0000-0000-0000000000ff';

(async () => {
  console.log('file audit log — every trail\'s SQL runs against the real schema');

  // ── 1. EVERY TRAIL RUNS, AND A BREAK NAMES ITSELF ───────────────────────
  // Each trail is run on its own so a failure says WHICH trail broke and on
  // which column, instead of "the log is a bit shorter than it should be".
  const TRAILS = activity._internals.TRAILS;
  assert.ok(Array.isArray(TRAILS) && TRAILS.length >= 10,
    `expected the trail table to be exported, found ${TRAILS && TRAILS.length}`);
  let checked = 0;
  for (const trail of TRAILS) {
    try { await activity._internals.trailEvents(FAKE, trail); checked++; }
    catch (e) { bad(`the "${trail.name}" trail does not run: ${e.message}`); }
  }
  if (checked === TRAILS.length) ok(`all ${checked} trails run against the real schema`);

  // ── 1b. THE FAN-OUT IS BOUNDED WELL UNDER THE CONNECTION POOL ──────────
  // The feed reads ~45 tables and the pool holds 10. A request that cannot get
  // a connection does not fail fast, it WAITS — this repo already has a
  // regression test for that exact incident. One person opening this tab must
  // never be able to stall the rest of the app.
  {
    const realQuery = db.query;
    let inFlight = 0; let peak = 0;
    db.query = function (...args) {
      inFlight++; peak = Math.max(peak, inFlight);
      return realQuery.apply(db, args).finally(() => { inFlight--; });
    };
    await activity.fileActivity(FAKE, false, { includeRequests: true });
    db.query = realQuery;
    if (peak > 8) bad(`the feed ran ${peak} queries at once — that is too close to the 10-connection pool`);
    else ok(`the fan-out peaked at ${peak} concurrent queries, well under the pool`);
  }

  // ── 2. THE WHOLE FEED, END TO END, REPORTS NO UNREADABLE SOURCE ─────────
  // staffFeed swallows a broken source and records it in the completeness row.
  // On a correct build that row must not exist at all.
  const rows = await activity.fileActivity(FAKE, false, { includeRequests: true });
  assert.ok(Array.isArray(rows), 'the feed must always be an array');
  const gap = rows.find((r) => r && r.source === 'meta');
  if (gap) bad(`the feed reports unreadable trails:\n        ${gap.label}`);
  else ok('every trail was readable — the feed reports no gap');

  // ── 3. THE COMPLETENESS ROW EXISTS AND LEADS, when a source IS broken ──
  // A silently short audit log is worse than one that says where the hole is,
  // so prove the guard actually reports rather than hides.
  const realQuery = db.query;
  let onlyOnce = true;
  db.query = function (...args) {
    if (onlyOnce && /FROM notifications/.test(String(args[0]))) { onlyOnce = false; return Promise.reject(new Error('boom')); }
    return realQuery.apply(db, args);
  };
  const broken = await activity.fileActivity(FAKE, false, {});
  db.query = realQuery;
  const meta = broken.find((r) => r && r.source === 'meta');
  if (!meta) bad('a broken trail was swallowed silently — the log claimed to be complete');
  else if (broken[0] !== meta) bad('the completeness warning was not the first row');
  else if (!/notifications/.test(meta.label)) bad(`the warning does not name the broken trail: ${meta.label}`);
  else ok('a broken trail is reported at the TOP, naming itself');

  // ── 4. THE BORROWER FEED IS STRUCTURALLY SEPARATE ───────────────────────
  // Widening the staff log must never be able to leak an internal action onto
  // a borrower screen, so the two paths may not share a query.
  const borrower = await activity.fileActivity(FAKE, true);
  assert.ok(Array.isArray(borrower), 'the borrower feed must always be an array');
  if (borrower.some((r) => r && r.source === 'meta')) bad('the borrower feed picked up the staff completeness row');
  else ok('the borrower feed is unchanged and carries no staff-only rows');

  // ── 5. THE DOSSIER'S QUERIES ARE VALID TOO ──────────────────────────────
  // Same class, same guard, same risk: pulled straight out of the route.
  const routeSrc = require('fs').readFileSync(require.resolve('../src/routes/staff.js'), 'utf8');
  const dossierBlock = routeSrc.slice(routeSrc.indexOf("router.get('/documents/:id/dossier'"),
    routeSrc.indexOf("router.get('/documents/:id/download'"));
  assert.ok(dossierBlock.length > 500, 'could not isolate the dossier route');
  // The route builds two of its queries with a template literal; resolve the
  // one interpolation so EVERY query is checked, not just the plain ones.
  const dq = [...dossierBlock.matchAll(/`(SELECT[\s\S]*?)`/g)].map((m) => m[1]
    .replace(/\$\{STAFF_NAME_SQL_DOSSIER\}/g, `NULLIF(s.full_name,'') AS pushed_by_name`));
  const unresolved = dq.filter((q) => /\$\{/.test(q));
  if (unresolved.length) bad(`${unresolved.length} dossier quer(y|ies) still carry an unresolved template — they are NOT being checked`);
  let dChecked = 0;
  for (const q of dq.filter((x) => !/\$\{/.test(x))) {
    const params = /\$2/.test(q) ? [FAKE, FAKE] : [FAKE];
    try { await db.query(q, params); dChecked++; }
    catch (e) { bad(`a dossier query does not run: ${e.message}\n        ${q.slice(0, 200).replace(/\s+/g, ' ')}…`); }
  }
  if (dChecked === dq.length) ok(`all ${dChecked} dossier queries run against the real schema`);

  // ── 6. THE INDEXES db/406 PROMISED ARE ACTUALLY THERE ───────────────────
  // The wide audit read scans an append-only table that is never pruned; if
  // the index silently failed to create, one tab becomes a table scan.
  const idx = await db.query(
    `SELECT indexname FROM pg_indexes WHERE indexname = ANY($1::text[])`,
    [['idx_audit_detail_application', 'idx_audit_entity_created', 'idx_req_audit_entity_id_at']]);
  const have = new Set(idx.rows.map((r) => r.indexname));
  for (const want of ['idx_audit_detail_application', 'idx_audit_entity_created', 'idx_req_audit_entity_id_at']) {
    if (!have.has(want)) bad(`db/406 did not create ${want}`);
  }
  if (have.size === 3) ok('the three audit-log indexes exist');

  // ── 7. THE IMPERSONATION COLUMNS THE FEED READS REALLY EXIST ────────────
  // This is the single biggest hole an audit log can have: without it, every
  // action a staffer takes inside a borrower-view session reads as the
  // borrower having done it themselves.
  const cols = await db.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE column_name IN ('impersonator_staff_id','impersonator_role')
        AND table_name IN ('audit_log','request_audit_log')`);
  const found = new Set(cols.rows.map((r) => `${r.table_name}.${r.column_name}`));
  for (const want of ['audit_log.impersonator_staff_id', 'request_audit_log.impersonator_staff_id']) {
    if (!found.has(want)) bad(`${want} is missing — impersonated actions would read as the borrower`);
  }
  if (found.has('audit_log.impersonator_staff_id') && found.has('request_audit_log.impersonator_staff_id')) {
    ok('the on-behalf-of columns exist on both audit tables');
  }

  // ── 8. THE WHOLE THING, THROUGH THE REAL HTTP DOORS, WITH REAL DATA ────
  // A query that runs is not the same as a surface that ANSWERS. This walks a
  // real document through a real condition and asserts the two screens say
  // what the owner asked them to say.
  process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
  const http = require('http');
  const C = require('../src/lib/crypto');
  const sfx = Date.now().toString(36);
  let server = null;
  try {
    const borrowerId = (await db.query(
      `INSERT INTO borrowers (email,first_name,last_name) VALUES ($1,'Dossier','Tester') RETURNING id`,
      [`dossier-${sfx}@test.local`])).rows[0].id;
    const staffId = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,'Dossier Admin','super_admin',true,false,'x',0) RETURNING id`,
      [`dossier-admin-${sfx}@test.local`])).rows[0].id;
    const appId = (await db.query(
      `INSERT INTO applications (borrower_id,status,property_address) VALUES ($1,'underwriting','{"line1":"1 Audit Way"}') RETURNING id`,
      [borrowerId])).rows[0].id;
    const itemId = (await db.query(
      `INSERT INTO checklist_items (scope,application_id,label,status,audience,item_kind,is_required,hint)
       VALUES ('application',$1,'Government photo ID','received','both','document',true,'A clear photo of the front and back.')
       RETURNING id`, [appId])).rows[0].id;
    const docId = (await db.query(
      `INSERT INTO documents (application_id,borrower_id,checklist_item_id,filename,content_type,size_bytes,
                              storage_provider,storage_ref,uploaded_by_kind,uploaded_by_id,slot_label,
                              source_type,visibility,review_status,rejection_reason,reviewed_by,reviewed_at,sha256)
       VALUES ($1,$2,$3,'drivers-license.pdf','application/pdf',204800,'local','x/y','borrower',$2,'Front',
               'borrower_upload','borrower','rejected','the back of the card is missing',$4,now(),'abc123')
       RETURNING id`, [appId, borrowerId, itemId, staffId])).rows[0].id;
    await db.query(
      `INSERT INTO audit_log (actor_kind,actor_id,action,entity_type,entity_id,detail)
       VALUES ('staff',$1,'reject_document','document',$2,'{"reason":"the back of the card is missing"}'::jsonb)`,
      [staffId, docId]);
    await db.query(
      `INSERT INTO audit_log (actor_kind,actor_id,action,entity_type,entity_id,detail)
       VALUES ('staff',$1,'edit_application','application',$2,
               '{"changes":{"purchase_price":{"from":100000,"to":125000}}}'::jsonb)`, [staffId, appId]);

    const app = require('../src/server');
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const sTok = C.signJwt({ sub: staffId, kind: 'staff', role: 'super_admin', tv: 0 });
    const call = (p) => new Promise((resolve, reject) => {
      const rq = http.request({ method: 'GET', path: p, port: server.address().port, host: '127.0.0.1',
        timeout: 15000, headers: { authorization: `Bearer ${sTok}` } },
        (res) => { let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => { let j = null; try { j = s ? JSON.parse(s) : null; } catch (_) { j = { _raw: s.slice(0, 300) }; } resolve({ status: res.statusCode, body: j }); }); });
      rq.on('timeout', () => { rq.destroy(); resolve({ status: 'timeout', body: null }); });
      rq.on('error', reject); rq.end();
    });

    // The documents LIST — the owner's actual complaint.
    const list = await call(`/api/staff/applications/${appId}/documents`);
    const d = (list.body || []).find((x) => x.id === docId);
    if (!d) bad(`the document list did not return the document (status ${list.status})`);
    else {
      if (d.title !== 'Government photo ID') bad(`the list row is not titled by its condition: ${d.title}`);
      else ok('the list row is titled by its condition, not "General upload"');
      if (!/Government photo ID/.test(d.where_label || '')) bad(`the list row does not say where it landed: ${d.where_label}`);
      else ok('the list row says which condition it was uploaded to');
      if (!d.purpose_headline) bad('the list row carries no purpose line');
      else ok('the list row carries a plain-language purpose');
      if (d.uploaded_by_name !== 'Dossier Tester') bad(`the uploader is not named: ${d.uploaded_by_name}`);
      else ok('the list names WHO uploaded it, not just "borrower"');
    }

    // The DOSSIER — where, why, and the full history.
    const dos = await call(`/api/staff/documents/${docId}/dossier`);
    if (dos.status !== 200) bad(`the dossier answered ${dos.status}`);
    else {
      const b = dos.body;
      if (b.placement.where !== 'condition') bad(`placement is wrong: ${b.placement.where}`);
      else ok('the dossier places it on its condition');
      if (!/front and back/i.test((b.purpose.asked || ''))) bad('the dossier does not quote what was actually asked for');
      else ok('the dossier quotes the exact words the borrower was shown');
      if (b.review.status !== 'rejected') bad(`review status is wrong: ${b.review.status}`);
      else ok('the dossier reports the rejection');
      const tl = b.timeline || [];
      if (!tl.some((e) => e.code === 'uploaded')) bad('the upload is missing from the history');
      else ok('the history keeps the upload');
      const rej = tl.find((e) => e.code === 'reject_document');
      if (!rej) bad('the rejection is missing from the history');
      else if (rej.actor !== 'Dossier Admin') bad(`the rejection does not name who did it: ${rej.actor}`);
      else if (!/back of the card is missing/.test(rej.detail || '')) bad('the rejection does not carry its reason');
      else ok('the history names WHO rejected it and WHY');
      if (tl.filter((e) => e.code === 'reject_document').length !== 1) bad('the rejection is double-counted');
      else ok('the audit row and the document row do not double-count the verdict');
      if (b.identity.uploadedBy !== 'Dossier Tester') bad(`the dossier does not name the uploader: ${b.identity.uploadedBy}`);
      else ok('the dossier names the uploader');
    }

    // The AUDIT LOG — the file's own trail, through the real route.
    const act = await call(`/api/staff/applications/${appId}/activity`);
    if (act.status !== 200) bad(`the audit log answered ${act.status}`);
    else {
      const rowsA = act.body || [];
      if (rowsA.some((r) => r.source === 'meta')) bad('the live audit log reports an unreadable trail');
      else ok('the audit log route answers with no unreadable trails');
      const up = rowsA.find((r) => /uploaded a document/.test(r.verb || ''));
      if (!up) bad('the audit log does not show the upload');
      else if (up.actor_name !== 'Dossier Tester') bad(`the upload does not name the uploader: ${up.actor_name}`);
      else if (!/Government photo ID/.test(up.label || '')) bad('the upload does not say which condition it went to');
      else ok('the audit log shows who uploaded what, and to which condition');
      const rj = rowsA.find((r) => /rejected a document/.test(r.verb || ''));
      if (!rj || rj.actor_name !== 'Dossier Admin') bad('the audit log does not show who rejected the document');
      else ok('the audit log shows who rejected it');
      const ed = rowsA.find((r) => /edited the application/.test(r.verb || ''));
      if (!ed || !/125,000|125000/.test(ed.label || '')) bad(`the audit log lost the field-level before/after: ${ed && ed.label}`);
      else ok('the audit log shows the exact before → after of a field change');
      if (!rowsA.some((r) => r.cat === 'condition')) bad('the audit log shows no condition activity');
      else ok('the audit log carries the condition trail');
    }

    // A staffer on no file may not read a document's dossier.
    const outsiderId = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,'Outsider','loan_officer',true,false,'x',0) RETURNING id`,
      [`dossier-out-${sfx}@test.local`])).rows[0].id;
    const oTok = C.signJwt({ sub: outsiderId, kind: 'staff', role: 'loan_officer', tv: 0 });
    const denied = await new Promise((resolve, reject) => {
      const rq = http.request({ method: 'GET', path: `/api/staff/documents/${docId}/dossier`,
        port: server.address().port, host: '127.0.0.1', timeout: 15000,
        headers: { authorization: `Bearer ${oTok}` } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      rq.on('error', reject); rq.end();
    });
    if (denied !== 403) bad(`a staffer not on the file could read the dossier (${denied})`);
    else ok('the dossier is refused to a staffer who is not on the file');
  } finally {
    if (server) await new Promise((r) => server.close(r));
  }

  console.log(failures ? `\n${failures} failure(s).` : '\nAll checks passed.');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
