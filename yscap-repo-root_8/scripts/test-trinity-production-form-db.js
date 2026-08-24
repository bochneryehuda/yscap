'use strict';
/**
 * THE PRODUCTION FORM — the record, the placement, the read-back, and the picker.
 * REAL Postgres, Trinity's API stubbed.
 *
 * Owner-directed 2026-08-24: *"Form 19 is only for the test environment. We need to change it for
 * the production environment … By default, the system, by physical inspection, should order the
 * real form … We should also have the option to change forms and order different forms, but this
 * should be the default and should give you a warning if you are trying to change."*
 *
 * WHY A REAL DATABASE. The whole hazard is a COLUMN: `trinity_form_id` is what makes an order's
 * budget readable after the default moves, and every query that reads or writes it sits inside a
 * best-effort catch somewhere in production — so a phantom column, a wrong bind position, or a
 * column DEFAULT nobody noticed would report a confident "nothing to do" forever. The pure suite
 * proves the RULE and the wiring by source; this proves the column behaves, the migration
 * converges, and a placed order records what it actually went out on.
 *
 * Skips cleanly when DATABASE_URL is unset.
 */

if (!process.env.DATABASE_URL) { console.log('test-trinity-production-form-db: SKIPPED (no DATABASE_URL)'); process.exit(0); }

process.env.TRINITY_ENABLED = '1';
process.env.TRINITY_OUTBOUND_ENABLED = '1';
process.env.TRINITY_DRYRUN = '0';
process.env.TRINITY_COMPANY_ID = '39400';
process.env.TRINITY_USERNAME = process.env.TRINITY_USERNAME || 'test-user';
process.env.TRINITY_PASSWORD = process.env.TRINITY_PASSWORD || 'test-pass';

const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');

// ---- stub the client BEFORE anything requires it -------------------------------
const client = require('../src/trinity/client');
const seen = { create: [], budget: [] };
let created = 0;
let catalogue = [
  { id: 1079, name: 'General Purpose Line Item Draw PCR' },
  { id: 1081, name: 'Sibling Dollar Line Item Draw' },
  { id: 159, name: 'Budget Review' },
];
let catalogueReadable = true;

client.available = () => true;
client.enabled = () => true;
client.outboundEnabled = () => true;
client.dryrun = () => false;
client.companyId = async () => 39400;
client.forms = async () => (catalogueReadable ? catalogue : (() => { throw new Error('unreachable'); })());
client.formsCached = async () => (catalogueReadable ? catalogue : null);
/* Ids unique to THIS run. `uq_tio_trinity_order` refuses two of our records holding one Trinity
   order — correctly — so a fixed stub id makes the second run of this suite fail on rows the first
   run left behind, which reads as a product bug and is not one. */
const RUN = Date.now() % 100000;
client.createOrder = async (payload, opts = {}) => {
  created++;
  seen.create.push({ form: opts.form == null ? null : opts.form });
  return { id: 7000000 + RUN * 10 + created, order: { id: 8000000 + RUN * 10 + created, total: {} }, _sent: payload };
};
client.findOrderByCustomerKey = async () => null;
client.getOrder = async () => ({ id: 800001, status: { id: 7, name: 'Searching for Inspector' }, subStatus: null, completedAt: null });
client.getBudget = async (id, form) => { seen.budget.push({ id: Number(id), form: form == null ? null : Number(form) }); return null; };
client.getPhotos = async () => [];
client.getReport = async () => { const e = new Error('not ready'); e.status = 404; throw e; };
client.getComments = async () => [];
client.addDocument = async (id, d) => ({ id: 1, fileName: d.fileName, group: { id: d.groupId } });
client.addComment = async () => ({ id: 5001, createdAt: new Date().toISOString() });

const order = require('../src/trinity/order');
const ingest = require('../src/trinity/ingest');
const intake = require('../src/trinity/intake');
const FORM = require('../src/trinity/form');

let n = 0, failed = 0;
const ok = (cond, label) => { n++; if (cond) return; failed++; console.error('  ✘ ' + label); };
const eq = (a, b, label) => ok(a === b, `${label} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`);

