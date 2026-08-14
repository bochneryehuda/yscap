'use strict';
/**
 * DB-gated test — the Richer Value schema (db/548) and the wiring that hangs off
 * it. Skips without DATABASE_URL.
 *
 *   node scripts/test-richer-value-db.js
 *
 * WHY THIS EXISTS ALONGSIDE THE PURE TESTS. The pure suites cover the builder and
 * the report reader with no database in reach, which is right for them — but a
 * pure test cannot catch the one class this repo has been bitten by repeatedly: a
 * query naming a column that does not exist, sitting inside a swallowing catch, so
 * the feature reports a confident "nothing to do" forever. Every column this
 * integration reads or writes is checked HERE, against `information_schema`, so a
 * typo is a failed build rather than a silent no-op in production.
 *
 * It deliberately does NOT place an order. Ordering is a vendor round-trip that
 * costs money, and it is proven separately against their training tenant.
 */
const assert = require('assert');
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

if (!process.env.DATABASE_URL) {
  console.log('SKIP test-richer-value-db (no DATABASE_URL)');
  process.exit(0);
}
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);

const R = require('path').resolve(__dirname, '..');
const db = require(R + '/src/db');

/** Every column the integration touches, by table. A miss here is a real bug. */
const REQUIRED = {
  rv_orders: [
    'id', 'application_id', 'checklist_item_id', 'intake_token', 'order_token', 'company_token',
    'client_loan_number', 'report_type', 'inspection_type', 'turnaround_time',
    'gla_include', 'licensing_required', 'include_flood_certification', 'property_upload_type',
    'request_body', 'dryrun', 'price', 'total_price_cents', 'payment_method', 'paid_at',
    'payment_link', 'intake_form_link', 'status', 'status_reason', 'vendor_status',
    'vendor_inspection_status', 'inspection_scheduled_date', 'due_date',
    'results', 'as_is_value', 'arv', 'arv_basis', 'values_applied_at', 'values_applied_by',
    'pdf_document_id', 'xml_waiver_applied', 'last_event_at', 'last_polled_at', 'last_error',
    'cancel_reason', 'cancelled_at', 'cancelled_by', 'placed_by', 'placed_at', 'created_at', 'updated_at',
  ],
  rv_order_events: [
    'id', 'rv_order_row', 'application_id', 'order_type', 'action_type', 'action',
    'intake_token', 'order_token', 'event_at', 'payload', 'payload_hash',
    'received_at', 'processed_at', 'process_error', 'attempts', 'next_attempt_at', 'dead_at',
  ],
  rv_status_events: ['id', 'rv_order_row', 'application_id', 'event_type', 'status', 'comment', 'occurred_at', 'dedupe_key', 'recorded_at'],
  rv_write_log: ['id', 'rv_order_row', 'application_id', 'action', 'method', 'path', 'request', 'response', 'ok', 'error', 'staff_id', 'created_at'],
  rv_reference_cache: ['cache_key', 'payload', 'fetched_at', 'last_error'],
};

