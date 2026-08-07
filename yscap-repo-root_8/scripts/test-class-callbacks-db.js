'use strict';
/**
 * Class Valuation callbacks — real Postgres, real HTTP against the real receiver.
 *
 * A pure test cannot catch a wrong column name, an index that does not dedupe, or a
 * public endpoint that is accidentally open. All three are the kind of thing that
 * only shows up against the real thing, and one of them (an unauthenticated public
 * writer) is a security property, not a feature.
 *
 * What it pins:
 *   • the receiver refuses everything without the right Basic credentials, and fails
 *     CLOSED when none are configured;
 *   • a delivery is STORED before anything is interpreted, and a retry collapses;
 *   • an event finds its order by their id AND by our reference number;
 *   • THE VERSION RULE: a 3.6 order's callback resolves to a 3.6 order and a 2.6
 *     order's to 2.6 — from OUR row, since their payload is identical either way —
 *     and an order whose version was never recorded refuses a version-specific call
 *     rather than guessing one.
 */
if (!process.env.DATABASE_URL) { console.log('test-class-callbacks-db: SKIP (no DATABASE_URL)'); process.exit(0); }

// SET BEFORE THE FIRST require(). `src/config.js` reads process.env ONCE at load and
// caches it, and almost anything in this repo pulls config in transitively — so a
// value set even one require() later is invisible to the receiver, and every
// authenticated delivery would 401 for a reason that looks like a code bug.
process.env.CLASS_CALLBACK_USER = 'pilot-class';
process.env.CLASS_CALLBACK_PASSWORD = 'pw-' + Math.random().toString(36).slice(2, 10);

const { signJwt } = require('../src/lib/crypto');
const db = require('../src/db');
const cb = require('../src/class/callbacks');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('PASS ' + l); } else { fail++; console.error('FAIL ' + l); } };
const tag = Math.random().toString(36).slice(2, 10);

