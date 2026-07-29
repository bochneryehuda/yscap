'use strict';
/**
 * #203 — pure tests for the whole-loan context completeness scorer. Proves:
 *   • a fully-populated context → ready, status 'complete', score high, no gaps;
 *   • a missing REQUIRED key → not ready, status 'insufficient', that key in
 *     requiredMissing + a gap, and the score is HARD-CAPPED (never "80% complete");
 *   • FICO provenance is surfaced (present + source, or a named gap when absent);
 *   • liquidity provenance: supplied+shortfall 0 → satisfied; absent → not supplied;
 *   • provenance rollup counts sources (api_verification / document / appraisal);
 *   • discrepancy count passes through; it gates/ blocks NOTHING (advisory);
 *   • hostile input never throws → a safe insufficient default.
 */
const assert = require('assert');
const cc = require('../src/lib/underwriting/context-completeness');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// build an assembleContext-shaped object
function field(value, source, confidence) {
  return { value, governingSource: source || null, confidence: confidence || 'high', sourceId: null, sourceVersion: null };
}
function ctx(over = {}) {
  const fields = Object.assign({
    program: field('gold', 'registration', 'definite'),
    loan_amount: field(300000, 'registration', 'definite'),
    fico: field(720, 'document', 'high'),
    as_is_value: field(250000, 'appraisal', 'high'),
    arv: field(400000, 'appraisal', 'high'),
  }, over.fields || {});
  return Object.assign({
    applicationId: 'a1',
    fields,
    values: {},
    discrepancies: over.discrepancies || [],
    missingRequired: over.missingRequired || [],
    registration: { present: true },
    liquidity: over.liquidity !== undefined ? over.liquidity : { required: 50000, verified: 60000, shortfall: 0 },
    ready: over.ready !== undefined ? over.ready : true,
  }, over.top || {});
}

// 1. fully-populated → complete.
{
  const r = cc.completenessReport(ctx());
  assert.strictEqual(r.ready, true);
  assert.strictEqual(r.status, 'complete', 'all criticals present + no required missing');
  assert.deepStrictEqual(r.gaps, [], 'no gaps when every critical is present');
  assert.ok(r.score > 0.9, 'a complete file scores high');
  assert.strictEqual(r.coverage.present, 5);
  ok('a fully-populated context → ready, complete, high score, no gaps');
}

// 2. a missing REQUIRED key hard-caps the score and flags insufficient.
{
  const r = cc.completenessReport(ctx({
    fields: { loan_amount: field(null, null) },
    missingRequired: ['loan_amount'],
    ready: false,
  }));
  assert.strictEqual(r.ready, false);
  assert.strictEqual(r.status, 'insufficient', 'a missing required key is never merely partial');
  assert.deepStrictEqual(r.requiredMissing, ['loan_amount']);
  assert.ok(r.score <= 0.5, 'a missing required key hard-caps the score (never "80% complete")');
  assert.ok(r.gaps.some((g) => g.key === 'loan_amount'), 'the missing required key is a named gap');
  ok('a missing required key → not ready, insufficient, score hard-capped, gap listed');
}

// 3. FICO provenance surfaced.
{
  const present = cc.completenessReport(ctx());
  assert.strictEqual(present.fico.present, true);
  assert.strictEqual(present.fico.source, 'document', 'FICO provenance names its source');

  const absent = cc.completenessReport(ctx({ fields: { fico: field(null, null) } }));
  assert.strictEqual(absent.fico.present, false);
  assert.ok(absent.gaps.some((g) => g.key === 'fico' && /credit/i.test(g.source)), 'absent FICO becomes a gap naming where to get it');
  ok('FICO provenance is surfaced; a missing FICO is a named gap');
}

// 4. liquidity provenance.
{
  const satisfied = cc.completenessReport(ctx());
  assert.strictEqual(satisfied.liquidity.supplied, true);
  assert.strictEqual(satisfied.liquidity.satisfied, true, 'shortfall 0 → satisfied');

  const shortfall = cc.completenessReport(ctx({ liquidity: { required: 50000, verified: 30000, shortfall: 20000 } }));
  assert.strictEqual(shortfall.liquidity.satisfied, false, 'a shortfall is not satisfied');
  assert.strictEqual(shortfall.liquidity.shortfall, 20000);

  const none = cc.completenessReport(ctx({ liquidity: null }));
  assert.strictEqual(none.liquidity.supplied, false, 'no liquidity block → not supplied');
  ok('liquidity provenance: supplied+shortfall 0 → satisfied; absent → not supplied');
}

// 5. provenance rollup counts distinct sources incl. api_verification.
{
  const r = cc.completenessReport(ctx({
    fields: { arv: field(400000, 'api_verification', 'high') }, // ATTOM/HouseCanary-backed
  }));
  assert.ok(r.provenance.apiVerified >= 1, 'an api_verification fact is counted');
  assert.ok(r.provenance.distinctSources >= 2, 'multiple distinct sources counted');
  assert.ok(r.provenance.documentBacked >= 1, 'appraisal/document facts counted');
  ok('provenance rollup counts api_verification / document / appraisal sources');
}

// 6. discrepancy count passes through; advisory only.
{
  const r = cc.completenessReport(ctx({ discrepancies: [{ field: 'arv' }, { field: 'as_is_value' }] }));
  assert.strictEqual(r.discrepancyCount, 2);
  // advisory: the report never returns a "block" — no such field exists; it's a report.
  assert.ok(!('block' in r) && !('blocks' in r), 'the completeness report never blocks — advisory only');
  ok('discrepancy count passes through; the report is advisory (never blocks)');
}

// 7. hostile input never throws → safe insufficient default.
{
  for (const bad of [null, undefined, 42, 'x', {}, { fields: 7 }, { fields: null }]) {
    assert.doesNotThrow(() => cc.completenessReport(bad));
    const r = cc.completenessReport(bad);
    assert.strictEqual(r.status, 'insufficient');
    assert.strictEqual(r.ready, false);
    assert.strictEqual(r.score, 0);
  }
  ok('hostile input never throws; degrades to a safe insufficient default');
}

console.log(`\ncontext-completeness pure — ${passed} checks passed`);
