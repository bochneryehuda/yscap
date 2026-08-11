/**
 * TPO PORTAL — Phase 6e (broker ↔ team MESSAGING), real Postgres + HTTP.
 *
 * Proves the broker's messaging surface reuses the shared chat v3 infra SAFELY:
 *   • a broker's message posts as sender_kind='tpo' (distinct from our staff) and resolves its name
 *     from staff_users; the broker↔team conversation is kind='tpo', never borrower_visible;
 *   • our AE (an internal assignee) is seated as a staff member and sees the conversation
 *     (chat.staffCanAccess) with the broker's message;
 *   • a STAFF reply is delivered to the broker BORROWER-SAFE: a capital-partner name a staffer typed
 *     is SCRUBBED before the broker reads it;
 *   • THE EMAIL-LEAK GUARD: a staff reply creates NO chat email / deferred job for the broker (tpo)
 *     member — the raw body can never be emailed to the external broker;
 *   • firm isolation: firm B's broker cannot read firm A's conversation, its messages, or an
 *     attachment; the list is firm-scoped;
 *   • tpoCanAccess refuses a borrower/internal conversation (a broker never reaches one);
 *   • an attachment round-trips: the broker sends a photo and fetches its bytes firm-scoped, and a
 *     cross-firm broker gets 404.
 */
const http = require('http');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

function call(server, method, p, token, body, raw) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) };
    const r = http.request({ method, path: p, port: server.address().port, host: '127.0.0.1', headers },
      (res) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, ctype: res.headers['content-type'] || '', buf, body: raw ? buf.toString('latin1') : (buf.length ? JSON.parse(buf.toString('utf8')) : null) });
      }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
function png() {
  return Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001080600000' +
    '01f15c4890000000d49444154789c6360000002000100ffff0300000600055773d6d40000000049454e44ae426082', 'hex');
}

