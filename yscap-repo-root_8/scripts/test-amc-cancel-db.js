'use strict';
/**
 * DB-gated test for the NAN (AMC / AppraisalScope) cancel service (src/amc/cancel.js)
 * against a REAL Postgres.
 *
 * requestCancel rides the SAME guarded write channel as CreateAppraisal — it calls
 * session.authContext() (DoLogin) and client.write() directly — so, like the sibling
 * AMC db tests, this drives the network by STUBBING those two module singletons in the
 * require cache (cancel.js holds the same cached exports objects, and reads .authContext
 * / .write at call time, so mutating them here is what cancel.js sees). Everything else
 * — the DB writes, the amc_write_log journal, describeSendFailure, cdg.parseError — runs
 * for real. Everything happens inside ONE transaction that is ROLLED BACK.
 *
 * Covers: the three guards (reason_required / not_placed / not_cancellable); the DRY-RUN
 * flow (status → cancel_requested, reason recorded, journaled, api key masked in the
 * journal); a vendor NACK (status unchanged, journaled ok:false); an ACCEPTED cancel
 * (status → cancel_requested, cancel_requested_by/at, last_status_response, last_error
 * cleared, journaled ok:true); a send failure (status unchanged, journaled ok:false);
 * outbound-off; and that buildPreview surfaces the auto-filled assumptions.
 *
 * Skips cleanly without DATABASE_URL.
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');

if (!process.env.DATABASE_URL) {
  console.log('test-amc-cancel-db: skipped (no DATABASE_URL)');
  process.exit(0);
}

// Pin the tenant environment so the amc_form_map rule this test inserts (tagged 'uat')
// is the one formRules filters on — before order-service (→ config) is required.
process.env.AMC_ENVIRONMENT = 'uat';

const { Pool } = require('pg');
const client = require(path.join(ROOT, 'src/amc/client'));
const session = require(path.join(ROOT, 'src/amc/session'));
const orderService = require(path.join(ROOT, 'src/amc/order-service'));
const cancel = require(path.join(ROOT, 'src/amc/cancel'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };

// ---- stub the guarded write channel (offline) --------------------------------
// authContext() never touches the network; write() returns whatever the current test
// sets. cancel.js reads session.authContext / client.write at call time, so these win.
session.authContext = async () => ({ apiKey: 'SECRETKEY', subdomain: 'integrations.uat', lenderIdentifier: 'L', sourceClientId: 'S' });
let writeImpl = async () => { throw new Error('writeImpl not set'); };
client.write = async (...a) => writeImpl(...a);

// A CDG success envelope: parseError returns null → the accepted path.
const acceptedResp = { message: { products: { serviceProviderStatus: 'Cancellation Requested' } } };
// A CDG NACK envelope: a negative statusCode → parseError returns non-null.
const nackResp = { message: { statusResponses: [
  { statusCondition: 'nack', statusCode: '-100', statusName: 'AuthError', statusDescription: 'Order not found for cancellation.' },
] } };

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const { ensureSchema } = require(path.join(ROOT, 'src/migrate-boot'));
  await ensureSchema();
  const c = await pool.connect();

  // amc_write_log rows for an order, newest first.
  const journalRows = (orderId) => c.query(
    `SELECT action, ok, error, request_summary, response_summary FROM amc_write_log
      WHERE order_id = $1 ORDER BY id DESC`, [orderId]).then((r) => r.rows);
  const reload = (orderId) => c.query(`SELECT * FROM amc_orders WHERE id = $1`, [orderId]).then((r) => r.rows[0]);

  try {
    await c.query('BEGIN');

    // ---- a minimal loan file with a PLACED order -----------------------------
    const bo = await c.query(
      `INSERT INTO borrowers (first_name, last_name, email, cell_phone, current_address)
       VALUES ('Cameron','Cancel',$1,'555-0111','{"line1":"3 Beaver St","city":"Albany","state":"NY","zip":"12207"}')
       RETURNING id`, [`amc-cancel-${Date.now()}@example.com`]);
    const borrowerId = bo.rows[0].id;

    const staff = await c.query(
      `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Cara Coordinator','processor',true) RETURNING id`,
      [`amc-cancel-staff-${Date.now()}@example.com`]);
    const staffId = staff.rows[0].id;

    const app = await c.query(
      `INSERT INTO applications
         (borrower_id, ys_loan_number, program, loan_type, property_address, property_type,
          occupancy, purchase_price, loan_amount)
       VALUES ($1,'YSCAP-CANCEL-1','bridge','Purchase',
          '{"street":"3 Beaver St","city":"Albany","state":"NY","zip":"12207","county":"Albany"}',
          'SFR','Investment',350000,262500)
       RETURNING id`, [borrowerId]);
    const appId = app.rows[0].id;

    // A placed order: it reached the AMC (sp + cdg order numbers), status 'ordered'.
    const placed = await c.query(
      `INSERT INTO amc_orders (application_id, client_order_number, cdg_order_number, sp_order_number, status)
       VALUES ($1,'YSCAP-CANCEL-1','CLG500','SP-500','ordered') RETURNING *`, [appId]);
    const order = placed.rows[0];

    // ---- guard: a reason is required ----------------------------------------
    const noReason = await cancel.requestCancel(c, order, { staffId });
    ok(!noReason.ok && noReason.error === 'reason_required', 'a cancel with no reason is refused');
    const blankReason = await cancel.requestCancel(c, order, { reason: '   ', staffId });
    ok(!blankReason.ok && blankReason.error === 'reason_required', 'a whitespace-only reason is refused');

    // ---- guard: an order that never reached the AMC can't be cancelled there --
    const draftRow = await c.query(
      `INSERT INTO amc_orders (application_id, client_order_number, status) VALUES ($1,'YSCAP-CANCEL-1','draft') RETURNING *`, [appId]);
    const notPlaced = await cancel.requestCancel(c, draftRow.rows[0], { reason: 'borrower withdrew', staffId });
    ok(!notPlaced.ok && notPlaced.error === 'not_placed', 'an order that never reached the AMC is not_placed');
    // A cancel needs the ServiceProviderOrderNumber (the envelope + the poll both key on
    // it), so a cdg-only order — which the poll could never advance — is also not_placed.
    const cdgOnly = await c.query(
      `INSERT INTO amc_orders (application_id, cdg_order_number, status) VALUES ($1,'CLG-NOSP','ordered') RETURNING *`, [appId]);
    const noSp = await cancel.requestCancel(c, cdgOnly.rows[0], { reason: 'x', staffId });
    ok(!noSp.ok && noSp.error === 'not_placed', 'an order with a cdg number but no sp order number is not_placed');

    // ---- guard: a terminal order is not cancellable -------------------------
    for (const term of ['cancelled', 'completed']) {
      // Distinct sp_order_number per row — uq_amc_orders_sp_order is UNIQUE.
      const t = await c.query(
        `INSERT INTO amc_orders (application_id, cdg_order_number, sp_order_number, status)
         VALUES ($1,$2,$3,$4) RETURNING *`, [appId, 'CLG-T-' + term, 'SP-T-' + term, term]);
      const res = await cancel.requestCancel(c, t.rows[0], { reason: 'x', staffId });
      ok(!res.ok && res.error === 'not_cancellable', `a ${term} order is not_cancellable`);
    }

    // ---- guard: a cancel already in flight is not re-sent -------------------
    // A second requestCancel on a cancel_requested order must NOT send another
    // CancelOrder to the vendor and must NOT overwrite the original cancel audit
    // metadata (who/when first asked). The poll worker is already waiting for the
    // vendor's confirmation.
    const inFlight = await c.query(
      `INSERT INTO amc_orders (application_id, cdg_order_number, sp_order_number, status,
          cancel_reason, cancel_requested_at, cancel_requested_by)
       VALUES ($1,'CLG-INFLIGHT','SP-INFLIGHT','cancel_requested','the first reason',
          now() - interval '1 hour', $2) RETURNING *`, [appId, staffId]);
    let sentDuringInFlight = false;
    writeImpl = async () => { sentDuringInFlight = true; return acceptedResp; };
    const dbl = await cancel.requestCancel(c, inFlight.rows[0], { reason: 'a different reason', staffId });
    ok(!dbl.ok && dbl.error === 'not_cancellable', 'a cancel already in flight is not_cancellable');
    ok(sentDuringInFlight === false, 'in-flight cancel: nothing is re-sent to the vendor');
    const afterDbl = await reload(inFlight.rows[0].id);
    ok(afterDbl.cancel_reason === 'the first reason', 'in-flight cancel: the original reason is preserved');
    const dblJ = await journalRows(inFlight.rows[0].id);
    ok(dblJ.length === 0, 'in-flight cancel: no new journal row (never reached the transport)');

    // ---- DRY-RUN: the transport short-circuits without sending ---------------
    writeImpl = async () => ({ __dryrun: true });
    const dry = await cancel.requestCancel(c, order, { reason: 'Borrower withdrew from the deal', staffId });
    ok(dry.ok && dry.dryrun === true, 'a dry-run cancel returns ok + dryrun');
    ok(dry.order && dry.order.status === 'cancel_requested', 'dry-run: status → cancel_requested');
    ok(dry.order.cancel_reason === 'Borrower withdrew from the deal', 'dry-run: the reason is recorded');
    ok(dry.order.dryrun === true, 'dry-run: the order is marked dryrun');
    ok(/TEST MODE/i.test(dry.order.last_error || ''), 'dry-run: last_error explains it was not really sent');
    const dryJ = await journalRows(order.id);
    ok(dryJ.length === 1 && dryJ[0].action === 'CancelOrder' && dryJ[0].ok === true, 'dry-run: one CancelOrder journal row, ok:true');
    // the api key never lands in the journal (maskRequest hides it)
    ok(!JSON.stringify(dryJ[0].request_summary || '').includes('SECRETKEY'), 'dry-run: the api key is masked out of the journal');

    // ---- a vendor NACK: nothing changes on the order ------------------------
    // Reset the order to a placed, non-cancel state to test the NACK cleanly.
    await c.query(`UPDATE amc_orders SET status='ordered', cancel_reason=NULL, cancel_requested_at=NULL, dryrun=false, last_error=NULL WHERE id=$1`, [order.id]);
    writeImpl = async () => nackResp;
    const nack = await cancel.requestCancel(c, order, { reason: 'wrong order', staffId });
    ok(!nack.ok && nack.error === 'amc_nack', 'a vendor NACK returns amc_nack');
    ok(/not found/i.test(nack.message || ''), 'the NACK carries the vendor description');
    const afterNack = await reload(order.id);
    ok(afterNack.status === 'ordered', 'NACK: the order status is unchanged (asking is not agreeing)');
    ok(afterNack.cancel_reason == null && afterNack.cancel_requested_at == null, 'NACK: no cancel metadata is written');
    const nackJ = await journalRows(order.id);
    ok(nackJ[0].ok === false && /not found/i.test(nackJ[0].error || ''), 'NACK: journaled ok:false with the reason');

    // ---- ACCEPTED: the cancel request is recorded ---------------------------
    writeImpl = async (built, opts) => {
      // the action rides ?orderId=<cdg order number> exactly as an AddForm does
      ok(opts && opts.orderId === 'CLG500' && opts.label === 'CancelOrder', 'accepted: write() is called with the cdg order id + CancelOrder label');
      return acceptedResp;
    };
    const acc = await cancel.requestCancel(c, order, { reason: 'Deal fell through', staffId });
    ok(acc.ok && acc.order, 'an accepted cancel returns ok + the order');
    ok(acc.order.status === 'cancel_requested', 'accepted: status → cancel_requested (not yet cancelled)');
    ok(acc.order.cancel_reason === 'Deal fell through', 'accepted: the reason is recorded');
    ok(String(acc.order.cancel_requested_by) === String(staffId), 'accepted: cancel_requested_by is the staffer');
    ok(acc.order.cancel_requested_at != null, 'accepted: cancel_requested_at is stamped');
    ok(acc.order.last_status_response != null, 'accepted: the vendor response is stored');
    ok(acc.order.last_error == null, 'accepted: last_error is cleared');
    const accJ = await journalRows(order.id);
    ok(accJ[0].ok === true && accJ[0].action === 'CancelOrder', 'accepted: journaled ok:true');

    // ---- a send failure: the order is untouched, the failure is recorded ----
    // Reset to a placed non-cancel state so the "unchanged" assertion is meaningful.
    await c.query(`UPDATE amc_orders SET status='ordered', cancel_reason=NULL, cancel_requested_at=NULL, cancel_requested_by=NULL, last_error=NULL, last_status_response=NULL WHERE id=$1`, [order.id]);
    writeImpl = async () => { const e = new Error('AMC CancelOrder -> 500'); e.status = 500; e.body = { raw: 'gateway boom' }; throw e; };
    const failed = await cancel.requestCancel(c, order, { reason: 'try to cancel', staffId });
    ok(!failed.ok && failed.error === 'send_failed', 'a transport error returns send_failed');
    const afterFail = await reload(order.id);
    ok(afterFail.status === 'ordered', 'send failure: status is unchanged (never flips to cancel_requested)');
    ok(afterFail.cancel_reason == null, 'send failure: no cancel metadata is written');
    ok(/gateway boom|HTTP 500/i.test(afterFail.last_error || ''), 'send failure: last_error carries the gateway reason');
    const failJ = await journalRows(order.id);
    ok(failJ[0].ok === false, 'send failure: journaled ok:false');

    // ---- outbound off is reported as outbound_disabled, not a mystery error --
    writeImpl = async () => { const e = new Error('outbound disabled'); e.code = 'AMC_OUTBOUND_DISABLED'; throw e; };
    const off = await cancel.requestCancel(c, order, { reason: 'cancel please', staffId });
    ok(!off.ok && off.error === 'outbound_disabled', 'outbound-off returns outbound_disabled');
    ok((await reload(order.id)).status === 'ordered', 'outbound-off: status unchanged');

    // ---- buildPreview surfaces the auto-filled assumptions ------------------
    // A form-map rule so the preview auto-picks a named form (tagged for this env).
    await c.query(
      `INSERT INTO amc_form_map (program, loan_type, product_code, product_name, priority, active, environment)
       VALUES ('bridge', 'bridge', '5', 'Bridge appraisal (test)', 10, true, 'uat')`);
    const preview = await orderService.buildPreview(c, appId);
    ok(preview && Array.isArray(preview.assumptions), 'buildPreview returns an assumptions array');
    const bySource = Object.fromEntries((preview.assumptions || []).map((a) => [a.field, a]));
    ok(bySource.mortgageType && bySource.mortgageType.source === 'default' && bySource.mortgageType.value === 'Conventional',
      'assumptions: mortgage type is a defaulted assumption (Conventional)');
    ok(bySource.bestContact && bySource.bestContact.source === 'default' && bySource.bestContact.value === 'Borrower',
      'assumptions: best contact surfaces as a default (loadContext no longer hides it)');
    ok(bySource.titleCategory && bySource.titleCategory.source === 'derived' && bySource.titleCategory.value === 'Single Family',
      'assumptions: property type is a derived assumption (SFR → Single Family)');
    ok(bySource.productCode && bySource.productCode.source === 'rule' && bySource.productCode.value === 'Bridge appraisal (test)',
      'assumptions: the auto-picked form is a rule assumption, reporting the form NAME');

    await c.query('ROLLBACK');
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (_) { /* ignore */ }
    fail++; console.error('  FAIL (threw):', e.message, e.stack);
  } finally {
    c.release();
    await pool.end();
  }

  console.log(`\n[test-amc-cancel-db] ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
