'use strict';
/**
 * PROOF of the three gates in front of the DSCR PRICER — the rule that PILOT
 * never hands back a price built from a request the pricing engine partly ignored.
 *
 * Seventh thread from the coverage sweep. `routes/dscr-pricer.js price` is the
 * door an officer's quote comes out of, and it had never executed in any suite —
 * including all three of its refusals. Each one exists for the same reason, said
 * three times in the route's own words: "…would be silently ignored, so the
 * request is rejected rather than mis-priced."
 *
 * WHY THAT MATTERS MORE THAN A NORMAL VALIDATION ERROR. A rejected request shows
 * somebody an error. A quietly-dropped field shows them a PRICE — a real-looking
 * rate, from a real lender, for a loan that is not the one they described. An
 * officer reads that number to a borrower. The failure has no symptom.
 *
 * THE THREE GATES, in the order the door applies them:
 *   1. A field we have not implemented → refused, and NAMED, with the supported
 *      list beside it so the caller can act. Not dropped.
 *   2. A scenario that does not validate (an incomplete or conflicting location,
 *      an unknown loan purpose) → refused BEFORE any upstream call. Asserted by
 *      counting calls: a refusal that had already spent a vendor request is a
 *      refusal that cost money.
 *   3. A supported field carrying a value the engine does not recognise → refused
 *      AFTER the call, because that is where the warning is discovered. The
 *      price is thrown away rather than returned.
 *
 * AND THE ONE THAT IS NOT A REFUSAL AT ALL: the door prices the ZIP-ENRICHED
 * scenario, never the one that was validated. Validating one request and sending
 * a different one upstream is the same silent-substitution failure wearing a
 * different hat, and it is checked by reading what the vendor was actually asked.
 *
 * PURE: the Lender Price client is replaced through require.cache before the route
 * is loaded, so nothing here reaches a vendor. No database, no HTTP server — the
 * handlers are exported and called directly.
 */

const assert = require('assert');

let checks = 0;
const ok = (c, w) => { assert.ok(c, w); checks++; };
const eq = (a, b, w) => { assert.strictEqual(a, b, w); checks++; };

// ── The vendor, replaced before the route is required ─────────────────────
const LP = require.resolve('../src/longterm/lenderprice/client');
const asked = [];
let nextResult = null;
const realLp = require(LP);
require.cache[LP] = {
  id: LP,
  filename: LP,
  loaded: true,
  exports: {
    ...realLp,
    price: async (sc) => {
      asked.push(sc);
      return nextResult;
    },
  },
};

const pricer = require('../src/longterm/routes/dscr-pricer');
const { price } = pricer.handlers;
const { REGISTRY_WARNINGS } = require('../src/longterm/lenderprice/search-model');

/** A minimal express-ish res that records what the handler answered. */
function fakeRes() {
  const out = { code: 200, body: null };
  return {
    status(c) { out.code = c; return this; },
    json(b) { out.body = b; return this; },
    out,
  };
}
const post = async (body) => {
  const res = fakeRes();
  await price({ body }, res);
  return res.out;
};

