/**
 * #68 inbound per-file reply-to — end-to-end test.
 *
 * Covers the owner's required cases: valid file address, upper/lower-case address,
 * malformed address, unknown application id, file with no assignees, duplicate
 * assignee emails, Resend retrieval failure, forwarding failure, duplicate
 * email_id (idempotency), invalid webhook signature, and that the existing
 * /api/inbound/chat route still works. Plus outbound Reply-To wiring.
 *
 * Self-contained: creates its own borrower/application/staff fixtures in the
 * throwaway yscap_test DB and cleans them up. The Resend Receiving API and the
 * email provider are stubbed (no network); the webhook signature is a real
 * Svix round-trip so the verifier is exercised for real.
 *
 * Run: node scripts/test-inbound-file-email.js   (needs local Postgres)
 */
const crypto = require('crypto');

// --- env MUST be set before any app module (config caches it) --------------
const DOMAIN = 'reply.yscapgroup.test';
const SECRET_B64 = Buffer.from('inbound-webhook-test-secret-key-01').toString('base64');
const SECRET = 'whsec_' + SECRET_B64;
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://yscap:yscap@127.0.0.1:5432/yscap_test';
process.env.JWT_SECRET = 'test-secret-inbound-file';
process.env.CHAT_REPLY_DOMAIN = DOMAIN;
process.env.RESEND_WEBHOOK_SECRET = SECRET;
process.env.RESEND_INBOUND_API_KEY = 'test-inbound-key';   // makes inboundKey() non-null
process.env.EMAIL_PROVIDER = 'none';                        // keep provider = noop
process.env.NODE_ENV = 'test';

const http = require('http');
const REPO = __dirname + '/..';
const db = require(REPO + '/src/db');
const email = require(REPO + '/src/lib/email');            // provider object — we stub sendMail
const fileInbox = require(REPO + '/src/lib/file-inbox');
const fileAddr = require(REPO + '/src/lib/file-address');
const webhook = require(REPO + '/src/lib/resend-webhook');

const PORT = 5622;
const uuid = () => crypto.randomUUID();

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL', m); } };

function sign(body, opts = {}) {
  const id = opts.id || ('msg_' + uuid());
  const ts = String(opts.ts || Math.floor(Date.now() / 1000));
  const key = Buffer.from(SECRET_B64, 'base64');
  const sig = crypto.createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': 'v1,' + sig };
}

function post(path, rawBody, headers) {
  return new Promise((resolve, reject) => {
    const h = Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(rawBody) }, headers || {});
    const req = http.request({ host: '127.0.0.1', port: PORT, method: 'POST', path, headers: h },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    req.on('error', reject); req.write(rawBody); req.end();
  });
}

// ---- stubbable behavior for the Resend Receiving API + the email provider ----
let sent = [];
let sendBehavior = 'ok';       // 'ok' | 'throw'
let retrievalBehavior = 'ok';  // 'ok' | 'fail'
let cannedEmail = null;

function installStubs() {
  email.sendMail = async (args) => {
    sent.push(args);
    if (sendBehavior === 'throw') throw new Error('smtp down');
    return { ok: true, id: 'stub' };
  };
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/emails/receiving/')) {
      if (retrievalBehavior === 'fail') return { ok: false, status: 502, json: async () => ({}) };
      if (/\/attachments\/[^/]+$/.test(u)) return { ok: true, status: 200, json: async () => ({ download_url: 'https://dl.test/x', filename: 'a.pdf', size: 3 }) };
      return { ok: true, status: 200, json: async () => cannedEmail };
    }
    if (u.startsWith('https://dl.test/')) return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
}

