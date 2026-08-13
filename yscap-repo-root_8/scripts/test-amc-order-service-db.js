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

// Pin the tenant environment so the form-map rows this test inserts (tagged 'uat')
// match what formRules filters on, deterministically — regardless of AMC_ORDER_URL.
// Must be set BEFORE order-service (→ config) is required.
process.env.AMC_ENVIRONMENT = 'uat';

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

    // A loan officer + processor on the file — their emails must ride the order's
    // update-notification list (owner-directed contacts).
    const stamp = Date.now();
    const lo = await c.query(
      `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Officer O','loan_officer',true) RETURNING id`,
      [`amc-lo-${stamp}@example.com`]);
    const pr = await c.query(
      `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Proc P','processor',true) RETURNING id`,
      [`amc-pr-${stamp}@example.com`]);

    const app = await c.query(
      `INSERT INTO applications
         (borrower_id, llc_id, ys_loan_number, program, loan_type, property_address,
          property_type, occupancy, purchase_price, loan_amount, est_closing_date,
          loan_officer_id, processor_id)
       VALUES ($1,$2,'YSCAP-AMC-1','bridge','Purchase',
          '{"street":"12 Oak St","city":"Brooklyn","state":"NY","zip":"11249","county":"Kings"}',
          'SFR','Investment',400000,300000,'2026-09-15',$3,$4)
       RETURNING id`, [borrowerId, llc.rows[0].id, lo.rows[0].id, pr.rows[0].id]);
    const appId = app.rows[0].id;

    // A form-map rule so the preview auto-picks a form (tagged for THIS environment,
    // carrying a human name).
    await c.query(
      `INSERT INTO amc_form_map (program, property_category, loan_purpose, product_code, product_name, subproduct_codes, amc_identifier, priority, active, environment)
       VALUES ('bridge', NULL, NULL, '5', 'Bridge SFR appraisal (test)', ARRAY['7'], '426', 10, true, 'uat')`);
    // A wildcard fallback that should LOSE to the specific bridge rule.
    await c.query(
      `INSERT INTO amc_form_map (program, product_code, priority, active, environment) VALUES (NULL, '1', 100, true, 'uat')`);
    // A DECOY from the OTHER environment: lowest priority, so if it were read it would
    // win — proving the environment filter excludes it.
    await c.query(
      `INSERT INTO amc_form_map (program, product_code, priority, active, environment) VALUES ('bridge', 'PROD-ONLY', 1, true, 'production')`);

    // The appraisal_card condition, so cardStatus can read it.
    await c.query(
      `INSERT INTO checklist_items (application_id, scope, tool_key, label, status, audience, item_kind)
       VALUES ($1,'application','appraisal_card','Appraisal payment card','outstanding','borrower','document')`, [appId]);

    // The account's client-on-report profiles (AppraisalScope's required client_displayed_id).
    // Exactly ONE profile cached → order-service auto-selects it (the common case), so the
    // order is placeable without any config. Keyed under '' to match the test config's
    // (unset) subdomain. ON CONFLICT so a real cached row doesn't collide inside the txn.
    await c.query(
      `INSERT INTO amc_lookup_cache (lookup_type, subdomain, payload, fetched_at)
       VALUES ('GetClientDisplayOnReport', '', '[{"id":"297","name":"YS Capital Group"}]'::jsonb, now())
       ON CONFLICT (lookup_type, subdomain)
         DO UPDATE SET payload = EXCLUDED.payload, fetched_at = now()`);

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
    // The client-on-report profile (client_displayed_id) auto-selected from the account's
    // single cached profile.
    ok(ctx.clientDisplayedId === '297' && ctx.clientDisplayedSource === 'catalog', 'client-displayed-on-report auto-selected from the single cached profile');
    ok(ctx.clientDisplayedName === 'YS Capital Group', 'client-displayed-on-report name loaded');

    // ---- contacts: the LO + processor + borrower emails ride the update-notify list ----
    ok(Array.isArray(ctx.notifyEmails), 'loadContext returns notifyEmails');
    ok(ctx.notifyEmails.includes(`amc-lo-${stamp}@example.com`), 'loan officer email on the notify list');
    ok(ctx.notifyEmails.includes(`amc-pr-${stamp}@example.com`), 'processor email on the notify list');
    ok(ctx.notifyEmails.some((e) => e.startsWith('amc-test-')), 'borrower email on the notify list');

    // ---- buildPreview: auto-picks the specific form + fills the spec ----
    const preview = await orderService.buildPreview(c, appId);
    ok(preview && preview.chosenForm && preview.chosenForm.productCode === '5', 'preview auto-picks the specific bridge form (not the wildcard, and not the wrong-environment decoy)');
    ok(preview.chosenForm.productName === 'Bridge SFR appraisal (test)', 'chosenForm carries the human name (product_name now selected)');
    ok(preview.chosenFormName === 'Bridge SFR appraisal (test)', 'preview exposes chosenFormName for the UI');
    ok(preview.chosenForm.amcIdentifier === '426', 'preview carries the preferred AMC');
    // The form dropdown catalog includes the mapped form (with its name), even without a live GetJobType cache.
    ok(Array.isArray(preview.forms) && preview.forms.some((f) => String(f.id) === '5' && f.name === 'Bridge SFR appraisal (test)'), 'forms catalog includes the mapped form with its name');
    ok(!preview.forms.some((f) => String(f.id) === 'PROD-ONLY'), 'the production-only decoy is not offered in a UAT service');
    // The order-update recipients are surfaced on the preview.
    ok(Array.isArray(preview.notifyEmails) && preview.notifyEmails.length >= 3, 'preview exposes the update-email recipients');
    ok(preview.spec.notifyEmails && preview.spec.notifyEmails.length >= 3, 'the spec carries the notify emails → products[].notifications');
    ok(preview.spec.loan.loanNumber === 'YSCAP-AMC-1' && preview.spec.property.titleCategory === 'Single Family', 'spec filled from the file');
    ok(preview.spec.clientDisplayedId === '297', 'spec carries the client-displayed-on-report id → sourceClientIdentifier');
    ok(preview.canPlace === true && preview.missing.length === 0, 'preview is complete → placeable');

    // ---- createOrder (draft, no network) ----
    const draft = await orderService.createOrder(c, appId, { place: false, staffId: null });
    ok(draft.ok === true && draft.draft === true, 'createOrder(place:false) returns a draft');
    ok(draft.order && draft.order.status === 'draft' && draft.order.product_code === '5', 'draft persisted with the chosen form');
    ok(draft.order.request_payload && JSON.stringify(draft.order.request_payload).includes('YSCAP-AMC-1'), 'draft stores the (masked) request payload');
    ok(!JSON.stringify(draft.order.request_payload).includes('DoLogin'), 'draft payload carries no login credentials');
    // The stored (masked) payload carries the client-displayed id on the clientSystem
    // sourceInformation (the field the gateway maps to client_displayed_id) — proof the
    // whole chain resolves the CDOR through to the wire message a draft records, and that
    // no Lender party is emitted for this purpose.
    {
      const cs = (draft.order.request_payload.message || {}).clientSystem || {};
      ok(cs.sourceInformation && cs.sourceInformation.sourceClientIdentifier === '297',
        'draft payload carries client_displayed_id via clientSystem.sourceInformation.sourceClientIdentifier');
      const parties = ((((draft.order.request_payload.message || {}).deals || [])[0] || {}).parties || []);
      ok(!parties.some((p) => p.partyRoleType === 'Lender'), 'draft payload emits no Lender party for client_displayed_id');
    }

    // ---- listOrders ----
    const list = await orderService.listOrders(c, appId);
    ok(list.length === 1 && list[0].id === draft.order.id, 'listOrders returns the draft');

    // ---- resolveClientDisplayed: 1 profile → auto; several → don't guess; none → blocked.
    //      Proves the order is blocked (not sent to fail at NAN) when the account has
    //      several client-on-report profiles and none is pinned. ----
    const setCdor = async (rows) => c.query(
      `INSERT INTO amc_lookup_cache (lookup_type, subdomain, payload, fetched_at)
       VALUES ('GetClientDisplayOnReport','',$1::jsonb, now())
       ON CONFLICT (lookup_type, subdomain) DO UPDATE SET payload = EXCLUDED.payload, fetched_at = now()`,
      [JSON.stringify(rows)]);

    await setCdor([{ id: '297', name: 'YS Capital Group' }]);
    const one = await orderService.resolveClientDisplayed(c, '');
    ok(one.id === '297' && one.source === 'catalog', 'one cached profile matching the default name → auto-selected');

    // NAME MATCH wins even when the account has several profiles: "YS Capital Group" is
    // matched to its id, so the order is not blocked (owner-directed default).
    await setCdor([{ id: '297', name: 'YS Capital Group' }, { id: '512', name: 'Other Client' }]);
    const matched = await orderService.resolveClientDisplayed(c, '');
    ok(matched.id === '297' && matched.source === 'catalog', 'default name matched to its id even among several profiles');

    // Several profiles, NONE matching the default name → not guessed; the picker chooses.
    await setCdor([{ id: '297', name: 'A' }, { id: '512', name: 'B' }]);
    const many = await orderService.resolveClientDisplayed(c, '');
    ok(many.id === null && many.source === 'multiple' && many.options.length === 2, 'several profiles, none matching the default → picker (blocked until chosen)');

    // No cached profile at all → fall back to the configured NAME so the order still goes out.
    await setCdor([]);
    const nameOnly = await orderService.resolveClientDisplayed(c, '');
    ok(nameOnly.id === null && nameOnly.source === 'name_default' && nameOnly.name === 'YS Capital Group',
      'empty cache → default name sent (order NOT blocked)');
    // Restore the single-profile cache for any later reads in this transaction.
    await setCdor([{ id: '297', name: 'YS Capital Group' }]);

    // ---- a refinance file carries a PROPERTY VALUE (AppraisalScope requires an amount).
    //      There is no purchase, so it uses the AS-IS VALUE (deal-basis rule) — never the
    //      purchase price. as_is_value (320k) differs from purchase_price (250k) so the
    //      assertion proves the as-is value wins. ----
    const refi = await c.query(
      `INSERT INTO applications (borrower_id, ys_loan_number, program, loan_type, property_address, property_type, purchase_price, as_is_value, loan_amount)
       VALUES ($1,'YSCAP-AMC-2','bridge','Refi Cash-Out','{"street":"9 Elm St","city":"Queens","state":"NY","zip":"11375"}','SFR',250000,320000,200000)
       RETURNING id`, [borrowerId]);
    const rctx = await orderService.loadContext(c, refi.rows[0].id);
    ok(rctx.property.salesContractAmount === 320000, 'refinance carries the AS-IS value as the property amount (never the purchase price)');
    ok(rctx.loanPurpose === 'Refi Cash-Out', 'refinance loan purpose carried through');

    // ---- environment fallback (the shipped seed is production-only; a service whose
    //      environment has no rules must still auto-pick, not come back empty) ----
    // Remove every rule tagged for THIS ('uat') environment. The remaining rows are the
    // db/481 production seed + the production 'PROD-ONLY' decoy — a different environment
    // than the service is pointed at. formRules must fall back to them rather than starve.
    await c.query(`DELETE FROM amc_form_map WHERE environment = 'uat'`);
    const fellBack = await orderService.formRules(c);
    ok(fellBack.length > 0, 'formRules falls back to another environment when this one has no rules (never starved)');
    ok(fellBack.some((r) => r.product_code === 'PROD-ONLY'), 'the fallback reaches the production rules so a default still auto-picks');

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
