'use strict';
/**
 * THE LOGIN-FREE CONDITION CENTER — guest condition links (owner-directed
 * 2026-08-28), over a REAL Postgres and REAL HTTP. Skips with no DATABASE_URL.
 *
 * The whole safety story of this feature is that an EMAILED LINK becomes a
 * borrower session in a JAIL, so what this test pins is the jail:
 *
 *   A. THE EXCHANGE — the emailed token becomes a session; junk/expired/revoked
 *      tokens do not.
 *   B. THE JAIL — a guest session reads THIS file's checklist and file header
 *      and NOTHING else: another application 404s under ownership, the profile,
 *      chat and credential doors answer 403 before any route runs, and the SSE
 *      stream refuses the token outright.
 *   C. PII NEVER LEAVES — the responses a guest can read carry no SSN, DOB or
 *      card fields (the same scrub a helper session gets).
 *   D. THE WORK LANDS — an upload through the guest door files a real PENDING
 *      document on the right condition; an info answer writes through the same
 *      governed door the portal uses and flips the condition to received.
 *   E. REVOCATION KILLS LIVE SESSIONS — the very next request after a revoke is
 *      refused; an expired link refuses the exchange.
 *   F. THE STAFF OUTREACH — the preview names the borrower, co-borrower and
 *      HELPERS; the send mints one link per recipient (each email carries its
 *      OWN token; the co-borrower's link opens the co-borrower's identity), the
 *      Reply-To is the file's own address so replies land in the file's email
 *      chain, and a parked (on-hold) file refuses to send.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-condition-links-db (no DATABASE_URL)'); process.exit(0); }
process.env.EMAIL_PROVIDER = 'none';
process.env.NOTIFY_DIGESTS_ENABLED = '0';
process.env.APP_URL = process.env.APP_URL || 'https://pilot.example.test';
process.env.CHAT_REPLY_DOMAIN = process.env.CHAT_REPLY_DOMAIN || 'reply.yscapgroup.com';

const db = require('../src/db');
const conditionLink = require('../src/lib/condition-link');
const { signJwt } = require('../src/lib/crypto');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const uniq = `gcl-${process.pid}-${Date.now()}`;

(async () => {
  const app = require('../src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // ── the file: borrower + co-borrower + a helper each, an officer, conditions ─
  const officer = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Olive Officer','loan_officer',true) RETURNING id`,
    [`${uniq}-lo@example.test`])).rows[0].id;
  const borrower = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email,date_of_birth,fico) VALUES ('Gina','Guest',$1,'1980-01-02',701) RETURNING id`,
    [`${uniq}-bo@example.test`])).rows[0].id;
  const coBorrower = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Coby','Guest',$1) RETURNING id`,
    [`${uniq}-co@example.test`])).rows[0].id;
  await db.query(
    `INSERT INTO borrower_assistants (borrower_id,email,name,invited_by_self) VALUES ($1,$2,'Hana Helper',true)`,
    [borrower, `${uniq}-helper@example.test`]);
  const mkApp = async (status = 'underwriting') => (await db.query(
    `INSERT INTO applications (borrower_id, co_borrower_id, loan_officer_id, ys_loan_number, property_address, status, loan_type)
     VALUES ($1,$2,$3,$4,'{"oneLine":"7 Guest Grove, Brooklyn, NY 11211"}','${status}','Purchase') RETURNING id`,
    [borrower, coBorrower, officer, `YS${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 90 + 10)}`])).rows[0].id;
  const appId = await mkApp();
  const otherApp = await mkApp();   // the SAME borrower's other file — the jail still holds
  const mkItem = (aid, label, extra = {}) => db.query(
    `INSERT INTO checklist_items (scope,application_id,label,borrower_label,audience,item_kind,is_required,status,tool_key,field_key)
     VALUES ('application',$1,$2,$2,'borrower','document',true,'outstanding',$3,$4) RETURNING id`,
    [aid, label, extra.toolKey || null, extra.fieldKey || null]).then((r) => r.rows[0].id);
  const upItem = await mkItem(appId, 'Purchase contract');
  const infoItem = await mkItem(appId, 'What is the purchase price?', { toolKey: 'info_field', fieldKey: 'purchase_price' });
  // An item nothing in this test answers — the one that MUST still be on the
  // outstanding list when the outreach preview runs (the two above will have
  // moved to in-review by then, which correctly takes them OFF that list).
  await mkItem(appId, 'Government issued ID card');
  await mkItem(otherApp, 'Other-file item');

  const call = async (method, p, token, body, headers) => {
    const r = await fetch(`${base}${p}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}), ...(headers || {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let j = null; try { j = await r.json(); } catch (_) { /* not json */ }
    return { status: r.status, body: j };
  };

  // ── A. THE EXCHANGE ────────────────────────────────────────────────────────
  const { link, token: clearToken } = await conditionLink.mintLink({
    applicationId: appId, borrowerId: borrower, email: `${uniq}-bo@example.test`, createdBy: officer });
  let guestJwt;
  {
    const r = await call('POST', '/auth/condition-link', null, { token: clearToken });
    ok(r.status === 200 && r.body.ok && r.body.accessToken, 'the emailed token exchanges for a session');
    ok(r.body.applicationId === appId, 'the exchange names the linked file');
    guestJwt = r.body.accessToken;
    const junk = await call('POST', '/auth/condition-link', null, { token: 'not-a-real-token-aaaaaaaa' });
    ok(junk.status === 404, 'a junk token is refused');
    const stored = (await db.query(`SELECT token_hash FROM condition_links WHERE id=$1`, [link.id])).rows[0];
    ok(stored.token_hash !== clearToken && stored.token_hash.length === 64, 'the clear token is never stored — only its hash');
  }

  // ── B. THE JAIL ────────────────────────────────────────────────────────────
  {
    const list = await call('GET', `/api/borrower/applications/${appId}/checklist`, guestJwt);
    ok(list.status === 200 && Array.isArray(list.body), 'the guest reads THIS file’s condition list');
    ok(list.body.some((it) => it.label === 'Purchase contract'), '…and the real conditions are on it');
    const head = await call('GET', `/api/borrower/applications/${appId}`, guestJwt);
    ok(head.status === 200, 'the guest reads THIS file’s header');
    const other = await call('GET', `/api/borrower/applications/${otherApp}/checklist`, guestJwt);
    ok(other.status === 403, 'the SAME borrower’s OTHER file is refused — the link is per file, not per person');
    const profile = await call('GET', '/api/borrower/profile', guestJwt);
    ok(profile.status === 403, 'the profile door is closed');
    const me = await call('GET', '/auth/me', guestJwt);
    ok(me.status === 403, 'the /auth surface is closed');
    const logout = await call('POST', '/auth/logout', guestJwt);
    ok(logout.status === 403, 'the credential doors are closed');
    const sse = await call('GET', `/api/events?token=${encodeURIComponent(guestJwt)}`);
    ok(sse.status === 403, 'the live event stream refuses a guest token (the one authenticate() bypass)');
  }

  // ── C. PII NEVER LEAVES ────────────────────────────────────────────────────
  {
    const head = await call('GET', `/api/borrower/applications/${appId}`, guestJwt);
    const s = JSON.stringify(head.body);
    ok(!/date_of_birth|"dob"|"ssn"|ssn_last4|card_last4/.test(s), 'the file header carries no DOB / SSN / card fields');
    ok(!/"fico"\s*:\s*701/.test(s), 'the borrower’s credit score value does not leave through a guest link');
  }

  // ── D. THE WORK LANDS ──────────────────────────────────────────────────────
  {
    const up = await call('POST', '/api/borrower/documents', guestJwt, {
      applicationId: appId, checklistItemId: upItem,
      filename: 'contract.pdf', contentType: 'application/pdf',
      dataBase64: Buffer.from('%PDF-1.4 guest contract bytes').toString('base64'),
    });
    ok(up.status === 201 && up.body.documentId, 'an upload through the guest door lands');
    const doc = (await db.query(`SELECT * FROM documents WHERE id=$1`, [up.body.documentId])).rows[0];
    ok(doc && doc.checklist_item_id === upItem && doc.application_id === appId,
      '…on the right condition of the right file');
    ok(doc.review_status === 'pending' && doc.uploaded_by_kind === 'borrower',
      '…born PENDING like every borrower upload — a guest upload still waits for a reviewer');
    const cross = await call('POST', '/api/borrower/documents', guestJwt, {
      applicationId: otherApp, checklistItemId: upItem,
      filename: 'x.pdf', dataBase64: Buffer.from('x').toString('base64'),
    });
    ok(cross.status === 403, 'an upload aimed at another file is refused by the jail');
    const llcTry = await call('POST', '/api/borrower/documents', guestJwt, {
      applicationId: appId, llcId: '11111111-1111-1111-1111-111111111111',
      filename: 'x.pdf', dataBase64: Buffer.from('x').toString('base64'),
    });
    ok(llcTry.status === 403, 'an LLC-scoped upload is refused — the guest door is conditions on this file only');

    const info = await call('POST', `/api/borrower/applications/${appId}/checklist/${infoItem}/info`, guestJwt,
      { value: 450000 });
    ok(info.status === 200, 'an information answer saves through the governed portal door');
    const after = (await db.query(`SELECT status FROM checklist_items WHERE id=$1`, [infoItem])).rows[0];
    ok(after && after.status === 'received', '…and the condition moves to received');
    const written = (await db.query(`SELECT purchase_price FROM applications WHERE id=$1`, [appId])).rows[0];
    ok(written && Number(written.purchase_price) === 450000, '…and the value is ON THE FILE — saved directly, no login');
  }

  // ── E. REVOCATION / EXPIRY ─────────────────────────────────────────────────
  {
    await db.query(`UPDATE condition_links SET revoked_at=now() WHERE id=$1`, [link.id]);
    const dead = await call('GET', `/api/borrower/applications/${appId}/checklist`, guestJwt);
    ok(dead.status === 401, 'revoking the link kills the LIVE session on its very next request');
    const reuse = await call('POST', '/auth/condition-link', null, { token: clearToken });
    ok(reuse.status === 404, '…and the emailed token can never be exchanged again');
    const { link: exp, token: expTok } = await conditionLink.mintLink({
      applicationId: appId, borrowerId: borrower, email: `${uniq}-bo@example.test`, createdBy: officer });
    await db.query(`UPDATE condition_links SET expires_at=now() - interval '1 minute' WHERE id=$1`, [exp.id]);
    const late = await call('POST', '/auth/condition-link', null, { token: expTok });
    ok(late.status === 404, 'an expired link refuses the exchange');
  }

  // ── F. THE STAFF OUTREACH ──────────────────────────────────────────────────
  const staffJwt = signJwt({ sub: officer, kind: 'staff', role: 'loan_officer', tv: 0, sid: 'test' });
  {
    const pv = await call('GET', `/api/staff/applications/${appId}/conditions/outreach`, staffJwt);
    ok(pv.status === 200, 'the outreach preview answers');
    const kinds = Object.fromEntries(pv.body.recipients.map((r) => [r.kind, r.email]));
    ok(kinds.borrower === `${uniq}-bo@example.test` && kinds.co_borrower === `${uniq}-co@example.test`,
      'the preview names the borrower and the co-borrower');
    ok(kinds.helper === `${uniq}-helper@example.test`, '…and the HELPER on file, so they can be looped in');
    ok(pv.body.items.some((it) => it.label === 'Government issued ID card'), 'the preview lists the real outstanding items');
    ok(!pv.body.items.some((it) => it.label === 'Purchase contract'),
      '…and an item whose document is in review is NOT nagged for again');
    ok(String(pv.body.replyTo || '').startsWith(`file+${appId}@`),
      'replies go to the FILE’s own address — straight into its email chain');
    ok(/Subject:|What your loan still needs/.test(`${pv.body.preview.subject}`), 'the preview carries the email as it will send');

    // The send — with the provider stubbed to capture what actually goes out.
    const email = require('../src/lib/email');
    const realSend = email.sendMail;
    const outbox = [];
    email.sendMail = async (opts) => { outbox.push(opts); return { ok: true, id: `m${outbox.length}` }; };
    let sendRes;
    try {
      sendRes = await call('POST', `/api/staff/applications/${appId}/conditions/outreach`, staffJwt, {
        emails: [`${uniq}-bo@example.test`, `${uniq}-co@example.test`, `${uniq}-helper@example.test`],
        note: 'Quick note from your loan team.',
      });
    } finally { email.sendMail = realSend; }
    ok(sendRes.status === 200 && sendRes.body.ok && sendRes.body.sent.length === 3, 'the send reaches all three recipients');
    ok(outbox.length === 3, 'three separate emails went out — one per recipient');
    const urls = outbox.map((o) => (String(o.text).match(/\/link\/r\?to=[^\s)]+/) || [''])[0]);
    ok(urls.every(Boolean) && new Set(urls).size === 3, 'each email carries its OWN personal link — never a shared token');
    ok(outbox.every((o) => String(o.replyTo || '').startsWith(`file+${appId}@`)), 'every email replies into the file’s chain');
    ok(outbox.every((o) => /Quick note from your loan team/.test(o.text)), 'the sender’s note rides on top');
    ok(outbox.every((o) => /Government issued ID card/.test(o.text)), 'the numbered outstanding list is in the body');
    // Every checklist item carries its own DIRECT link, and each recipient's
    // per-item links carry THEIR token (the same one as their main button).
    ok(outbox.every((o) => (String(o.text).match(/Upload \/ fill this one in: /g) || []).length >= 1),
      'every condition in the email has its own direct upload/fill link');
    ok(outbox.every((o) => {
      // The links are /link/r bounces, so the token rides URL-encoded (t%3D…).
      const toks = [...String(o.text).matchAll(/t%3D([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
      return toks.length >= 2 && new Set(toks).size === 1;
    }), 'a recipient’s per-item links all carry THEIR own token');

    // WHOSE view each link opens: the co-borrower's email got the CO's identity.
    const links = (await db.query(
      `SELECT sent_to_email, borrower_id FROM condition_links WHERE application_id=$1 AND revoked_at IS NULL ORDER BY created_at`,
      [appId])).rows;
    const coLink = links.find((l) => l.sent_to_email === `${uniq}-co@example.test`);
    const helperLink = links.find((l) => l.sent_to_email === `${uniq}-helper@example.test`);
    ok(coLink && coLink.borrower_id === coBorrower, 'the co-borrower’s link opens the CO-borrower’s identity (per-borrower privacy)');
    ok(helperLink && helperLink.borrower_id === borrower, 'the primary’s helper gets the primary borrower’s view');

    // A parked file sends nothing.
    await db.query(`UPDATE applications SET status='on_hold' WHERE id=$1`, [appId]);
    const held = await call('POST', `/api/staff/applications/${appId}/conditions/outreach`, staffJwt,
      { emails: [`${uniq}-bo@example.test`] });
    ok(held.status === 409, 'a file on hold refuses the outreach — a parked file emails nobody');
    await db.query(`UPDATE applications SET status='underwriting' WHERE id=$1`, [appId]);

    // Revoke through the staff door.
    const linkRow = (await db.query(
      `SELECT id FROM condition_links WHERE application_id=$1 AND revoked_at IS NULL LIMIT 1`, [appId])).rows[0];
    const rv = await call('POST', `/api/staff/applications/${appId}/conditions/outreach/${linkRow.id}/revoke`, staffJwt);
    ok(rv.status === 200, 'staff can revoke a link that should not be out there');
  }

  await new Promise((r) => server.close(r));
  await db.pool.end().catch(() => {});
  if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
  console.log('\nAll guest condition-link checks passed.');
})().catch((e) => { console.error(e); process.exit(1); });