(async () => {
  if (!process.env.DATABASE_URL) { console.log('  ~~ SKIP TPO chat DB (no DATABASE_URL)'); process.exit(0); }
  const R = require('path').resolve(__dirname, '..');
  const db = require(R + '/src/db');
  const C = require(R + '/src/lib/crypto');
  const chat = require(R + '/src/lib/chat');
  // Capture every outbound email recipient so we can PROVE the broker is never emailed a chat body
  // (the frozen never-leak-to-an-external-party rule) while our team IS notified.
  const emailMod = require(R + '/src/lib/email');
  const emailedTo = [];
  emailMod.sendMail = async (opts) => { for (const t of [].concat((opts && opts.to) || [])) emailedTo.push(String(t)); return { id: 'stub' }; };
  const app = require(R + '/src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));

  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const mail = (t) => `${t}-${sfx}@brk.test`;
  const tpoTok = (id) => C.signJwt({ sub: id, kind: 'tpo', role: 'tpo_officer', tv: 0 });
  const staffTok = (id, role) => C.signJwt({ sub: id, kind: 'staff', role: role || 'super_admin', tv: 0 });

  try {
    const hash = await C.hashPassword('BrokerPass123!');
    const firmA = (await db.query(`INSERT INTO tpo_firms (name,status) VALUES ($1,'active') RETURNING id`, [`Firm A ${sfx}`])).rows[0].id;
    const firmB = (await db.query(`INSERT INTO tpo_firms (name,status) VALUES ($1,'active') RETURNING id`, [`Firm B ${sfx}`])).rows[0].id;
    const brokerA = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,is_external,tpo_firm_id,password_hash,token_version)
       VALUES ($1,'Broker Alice','tpo_officer',true,true,$2,$3,0) RETURNING id`, [mail('brokerA'), firmA, hash])).rows[0].id;
    const brokerB = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,is_external,tpo_firm_id,password_hash,token_version)
       VALUES ($1,'Broker Bob','tpo_officer',true,true,$2,$3,0) RETURNING id`, [mail('brokerB'), firmB, hash])).rows[0].id;
    // our internal account executive (NOT external)
    const ae = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,is_external,password_hash,token_version)
       VALUES ($1,'Ava Executive','loan_officer',true,false,$2,0) RETURNING id`, [mail('ae'), hash])).rows[0].id;
    // a see-all internal admin whose staff chat inbox seeds member rosters unscoped across every file
    const admin = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,is_external,password_hash,token_version)
       VALUES ($1,'Sam Admin','super_admin',true,false,$2,0) RETURNING id`, [mail('admin'), hash])).rows[0].id;
    const tokA = tpoTok(brokerA), tokB = tpoTok(brokerB);

    const borId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email,origin) VALUES ('Cy','Chat',$1,'tpo') RETURNING id`, [mail('cy')])).rows[0].id;
    const appA = (await db.query(
      `INSERT INTO applications (borrower_id, is_tpo, tpo_firm_id, loan_officer_id, ys_loan_number, status, loan_type, source, borrower_portal_enabled)
       VALUES ($1,true,$2,$3,$4,'in_review','Purchase','tpo',true) RETURNING id`, [borId, firmA, brokerA, `YC${sfx}`.slice(0, 20)])).rows[0].id;
    // seat our AE as an account_executive assignee on the file
    await db.query(`INSERT INTO application_assignees (application_id, staff_id, role, is_primary) VALUES ($1,$2,'account_executive',false)`, [appA, ae]);

    // ── the broker opens messaging on their file (lazy-ensures the conversation) ──
    const list = await call(server, 'GET', `/api/tpo/chat/conversations?applicationId=${appA}`, tokA);
    ok(list.status === 200, `broker A → chat list 200 (got ${list.status})`);
    const conv = (list.body && list.body.conversations || [])[0];
    ok(conv && conv.application_id === appA, 'the broker↔team conversation exists on the file');
    const cid = conv && conv.id;

    // the conversation is kind='tpo' + NOT borrower_visible + seats broker(tpo) and AE(staff)
    const crow = (await db.query(`SELECT kind, borrower_visible FROM conversations WHERE id=$1`, [cid])).rows[0];
    ok(crow && crow.kind === 'tpo' && crow.borrower_visible === false, 'conversation is kind=tpo, never borrower-visible');
    const mems = (await db.query(`SELECT member_kind, member_id FROM conversation_members WHERE conversation_id=$1`, [cid])).rows;
    ok(mems.some(m => m.member_kind === 'tpo' && m.member_id === brokerA), 'the broker is seated as a tpo member');
    ok(mems.some(m => m.member_kind === 'staff' && m.member_id === ae), 'our AE is seated as a staff member');

    // ── the broker sends a message ──
    const send = await call(server, 'POST', `/api/tpo/chat/conversations/${cid}/messages`, tokA, { body: 'Hi team — can you confirm the appraisal is ordered?' });
    ok(send.status === 201 && send.body.message, `broker sends a message (got ${send.status})`);
    ok(send.body.message.sender_kind === 'tpo', 'the message is stored as sender_kind=tpo (distinct from staff)');
    ok(send.body.message.sender_name === 'Broker Alice', "the broker's name resolves from staff_users");

    // our AE can access the conversation (staff side)
    ok(await chat.staffCanAccess({ id: ae, role: 'loan_officer' }, await chat.getConversation(cid)), 'our AE (assignee) can access the broker↔team conversation');

    // ── a STAFF reply carrying a capital-partner name is delivered BORROWER-SAFE ──
    const convObj = await chat.getConversation(cid);
    await chat.postMessage({ conv: convObj, actor: { kind: 'staff', id: ae, roleLabel: 'Account Executive' },
      body: 'Yes — BlueLake Capital approved it, ordering now.' });
    const bmsgs = await call(server, 'GET', `/api/tpo/chat/conversations/${cid}/messages`, tokA);
    ok(bmsgs.status === 200, 'broker reads the thread');
    const rawJson = JSON.stringify(bmsgs.body || {});
    ok(!/BlueLake|Blue Lake/i.test(rawJson), 'the staff reply is SCRUBBED of the capital-partner name before the broker reads it');
    ok(/Gold Standard program/i.test(rawJson), 'the partner name became the borrower-safe "Gold Standard program"');
    // the staff copy still has the REAL name (stored verbatim)
    const stored = (await db.query(`SELECT body FROM messages WHERE conversation_id=$1 AND sender_kind='staff' ORDER BY seq DESC LIMIT 1`, [cid])).rows[0];
    ok(/BlueLake/i.test(stored.body), 'our team sees the real name (stored verbatim; only the broker view is scrubbed)');

    // ── THE EMAIL-LEAK GUARD: no chat email / deferred job is ever created for the broker (tpo) ──
    const tpoJobs = (await db.query(`SELECT count(*)::int c FROM chat_notification_jobs WHERE recipient_kind='tpo'`)).rows[0].c;
    ok(tpoJobs === 0, 'NO chat email / deferred notification job is ever queued for a tpo (broker) member — the raw body can never be emailed to the external broker');

    // ── firm isolation ──
    const bList = await call(server, 'GET', `/api/tpo/chat/conversations`, tokB);
    ok(bList.status === 200 && !(bList.body.conversations || []).some(c => c.id === cid), "firm B's broker does NOT see firm A's conversation in the list");
    const bGet = await call(server, 'GET', `/api/tpo/chat/conversations/${cid}`, tokB);
    ok(bGet.status === 404, "firm B's broker cannot open firm A's conversation (404)");
    const bMsgs = await call(server, 'GET', `/api/tpo/chat/conversations/${cid}/messages`, tokB);
    ok(bMsgs.status === 404, "firm B's broker cannot read firm A's messages (404)");
    const bSend = await call(server, 'POST', `/api/tpo/chat/conversations/${cid}/messages`, tokB, { body: 'x' });
    ok(bSend.status === 404, "firm B's broker cannot POST into firm A's conversation (404)");

    // ── tpoCanAccess refuses a borrower/internal conversation ──
    await chat.ensureConversationsForApp(appA);
    const borrowerConv = (await db.query(`SELECT id FROM conversations WHERE application_id=$1 AND kind='borrower'`, [appA])).rows[0].id;
    const bc = await call(server, 'GET', `/api/tpo/chat/conversations/${borrowerConv}`, tokA);
    ok(bc.status === 404, 'the broker cannot open the BORROWER conversation on their own file (404 — tpo only)');
    const internalConv = (await db.query(`SELECT id FROM conversations WHERE application_id=$1 AND kind='internal'`, [appA])).rows[0].id;
    const ic = await call(server, 'GET', `/api/tpo/chat/conversations/${internalConv}`, tokA);
    ok(ic.status === 404, 'the broker cannot open the INTERNAL team conversation (404)');

    // ── SECURITY: the broker (external) is NEVER a 'staff' member of ANY conversation ──
    // Pre-Phase-6e, ensureConversationsForApp seated the loan_officer — the external broker on a TPO
    // file — as a 'staff' member of the internal "Loan Team" chat, so our team's raw internal
    // messages would be emailed to the broker. ensureConversationsForApp(appA) ran just above; the
    // broker must NOT have gained a staff membership anywhere.
    const brokerStaffMemberships = (await db.query(`SELECT count(*)::int c FROM conversation_members WHERE member_id=$1 AND member_kind='staff'`, [brokerA])).rows[0].c;
    ok(brokerStaffMemberships === 0, 'the broker is NEVER a staff member of any conversation (no internal-chat → broker email leak)');
    const brokerTpoMembership = (await db.query(`SELECT count(*)::int c FROM conversation_members WHERE member_id=$1 AND member_kind='tpo' AND conversation_id=$2`, [brokerA, cid])).rows[0].c;
    ok(brokerTpoMembership === 1, 'the broker IS a tpo member of the broker↔team conversation');

    // ── SECURITY (FUNC audit): the STAFF chat inbox has its OWN copy of the member-seeding SQL (it is
    // NOT routed through ensureConversationsForApp). A see-all admin loading it seeds rosters UNSCOPED
    // across every file, so without the same external-staffer guard it would re-seat the external
    // broker (loan_officer_id on a TPO file) as a 'staff' member on EVERY inbox load — undoing db/528's
    // cleanup and re-opening the internal-chat → broker email leak. Drive that exact route and re-assert.
    const inbox = await call(server, 'GET', `/api/staff/chat/conversations`, staffTok(admin, 'super_admin'));
    ok(inbox.status === 200, `staff (admin) chat inbox loads (got ${inbox.status})`);
    const brokerStaffAfterInbox = (await db.query(`SELECT count(*)::int c FROM conversation_members WHERE member_id=$1 AND member_kind='staff'`, [brokerA])).rows[0].c;
    ok(brokerStaffAfterInbox === 0, 'the staff inbox seeding does NOT re-seat the broker as a staff member (staff-chat.js guard mirrors ensureConversationsForApp)');
    // and the broker never becomes a member of any NON-tpo conversation via this path either
    const brokerNonTpoMemberships = (await db.query(
      `SELECT count(*)::int c FROM conversation_members cm JOIN conversations c ON c.id=cm.conversation_id
        WHERE cm.member_id=$1 AND c.kind <> 'tpo'`, [brokerA])).rows[0].c;
    ok(brokerNonTpoMemberships === 0, "the broker is a member of the 'tpo' conversation ONLY — never an internal/borrower/lo_processor chat");
    // a message in the INTERNAL conversation must not reach the broker by email
    const internalConvObj = await chat.getConversation(internalConv);
    await chat.postMessage({ conv: internalConvObj, actor: { kind: 'staff', id: ae, roleLabel: 'AE' }, body: 'internal note: BlueLake wants extra reserves' });

    // ── attachment round-trip (firm-scoped serve) ──
    const withAtt = await call(server, 'POST', `/api/tpo/chat/conversations/${cid}/messages`, tokA,
      { body: 'here is the purchase contract', attachment: { filename: 'contract.png', dataBase64: png().toString('base64'), contentType: 'image/png' } });
    ok(withAtt.status === 201 && withAtt.body.message.attachment_document_id, 'broker sends a message with a photo attachment');
    const docId = withAtt.body.message.attachment_document_id;
    // stored as a 'staff' upload (documents CHECK allows only borrower/staff) attributed to the broker
    const drow = (await db.query(`SELECT uploaded_by_kind, uploaded_by_id, visibility FROM documents WHERE id=$1`, [docId])).rows[0];
    ok(drow && drow.uploaded_by_kind === 'staff' && drow.uploaded_by_id === brokerA && drow.visibility === 'staff_only',
      "the broker's chat attachment stores as a staff/staff_only doc attributed to the broker (never borrower-exposed)");
    const fetchA = await call(server, 'GET', `/api/tpo/chat/attachment/${docId}`, tokA, null, true);
    ok(fetchA.status === 200 && fetchA.buf.length === png().length, 'broker A fetches its own chat attachment bytes (200)');
    const fetchB = await call(server, 'GET', `/api/tpo/chat/attachment/${docId}`, tokB);
    ok(fetchB.status === 404, "firm B's broker cannot fetch firm A's chat attachment (404 — firm isolation)");
    const fetchNone = await call(server, 'GET', `/api/tpo/chat/attachment/${borId}`, tokA);   // a real uuid, not a chat attachment
    ok(fetchNone.status === 404, 'a non-attachment document id → 404 (not a generic download door)');

    // ── EMAIL: the broker is never emailed a chat body; our team IS notified normally ──
    ok(!emailedTo.some(t => t.startsWith(`brokerA-${sfx}`)),
      'the broker is NEVER sent a chat email — a staff reply / internal note never reaches the external broker by email');
    ok(emailedTo.some(t => t.startsWith(`ae-${sfx}`)),
      'our AE IS emailed about the broker messages (team notified through the normal path)');

    // ── SECURITY (audit SEC-1): the LIVE SSE fan-out must scrub the partner name for a tpo (broker)
    // connection, not only the REST fetch — SSE is the broker's PRIMARY delivery channel in v1, so a
    // gap there leaks the raw capital-partner name live even though the HTTP fetch scrubs it. ──
    const events = require(R + '/src/lib/events');
    const sseFrames = [];
    const fakeRes = { writeHead() {}, write(s) { sseFrames.push(String(s)); }, on() {}, end() {} };
    events.addClient(fakeRes, { kind: 'tpo', id: brokerA });   // brokerA is a tpo member of cid (seated above)
    await events.publishToConversation(cid, 'message:new',
      { message: { body: 'Confirmed with BlueLake Capital — funding Friday.', sender_kind: 'staff' } });
    const sse = sseFrames.join('\n');
    ok(!/BlueLake|Blue Lake/i.test(sse), 'the LIVE SSE frame to the broker is SCRUBBED of the capital-partner name (not just the REST fetch)');
    ok(/Gold Standard program/i.test(sse), 'the SSE frame carries the borrower-safe "Gold Standard program"');

    console.log(`\ntest-tpo-chat-db: ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error('  FAIL (threw):', e && e.stack || e);
    fail++;
  } finally {
    server.close();
    try { await db.pool.end(); } catch (_) {}
  }
  process.exit(fail ? 1 : 0);
})();
