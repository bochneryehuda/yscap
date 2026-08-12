'use strict';
/**
 * Class Valuation preview + order desk — real Postgres.
 *
 * A pure test cannot catch a wrong column name (it mocks the query), and this
 * repo has been bitten by exactly that class more than once — a phantom column
 * inside a swallowing catch reads as "no data" forever. So this drives the real
 * routes against a real file.
 *
 * What it pins:
 *   • the preview lists EVERY field that would be sent, walked from the built
 *     body rather than a hand-kept list;
 *   • a derived value is labelled derived, a missing one blocks;
 *   • ordering refuses without an explicit confirm, refuses while incomplete,
 *     and refuses while the switches are off — in that order;
 *   • the per-file scope still 403s a staffer who is not on the file.
 */
const { signJwt } = require('../src/lib/crypto');
if (!process.env.DATABASE_URL) { console.log('test-class-preview-db: SKIP (no DATABASE_URL)'); process.exit(0); }

const db = require('../src/db');
const orderService = require('../src/class/order-service');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('PASS ' + l); } else { fail++; console.error('FAIL ' + l); } };

const rid = () => Math.random().toString(36).slice(2, 10);

async function main() {
  const tag = rid();
  // --- a real file -------------------------------------------------------
  const b = await db.query(
    `INSERT INTO borrowers (first_name, last_name, email, cell_phone)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    ['Ada', 'Reyes-' + tag, `ada.${tag}@example.com`, '5551234567']);
  const borrowerId = b.rows[0].id;

  const a = await db.query(
    `INSERT INTO applications (borrower_id, ys_loan_number, loan_type, property_type, occupancy,
                               property_address, purchase_price, loan_amount, status)
     VALUES ($1,$2,'fix_and_flip','Single Family','investment',
             $3::jsonb, 180000, 250000, 'underwriting')
     RETURNING id`,
    [borrowerId, 'YSCAP' + tag,
     JSON.stringify({ addressLine: '195 Parrish St', city: 'Wilkes-Barre', state: 'PA', postalCode: '18702', county: 'Luzerne' })]);
  const appId = a.rows[0].id;

  // --- the context loader reads real columns -----------------------------
  const ctx = await orderService.loadContext(db, appId);
  ok(!!ctx, 'loadContext returns a context (every column it names really exists)');
  ok(ctx.referenceNumber === 'YSCAP' + tag, 'our loan number becomes the reference number');
  ok(ctx.property.city === 'Wilkes-Barre', 'the address is read out of the jsonb');
  ok(ctx.property.category === 'sfr', 'the property type is the CANONICAL key, not the raw label');
  ok(ctx.borrower.email === `ada.${tag}@example.com`, 'the borrower comes through');

  // --- the preview shows everything --------------------------------------
  const pv = await orderService.buildPreview(db, appId);
  ok(!!pv, 'a preview is produced');

  // The whole point of the feature: every field, not a chosen four.
  const paths = pv.fields.map((f) => f.path);
  for (const want of ['referenceNumber', 'property.street', 'property.city', 'property.state',
                      'property.zip', 'loanInfo.loanNumber', 'loanInfo.loanAmount',
                      'loanInfo.loanType', 'purpose', 'occupancy', 'propertyTypeEnum',
                      'lender.clientName', 'contractPrice']) {
    ok(paths.includes(want), `the preview lists ${want}`);
  }
  ok(pv.fields.length >= 15, `the preview is comprehensive (${pv.fields.length} fields), not a summary`);
  ok(pv.fields.every((f) => f.label && f.label !== f.path || /\./.test(f.path)),
     'fields carry a human label');

  // Provenance is what makes the screen readable.
  const byPath = Object.fromEntries(pv.fields.map((f) => [f.path, f]));
  ok(byPath['loanInfo.loanType'].state === 'derived',
     'their loan type is marked DERIVED — Class has no fix-and-flip value');
  ok(/Bridge/.test(byPath['loanInfo.loanType'].why || ''),
     'and the reason says where the deal\'s real nature went');
  ok(byPath['property.city'].state === 'read', 'a value read straight off the file is marked read');
  ok(byPath.occupancy.value === 'Investor', 'occupancy leads with Investor for an RTL investment file (the rejected "Investment" is no longer the head)');
  ok(Array.isArray(pv.occupancyCandidates) && pv.occupancyCandidates[0] === 'Investor'
     && pv.occupancyCandidates.includes('Other') && pv.occupancyKey === 'investment',
     'the preview exposes the full occupancy cascade + the classification it is remembered under');
  ok(byPath.occupancy.label === 'Occupancy', 'and carries a human label');

  // Missing: no product chosen yet.
  ok(pv.canPlace === false, 'without a product chosen the order cannot be placed');
  ok(pv.missing.some((m) => m.field === 'productId'), 'and the missing product is named');
  ok(byPath.productId.state === 'missing', 'the product row is flagged missing on the screen');

  // --- product AUTO-PICK from class_form_map (the NAN parity gap) --------------
  // Seed ONE rule that matches this fix&flip / SFR deal and the product is chosen for
  // the desk automatically; a staff override still wins; removing the rule restores the
  // ask-a-human default. The map ships EMPTY, so this proves the mechanism WITHOUT
  // changing the inert base behaviour every other assertion in this file relies on.
  // priority 20 keeps the row outside uq_class_form_map_default, and note=<tag> makes the
  // seed uniquely this run's so a concurrent run can never delete it out from under us.
  const clsEnv = require('../src/config').class.environment;
  const seedTag = `t-${tag}`;
  await db.query(
    `INSERT INTO class_form_map (loan_type, property_key, product_id, product_name, priority, environment, note)
     VALUES ('fix_and_flip','sfr','56634','1004 - SFR - Class', 20, $1, $2)`, [clsEnv, seedTag]);

  const pvAuto = await orderService.buildPreview(db, appId);
  ok(pvAuto.chosenProduct && pvAuto.chosenProduct.productId === '56634',
     'a class_form_map rule auto-picks the product for the deal (fix&flip SFR -> 56634)');
  ok(pvAuto.chosenProduct.productName === '1004 - SFR - Class', 'and carries the product name for the screen');
  ok(String(pvAuto.body.productId) === '56634', 'the auto-picked product rides the order body');
  ok(pvAuto.canPlace === true, 'so a fully-addressed file is now placeable with no human pick');
  const pAuto = Object.fromEntries(pvAuto.fields.map((f) => [f.path, f]));
  ok(pAuto.productId && pAuto.productId.state !== 'missing', 'and the product row is no longer flagged missing');

  // A staff override still WINS over the auto-pick.
  const pvAutoOv = await orderService.buildPreview(db, appId, { overrides: { productId: 999 } });
  ok(String(pvAutoOv.body.productId) === '999', 'a staff-chosen product still overrides the auto-pick');
  ok(pvAutoOv.overridden.includes('productId'), 'and the override is recorded as a human choice');

  // Remove the rule — the mechanism is INERT again, exactly as it ships.
  await db.query('DELETE FROM class_form_map WHERE note=$1', [seedTag]);
  const pvNone = await orderService.buildPreview(db, appId);
  ok(pvNone.chosenProduct === null, 'with the map empty again, nothing is auto-picked');
  ok(pvNone.canPlace === false && pvNone.missing.some((m) => m.field === 'productId'),
     'and the desk asks a human to pick, exactly as before the map was seeded');

  // --- an override rescues it and is recorded ----------------------------
  const pv2 = await orderService.buildPreview(db, appId, { overrides: { productId: 42 } });
  ok(pv2.canPlace === true, 'choosing a product makes it placeable');
  ok(pv2.overridden.includes('productId'), 'and the choice is recorded as an override');
  const byPath2 = Object.fromEntries(pv2.fields.map((f) => [f.path, f]));
  ok(byPath2.productId.state === 'overridden', 'the screen shows it as chosen by a person');

  // --- county is DERIVED from the address when the file lacks one ---------
  // Class REQUIRES a county ("The County field is required" — the owner's live
  // 400), and a mailing address rarely carries one. buildPreview geocodes it
  // (stubbed here so the test never touches the network) and records it as a
  // STATED assumption; without a resolvable county the order is blocked with a
  // plain reason rather than sending null for Class to reject.
  {
    const addressCanon = require('../src/lib/address-canon');
    const origResolve = addressCanon.resolveCounty;
    await db.query(`UPDATE applications SET property_address = property_address - 'county' WHERE id=$1`, [appId]);

    addressCanon.resolveCounty = async () => null;               // the geocode cannot place it
    const noC = await orderService.buildPreview(db, appId, { overrides: { productId: 42 } });
    const byNoC = Object.fromEntries(noC.fields.map((f) => [f.path, f]));
    ok(noC.canPlace === false && byNoC['property.county'] && byNoC['property.county'].state === 'missing',
       'a county-less file with no geocode result blocks the order and flags county missing');

    addressCanon.resolveCounty = async () => 'Kings County';     // the geocode resolves it
    const gotC = await orderService.buildPreview(db, appId, { overrides: { productId: 42 } });
    const byGotC = Object.fromEntries(gotC.fields.map((f) => [f.path, f]));
    ok(gotC.body.property.county === 'Kings County' && gotC.canPlace === true,
       'a derived county fills the field Class requires and unblocks the order');
    ok(byGotC['property.county'].state === 'derived',
       'and is shown DERIVED — a value the reviewer confirms, never a silent default');
    ok(gotC.assumptions.some((a) => a.field === 'property.county' && /property address/i.test(a.why || '')),
       'the assumption says it was read from the property address');

    addressCanon.resolveCounty = origResolve;
    await db.query(`UPDATE applications SET property_address = jsonb_set(property_address, '{county}', '"Luzerne"') WHERE id=$1`, [appId]);
  }

  // --- a walked body cannot fall behind the builder ----------------------
  const bodyLeaves = [];
  (function walk(o, p) {
    for (const [k, v] of Object.entries(o || {})) {
      const path = p ? `${p}.${k}` : k;
      if (Array.isArray(v)) continue;
      if (v && typeof v === 'object') { walk(v, path); continue; }
      bodyLeaves.push(path);
    }
  })(pv2.body, '');
  const missingFromScreen = bodyLeaves.filter((p) => !paths.includes(p) && !pv2.fields.some((f) => f.path === p));
  ok(missingFromScreen.length === 0,
     `every field in the body appears on the screen (unshown: ${missingFromScreen.join(', ') || 'none'})`);

  // ==========================================================================
  // THE ORDERING GATES, over real HTTP. These are the four refusals that stand
  // between a click and an appraiser being dispatched to someone's property, and
  // they are the reason this test boots the real server rather than calling the
  // service directly: three of the four live in the ROUTE, not in the builder.
  // ==========================================================================
  const app = require('../src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const officer = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,$2,'loan_officer',true) RETURNING id`,
    [`cls-lo-${tag}@example.test`, 'Ophelia Officer'])).rows[0].id;
  const outsider = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,$2,'loan_officer',true) RETURNING id`,
    [`cls-out-${tag}@example.test`, 'Otto Other'])).rows[0].id;
  await db.query('UPDATE applications SET loan_officer_id=$2 WHERE id=$1', [appId, officer]);
  await db.query(`INSERT INTO application_assignees (application_id, staff_id, role)
                  VALUES ($1,$2,'loan_officer') ON CONFLICT DO NOTHING`, [appId, officer]);

  // ==========================================================================
  // THE NOTIFY LIST — the NAN parity gap. Class must email the loan officer, the
  // processor AND the borrower(s) as the appraisal moves, the same set NAN carries
  // as products[].notifications. loadContext builds it and the preview surfaces it.
  // ==========================================================================
  const processor = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,$2,'processor',true) RETURNING id`,
    [`cls-pr-${tag}@example.test`, 'Percy Processor'])).rows[0].id;
  const cob = (await db.query(
    `INSERT INTO borrowers (first_name, last_name, email, cell_phone)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    ['Cody', 'Coborrow-' + tag, `cody.${tag}@example.com`, '5559990000'])).rows[0].id;
  await db.query('UPDATE applications SET processor_id=$2, co_borrower_id=$3 WHERE id=$1', [appId, processor, cob]);

  const ctxN = await orderService.loadContext(db, appId);
  const wantEmails = [`cls-lo-${tag}@example.test`, `cls-pr-${tag}@example.test`,
                      `ada.${tag}@example.com`, `cody.${tag}@example.com`];
  ok(wantEmails.every((e) => ctxN.notifyEmails.includes(e)),
     'notifyEmails carries the loan officer, the processor AND both borrowers');
  ok(ctxN.notifyEmails.length === 4, 'and nobody appears twice');

  // Class's notification list accepts EXACTLY ONE item, of type BorrowerInfo — its
  // enum has no other type, and more than one is rejected ("should have exactly one
  // item of type BorrowerInfo"). So the built body carries a SINGLE notification: the
  // borrower's own email. The preview surfaces exactly what goes out (that one
  // recipient), not the whole notify pool the loan officer / processor sit in.
  const pvN = await orderService.buildPreview(db, appId, { overrides: { productId: 42 } });
  ok(Array.isArray(pvN.notifyEmails) && pvN.notifyEmails.length === 1 &&
     pvN.notifyEmails[0] === `ada.${tag}@example.com`,
     'the preview surfaces the ONE recipient that actually goes out (the borrower)');
  ok((pvN.body.notificationList || []).length === 1 &&
     // The key is `Type` on UAD 2.6 and `type` on 3.6 — read whichever this version emitted.
     (pvN.body.notificationList[0].Type != null ? pvN.body.notificationList[0].Type : pvN.body.notificationList[0].type) === 'BorrowerInfo' &&
     (pvN.body.notificationList[0].Email != null ? pvN.body.notificationList[0].Email : pvN.body.notificationList[0].email) === `ada.${tag}@example.com`,
     'the order body carries exactly one BorrowerInfo entry — the borrower\'s email');

  // A DEACTIVATED processor drops out — an appraiser notice must never chase a
  // staffer who has left, exactly as the AMC desk does.
  await db.query('UPDATE staff_users SET is_active=false WHERE id=$1', [processor]);
  const ctxOff = await orderService.loadContext(db, appId);
  ok(!ctxOff.notifyEmails.includes(`cls-pr-${tag}@example.test`),
     'a deactivated processor is dropped from the notify list');
  ok(ctxOff.notifyEmails.includes(`cls-lo-${tag}@example.test`),
     'while the active loan officer stays on it');
  await db.query('UPDATE staff_users SET is_active=true WHERE id=$1', [processor]);

  const jwtFor = (id) => signJwt({ sub: id, kind: 'staff', role: 'loan_officer', tv: 0, sid: 'test' });
  const call = async (method, path, body, jwt) => {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${jwt || jwtFor(officer)}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let j = null; try { j = await r.json(); } catch (_) { /* a non-JSON body is still a result */ }
    return { status: r.status, body: j };
  };

  // The screen's own data feed.
  const cfgRes = await call('GET', '/api/class/config');
  ok(cfgRes.status === 200, 'the config route answers');
  ok(cfgRes.body && cfgRes.body.enums && Array.isArray(cfgRes.body.enums.propertyTypeEnum),
     'and hands the screen Class\'s own value lists, so the picker cannot drift from the builder');
  ok(!JSON.stringify(cfgRes.body).match(/client_?secret|password/i),
     'and carries no credential of any shape');

  // GATE 1 — a GET can never place an order, and a POST without an explicit
  // confirmation is a refusal rather than a default.
  const noConfirm = await call('POST', `/api/class/files/${appId}/order`, { overrides: { productId: 42 } });
  ok(noConfirm.status === 400 && noConfirm.body.error === 'confirm_required',
     'ordering without an explicit confirmation is refused');

  // GATE 2 — incomplete is refused, and the refusal NAMES what is missing. This
  // is re-checked at send time, not trusted from whatever the screen last saw.
  const incomplete = await call('POST', `/api/class/files/${appId}/order`, { confirm: true });
  ok(incomplete.status === 422 && incomplete.body.error === 'incomplete',
     'a file with no product chosen cannot be ordered');
  ok((incomplete.body.missing || []).some((m) => m.field === 'productId'),
     'and the refusal names the missing product rather than a generic error');

  // GATE 3 — with everything filled in, the SWITCHES are still the last word.
  const switchedOff = await call('POST', `/api/class/files/${appId}/order`, { confirm: true, overrides: { productId: 42 } });
  ok(switchedOff.status === 409 && /CLASS_(DISABLED|NOT_CONFIGURED)/.test(switchedOff.body.error || ''),
     'a complete order still cannot go out while the connection is switched off');

  // GATE 4 — the per-file scope. A staffer who is not on this file cannot see the
  // preview and cannot order, and gets the same 403 either way.
  const jwtOut = jwtFor(outsider);
  const peek = await call('GET', `/api/class/files/${appId}/preview`, null, jwtOut);
  ok(peek.status === 403, 'a staffer who is not on the file cannot see the order preview');
  const sneak = await call('POST', `/api/class/files/${appId}/order`, { confirm: true, overrides: { productId: 42 } }, jwtOut);
  ok(sneak.status === 403, 'and cannot order on it either');

  // The preview over HTTP must agree with the preview computed in-process — the
  // screen and the send would otherwise be looking at two different orders.
  const httpPv = await call('GET', `/api/class/files/${appId}/preview?productId=42`);
  ok(httpPv.status === 200 && httpPv.body.canPlace === true, 'the HTTP preview accepts an override from the screen');
  ok(httpPv.body.fields.length === pv2.fields.length, 'and lists exactly the same fields as the service does');

  // ==========================================================================
  // BOTH UAD VERSIONS, END TO END. 2.6 is the default; 3.6 can be chosen for ONE
  // order without moving anyone else. The preview and the send must agree about
  // WHICH — a 2.6 body posted to the 3.6 endpoint (or the reverse) would have its
  // renamed fields silently dropped.
  // ==========================================================================
  const pv26 = await call('GET', `/api/class/files/${appId}/preview?productId=42`);
  const pv36 = await call('GET', `/api/class/files/${appId}/preview?productId=42&apiVersion=v2`);
  ok(pv26.body.uad === '2.6' && pv26.body.path === '/orders',
     'with nothing asked for, the preview is a UAD 2.6 order on /orders');
  ok(pv36.body.uad === '3.6' && pv36.body.path === '/v2/orders',
     'choosing the newer form previews a UAD 3.6 order on /v2/orders');
  ok(pv26.body.body.propertyTypeEnum === 'SingleFamily' && pv26.body.body.propertyType === undefined,
     'and the 2.6 body carries the 2.6 field name');
  ok(pv36.body.body.propertyType === 'SingleFamily' && pv36.body.body.propertyTypeEnum === undefined,
     'while the 3.6 body carries the 3.6 one — never both, never the wrong one');
  ok(pv36.body.options.occupancyIsEnum === true && pv26.body.options.occupancyIsEnum === false,
     'the screen is told occupancy is a closed list on 3.6 and free text on 2.6');
  ok(pv36.body.fields.some((f) => f.path === 'propertyType') &&
     !pv36.body.fields.some((f) => f.path === 'propertyTypeEnum'),
     'the 3.6 preview lists the field under the name it will actually be sent as');
  ok(pv36.body.defaultVersion === 'v1',
     'and the screen is told 2.6 is still everyone else\'s default');

  // The version rides the same override channel as every other correction, so it is
  // covered by the same allowlist and shows on the screen as a human choice.
  ok((pv36.body.overridden || []).includes('apiVersion'),
     'choosing the version is recorded as a deliberate choice, not a silent switch');

  // An override the allowlist does not carry is DROPPED, never passed through.
  const smuggle = await call('GET', `/api/class/files/${appId}/preview?productId=42&amcName=Someone%20Else`);
  ok(smuggle.status === 200 && smuggle.body.body.amcName === undefined,
     'a field outside the allowlist cannot be smuggled into the order body');

  // ==========================================================================
  // THE OCCUPANCY CASCADE, END TO END. v1 `occupancy` binds to an undocumented live
  // enum, so the sender tries the candidate list IN ORDER on the specific occupancy
  // binding 400 and stops at the first Class accepts. We stub the vendor call — the
  // whole point is to prove the ROUTE cascades, remembers, and records the winner
  // without ever placing more than one real order.
  // ==========================================================================
  const client = require('../src/class/client');
  const origCreate = client.createOrder;
  const origConfigured = client.configured;
  // Enabled + ready so the four gates pass; dryrun off so the real send path runs.
  client.configured = () => ({
    enabled: true, ready: true, dryrun: false, outbound: true, apiVersion: 'v1',
    environment: 'uat', hasClient: true, hasUser: true, hostsConfirmed: true, callbackReady: true,
  });
  const occErr = () => Object.assign(new Error('Class createOrder failed: HTTP 400'), {
    status: 400,
    body: { success: false, code: '400', error: 'The JSON value could not be converted to CV.OrdersExternal.Common.Orders.OccupancyTypeEnum. Path: $.occupancy | LineNumber: 0 | BytePositionInLine: 987.' },
  });

  // --- the first order of this classification cascades to the value Class takes ---
  orderService._internals.LEARNED_OCCUPANCY.clear();
  let calls = [];
  let failSet = new Set(['Investor', 'NonOwnerOccupied']);   // first two refused, third accepted
  client.createOrder = async (b) => {
    calls.push(b.occupancy);
    if (failSet.has(b.occupancy)) throw occErr();
    return { orderId: 7788, transactionId: 'tx-' + b.occupancy };
  };
  const placed = await call('POST', `/api/class/files/${appId}/order`, { confirm: true, overrides: { productId: 42 } });
  ok(placed.status === 200 && placed.body.ok === true && String(placed.body.orderId) === '7788',
     'the order succeeds once Class accepts a candidate — one real order, not one per try');
  ok(JSON.stringify(calls) === JSON.stringify(['Investor', 'NonOwnerOccupied', 'InvestmentProperty']),
     'the sender walked the cascade IN ORDER, stopping at the first value Class took');
  ok(placed.body.body.occupancy === 'InvestmentProperty',
     'and the response reports the occupancy that was actually accepted, not the first guess');
  const row1 = (await db.query(
    `SELECT status, class_order_id, request_body FROM class_orders
      WHERE application_id=$1 ORDER BY id DESC LIMIT 1`, [appId])).rows[0];
  ok(row1 && row1.status === 'ordered' && String(row1.class_order_id) === '7788',
     'the ONE order row records the success (never a row per rejected candidate)');
  ok(row1 && row1.request_body && row1.request_body.occupancy === 'InvestmentProperty',
     'and its stored request body carries the accepted occupancy, not the first-guess one');
  ok(orderService.learnedOccupancy('v1', 'investment') === 'InvestmentProperty',
     'the winner is remembered for this environment + version + classification');

  // --- the next order of the same shape starts on the learned value, no cascade ---
  calls = [];
  const placed2 = await call('POST', `/api/class/files/${appId}/order`, { confirm: true, overrides: { productId: 42 } });
  ok(placed2.status === 200 && placed2.body.ok === true,
     'a second order of the same classification also succeeds');
  ok(JSON.stringify(calls) === JSON.stringify(['InvestmentProperty']),
     'and it goes out on the learned value in ONE call — the cascade is not re-walked');

  // --- a DIFFERENT field's error stops the cascade at once and surfaces as itself ---
  orderService._internals.LEARNED_OCCUPANCY.clear();
  calls = [];
  client.createOrder = async (b) => {
    calls.push(b.occupancy);
    throw Object.assign(new Error('Class createOrder failed: HTTP 400'), {
      status: 400, body: { error: 'could not be converted to PropertyTypeEnum. Path: $.propertyTypeEnum' } });
  };
  const stopped = await call('POST', `/api/class/files/${appId}/order`, { confirm: true, overrides: { productId: 42 } });
  ok(stopped.status === 502 && (stopped.body.error === 'order_failed'),
     'a non-occupancy failure is surfaced, not swallowed by the cascade');
  ok(calls.length === 1, 'and the cascade stopped on the first try — it never retries past a real error');
  const rowErr = (await db.query(
    `SELECT status, last_error FROM class_orders WHERE application_id=$1 ORDER BY id DESC LIMIT 1`, [appId])).rows[0];
  ok(rowErr && rowErr.status === 'error', 'the order row records the error');

  client.createOrder = origCreate;
  client.configured = origConfigured;

  // Remove the three test order rows so the cleanup below can drop the app.
  await db.query('DELETE FROM class_orders WHERE application_id=$1', [appId]);

  // --- cleanup ------------------------------------------------------------
  server.close();
  await db.query('DELETE FROM class_form_map WHERE note=$1', [seedTag]);
  await db.query('DELETE FROM applications WHERE id=$1', [appId]);
  await db.query('DELETE FROM borrowers WHERE id = ANY($1::uuid[])', [[borrowerId, cob]]);
  await db.query('DELETE FROM staff_users WHERE id = ANY($1::uuid[])', [[officer, outsider, processor]]);

  console.log(`\ntest-class-preview-db: ${pass} passed, ${fail} failed`);
  // NOTE for whoever reads this output next: a trailing
  //   "[request-audit] flush failed … Cannot use a pool after calling end"
  // line is EXPECTED and is not a failure. The shared request audit flushes on its
  // own timer and this test ends the pool first; the exit code above is the verdict.
  await db.pool.end().catch(() => {});
  if (fail) process.exit(1);
}

main().catch(async (e) => { console.error('FAILED', e); try { await db.pool.end(); } catch (_) {} process.exit(1); });
