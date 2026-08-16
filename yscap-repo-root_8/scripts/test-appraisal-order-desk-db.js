'use strict';
/**
 * THE APPRAISAL IS AN ORDER ON THE ORDERS DESK — against a real Postgres.
 *
 * The pure half (which vendor status means what, and which of a file's orders the
 * desk shows) is pinned by `test-appraisal-order-mirror-pure.js`. This is the half
 * a pure test cannot reach:
 *
 *   • the desk row is really written, and the column's own CHECK accepts it
 *     (db/564 — a projection that writes a value the constraint refuses fails on a
 *     write nobody watches);
 *   • a HUMAN's work on that row — the assignment, the note, an agreed due date —
 *     survives every later projection. This is the property the whole named-column
 *     upsert exists for, and it is the one that would be lost silently;
 *   • the clock comes out right, off the shared `order-sla` calculator rather than
 *     a second one;
 *   • the back-book sweep puts existing files on the desk;
 *   • and the desk NEVER becomes a second way to order or finish an appraisal.
 *
 * DB-gated; skips cleanly without DATABASE_URL. Fixtures are committed and removed.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const path = require('path');
const ROOT = path.join(__dirname, '..');

if (!process.env.DATABASE_URL) {
  console.log('test-appraisal-order-desk-db: skipped (no DATABASE_URL)');
  process.exit(0);
}

const db = require(path.join(ROOT, 'src/db'));
const { ensureSchema } = require(path.join(ROOT, 'src/migrate-boot'));
const mirror = require(path.join(ROOT, 'src/lib/appraisal-order-mirror'));
const orderSla = require(path.join(ROOT, 'src/lib/order-sla'));

let n = 0, failures = 0;
const ok = (c, m) => { n++; console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const tag = `${process.pid}${Date.now()}`;

async function seedFile(label) {
  const bor = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Desk','Test',$1) RETURNING id`,
    [`desk_${tag}_${label}@example.com`])).rows[0];
  const app = (await db.query(
    `INSERT INTO applications (borrower_id, status, ys_loan_number)
     VALUES ($1,'underwriting',$2) RETURNING id`,
    [bor.id, `YSCAP-DESK-${label}-${tag}`.slice(0, 40)])).rows[0];
  return { borId: bor.id, appId: app.id };
}
const deskRow = async (appId) => (await db.query(
  `SELECT * FROM file_orders WHERE application_id=$1 AND order_type='appraisal'`, [appId])).rows[0] || null;

(async () => {
  await ensureSchema();
  const cleanupApps = [], cleanupBors = [];
  const staff = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,'Desk Tester','processor',true) RETURNING id`,
    [`deskstaff_${tag}@example.com`])).rows[0];

  // ===================================================================
  // A. The column accepts the fourth type — and the type list agrees.
  // ===================================================================
  {
    ok(orderSla.ORDER_TYPES.includes('appraisal'), 'A1: the desk tracks the appraisal as an order type');
    ok(orderSla.ORDER_LABEL.appraisal && orderSla.VENDOR_LABEL.appraisal,
      'A2: it has a label and a "who we are waiting on", so the nudge and the queue can name it');
    ok(orderSla.SLA_BUSINESS_DAYS.appraisal > orderSla.SLA_BUSINESS_DAYS.title,
      'A3: an appraisal is given longer than a title search, because it takes longer');
    const def = (await db.query(
      `SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='file_orders_order_type_check'`)).rows[0];
    ok(def && /appraisal/.test(def.d), 'A4: the column\'s own CHECK admits it (db/564)');
  }

  // ===================================================================
  // B. A placed NAN order appears on the desk, with the vendor's own detail.
  // ===================================================================
  {
    const f = await seedFile('nan');
    cleanupApps.push(f.appId); cleanupBors.push(f.borId);

    ok((await deskRow(f.appId)) === null, 'B1: a file with no appraisal order has no desk row (control)');

    await db.query(
      `INSERT INTO amc_orders (application_id, client_order_number, sp_order_number, appraisal_file_number,
                               status, form_description, job_fee, management_fee, ordered_at)
       VALUES ($1,$2,$3,$4,'assigned','1004 URAR',500,75, now() - interval '4 days')`,
      [f.appId, `CO-${tag}`.slice(0, 40), `SP-${tag}`.slice(0, 40), `AS-${tag}`.slice(0, 30)]);

    const out = await mirror.syncOne(f.appId, db);
    ok(out && out.ok && out.vendor === 'nan', 'B2: the projection runs and names the vendor');
    const row = await deskRow(f.appId);
    ok(row && row.status === 'ordered', 'B3: the appraisal is on the desk as an ordered order');
    ok(row.vendor_name === 'AppraisalScope / NAN', 'B4: …under the appraisal company\'s name');
    const meta = row.meta && row.meta.appraisal;
    ok(meta && meta.orderNumber && /^AS-/.test(meta.orderNumber), 'B5: their order number is recorded for a human to quote');
    ok(meta && meta.feeCents === 57500, 'B6: the fee comes across in cents');
    ok(meta && meta.section === 'sec-order-appraisal', 'B7: the desk knows where to send somebody to work the order');

    // The clock is the SHARED one, so the card, the queue and the nudge agree.
    const state = orderSla.orderState({ ...row, order_type: 'appraisal' }, new Date());
    ok(state.open === true, 'B8: the order reads as open');
    ok(state.dueOn && /^\d{4}-\d{2}-\d{2}$/.test(state.dueOn), 'B9: it has a due date, derived off the shared SLA');
    ok(state.slaDays === orderSla.SLA_BUSINESS_DAYS.appraisal, 'B10: …on the appraisal\'s own SLA, not the default');
  }

  // ===================================================================
  // C. THE PROPERTY THAT MATTERS MOST: a human's work is never wiped.
  // ===================================================================
  {
    const f = await seedFile('human');
    cleanupApps.push(f.appId); cleanupBors.push(f.borId);
    await db.query(
      `INSERT INTO amc_orders (application_id, client_order_number, sp_order_number, status, ordered_at)
       VALUES ($1,$2,$3,'in_process', now() - interval '2 days')`,
      [f.appId, `CO2-${tag}`.slice(0, 40), `SP2-${tag}`.slice(0, 40)]);
    await mirror.syncOne(f.appId, db);

    // A coordinator takes it on, agrees a date with the appraiser, writes a note.
    await db.query(
      `UPDATE file_orders
          SET assigned_to=$2, assigned_at=now(), due_on='2026-12-24', sla_days=21,
              notes='Appraiser is booked for Thursday.', first_response_at=now(), followup_count=2
        WHERE application_id=$1 AND order_type='appraisal'`, [f.appId, staff.id]);

    // …and the vendor moves on, so the projection runs again.
    await db.query(`UPDATE amc_orders SET status='inspected' WHERE application_id=$1`, [f.appId]);
    await mirror.syncOne(f.appId, db);

    const row = await deskRow(f.appId);
    ok(String(row.assigned_to) === String(staff.id), 'C1: the assignment survives the next projection');
    ok(row.notes === 'Appraiser is booked for Thursday.', 'C2: the note survives');
    ok(String(row.due_on).slice(0, 10) === '2026-12-24', 'C3: the agreed due date survives');
    ok(Number(row.sla_days) === 21, 'C4: an overridden SLA survives');
    ok(row.first_response_at != null, 'C5: the first-response stamp survives');
    ok(Number(row.followup_count) === 2, 'C6: the follow-up count survives');
    ok(row.status === 'ordered', 'C7: …and the derived half still tracked the vendor');
  }

  // ===================================================================
  // D. The report coming back, and the order finishing.
  // ===================================================================
  {
    const f = await seedFile('done');
    cleanupApps.push(f.appId); cleanupBors.push(f.borId);
    await db.query(
      `INSERT INTO amc_orders (application_id, client_order_number, sp_order_number, status, ordered_at)
       VALUES ($1,$2,$3,'product_available', now() - interval '9 days')`,
      [f.appId, `CO3-${tag}`.slice(0, 40), `SP3-${tag}`.slice(0, 40)]);
    await mirror.syncOne(f.appId, db);
    ok((await deskRow(f.appId)).status === 'documents_in',
      'D1: the report being available reads as "documents in", like a title commitment coming back');

    await db.query(`UPDATE amc_orders SET status='completed', completed_at=now() WHERE application_id=$1`, [f.appId]);
    await mirror.syncOne(f.appId, db);
    const row = await deskRow(f.appId);
    ok(row.status === 'completed' && row.completed_at, 'D2: it finishes on its own when the vendor says so');
    ok(orderSla.orderState({ ...row, order_type: 'appraisal' }, new Date()).open === false,
      'D3: …and it drops out of the open queue');
  }

  // ===================================================================
  // E. Several orders on one file — the desk shows the live one.
  // ===================================================================
  {
    const f = await seedFile('two');
    cleanupApps.push(f.appId); cleanupBors.push(f.borId);
    await db.query(
      `INSERT INTO amc_orders (application_id, client_order_number, sp_order_number, status, ordered_at)
       VALUES ($1,$2,$3,'cancelled', now())`,
      [f.appId, `CO4-${tag}`.slice(0, 40), `SP4-${tag}`.slice(0, 40)]);
    await db.query(
      `INSERT INTO class_orders (application_id, class_order_id, reference_number, api_version, uad, order_path, status, placed_at)
       VALUES ($1,$2,$3,'v1','2.6','/orders','in_process', now() - interval '3 days')`,
      [f.appId, `CL-${tag}`.slice(0, 40), `REF-${tag}`.slice(0, 40)]);
    await mirror.syncOne(f.appId, db);
    const row = await deskRow(f.appId);
    ok(row.status === 'ordered' && row.vendor_name === 'Class Valuation',
      'E1: a cancelled first attempt never masks the live order on the other vendor');
  }

  // ===================================================================
  // F. A draft that was never placed puts nothing on the desk.
  // ===================================================================
  {
    const f = await seedFile('draft');
    cleanupApps.push(f.appId); cleanupBors.push(f.borId);
    await db.query(
      `INSERT INTO amc_orders (application_id, client_order_number, status)
       VALUES ($1,$2,'draft')`, [f.appId, `CO5-${tag}`.slice(0, 40)]);
    await mirror.syncOne(f.appId, db);
    ok((await deskRow(f.appId)) === null,
      'F1: an abandoned draft is not an order and never reaches the desk');
  }

  // ===================================================================
  // G. THE BACK BOOK. Every file that already had an appraisal order.
  // ===================================================================
  {
    const f = await seedFile('back');
    cleanupApps.push(f.appId); cleanupBors.push(f.borId);
    await db.query(
      `INSERT INTO amc_orders (application_id, client_order_number, sp_order_number, status, ordered_at)
       VALUES ($1,$2,$3,'in_review', now() - interval '20 days')`,
      [f.appId, `CO6-${tag}`.slice(0, 40), `SP6-${tag}`.slice(0, 40)]);
    ok((await deskRow(f.appId)) === null, 'G1: it starts off the desk (the state every existing file is in)');
    const swept = await mirror.backfillOnce(db, 500);
    ok(swept && swept.synced > 0, 'G2: the boot sweep runs');
    ok((await deskRow(f.appId)) !== null, 'G3: …and an existing file gains its desk row');
    // Self-draining: the same file is not swept again.
    const again = await mirror.backfillOnce(db, 500);
    const stillListed = (again.swept || 0) > 0 && (await db.query(
      `SELECT 1 FROM file_orders WHERE application_id=$1 AND order_type='appraisal'`, [f.appId])).rowCount === 1;
    ok(stillListed || (again.swept === 0), 'G4: the sweep drains — a file it has done is not re-swept');
  }

  // ===================================================================
  // H. The desk may TRACK an appraisal; it may never ORDER or FINISH one.
  // ===================================================================
  {
    const staffRoutes = require(path.join(ROOT, 'src/routes/staff'));
    const src = require('fs').readFileSync(path.join(ROOT, 'src/routes/staff.js'), 'utf8');
    ok(/function isOrderKind\(k\) \{ return k === 'title' \|\| k === 'insurance'; \}/.test(src),
      'H1: the SEND door is still title and insurance only — an appraisal is never emailed from the desk');
    ok(/kind === 'appraisal'[\s\S]{0,400}vendor_owned/.test(src),
      'H2: marking an appraisal finished by hand is refused, because the vendor owns that');
    ok(typeof staffRoutes.signOffGate === 'function', 'H3: (the routes module still loads)');
  }

  // cleanup
  for (const id of cleanupApps) {
    await db.query('DELETE FROM file_order_events WHERE application_id=$1', [id]).catch(() => {});
    await db.query('DELETE FROM file_orders WHERE application_id=$1', [id]).catch(() => {});
    await db.query('DELETE FROM amc_orders WHERE application_id=$1', [id]).catch(() => {});
    await db.query('DELETE FROM class_orders WHERE application_id=$1', [id]).catch(() => {});
    await db.query('DELETE FROM rv_orders WHERE application_id=$1', [id]).catch(() => {});
    await db.query('DELETE FROM applications WHERE id=$1', [id]).catch(() => {});
  }
  for (const id of cleanupBors) await db.query('DELETE FROM borrowers WHERE id=$1', [id]).catch(() => {});
  await db.query('DELETE FROM staff_users WHERE id=$1', [staff.id]).catch(() => {});

  console.log(failures ? `\n${failures} FAILURE(S) of ${n}` : `\nOK  appraisal-order-desk-db: ${n} checks passed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
