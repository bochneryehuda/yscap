'use strict';
/**
 * PROOF of the PPE CANARY door's refusals — the endpoint that has been silently
 * dead TWICE.
 *
 * A canary prices a battery of scenarios through both engines and records where
 * they disagree. It is how the shadow engine earns trust before anything is
 * promoted. Its route has never been executed by any suite, and its own comments
 * record two separate occasions on which it was completely non-functional:
 *
 *   1. `scenarioMatrix.buildMatrix` returns `{scenarios, fullSize, truncated,
 *      stride}` — NOT an array. Taking it whole made the `Array.isArray` check
 *      below false, so EVERY matrix-shaped canary answered 400 "that produced no
 *      scenarios to price", and the endpoint's own size refusal was unreachable
 *      from that branch entirely.
 *   2. The engine names. `/quote` drives `facade.priceWithShadow`, whose engines
 *      are `priceLp` / `ourQuote`; the canary drives `runShadow`, whose engines
 *      are `ours` / `theirs`. Passing the facade's names made `runShadow` refuse
 *      outright, so every canary call 500'd.
 *
 * Both were found by READING and fixed. Neither is guarded, and a function that
 * has been dead twice is one somebody will make dead a third time. This suite
 * covers the half that can be proven without a database or a vendor — the
 * validation, which is where the first bug lived and where the endpoint's real
 * policy is.
 *
 * THE POLICY WORTH PINNING: a matrix too big to price is REFUSED, never thinned.
 * `buildMatrix` will happily STRIDE a huge matrix down to fit — take every Nth
 * scenario — and an agreement rate measured over scenarios nobody chose reads
 * cleaner than it is. That refusal is the one the first bug made unreachable.
 *
 * PURE: the handler is exported, and every case here returns before the route
 * needs a rate sheet, a database or an upstream call.
 */

const assert = require('assert');

let checks = 0;
const ok = (c, w) => { assert.ok(c, w); checks++; };
const eq = (a, b, w) => { assert.strictEqual(a, b, w); checks++; };

const ppe = require('../src/longterm/routes/ppe');
const { canaryRoute } = ppe.handlers;
const { MAX_CANARY_SCENARIOS } = ppe._internals;
const matrix = require('../src/longterm/ppe/scenario-matrix');

function fakeRes() {
  const out = { code: 200, body: null };
  return { status(c) { out.code = c; return this; }, json(b) { out.body = b; return this; }, out };
}
const post = async (body) => {
  const res = fakeRes();
  await canaryRoute({ body, query: {}, headers: {} }, res);
  return res.out;
};

