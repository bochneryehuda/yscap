'use strict';
/*
 * Regression (live 400, 2026-07-26): the Encompass pipeline SEARCH refuses a
 * COMPLEX filter that carries an `operator` alongside a SINGLE term —
 *   "queryContract.filter: If only one filter term is supplied in the list
 *    'Terms', 'Operator' does not apply."
 * The by-loan-number lookup built exactly that shape ({operator:'and', terms:[one]}),
 * so a file WITH a loan number showed as "No Encompass loan is linked to this file yet".
 *
 * Proves — with NO network and NO DB (global.fetch mocked, the POST body captured):
 *   (1) client.findLoanByLoanNumber sends a VALID single-term filter with NO
 *       `operator` (simple form), matchType PascalCase 'Exact' (the tenant's
 *       proven casing, cf. MATCH_ALL_FILTER 'GreaterThan').
 *   (2) pipelineSearch STRIPS `operator` from a single-term COMPLEX filter (the
 *       chokepoint guard, so no future caller can reintroduce the 400).
 *   (3) ...but KEEPS `operator` when 2+ terms are supplied (operator is valid there).
 *   (4) the READ-ONLY export surface is untouched by the fix.
 *
 * A read-shaped body normalization only — no write path, same allowlisted endpoint.
 */
const assert = require('assert');

process.env.ENCOMPASS_CLIENT_ID = process.env.ENCOMPASS_CLIENT_ID || 'test-client';
process.env.ENCOMPASS_CLIENT_SECRET = process.env.ENCOMPASS_CLIENT_SECRET || 'test-secret';
process.env.ENCOMPASS_INSTANCE_ID = process.env.ENCOMPASS_INSTANCE_ID || 'TESTINSTANCE';
process.env.ENCOMPASS_API_BASE = 'https://api.elliemae.example';

delete require.cache[require.resolve('../src/config')];
delete require.cache[require.resolve('../src/lib/integrations/encompass')];
delete require.cache[require.resolve('../src/encompass/client')];

const encompass = require('../src/lib/integrations/encompass');
const client = require('../src/encompass/client');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// Capture every pipeline-search request body; fake the token + a one-loan result.
const bodies = [];
const realFetch = global.fetch;
global.fetch = async (url, init) => {
  const method = (init && init.method) || 'GET';
  const u = String(url);
  if (u.endsWith('/oauth2/v1/token')) {
    return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.includes('/encompass/v3/loanPipeline')) {
    let parsed = null; try { parsed = JSON.parse(init && init.body); } catch (_) { /* ignore */ }
    bodies.push({ method, body: parsed });
    return new Response(JSON.stringify([{ loanGuid: 'g1', 'Loan.LoanNumber': '12345' }]), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};

(async () => {
  try {
    // (1) The by-loan-number lookup sends a valid single-term filter, no operator.
    bodies.length = 0;
    const hits = await client.findLoanByLoanNumber('12345');
    assert.ok(Array.isArray(hits) && hits.length === 1, 'returns the matched loan');
    const b1 = (bodies.find((x) => x.method === 'POST') || {}).body;
    assert.ok(b1 && b1.filter, 'a filter was sent on the by-loan-number search');
    assert.ok(!('operator' in b1.filter), 'NO operator on the single-term by-loan-number filter');
    // Simple form: canonicalName at the filter root, no terms array.
    assert.ok(!Array.isArray(b1.filter.terms), 'by-loan-number filter uses the simple (no-terms-list) form');
    assert.strictEqual(b1.filter.canonicalName, 'Loan.LoanNumber');
    assert.strictEqual(b1.filter.value, '12345');
    assert.strictEqual(b1.filter.matchType, 'Exact', 'matchType is PascalCase Exact');
    ok('findLoanByLoanNumber sends a valid single-term filter with no operator');

    // (2) Chokepoint: a single-term COMPLEX filter has its operator stripped.
    bodies.length = 0;
    await encompass.pipelineSearch({
      filter: { operator: 'and', terms: [{ canonicalName: 'Loan.LoanNumber', value: 'Z', matchType: 'Exact' }] },
      fields: ['Loan.Guid'],
    });
    const b2 = bodies[0].body;
    assert.ok(b2.filter && Array.isArray(b2.filter.terms) && b2.filter.terms.length === 1, 'single-term list preserved');
    assert.ok(!('operator' in b2.filter), 'operator STRIPPED from a single-term complex filter');
    ok('pipelineSearch strips operator from a single-term complex filter');

    // (3) Chokepoint: 2+ terms KEEP the operator (operator is valid there).
    bodies.length = 0;
    await encompass.pipelineSearch({
      filter: { operator: 'or', terms: [
        { canonicalName: 'Loan.LoanNumber', value: 'A', matchType: 'Exact' },
        { canonicalName: 'Loan.LoanNumber', value: 'B', matchType: 'Exact' },
      ] },
      fields: ['Loan.Guid'],
    });
    const b3 = bodies[0].body;
    assert.strictEqual(b3.filter.operator, 'or', 'operator KEPT with 2+ terms');
    assert.strictEqual(b3.filter.terms.length, 2);
    ok('pipelineSearch keeps operator when 2+ terms are supplied');

    // (4) The READ-ONLY export surface is unchanged by the fix.
    assert.deepStrictEqual(
      Object.keys(encompass).sort(),
      ['READ_ONLY', 'apiGet', 'configured', 'fieldReader', 'name', 'ping', 'pipelineSearch'],
    );
    assert.strictEqual(encompass.READ_ONLY, true);
    ok('read-only export surface unchanged');

    console.log(`\nEncompass pipeline filter — ${passed} checks passed`);
  } catch (e) {
    console.error('FAIL test-encompass-pipeline-filter:', e && e.stack ? e.stack : e);
    process.exitCode = 1;
  } finally {
    global.fetch = realFetch;
  }
})();