async function waitForTable(name, ms = 25000) {
  const start = Date.now();
  for (;;) {
    try {
      const r = await db.query(`SELECT to_regclass($1) AS t`, ['public.' + name]);
      if (r.rows[0] && r.rows[0].t) return true;
    } catch (_) { /* db not ready yet */ }
    if (Date.now() - start > ms) return false;
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function main() {
  const app = require(REPO + '/src/server.js');
  const server = app.listen(PORT);
  // server.js only runs ensureSchema() under `require.main === module`; a required
  // server doesn't migrate. Run the REAL production migration path here so db/116
  // is applied through the same runner Render uses on boot.
  await require(REPO + '/src/migrate-boot').ensureSchema();
  const ready = await waitForTable('inbound_file_emails');
  ok(ready, 'db/116 inbound_file_emails table applied by ensureSchema (the boot runner)');
  if (!ready) { server.close(); console.log('\nABORT: table never appeared'); process.exit(1); }

  // ---- fixtures ----
  const B = uuid(), A1 = uuid(), A2 = uuid(), S1 = uuid(), S2 = uuid();
  const S1email = `s1_${A1.slice(0, 8)}@staff.test`;
  const S2email = `s2_${A1.slice(0, 8)}@staff.test`;
  try {
    await db.query(`INSERT INTO borrowers (id, first_name, last_name, email) VALUES ($1,'Test','Borrower',$2)`, [B, `b_${A1.slice(0, 8)}@x.test`]);
    for (const a of [A1, A2]) {
      await db.query(`INSERT INTO applications (id, borrower_id, ys_loan_number, property_address)
                      VALUES ($1,$2,$3,$4::jsonb)`, [a, B, 'TEST-' + a.slice(0, 6), JSON.stringify({ oneLine: '123 Test St, Testville, NY' })]);
    }
    await db.query(`INSERT INTO staff_users (id, email, full_name, role, is_active) VALUES ($1,$2,'Officer One','loan_officer',true)`, [S1, S1email]);
    await db.query(`INSERT INTO staff_users (id, email, full_name, role, is_active) VALUES ($1,$2,'Processor Two','processor',true)`, [S2, S2email]);
    // A1 assignees: S1 (LO) + S2 (processor). A2: none.
    await db.query(`INSERT INTO application_assignees (application_id, staff_id, role, is_primary) VALUES ($1,$2,'loan_officer',true)`, [A1, S1]);
    await db.query(`INSERT INTO application_assignees (application_id, staff_id, role, is_primary) VALUES ($1,$2,'processor',true)`, [A1, S2]);

    installStubs();
    cannedEmail = { from: 'Guest Sender <guest@external.test>', to: [`file+${A1}@${DOMAIN}`], subject: 'Re: your file', text: 'Hi team, here is my reply.', html: '<p>Hi team</p>', attachments: [] };

    const evt = (emailId, to) => ({ type: 'email.received', data: { email_id: emailId, to } });

    // ---------- unit: file-address ----------
    console.log('\n# file-address helpers');
    ok(fileAddr.applicationIdFromRecipient(`file+${A1}@${DOMAIN}`) === A1, 'valid file address → applicationId');
    ok(fileAddr.applicationIdFromRecipient(`FILE+${A1.toUpperCase()}@${DOMAIN.toUpperCase()}`) === A1, 'uppercase address → applicationId (case-insensitive)');
    ok(fileAddr.applicationIdFromRecipient(`wrong-format@${DOMAIN}`) === null, 'malformed local part → null');
    ok(fileAddr.applicationIdFromRecipient(`file+not-a-uuid@${DOMAIN}`) === null, 'non-uuid id → null');
    ok(fileAddr.applicationIdFromRecipient(`file+${A1}@other.example.com`) === null, 'wrong domain → null');
    ok(fileAddr.fileReplyTo(A1) === `file+${A1}@${DOMAIN}`, 'fileReplyTo builds the address');
    ok(fileAddr.fileReplyTo('nope') === null, 'fileReplyTo(bad id) → null');

    // ---------- unit: signature ----------
    console.log('\n# webhook signature');
    const body = JSON.stringify(evt('sig-1', [`file+${A1}@${DOMAIN}`]));
    const h = sign(body);
    ok(webhook.verify(body, h, SECRET).ok === true, 'valid signature verifies');
    ok(webhook.verify(body + ' ', h, SECRET).ok === false, 'tampered body fails');
    ok(webhook.verify(body, Object.assign({}, h, { 'svix-signature': 'v1,deadbeef' }), SECRET).ok === false, 'wrong signature fails');
    ok(webhook.verify(body, { 'svix-id': 'x' }, SECRET).ok === false, 'missing headers fail');
    ok(webhook.verify(body, sign(body, { ts: Math.floor(Date.now() / 1000) - 4000 }), SECRET).ok === false, 'stale timestamp fails (replay window)');

    // ---------- core: processReceivedEvent ----------
    console.log('\n# processReceivedEvent');
    sent = []; sendBehavior = 'ok'; retrievalBehavior = 'ok';
    let r = await fileInbox.processReceivedEvent(evt('test-valid-1', [`file+${A1}@${DOMAIN}`]));
    ok(r.status === 'forwarded' && r.count === 2, 'valid → forwarded to 2 assignees');
    ok(sent.length === 1 && sent[0].to.length === 2, 'one branded forward to both staff');
    ok(sent[0].to.includes(S1email) && sent[0].to.includes(S2email), 'both assignee emails present');
    ok(sent[0].replyTo === `file+${A1}@${DOMAIN}`, 'forward carries the per-file Reply-To (thread continues)');

    sent = [];
    r = await fileInbox.processReceivedEvent(evt('test-upper-1', [`File+${A1.toUpperCase()}@${DOMAIN}`]));
    ok(r.status === 'forwarded', 'uppercase address → forwarded');

    sent = [];
    r = await fileInbox.processReceivedEvent(evt('test-malformed-1', [`hello@${DOMAIN}`]));
    ok(r.status === 'no_file_address' && sent.length === 0, 'malformed address → no forward');

    sent = [];
    r = await fileInbox.processReceivedEvent(evt('test-unknown-1', [`file+${uuid()}@${DOMAIN}`]));
    ok(r.status === 'unknown_app' && sent.length === 0, 'unknown application id → no forward');

    sent = [];
    r = await fileInbox.processReceivedEvent(evt('test-noassign-1', [`file+${A2}@${DOMAIN}`]));
    ok(r.status === 'no_recipients' && sent.length === 0, 'file with no assignees → no forward');

    // duplicate assignee emails (same staffer in two roles) dedups to one address
    await db.query(`INSERT INTO application_assignees (application_id, staff_id, role, is_primary) VALUES ($1,$2,'processor',false)
                    ON CONFLICT DO NOTHING`, [A1, S1]);
    const dedup = await fileInbox.assigneesForFile(A1);
    ok(dedup.length === 2, 'duplicate assignee email deduped (S1 in two roles → 1 unique) + S2 = 2');

    sent = []; retrievalBehavior = 'fail';
    r = await fileInbox.processReceivedEvent(evt('test-retrievefail-1', [`file+${A1}@${DOMAIN}`]));
    ok(r.status === 'retrieval_failed' && sent.length === 0, 'Resend retrieval failure → no forward, handled');
    retrievalBehavior = 'ok';

    sent = []; sendBehavior = 'throw';
    r = await fileInbox.processReceivedEvent(evt('test-forwardfail-1', [`file+${A1}@${DOMAIN}`]));
    ok(r.status === 'forward_failed', 'forwarding failure → handled (no throw out)');
    sendBehavior = 'ok';

    // duplicate email_id (idempotency): same id twice → only one forward
    sent = [];
    const dupId = 'test-dup-1';
    const r1 = await fileInbox.processReceivedEvent(evt(dupId, [`file+${A1}@${DOMAIN}`]));
    const r2 = await fileInbox.processReceivedEvent(evt(dupId, [`file+${A1}@${DOMAIN}`]));
    ok(r1.status === 'forwarded' && r2.status === 'duplicate', 'duplicate email_id → second is a no-op');
    ok(sent.length === 1, 'duplicate email_id forwarded exactly once');

    // record row exists for the file
    const rec = await db.query(`SELECT status, forwarded_count FROM inbound_file_emails WHERE resend_email_id='test-valid-1'`);
    ok(rec.rows[0] && rec.rows[0].status === 'forwarded' && Number(rec.rows[0].forwarded_count) === 2, 'inbound email recorded on the file');

    // attachment path (best-effort) doesn't break the forward
    sent = [];
    cannedEmail = Object.assign({}, cannedEmail, { attachments: [{ id: 'att1', filename: 'a.pdf', content_type: 'application/pdf', size: 3 }] });
    r = await fileInbox.processReceivedEvent(evt('test-attach-1', [`file+${A1}@${DOMAIN}`]));
    ok(r.status === 'forwarded' && sent.length === 1, 'attachment present → still forwards');
    ok(Array.isArray(sent[0].attachments) && sent[0].attachments.length === 1 && sent[0].attachments[0].content, 'attachment retrieved + base64 forwarded');
    cannedEmail = Object.assign({}, cannedEmail, { attachments: [] });

    // ---------- HTTP: signature layer + route ----------
    console.log('\n# HTTP route (signature + mount)');
    const hb = JSON.stringify(evt('test-http-valid-1', [`file+${A1}@${DOMAIN}`]));
    let resp = await post('/api/inbound/file-email', hb, sign(hb));
    ok(resp.status === 200, 'valid signature → 200 (' + resp.status + ')');

    resp = await post('/api/inbound/file-email', hb, { 'svix-id': 'x', 'svix-timestamp': String(Math.floor(Date.now() / 1000)), 'svix-signature': 'v1,bogus' });
    ok(resp.status === 400, 'invalid signature → 400 (' + resp.status + ')');

    // unknown/other file address, valid signature → 200 (no crash, no forward)
    const hb2 = JSON.stringify(evt('test-http-unknown-1', [`file+${uuid()}@${DOMAIN}`]));
    resp = await post('/api/inbound/file-email', hb2, sign(hb2));
    ok(resp.status === 200, 'unknown app with valid signature → 200');

    // existing chat inbound route still works (no reply key → 200 skipped)
    resp = await post('/api/inbound/chat', JSON.stringify({ data: { to: ['nobody@nowhere.test'], text: 'hi' } }), {});
    ok(resp.status === 200, 'existing /api/inbound/chat still returns 200');

    // ---------- outbound: opts.replyTo threading (audit coverage fixes) ----------
    console.log('\n# outbound replyTo threading');
    const catalog = require(REPO + '/src/lib/email/catalog');
    sent = [];
    await catalog.send('borrowerInvite', 'someone@invite.test',
      { firstName: 'T', acceptUrl: 'https://x/accept', hasAccount: false },
      { replyTo: fileAddr.fileReplyTo(A1) });
    ok(sent.length === 1 && sent[0].replyTo === `file+${A1}@${DOMAIN}`, 'catalog.send threads opts.replyTo to the provider');
    sent = [];
    await catalog.send('leadReceived', 'someone@lead.test',
      { firstName: 'T', toolLabel: 'Loan Calculator', officerName: null }, { replyTo: null });
    ok(sent.length === 1 && sent[0].replyTo == null, 'opts.replyTo null → no Reply-To (unchanged behavior)');

    // graph provider forwards replyTo → message.replyTo (fetch stubbed, no network)
    const realFetch = global.fetch;
    let graphBody = null;
    global.fetch = async (url, opts) => {
      if (String(url).includes('oauth2')) return { ok: true, json: async () => ({ access_token: 't', expires_in: 3600 }) };
      graphBody = JSON.parse(opts.body);
      return { ok: true, status: 202, text: async () => '', json: async () => ({}) };
    };
    try {
      const graph = require(REPO + '/src/lib/email/graph');
      await graph.sendMail({ to: 'a@b.test', subject: 's', text: 't', replyTo: `file+${A1}@${DOMAIN}` });
      ok(graphBody && graphBody.message && Array.isArray(graphBody.message.replyTo)
        && graphBody.message.replyTo[0].emailAddress.address === `file+${A1}@${DOMAIN}`,
        'graph provider sets message.replyTo from replyTo');
      graphBody = null;
      await graph.sendMail({ to: 'a@b.test', subject: 's', text: 't' });
      ok(graphBody && graphBody.message && !('replyTo' in graphBody.message), 'graph provider omits replyTo when absent');
    } finally { global.fetch = realFetch; }

  } catch (e) {
    fail++; console.log('  ✗ EXCEPTION', e && e.stack ? e.stack : e);
  } finally {
    // cleanup (FK-safe order)
    try {
      await db.query(`DELETE FROM inbound_file_emails WHERE resend_email_id LIKE 'test-%'`);
      await db.query(`DELETE FROM application_assignees WHERE application_id = ANY($1::uuid[])`, [[A1, A2]]);
      await db.query(`DELETE FROM applications WHERE id = ANY($1::uuid[])`, [[A1, A2]]);
      await db.query(`DELETE FROM borrowers WHERE id=$1`, [B]);
      await db.query(`DELETE FROM staff_users WHERE id = ANY($1::uuid[])`, [[S1, S2]]);
    } catch (e) { console.log('  (cleanup warn)', e.message); }
    server.close();
  }
  console.log(`\n#68 inbound-file-email: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main();
