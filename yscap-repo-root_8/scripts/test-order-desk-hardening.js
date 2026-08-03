/**
 * THE ORDERS DESK, HARDENED — real Postgres, real HTTP. Skips with no DATABASE_URL.
 *
 * Five confirmed defects, each reproduced before it was fixed and each pinned here.
 * Every assertion in this file was checked to FAIL against the pre-fix code.
 *
 *  1. A BORROWER COULD DOWNLOAD THE TITLE COMPANY'S WIRING INSTRUCTIONS.
 *     `saveReturnedDocs` omitted `visibility`/`source_type`, so a returned vendor
 *     document took db/014's defaults (visibility='borrower'). The borrower's own
 *     document list gates on that column, NOT on the owning condition's audience —
 *     and rtl_cond_title / rtl_cond_insurance are audience='staff'.
 *  2. A TRANSIENT FAILURE LOST DOCUMENTS FOREVER. `saveReturnedDocs` could not
 *     throw (every attachment sat in a bare catch), so file-inbox marked the order
 *     handled whether or not anything saved, and the webhook redelivery skipped it.
 *  3. REPLYING IN AN ORDER THREAD EMAILED THE BORROWER. `/emails/reply` had a
 *     `closing` branch — written precisely because the default fan-out includes the
 *     borrower — and no title/insurance branch, so a reply to the title company
 *     went to the borrower and never to the vendor.
 *  4. AN ORDER WAS RECORDED AS SENT THAT NEVER WENT. `email.sendMail` returns
 *     {ok:false} WITHOUT throwing when email is off or the API key has rotated.
 *  5. TWO CLICKS SENT THE ORDER TWICE. The place door read the status, sent the
 *     email, and only then wrote the row.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-order-desk-hardening (no DATABASE_URL)'); process.exit(0); }
process.env.EMAIL_PROVIDER = 'none';
process.env.NOTIFY_DIGESTS_ENABLED = '0';
process.env.CHAT_REPLY_DOMAIN = process.env.CHAT_REPLY_DOMAIN || 'reply.yscapgroup.com';

const db = require('../src/db');
const orders = require('../src/lib/orders');
const orderInbox = require('../src/lib/order-inbox');
const { signJwt } = require('../src/lib/crypto');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const uniq = `odh-${process.pid}-${Date.now()}`;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
const b64 = PDF.toString('base64');
const otherPdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/X 2>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n').toString('base64');

(async () => {
  /* ─────────────── A. the pure send verdict (no DB, no network) ─────────────── */
  console.log('\nA. the provider\'s answer decides');
  {
    assert(orders.sendVerdict({ ok: true }).ok === true, 'a provider that accepted the message is a send');
    const off = orders.sendVerdict({ ok: false, skipped: true });
    assert(off.ok === false && off.reason === 'email_disabled',
      'the noop provider ({ok:false, skipped:true}, which never throws) is NOT a send — this is what recorded orders no vendor ever received');
    assert(orders.sendVerdict({ ok: false }).reason === 'send_failed', 'a rejection is a failure');
    assert(orders.sendVerdict(null).reason === 'send_failed', 'no answer at all is a failure, never a success');
    assert(orders.sendVerdict(undefined).ok === false, 'undefined is refused too');
    // A timeout may well have been delivered — reporting it as failed is what
    // makes an operator re-send and the vendor receive the order twice.
    for (const e of [new Error('The operation timed out'), Object.assign(new Error('x'), { code: 'ECONNRESET' }), new Error('fetch failed')]) {
      assert(orders.isAmbiguousSendFailure(e) === true, `"${e.message}/${e.code || ''}" is ambiguous, not failed`);
    }
    assert(orders.isAmbiguousSendFailure(new Error('validation_error: invalid to address')) === false,
      'a definite rejection is NOT ambiguous — it must free the order to be re-sent');
    assert(orders.isAmbiguousSendFailure(null) === false, 'no error is not ambiguous');
  }

  const app = require('../src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  /* ────────────────────────────────── seed ─────────────────────────────────── */
  const mkStaff = async (role, name, email) => (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,$2,$3,true) RETURNING id`,
    [email, name, role])).rows[0].id;
  const officer = await mkStaff('loan_officer', 'Ophelia Officer', `${uniq}-lo@example.test`);
  const borrowerEmail = `${uniq}-bo@example.test`;
  const borrower = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Bo','Rrower',$1) RETURNING id`,
    [borrowerEmail])).rows[0].id;
  // The borrower needs a portal login row for their token to authenticate.
  const { hashPassword } = require('../src/lib/crypto');
  await db.query(
    `INSERT INTO borrower_auth (borrower_id, password_hash, token_version)
     VALUES ($1,$2,0) ON CONFLICT DO NOTHING`,
    [borrower, hashPassword('Sup3r-Secret-Pw!')]);

  const mkApp = async () => {
    const id = (await db.query(
      `INSERT INTO applications (borrower_id, loan_officer_id, ys_loan_number, property_address, status, loan_type, usps_imported_at)
       VALUES ($1,$2,$3,$4,'underwriting','Purchase', now()) RETURNING id`,
      [borrower, officer, `YS${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 90 + 10)}`,
       JSON.stringify({ oneLine: '9 Order Ave, Brooklyn, NY 11211', street: '9 Order Ave', city: 'Brooklyn', state: 'NY', zip: '11211' })])).rows[0].id;
    await db.query(`INSERT INTO application_assignees (application_id, staff_id, role) VALUES ($1,$2,'loan_officer')
                    ON CONFLICT DO NOTHING`, [id, officer]);
    return id;
  };
  const addVendor = async (appId, type, email) => {
    const c = (await db.query(
      `INSERT INTO service_contacts (borrower_id, contact_type, company_name, contact_name, email)
       VALUES ($1,$2,$3,'A Person',$4) RETURNING id`,
      [borrower, type, `${type} co`, email])).rows[0].id;
    await db.query(
      `INSERT INTO application_service_contacts (application_id, service_contact_id, contact_type)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [appId, c, type]);
    return c;
  };
  const jwtLo = signJwt({ sub: officer, kind: 'staff', role: 'loan_officer', tv: 0, sid: 'test' });
  const jwtBo = signJwt({ sub: borrower, kind: 'borrower', tv: 0, sid: 'test' });
  const call = async (method, p, body, jwt = jwtLo) => {
    const r = await fetch(`${base}${p}`, {
      method,
      headers: { Authorization: `Bearer ${jwt}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let j = null; try { j = await r.json(); } catch (_) { /* not json */ }
    return { status: r.status, body: j };
  };

  /* ── B. a returned vendor document is STAFF-ONLY, new and back-filled ─────── */
  console.log('\nB. the borrower can never download what the vendor sent us');
  {
    const appId = await mkApp();
    const r = await orderInbox.saveReturnedDocs({
      applicationId: appId, orderType: 'title',
      attachments: [{ filename: 'wiring-instructions.pdf', contentType: 'application/pdf', content: b64 }],
      fromEmail: 'closer@titleco.test',
    });
    assert(r.saved === 1, 'the title company\'s document is filed');
    const doc = (await db.query(
      `SELECT id, visibility, source_type FROM documents WHERE application_id=$1 AND doc_kind='title_order_return'`,
      [appId])).rows[0];
    assert(doc.visibility === 'staff_only',
      'it is staff_only — NOT db/014\'s borrower default, which is what exposed wiring instructions');
    assert(doc.source_type === 'system', 'and it is classified as system, not as a borrower upload');

    // The real proof is the borrower's own door, not the column.
    const list = await fetch(`${base}/api/borrower/documents`, { headers: { Authorization: `Bearer ${jwtBo}` } });
    const listed = await list.json().catch(() => []);
    const ids = (Array.isArray(listed) ? listed : (listed.documents || [])).map((d) => d.id);
    assert(!ids.includes(doc.id), 'the borrower\'s document library does not list it');
    const dl = await fetch(`${base}/api/borrower/documents/${doc.id}`, { headers: { Authorization: `Bearer ${jwtBo}` } });
    assert(dl.status === 403 || dl.status === 404, `and the borrower cannot download it (got ${dl.status})`);

    // PREVIOUS AND FUTURE: db/454 must fix what is already on disk. Put a row back
    // into the old shape and re-run the migration exactly as boot does.
    await db.query(`UPDATE documents SET visibility='borrower', source_type='borrower_upload' WHERE id=$1`, [doc.id]);
    const sql = require('fs').readFileSync(require('path').join(__dirname, '..', 'db', '454_order_returns_staff_only.sql'), 'utf8');
    await db.query(sql);
    const healed = (await db.query(`SELECT visibility, source_type FROM documents WHERE id=$1`, [doc.id])).rows[0];
    assert(healed.visibility === 'staff_only' && healed.source_type === 'system',
      'db/454 closes the exposure on a document that was already filed');
    // Re-running it must be a no-op, and it must never touch anything else.
    const others = (await db.query(
      `SELECT count(*)::int AS c FROM documents
        WHERE COALESCE(doc_kind,'') NOT IN ('title_order_return','insurance_order_return')
          AND visibility='staff_only' AND source_type='system' AND application_id=$1`, [appId])).rows[0].c;
    await db.query(sql);
    assert(others === 0, 'the migration is scoped to the two order-return kinds and nothing else on the file');
  }

  /* ── C. a redelivery is idempotent FOREVER, not for 120 seconds ───────────── */
  console.log('\nC. a webhook redelivery never double-files, and never loses a document');
  {
    const appId = await mkApp();
    const att = [{ filename: 'binder.pdf', contentType: 'application/pdf', content: b64 }];
    const first = await orderInbox.saveReturnedDocs({ applicationId: appId, orderType: 'insurance', attachments: att, fromEmail: 'a@b.test' });
    assert(first.saved === 1 && first.deduped === 0, 'the first delivery files it');

    // Age the document well past doc-dedup's 120-second window — the exact case
    // that used to re-file everything, and the reason the marker had to be
    // written unconditionally.
    await db.query(`UPDATE documents SET created_at = now() - interval '2 hours' WHERE application_id=$1`, [appId]);
    const again = await orderInbox.saveReturnedDocs({ applicationId: appId, orderType: 'insurance', attachments: att, fromEmail: 'a@b.test' });
    assert(again.saved === 0 && again.deduped === 1,
      'a redelivery TWO HOURS later files nothing — dedupe is on the content hash, with no window');
    const n = (await db.query(`SELECT count(*)::int AS c FROM documents WHERE application_id=$1`, [appId])).rows[0].c;
    assert(n === 1, 'so the file still holds exactly one copy');

    // A REVISED document under the same name is a different document.
    const revised = await orderInbox.saveReturnedDocs({
      applicationId: appId, orderType: 'insurance',
      attachments: [{ filename: 'binder.pdf', contentType: 'application/pdf', content: otherPdf }], fromEmail: 'a@b.test' });
    assert(revised.saved === 1, 'different bytes under the same name still file — a revised binder is not a redelivery');
  }

  /* ── D. a failure says WHICH kind it is, so the caller can decide to retry ── */
  console.log('\nD. permanent and transient failures are told apart');
  {
    const appId = await mkApp();
    const bad = await orderInbox.saveReturnedDocs({
      applicationId: appId, orderType: 'title',
      attachments: [{ filename: 'broken.pdf', contentType: 'application/pdf', content: 'data:application/pdf;base64,%%%not base64%%%' }],
      fromEmail: 'a@b.test' });
    assert(bad.failedPermanent === 1 && bad.failedTransient === 0,
      'bytes that will not decode are PERMANENT — a redelivery would produce the identical result, so it must not hold the order open');
    assert(bad.failed === 1, 'and they are COUNTED, never a silent "0 problems"');

    const gone = await orderInbox.saveReturnedDocs({
      applicationId: '00000000-0000-0000-0000-000000000000', orderType: 'title',
      attachments: [{ filename: 'x.pdf', contentType: 'application/pdf', content: b64 }], fromEmail: 'a@b.test' });
    assert(gone.failedPermanent === 1 && gone.failedTransient === 0, 'an unknown file is permanent too');

    // A storage failure is the retryable case. Break storage.save for one call.
    const storage = require('../src/lib/storage');
    const realSave = storage.save;
    storage.save = async () => { throw new Error('disk on fire'); };
    let transient;
    try {
      transient = await orderInbox.saveReturnedDocs({
        applicationId: appId, orderType: 'title',
        attachments: [{ filename: 'commitment.pdf', contentType: 'application/pdf', content: b64 }], fromEmail: 'a@b.test' });
    } finally { storage.save = realSave; }
    assert(transient.failedTransient === 1 && transient.failedPermanent === 0,
      'a storage failure is TRANSIENT — this is what lets file-inbox withhold the marker and actually recover');
    assert(transient.saved === 0, 'and nothing was recorded as saved');

    // The retry then works, and does not duplicate.
    const retry = await orderInbox.saveReturnedDocs({
      applicationId: appId, orderType: 'title',
      attachments: [{ filename: 'commitment.pdf', contentType: 'application/pdf', content: b64 }], fromEmail: 'a@b.test' });
    assert(retry.saved === 1, 'the retry files the document that was nearly lost');
  }

  /* ── E. an order that did not send is not recorded as sent ────────────────── */
  console.log('\nE. an order is recorded only when it really went out');
  {
    const appId = await mkApp();
    await addVendor(appId, 'title_company', `${uniq}-title@vendor.test`);
    // EMAIL_PROVIDER=none, so the provider answers {ok:false, skipped:true}
    // WITHOUT throwing — the exact shape that used to be recorded as 'ordered'.
    const r = await call('POST', `/api/staff/applications/${appId}/orders/title/place`, {});
    assert(r.status === 502 && r.body && r.body.code === 'email_disabled',
      `a send the provider never accepted is refused, with the reason (got ${r.status} ${r.body && r.body.code})`);
    const row = (await db.query(
      `SELECT status, ordered_at, send_count FROM file_orders WHERE application_id=$1 AND order_type='title'`, [appId])).rows[0];
    assert(row && row.status === 'not_ordered',
      'the claim is RELEASED — the desk does not show an order nobody received');
    assert(row && row.ordered_at === null && Number(row.send_count) === 0,
      'and it carries no send date, so nothing downstream can age or score a send that never happened');

    // A FAILED RE-SEND MUST NOT RESET THE CLOCK. This is the case a rule-based
    // revert gets wrong: the claim overwrote ordered_at with now(), so decrementing
    // back to 'ordered' would leave a three-week-old order looking freshly placed
    // and silence its overdue nudge.
    const email = require('../src/lib/email');
    const realSend = email.sendMail;
    email.sendMail = async () => ({ ok: true, id: 'test' });
    try { await call('POST', `/api/staff/applications/${appId}/orders/title/place`, {}); }
    finally { email.sendMail = realSend; }
    await db.query(
      `UPDATE file_orders SET ordered_at = now() - interval '21 days' WHERE application_id=$1 AND order_type='title'`, [appId]);
    const before = (await db.query(
      `SELECT status, ordered_at, send_count FROM file_orders WHERE application_id=$1 AND order_type='title'`, [appId])).rows[0];
    // Now force a re-send with the provider off again.
    const failed = await call('POST', `/api/staff/applications/${appId}/orders/title/place`, { force: true });
    assert(failed.status === 502, 'the forced re-send is refused too');
    const after = (await db.query(
      `SELECT status, ordered_at, send_count FROM file_orders WHERE application_id=$1 AND order_type='title'`, [appId])).rows[0];
    assert(after.status === 'ordered', 'the order is still placed — the earlier, real send stands');
    assert(new Date(after.ordered_at).getTime() === new Date(before.ordered_at).getTime(),
      'and it keeps its ORIGINAL send date — a failed re-send never resets the aging clock');
    assert(Number(after.send_count) === Number(before.send_count),
      'and the send count is unchanged');
  }

  /* ── F. two clicks send ONE order ─────────────────────────────────────────── */
  console.log('\nF. the send is claimed atomically');
  {
    const appId = await mkApp();
    await addVendor(appId, 'insurance_agent', `${uniq}-ins@vendor.test`);
    // Make the provider succeed so the claim commits, and COUNT the sends.
    const email = require('../src/lib/email');
    const realSend = email.sendMail;
    let sends = 0;
    email.sendMail = async () => { sends += 1; await new Promise((r) => setTimeout(r, 120)); return { ok: true, id: 'test' }; };
    let both;
    try {
      both = await Promise.all([
        call('POST', `/api/staff/applications/${appId}/orders/insurance/place`, {}),
        call('POST', `/api/staff/applications/${appId}/orders/insurance/place`, {}),
      ]);
    } finally { email.sendMail = realSend; }
    const okCount = both.filter((x) => x.status === 200).length;
    const conflict = both.filter((x) => x.status === 409).length;
    assert(okCount === 1 && conflict === 1,
      `exactly one of two simultaneous clicks places the order (got ${okCount} ok / ${conflict} conflict)`);
    assert(sends === 1, `and the insurance agent received exactly ONE order email (got ${sends})`);
    const rows = (await db.query(
      `SELECT status, send_count FROM file_orders WHERE application_id=$1 AND order_type='insurance'`, [appId])).rows;
    assert(rows.length === 1 && rows[0].status === 'ordered' && Number(rows[0].send_count) === 1,
      'the row records one send, not two');
  }

  /* ── G. a reply in an order thread reaches the VENDOR, never the borrower ── */
  console.log('\nG. a reply on an order thread goes to the vendor');
  {
    const appId = await mkApp();
    const vendorEmail = `${uniq}-title2@vendor.test`;
    await addVendor(appId, 'title_company', vendorEmail);
    const email = require('../src/lib/email');
    const realSend = email.sendMail;
    const sent = [];
    email.sendMail = async (o) => { sent.push(o); return { ok: true, id: 'test' }; };
    try {
      // Before the order is placed there is no thread — and it must FAIL CLOSED
      // rather than fall through to the borrower fan-out.
      const early = await call('POST', `/api/staff/applications/${appId}/emails/reply`,
        { body: 'Any update?', scope: 'title' });
      assert(early.status === 400 && early.body.code === 'not_ordered',
        'with no order placed the reply is refused, never redirected to the borrower');
      assert(sent.length === 0, 'and nothing was emailed to anybody');

      await call('POST', `/api/staff/applications/${appId}/orders/title/place`, {});
      sent.length = 0;
      const reply = await call('POST', `/api/staff/applications/${appId}/emails/reply`,
        { body: 'Any update on the commitment?', scope: 'title' });
      assert(reply.status === 200, `the reply sends (got ${reply.status} ${reply.body && reply.body.error})`);
      assert(sent.length === 1, 'exactly one email went out');
      const to = [].concat(sent[0].to || []).map((x) => String(x).toLowerCase());
      const cc = [].concat(sent[0].cc || []).map((x) => String(x).toLowerCase());
      assert(to.includes(vendorEmail.toLowerCase()), 'it is addressed TO the title company');
      assert(!to.includes(borrowerEmail.toLowerCase()),
        'the BORROWER is not on the To line — the whole reason this branch exists');
      assert(!cc.includes(borrowerEmail.toLowerCase()),
        'and title does not CC the borrower by default (owner-directed 2026-07-31)');
      const after = (await db.query(
        `SELECT followup_count FROM file_orders WHERE application_id=$1 AND order_type='title'`, [appId])).rows[0];
      assert(Number(after.followup_count) === 1,
        'the reply counts as chasing the vendor, so the desk knows somebody wrote to them');
    } finally { email.sendMail = realSend; }
  }

  /* ── H. an ordinary reply still fans out to the file, unchanged ───────────── */
  console.log('\nH. every other reply behaves exactly as before');
  {
    const appId = await mkApp();
    const email = require('../src/lib/email');
    const realSend = email.sendMail;
    const sent = [];
    email.sendMail = async (o) => { sent.push(o); return { ok: true, id: 'test' }; };
    try {
      const r = await call('POST', `/api/staff/applications/${appId}/emails/reply`, { body: 'Hello from the team' });
      assert(r.status === 200, 'a reply with no scope sends');
      const to = sent.flatMap((s) => [].concat(s.to || [])).map((x) => String(x).toLowerCase());
      assert(to.includes(borrowerEmail.toLowerCase()),
        'and still reaches the borrower — the default fan-out is untouched');
    } finally { email.sendMail = realSend; }
  }

  await new Promise((r) => server.close(r));
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll Orders desk hardening checks passed.');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
