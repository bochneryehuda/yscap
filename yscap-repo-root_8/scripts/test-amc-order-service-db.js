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
    // SEEDED UNDER THE TENANT'S OWN KEY, NOT UNDER WHATEVER THE READER ASKS FOR.
    // This is the audit's finding: the first version of this test seeded under
    // `ctx.subdomain || ''` — the same key the reader uses — so it matched by
    // construction and could not see that with AMC_SUBDOMAIN unset (the state today)
    // the real catalog, which db/481 seeds under 'nan', was invisible. Every form the
    // owner had not also named on a rule still printed a bare number, and the override
    // dropdown was empty. 'nan' is the live tenant; the reader is given nothing.
    await c.query(
      `INSERT INTO amc_lookup_cache (lookup_type, subdomain, payload, fetched_at)
       VALUES ('GetJobType', 'nan', $1::jsonb, now())
       ON CONFLICT (lookup_type, subdomain)
         DO UPDATE SET payload = EXCLUDED.payload, fetched_at = now()`,
      [JSON.stringify([
        { id: '5', name: '1004 w/ 1007 - Single Family Residence' },
        { id: '56012', name: '1004D - Appraisal Update' },
      ])]);
    ok(!ctx.subdomain, 'the test runs with no AMC_SUBDOMAIN configured — the live state');

    const named = await orderService.buildPreview(c, appId);
    ok(named.formName === '1004 w/ 1007 - Single Family Residence',
      'the preview names the form from the tenant catalog, not just its number');
    ok(named.chosenForm.formName === named.formName, 'the chosen form carries the same name');
    ok(named.productCode === '5', 'the preview says which product code that name belongs to');
    ok(orderService.formNameFor('77', [], await orderService.formRules(c)) === 'Owner label for 77',
      'a form outside the catalog still gets the name set on its rule');
    ok(named.forms.length > 0,
      'the full form list reaches the override dropdown — the owner asked for every form, not the nine we named');
    ok(named.forms.some((f) => String(f.id) === '56012'),
      'including a form no rule mentions');

    // A STAFF OVERRIDE IS NAMED FROM ITS OWN CODE, and so is the auto-picked form.
    // Naming `chosenForm` from the SPEC labelled the auto-picked code with the
    // overridden form's name — the "confidently describes the wrong report" failure,
    // arriving through an override instead of through a wrong tenant.
    const over = await orderService.buildPreview(c, appId, { overrides: { productCode: '56012' } });
    ok(over.formName === '1004D - Appraisal Update' && over.productCode === '56012',
      'the preview names the form staff actually picked');
    ok(over.chosenForm.productCode === '5' && over.chosenForm.formName === '1004 w/ 1007 - Single Family Residence',
      'while the auto-picked form keeps ITS OWN name — the two can never be crossed');

    // THE RULES ARE SCOPED TO THIS ENVIRONMENT. db/481 gave the table an `environment`
    // column because their ids differ between UAT and production, and said the
    // resolver would only read matching rows — nothing implemented it, so a UAT rule
    // could pick, and now name, a production form.
    await c.query(
      `INSERT INTO amc_form_map (loan_type, property_key, product_code, product_name, priority, environment, active)
       VALUES ('bridge','sfr','999','A UAT-only form', 1, 'uat', true)`);
    const rulesNow = await orderService.formRules(c);
    ok(!rulesNow.some((r) => String(r.product_code) === '999'),
      'a rule from another environment is never used, whatever its priority');

    const named2 = await orderService.createOrder(c, appId, { place: false, staffId: null });
    ok(named2.order.form_description === '1004 w/ 1007 - Single Family Residence',
      'the order records the form NAME, so the orders list never shows a bare number');

    // AN ORDER THAT ALREADY EXISTS IS NAMED TOO — the owner's actual report. The name is
    // recorded when an order is CREATED, so every order placed before that existed has
    // none, and the list fell back to "Form 56634" on exactly the screen he reported it
    // from. A backfill cannot fix it (the names live in the vendor's per-tenant
    // catalogue), so it is resolved on READ, through the same rule the builder uses.
    await c.query(`UPDATE amc_orders SET form_description = NULL WHERE id = $1`, [named2.order.id]);
    const relisted = await orderService.listOrders(c, appId);
    const back = relisted.find((o) => String(o.id) === String(named2.order.id));
    ok(back && back.form_description === '1004 w/ 1007 - Single Family Residence',
      'an order stored with no form name is named when the list is read');
    const backOne = await orderService.getOrder(c, named2.order.id);
    ok(backOne && backOne.form_description === '1004 w/ 1007 - Single Family Residence',
      'and so is a single order read on its own');
    const stillNull = await c.query(`SELECT form_description FROM amc_orders WHERE id = $1`, [named2.order.id]);
    ok(stillNull.rows[0].form_description === null,
      'reading it never writes to the row — the name is resolved, not persisted behind our back');

    // A NAME ALREADY ON THE ROW IS NEVER REPLACED: it may be the vendor's own wording,
    // which is more authoritative than anything we can look up.
    await c.query(`UPDATE amc_orders SET form_description = 'What the vendor called it' WHERE id = $1`,
      [named2.order.id]);
    const kept = await orderService.getOrder(c, named2.order.id);
    ok(kept.form_description === 'What the vendor called it', 'a stored form name always wins');

    // A product code the catalogue does not know leaves the number showing rather than
    // guessing, and must never throw on the read path.
    await c.query(`UPDATE amc_orders SET form_description = NULL, product_code = 'no-such-code' WHERE id = $1`,
      [named2.order.id]);
    const unknown = await orderService.getOrder(c, named2.order.id);
    ok(unknown && unknown.form_description == null, 'an unknown form code is left unnamed, never invented');

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

    // THE LINK'S TYPE AND THE DIRECTORY'S TYPE DO DIVERGE, and the reader must ask
    // ONE question about it. The vendor-MERGE route re-points a link at a surviving
    // directory row without touching the link's own type — so a realtor whose vendor
    // record was later merged into a differently-typed one passed the SQL filter (on
    // the link) and was then dropped by the JS match (on the directory), silently
    // losing the exact contact this reader exists to find.
    await c.query(`UPDATE service_contacts SET contact_type='other' WHERE id=$1`, [sc.rows[0].id]);
    const merged = await orderService.buildPreview(c, appId);
    const mAccess = (merged.spec.contacts || []).find((x) => x.role === 'PropertyAccess');
    ok(mAccess && mAccess.company === 'Acme Realty',
      'a merged vendor record still reaches the order — the filter and the match agree');
    await c.query(`UPDATE service_contacts SET contact_type='realtor' WHERE id=$1`, [sc.rows[0].id]);

    // A COMPANY IS NOT A PERSON, and an unreachable one is not the best contact.
    await c.query(`UPDATE service_contacts SET contact_name=NULL, email=NULL, phone=NULL WHERE id=$1`, [sc.rows[0].id]);
    const nameless = await orderService.buildPreview(c, appId);
    const nAccess = (nameless.spec.contacts || []).find((x) => x.role === 'PropertyAccess');
    ok(!nAccess || (nAccess.firstName === null && nAccess.lastName === null),
      'a company name is never split into a person who does not exist');
    ok(nameless.spec.parties.bestContact === 'Borrower',
      'and an unreachable property contact never becomes the best person to contact');
    ok((nameless.contactNotes || []).some((n) => /property-access/i.test(n)),
      'the screen says so too — the wire and the screen agree');
    await c.query(`UPDATE service_contacts SET contact_name='Dana Realtor', email='dana@acme.test', phone='555-9000' WHERE id=$1`,
      [sc.rows[0].id]);

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
