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

  // The person who can open the door. Both appraisal desks carried
  // `propertyContact: null, // filled from file contacts once wired`, so a realtor or
  // contractor recorded on the file for exactly this purpose was never sent to either
  // vendor. One shared reader (src/lib/appraisal-contacts.js) fills it for both.
  {
    const sc = await db.query(
      `INSERT INTO service_contacts (borrower_id, contact_type, company_name, contact_name, email, phone)
       VALUES ($1,'realtor','Keystone Realty','Pat Agent',$2,'570-555-0101') RETURNING id`,
      [borrowerId, `pat.${tag}@example.com`]);
    await db.query(
      `INSERT INTO application_service_contacts (application_id, service_contact_id, contact_type, added_by_kind)
       VALUES ($1,$2,'realtor','staff')`, [appId, sc.rows[0].id]);
    const withAccess = await orderService.loadContext(db, appId);
    ok(withAccess.propertyContact && withAccess.propertyContact.company === 'Keystone Realty',
      'the file’s realtor is finally read as the property-access contact');
    ok(withAccess.propertyContact.firstName === 'Pat' && withAccess.propertyContact.lastName === 'Agent',
      'their name is split for a vendor that wants first + last');
    const built = require('../src/class/order-build').buildOrder(withAccess);
    const roles = (built.body.contacts || []).map((c) => c.Type || c.type);
    ok(roles.includes('PropertyAccess'), 'and Class is actually told about them');
    // Every other file is unaffected: with nobody recorded, the order still says so
    // rather than inventing a contact.
    await db.query('DELETE FROM application_service_contacts WHERE application_id=$1', [appId]);
    const without = await orderService.loadContext(db, appId);
    ok(without.propertyContact === null, 'a file with no such contact still reports none');
  }

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
  ok(byPath.occupancy.value === 'Investment', 'occupancy resolves for an RTL investment file');
  ok(byPath.occupancy.label === 'Occupancy', 'and carries a human label');

  // Missing: no product chosen yet.
  ok(pv.canPlace === false, 'without a product chosen the order cannot be placed');
  ok(pv.missing.some((m) => m.field === 'productId'), 'and the missing product is named');
  ok(byPath.productId.state === 'missing', 'the product row is flagged missing on the screen');

  // --- an override rescues it and is recorded ----------------------------
  const pv2 = await orderService.buildPreview(db, appId, { overrides: { productId: 42 } });
  ok(pv2.canPlace === true, 'choosing a product makes it placeable');
  ok(pv2.overridden.includes('productId'), 'and the choice is recorded as an override');
  const byPath2 = Object.fromEntries(pv2.fields.map((f) => [f.path, f]));
  ok(byPath2.productId.state === 'overridden', 'the screen shows it as chosen by a person');

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
  // AN ORDER-ROW ID IS SANITIZED ONCE AND THAT SANITIZED VALUE IS WHAT TRAVELS.
  // Found by the post-merge security audit: the range check ran on a trimmed copy
  // and the six handlers then bound the RAW parameter, so a value JavaScript trims
  // and Postgres does not — a non-breaking space, U+2028, a byte-order mark — got
  // past the check and reached a bigint bind, where 22P02 was answered by the
  // server's global error mapper rather than by the check written for it. No file
  // could ever be read across (the gate still governs that), but the guarantee was
  // resting on a catch-all.
  // ==========================================================================
  {
    const order = (await db.query(
      `INSERT INTO class_orders (application_id, reference_number, api_version, uad, order_path, status)
       VALUES ($1,$2,'v1','2.6','/orders','ordered') RETURNING id`,
      [appId, 'YSCAP' + tag])).rows[0].id;

    const good = await call('GET', `/api/class/files/${appId}/orders/${order}/thread`);
    ok(good.status === 200, 'the order on this file answers on its own id (the control)');

    for (const [name, prefix] of [['a non-breaking space', '%C2%A0'], ['a line separator', '%E2%80%A8'],
                                  ['a byte-order mark', '%EF%BB%BF'], ['an em space', '%E2%80%83']]) {
      const r = await call('GET', `/api/class/files/${appId}/orders/${prefix}${order}/thread`);
      ok(r.status === 404 && r.body && r.body.error === 'not_found',
         `${name} in the id is answered as "no such order here", not as a server error`);
    }
    // And the ordinary hostile shapes still land on the same path.
    for (const bad of ['99999999999999999999', '0', '-1', 'abc', '1.5']) {
      const r = await call('GET', `/api/class/files/${appId}/orders/${bad}/thread`);
      ok(r.status === 404, `a ${bad} id is 404, never 500`);
    }
    await db.query('DELETE FROM class_orders WHERE id=$1', [order]);
  }

  // --- cleanup ------------------------------------------------------------
  server.close();
  await db.query('DELETE FROM applications WHERE id=$1', [appId]);
  await db.query('DELETE FROM borrowers WHERE id=$1', [borrowerId]);
  await db.query('DELETE FROM staff_users WHERE id = ANY($1::uuid[])', [[officer, outsider]]);

  console.log(`\ntest-class-preview-db: ${pass} passed, ${fail} failed`);
  // NOTE for whoever reads this output next: a trailing
  //   "[request-audit] flush failed … Cannot use a pool after calling end"
  // line is EXPECTED and is not a failure. The shared request audit flushes on its
  // own timer and this test ends the pool first; the exit code above is the verdict.
  await db.pool.end().catch(() => {});
  if (fail) process.exit(1);
}

main().catch(async (e) => { console.error('FAILED', e); try { await db.pool.end(); } catch (_) {} process.exit(1); });
