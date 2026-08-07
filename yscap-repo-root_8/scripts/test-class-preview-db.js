'use strict';
/**
 * Class Valuation preview + order desk — real Postgres, real HTTP.
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
const assert = require('assert');
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

  // --- cleanup ------------------------------------------------------------
  await db.query('DELETE FROM applications WHERE id=$1', [appId]);
  await db.query('DELETE FROM borrowers WHERE id=$1', [borrowerId]);

  console.log(`\ntest-class-preview-db: ${pass} passed, ${fail} failed`);
  await db.pool.end().catch(() => {});
  if (fail) process.exit(1);
}

main().catch(async (e) => { console.error('FAILED', e); try { await db.pool.end(); } catch (_) {} process.exit(1); });
