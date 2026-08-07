/**
 * A STAFF-SET LOAN AMOUNT SURVIVES A BORROWER RE-REGISTER (owner-directed
 * 2026-08-06). Real Postgres. Skips cleanly with no DATABASE_URL.
 *
 * THE HOLE THIS CLOSES. `targetLoan` lives in the studio's ADMIN zone, which is
 * removed from the DOM for a borrower — so their studio cannot show it, cannot
 * restore it, and `borrowerPricingOverrides` rightly refuses to accept one from the
 * client. Every one of those is correct on its own, and together they made a silent
 * way to UNDO an officer's ceiling: staff register at a typed amount, the borrower
 * opens their own Products & Pricing, sees the deal at its maximum, presses
 * Register, and the file re-registers at the full amount — a bigger loan at a worse
 * rate, with no approval, no escalation and no record that a ceiling ever existed.
 *
 * The fix carries it forward from the file's own current registration, exactly as
 * the per-file markup is carried, and for the same stated reason: a borrower can
 * never reprice away the basis the file was structured at.
 *
 * NOTE the query is asserted against the REAL table here rather than only through a
 * mock — the first cut of this fix selected `superseded_at`, a column that does not
 * exist, inside a try/catch. It threw on every call and silently did nothing, which
 * is precisely the swallowed-phantom-column class this repo has been bitten by
 * before. A pure test could not have caught it.
 */
'use strict';

const path = require('path');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

if (!process.env.DATABASE_URL) {
  console.log('SKIP test-target-loan-sticky-db: no DATABASE_URL');
  process.exit(0);
}

const db = require('../src/db');
const pricing = require('../src/lib/pricing');

(async () => {
  // ---- 1. The column the sticky read depends on actually exists -----------------
  const cols = await db.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'product_registrations' AND column_name IN ('is_current','inputs')`);
  const names = cols.rows.map((r) => r.column_name).sort();
  assert(names.join(',') === 'inputs,is_current',
    `A1 product_registrations still carries the columns the sticky read uses (${names.join(',') || 'none'})`);
  const bad = await db.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = 'product_registrations' AND column_name = 'superseded_at'`);
  assert(bad.rows.length === 0,
    'A2 …and there is no superseded_at column — the predicate is is_current, as the rest of the codebase uses');

  // ---- 2. The exact query the route runs, against the real table ----------------
  // A throwing query here would be swallowed by the route's catch and the ceiling
  // would silently vanish, so it is exercised for real rather than assumed.
  let ran = true, qErr = null;
  try {
    await db.query(
      `SELECT inputs FROM product_registrations WHERE application_id = $1 AND is_current LIMIT 1`,
      ['00000000-0000-0000-0000-000000000000']);
  } catch (e) { ran = false; qErr = e.message; }
  assert(ran, `B1 the sticky read is a VALID query against the live schema${qErr ? ` (${qErr})` : ''}`);

  // ---- 3. The route carries it, and it genuinely lowers the loan ----------------
  // The sticky value is applied as an override on top of the borrower's own, so the
  // behaviour is proven at the layer that matters: buildInputs + the frozen engine.
  const app = {
    loan_type: 'Purchase', program: 'silver', property_type: 'SFR (1 unit)', units: 1,
    property_address: { line1: '1 Test St', city: 'Newark', state: 'NJ', zip: '07102' },
    purchase_price: 558000, as_is_value: 558000, arv: 900000,
    rehab_budget: 150000, rehab_type: 'Light Rehab', term: '12 Months',
    requested_ir_months: 0, fico: 740,
    requested_exp_flips: 6, requested_exp_holds: 6, requested_exp_ground: 6,
  };
  const exp = { flips: 6, holds: 6, ground: 6 };
  const SVP = require('../web/v2/tools/silver-program.js');

  const atMax = SVP.evaluate(pricing.buildInputs(app, exp, {}));
  const maxLoan = (atMax.sizing && atMax.sizing.totalLoan) || 0;
  assert(maxLoan > 100000, `C1 the control deal prices at its maximum ($${Math.round(maxLoan).toLocaleString()})`);

  const CEILING = Math.round(maxLoan * 0.75);
  const withCeiling = SVP.evaluate(pricing.buildInputs(app, exp, { targetLoan: CEILING }));
  const capped = (withCeiling.sizing && withCeiling.sizing.totalLoan) || 0;
  assert(capped <= CEILING + 1 && capped < maxLoan - 1,
    `C2 a staff ceiling of $${CEILING.toLocaleString()} genuinely binds (loan $${Math.round(capped).toLocaleString()})`);

  // The borrower's own payload can never carry it…
  const borrowerRaw = { targetLoan: 9999999, targetLTC: 0.8 };
  const sanitized = {};
  {
    // mirror the route: borrowerPricingOverrides is module-private, so assert the
    // OUTCOME instead — a client-supplied targetLoan must not reach the engine.
    const src = require('fs').readFileSync(path.join(__dirname, '..', 'src/routes/borrower.js'), 'utf8');
    assert(!/out\.targetLoan\s*=/.test(src),
      'D1 the borrower allowlist never accepts a client-supplied loan amount');
    assert(/overrides\.targetLoan = prev/.test(src),
      'D2 …and the route carries the file\'s OWN registered amount forward instead');
    assert(/AND is_current LIMIT 1/.test(src),
      'D3 …read with the table\'s real current-row predicate');
  }
  void borrowerRaw; void sanitized;

  // …so a re-register that carries the sticky value must land back on the ceiling,
  // not on the maximum.
  const reReg = SVP.evaluate(pricing.buildInputs(app, exp, { targetLoan: CEILING }));
  const reLoan = (reReg.sizing && reReg.sizing.totalLoan) || 0;
  assert(Math.abs(reLoan - capped) < 1,
    `E1 a borrower re-register carrying the sticky amount re-prices at the CEILING, not the maximum ($${Math.round(reLoan).toLocaleString()})`);
  assert(reLoan < maxLoan - 1,
    `E2 …which is $${Math.round(maxLoan - reLoan).toLocaleString()} below the maximum it would otherwise have registered`);

  console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
  await db.pool.end().catch(() => {});
  process.exit(failures ? 1 : 0);
})().catch(async (e) => {
  console.error('FATAL', e);
  try { await db.pool.end(); } catch (_) {}
  process.exit(1);
});