async function main() {
  const app = require('../src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const CB = `${base}/api/class/callbacks`;
  const basic = 'Basic ' + Buffer.from(`${process.env.CLASS_CALLBACK_USER}:${process.env.CLASS_CALLBACK_PASSWORD}`).toString('base64');

  // ---- a real file, and TWO orders on it — one per form version ----------
  const borrowerId = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Ada',$1,$2) RETURNING id`,
    ['Reyes-' + tag, `ada.${tag}@example.test`])).rows[0].id;
  const appId = (await db.query(
    `INSERT INTO applications (borrower_id, ys_loan_number, loan_type, property_type, status)
     VALUES ($1,$2,'fix_and_flip','Single Family','underwriting') RETURNING id`,
    [borrowerId, 'YSCAP' + tag])).rows[0].id;

  const mkOrder = async (version, uad, path, classOrderId, ref) => (await db.query(
    `INSERT INTO class_orders (application_id, reference_number, api_version, uad, order_path,
                               class_order_id, status, placed_at)
     VALUES ($1,$2,$3,$4,$5,$6,'ordered', now()) RETURNING id`,
    [appId, ref, version, uad, path, classOrderId])).rows[0].id;

  const order26 = await mkOrder('v1', '2.6', '/orders', `cls26-${tag}`, 'YSCAP' + tag);
  const order36 = await mkOrder('v2', '3.6', '/v2/orders', `cls36-${tag}`, 'REF36-' + tag);

  const post = (body, headers) => fetch(CB, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(headers || {}) },
    body: JSON.stringify(body),
  });
  const envelope = (eventName, orderId, referenceNumber, data) =>
    ({ orderId, referenceNumber, eventName, sent: new Date().toISOString(), created: new Date().toISOString(), data });

  // =========================================================================
  console.log('\n--- the public receiver is not open ---');
  const noAuth = await post(envelope('StatusChanged', `cls26-${tag}`, null, { StatusName: 'Active' }));
  ok(noAuth.status === 401, 'a delivery with no credentials is refused');
  const wrongPw = await post(envelope('StatusChanged', `cls26-${tag}`, null, { StatusName: 'Active' }),
    { Authorization: 'Basic ' + Buffer.from(`${process.env.CLASS_CALLBACK_USER}:wrong`).toString('base64') });
  ok(wrongPw.status === 401, 'a wrong password is refused');
  const wrongUser = await post(envelope('StatusChanged', `cls26-${tag}`, null, { StatusName: 'Active' }),
    { Authorization: 'Basic ' + Buffer.from(`someone-else:${process.env.CLASS_CALLBACK_PASSWORD}`).toString('base64') });
  ok(wrongUser.status === 401, 'a wrong username is refused');
  const stored0 = await db.query('SELECT count(*)::int n FROM class_callback_events WHERE class_order_id = $1', [`cls26-${tag}`]);
  ok(stored0.rows[0].n === 0, 'and none of those refusals wrote anything');

  const noEvent = await post({ orderId: 1 }, { Authorization: basic });
  ok(noEvent.status === 400, 'an authenticated delivery with no event name is a bad request');

  // FAIL CLOSED. With nothing configured, the receiver must refuse EVERY delivery —
  // including one carrying credentials that look right. An unauthenticated public
  // endpoint that writes rows is worse than a receiver that is switched off, and
  // "nobody has set this up yet" reads as off. The config object is read at call
  // time, so blanking it here exercises the real code path.
  const liveCfg = require('../src/config').class;
  const keepUser = liveCfg.callbackUser, keepPw = liveCfg.callbackPassword;
  liveCfg.callbackUser = null; liveCfg.callbackPassword = null;
  const unconfigured = await post(envelope('StatusChanged', `cls26-${tag}`, null, { StatusName: 'Active' }), { Authorization: basic });
  ok(unconfigured.status === 401, 'with no callback credentials configured, every delivery is refused');
  const blankBasic = await post(envelope('StatusChanged', `cls26-${tag}`, null, { StatusName: 'Active' }),
    { Authorization: 'Basic ' + Buffer.from(':').toString('base64') });
  ok(blankBasic.status === 401, 'and empty credentials never match empty config');
  liveCfg.callbackUser = keepUser; liveCfg.callbackPassword = keepPw;

  // =========================================================================
  console.log('\n--- a delivery is stored, answered fast, and a retry collapses ---');
  const body1 = envelope('StatusChanged', `cls26-${tag}`, 'YSCAP' + tag, { StatusName: 'Active', Reason: 'Order accepted' });
  const r1 = await post(body1, { Authorization: basic });
  ok(r1.status === 200, 'a good delivery is accepted');
  ok((await r1.json()).ok === true, 'and answers ok — their contract is a 200 inside 30 seconds');
  const again = await post(body1, { Authorization: basic });
  ok(again.status === 200, 'their retry is accepted too (never a non-2xx, or they stop retrying)');
  const n1 = await db.query('SELECT count(*)::int n FROM class_callback_events WHERE class_order_id = $1', [`cls26-${tag}`]);
  ok(n1.rows[0].n === 1, 'but the identical retry collapsed to ONE stored event');

  // The receiver drains on its own; give it a moment, then settle anything left.
  await new Promise((r) => setTimeout(r, 300));
  await cb.drain({ limit: 50 });

  const o26 = (await db.query('SELECT * FROM class_orders WHERE id = $1', [order26])).rows[0];
  ok(o26.status === 'in_process', 'their "Active" moved our order to in_process');
  ok(o26.status_reason === 'Order accepted', 'and the reason a human reads was kept');
  ok(!!o26.last_event_at, 'and the order records that we heard from them');

  // =========================================================================
  console.log('\n--- an event finds its order by OUR reference number too ---');
  // This is the case where their id has not reached us: the order row carries only
  // what we sent. A payload with no orderId must still land on the right file.
  const refOnly = await mkOrder('v1', '2.6', '/orders', null, 'REFONLY-' + tag);
  await post(envelope('SetAppointment', null, 'REFONLY-' + tag,
    { appointmentDate: '2026-08-20T15:00:00Z', dueDate: '2026-08-25T00:00:00Z' }), { Authorization: basic });
  await new Promise((r) => setTimeout(r, 300));
  await cb.drain({ limit: 50 });
  const ro = (await db.query('SELECT * FROM class_orders WHERE id = $1', [refOnly])).rows[0];
  ok(ro.appointment_date && ro.appointment_date.toISOString().startsWith('2026-08-20'),
     'an event carrying only our reference number still found its order');

  // =========================================================================
  console.log('\n--- THE VERSION RULE ---');
  // Their two payloads are IDENTICAL in shape. The only thing that distinguishes a
  // 3.6 order from a 2.6 one is our own row — which is the whole reason it is stored.
  const p26 = envelope('StatusChanged', `cls26-${tag}`, null, { StatusName: 'Completed' });
  const p36 = envelope('StatusChanged', `cls36-${tag}`, null, { StatusName: 'Completed' });
  ok(JSON.stringify(Object.keys(p26).sort()) === JSON.stringify(Object.keys(p36).sort()),
     'a 2.6 callback and a 3.6 callback are the same shape — nothing in the payload tells them apart');

  await post(p36, { Authorization: basic });
  await new Promise((r) => setTimeout(r, 300));
  await cb.drain({ limit: 50 });
  const o36 = (await db.query('SELECT * FROM class_orders WHERE id = $1', [order36])).rows[0];
  ok(o36.status === 'completed', 'the 3.6 order was updated by its own callback');
  ok(cb.versionOf(o36).uad === '3.6' && cb.versionOf(o36).version === 'v2',
     'and resolving its version from OUR row says 3.6');
  ok(cb.versionOf(o26).uad === '2.6', 'while the other order on the SAME file resolves to 2.6');
  ok(o36.order_path === '/v2/orders' && o26.order_path === '/orders',
     'each order remembers the exact path it was placed on, so a follow-up cannot be sent to the wrong one');

  // The refusal, against a REAL row this time.
  const legacy = await mkOrder('v1', '2.6', '/orders', `cls-legacy-${tag}`, 'LEGACY-' + tag);
  await db.query(`UPDATE class_orders SET api_version = NULL WHERE id = $1`, [legacy])
    .catch(() => { /* NOT NULL — see the assertion below */ });
  const legacyRow = (await db.query('SELECT * FROM class_orders WHERE id = $1', [legacy])).rows[0];
  ok(legacyRow.api_version === 'v1',
     'the column REFUSES to go null — an order with no recorded version cannot be created by accident');
  const refused = await cb.refreshOrder({ id: legacy, class_order_id: 'x', api_version: 'v3' });
  ok(refused.ok === false && refused.reason === 'version_unknown',
     'and an unrecognised recorded version refuses a follow-up rather than guessing a path');

  // =========================================================================
  console.log('\n--- an attachment announcement becomes a work item, once ---');
  await post(envelope('NewAttachments', `cls36-${tag}`, null, { orderId: 1, name: 'Appraisal.pdf', contentType: 'application/pdf' }), { Authorization: basic });
  await new Promise((r) => setTimeout(r, 300));
  await cb.drain({ limit: 50 });
  const at1 = await db.query('SELECT * FROM class_attachments WHERE class_order_row = $1', [order36]);
  ok(at1.rowCount === 1 && at1.rows[0].name === 'Appraisal.pdf', 'the announced document is recorded against the order');
  ok(at1.rows[0].document_id === null, 'and is NOT yet on the loan file — announcing is not delivering');
  // A re-announcement of the same document (a different day, so a different hash) is
  // the same file, not a second one.
  await db.query(`INSERT INTO class_attachments (class_order_row, application_id, name, content_type)
                  VALUES ($1,$2,'Appraisal.pdf','application/pdf')
                  ON CONFLICT (class_order_row, name) WHERE name IS NOT NULL DO NOTHING`, [order36, appId]);
  const at2 = await db.query('SELECT count(*)::int n FROM class_attachments WHERE class_order_row = $1', [order36]);
  ok(at2.rows[0].n === 1, 're-announcing the same document does not create a second row');

  // =========================================================================
  console.log('\n--- an event for an order we never placed is KEPT, not dropped ---');
  await post(envelope('StatusChanged', `cls-unknown-${tag}`, 'NOT-OURS-' + tag, { StatusName: 'Active' }), { Authorization: basic });
  await new Promise((r) => setTimeout(r, 300));
  await cb.drain({ limit: 50 });
  const orphan = await db.query('SELECT * FROM class_callback_events WHERE class_order_id = $1', [`cls-unknown-${tag}`]);
  ok(orphan.rowCount === 1, 'the delivery is on the record');
  ok(orphan.rows[0].processed_at !== null && !orphan.rows[0].process_error,
     'and is marked handled rather than retried forever — an order we do not have is not an error');
  ok(orphan.rows[0].class_order_row === null, 'with no order attached, because there is none');

  // =========================================================================
  console.log('\n--- THEIR REPLY lands in the same thread we type into ---');
  await post(envelope('NewNotes', `cls36-${tag}`, null,
    [{ noteId: `note-${tag}-1`, content: 'The appraiser will call the borrower today.' }]), { Authorization: basic });
  await new Promise((r) => setTimeout(r, 300));
  await cb.drain({ limit: 50 });
  const inbound = await db.query(
    `SELECT * FROM class_notes WHERE class_order_row = $1 ORDER BY created_at`, [order36]);
  ok(inbound.rowCount === 1 && inbound.rows[0].direction === 'ToClient',
     'their note arrived on the order, marked as THEIR side of the thread');
  ok(inbound.rows[0].read_at === null, 'and starts unread, so the desk can badge it');
  // Their retry repeats the note verbatim; the note id is what makes this idempotent.
  await db.query(
    `INSERT INTO class_notes (class_order_row, application_id, class_note_id, direction, content)
     VALUES ($1,$2,$3,'ToClient','dupe') ON CONFLICT (class_note_id) WHERE class_note_id IS NOT NULL DO NOTHING`,
    [order36, appId, `note-${tag}-1`]);
  const stillOne = await db.query('SELECT count(*)::int n FROM class_notes WHERE class_order_row = $1', [order36]);
  ok(stillOne.rows[0].n === 1, 'and the same note delivered twice does not become two messages');

  // =========================================================================
  console.log('\n--- the staff view, and the setup route that is NOT the receiver ---');
  const officer = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Ophelia Officer','loan_officer',true) RETURNING id`,
    [`cls-cb-lo-${tag}@example.test`])).rows[0].id;
  await db.query('UPDATE applications SET loan_officer_id=$2 WHERE id=$1', [appId, officer]);
  const jwt = signJwt({ sub: officer, kind: 'staff', role: 'loan_officer', tv: 0, sid: 'test' });
  const view = await fetch(`${base}/api/class/files/${appId}/orders`, { headers: { Authorization: `Bearer ${jwt}` } });
  const viewBody = await view.json();
  ok(view.status === 200 && viewBody.orders.length >= 3, 'the file screen can read its Class orders');
  ok(viewBody.orders.every((o) => o.api_version && o.uad),
     'and every one of them says which form version it is on');
  ok(viewBody.events.length >= 1 && viewBody.attachments.length >= 1, 'with the events and announced documents behind them');

  // The setup route must NOT be swallowed by the public receiver mounted ahead of it.
  const setup = await fetch(`${base}/api/class/callback-setup`, { headers: { Authorization: `Bearer ${jwt}` } });
  ok(setup.status === 403, 'callback setup is admin-only (a loan officer is refused, not 401-ed by the webhook)');
  const openSetup = await fetch(`${base}/api/class/callback-setup`);
  ok(openSetup.status === 401, 'and it is behind auth');

  // =========================================================================
  console.log('\n--- messaging, revisions and reconsiderations of value, over real HTTP ---');
  const call = async (method, path, body) => {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${jwt}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let j = null; try { j = await r.json(); } catch (_) {}
    return { status: r.status, body: j };
  };

  const th0 = await call('GET', `/api/class/files/${appId}/orders/${order36}/thread`);
  ok(th0.status === 200 && th0.body.notes.length === 1 && th0.body.unread === 1,
     'the thread shows their message and counts it unread');

  // A note we type is RECORDED even though sending fails (the connection is off).
  const sent = await call('POST', `/api/class/files/${appId}/orders/${order36}/notes`,
    { content: 'Please confirm the inspection date.' });
  ok(sent.status === 502, 'with the connection off the send genuinely fails');
  const th1 = await call('GET', `/api/class/files/${appId}/orders/${order36}/thread`);
  ok(th1.body.notes.length === 2 && th1.body.notes[1].direction === 'FromClient',
     'but the message a human typed is KEPT, not lost with the failed send');
  ok(!!th1.body.notes[1].send_error, 'and carries why it did not go out, so it can be retried');
  ok(th1.body.notes[1].sent_at === null, 'and is not pretending to have been delivered');

  const empty = await call('POST', `/api/class/files/${appId}/orders/${order36}/notes`, { content: '   ' });
  ok(empty.status === 400, 'an empty message is refused before anything is written');

  const read = await call('POST', `/api/class/files/${appId}/orders/${order36}/read`);
  ok(read.status === 200, 'their messages can be marked read');
  const th2 = await call('GET', `/api/class/files/${appId}/orders/${order36}/thread`);
  ok(th2.body.unread === 0, 'and the unread count clears');

  // Reasons come from the server, so the picker cannot offer a code Class rejects.
  const reasons = await call('GET', '/api/class/revision-reasons?kind=rov');
  ok(reasons.status === 200 && reasons.body.common.length > 0, 'the ROV reason list is served');
  ok(reasons.body.rovIsARevision === true,
     'and says plainly that an ROV is a revision — there is no separate request type at Class');
  ok(reasons.body.common.every((r) => r.code && r.label), 'each reason carries its code AND plain English');

  const badRev = await call('POST', `/api/class/files/${appId}/orders/${order36}/revision`,
    { reasons: [{ reasonType: 'NotARealCode' }] });
  ok(badRev.status === 400 && /not a reason Class accepts/.test((badRev.body.problems || []).join(' ')),
     'a made-up reason code is refused before anything is recorded');

  const fakeRov = await call('POST', `/api/class/files/${appId}/orders/${order36}/revision`,
    { kind: 'rov', reasons: [{ reasonType: 'PhotosandMLSphotosgeneric', reason: 'blurry' }] });
  ok(fakeRov.status === 400, 'an ROV with no value-related reason is refused');

  const rov = await call('POST', `/api/class/files/${appId}/orders/${order36}/revision`, {
    kind: 'rov',
    reasons: [{ reasonType: 'ReconciliationConcernsValueRelatedConcerns', reason: 'Three closer sales support $410,000' }],
    supporting: [{ address: '12 Nearby St', price: 410000 }],
  });
  ok(rov.status === 502, 'the ROV cannot reach Class while the connection is off');
  const asks = await db.query(`SELECT * FROM class_revisions WHERE class_order_row = $1 ORDER BY requested_at`, [order36]);
  ok(asks.rowCount === 1 && asks.rows[0].kind === 'rov',
     'but the ask is RECORDED as a reconsideration of value, so the file remembers we disputed');
  ok(asks.rows[0].status === 'error' && !!asks.rows[0].last_error, 'with the failure on it, ready to retry');
  ok(Array.isArray(asks.rows[0].supporting) && asks.rows[0].supporting[0].price === 410000,
     'and the comparables we put forward are kept with it');

  // A VALUE reason filed as an ordinary revision is still recorded as an ROV.
  await call('POST', `/api/class/files/${appId}/orders/${order36}/revision`,
    { kind: 'revision', reasons: [{ reasonType: 'AdjustmentsWrongDirection', reason: 'up not down' }] });
  const asks2 = await db.query(
    `SELECT kind FROM class_revisions WHERE class_order_row = $1 ORDER BY requested_at DESC LIMIT 1`, [order36]);
  ok(asks2.rows[0].kind === 'rov',
     'a value dispute filed as a plain revision is still recorded as one — the reasons decide, not the button');

  const noConfirm = await call('POST', `/api/class/files/${appId}/orders/${order36}/cancel`,
    { reasons: [{ reasonType: 'ClientRequestedCancellation' }] });
  ok(noConfirm.status === 400 && noConfirm.body.error === 'confirm_required',
     'cancelling needs an explicit confirmation, like placing does');

  // THE SCOPE CHECK. An order row id is a plain number, so a staffer must not be able
  // to reach another file's order by guessing one.
  const otherBorrower = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Zed',$1,$2) RETURNING id`,
    ['Other-' + tag, `zed.${tag}@example.test`])).rows[0].id;
  const otherApp = (await db.query(
    `INSERT INTO applications (borrower_id, ys_loan_number, status) VALUES ($1,$2,'underwriting') RETURNING id`,
    [otherBorrower, 'YSOTHER' + tag])).rows[0].id;
  await db.query('UPDATE applications SET loan_officer_id=$2 WHERE id=$1', [otherApp, officer]);
  const crossFile = await call('GET', `/api/class/files/${otherApp}/orders/${order36}/thread`);
  ok(crossFile.status === 404,
     'an order id from ANOTHER file is not reachable, even by a staffer who can see both');

  // ---- cleanup ------------------------------------------------------------
  server.close();
  await db.query('DELETE FROM applications WHERE id=$1', [otherApp]);
  await db.query('DELETE FROM borrowers WHERE id=$1', [otherBorrower]);
  await db.query('DELETE FROM class_callback_events WHERE class_order_id LIKE $1 OR reference_number LIKE $2',
    [`%${tag}`, `%${tag}`]);
  await db.query('DELETE FROM applications WHERE id=$1', [appId]);
  await db.query('DELETE FROM borrowers WHERE id=$1', [borrowerId]);
  await db.query('DELETE FROM staff_users WHERE id=$1', [officer]);

  console.log(`\ntest-class-callbacks-db: ${pass} passed, ${fail} failed`);
  // A trailing "[request-audit] flush failed … pool after end" line is EXPECTED here
  // and is not a failure — the shared audit flushes on its own timer.
  await db.pool.end().catch(() => {});
  if (fail) process.exit(1);
}

main().catch(async (e) => { console.error('FAILED', e); try { await db.pool.end(); } catch (_) {} process.exit(1); });