(async () => {
  /* THE MIGRATIONS MUST HAVE RUN BEFORE THE FIRST WRITE. Booting kicks them off asynchronously, so
     a suite that starts straight away races a brand-new column into existence and reads "does not
     exist" on the very run meant to prove it. */
  await ensureSchema();

  // ── A. the column ─────────────────────────────────────────────────────────────────────────
  const col = (await db.query(
    `SELECT data_type, column_default, is_nullable FROM information_schema.columns
      WHERE table_name='trinity_inspection_orders' AND column_name='trinity_form_id'`)).rows[0];
  ok(col, 'A1 trinity_inspection_orders.trinity_form_id exists');
  eq(col && col.data_type, 'integer', 'A2 …as an integer');
  /* NO COLUMN DEFAULT is the whole correctness of db/628. A default of 19 would stamp every
     brand-new record with the SANDBOX form at INSERT — on a production account that does not carry
     form 19 at all — and the placement would then dutifully use it. */
  eq(col && col.column_default, null, 'A3 …with NO default: an unplaced record has no form, and that is the honest value');
  eq(col && col.is_nullable, 'YES', 'A4 …and NULL is allowed, because that is what "not placed yet" looks like');

  // ── B. fixture ────────────────────────────────────────────────────────────────────────────
  const stamp = Date.now();
  const b = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email,cell_phone) VALUES ('Ada','Lovelace',$1,'7325550134') RETURNING id`,
    [`trinform-${stamp}@example.com`])).rows[0];
  const a = (await db.query(
    `INSERT INTO applications (borrower_id, status, ys_loan_number, property_address, property_type, units, loan_amount, loan_type, rehab_budget)
     VALUES ($1,'funded',$2,$3::jsonb,'SFR',1,350000,'Purchase',140000) RETURNING id`,
    [b.id, `YSCAP-F-${stamp.toString(36)}`,
      JSON.stringify({ street: '9 Elm St', city: 'Lakewood', state: 'NJ', zip: '08701', oneLine: '9 Elm St, Lakewood, NJ' })])).rows[0];
  const sc = (await db.query(
    `INSERT INTO service_contacts (contact_type, company_name, contact_name, email, phone)
     VALUES ('contractor','Builder Co LLC','Sam Builder',$1,'7325550199') RETURNING id`,
    [`sam-${stamp}@builderco.example.com`])).rows[0];
  await db.query(`INSERT INTO application_service_contacts (application_id, service_contact_id, contact_type) VALUES ($1,$2,'contractor')`, [a.id, sc.id]);

  const base = 700000 + Math.floor(Math.random() * 200000);
  await db.query(
    `INSERT INTO sitewire_job_item_links (application_id, sitewire_budget_id, sitewire_job_item_id, sow_line_key, section_token, name, budgeted_cents, is_media_item)
     VALUES ($1,$2,$3,'roof','roof','Roof',4000000,false)`, [a.id, base, base + 11]);
  /* THE FILE IS ON PHYSICAL INSPECTIONS — set the way the coordinator's Start-draw screen sets it.
     Without this the routing says VIRTUAL and `orderManually` refuses on eligibility long before
     it ever looks at a form, which would leave section G proving nothing about forms. */
  await db.query(
    `INSERT INTO sitewire_property_links (application_id, sitewire_property_id, matched_by, inspection_method)
     VALUES ($1,$2,'created','traditional')
     ON CONFLICT DO NOTHING`, [a.id, base]);

  /* One OPEN draw request per file (`uq_pdr_open`), which is a real rule and not something to work
     around — each section closes its predecessor out, exactly as a finished draw would. */
  const newRequest = async () => {
    await db.query(
      `UPDATE portal_draw_requests SET status='closed_out' WHERE application_id=$1 AND status IN ('submitted','entered','approved')`,
      [a.id]);
    return (await db.query(
      `INSERT INTO portal_draw_requests (application_id, source, platform, lines, total_requested_cents)
       VALUES ($1,'staff','trinity',$2::jsonb,$3) RETURNING id`,
      [a.id, JSON.stringify([{ sitewire_job_item_id: base + 11, sow_line_key: 'roof', name: 'Roof', requested_cents: 1000000 }]), 1000000])).rows[0];
  };
  const newRecord = async (prId, formId = null) => (await db.query(
    `INSERT INTO trinity_inspection_orders (application_id, portal_draw_request_id, customer_key, trinity_form_id)
     VALUES ($1,$2,$3,$4) RETURNING id`, [a.id, prId, `pdr-${prId}`, formId])).rows[0];

  // ── C. an ordinary order goes out on, and records, the production default ──────────────────
  {
    const pr = await newRequest();
    const rec = await newRecord(pr.id);
    seen.create.length = 0;
    const placed = await order.placeOrder(a.id, rec.id);
    ok(placed.ok, 'C1 the order is placed');
    eq(seen.create[0] && seen.create[0].form, 1079, 'C2 it goes out on the PRODUCTION form, not the sandbox one');
    const row = (await db.query(`SELECT trinity_form_id, trinity_order_id FROM trinity_inspection_orders WHERE id=$1`, [rec.id])).rows[0];
    eq(Number(row.trinity_form_id), 1079, 'C3 …and the record says which form it went out on');
    ok(row.trinity_order_id, 'C4 …in the same statement that records the order id');
  }

  // ── D. a record that already names a form is placed on THAT one ────────────────────────────
  {
    // This is the resume case AND the coordinator's choice, and they are the same mechanism: a
    // retry that quietly reverted to today's default would place a second, different product.
    const pr = await newRequest();
    const rec = await newRecord(pr.id, 19);
    seen.create.length = 0;
    const placed = await order.placeOrder(a.id, rec.id);
    ok(placed.ok, 'D1 the order is placed');
    eq(seen.create[0] && seen.create[0].form, 19, 'D2 …on the form the RECORD names, not the configured default');
    const row = (await db.query(`SELECT trinity_form_id FROM trinity_inspection_orders WHERE id=$1`, [rec.id])).rows[0];
    eq(Number(row.trinity_form_id), 19, 'D3 …and the record still names it afterwards');
  }

  // ── E. the read-back uses the order's own form ─────────────────────────────────────────────
  {
    // THE TRAP THIS WHOLE CHANGE EXISTS FOR: an order placed on 19 is readable ONLY at
    // /forms/19/..., so reading it back at today's default returns nothing — the inspector's
    // approved figures simply stop arriving, on every order already in flight, with nothing
    // anywhere saying why.
    const pr = await newRequest();
    const rec = await newRecord(pr.id, 19);
    await db.query(`UPDATE trinity_inspection_orders SET trinity_order_id=$2 WHERE id=$1`, [rec.id, 8100000 + RUN * 10 + 1]);
    const row = (await db.query(`SELECT * FROM trinity_inspection_orders WHERE id=$1`, [rec.id])).rows[0];
    seen.budget.length = 0;
    await ingest.readResults(row).catch(() => null);
    eq(seen.budget[0] && seen.budget[0].form, 19, 'E1 readResults asks Trinity for the budget on form 19');
    eq(seen.budget[0] && seen.budget[0].id, 8100000 + RUN * 10 + 1, 'E2 …for this order');

    const pr2 = await newRequest();
    const rec2 = await newRecord(pr2.id, null);
    await db.query(`UPDATE trinity_inspection_orders SET trinity_order_id=$2 WHERE id=$1`, [rec2.id, 8100000 + RUN * 10 + 2]);
    const row2 = (await db.query(`SELECT * FROM trinity_inspection_orders WHERE id=$1`, [rec2.id])).rows[0];
    seen.budget.length = 0;
    await ingest.readResults(row2).catch(() => null);
    eq(seen.budget[0] && seen.budget[0].form, 1079,
      'E3 a record with no form recorded falls back to the default — a pre-db/628 row behaves as it always did');
  }

  // ── F. the picker reads TRINITY's list, and says so when it cannot ─────────────────────────
  {
    const opts = await intake.orderOptions(a.id);
    ok(opts.form, 'F1 the order door reports what form it would use');
    eq(opts.form.default, 1079, 'F2 …the production form');
    eq(opts.form.defaultName, 'General Purpose Line Item Draw PCR', 'F3 …named from Trinity’s OWN catalogue, not a list we keep');
    ok(opts.form.onAccount, 'F4 …and confirmed to be on this account');
    ok(opts.form.read, 'F5 …and it says the catalogue was genuinely read');
    ok(opts.form.products.some((p) => Number(p.id) === 1081), 'F6 …offering the account’s other forms to pick from');

    catalogueReadable = false;
    const opts2 = await intake.orderOptions(a.id);
    eq(opts2.form.read, false, 'F7 an unreadable catalogue says so');
    eq(opts2.form.products.length, 0, 'F8 …with nothing to pick from');
    eq(opts2.form.default, 1079, 'F9 …but the default is still stated — a failed read never blanks the order door');
    catalogueReadable = true;
  }

  // ── G. changing the form: refused, warned, then confirmed ──────────────────────────────────
  {
    const pr = await newRequest();
    await newRecord(pr.id);

    const un = await intake.orderManually(a.id, { portalRequestId: pr.id, formId: 1081 });
    ok(un.blocked && un.needsFormConfirm, 'G1 a different form is not placed until it is confirmed');
    ok(/1081/.test(String(un.warning)) && /1079/.test(String(un.warning)),
      'G2 …and the warning names both forms');
    let row = (await db.query(`SELECT trinity_form_id, trinity_order_id FROM trinity_inspection_orders WHERE portal_draw_request_id=$1`, [pr.id])).rows[0];
    eq(row.trinity_form_id, null, 'G3 …and nothing is stamped on the record until then');
    eq(row.trinity_order_id, null, 'G4 …and nothing is ordered');

    const review = await intake.orderManually(a.id, { portalRequestId: pr.id, formId: 159, confirmForm: true });
    ok(review.blocked && review.formProblem === 'budget_review',
      'G5 the budget review is refused from the draw door even when confirmed — it has its own gate');

    const absent = await intake.orderManually(a.id, { portalRequestId: pr.id, formId: 4242, confirmForm: true });
    ok(absent.blocked && absent.formProblem === 'not_on_account',
      'G6 a form not on the account is refused before anything is ordered');

    seen.create.length = 0;
    const done = await intake.orderManually(a.id, { portalRequestId: pr.id, formId: 1081, confirmForm: true });
    ok(done.ok, 'G7 confirmed, it is ordered');
    eq(seen.create[0] && seen.create[0].form, 1081, 'G8 …on the form that was confirmed');
    row = (await db.query(`SELECT trinity_form_id FROM trinity_inspection_orders WHERE portal_draw_request_id=$1`, [pr.id])).rows[0];
    eq(Number(row.trinity_form_id), 1081, 'G9 …and the record names it');
    ok(/1081/.test(String(done.formWarning || '')), 'G10 …and the answer carries the warning that was confirmed');
  }

  // ── H. the migration converges, and its backfill is SCOPED ────────────────────────────────
  {
    /* Every migration replays on EVERY boot, so what must be proven is that it CONVERGES — not
       that some other suite left the table tidy. A row PLACED before db/628 went out on 19 (a
       fact: it was the hard-coded default until then); a record that has ordered nothing has no
       form, and stamping one would hand it the sandbox form on a production account. */
    const prPlaced = await newRequest();
    const recPlaced = await newRecord(prPlaced.id, null);
    await db.query(`UPDATE trinity_inspection_orders SET trinity_order_id=$2, trinity_form_id=NULL WHERE id=$1`, [recPlaced.id, 8100000 + RUN * 10 + 3]);
    const prUnplaced = await newRequest();
    const recUnplaced = await newRecord(prUnplaced.id, null);

    const sql = fs.readFileSync(path.join(__dirname, '..', 'db/628_trinity_order_records_its_form_id.sql'), 'utf8');
    await db.query(sql);

    const p = (await db.query(`SELECT trinity_form_id FROM trinity_inspection_orders WHERE id=$1`, [recPlaced.id])).rows[0];
    eq(Number(p.trinity_form_id), 19, 'H1 an order PLACED before db/628 is backfilled to 19 — the only form it could have used');
    const u = (await db.query(`SELECT trinity_form_id FROM trinity_inspection_orders WHERE id=$1`, [recUnplaced.id])).rows[0];
    eq(u.trinity_form_id, null, 'H2 a record that ordered nothing is left with NO form — it will use the default when it places');

    // Replaying must not move a form somebody chose.
    await db.query(`UPDATE trinity_inspection_orders SET trinity_form_id=1081 WHERE id=$1`, [recUnplaced.id]);
    await db.query(sql);
    const u2 = (await db.query(`SELECT trinity_form_id FROM trinity_inspection_orders WHERE id=$1`, [recUnplaced.id])).rows[0];
    eq(Number(u2.trinity_form_id), 1081, 'H3 a replay never rewrites a form the desk chose');

    const col2 = (await db.query(
      `SELECT column_default FROM information_schema.columns
        WHERE table_name='trinity_inspection_orders' AND column_name='trinity_form_id'`)).rows[0];
    eq(col2.column_default, null, 'H4 …and the column still carries no default after a replay');
  }

  // ── I. the constants are what the rest of the system reads ────────────────────────────────
  eq(client.formId(), FORM.PRODUCTION_DRAW_FORM_ID, 'I1 the client’s default IS the production form');

  await db.query(`DELETE FROM trinity_inspection_orders WHERE application_id=$1`, [a.id]);
  await db.query(`DELETE FROM portal_draw_requests WHERE application_id=$1`, [a.id]);

  console.log(`${failed ? '✗' : '✓'} test-trinity-production-form-db: ${n - failed}/${n} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('test-trinity-production-form-db FAILED:', e); process.exit(1); });
