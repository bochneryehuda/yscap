/**
 * TPO PORTAL — Phase 5a (lender-progress reveal + broker info-field writer),
 * real Postgres + HTTP.
 *
 * Proves:
 *   • the READ-ONLY lender-progress reveal shows ONLY the curated order-driven
 *     staff conditions (credit, appraisal received) with hand-authored
 *     broker-safe wording — never the internal hint/note;
 *   • the HARD RULE: the flood certificate (a staff condition on EVERY file) is
 *     NEVER shown to a broker, in the checklist OR the progress reveal;
 *   • a broker ANSWERS an information condition for a DEAL (applications) field —
 *     the value is written, the condition moves to review, and it is firm-scoped
 *     and audited to the broker;
 *   • a PERSON field (fico → borrowers) is NOT answerable inline and is
 *     redirected to the profile door — never written from the condition answer;
 *   • FREEZE PARITY: answering a frozen file's field is refused (409), exactly as
 *     a borrower/staffer editing the same field is;
 *   • firm isolation on both the reveal and the info writer.
 */
const http = require('http');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

function call(server, method, p, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) };
    const r = http.request({ method, path: p, port: server.address().port, host: '127.0.0.1', headers },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  if (!process.env.DATABASE_URL) { console.log('  ~~ SKIP TPO conditions DB (no DATABASE_URL)'); process.exit(0); }
  const R = require('path').resolve(__dirname, '..');
  const db = require(R + '/src/db');
  const C = require(R + '/src/lib/crypto');
  const app = require(R + '/src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const mail = (t) => `${t}-${sfx}@brk.test`;
  const addrOf = (n) => ({ line1: `${n} Main St`, city: 'Lakewood', state: 'NJ', zip: '08701' });
  const tpoTok = (id) => C.signJwt({ sub: id, kind: 'tpo', role: 'tpo_officer', tv: 0 });

  // Insert an info-field condition (a broker-facing info question about a field).
  const addInfoCond = (appId, fieldKey, label) => db.query(
    `INSERT INTO checklist_items (application_id, label, borrower_label, audience, status, item_kind, tool_key, field_key, scope)
     VALUES ($1,$2,$3,'both','outstanding','task','info_field',$4,'application') RETURNING id`,
    [appId, label, label, fieldKey]).then((r) => r.rows[0].id);

  try {
    const hash = await C.hashPassword('BrokerPass123!');
    const firmA = (await db.query(`INSERT INTO tpo_firms (name,status) VALUES ($1,'active') RETURNING id`, [`Firm A ${sfx}`])).rows[0].id;
    const firmB = (await db.query(`INSERT INTO tpo_firms (name,status) VALUES ($1,'active') RETURNING id`, [`Firm B ${sfx}`])).rows[0].id;
    const brokerA = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,is_external,tpo_firm_id,password_hash,token_version)
       VALUES ($1,'Broker A','tpo_officer',true,true,$2,$3,0) RETURNING id`, [mail('brokerA'), firmA, hash])).rows[0].id;
    const brokerB = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,is_external,tpo_firm_id,password_hash,token_version)
       VALUES ($1,'Broker B','tpo_officer',true,true,$2,$3,0) RETURNING id`, [mail('brokerB'), firmB, hash])).rows[0].id;
    const tokA = tpoTok(brokerA), tokB = tpoTok(brokerB);

    // Broker A enters a loan → conditions auto-generate (incl. credit, appraisal,
    // flood — all staff-audience).
    const enter = await call(server, 'POST', '/api/tpo/applications', tokA, {
      borrower: { firstName: 'Cara', lastName: 'Cond', email: mail('cara') },
      propertyAddress: addrOf(1), loanType: 'Purchase', purchasePrice: 300000, asIsValue: 300000, arv: 400000, rehabBudget: 50000 });
    ok(enter.status === 201 && enter.body.id, 'broker A enters a loan (201)');
    const appA = enter.body.id;
    const cara = (await db.query(`SELECT id FROM borrowers WHERE email=$1`, [mail('cara')])).rows[0].id;

    // Pin the DB item ids for the credit + appraisal staff order conditions (these
    // are instantiated on every RTL file at creation by generateChecklist).
    const codeIds = {};
    for (const row of (await db.query(
      `SELECT ci.id, t.code FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
        WHERE ci.application_id=$1 AND t.code = ANY($2::text[])`,
      [appA, ['rtl_cond_credit', 'rtl_cond_appraisaldocs']])).rows) codeIds[row.code] = row.id;
    ok(codeIds.rtl_cond_credit && codeIds.rtl_cond_appraisaldocs,
      'the file has the credit + appraisal staff conditions (auto-generated)');
    // Explicitly seed a FLOOD CERTIFICATE condition (staff-only, on every active
    // file per the owner HARD RULE) so the reveal's exclusion is actually
    // exercised. NB: a TPO file starts at 'file_intake', outside the conditions
    // engine's OPEN_STATUSES, so the engine's always/rules conditions (incl. flood)
    // do not auto-attach until the file becomes active — this seed stands in for
    // the active-file state where flood is present.
    codeIds.rtl_cond_flood = (await db.query(
      `INSERT INTO checklist_items (application_id, template_id, label, audience, status, item_kind, scope)
       SELECT $1, id, 'Flood certificate', 'staff', 'outstanding', 'document', 'application'
         FROM checklist_templates WHERE code='rtl_cond_flood' RETURNING id`, [appA])).rows[0].id;

    // ---------------------------------------------------------------
    // 1) THE READ-ONLY LENDER-PROGRESS REVEAL
    // ---------------------------------------------------------------
    const chk = await call(server, 'GET', `/api/tpo/applications/${appA}/checklist`, tokA);
    ok(chk.status === 200 && Array.isArray(chk.body.checklist) && Array.isArray(chk.body.progress), 'checklist returns {checklist, progress}');
    const prog = chk.body.progress || [];
    const chkIds = new Set((chk.body.checklist || []).map((c) => c.id));
    const progById = Object.fromEntries(prog.map((c) => [c.id, c]));

    ok(prog.length === 2, 'exactly two lender-progress rows are revealed (credit + appraisal)');
    const credit = progById[codeIds.rtl_cond_credit];
    const appr = progById[codeIds.rtl_cond_appraisaldocs];
    ok(credit && credit.label === 'Credit report' && credit.readOnly === true && credit.answerable === false,
      'the credit condition is revealed read-only with the safe label "Credit report"');
    ok(appr && appr.label === 'Appraisal' && appr.readOnly === true,
      'the appraisal condition is revealed read-only with the safe label "Appraisal"');
    // The internal hint must NEVER leak — the credit template hint is
    // "Upload the borrower's credit report (internal)…"; the reveal shows OUR note.
    ok(credit && /loan team/i.test(credit.hint || '') && !/internal/i.test(credit.hint || ''),
      'the revealed row shows the broker-safe note, never the internal hint');

    // HARD RULE: the flood certificate is NEVER shown — not in checklist, not in progress.
    ok(!progById[codeIds.rtl_cond_flood] && !chkIds.has(codeIds.rtl_cond_flood),
      'the flood certificate (staff-only) is NEVER shown to the broker (HARD RULE)');
    const allLabels = [...(chk.body.checklist || []), ...prog].map((c) => String(c.label || '').toLowerCase());
    ok(!allLabels.some((l) => l.includes('flood')), 'no row anywhere mentions flood');
    // The credit/appraisal staff conditions are NOT in the actionable checklist either.
    ok(!chkIds.has(codeIds.rtl_cond_credit) && !chkIds.has(codeIds.rtl_cond_appraisaldocs),
      'the revealed staff conditions never appear in the actionable checklist');

    // A co-borrower's separate credit pull adds a SECOND staff rtl_cond_credit
    // item (credit/co-condition.js) — the broker must still see exactly ONE
    // "Credit report" row, with the LEAST-advanced status.
    await db.query(
      `INSERT INTO checklist_items (application_id, template_id, label, audience, status, item_kind, field_key, scope)
       SELECT $1, id, 'Credit report', 'staff', 'satisfied', 'document', 'cob_credit', 'application'
         FROM checklist_templates WHERE code='rtl_cond_credit'`, [appA]);
    const chkDup = await call(server, 'GET', `/api/tpo/applications/${appA}/checklist`, tokA);
    const creditRows = (chkDup.body.progress || []).filter((c) => c.label === 'Credit report');
    ok(creditRows.length === 1, 'a co-borrower credit item does NOT duplicate the "Credit report" progress row');
    ok(creditRows[0] && creditRows[0].status === 'outstanding', 'the deduped credit row keeps the LEAST-advanced status');
    ok((chkDup.body.progress || []).length === 2, 'still exactly two progress rows after the co-borrower credit item');

    // ---------------------------------------------------------------
    // 2) THE INFO-FIELD WRITER — a DEAL (applications) field
    // ---------------------------------------------------------------
    const arvCondId = await addInfoCond(appA, 'arv', 'Confirm the after-repair value');
    const chk2 = await call(server, 'GET', `/api/tpo/applications/${appA}/checklist`, tokA);
    const arvRow = (chk2.body.checklist || []).find((c) => c.id === arvCondId);
    ok(arvRow && arvRow.answerable === true, 'an applications-field info condition is marked answerable');
    // a document condition is never answerable
    const docRow = (chk2.body.checklist || []).find((c) => c.item_kind === 'document');
    ok(!docRow || docRow.answerable === false, 'a document condition is never answerable');

    const ans = await call(server, 'POST', `/api/tpo/applications/${appA}/checklist/${arvCondId}/info`, tokA, { value: 425000 });
    ok(ans.status === 200 && ans.body.status === 'received', 'the broker answers the ARV info condition (200, received)');
    ok((await db.query(`SELECT arv FROM applications WHERE id=$1`, [appA])).rows[0].arv === '425000.00', 'the ARV was written to the file');
    ok((await db.query(`SELECT status FROM checklist_items WHERE id=$1`, [arvCondId])).rows[0].status === 'received', 'the info condition moved to received');
    ok((await db.query(`SELECT 1 FROM audit_log WHERE action='tpo_answer_info_condition' AND entity_id=$1 AND actor_id=$2`, [arvCondId, brokerA])).rows.length === 1,
      'the info answer is audited to the broker');
    // an empty answer is refused
    ok((await call(server, 'POST', `/api/tpo/applications/${appA}/checklist/${arvCondId}/info`, tokA, { value: '' })).status === 400, 'an empty answer is refused (400)');
    // a non-info condition is not an information item
    if (docRow) ok((await call(server, 'POST', `/api/tpo/applications/${appA}/checklist/${docRow.id}/info`, tokA, { value: 'x' })).status === 404,
      'answering a non-info condition is refused (404)');

    // ---------------------------------------------------------------
    // 3) A PERSON FIELD (fico) is redirected to the profile, never written here
    // ---------------------------------------------------------------
    const ficoCondId = await addInfoCond(appA, 'fico', 'Confirm the credit score');
    const chk3 = await call(server, 'GET', `/api/tpo/applications/${appA}/checklist`, tokA);
    const ficoRow = (chk3.body.checklist || []).find((c) => c.id === ficoCondId);
    ok(ficoRow && ficoRow.answerable === false, 'a person field (fico) is NOT answerable inline');
    const ficoAns = await call(server, 'POST', `/api/tpo/applications/${appA}/checklist/${ficoCondId}/info`, tokA, { value: 700 });
    ok(ficoAns.status === 400 && /profile/i.test(ficoAns.body.error || ''), 'answering a fico condition is redirected to the profile (400)');
    ok((await db.query(`SELECT fico FROM borrowers WHERE id=$1`, [cara])).rows[0].fico === null, 'the fico was NOT written from the condition answer');

    // A NON-WRITABLE built-in field (note_buyer → the staff-only capital partner
    // applications.lender) is NOT answerable inline, and the writer refuses it —
    // a broker can never write it from a condition (double defense).
    const nbCondId = await addInfoCond(appA, 'note_buyer', 'Confirm the note buyer');
    const nbRow = ((await call(server, 'GET', `/api/tpo/applications/${appA}/checklist`, tokA)).body.checklist || []).find((c) => c.id === nbCondId);
    ok(nbRow && nbRow.answerable === false, 'a non-writable built-in field (note_buyer) is NOT answerable');
    ok((await call(server, 'POST', `/api/tpo/applications/${appA}/checklist/${nbCondId}/info`, tokA, { value: 'BlueLake' })).status === 400,
      'the writer refuses a non-writable field (400) — the note buyer is never broker-writable');
    ok((await db.query(`SELECT lender FROM applications WHERE id=$1`, [appA])).rows[0].lender === null, 'the note buyer (lender) was NOT written');

    // ---------------------------------------------------------------
    // 3b) REGISTRATION SANDBOX PARITY — on a REGISTERED file a change-requestable
    // economics answer becomes a reviewable change request (staff approve), NEVER
    // a live write — exactly like the borrower's info door. Confirming the current
    // value is received; a different value is held for approval.
    // ---------------------------------------------------------------
    await db.query(`INSERT INTO product_registrations (application_id, program, inputs, quote, is_current) VALUES ($1,'standard','{}','{}',true)`, [appA]);
    // a DIFFERENT arv → a change request; the live value stays 425000.
    const chg = await call(server, 'POST', `/api/tpo/applications/${appA}/checklist/${arvCondId}/info`, tokA, { value: 700000 });
    ok(chg.status === 200 && chg.body.changeRequested === true && chg.body.locked === true,
      'a change to a REGISTERED file opens a change request (not a live write)');
    ok((await db.query(`SELECT arv FROM applications WHERE id=$1`, [appA])).rows[0].arv === '425000.00',
      'the economics were NOT written live on a registered file (parity with the borrower)');
    ok((await db.query(
      `SELECT 1 FROM change_requests WHERE application_id=$1 AND field='arv' AND status='pending'
         AND requested_by_kind='staff' AND requested_by_id=$2`, [appA, brokerA])).rows.length === 1,
      'a pending change request is filed, attributed to the broker');
    // confirming the value already on file (425000) → received, no request.
    const conf = await call(server, 'POST', `/api/tpo/applications/${appA}/checklist/${arvCondId}/info`, tokA, { value: 425000 });
    ok(conf.status === 200 && conf.body.changeRequested === false, 'confirming the current value is accepted with no change request');

    // Staff approve the broker's request → the economics apply, and the BORROWER is
    // NOT notified "your requested change" (the broker made it, not the borrower —
    // audit fix: the shared change_requests notify is gated on requested_by_kind).
    const staffAdmin = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,is_external,password_hash,token_version)
       VALUES ($1,'Admin','super_admin',true,false,$2,0) RETURNING id`, [mail('admin'), hash])).rows[0].id;
    const staffTok = C.signJwt({ sub: staffAdmin, kind: 'staff', role: 'super_admin', tv: 0 });
    const crId = (await db.query(`SELECT id FROM change_requests WHERE application_id=$1 AND field='arv' AND status='pending'`, [appA])).rows[0].id;
    const approveResp = await call(server, 'POST', `/api/staff/change-requests/${crId}/approve`, staffTok, {});
    ok(approveResp.status === 200, 'staff approve the broker change request (200)');
    ok((await db.query(`SELECT arv FROM applications WHERE id=$1`, [appA])).rows[0].arv === '700000.00', 'the approved economics are applied to the file');
    ok((await db.query(
      `SELECT count(*)::int n FROM notifications WHERE application_id=$1 AND recipient_kind='borrower' AND type='change_request'`, [appA])).rows[0].n === 0,
      'the borrower is NOT notified about a BROKER-originated change request (no misattribution)');

    // ---------------------------------------------------------------
    // 4) FIRM ISOLATION on the reveal + the info writer
    // ---------------------------------------------------------------
    ok((await call(server, 'GET', `/api/tpo/applications/${appA}/checklist`, tokB)).status === 404, 'broker B cannot read firm A conditions (404)');
    ok((await call(server, 'POST', `/api/tpo/applications/${appA}/checklist/${arvCondId}/info`, tokB, { value: 999999 })).status === 404,
      'broker B cannot answer a firm A info condition (404)');
    ok((await db.query(`SELECT arv FROM applications WHERE id=$1`, [appA])).rows[0].arv === '700000.00', 'the cross-firm attempt wrote nothing');

    // ---------------------------------------------------------------
    // 5) FREEZE PARITY — a frozen file refuses the answer (same as staff/borrower)
    // ---------------------------------------------------------------
    await db.query(`UPDATE applications SET status='funded' WHERE id=$1`, [appA]);
    const frozen = await call(server, 'POST', `/api/tpo/applications/${appA}/checklist/${arvCondId}/info`, tokA, { value: 500000 });
    ok(frozen.status === 409, 'answering a frozen (funded) file is refused (409) — freeze parity');
    ok((await db.query(`SELECT arv FROM applications WHERE id=$1`, [appA])).rows[0].arv === '700000.00', 'the frozen answer wrote nothing');
  } catch (e) {
    fail++; console.log('  FAIL (threw):', e.message, e.stack ? e.stack.split('\n')[1] : '');
  } finally {
    try {
      const like = `%${sfx}%`;
      const appIds = (await db.query(
        `SELECT id FROM applications WHERE tpo_firm_id IN (SELECT id FROM tpo_firms WHERE name LIKE $1)
            OR borrower_id IN (SELECT id FROM borrowers WHERE email LIKE $1)`, [like])).rows.map((r) => r.id);
      if (appIds.length) {
        await db.query(`DELETE FROM notifications WHERE application_id = ANY($1::uuid[])`, [appIds]).catch(() => {});
        await db.query(`DELETE FROM change_requests WHERE application_id = ANY($1::uuid[])`, [appIds]).catch(() => {});
        await db.query(`DELETE FROM product_registrations WHERE application_id = ANY($1::uuid[])`, [appIds]).catch(() => {});
        await db.query(`DELETE FROM checklist_items WHERE application_id = ANY($1::uuid[])`, [appIds]).catch(() => {});
      }
      await db.query(`DELETE FROM applications WHERE tpo_firm_id IN (SELECT id FROM tpo_firms WHERE name LIKE $1)`, [like]);
      await db.query(`DELETE FROM applications WHERE borrower_id IN (SELECT id FROM borrowers WHERE email LIKE $1)`, [like]);
      await db.query(`DELETE FROM audit_log WHERE actor_id IN (SELECT id FROM staff_users WHERE email LIKE $1)`, [like]);
      await db.query(`DELETE FROM borrowers WHERE email LIKE $1`, [like]);
      await db.query(`DELETE FROM staff_users WHERE email LIKE $1`, [like]);
      await db.query(`DELETE FROM tpo_firms WHERE name LIKE $1`, [like]);
    } catch (_) { /* best-effort cleanup */ }
    try { server.close(); } catch (_) {}
    try { await db.pool.end(); } catch (_) {}
    console.log(`test-tpo-conditions-db: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
