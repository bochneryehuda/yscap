'use strict';
/**
 * DB test — registering a product WRITES the rehab scope onto the loan file.
 *
 *   DATABASE_URL=postgres://… node scripts/test-rehab-type-register-db.js
 *
 * Owner-reported 2026-07-27: the Term Sheet Studio makes you state the rehab
 * scope, but after registering on Products & Pricing the loan application screen
 * still showed nothing for Rehab type. persistProductRegistration wrote back the
 * rehab BUDGET and never the TYPE. Proves, against a real Postgres:
 *   1. A file with a blank rehab type gets the registered scope written onto it
 *      (and it survives on the row every consumer reads).
 *   2. Re-registering the same light scope leaves a borrower's "Cosmetic" alone
 *      — the lossy label is never flattened to "Moderate".
 *   3. A REAL scope change in the studio moves the file, and stale square
 *      footage is nulled with it so the next quote doesn't re-price it as an
 *      addition.
 *   4. A bridge deal (no rehab) is never stamped with a scope.
 */
const R = require('path').resolve(__dirname, '..');

(async () => {
  if (!process.env.DATABASE_URL) { console.log('  ~~ SKIP rehab-type register DB test (no DATABASE_URL)'); return; }
  const db = require(R + '/src/db');
  const pricing = require(R + '/src/lib/pricing');
  const { persistProductRegistration } = require(R + '/src/lib/product-registration');
  let pass = 0, fail = 0;
  const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
  const rnd = () => 'rehabtype' + Math.random() + '@e.com';

  // A file shaped like a real fix & flip so the frozen engine sizes a loan.
  async function mkApp(extra) {
    const b = await db.query(`INSERT INTO borrowers(first_name,last_name,email,fico) VALUES('R','T',$1,720) RETURNING id`, [rnd()]);
    const cols = Object.assign({
      program: 'Fix & Flip w/ Construction', loan_type: 'Purchase', property_type: 'SFR', units: 1,
      purchase_price: 400000, as_is_value: 400000, arv: 700000, rehab_budget: 120000, term: '12 Months',
      property_address: JSON.stringify({ line1: '12 Churchill Lane', city: 'Lakewood', state: 'NJ', zip: '08701' }),
      requested_exp_flips: 3,
    }, extra || {});
    const keys = Object.keys(cols);
    const a = await db.query(
      `INSERT INTO applications(borrower_id,${keys.join(',')})
       VALUES ($1,${keys.map((_, i) => '$' + (i + 2)).join(',')}) RETURNING id`,
      [b.rows[0].id, ...keys.map((k) => cols[k])]);
    return a.rows[0].id;
  }
  const fileRow = async (id) => (await db.query(
    `SELECT rehab_type, sqft_pre, sqft_post, rehab_budget FROM applications WHERE id=$1`, [id])).rows[0];

  // Register the way the routes do: buildInputs(file, exp, studio overrides) →
  // quoteProgram → persistProductRegistration inside a transaction. (The routes'
  // own loadFileForPricing adds the co-borrower FICO/track-record roll-up, which
  // these single-borrower fixtures don't exercise.)
  async function register(appId, overrides) {
    const f = (await db.query(
      `SELECT a.*, b.fico AS fico FROM applications a JOIN borrowers b ON b.id=a.borrower_id WHERE a.id=$1`,
      [appId])).rows[0];
    const exp = { flips: f.requested_exp_flips || 0, holds: f.requested_exp_holds || 0, ground: f.requested_exp_ground || 0 };
    const inputs = pricing.buildInputs(f, exp, overrides || {});
    const quote = pricing.quoteProgram('standard', inputs);
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      const reg = await persistProductRegistration(client, {
        appId, program: 'standard', inputs, quote, registeredByStaffId: null, isManual: false,
      });
      await client.query('COMMIT');
      return { reg, inputs, quote };
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }

  if (!pricing.enginesReady()) {
    console.log('  ~~ SKIP rehab-type register DB test (pricing engines unavailable):', pricing.loadErr());
    return;
  }

  // ---- 1. THE BUG: a blank rehab type is filled by the registration ----
  let app = await mkApp({});
  ok((await fileRow(app)).rehab_type == null, 'setup: the file starts with no rehab type');
  let r = await register(app, {});
  ok(r.quote.sizing.totalLoan > 0, 'setup: the scenario sized a loan');
  let row = await fileRow(app);
  ok(row.rehab_type === 'Moderate', 'FIX: registering a light/moderate scope fills the blank Rehab type (was left empty)');

  // The written label is one the pricing engine and ClickUp both understand.
  ok(pricing.buildInputs({ rehab_type: row.rehab_type }).heavyRehab === false,
    'the written label round-trips through buildInputs as a light rehab');

  // ---- 1b. the studio's HEAVY choice lands on a blank file ----
  app = await mkApp({});
  await register(app, { heavyRehab: true });
  ok((await fileRow(app)).rehab_type === 'Heavy / gut rehab', 'the studio Heavy scope lands on the file');

  // ---- 1c. the expansion checkbox lands on a blank file ----
  app = await mkApp({});
  await register(app, { sqftAddition: true });
  ok((await fileRow(app)).rehab_type === 'Adding square footage', 'the "adding square footage" choice lands on the file');

  // ---- 2. a borrower's more specific label is NEVER flattened ----
  app = await mkApp({ rehab_type: 'Cosmetic' });
  await register(app, {});
  ok((await fileRow(app)).rehab_type === 'Cosmetic',
    'KEY: re-registering the same light scope keeps "Cosmetic" (never rewritten to "Moderate")');
  // …and a no-op re-register leaves the fresh registration usable (not stale).
  const st = await db.query(
    `SELECT stale FROM product_registrations WHERE application_id=$1 AND is_current`, [app]);
  ok(st.rows[0] && st.rows[0].stale === false, 'the registration it just wrote is not left flagged stale');

  // ---- 3. a REAL scope change moves the file, and takes stale sq ft with it ----
  app = await mkApp({ rehab_type: 'Adding square footage', sqft_pre: 1000, sqft_post: 2000 });
  await register(app, { heavyRehab: true, sqftAddition: false });
  row = await fileRow(app);
  ok(row.rehab_type === 'Heavy / gut rehab', 'un-checking the expansion moves the file off "Adding square footage"');
  ok(row.sqft_pre == null && row.sqft_post == null, 'and the now-irrelevant square footage is nulled with it');
  ok(pricing.buildInputs({ rehab_type: row.rehab_type, sqft_pre: row.sqft_pre, sqft_post: row.sqft_post }).sqftAddition === false,
    'so the next quote no longer prices it as an addition');

  // ---- 3b. escalating scope on a cosmetic file ----
  app = await mkApp({ rehab_type: 'Cosmetic' });
  await register(app, { heavyRehab: true });
  ok((await fileRow(app)).rehab_type === 'Heavy / gut rehab', 'escalating to Heavy in the studio moves the file');

  // ---- 4. a deal with no rehab is never stamped ----
  app = await mkApp({ program: 'Bridge', rehab_budget: 0, arv: null });
  await register(app, {});
  ok((await fileRow(app)).rehab_type == null, 'a bridge deal is never stamped with a rehab scope');

  // A ground-up file records its own scope.
  app = await mkApp({ program: 'Ground-Up Construction', rehab_budget: 300000 });
  await register(app, {});
  ok((await fileRow(app)).rehab_type === 'Ground-up construction', 'a ground-up registration records Ground-up construction');

  console.log(`  rehab-type register DB: ${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})().then(() => process.exit(process.exitCode || 0))
  .catch((e) => { console.error('rehab-type register DB test error:', e); process.exit(1); });
