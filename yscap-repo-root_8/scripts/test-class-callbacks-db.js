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
  //
  // UNKNOWN IS REPRESENTABLE, and it has to be. db/490 originally declared the column
  // NOT NULL DEFAULT 'v1', which meant an order back-filled without a version — the
  // case the code explicitly anticipates, an order placed by hand in the Class portal
  // — was silently stamped 2.6 and became indistinguishable from one really placed on
  // 2.6. That made `versionOf`'s `known:false` branch unreachable for any stored row,
  // so the refusal it guards could never fire. db/492 drops the default and the NOT
  // NULL; every order PILOT places still writes the column explicitly.
  const legacy = await mkOrder('v1', '2.6', '/orders', `cls-legacy-${tag}`, 'LEGACY-' + tag);
  await db.query(`UPDATE class_orders SET api_version = NULL WHERE id = $1`, [legacy]);
  const legacyRow = (await db.query('SELECT * FROM class_orders WHERE id = $1', [legacy])).rows[0];
  ok(legacyRow.api_version === null,
     'an order whose version we genuinely do not know can SAY so — it is never stamped 2.6 by a default');
  ok(cb.versionOf(legacyRow).known === false,
     'and it reads as unknown, so the follow-up refusal below is reachable at all');
  await db.query(`UPDATE class_orders SET api_version = 'v1' WHERE id = $1`, [legacy]);
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

  const huge = await call('GET', `/api/class/files/${appId}/orders/999999999999999999999/thread`);
  ok(huge.status === 404,
     'an order id too big to BE an order is "no such order", not a 500 that reads as PILOT being broken');

  // =========================================================================
  // A DELIVERY WE CANNOT STORE VERBATIM IS STILL STORED, AND STILL DISTINCT.
  // Each of these was a real defect found by the pre-merge security audit; each
  // assertion below fails on the code as it was written.
  console.log('\n--- a body we cannot store as-is is still recorded, and never merged with another ---');

  const NUL = String.fromCharCode(0);
  const countFor = async (name) => Number((await db.query(
    'SELECT count(*) c FROM class_callback_events WHERE event_name = $1', [name])).rows[0].c);

  // 1. A NUL byte in any of the three indexed fields. Postgres refuses a NUL in text,
  //    and this router sits ABOVE the global stripper — so before the fix each of
  //    these 500'd, and a 500 is a retry, forever, for a body that can never store.
  for (const [field, body] of [
    ['eventName', { eventName: `NulEvent${NUL}-${tag}`, orderId: `cls26-${tag}` }],
    ['orderId', { eventName: `NulOrder-${tag}`, orderId: `cls26-${tag}${NUL}x` }],
    ['referenceNumber', { eventName: `NulRef-${tag}`, referenceNumber: `REF${NUL}-${tag}` }],
  ]) {
    const r = await post(body, { Authorization: basic });
    ok(r.status === 200, `a NUL byte in ${field} is accepted and stored, never a permanent 500`);
  }

  // 2. An oversize id cannot ride through the guard that exists to keep the row small.
  await post({ eventName: `BigId-${tag}`, orderId: 'Z'.repeat(500000) }, { Authorization: basic });
  const bigIdRow = (await db.query(
    `SELECT length(class_order_id) idlen, length(payload::text) plen
       FROM class_callback_events WHERE event_name = $1`, [`BigId-${tag}`])).rows[0];
  ok(bigIdRow && bigIdRow.idlen <= 256 && bigIdRow.plen < 200000,
     `a 500KB order id is capped, and the stored row stays small (id ${bigIdRow && bigIdRow.idlen}, row ${bigIdRow && bigIdRow.plen})`);

  // 3. THE ONE THAT LOST DATA. Two DIFFERENT oversize deliveries on the SAME order:
  //    the marker used to be a pure function of the envelope, so both hashed the same,
  //    the unique index dropped the second, and we answered 200 — so the vendor never
  //    retried. Two distinct events must remain two rows.
  // The blob must genuinely clear the 200KB guard, or this whole section passes for
  // the wrong reason — both bodies store verbatim, stay distinct, and prove nothing.
  const big = (fill) => ({ eventName: `Oversize-${tag}`, orderId: `cls26-${tag}`, data: { blob: fill.repeat(260000) } });
  const o1 = await post(big('a'), { Authorization: basic });
  const o2 = await post(big('b'), { Authorization: basic });
  ok(o1.status === 200 && o2.status === 200, 'both oversize deliveries are accepted');
  ok(await countFor(`Oversize-${tag}`) === 2,
     'two DIFFERENT oversize deliveries stay two rows — the marker carries a digest of what actually arrived');

  // ...and a genuine RETRY of one of them still collapses, which is the whole point of
  // the dedupe. Distinguishing these two cases is exactly what the digest buys.
  await post(big('a'), { Authorization: basic });
  ok(await countFor(`Oversize-${tag}`) === 2,
     'but a real retry of the same oversize body still collapses — dedupe is not lost to the fix');

  await db.query('DELETE FROM class_callback_events WHERE event_name LIKE $1', [`%${tag}`]);

  // =========================================================================
  // ONE DELIVERY WE CANNOT INTERPRET MUST NOT HOLD UP THE ONES BEHIND IT.
  // Found by the pre-merge correctness audit and reproduced against the real
  // receiver: a failing row kept `processed_at IS NULL` and stayed FIRST in
  // `ORDER BY received_at`, so it sat at the head of every batch forever. The
  // receiver drains at limit 25 — 25 of these and nothing live is processed.
  console.log('\n--- a delivery we cannot interpret steps out of the queue ---');

  // A `data` array containing a null element — the exact payload that threw.
  await post({ eventName: 'NewAttachments', orderId: `cls26-${tag}`, data: [null] }, { Authorization: basic });
  const poison = (await db.query(
    `SELECT id FROM class_callback_events WHERE event_name='NewAttachments' AND class_order_id=$1`,
    [`cls26-${tag}`])).rows[0];
  ok(!!poison, 'the malformed delivery is stored, as every delivery must be');

  // It no longer throws at all — a null element is simply not an attachment.
  //
  // The row is WAITED for rather than read straight after our own drain: the receiver
  // fires its own drain from `setImmediate` on every accepted delivery, and since a
  // delivery is now CLAIMED before it is worked (the duplicate-messages fix), exactly
  // ONE of the two drains does the work — so ours may legitimately find it already
  // taken. Before the claim both drains processed it, which is precisely the defect.
  // The assertion is unchanged in substance: it must end up processed, and no drain
  // may report a failure.
  const d1 = await cb.drain({ limit: 25 });
  let after1 = null;
  for (let i = 0; i < 40; i++) {
    after1 = (await db.query(
      'SELECT processed_at, attempts, dead_at FROM class_callback_events WHERE id=$1', [poison.id])).rows[0];
    if (after1 && after1.processed_at != null) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  ok(after1.processed_at != null,
     'a null element in the attachment list is skipped, not thrown on — the event processes normally');
  ok(after1.attempts === 0 && after1.dead_at == null, 'and it was never recorded as a failed attempt');
  ok(d1.failed === 0, 'and the drain reports no failure');

  // A genuinely unprocessable row (an amount past what the column can hold used to
  // be one) must still not block. Force a failure directly to prove the mechanism.
  const stuck = (await db.query(
    `INSERT INTO class_callback_events (event_name, class_order_id, payload, payload_hash)
     VALUES ('StatusChanged', $1, $2::jsonb, $3) RETURNING id`,
    [`cls26-${tag}`, JSON.stringify({ data: { StatusName: 'Completed' } }), `poison-${tag}`])).rows[0].id;
  // Simulate repeated failures the way processEvent records them.
  await db.query(
    `UPDATE class_callback_events SET attempts=2, process_error='forced', next_attempt_at = now() + interval '1 hour'
      WHERE id=$1`, [stuck]);

  const live = (await db.query(
    `INSERT INTO class_callback_events (event_name, class_order_id, payload, payload_hash)
     VALUES ('StatusChanged', $1, $2::jsonb, $3) RETURNING id`,
    [`cls26-${tag}`, JSON.stringify({ data: { StatusName: 'Completed' } }), `live-${tag}`])).rows[0].id;

  await cb.drain({ limit: 1 });   // limit 1 — the backed-off row must not be the one taken
  const liveRow = (await db.query('SELECT processed_at FROM class_callback_events WHERE id=$1', [live])).rows[0];
  ok(liveRow.processed_at != null,
     'a NEW delivery is processed even at limit 1, because a backed-off failure is no longer first in the queue');

  // Given up on after MAX_ATTEMPTS — kept, never deleted, and answerable.
  await db.query(
    `UPDATE class_callback_events SET attempts=$2, dead_at=now(), process_error='forced'
      WHERE id=$1`, [stuck, cb._internals.MAX_ATTEMPTS]);
  const dl = await cb.deadLetter({ limit: 50 });
  ok(dl.some((r) => String(r.id) === String(stuck)),
     'a delivery we gave up on is still in the table and still answerable — never deleted');
  const d2 = await cb.drain({ limit: 25 });
  ok(d2.failed === 0, 'and it is out of the rotation, so it can never fail a drain again');

  ok(cb._internals.backoffSeconds(1) < cb._internals.backoffSeconds(3),
     'the wait grows with each attempt, so a transient failure retries soon and a hopeless one backs off');

  // Money past what the column can hold is DROPPED, not stored as exponent notation
  // (which Postgres refuses, failing the whole event forever).
  ok(cb._internals.money(1e30) === null, 'an amount too large to store is dropped rather than poisoning the row');
  ok(cb._internals.money(299) === 29900, 'and an ordinary fee still converts to cents');

  // =========================================================================
  // OUR REFERENCE IS THE LOAN NUMBER, SO IT NAMES THE FILE — NEVER THE ORDER.
  console.log('\n--- a reference-only event is never applied to a guess ---');

  // Both orders on this file share 'YSCAP<tag>'? No — order36 carries its own ref.
  // Give the 3.6 order the SAME reference as the 2.6 one, which is what really
  // happens: reference_number is applications.ys_loan_number for every order.
  await db.query('UPDATE class_orders SET reference_number=$2 WHERE id=$1', [order36, 'YSCAP' + tag]);
  await db.query('UPDATE class_orders SET status=$2 WHERE id=$1', [order26, 'ordered']);
  await db.query('UPDATE class_orders SET status=$2 WHERE id=$1', [order36, 'ordered']);

  const ambiguous = await cb.findOrder(null, { referenceNumber: 'YSCAP' + tag });
  ok(ambiguous === null,
     'with two live orders sharing one loan number, a reference-only event matches NEITHER — it is never applied to a guess');

  // Once one is finished, the live one is unambiguous and the event lands correctly.
  await db.query(`UPDATE class_orders SET status='completed' WHERE id=$1`, [order26]);
  const resolved = await cb.findOrder(null, { referenceNumber: 'YSCAP' + tag });
  ok(resolved && String(resolved.id) === String(order36),
     'and once only one order can still receive events, it resolves to that one');

  // Their own order id always wins and is never ambiguous.
  const byId = await cb.findOrder(null, { classOrderId: `cls26-${tag}`, referenceNumber: 'YSCAP' + tag });
  ok(byId && String(byId.id) === String(order26),
     "their order id still wins outright — it identifies the order, unlike our reference");

  await db.query('DELETE FROM class_callback_events WHERE class_order_id = $1', [`cls26-${tag}`]);

  // =========================================================================
  // ONE VENDOR MESSAGE MUST APPEAR ON THE THREAD EXACTLY ONCE.
  // Found by the post-merge security audit and reproduced against the real
  // receiver: `drain` read `WHERE processed_at IS NULL` and only stamped the row
  // at the END, while the receiver fires a drain from `setImmediate` on EVERY
  // accepted delivery — so two drains worked the SAME stored event and both
  // inserted its notes. Class pushes in bursts, so this is ordinary behaviour,
  // not a contrived race. Measured before the fix: one delivery carrying ONE
  // message produced four to seven rows, and the unread badge counted them all.
  // =========================================================================
  console.log('\n--- one message, one row, however many drains race ---');
  {
    // A note with NO vendor id — the shape the partial unique index cannot
    // arbitrate, and the one their guide explicitly allows.
    const ev = (await db.query(
      `INSERT INTO class_callback_events (event_name, class_order_id, payload, payload_hash)
       VALUES ('NewNotes', $1, $2::jsonb, $3) RETURNING id`,
      [`cls26-${tag}`,
       JSON.stringify({ data: [{ content: 'Please confirm access with the tenant.' }] }),
       `burst-notes-${tag}`])).rows[0];

    // Six drains at once, exactly as six deliveries landing together would.
    await Promise.all(Array.from({ length: 6 }, () => cb.drain({ limit: 25 })));
    const notes = await db.query(
      `SELECT count(*)::int AS n FROM class_notes
        WHERE class_order_row = $1 AND direction = 'ToClient' AND class_note_id IS NULL`, [order26]);
    ok(notes.rows[0].n === 1,
       `one vendor message stays ONE row on the thread under six concurrent drains (got ${notes.rows[0].n})`);
    const done = await db.query('SELECT processed_at FROM class_callback_events WHERE id=$1', [ev.id]);
    ok(done.rows[0].processed_at != null, 'and the delivery is still processed — the claim never strands one');

    // A genuine RE-delivery of the same id-less note, days later, is still the
    // same message: the second layer of the guard, independent of the claim.
    await db.query(
      `INSERT INTO class_callback_events (event_name, class_order_id, payload, payload_hash)
       VALUES ('NewNotes', $1, $2::jsonb, $3)`,
      [`cls26-${tag}`,
       JSON.stringify({ data: [{ content: 'Please confirm access with the tenant.' }] }),
       `burst-notes-again-${tag}`]);
    await cb.drain({ limit: 25 });
    const again = await db.query(
      `SELECT count(*)::int AS n FROM class_notes
        WHERE class_order_row = $1 AND direction = 'ToClient' AND class_note_id IS NULL`, [order26]);
    ok(again.rows[0].n === 1, 're-delivering the same id-less note adds nothing');

    // The same hole, mirrored: an attachment announcement with an id and NO name.
    await db.query(
      `INSERT INTO class_callback_events (event_name, class_order_id, payload, payload_hash)
       VALUES ('NewAttachments', $1, $2::jsonb, $3)`,
      [`cls26-${tag}`, JSON.stringify({ data: [{ attachmentId: `att-${tag}` }] }),
       `burst-attach-${tag}`]);
    await Promise.all(Array.from({ length: 6 }, () => cb.drain({ limit: 25 })));
    const att = await db.query(
      `SELECT count(*)::int AS n FROM class_attachments
        WHERE class_order_row = $1 AND name IS NULL`, [order26]);
    ok(att.rows[0].n === 1,
       `a name-less attachment announcement stays ONE row (got ${att.rows[0].n})`);

    // THE OTHER WRITER OF THE SAME TABLE. "Check for replies" (messages.syncNotes) is
    // the one a human presses, and it carried the identical partial-index hole: every
    // press re-inserted an id-less note and the unread badge counted every copy.
    // The integration is switched OFF in a test environment and `syncNotes` refuses
    // early when it is, so both the switch reading and the vendor call are stubbed —
    // what is under test is the INSERT, not the transport.
    // Absolute numbers: the thread is cleared first, so this block does not depend on
    // how many rows the assertions above happened to leave behind.
    await db.query('DELETE FROM class_notes WHERE class_order_row = $1', [order26]);
    const classClient = require('../src/class/client');
    const realNotes = classClient.notes;
    const realConfigured = classClient.configured;
    classClient.configured = () => ({ ...realConfigured(), enabled: true });
    classClient.notes = async () => ({ data: [
      { content: 'Please confirm access with the tenant.', created: '2026-08-12T10:00:00Z' },
      { noteId: `n-${tag}-1`, content: 'The appraiser will call you.' },
    ] });
    const messages = require('../src/class/messages');
    const counts = [];
    for (let i = 0; i < 4; i++) {
      await messages.syncNotes(order26);
      counts.push((await db.query(
        `SELECT count(*)::int AS n FROM class_notes WHERE class_order_row = $1`, [order26])).rows[0].n);
    }
    classClient.notes = realNotes;
    classClient.configured = realConfigured;
    ok(counts[0] === counts[3],
       `pressing "check for replies" four times adds nothing after the first (${counts.join(' → ')})`);
    ok(counts[3] === 2, 'the id-bearing note is added once and the id-less one is not duplicated');

    // A DIFFERENT message must still land — the guard dedupes, it does not swallow.
    await db.query(
      `INSERT INTO class_callback_events (event_name, class_order_id, payload, payload_hash)
       VALUES ('NewNotes', $1, $2::jsonb, $3)`,
      [`cls26-${tag}`, JSON.stringify({ data: [{ content: 'The appraiser is running late.' }] }),
       `burst-notes-other-${tag}`]);
    await cb.drain({ limit: 25 });
    const two = await db.query(
      `SELECT count(*)::int AS n FROM class_notes
        WHERE class_order_row = $1 AND direction = 'ToClient' AND class_note_id IS NULL`, [order26]);
    ok(two.rows[0].n === 2, 'a genuinely different message still lands');

    // …but a genuine NUDGE days later, with the same wording and the vendor's own new
    // timestamp, is a NEW message and must land. Without the timestamp in the identity
    // the guard was a permanent swallow: those words, ever again, dropped in silence.
    await db.query(
      `INSERT INTO class_callback_events (event_name, class_order_id, payload, payload_hash)
       VALUES ('NewNotes', $1, $2::jsonb, $3)`,
      [`cls26-${tag}`,
       JSON.stringify({ data: [{ content: 'Please confirm access with the tenant.', created: '2026-08-20T09:00:00Z' }] }),
       `burst-notes-nudge-${tag}`]);
    await cb.drain({ limit: 25 });
    const nudged = await db.query(
      `SELECT count(*)::int AS n FROM class_notes
        WHERE class_order_row = $1 AND direction = 'ToClient' AND class_note_id IS NULL`, [order26]);
    ok(nudged.rows[0].n === 3, 'a later nudge repeating the same wording still lands — the guard dedupes, it does not swallow');


    await db.query('DELETE FROM class_notes WHERE class_order_row = $1', [order26]);
    await db.query('DELETE FROM class_attachments WHERE class_order_row = $1', [order26]);
    await db.query('DELETE FROM class_callback_events WHERE class_order_id = $1', [`cls26-${tag}`]);
  }

  // The claim must never lose a delivery: a row taken by a drain that then dies is
  // due again once its lease expires, and its attempt count is untouched — a crash
  // costs a retry, not one of the six tries before a delivery is given up on.
  {
    const ev = (await db.query(
      `INSERT INTO class_callback_events (event_name, class_order_id, payload, payload_hash)
       VALUES ('StatusChanged', $1, $2::jsonb, $3) RETURNING id`,
      [`cls26-${tag}`, JSON.stringify({ data: { StatusName: 'Completed' } }), `lease-${tag}`])).rows[0];
    // Claim it the way drain does, then abandon it.
    await db.query(
      `UPDATE class_callback_events SET next_attempt_at = now() + interval '120 seconds' WHERE id=$1`, [ev.id]);
    const skipped = await cb.drain({ limit: 25 });
    const mid = (await db.query(
      'SELECT processed_at, attempts FROM class_callback_events WHERE id=$1', [ev.id])).rows[0];
    ok(mid.processed_at == null && mid.attempts === 0,
       'a claimed delivery is not worked twice, and the claim costs it no attempt');
    ok(skipped.failed === 0, 'and skipping it is not a failure');
    // Lease expires -> due again.
    await db.query(`UPDATE class_callback_events SET next_attempt_at = now() - interval '1 second' WHERE id=$1`, [ev.id]);
    await cb.drain({ limit: 25 });
    const back = (await db.query('SELECT processed_at FROM class_callback_events WHERE id=$1', [ev.id])).rows[0];
    ok(back.processed_at != null, 'once the lease expires the delivery is picked up again — nothing is lost');
    await db.query('DELETE FROM class_callback_events WHERE class_order_id = $1', [`cls26-${tag}`]);
  }

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
