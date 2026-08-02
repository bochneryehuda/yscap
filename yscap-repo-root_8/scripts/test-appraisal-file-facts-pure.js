/**
 * THE FACTS THE APPRAISAL PUTS ON THE FILE (db/403, owner-directed 2026-08-02).
 *
 * The owner, reading the Appraisal page's data comparison: "Occupancy / Year built / Living area /
 * Market rent (1007) / Seller … all these things that he's getting from the appraisal, [our file
 * has] nothing to compare. Please add this field in our file and that field should automatically be
 * tabulated once you import the XML of the appraisal … we have a seller's name on file, so we can
 * do stuff with it to make sure it matches other documentation."
 *
 * Pure — no database, no network. Covers:
 *   1. the market-rent resolution (subject figure first, then the per-unit rent schedule);
 *   2. the import's file fill: blank-only, and OCCUPANCY IS NEVER WRITTEN;
 *   3. the fact registry now reads all four off the loan file (no more "nothing to compare");
 *   4. the three read-only facts are shown but never raise a finding;
 *   5. the file's seller becomes the value of record the other documents tie out against — and on a
 *      wholesale deal a flipper-role contract is still judged against the flipper, not against it.
 */
const assert = require('assert');

const { _internals: { marketMonthlyRent, fillFileFacts } } = require('../src/lib/appraisal/import');
const { FACT_BY_KEY } = require('../src/lib/underwriting/facts');
const { buildTieout } = require('../src/lib/underwriting/tieout');

let n = 0;
const ok = (cond, msg) => { n++; assert.ok(cond, msg); };

// A recording stub for `db`: every statement is captured instead of executed.
function stubDb() {
  const sql = [];
  return { sql, query: async (text, params) => { sql.push({ text, params }); return { rowCount: 1, rows: [] }; } };
}

const ADDR = { line1: '148 Plymouth St', city: 'New Haven', state: 'CT', zip: '06511' };

