/**
 * Email Center (db/182 + src/lib/email-log.js + the /emails routes).
 *
 * Exercises the capture + history + reply layer end-to-end against a real
 * Postgres with migrations applied. Skips cleanly when there's no DATABASE_URL.
 *
 * Covers:
 *   · unit helpers (normalizeSubject / threadKeyFor collapse Re:/Fwd: + tag)
 *   · backfillEmailHistoryOnce mirrors historical notifications (status mapped,
 *     reconstructed=true, idempotent)
 *   · captureOutbound stores a full body + is idempotent per notification_id
 *   · captureInbound stores a body, then ON CONFLICT refines status yet KEEPS body
 *   · renderHistoricalBody re-renders a branded body from a bare notification
 *   · GET /applications/:id/emails (per-file list, scoped)
 *   · GET /applications/:id/emails/:msgId (on-demand render of a historical row)
 *   · GET /emails + /emails/stats (global mailbox, visibility-scoped)
 *   · POST /applications/:id/emails/reply (sends to file parties, captured)
 *   · visibility: an unassigned officer can NOT see another file's mail
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-email-history (no DATABASE_URL)'); process.exit(0); }
process.env.EMAIL_PROVIDER = process.env.EMAIL_PROVIDER || 'none';
process.env.APP_URL = process.env.APP_URL || 'https://track.example';   // enables the open-tracking pixel

const db = require('../src/db');
const emailLog = require('../src/lib/email-log');
const { signJwt } = require('../src/lib/crypto');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const uniq = `eh-${process.pid}-${Date.now()}`;

(async () => {
  // ---- unit helpers (no DB) ----
  assert(emailLog.normalizeSubject('Re: Fwd: Hello · YS-1042 · 123 Main St') === 'hello',
    'normalizeSubject strips Re:/Fwd: + subject tag');
  assert(emailLog.threadKeyFor('11111111-1111-1111-1111-111111111111', 'Re: Hello · YS-1 · X')
      === emailLog.threadKeyFor('11111111-1111-1111-1111-111111111111', 'Hello'),
    'threadKeyFor threads a reply onto its original');

  // ---- seed ----
  const app = require('../src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const officer = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Ophelia Officer','loan_officer',true) RETURNING id`,
    [`${uniq}-lo@example.test`])).rows[0].id;
  const other = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Otto Other','loan_officer',true) RETURNING id`,
    [`${uniq}-other@example.test`])).rows[0].id;
  const admin = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Adah Admin','admin',true) RETURNING id`,
    [`${uniq}-admin@example.test`])).rows[0].id;
  const borrower = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Bo','Rrower',$1) RETURNING id`,
    [`${uniq}-bo@example.test`])).rows[0].id;
  const appId = (await db.query(
    `INSERT INTO applications (borrower_id, loan_officer_id, ys_loan_number, property_address, status)
     VALUES ($1,$2,$3,$4,'processing') RETURNING id`,
    [borrower, officer, `YS-${process.pid % 100000}`, JSON.stringify({ oneLine: '123 Main St, Anytown, NY', street: '123 Main St' })])).rows[0].id;
  // the officer is an active assignee (the trigger normally does this; assert-friendly explicit insert)
  await db.query(
    `INSERT INTO application_assignees (application_id, staff_id, role) VALUES ($1,$2,'loan_officer')
     ON CONFLICT DO NOTHING`, [appId, officer]);

  // two historical notifications (one emailed, one in-app only) + a borrower one
  const nStaffSent = (await db.query(
    `INSERT INTO notifications (recipient_kind,staff_id,type,title,body,application_id,email_status,emailed_at)
     VALUES ('staff',$1,'status_change','Status moved to Processing','The file advanced.',$2,'sent',now()) RETURNING id`,
    [officer, appId])).rows[0].id;
  const nBorrowerInApp = (await db.query(
    `INSERT INTO notifications (recipient_kind,borrower_id,type,title,body,application_id,email_status)
     VALUES ('borrower',$1,'doc_uploaded','A document was added','We uploaded a file for you.',$2,'skipped') RETURNING id`,
    [borrower, appId])).rows[0].id;

  // ---- backfill ----
  const bf = await emailLog.backfillEmailHistoryOnce(1000);
  assert(bf.notifs >= 2, `backfill mirrored historical notifications (${bf.notifs})`);
  const bfRows = await db.query(
    `SELECT notification_id, status, reconstructed, direction, subject FROM email_messages WHERE application_id=$1 ORDER BY occurred_at`, [appId]);
  const sentRow = bfRows.rows.find((r) => r.notification_id === nStaffSent);
  const inAppRow = bfRows.rows.find((r) => r.notification_id === nBorrowerInApp);
  assert(sentRow && sentRow.status === 'sent' && sentRow.reconstructed === true, 'historical emailed notification mirrored as sent+reconstructed');
  assert(inAppRow && inAppRow.status === 'skipped', 'historical in-app-only notification mirrored as skipped');
  const before = (await db.query(`SELECT count(*)::int c FROM email_messages`)).rows[0].c;
  await emailLog.backfillEmailHistoryOnce(1000);
  const after = (await db.query(`SELECT count(*)::int c FROM email_messages`)).rows[0].c;
  assert(before === after, 'backfill is idempotent (no duplicate rows on re-run)');

  // ---- captureOutbound (full body, live send) ----
  const nLive = (await db.query(
    `INSERT INTO notifications (recipient_kind,staff_id,type,title,body,application_id,email_status)
     VALUES ('staff',$1,'message','New message','A live one.',$2,'pending') RETURNING id`, [officer, appId])).rows[0].id;
  await emailLog.captureOutbound(
    { to: [`${uniq}-lo@example.test`], subject: 'New message · YS-1 · 123 Main St', html: '<h1>Hi</h1><p>Body here</p>', text: 'Hi\nBody here', replyTo: `file+${appId}@reply.example` },
    { applicationId: appId, notificationId: nLive, type: 'message', audience: 'staff', status: 'sent', providerId: 'prov_1' });
  const live = (await db.query(`SELECT body_html, status, provider_message_id FROM email_messages WHERE notification_id=$1`, [nLive])).rows[0];
  assert(live && live.body_html && live.body_html.includes('Body here') && live.status === 'sent', 'captureOutbound stored the full body + status');
  await emailLog.captureOutbound(
    { to: [`${uniq}-lo@example.test`], subject: 'New message', html: '<p>again</p>' },
    { applicationId: appId, notificationId: nLive, type: 'message', audience: 'staff', status: 'sent', providerId: 'prov_2' });
  const dupCount = (await db.query(`SELECT count(*)::int c FROM email_messages WHERE notification_id=$1`, [nLive])).rows[0].c;
  assert(dupCount === 1, 'captureOutbound is idempotent per notification_id (ON CONFLICT update)');

  // ---- captureInbound (body, then status refine keeps body) ----
  const inbId = (await db.query(
    `INSERT INTO inbound_file_emails (resend_email_id, application_id, from_email, subject, status)
     VALUES ($1,$2,$3,'Re: your file','received') RETURNING id`,
    [`${uniq}-resend`, appId, `${uniq}-bo@example.test`])).rows[0].id;
  await emailLog.captureInbound({ inboundId: inbId, applicationId: appId, from: `${uniq}-bo@example.test`, subject: 'Re: your file', html: '<p>my reply</p>', text: 'my reply', status: 'received' });
  await emailLog.captureInbound({ inboundId: inbId, applicationId: appId, from: `${uniq}-bo@example.test`, subject: 'Re: your file', status: 'forwarded', forwardedTo: [`${uniq}-lo@example.test`] });
  const inbRow = (await db.query(`SELECT body_text, status, direction, meta FROM email_messages WHERE inbound_id=$1`, [inbId])).rows[0];
  assert(inbRow && inbRow.direction === 'inbound' && inbRow.body_text === 'my reply' && inbRow.status === 'forwarded',
    'captureInbound stored body, then refined status to forwarded WITHOUT losing the body');

  // ---- fan-out consolidation: the SAME email to two staffers is ONE message ----
  await emailLog.captureOutbound({ to: [`${uniq}-lo@example.test`], subject: 'Team update · YS-1', html: '<p>x</p>', replyTo: `file+${appId}@r.test` },
    { applicationId: appId, type: 'status_change', audience: 'staff', status: 'sent' });
  await emailLog.captureOutbound({ to: [`${uniq}-other@example.test`], subject: 'Team update · YS-1', html: '<p>x</p>', replyTo: `file+${appId}@r.test` },
    { applicationId: appId, type: 'status_change', audience: 'staff', status: 'skipped' });

  // ---- renderHistoricalBody ----
  const built = await emailLog.renderHistoricalBody(nStaffSent);
  assert(built && built.html && /Status moved to Processing/i.test(built.html), 'renderHistoricalBody re-renders a branded body from a bare notification');

  // ---- HTTP ----
  const loTok = signJwt({ sub: officer, kind: 'staff', role: 'loan_officer', tv: 0 });
  const otherTok = signJwt({ sub: other, kind: 'staff', role: 'loan_officer', tv: 0 });
  const adminTok = signJwt({ sub: admin, kind: 'staff', role: 'admin', tv: 0 });
  const get = (path, tok) => fetch(base + path, { headers: { Authorization: `Bearer ${tok}` } });
  const post = (path, tok, body) => fetch(base + path, { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  // per-file list (assigned officer)
  const listRes = await get(`/api/staff/applications/${appId}/emails`, loTok);
  const list = await listRes.json();
  assert(listRes.status === 200 && Array.isArray(list) && list.length >= 3, `per-file list returns rows (${list.length})`);
  assert(list.some((r) => r.direction === 'inbound') && list.some((r) => r.direction === 'outbound'), 'per-file list has both inbound + outbound');
  // the fan-out to two staffers consolidates into ONE message listing both, each
  // with its own delivery status
  const fanout = list.find((r) => (r.subject || '').startsWith('Team update'));
  assert(fanout && Array.isArray(fanout.recipients) && fanout.recipients.length === 2, `fan-out consolidated into one message with all recipients (${fanout ? fanout.recipients.length : 'missing'})`);
  assert(fanout && fanout.recipients.some((x) => x.status === 'sent') && fanout.recipients.some((x) => x.status === 'skipped'), 'each recipient carries its own delivery status');

  // detail with on-demand render of a historical (bodyless) row
  const histMsg = list.find((r) => r.reconstructed && r.direction === 'outbound' && !r.has_body);
  assert(!!histMsg, 'a historical row is present (no stored body)');
  if (histMsg) {
    const dRes = await get(`/api/staff/applications/${appId}/emails/${histMsg.id}`, loTok);
    const d = await dRes.json();
    assert(dRes.status === 200 && d.body_html && d.rendered === true, 'detail renders a historical body on demand');
  }

  // visibility: an unassigned officer is forbidden
  const forbidden = await get(`/api/staff/applications/${appId}/emails`, otherTok);
  assert(forbidden.status === 403, 'unassigned officer is forbidden from a file they cannot see');

  // global mailbox: admin sees this file's mail
  const gAdmin = await (await get(`/api/staff/emails?q=${uniq}`, adminTok)).json();
  assert(Array.isArray(gAdmin) && gAdmin.length >= 1, `admin global mailbox returns rows (${Array.isArray(gAdmin) ? gAdmin.length : 'n/a'})`);
  // global mailbox scoping: the unassigned officer sees NONE of this file's mail
  const gOther = await (await get(`/api/staff/emails?q=${uniq}`, otherTok)).json();
  assert(Array.isArray(gOther) && gOther.every((r) => r.application_id !== appId), 'unassigned officer global mailbox excludes the file');
  // assigned officer DOES see it
  const gLo = await (await get(`/api/staff/emails?q=${uniq}`, loTok)).json();
  assert(Array.isArray(gLo) && gLo.some((r) => r.application_id === appId), 'assigned officer global mailbox includes the file');

  // stats
  const stats = await (await get('/api/staff/emails/stats', adminTok)).json();
  assert(stats && typeof stats.total === 'number' && stats.total >= 3, 'stats returns totals');

  // reply-recipients preview: the borrower + assignees a reply would reach
  const rr = await (await get(`/api/staff/applications/${appId}/emails/reply-recipients`, loTok)).json();
  assert(Array.isArray(rr) && rr.some((p) => p.email === `${uniq}-bo@example.test` && p.kind === 'borrower'), 'reply-recipients lists the borrower (not read as a message id)');

  // reply — sends to the borrower (a file party), captured as staff_reply
  const rRes = await post(`/api/staff/applications/${appId}/emails/reply`, loTok, { body: 'Thanks — here is your update.' });
  const rJson = await rRes.json();
  assert(rRes.status === 200 && rJson.ok && rJson.sent_to.includes(`${uniq}-bo@example.test`), 'reply sends to the file borrower');
  const replyRow = (await db.query(`SELECT msg_type, status, body_html FROM email_messages WHERE application_id=$1 AND msg_type='staff_reply'`, [appId])).rows[0];
  assert(replyRow && replyRow.body_html && /Thanks/.test(replyRow.body_html), 'the reply was captured into the Email Center with its body');

  // reply with an empty body is rejected
  const rEmpty = await post(`/api/staff/applications/${appId}/emails/reply`, loTok, { body: '   ' });
  assert(rEmpty.status === 400, 'empty reply is rejected');

  // frozen rule: a note-buyer/capital-partner name a staffer types in the reply
  // SUBJECT or BODY must never reach the borrower (the reply goes to the borrower).
  const rScrub = await post(`/api/staff/applications/${appId}/emails/reply`, loTok,
    { subject: 'Re: Fidelis payoff schedule', body: 'The Churchill payoff is attached.' });
  assert(rScrub.status === 200, 'reply with a partner name sends');
  const scrubRow = (await db.query(
    `SELECT subject, body_html FROM email_messages WHERE application_id=$1 AND msg_type='staff_reply' AND subject ILIKE '%payoff%' ORDER BY occurred_at DESC LIMIT 1`, [appId])).rows[0];
  assert(scrubRow && !/fidelis/i.test(scrubRow.subject), 'reply SUBJECT is borrower-safe scrubbed (no note-buyer name)');
  assert(scrubRow && !/churchill/i.test(scrubRow.body_html || ''), 'reply BODY is borrower-safe scrubbed (no note-buyer name)');

  // ---- attachment download + resend (enhancements) ----
  const storage = require('../src/lib/storage');
  const nAtt = (await db.query(
    `INSERT INTO notifications (recipient_kind,staff_id,type,title,body,application_id,email_status) VALUES ('staff',$1,'doc_uploaded','Doc email','A doc was sent.',$2,'sent') RETURNING id`, [officer, appId])).rows[0].id;
  const bytes = Buffer.from('%PDF-1.4 fake pdf bytes for test');
  const saved = await storage.save(bytes, { filename: 'Term-Sheet.pdf' });
  await db.query(
    `INSERT INTO sent_emails (notification_id, application_id, audience, recipient_kind, subject, to_emails, html, attachments, status)
     VALUES ($1,$2,'staff','staff','Doc email',$3,'<p>hi</p>',$4::jsonb,'sent')`,
    [nAtt, appId, [`${uniq}-lo@example.test`], JSON.stringify([{ filename: 'Term-Sheet.pdf', content_type: 'application/pdf', size: bytes.length, storage_ref: saved.ref }])]);
  await emailLog.captureOutbound(
    { to: [`${uniq}-lo@example.test`], subject: 'Doc email', html: '<p>hi</p>', replyTo: `file+${appId}@r.test`, attachments: [{ filename: 'Term-Sheet.pdf', contentType: 'application/pdf', content: bytes.toString('base64') }] },
    { applicationId: appId, notificationId: nAtt, type: 'doc_uploaded', audience: 'staff', status: 'sent' });
  const attMsg = (await db.query(`SELECT id FROM email_messages WHERE notification_id=$1`, [nAtt])).rows[0].id;
  // detail marks the attachment downloadable
  const attDetail = await (await get(`/api/staff/applications/${appId}/emails/${attMsg}`, loTok)).json();
  assert(Array.isArray(attDetail.attachments) && attDetail.attachments[0] && attDetail.attachments[0].downloadable === true, 'detail marks a stored attachment downloadable');
  // download returns the exact bytes
  const dl = await get(`/api/staff/applications/${appId}/emails/${attMsg}/attachments/0`, loTok);
  const dlBuf = Buffer.from(await dl.arrayBuffer());
  assert(dl.status === 200 && dlBuf.equals(bytes), 'attachment download returns the exact bytes');
  // a bad index 404s
  const dlBad = await get(`/api/staff/applications/${appId}/emails/${attMsg}/attachments/9`, loTok);
  assert(dlBad.status === 404, 'a missing attachment index 404s');
  // unassigned officer cannot download
  const dlForbid = await get(`/api/staff/applications/${appId}/emails/${attMsg}/attachments/0`, otherTok);
  assert(dlForbid.status === 403, 'unassigned officer cannot download an attachment');
  // resend re-delivers to the original recipients (a new captured message)
  const resendBefore = (await db.query(`SELECT count(*)::int c FROM email_messages WHERE application_id=$1 AND msg_type='resend'`, [appId])).rows[0].c;
  const rs = await post(`/api/staff/applications/${appId}/emails/${attMsg}/resend`, loTok, {});
  const rsJson = await rs.json();
  assert(rs.status === 200 && rsJson.ok && rsJson.sent_to.includes(`${uniq}-lo@example.test`), 'resend re-delivers to the original recipient');
  const resendAfter = (await db.query(`SELECT count(*)::int c FROM email_messages WHERE application_id=$1 AND msg_type='resend'`, [appId])).rows[0].c;
  assert(resendAfter === resendBefore + 1, 'resend is captured as a new message in the history');
  // resend of an inbound message is rejected
  const inMsg = (await db.query(`SELECT id FROM email_messages WHERE application_id=$1 AND direction='inbound' LIMIT 1`, [appId])).rows[0];
  if (inMsg) { const rsIn = await post(`/api/staff/applications/${appId}/emails/${inMsg.id}/resend`, loTok, {}); assert(rsIn.status === 400, 'resend of an inbound reply is rejected'); }

  // ---- open tracking ----
  assert(/\/e\/o\/abc\.gif/.test(emailLog && require('../src/lib/notify').injectOpenPixel('<html><body>hi</body></html>', 'abc')),
    'injectOpenPixel splices the tracking pixel into the sent body');
  assert(require('../src/lib/notify').injectOpenPixel('<html><body>hi</body></html>', 'abc').includes('display:none'),
    'the tracking pixel is invisible');
  const notify = require('../src/lib/notify');
  const nOpen = await notify.notifyStaff(officer, { type: 'message', title: 'Trackable', body: 'Open me', applicationId: appId });
  await new Promise((r) => setTimeout(r, 500));   // let the fire-and-forget capture finish
  const storedBody = (await db.query(`SELECT body_html FROM email_messages WHERE notification_id=$1`, [nOpen])).rows[0];
  assert(storedBody && storedBody.body_html && !/\/e\/o\//.test(storedBody.body_html), 'the STORED Email Center body has NO tracking pixel (clean copy)');
  // simulate the borrower's email client loading the pixel
  const px = await fetch(`${base}/e/o/${nOpen}.gif`);
  assert(px.status === 200 && String(px.headers.get('content-type') || '').includes('image/gif'), 'the open pixel returns a 1x1 gif');
  const o1 = (await db.query(`SELECT open_count FROM email_opens WHERE notification_id=$1`, [nOpen])).rows[0];
  assert(o1 && o1.open_count >= 1, 'an open is recorded in email_opens');
  await fetch(`${base}/e/o/${nOpen}.gif`);
  const o2 = (await db.query(`SELECT open_count FROM email_opens WHERE notification_id=$1`, [nOpen])).rows[0];
  assert(o2.open_count === o1.open_count + 1, 'a repeat open increments the count');
  // the per-file list now shows the recipient opened it
  const listOpen = await (await get(`/api/staff/applications/${appId}/emails`, loTok)).json();
  const openedMsg = (Array.isArray(listOpen) ? listOpen : []).find((r) => Array.isArray(r.recipients) && r.recipients.some((x) => x.opened_at));
  assert(!!openedMsg, 'the per-file list surfaces a recipient opened_at');
  // a bogus/guessed id returns a gif but records nothing (FK guard)
  const pxBad = await fetch(`${base}/e/o/00000000-0000-0000-0000-000000000000.gif`);
  const bogus = (await db.query(`SELECT count(*)::int c FROM email_opens WHERE notification_id='00000000-0000-0000-0000-000000000000'`)).rows[0].c;
  assert(pxBad.status === 200 && bogus === 0, 'a bogus open id returns a gif but records no row (FK guard)');

  // ---- open tracking: the BCC'd loan officer must NOT trip the borrower's pixel ----
  // A borrower email silently BCCs the assigned LO. If the LO's copy carried the
  // SAME pixel (keyed on the borrower's notification), their mail client / scanner
  // loading it would record a FALSE borrower-open. So the pixel copy goes only to
  // the borrower; the officer gets a separate, pixel-free copy.
  const noop = require('../src/lib/email/noop');
  const realNoopSend = noop.sendMail;
  const provSends = [];
  noop.sendMail = async (m) => { provSends.push(m); return realNoopSend(m); };
  try {
    const nBo = await notify.notifyBorrower(borrower, { type: 'status_change', title: 'Your file moved', body: 'Onward', applicationId: appId, major: true });
    await new Promise((r) => setTimeout(r, 500));   // let the fire-and-forget officer copy + capture finish
    const boSend = provSends.find((m) => [].concat(m.to || []).some((t) => String(t).includes(`${uniq}-bo@`)));
    const loSend = provSends.find((m) => [].concat(m.to || []).some((t) => String(t).includes(`${uniq}-lo@`)));
    assert(boSend && new RegExp(`/e/o/${nBo}\\.gif`).test(String(boSend.html || '')), 'the borrower copy carries the open pixel');
    assert(boSend && !(Array.isArray(boSend.bcc) && boSend.bcc.length), 'the borrower copy is no longer BCC-ing the officer (split off)');
    assert(loSend && !/\/e\/o\//.test(String(loSend.html || '')), "the officer's separate copy is pixel-free (cannot trip a false borrower-open)");
    // the officer's split copy is NOT recorded in the Email Center (would clobber the borrower row)
    const boRows = (await db.query(`SELECT to_emails FROM email_messages WHERE notification_id=$1`, [nBo])).rows;
    assert(boRows.length === 1 && JSON.stringify(boRows[0].to_emails).includes(`${uniq}-bo@`),
      'only the borrower send is captured (officer split copy is not double-recorded)');
  } finally { noop.sendMail = realNoopSend; }
  // _skipCapture keeps a send out of the Email Center entirely
  const email = require('../src/lib/email');
  const beforeSkip = (await db.query(`SELECT count(*)::int c FROM email_messages WHERE application_id=$1`, [appId])).rows[0].c;
  await email.sendMail({ to: [`${uniq}-bo@example.test`], subject: 'skip me', html: '<p>x</p>',
    replyTo: `file+${appId}@example.test`, _skipCapture: true });
  const afterSkip = (await db.query(`SELECT count(*)::int c FROM email_messages WHERE application_id=$1`, [appId])).rows[0].c;
  assert(afterSkip === beforeSkip, '_skipCapture suppresses the Email Center capture');

  // ---- cleanup ----
  await db.query(`DELETE FROM email_messages WHERE application_id=$1`, [appId]);
  await db.query(`DELETE FROM inbound_file_emails WHERE application_id=$1`, [appId]);
  await db.query(`DELETE FROM notifications WHERE application_id=$1`, [appId]);
  await db.query(`DELETE FROM application_assignees WHERE application_id=$1`, [appId]);
  await db.query(`DELETE FROM applications WHERE id=$1`, [appId]);
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrower]);
  await db.query(`DELETE FROM staff_users WHERE id = ANY($1)`, [[officer, other, admin]]);

  server.close();
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