async function main() {
  ok(MAX_CANARY_SCENARIOS > 0, `the endpoint declares a ceiling (${MAX_CANARY_SCENARIOS})`);

  // ── A. NEITHER SCENARIOS NOR A MATRIX ────────────────────────────────────
  {
    const r = await post({});
    eq(r.code, 400, 'a canary with neither scenarios nor a matrix is refused');
    ok(/scenarios/.test(r.body.error) && /matrix/.test(r.body.error),
      '…naming BOTH ways to ask, because "invalid request" leaves somebody guessing which one they meant');
  }

  // ── B. AN EMPTY BATTERY IS NOT A CANARY ──────────────────────────────────
  {
    const r = await post({ scenarios: [] });
    eq(r.code, 400, 'an explicitly empty scenario list is refused rather than run');
    ok(/no scenarios/i.test(r.body.error), '…saying so');
  }

  // ── C. THE ONE THAT MATTERS — A MATRIX IS UNWRAPPED, NOT TAKEN WHOLE ─────
  //
  // `buildMatrix` returns an OBJECT. If the route takes it whole, the array check
  // fails and this answers 400 "that produced no scenarios to price" — which is
  // exactly what it did, for every matrix-shaped canary, until the re-audit.
  //
  // A small matrix is used deliberately: it gets PAST validation, so the answer
  // proves the expansion was unwrapped. It then stops at the rate-sheet refusal,
  // which needs no database to reach.
  {
    const axes = { fico: [700, 720], ltv: [70, 75] };
    const expanded = matrix.buildMatrix(axes);
    eq(expanded.scenarios.length, 4, 'the matrix builder expands 2x2 to four scenarios');
    ok(!Array.isArray(expanded), '…and returns an OBJECT, which is the shape that caused the bug');

    const r = await post({ matrix: axes });
    ok(r.code !== 400 || !/no scenarios/i.test((r.body && r.body.error) || ''),
      'THE ONE THAT MATTERS: a matrix-shaped canary does NOT answer "that produced no scenarios to price" — taking the builder\'s object whole instead of its `.scenarios` is what made every matrix canary dead, and it read as correct');
    eq(r.code, 422,
      '…it gets past validation and stops at the rate-sheet refusal, which is how far this can be driven without a database');
    ok(/rate-sheet/i.test(r.body.error),
      '…and that refusal is the honest one: a canary with no program would price against a live upstream and record findings that say nothing about agreement');
  }

  // ── D. THE ONE THAT MATTERS — TOO BIG IS REFUSED, NEVER THINNED ─────────
  //
  // The refusal the first bug made unreachable. `buildMatrix` strides a large
  // matrix down to fit rather than failing, so without this the endpoint would
  // quietly measure agreement over every Nth scenario.
  {
    const huge = { fico: Array.from({ length: 40 }, (_, i) => 600 + i),
      ltv: Array.from({ length: 40 }, (_, i) => 50 + i) };
    const expanded = matrix.buildMatrix(huge);
    eq(expanded.fullSize, 1600, 'the matrix asks for 1,600 scenarios');
    eq(expanded.truncated, true, '…and the builder would happily STRIDE it down to fit');
    ok(expanded.scenarios.length <= MAX_CANARY_SCENARIOS, '…to the ceiling');

    const r = await post({ matrix: huge });
    eq(r.code, 422,
      'THE ONE THAT MATTERS: the endpoint REFUSES it rather than pricing the thinned battery — an agreement rate measured over scenarios nobody chose reads cleaner than it is');
    eq(r.body.asked, 1600, '…telling the caller what they actually asked for');
    eq(r.body.limit, MAX_CANARY_SCENARIOS, '…and the ceiling, so "narrow it" is actionable');
    ok(/refused rather than thinned/i.test(r.body.error), '…and saying why in words');
  }

  // ── E. AN EXPLICIT ARRAY OVER THE CEILING IS REFUSED THE SAME WAY ───────
  {
    const many = Array.from({ length: MAX_CANARY_SCENARIOS + 1 }, (_, i) => ({ fico: 700, _index: i }));
    const r = await post({ scenarios: many });
    eq(r.code, 422, 'sending too many scenarios outright is refused too — the ceiling is the endpoint\'s, not the matrix builder\'s');
    eq(r.body.asked, MAX_CANARY_SCENARIOS + 1, '…naming the count');
    eq(r.body.limit, MAX_CANARY_SCENARIOS, '…and the ceiling');
  }

  // ── F. A MATRIX THAT PRODUCES NOTHING, AND ONE THAT THROWS ──────────────
  //
  // These are two different failures and the route answers them differently. The
  // first draft of this section asserted `400 || 422` for one contrived input and
  // passed without touching the catch at all — removing the catch left it GREEN.
  // An assertion that accepts two answers proves neither.
  {
    // A malformed axis does NOT throw: the builder reports fullSize 0, so this is
    // the ordinary "you asked for nothing" path. This is the case a real caller
    // hits by sending an axis that is not a list.
    const r = await post({ matrix: { fico: 'not-a-list' } });
    eq(r.code, 400, 'an axis that is not a list expands to nothing, and nothing is refused');
    ok(/no scenarios/i.test(r.body.error), '…on the honest ground that it produced none, rather than a manufactured error');
  }
  {
    // The catch itself. A throwing getter is contrived — and it is the ONLY way to
    // reach that branch, which is worth saying rather than dressing up as a
    // realistic input. The branch matters because a builder failure must reach the
    // caller as THEIR bad request, not as our 500.
    const axes = Object.defineProperty({}, 'fico', {
      get() { throw new Error('axis blew up'); }, enumerable: true,
    });
    const r = await post({ matrix: axes });
    eq(r.code, 400, 'a matrix the builder THROWS on is answered 400, not 500 — the caller sent it and can fix it');
    ok(/could not be expanded/i.test(r.body.error), '…named as an expansion failure');
    ok(/axis blew up/.test(r.body.error), '…carrying the builder\'s own reason, which is the only clue to what was wrong with it');
  }

  console.log(`\n✓ lt ppe canary door (pure): ${checks} assertions passed`);
}

main().catch((e) => {
  console.error('✗ lt ppe canary door (pure) FAILED');
  console.error(e);
  process.exit(1);
});
