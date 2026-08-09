'use strict';
/**
 * DB-gated test for the AMC order service (src/amc/order-service.js).
 *
 * The pure logic (form selection, auto-fill, wire builders) is proven without a DB
 * elsewhere. This exercises the DB half against a REAL Postgres — which is the only
 * way to catch a wrong column name in loadContext's join (the repo's recurring
 * "phantom column inside a swallowing catch" class): it runs the actual query, builds
 * a preview, persists a DRAFT order (no network), reads it back, and checks the card
 * status link. Everything runs inside ONE transaction that is ROLLED BACK, so it
 * leaves no rows behind.
 *
 * Skips cleanly without DATABASE_URL.
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');

if (!process.env.DATABASE_URL) {
  console.log('test-amc-order-service-db: skipped (no DATABASE_URL)');
  process.exit(0);
}

const { Pool } = require('pg');
const orderService = require(path.join(ROOT, 'src/amc/order-service'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const { ensureSchema } = require(path.join(ROOT, 'src/migrate-boot'));
  await ensureSchema();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');

    // ---- minimal loan file ----
    const bo = await c.query(
      `INSERT INTO borrowers (first_name, middle_name, last_name, email, cell_phone, current_address)
       VALUES ('Peter','Ben','Parker',$1,'555-0100','{"line1":"1 Aardvark St","city":"NYC","state":"NY","zip":"10001"}')
       RETURNING id`, [`amc-test-${Date.now()}@example.com`]);
    const borrowerId = bo.rows[0].id;

    const llc = await c.query(`INSERT INTO llcs (borrower_id, llc_name) VALUES ($1,'PP Holdings LLC') RETURNING id`, [borrowerId]);
    const app = await c.query(
      `INSERT INTO applications
         (borrower_id, llc_id, ys_loan_number, program, loan_type, property_address,
          property_type, occupancy, purchase_price, loan_amount, est_closing_date)
       VALUES ($1,$2,'YSCAP-AMC-1','bridge','Purchase',
          '{"street":"12 Oak St","city":"Brooklyn","state":"NY","zip":"11249","county":"Kings"}',
          'SFR','Investment',400000,300000,'2026-09-15')
       RETURNING id`, [borrowerId, llc.rows[0].id]);
    const appId = app.rows[0].id;

    // A form-map rule so the preview auto-picks a form.
    await c.query(
      `INSERT INTO amc_form_map (program, property_category, loan_purpose, product_code, subproduct_codes, amc_identifier, priority, active)
       VALUES ('bridge', NULL, NULL, '5', ARRAY['7'], '426', 10, true)`);
    // A wildcard fallback that should LOSE to the specific bridge rule.
    await c.query(
      `INSERT INTO amc_form_map (program, product_code, priority, active) VALUES (NULL, '1', 100, true)`);

    // The appraisal_card condition, so cardStatus can read it.
    await c.query(
      `INSERT INTO checklist_items (application_id, scope, tool_key, label, status, audience, item_kind)
       VALUES ($1,'application','appraisal_card','Appraisal payment card','outstanding','borrower','document')`, [appId]);

    // ---- loadContext: exercises the real column names ----
    const ctx = await orderService.loadContext(c, appId);
    ok(ctx, 'loadContext returns a context');
    ok(ctx.loanNumber === 'YSCAP-AMC-1', 'loan number loaded');
    ok(ctx.program === 'bridge' && ctx.loanPurpose === 'Purchase', 'program + purpose loaded');
    ok(ctx.property.addressLine === '12 Oak St' && ctx.property.state === 'NY' && ctx.property.postalCode === '11249', 'property address parsed from jsonb');
    ok(ctx.property.county === 'Kings', 'county parsed');
    ok(ctx.property.salesContractAmount === 400000, 'purchase price used as sales contract amount (purchase)');
    ok(ctx.entityName === 'PP Holdings LLC', 'vesting entity loaded');
    ok(ctx.borrowers.length === 1 && ctx.borrowers[0].firstName === 'Peter' && ctx.borrowers[0].middleName === 'Ben', 'borrower loaded incl. middle name');
    ok(ctx.borrowers[0].residence && ctx.borrowers[0].residence.city === 'NYC', 'borrower residence parsed');
    ok(ctx.card && ctx.card.conditionStatus === 'outstanding' && ctx.card.onFile === false, 'card status: condition present, no card yet');

    // ---- buildPreview: auto-picks the specific form + fills the spec ----
    const preview = await orderService.buildPreview(c, appId);
    ok(preview && preview.chosenForm && preview.chosenForm.productCode === '5', 'preview auto-picks the specific bridge form (not the wildcard)');
    ok(preview.chosenForm.amcIdentifier === '426', 'preview carries the preferred AMC');
    ok(preview.spec.loan.loanNumber === 'YSCAP-AMC-1' && preview.spec.property.titleCategory === 'Single Family', 'spec filled from the file');
    ok(preview.canPlace === true && preview.missing.length === 0, 'preview is complete → placeable');

    // ---- createOrder (draft, no network) ----
    const draft = await orderService.createOrder(c, appId, { place: false, staffId: null });
    ok(draft.ok === true && draft.draft === true, 'createOrder(place:false) returns a draft');
    ok(draft.order && draft.order.status === 'draft' && draft.order.product_code === '5', 'draft persisted with the chosen form');
    ok(draft.order.request_payload && JSON.stringify(draft.order.request_payload).includes('YSCAP-AMC-1'), 'draft stores the (masked) request payload');
    ok(!JSON.stringify(draft.order.request_payload).includes('DoLogin'), 'draft payload carries no login credentials');

    // ---- listOrders ----
    const list = await orderService.listOrders(c, appId);
    ok(list.length === 1 && list[0].id === draft.order.id, 'listOrders returns the draft');

    // ---- the form's NAME, not just its number (owner-directed 2026-08-09) ----
    // Two sources, both real: the tenant's own catalog in amc_lookup_cache, and the
    // name the owner put on the rule. The catalog wins.
    await c.query(
      `INSERT INTO amc_form_map (program, product_code, product_name, priority, active)
       VALUES ('ground_up', '77', 'Owner label for 77', 20, true)`);
    await c.query(
      `INSERT INTO amc_lookup_cache (lookup_type, subdomain, payload, fetched_at)
       VALUES ('GetJobType', $1, $2::jsonb, now())
       ON CONFLICT (lookup_type, subdomain)
         DO UPDATE SET payload = EXCLUDED.payload, fetched_at = now()`,
      [ctx.subdomain || '', JSON.stringify([{ id: '5', name: '1004 w/ 1007 - Single Family Residence' }])]);

    const named = await orderService.buildPreview(c, appId);
    ok(named.formName === '1004 w/ 1007 - Single Family Residence',
      'the preview names the form from the tenant catalog, not just its number');
    ok(named.chosenForm.formName === named.formName, 'the chosen form carries the same name');
    ok(named.productCode === '5', 'the preview says which product code that name belongs to');
    ok(orderService.formNameFor('77', [], await orderService.formRules(c)) === 'Owner label for 77',
      'a form outside the catalog still gets the name set on its rule');

    const named2 = await orderService.createOrder(c, appId, { place: false, staffId: null });
    ok(named2.order.form_description === '1004 w/ 1007 - Single Family Residence',
      'the order records the form NAME, so the orders list never shows a bare number');

    // ---- the four role contacts (owner-directed 2026-08-09) ----
    // Class Valuation carries Borrower / Co-borrower / Property access / Loan officer;
    // the AMC now carries the same four people, read by the SHARED reader.
    const sc = await c.query(
      `INSERT INTO service_contacts (borrower_id, contact_type, company_name, contact_name, email, phone)
       VALUES ($1,'realtor','Acme Realty','Dana Realtor','dana@acme.test','555-9000') RETURNING id`, [borrowerId]);
    await c.query(
      `INSERT INTO application_service_contacts (application_id, service_contact_id, contact_type, added_by_kind)
       VALUES ($1,$2,'realtor','staff')`, [appId, sc.rows[0].id]);
    const lo = await c.query(
      `INSERT INTO staff_users (email, full_name, role, phone, password_hash, is_active)
       VALUES ($1,'Moshe Officer','loan_officer','555-7000','x',true) RETURNING id`,
      [`amc-lo-${Date.now()}@example.com`]);
    await c.query(`UPDATE applications SET loan_officer_id=$2 WHERE id=$1`, [appId, lo.rows[0].id]);

    const withPeople = await orderService.buildPreview(c, appId);
    const role = (r) => (withPeople.spec.contacts || []).find((x) => x.role === r);
    ok(role('Borrower') && role('Borrower').email, 'the borrower is on the order');
    ok(role('PropertyAccess') && role('PropertyAccess').company === 'Acme Realty',
      'the realtor who can open the door is finally sent — this was never wired for either vendor');
    ok(role('PropertyAccess').phone === '555-9000', 'their phone number travels');
    ok(role('LoanOfficer') && role('LoanOfficer').email, 'our loan officer is on the order');
    ok(withPeople.spec.notifyEmails.some((e) => /amc-lo-/.test(e)),
      'the officer is copied on the appraisal company’s notices (their loan-officer slot is the note buyer’s)');
    ok(withPeople.spec.parties.bestContact === 'Agent',
      'with a property-access contact, that is who the appraiser is told to call');
    ok((withPeople.contactNotes || []).length === 0, 'nothing left to warn about once all four are on file');

    // ---- TEST MODE / no login must never 500 (owner-reported 2026-08-09) ----
    // The AMC master switch is off in a test environment, which is exactly the state
    // the owner hit: pressing "Place order" used to throw out of here and surface as
    // the server's generic "Something went wrong on our end".
    let threw = null;
    let placed = null;
    try { placed = await orderService.createOrder(c, appId, { place: true, staffId: null }); }
    catch (e) { threw = e; }
    ok(!threw, 'placing an order with no live connection does not throw');
    ok(placed && placed.ok === false && placed.error === 'not_connected',
      'it is refused as "not connected", not as a server error');
    ok(placed && /switched off|isn’t set up|Could not sign in/.test(placed.message || ''),
      'the refusal says in plain words what is wrong');
    ok(placed && placed.order && placed.order.status === 'draft',
      'and the work is saved as a draft rather than thrown away');

    // ---- a refinance file must NOT carry a sales-contract amount ----
    const refi = await c.query(
      `INSERT INTO applications (borrower_id, ys_loan_number, program, loan_type, property_address, property_type, purchase_price, loan_amount)
       VALUES ($1,'YSCAP-AMC-2','bridge','Refi Cash-Out','{"street":"9 Elm St","city":"Queens","state":"NY","zip":"11375"}','SFR',250000,200000)
       RETURNING id`, [borrowerId]);
    const rctx = await orderService.loadContext(c, refi.rows[0].id);
    ok(rctx.property.salesContractAmount == null, 'refinance carries no sales-contract amount');
    ok(rctx.loanPurpose === 'Refi Cash-Out', 'refinance loan purpose carried through');

    await c.query('ROLLBACK');
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (_) { /* ignore */ }
    fail++; console.error('  FAIL (threw):', e.message);
  } finally {
    c.release();
    await pool.end();
  }

  console.log(`\n[test-amc-order-service-db] ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
