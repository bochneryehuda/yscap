'use strict';
/**
 * WHICH WAY IS THIS APPRAISAL BEING PAID FOR — against a real Postgres.
 *
 * Owner-directed 2026-08-16: *"We're gonna keep it manual. We're gonna have all
 * the options over there … send the payment link … use the card on file … use the
 * card manually. We should keep all the options open."*
 *
 * The vocabulary and the per-vendor capability are pinned purely by
 * `test-appraisal-payment-options-pure.js`. This is what a pure test cannot reach:
 *
 *   • db/562's columns and its CHECKs really exist and really accept the three
 *     methods — `payment-intent.js` reads through a swallowing catch, which is
 *     exactly how a phantom column reports a confident, permanent "nothing here";
 *   • one live instruction per order, so changing your mind REPLACES rather than
 *     stacks a second, contradictory one;
 *   • changing the method after it is paid does NOT un-pay it;
 *   • the routes: choosing, refusing what should be refused, settling, undoing;
 *   • and the one that matters most — NOTHING here charges anything.
 *
 * DB-gated; skips cleanly without DATABASE_URL. Fixtures are removed.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const path = require('path');
const ROOT = path.join(__dirname, '..');

if (!process.env.DATABASE_URL) {
  console.log('test-appraisal-payment-intent-db: skipped (no DATABASE_URL)');
  process.exit(0);
}

const db = require(path.join(ROOT, 'src/db'));
const { ensureSchema } = require(path.join(ROOT, 'src/migrate-boot'));
const intent = require(path.join(ROOT, 'src/lib/appraisal/payment-intent'));
const options = require(path.join(ROOT, 'src/lib/appraisal/payment-options'));

let n = 0, failures = 0;
const ok = (c, m) => { n++; console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const tag = `${process.pid}${Date.now()}`;

(async () => {
  await ensureSchema();
  const cleanupApps = [], cleanupBors = [];

  const staff = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active)
     VALUES ($1,'Pay Tester','processor',true) RETURNING id`,
    [`paystaff_${tag}@example.com`])).rows[0];

  async function seedFile(label) {
    const bor = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Pay','Test',$1) RETURNING id`,
      [`pay_${tag}_${label}@example.com`])).rows[0];
    const app = (await db.query(
      `INSERT INTO applications (borrower_id, status, ys_loan_number)
       VALUES ($1,'underwriting',$2) RETURNING id`,
      [bor.id, `YSCAP-PAY-${label}-${tag}`.slice(0, 40)])).rows[0];
    cleanupBors.push(bor.id); cleanupApps.push(app.id);
    return app.id;
  }

  // =====================================================================
  // A. The table exists and its shape is what the code believes.
  //    A swallowing catch turns a wrong column name into a permanent,
  //    confident "no payment instruction on any order" — so this is checked
  //    against information_schema, not inferred from a query succeeding.
  // =====================================================================
  {
    const cols = (await db.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name='appraisal_payment_intents'`)).rows.map((r) => r.column_name);
    for (const c of ['application_id', 'vendor', 'vendor_order_id', 'method', 'chosen_by',
      'chosen_at', 'note', 'performed_by', 'settled_at', 'settled_by', 'settled_note']) {
      ok(cols.includes(c), `A: db/562 really has ${c}`);
    }
    // The reader JOINs staff_users for the names it prints. That column has been
    // got wrong before in this repo (borrowers has no full_name), and here it
    // would fail inside the catch and silently blank the desk.
    const sn = (await db.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name='staff_users' AND column_name='full_name'`)).rows.length;
    ok(sn === 1, 'A: staff_users.full_name exists — the name the desk prints is really there');
  }

  // =====================================================================
  // B. All three methods are storable. The array in the code and the CHECK
  //    in the database must agree, or a perfectly valid choice 500s.
  // =====================================================================
  {
    const appId = await seedFile('methods');
    let i = 0;
    for (const m of options.METHODS) {
      const r = await intent.record({ appId, vendor: 'nan', orderId: ++i, method: m, staffId: staff.id });
      ok(r.ok && r.intent.method === m, `B: "${options.METHOD_LABEL[m]}" is storable`);
    }
    const bad = await intent.record({ appId, vendor: 'nan', orderId: 99, method: 'ACH', staffId: staff.id });
    ok(!bad.ok && bad.error === 'unknown_method', 'B: ACH is refused before it reaches the database');
    const badVendor = await intent.record({ appId, vendor: 'acme', orderId: 99, method: 'PAYMENT_LINK' });
    ok(!badVendor.ok && badVendor.error === 'unknown_vendor', 'B: an unknown appraisal company is refused');
    const noOrder = await intent.record({ appId, vendor: 'nan', orderId: 0, method: 'PAYMENT_LINK' });
    ok(!noOrder.ok && noOrder.error === 'no_order', 'B: an instruction with no order to attach to is refused');
  }

  // =====================================================================
  // C. ONE live instruction per order — changing your mind replaces it.
  // =====================================================================
  {
    const appId = await seedFile('replace');
    await intent.record({ appId, vendor: 'class', orderId: 501, method: 'PAYMENT_LINK', staffId: staff.id });
    await intent.record({ appId, vendor: 'class', orderId: 501, method: 'CARD_ON_FILE', staffId: staff.id });
    const rows = (await db.query(
      `SELECT * FROM appraisal_payment_intents WHERE vendor='class' AND vendor_order_id=501`)).rows;
    ok(rows.length === 1, 'C: changing your mind leaves ONE instruction, not two contradictory ones');
    ok(rows[0].method === 'CARD_ON_FILE', 'C: and it is the latest decision');
  }

  // =====================================================================
  // D. Changing the method after it is paid does NOT un-pay it.
  //    The money already moved; the desk must never go back to reading
  //    "still to be paid" because somebody corrected the record afterwards.
  // =====================================================================
  {
    const appId = await seedFile('settled');
    await intent.record({ appId, vendor: 'rv', orderId: 601, method: 'PAYMENT_LINK', staffId: staff.id, settled: true });
    const paid = await intent.forOrder('rv', 601);
    ok(!!paid.settled_at, 'D: a payment the vendor took is recorded as settled straight away');
    ok(paid.performed_by === 'vendor', 'D: and recorded as having been performed by the vendor');

    await intent.record({ appId, vendor: 'rv', orderId: 601, method: 'CARD_ON_FILE', staffId: staff.id });
    const after = await intent.forOrder('rv', 601);
    ok(after.method === 'CARD_ON_FILE', 'D: the method can still be corrected');
    ok(!!after.settled_at, 'D: …and correcting it does NOT un-pay the order');
    ok(after.describe && after.describe.settled, 'D: the desk still reads it as paid');
  }

  // =====================================================================
  // E. Settle / unsettle, and the refusal that keeps them honest.
  // =====================================================================
  {
    const appId = await seedFile('settle');
    const orphan = await intent.settle({ vendor: 'nan', orderId: 777, staffId: staff.id });
    ok(!orphan.ok && orphan.error === 'no_intent',
      'E: an order nobody chose a method for cannot be marked paid — that would stamp a method never picked');

    await intent.record({ appId, vendor: 'nan', orderId: 701, method: 'CARD_ON_FILE', staffId: staff.id });
    const before = await intent.forOrder('nan', 701);
    ok(before.describe.awaitingBackOffice, 'E: on AppraisalScope it starts out waiting on the back office');

    const s = await intent.settle({ vendor: 'nan', orderId: 701, staffId: staff.id, note: 'charged 08/16' });
    ok(s.ok && !!s.intent.settled_at && s.intent.settled_by === staff.id,
      'E: marking it paid records who did it');
    const done = await intent.forOrder('nan', 701);
    ok(!done.describe.awaitingBackOffice, 'E: and it stops asking anybody to do anything');

    const u = await intent.unsettle({ vendor: 'nan', orderId: 701 });
    ok(u.ok && !u.intent.settled_at, 'E: a wrongly-marked order can be put back');
    ok((await intent.forOrder('nan', 701)).method === 'CARD_ON_FILE',
      'E: and putting it back keeps the chosen method');
  }

  // =====================================================================
  // F. Reading it back the way the desk does.
  // =====================================================================
  {
    const appId = await seedFile('read');
    await intent.record({ appId, vendor: 'nan', orderId: 801, method: 'PAYMENT_LINK', staffId: staff.id });
    const all = await intent.forApplication(appId);
    ok(!!all['nan:801'], 'F: the desk finds it under <vendor>:<orderId>');
    ok(all['nan:801'].chosen_by_name === 'Pay Tester',
      'F: and it names who decided, so nobody has to go and ask');
    ok(all['nan:801'].describe && /payment link/i.test(all['nan:801'].describe.head),
      'F: with the same sentence every surface prints');
    ok(Object.keys(await intent.forApplication('00000000-0000-0000-0000-000000000000')).length === 0,
      'F: a file with nothing chosen reads as nothing');
  }

  // =====================================================================
  // G. THE ORDERS DESK CARRIES THE ORDER ROW ID.
  //    The instruction is keyed on the vendor order table's own id. The
  //    mirror's meta block had to learn to carry it — without it the desk
  //    can record an instruction it can never find again.
  // =====================================================================
  {
    const mirror = require(path.join(ROOT, 'src/lib/appraisal-order-mirror'));
    const d = mirror.describe('nan', {
      id: 4242, status: 'ordered', sp_order_number: 'SP-1', created_at: new Date(),
    });
    ok(d && d.rowId === 4242, 'G: the mirror knows the vendor order row id');
    // Proven through the real projection rather than by reading the source: the
    // desk's payment lookup is built from meta.orderId, so a meta block that drops
    // it fails here rather than in production.
    const appId = await seedFile('meta');
    await db.query(
      `INSERT INTO amc_orders (application_id, status, sp_order_number, created_at)
       VALUES ($1,'ordered',$2, now())`, [appId, `SP-META-${tag}`]);
    await mirror.syncOne(appId, db);
    const row = (await db.query(
      `SELECT meta FROM file_orders WHERE application_id=$1 AND order_type='appraisal'`, [appId])).rows[0];
    const meta = row && row.meta && row.meta.appraisal;
    ok(!!meta && meta.orderId != null,
      'G: and the desk projection carries it, so a payment instruction can be found again');
  }

  // =====================================================================
  // H. NOTHING IN THIS FEATURE CHARGES ANYTHING.
  //    Payment is manual by standing rule. The recording half must never
  //    grow a vendor call — that is how "manual" quietly stops being true.
  // =====================================================================
  {
    const fs = require('fs');
    const src = fs.readFileSync(path.join(ROOT, 'src/lib/appraisal/payment-intent.js'), 'utf8');
    const optSrc = fs.readFileSync(path.join(ROOT, 'src/lib/appraisal/payment-options.js'), 'utf8');
    const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const [name, s] of [['payment-intent', code(src)], ['payment-options', code(optSrc)]]) {
      ok(!/require\(['"][^'"]*\/(client|payment)['"]\)/.test(s) && !/fetch\s*\(/.test(s),
        `H: ${name}.js talks to no appraisal company — it only records what a person decided`);
    }
    ok(!/charge|capture|authorize/i.test(code(src)),
      'H: and it has no charge/capture/authorize path of its own');
  }

  // cleanup
  for (const a of cleanupApps) {
    await db.query(`DELETE FROM appraisal_payment_intents WHERE application_id=$1`, [a]);
    await db.query(`DELETE FROM amc_orders WHERE application_id=$1`, [a]);
    await db.query(`DELETE FROM file_orders WHERE application_id=$1`, [a]);
    await db.query(`DELETE FROM applications WHERE id=$1`, [a]);
  }
  for (const b of cleanupBors) await db.query(`DELETE FROM borrowers WHERE id=$1`, [b]);
  await db.query(`DELETE FROM staff_users WHERE id=$1`, [staff.id]);

  console.log(failures ? `\n${failures} FAILURE(S) of ${n}` : `\nOK  appraisal-payment-intent-db: ${n} checks passed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