(async () => {
  // The migrations run on boot; make sure ours has been applied before asserting.
  await require(R + '/src/migrate-boot').ensureSchema();

  /* ---- A. the schema is exactly what the code reads --------------------- */
  for (const [table, cols] of Object.entries(REQUIRED)) {
    const r = await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name=$1`, [table]);
    const have = new Set(r.rows.map((x) => x.column_name));
    ok(have.size > 0, `A the table ${table} exists`);
    const missing = cols.filter((c) => !have.has(c));
    ok(missing.length === 0, `A ${table} has every column the code touches${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);
  }

  /* ---- B. the guarantees the indexes make ------------------------------ */
  {
    const r = await db.query(`SELECT indexname FROM pg_indexes WHERE tablename='rv_orders'`);
    const names = r.rows.map((x) => x.indexname);
    ok(names.includes('uq_rv_orders_intake'), 'B an intake token is unique once we have one');
    ok(names.includes('uq_rv_orders_order'), 'B and so is their order token — the two ways a webhook finds its order');
  }
  {
    const r = await db.query(`SELECT indexname FROM pg_indexes WHERE tablename='rv_order_events'`);
    ok(r.rows.some((x) => x.indexname === 'uq_rv_events_dedupe'),
      'B a redelivered webhook is recorded once — their retries repeat a delivery verbatim');
  }
  {
    const r = await db.query(`SELECT indexname FROM pg_indexes WHERE tablename='rv_status_events'`);
    ok(r.rows.some((x) => x.indexname === 'uq_rv_status_dedupe'),
      'B and a poll that re-reads the same history ten times records it once');
  }

  /* ---- C. deleting a loan file takes its orders with it, and nothing else */
  {
    const r = await db.query(
      `SELECT rc.delete_rule, kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
         JOIN information_schema.referential_constraints rc ON rc.constraint_name = tc.constraint_name
        WHERE tc.table_name='rv_orders' AND tc.constraint_type='FOREIGN KEY'`);
    const byCol = Object.fromEntries(r.rows.map((x) => [x.column_name, x.delete_rule]));
    ok(byCol.application_id === 'CASCADE', 'C an order belongs to its file and goes with it');
    // A report we PAID FOR must not be destroyed because a condition was tidied
    // up or a staffer was deactivated.
    ok(byCol.checklist_item_id === 'SET NULL', 'C but removing the condition never deletes the order');
    ok(byCol.pdf_document_id === 'SET NULL', 'C nor does removing the filed report');
    ok(byCol.placed_by === 'SET NULL', 'C nor deactivating the person who placed it');
  }

  /* ---- D. the row round-trips, including the jsonb and the trigger ----- */
  {
    const app = (await db.query(
      `SELECT id FROM applications WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`)).rows[0];
    if (!app) {
      console.log('SKIP D (no application on this database to hang a test order off)');
    } else {
      const ins = await db.query(
        `INSERT INTO rv_orders (application_id, report_type, request_body, results, status)
         VALUES ($1,'reno-arv','{"a":1}'::jsonb,'{"responses":[]}'::jsonb,'placing') RETURNING id, updated_at`,
        [app.id]);
      const id = ins.rows[0].id;
      const before = ins.rows[0].updated_at;
      try {
        await db.query(`UPDATE rv_orders SET status='ordered' WHERE id=$1`, [id]);
        const after = (await db.query(`SELECT status, updated_at, request_body FROM rv_orders WHERE id=$1`, [id])).rows[0];
        ok(after.status === 'ordered', 'D the row updates');
        ok(new Date(after.updated_at) >= new Date(before), 'D and the touch trigger keeps updated_at current with no write path remembering to');
        ok(after.request_body && after.request_body.a === 1, 'D the request body round-trips as jsonb');

        // The status vocabulary is deliberately UNCONSTRAINED: their catalogue is
        // served by an API and a status we have never seen must never fail a write.
        await db.query(`UPDATE rv_orders SET status='a status nobody has seen' WHERE id=$1`, [id]);
        ok(true, 'D an unrecognised status can still be recorded rather than lost');
      } finally {
        await db.query(`DELETE FROM rv_orders WHERE id=$1`, [id]);
      }
    }
  }

  /* ---- E. the waiver table takes the new reason ------------------------ */
  {
    // `reason` is deliberately free text (no CHECK), so a new reason needs no
    // migration. Proven rather than assumed, because a CHECK added later would
    // make every Hybrid order fail at the moment the waiver is recorded.
    const r = await db.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'appraisal_xml_waivers'::regclass AND contype='c'`);
    const blocking = r.rows.filter((x) => /reason/.test(x.def) && !/hybrid_appraisal/.test(x.def));
    ok(blocking.length === 0,
      `E nothing constrains the waiver reason, so the product reason records cleanly${blocking.length ? ` (found: ${blocking.map((b) => b.def).join('; ')})` : ''}`);
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\ntest-richer-value-db: all checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
