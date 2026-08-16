'use strict';
/**
 * THE APPRAISAL → ORDERS-DESK PROJECTION, the pure half.
 *
 * `lib/appraisal-order-mirror.js` turns whatever the three appraisal vendors say
 * into ONE desk row. The decisions all live in `describe` (this vendor row, in the
 * desk's words) and `pickPrimary` (which of a file's several orders the desk
 * shows), and both are pure — so the whole truth table is provable with no
 * database, no credentials and no network.
 *
 * The properties that matter, and why each is here:
 *   • a draft or a dry run is NOT an order, and must never put a file on the desk;
 *   • an unrecognised vendor status may become 'ordered' but NEVER anything
 *     terminal — a state we do not know about must not read as "done";
 *   • a LIVE order outranks a finished or cancelled one, so a stale cancelled
 *     attempt can never mask the order somebody is actually waiting on.
 */
const path = require('path');
const mirror = require(path.join(__dirname, '..', 'src/lib/appraisal-order-mirror'));
const { describe: desc, pickPrimary } = mirror;

let n = 0, failures = 0;
const ok = (c, m) => { n++; console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

(async () => {
  // ---- 1. NAN ------------------------------------------------------------
  {
    ok(desc('nan', { status: 'draft', id: 1 }) === null, '1a: a NAN draft is not an order');
    const live = desc('nan', {
      id: 7, status: 'assigned', status_name: 'AssignedToAppraiser',
      sp_order_number: 'SP1', cdg_order_number: 'CLGGL1', appraisal_file_number: 'AS-99',
      form_description: '1004 URAR', job_fee: 500, management_fee: 75,
      ordered_at: '2026-08-01T00:00:00Z',
    });
    ok(live && live.status === 'ordered', '1b: a NAN order out with the appraiser is "ordered"');
    ok(live.orderNumber === 'AS-99', '1c: the AppraisalScope file number is the one a human quotes');
    ok(live.feeCents === 57500, '1d: NAN fees are dollars on the row and become cents');
    ok(live.vendorName === 'AppraisalScope / NAN', '1e: the vendor is named the way the appraisal section names it');
    ok(desc('nan', { id: 8, status: 'product_available' }).status === 'documents_in',
      '1f: the report being available is the desk\'s "documents in"');
    ok(desc('nan', { id: 9, status: 'completed' }).status === 'completed', '1g: completed maps straight through');
    ok(desc('nan', { id: 10, status: 'cancelled' }).status === 'cancelled', '1h: cancelled maps straight through');
    ok(desc('nan', { id: 11, status: 'rejected' }).status === 'cancelled',
      '1i: an order the AMC declined is off the desk, not left looking live');
  }

  // ---- 2. Class + Richer Values ------------------------------------------
  {
    const c = desc('class', {
      id: 3, status: 'in_process', class_order_id: 'CL-1', reference_number: 'YSC-1',
      product_title: 'Full URAR', client_fee_cents: 62500, placed_at: '2026-08-02T00:00:00Z',
    });
    ok(c && c.status === 'ordered' && c.orderNumber === 'CL-1' && c.feeCents === 62500,
      '2a: a Class order reads across with their own order id and fee');
    ok(desc('class', { id: 4, status: 'dryrun' }) === null, '2b: a Class dry run is not an order');

    const r = desc('rv', {
      id: 5, status: 'in_review', order_token: 'RV-9', intake_token: 'IN-9',
      report_type: 'Reno ARV', total_price_cents: 19900, placed_at: '2026-08-03T00:00:00Z',
    });
    ok(r && r.status === 'ordered' && r.orderNumber === 'RV-9' && r.feeCents === 19900,
      '2c: a Richer Values order reads across, preferring the order token over the intake token');
    ok(desc('rv', { id: 6, status: 'dismissed' }).status === 'cancelled',
      '2d: a dismissed Richer Values order is off the desk');
  }

  // ---- 3. A STATUS WE DO NOT KNOW ABOUT ----------------------------------
  //         Never terminal. The expensive failure is a new vendor state reading
  //         as "done" and the order quietly leaving the queue.
  {
    const unknownPlaced = desc('nan', { id: 12, status: 'someNewVendorState', sp_order_number: 'SP2' });
    ok(unknownPlaced && unknownPlaced.status === 'ordered',
      '3a: an unknown status on an order the vendor has given us an id for is LIVE');
    ok(desc('nan', { id: 13, status: 'someNewVendorState' }) === null,
      '3b: …and an unknown status with no vendor id at all is not an order yet');
    for (const v of ['nan', 'class', 'rv']) {
      const d = desc(v, { id: 14, status: 'brandNew', sp_order_number: 'X', class_order_id: 'X', order_token: 'X' });
      ok(d && d.status !== 'completed' && d.status !== 'cancelled',
        `3c.${v}: an unknown status is never read as finished or cancelled`);
    }
  }

  // ---- 4. Nulls and rubbish never throw ----------------------------------
  {
    ok(desc('nan', null) === null, '4a: no row, no order');
    ok(desc('nan', {}) === null, '4b: an empty row is not an order');
    ok(desc('nan', { status: 'ordered', job_fee: 'abc', management_fee: null, sp_order_number: 'S' }).feeCents === 0,
      '4c: an unreadable fee does not become NaN on the desk');
    ok(pickPrimary(null) === null && pickPrimary([]) === null, '4d: nothing to choose from is null, not a throw');
    ok(pickPrimary([null, undefined]) === null, '4e: a list of nothings is still null');
  }

  // ---- 5. WHICH ORDER THE DESK SHOWS -------------------------------------
  {
    const cancelled = desc('nan', { id: 1, status: 'cancelled', sp_order_number: 'A', ordered_at: '2026-08-10T00:00:00Z' });
    const live = desc('class', { id: 2, status: 'in_process', class_order_id: 'B', placed_at: '2026-08-01T00:00:00Z' });
    ok(pickPrimary([cancelled, live]).vendor === 'class',
      '5a: a LIVE order wins over a newer cancelled one — the desk shows what is being waited on');

    const done = desc('nan', { id: 3, status: 'completed', sp_order_number: 'C', ordered_at: '2026-08-05T00:00:00Z' });
    ok(pickPrimary([done, live]).vendor === 'class', '5b: a live order wins over a finished one');
    ok(pickPrimary([done, cancelled]).status === 'completed', '5c: with nothing live, the finished one beats the cancelled one');

    const older = desc('nan', { id: 4, status: 'ordered', sp_order_number: 'D', ordered_at: '2026-07-01T00:00:00Z' });
    const newer = desc('nan', { id: 5, status: 'ordered', sp_order_number: 'E', ordered_at: '2026-08-01T00:00:00Z' });
    ok(pickPrimary([older, newer]).orderNumber === 'E', '5d: between two live orders, the newest wins');
    ok(pickPrimary([desc('nan', { id: 6, status: 'product_available', sp_order_number: 'F', ordered_at: '2026-07-01T00:00:00Z' }), older]).orderNumber === 'F',
      '5e: further along wins when both are live');
  }

  // ---- 6. Every mapped value is one the desk understands -------------------
  //         A status this module invented would be refused by the column's own
  //         CHECK, on a write nobody watches.
  {
    const DESK = new Set(['ordered', 'documents_in', 'completed', 'cancelled']);
    const tables = mirror._internals;
    let bad = 0;
    for (const t of [tables.NAN_STATUS, tables.CLASS_STATUS, tables.RV_STATUS]) {
      for (const v of Object.values(t)) if (v !== null && !DESK.has(v)) bad += 1;
    }
    ok(bad === 0, '6: every vendor status maps onto a value the desk column allows');
  }

  console.log(failures ? `\n${failures} FAILURE(S) of ${n}` : `\nOK  appraisal-order-mirror-pure: ${n} checks passed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