(async () => {
  // ===== 1. Market rent — the subject's own figure first, then the rent schedule ================
  ok(marketMonthlyRent({ enrich: { est_market_monthly_rent: 4400 }, units: [] }) === 4400,
    'a 1004 + 1007 states the market rent on the subject — that figure is used');
  ok(marketMonthlyRent({ enrich: {}, units: [{ marketRent: 1200 }, { marketRent: 1300 }] }) === 2500,
    'a 1025 rent schedule with no subject figure sums the per-unit market rents');
  ok(marketMonthlyRent({ enrich: { est_market_monthly_rent: 4400 }, units: [{ marketRent: 1200 }] }) === 4400,
    'the subject figure WINS over the schedule — one resolution, never two answers');
  ok(marketMonthlyRent({ enrich: {}, units: [] }) === null, 'an appraisal that states neither gives null');
  ok(marketMonthlyRent({ enrich: { est_market_monthly_rent: 0 }, units: [{ marketRent: 0 }] }) === null,
    'a zero is an empty schedule, not a property that rents for nothing');

  // ===== 2. The import fill — blank-only, and never occupancy ===================================
  {
    const db = stubDb();
    await fillFileFacts(db, 'app-1', {
      subject: { yearBuilt: '1982', gla: 1686 },
      enrich: { owner_of_record: 'Angela T Morton', est_market_monthly_rent: 4400, occupancy_status: 'OwnerOccupied' },
      units: [],
    });
    const all = db.sql.map((q) => q.text).join('\n');
    ok(/SET seller_name = \$2/.test(all), 'the seller goes onto the file');
    ok(/SET year_built = \$2/.test(all), 'the year built goes onto the file');
    ok(/SET living_area_sqft = \$2/.test(all), 'the living area goes onto the file');
    ok(/SET market_rent = \$2/.test(all), 'the market rent goes onto the file');

    // THE OWNER'S ONE EXCLUSION: "the one thing you shouldn't import is if the appraisal says owner
    // occupied … he's purchasing it from the seller who is now owner occupied and it's going to be
    // an investment — so the occupancy, skip."
    ok(!/occupancy/i.test(all), 'OCCUPANCY IS NEVER WRITTEN onto the file by the appraisal import');

    assert.deepStrictEqual(db.sql.map((q) => q.params[1]), ['Angela T Morton', 1982, 1686, 4400],
      'the values are the appraisal’s, typed for their columns');
    n++;
    ok(db.sql.every((q) => /IS NULL/.test(q.text)),
      'every fill is blank-only — a value already on the file is never overwritten');
  }
  {
    // Nothing stated → nothing written. A silent appraisal must not blank the file or write junk.
    const db = stubDb();
    await fillFileFacts(db, 'app-2', { subject: {}, enrich: {}, units: [] });
    ok(db.sql.length === 0, 'an appraisal that states none of them writes nothing at all');
  }
  {
    // A garbage GLA can never reach an int4 column (the parser bounds it; this is the second belt).
    const db = stubDb();
    await fillFileFacts(db, 'app-3', { subject: { gla: 9e12, yearBuilt: null }, enrich: {}, units: [] });
    ok(db.sql.length === 0, 'an out-of-range living area is dropped rather than overflowing the column');
  }

  // ===== 3. The fact registry reads all four off the loan file ==================================
  {
    const ctx = { app: { seller_name: 'Angela T Morton', year_built: 1982, living_area_sqft: 1686, market_rent: 4400 } };
    for (const key of ['seller_name', 'year_built', 'living_area', 'market_rent']) {
      ok(FACT_BY_KEY[key].file(ctx) != null, `${key} now has a loan-file value — no more "nothing to compare"`);
      ok(FACT_BY_KEY[key].file({}) == null, `${key} still answers null on a file that has none`);
    }
  }

  // ===== 4. The read-only facts are shown, never flagged ========================================
  {
    // The file disagrees with the appraisal on all three (a human corrected the file, or a revised
    // appraisal came in). They must SHOW the difference and raise nothing: the owner's rule is that
    // these are never a requirement and never something to answer.
    const ctx = { app: { property_address: ADDR, year_built: 1982, living_area_sqft: 1686, market_rent: 4400 } };
    const r = buildTieout(ctx, [{
      id: 'a', docType: 'appraisal',
      fields: { propertyAddress: ADDR, yearBuilt: 1975, gla: 1200, marketRent: 3000 },
    }]);
    for (const key of ['year_built', 'living_area', 'market_rent']) {
      const row = r.matrix.find((m) => m.key === key);
      ok(row && row.fileValue != null, `${key} shows the loan file's value in the matrix`);
      ok(row.cells.find((c) => c.source === 'a').status === 'disagree', `${key} still SHOWS the difference`);
      ok(!r.discrepancies.some((d) => d.field === key), `${key} never raises a finding — it is a read, not a to-do`);
    }
  }

  // ===== 5. The seller on file is the value of record the other documents tie out against =======
  {
    const ctx = { app: { property_address: ADDR, seller_name: 'Angela T Morton' } };
    const same = buildTieout(ctx, [{ id: 'c', docType: 'purchase_contract', fields: { sellerNames: ['Angela T. Morton'] } }]);
    ok(!same.discrepancies.some((d) => d.field === 'seller_name'), 'a contract naming the file’s seller raises nothing');
    ok(same.matrix.find((m) => m.key === 'seller_name').cells.find((c) => c.source === 'c').status === 'agree',
      'and the matrix says the two agree');

    // A contract naming somebody else is the catch the owner asked for ("so we can do stuff with it
    // to make sure it matches other documentation").
    const diff = buildTieout(ctx, [{ id: 'c', docType: 'purchase_contract', fields: { sellerNames: ['Somebody Else'] } }]);
    const d = diff.discrepancies.find((x) => x.field === 'seller_name');
    ok(d && d.severity === 'fatal', 'a contract naming a different seller is caught against the file');
    ok(d.fileValue === 'Angela T Morton', 'and the finding quotes the file’s seller as the value of record');
  }

  // ===== 5b. …but a WHOLESALE deal's flipper is still judged against the flipper ================
  // On an assignment the contract's "seller" IS the wholesaler in the middle — comparing them to the
  // file's ORIGINAL seller compares two different bodies and could only ever produce a nonsense
  // fatal on a perfectly ordinary deal. The chain says which seller each document speaks to, and
  // the file value must not override that.
  {
    const ctx = {
      app: { property_address: ADDR, seller_name: 'Angela T Morton', is_assignment: true, underlying_contract_price: 400000 },
      vestingName: 'End Buyer LLC',
    };
    const r = buildTieout(ctx, [
      // The public record: Angela is the owner — the ORIGINAL seller.
      { id: 't', docType: 'title', fields: { propertyAddress: ADDR, vestedOwners: ['Angela T Morton'] } },
      // The underlying contract: Angela sells to the wholesaler at the seller price.
      { id: 'c1', docType: 'purchase_contract', fields: { sellerNames: ['Angela T Morton'], buyerName: 'Wholesale Partners LLC', purchasePrice: 400000 } },
      // The flip contract: the wholesaler sells on to us. Its "seller" is the wholesaler, not Angela.
      { id: 'c2', docType: 'purchase_contract', fields: { sellerNames: ['Wholesale Partners LLC'], buyerName: 'End Buyer LLC', purchasePrice: 430000 } },
    ]);
    const row = r.matrix.find((m) => m.key === 'seller_name');
    ok(row.cells.find((c) => c.source === 'c2').status !== 'disagree',
      'the flip contract is measured against the WHOLESALER, never against the file’s original seller');
    const bad = r.discrepancies.find((x) => x.field === 'seller_name');
    ok(!bad || !/Wholesale Partners/.test(String(bad.docValue || '')),
      'an ordinary wholesale deal raises no seller fatal just because the file now carries a seller');
  }

  console.log(`PASS test-appraisal-file-facts-pure (${n} assertions)`);
})().catch((e) => { console.error('FAIL', e && e.message); process.exit(1); });