async function main() {
  // A scenario that passes every gate — the control everything below is a variant of.
  const GOOD = {
    purpose: 'Purchase', value: 500000, loan: 375000, fico: 760, dscr: 1.25,
    propertyType: 'SingleFamily', zip: '07036', state: 'NJ', county: 'Union',
    countyFps: '34039', prepayMonths: 60,
  };
  const okResult = (request = {}) => ({
    ok: true, raw: { results: {} }, request, searchKey: 'sk-1', provenance: null,
  });

  // ── A. THE CONTROL ────────────────────────────────────────────────────────
  // Without this every refusal below could be a broken fixture rather than a gate.
  {
    asked.length = 0;
    nextResult = okResult({ criteria: {}, property: {}, dynamicPropertiesMap: {} });
    const r = await post({ scenario: { ...GOOD } });
    eq(r.code, 200, 'a complete, valid scenario prices — so the refusals below are gates and not a broken fixture');
    eq(asked.length, 1, '…reaching the pricing engine exactly once');
    ok(r.body && r.body.ok === true, '…and comes back as an answer');
  }

  // ── B. GATE 1 — A FIELD WE HAVE NOT IMPLEMENTED IS NAMED, NOT DROPPED ─────
  {
    asked.length = 0;
    const r = await post({ scenario: { ...GOOD, secondLienBalloonRider: true } });
    eq(r.code, 422,
      'THE ONE THAT MATTERS: a field the pricer has not implemented is REFUSED — dropping it would return a real-looking rate for a loan nobody described, and an officer reads that number to a borrower');
    eq(r.body.error, 'unsupported_field', '…under a name a caller can branch on');
    ok((r.body.fields || []).includes('secondLienBalloonRider'),
      '…NAMING the field, because "invalid request" leaves somebody guessing which of twenty they got wrong');
    ok(/Supported:/.test(r.body.message || ''), '…and listing what IS supported, so the answer is actionable');
    eq(asked.length, 0, '…having spent NOTHING upstream — a refusal that already paid for a vendor request is not a refusal');
  }

  // The meta fields around the scenario are NOT scenario fields and must not be
  // refused as unknown ones — a gate that rejects `debug` would make the diagnostic
  // route unusable and push somebody towards turning the gate off.
  {
    asked.length = 0;
    nextResult = okResult({ criteria: {}, property: {}, dynamicPropertiesMap: {} });
    const r = await post({ scenario: { ...GOOD }, debug: false, full: false });
    eq(r.code, 200, 'the envelope fields around the scenario are not mistaken for unknown scenario fields');
  }

  // ── C. GATE 2 — AN INVALID SCENARIO NEVER REACHES THE VENDOR ─────────────
  {
    asked.length = 0;
    const r = await post({ scenario: { ...GOOD, purpose: 'SomethingElse' } });
    eq(r.code, 422,
      'THE ONE THAT MATTERS: an unknown loan purpose is REFUSED rather than defaulted — silently pricing a cash-out as a refinance is the whole class of failure this door exists to stop');
    eq(asked.length, 0, '…before any upstream call');
    ok(r.body && r.body.error, '…with a reason attached');
  }
  {
    asked.length = 0;
    const r = await post({ scenario: { ...GOOD, zip: '', state: '', county: '', countyFps: '' } });
    eq(r.code, 422, 'a scenario with no location at all is refused — price varies by county, so a missing one is not a detail');
    eq(asked.length, 0, '…and again costs nothing upstream');
  }

  // ── D. GATE 3 — A RECOGNISED FIELD WITH AN UNRECOGNISED VALUE ────────────
  // This gate fires AFTER the call, because the warning is discovered while the
  // request is built. The point is that the price is THROWN AWAY rather than
  // returned: the engine accepted the field and ignored the value, so the number
  // that came back is for a different loan.
  {
    asked.length = 0;
    const built = { criteria: {}, property: {}, dynamicPropertiesMap: {} };
    built[REGISTRY_WARNINGS] = [{ field: 'incomeDocType', value: 'Vibes', reason: 'not a known token' }];
    nextResult = okResult(built);
    const r = await post({ scenario: { ...GOOD } });
    eq(asked.length, 1, 'the request did reach the engine, because this warning is only discovered as it is built');
    eq(r.code, 422,
      'THE ONE THAT MATTERS: …and the price that came back is THROWN AWAY — the engine accepted the field and ignored the value, so that number is for a different loan');
    eq(r.body.error, 'invalid_field_value', '…under its own name');
    ok((r.body.warnings || []).length === 1, '…carrying the warning itself');
    ok(/incomeDocType/.test(r.body.message || ''), '…and naming the field in the sentence a human reads');
  }

  // ── E. NOT A REFUSAL: WHAT IS VALIDATED IS WHAT IS SENT ──────────────────
  // `validateScenario` fills a caller's location in from their ZIP. The door must
  // price the ENRICHED scenario — pricing the original would validate one request
  // and send a different, county-less one upstream, which is the same silent
  // substitution the three gates above exist to prevent.
  {
    asked.length = 0;
    nextResult = okResult({ criteria: {}, property: {}, dynamicPropertiesMap: {} });
    const bare = { ...GOOD };
    delete bare.county;
    delete bare.countyFps;
    delete bare.state;
    const r = await post({ scenario: bare });
    // Asserted flatly rather than behind an `if`. The first draft accepted EITHER
    // road — enriched, or refused for an unresolvable ZIP — and a suite that
    // accepts either answer proves neither. 07036 resolves on this build (state
    // NJ, county FIPS 34039, measured), so that is what is asserted; the day it
    // stops resolving this should go red and say so rather than quietly switching
    // to proving the other thing.
    eq(r.code, 200, 'a scenario carrying only a ZIP is accepted, its location filled in from that ZIP');
    eq(asked.length, 1, '…and priced exactly once');
    const sent = asked[0] || {};
    eq(sent.state, 'NJ',
      'THE ONE THAT MATTERS: what reaches the engine is the ENRICHED scenario — validating one request and sending a different, county-less one upstream is the same silent substitution wearing a different hat');
    eq(sent.countyFps, '34039', '…county included, which is what price actually varies by');
    ok(r.body.requestedScenario && !r.body.requestedScenario.state,
      '…while `requestedScenario` still reports what the CALLER sent, so the two can be compared rather than agreeing by construction');
  }

  // ── F. AN UPSTREAM FAILURE IS NOT A PRICE ────────────────────────────────
  {
    asked.length = 0;
    nextResult = { ok: false, http: 503, error: 'upstream_down' };
    const r = await post({ scenario: { ...GOOD } });
    eq(r.code, 502, 'a pricing engine that is down reads as a bad GATEWAY, not as a bad request — the caller did nothing wrong and a 400 would send them to fix their scenario');
    ok(r.body && r.body.ok !== true, '…and is never dressed up as an answer');
  }
  {
    asked.length = 0;
    nextResult = { ok: false, http: 400, error: 'bad_request' };
    const r = await post({ scenario: { ...GOOD } });
    eq(r.code, 400, 'while a 4xx from the engine stays the caller\'s to fix');
  }

  console.log(`\n✓ lt dscr pricer refusals (pure): ${checks} assertions passed`);
}

main().catch((e) => {
  console.error('✗ lt dscr pricer refusals (pure) FAILED');
  console.error(e);
  process.exit(1);
});
