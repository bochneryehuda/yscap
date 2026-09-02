/**
 * THE LOAN OFFICER ASSISTANT — proven over real HTTP against a real database.
 *
 * Owner-directed 2026-09-02, short-term side: *"a new role, which is Loan Officer
 * Assistant, a back-office role, but you should have the same personas and the
 * same permissions as a loan officer, not the permissions of a processor. You
 * should not be able to be added as a processor on the file. You should be able
 * to be added as a Loan Officer Assistant on a file."*
 *
 * The pure half (scripts/test-loan-officer-assistant-pure.mjs) pins the
 * registry, the permissions, the front-end mirror and the migration's SQL to
 * each other. THIS half proves the rules where they actually bite — the routes,
 * with the real scoping SQL, on rows the constraints of db/672 have to accept:
 *
 *   (0) the database accepts the role and still refuses an unregistered one;
 *   (a) an assistant on no file is refused the file (no see_all_files);
 *   (b) THE ONE THAT MATTERS: they cannot be added as a PROCESSOR — not in the
 *       processor slot, not as the processor pointer — while a real processor
 *       still can (the rule is the role match, not the slot);
 *   (c) they CAN be added as a loan officer assistant, in their own slot, never
 *       as a primary, and the team rail shows them there;
 *   (d) once seated they open THAT file and only that file, and their pipeline
 *       lists it;
 *   (e) the weekly officer pipeline email reaches them (owner-directed 2026-09-02) —
 *       and not the processor seated on the same file: the audience is the
 *       loan-officer persona, not "anyone on a file";
 *   (f) an admin's file grant seats them in their own slot, never the processor
 *       bucket, and revoking it closes the door again;
 *   (g) a file an assistant CREATES stays reachable to them: seated as the
 *       assistant, never made the officer of record (an officer creating a file
 *       is, and gets no assistant row — the control);
 *   (h) removing them from a file removes their access;
 *   (i) their dashboard home is the loan officer's "My dashboard" (persona),
 *       while a processor's is still "My work".
 *
 * Self-skips without a DATABASE_URL, like every other *-db suite here.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-loan-officer-assistant-db (no DATABASE_URL)'); process.exit(0); }
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-loa';
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.EMAIL_PROVIDER = 'none';
process.env.NODE_ENV = 'test';

const http = require('http');
const crypto = require('crypto');
const REPO = __dirname + '/..';
const db = require(REPO + '/src/db');
const C = require(REPO + '/src/lib/crypto.js');
const uuid = () => crypto.randomUUID();

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL', m); } };
const short = (b) => { try { return JSON.stringify(b).slice(0, 160); } catch (_) { return String(b); } };

function api(server, method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token,
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
      res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? (() => { try { return JSON.parse(b); } catch { return b; } })() : null })); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  const app = require(REPO + '/src/server.js');
  await require(REPO + '/src/migrate-boot').ensureSchema();
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));

  const LO = uuid(), LOA = uuid(), PROC = uuid(), ADMIN = uuid();
  const B = uuid(), APP = uuid(), APP2 = uuid();
  const tag = LOA.slice(0, 8);
  const tok = (id, role) => C.signJwt({ sub: id, kind: 'staff', role, tv: 0 });
  const madeApps = [APP, APP2];
  const madeBorrowers = [B];
  const addr = (line1) => JSON.stringify({ line1, city: 'Lakewood', state: 'NJ', zip: '08701', oneLine: `${line1}, Lakewood, NJ 08701` });

  try {
    // ---- (0) the database accepts the role --------------------------------
    await db.query(`INSERT INTO staff_users (id,email,full_name,role,password_hash,is_active) VALUES
      ($1,$2,'LOA Officer','loan_officer','x',true),
      ($3,$4,'LOA Assistant','loan_officer_assistant','x',true),
      ($5,$6,'LOA Processor','processor','x',true),
      ($7,$8,'LOA Admin','admin','x',true)`,
      [LO, `loa_lo_${tag}@x.test`, LOA, `loa_la_${tag}@x.test`, PROC, `loa_pr_${tag}@x.test`, ADMIN, `loa_ad_${tag}@x.test`]);
    ok(true, '(0) staff_users accepts role=loan_officer_assistant (db/672)');
    let refused = null;
    try {
      await db.query(`INSERT INTO staff_users (id,email,full_name,role,password_hash,is_active) VALUES ($1,$2,'Bogus','not_a_role','x',true)`,
        [uuid(), `loa_bogus_${tag}@x.test`]);
    } catch (e) { refused = e.code; }
    ok(refused === '23514', `(0) …and still refuses an unregistered role (check_violation) — got ${refused}`);

    await db.query(`INSERT INTO borrowers (id,first_name,last_name,email) VALUES ($1,'Loa','Borrower',$2)`, [B, `loa_b_${tag}@x.test`]);
    await db.query(`INSERT INTO applications (id,borrower_id,loan_officer_id,status,property_address) VALUES
      ($1,$2,$3,'underwriting',$4), ($5,$2,$3,'underwriting',$6)`,
      [APP, B, LO, addr('9 Assistant Pl'), APP2, addr('11 Assistant Pl')]);

    const loTok = tok(LO, 'loan_officer');
    const loaTok = tok(LOA, 'loan_officer_assistant');
    const adminTok = tok(ADMIN, 'admin');

    // ---- (a) on no file → refused -------------------------------------------
    let r = await api(server, 'GET', `/api/staff/applications/${APP}`, loaTok);
    ok(r.status === 403, `(a) an assistant on no file is refused the file — got ${r.status}`);

    // ---- (b) never a processor ---------------------------------------------
    r = await api(server, 'POST', `/api/staff/applications/${APP}/assignees`, loTok, { staffId: LOA, role: 'processor' });
    ok(r.status === 400, `(b) THE ONE THAT MATTERS: the assistant cannot be added as a PROCESSOR on the file — got ${r.status} ${short(r.body)}`);
    let q = await db.query(`SELECT 1 FROM application_assignees WHERE application_id=$1 AND staff_id=$2 AND role='processor' AND removed_at IS NULL`, [APP, LOA]);
    ok(q.rowCount === 0, '(b) …and no processor row was written');
    r = await api(server, 'POST', `/api/staff/applications/${APP}/assign`, loTok, { processorId: LOA });
    ok(r.status === 404, `(b) …nor set as the file's processor (the pointer) — got ${r.status} ${short(r.body)}`);
    q = await db.query(`SELECT processor_id FROM applications WHERE id=$1`, [APP]);
    ok(q.rows[0].processor_id === null, '(b) the processor pointer is still empty');
    r = await api(server, 'POST', `/api/staff/applications/${APP}/assignees`, loTok, { staffId: PROC, role: 'processor' });
    ok(r.status === 200, `(b-control) a real processor IS accepted in the processor slot — the rule is the role match, not the slot — got ${r.status}`);

    // ---- (c) their own slot -------------------------------------------------
    r = await api(server, 'POST', `/api/staff/applications/${APP}/assignees`, loTok, { staffId: LOA, role: 'loan_officer_assistant' });
    ok(r.status === 200, `(c) the officer adds the assistant AS A LOAN OFFICER ASSISTANT — got ${r.status} ${short(r.body)}`);
    q = await db.query(`SELECT role, is_primary FROM application_assignees WHERE application_id=$1 AND staff_id=$2 AND removed_at IS NULL`, [APP, LOA]);
    ok(q.rowCount === 1 && q.rows[0].role === 'loan_officer_assistant' && q.rows[0].is_primary === false,
      `(c) one active row, in the assistant slot, never a primary — got ${short(q.rows)}`);
    r = await api(server, 'GET', `/api/staff/applications/${APP}/assignees`, loTok);
    ok(r.status === 200 && Array.isArray(r.body)
      && r.body.some((x) => String(x.staff_id) === LOA && x.role === 'loan_officer_assistant' && x.staff_role === 'loan_officer_assistant'),
      '(c) the team rail lists them under the assistant slot');
    r = await api(server, 'POST', `/api/staff/applications/${APP}/assignees`, loTok, { staffId: LOA, role: 'loan_officer_assistant' });
    ok(r.status === 409, `(c) adding them twice is refused — got ${r.status}`);

    // ---- (d) that file, and only that file ---------------------------------
    r = await api(server, 'GET', `/api/staff/applications/${APP}`, loaTok);
    ok(r.status === 200, `(d) seated, the assistant opens the file — got ${r.status}`);
    r = await api(server, 'GET', `/api/staff/applications/${APP2}`, loaTok);
    ok(r.status === 403, `(d) …and is still refused a file they are not on (no see_all_files, like the officer) — got ${r.status}`);
    r = await api(server, 'GET', '/api/staff/applications', loaTok);
    const listed = r.status === 200 ? JSON.stringify(r.body) : '';
    ok(r.status === 200 && listed.includes(APP) && !listed.includes(APP2),
      `(d) their pipeline lists the one file and not the other — got ${r.status} (has: ${listed.includes(APP)}, excludes: ${!listed.includes(APP2)})`);

    // ---- (e) the weekly officer pipeline email ------------------------------
    // (owner-directed 2026-09-02: "also give them the weekly officer pipeline email").
    // The pass CLAIMS a once-per-6-days audit_log row per recipient before it writes to
    // them (lib/throttle-claim), which is the durable trace of "this person was sent the
    // snapshot". The processor seated on the same file (b-control) must have NO claim:
    // the audience is the loan-officer PERSONA, derived from the registry.
    const digests = require(REPO + '/src/lib/notification-digests');
    await digests.weeklyOfficerPipelineOnce();
    const claimed = async (id) => (await db.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE action='officer_pipeline_weekly' AND entity_id=$1`, [id])).rows[0].n;
    ok(await claimed(LOA) === 1, '(e) the weekly officer pipeline email goes to the assistant — their book is the file they are seated on');
    ok(await claimed(LO) === 1, '(e-control) …and to the loan officer, as before');
    ok(await claimed(PROC) === 0, '(e-control) …but NOT to the processor seated on the same file — the audience is the officer persona');

    // ---- (f) an admin's file grant ------------------------------------------
    r = await api(server, 'POST', `/api/admin/staff/${LOA}/file-grants`, adminTok, { applicationId: APP2 });
    ok(r.status === 201, `(f) an admin grants the assistant a file — got ${r.status} ${short(r.body)}`);
    q = await db.query(`SELECT role FROM application_assignees WHERE application_id=$1 AND staff_id=$2 AND removed_at IS NULL`, [APP2, LOA]);
    ok(q.rowCount === 1 && q.rows[0].role === 'loan_officer_assistant',
      `(f) …seated in the ASSISTANT slot, never the processor bucket — got ${q.rows.map((x) => x.role)}`);
    r = await api(server, 'GET', `/api/staff/applications/${APP2}`, loaTok);
    ok(r.status === 200, `(f) …and the grant opens the file — got ${r.status}`);
    r = await api(server, 'DELETE', `/api/admin/staff/${LOA}/file-grants/${APP2}`, adminTok);
    ok(r.status === 200, `(f) the admin revokes it — got ${r.status}`);
    r = await api(server, 'GET', `/api/staff/applications/${APP2}`, loaTok);
    ok(r.status === 403, `(f) …and the door closes again — got ${r.status}`);

    // ---- (g) a file the assistant creates stays theirs ----------------------
    r = await api(server, 'POST', '/api/staff/applications', loaTok, {
      borrower: { firstName: 'Created', lastName: 'ByAssistant', email: `loa_new_${tag}@x.test` },
      propertyAddress: { line1: '7 Assistant Way', city: 'Lakewood', state: 'NJ', zip: '08701', oneLine: '7 Assistant Way, Lakewood, NJ 08701' },
    });
    ok(r.status === 201 && r.body && r.body.applicationId, `(g) the assistant creates a file — got ${r.status} ${short(r.body)}`);
    const newId = r.body && r.body.applicationId;
    if (newId) { madeApps.push(newId); if (r.body.borrowerId) madeBorrowers.push(r.body.borrowerId); }
    q = newId ? await db.query(`SELECT loan_officer_id, processor_id FROM applications WHERE id=$1`, [newId]) : { rows: [] };
    ok(q.rows[0] && String(q.rows[0].loan_officer_id || '') !== LOA, '(g) they are NOT the officer of record (an assistant assists one)');
    ok(q.rows[0] && q.rows[0].processor_id === null, '(g) …and not its processor');
    q = newId ? await db.query(`SELECT role FROM application_assignees WHERE application_id=$1 AND staff_id=$2 AND removed_at IS NULL`, [newId, LOA]) : { rowCount: 0, rows: [] };
    ok(q.rowCount === 1 && q.rows[0].role === 'loan_officer_assistant', `(g) …but seated on it as the loan officer assistant — got ${short(q.rows)}`);
    r = newId ? await api(server, 'GET', `/api/staff/applications/${newId}`, loaTok) : { status: 0 };
    ok(r.status === 200, `(g) so the file they just opened opens for them — got ${r.status}`);
    q = newId ? await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE entity_id=$1 AND action='add_assignee' AND actor_id=$2`, [newId, LOA]) : { rows: [{ n: 0 }] };
    ok(q.rows[0].n === 1, `(g) …and the seating is audited like any other add — ${q.rows[0].n} row(s)`);
    // The control: an OFFICER creating a file is its officer of record and gets no assistant row.
    r = await api(server, 'POST', '/api/staff/applications', loTok, {
      borrower: { firstName: 'Created', lastName: 'ByOfficer', email: `loa_lonew_${tag}@x.test` },
      propertyAddress: { line1: '8 Officer Way', city: 'Lakewood', state: 'NJ', zip: '08701', oneLine: '8 Officer Way, Lakewood, NJ 08701' },
    });
    const loNew = r.body && r.body.applicationId;
    if (loNew) { madeApps.push(loNew); if (r.body.borrowerId) madeBorrowers.push(r.body.borrowerId); }
    q = loNew ? await db.query(`SELECT loan_officer_id FROM applications WHERE id=$1`, [loNew]) : { rows: [{}] };
    ok(r.status === 201 && String(q.rows[0].loan_officer_id) === LO, `(g-control) an officer creating a file is its officer of record — got ${r.status}`);
    q = loNew ? await db.query(`SELECT count(*)::int AS n FROM application_assignees WHERE application_id=$1 AND role='loan_officer_assistant' AND removed_at IS NULL`, [loNew]) : { rows: [{ n: -1 }] };
    ok(q.rows[0].n === 0, '(g-control) …and no assistant row is written for them');

    // ---- (h) removal removes access ------------------------------------------
    r = await api(server, 'DELETE', `/api/staff/applications/${APP}/assignees/${LOA}?role=loan_officer_assistant`, loTok);
    ok(r.status === 200, `(h) the officer removes the assistant from the file — got ${r.status} ${short(r.body)}`);
    r = await api(server, 'GET', `/api/staff/applications/${APP}`, loaTok);
    ok(r.status === 403, `(h) …and they can no longer open it — got ${r.status}`);

    // ---- (i) the persona decides the dashboard home --------------------------
    await require(REPO + '/src/lib/dashboards/seed').seedDefaults();
    const store = require(REPO + '/src/lib/dashboards/store');
    const home = await store.homeFor({ id: LOA, role: 'loan_officer_assistant' });
    ok(home && home.slug === 'default_loan_officer', `(i) the assistant lands on the loan officer's "My dashboard" — got ${home && home.slug}`);
    const procHome = await store.homeFor({ id: PROC, role: 'processor' });
    ok(procHome && procHome.slug === 'default_processor', `(i-control) a processor still lands on "My work" — got ${procHome && procHome.slug}`);
  } catch (e) {
    fail++;
    console.log('  ✗ FAIL threw:', (e && e.stack) || e);
  } finally {
    // Best-effort teardown — the rows are ours (unique emails per run); a leftover
    // never affects another run.
    try { await db.query(`DELETE FROM application_assignees WHERE application_id = ANY($1::uuid[])`, [madeApps]); } catch (_) {}
    try { await db.query(`DELETE FROM applications WHERE id = ANY($1::uuid[])`, [madeApps]); } catch (_) {}
    try { await db.query(`DELETE FROM borrowers WHERE id = ANY($1::uuid[])`, [madeBorrowers]); } catch (_) {}
    try { await db.query(`DELETE FROM audit_log WHERE action='officer_pipeline_weekly' AND entity_id = ANY($1::uuid[])`, [[LO, LOA, PROC, ADMIN]]); } catch (_) {}
    try { await db.query(`DELETE FROM staff_users WHERE id = ANY($1::uuid[])`, [[LO, LOA, PROC, ADMIN]]); } catch (_) {}
    server.close();
  }
  console.log(`\n${fail ? `${fail} FAILED, ${pass} passed` : `OK — ${pass} passed, 0 failed.`}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
