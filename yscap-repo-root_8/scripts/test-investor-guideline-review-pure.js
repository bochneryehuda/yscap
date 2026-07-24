'use strict';
/**
 * Pure tests for investor-guideline-review.js — the deterministic note-buyer rule engine
 * that folds investor-guideline findings into the one whole-loan finding registry.
 */
const assert = require('assert');
const g = require('../src/lib/underwriting/investor-guideline-review');

let n = 0;
const ok = (name) => { n++; console.log('  ok -', name); };
const codes = (findings) => findings.map((f) => f.code).sort();
const byCode = (findings, code) => findings.find((f) => f.code === code);

console.log('investor-guideline-review pure tests');

// 1 — Blue Lake escalation triggers fire on the right data; each is fatal + escalates.
{
  const f = g.review({ note_buyer: 'Blue Lake', property_state: 'NY', loan_amount: 2_000_000, is_assignment: true, rehab_budget: 300_000, as_is_value: 200_000 });
  const c = codes(f);
  for (const code of ['isg_bl_ny_loan', 'isg_bl_loan_over_1_5m', 'isg_bl_assignment', 'isg_bl_rehab_over_250k', 'isg_bl_rehab_over_as_is']) {
    assert.ok(c.includes(code), `expected ${code}`);
  }
  const ny = byCode(f, 'isg_bl_ny_loan');
  assert.strictEqual(ny.severity, 'fatal');
  assert.strictEqual(ny.category, 'investor_guideline');
  assert.strictEqual(ny.source, 'investor_guideline');
  assert.strictEqual(ny.blocks_ctc, true);
  assert.strictEqual(ny.blocks_funding, true);
  assert.strictEqual(ny.blocks_term_sheet, false);
  assert.strictEqual(ny.evidence[0].escalate, true);
  assert.strictEqual(ny.evidence[0].escalate_to, 'Blue Lake');
  ok('Blue Lake escalations fire (NY, >$1.5MM, assignment, rehab>$250k, rehab>as-is) — fatal + escalate');
}

// 2 — the SAME loan under a different note buyer does NOT get Blue-Lake-specific escalations.
{
  const f = g.review({ note_buyer: 'CorrFirst', property_state: 'NY', loan_amount: 2_000_000, is_assignment: true });
  assert.ok(!codes(f).some((c) => c.startsWith('isg_bl_')), 'no Blue-Lake-only rules for CorrFirst');
  ok('note-buyer scoping: Blue Lake escalations do not apply to CorrFirst');
}

// 3 — insufficient data NEVER fabricates a finding (null → no finding).
{
  assert.deepStrictEqual(g.review({ note_buyer: 'bluelake' }), [], 'no data → no findings');
  // loan_amount present but under threshold → satisfied, no finding.
  assert.deepStrictEqual(codes(g.review({ note_buyer: 'bluelake', loan_amount: 500_000 })), [], 'under threshold → none');
  // unknown note buyer → buyer-SPECIFIC rules cannot fire, but ALL-buyer rules still do.
  const allBuyer = g.review({ note_buyer: '', in_flood_zone: true });
  assert.deepStrictEqual(codes(allBuyer), ['isg_flood_zone_needs_insurance'], 'all-buyer flood rule fires even with no note buyer set');
  assert.ok(!codes(g.review({ note_buyer: '', loan_amount: 2_000_000 })).some((c) => c.startsWith('isg_bl_')), 'buyer-specific rule needs a known buyer');
  ok('insufficient / satisfied data → no fabricated findings; all-buyer vs buyer-specific scoping');
}

// 4 — transferred appraisal: Blue Lake = not eligible (fatal); CorrFirst = needs transfer letter.
{
  const bl = g.review({ note_buyer: 'bluelake', appraisal: { present: true, transferred: true } });
  assert.ok(byCode(bl, 'isg_bl_transferred_appraisal'), 'Blue Lake transferred → not eligible');
  assert.strictEqual(byCode(bl, 'isg_bl_transferred_appraisal').severity, 'fatal');
  // CorrFirst transferred WITH a letter → no finding; WITHOUT → fatal.
  const cfOk = g.review({ note_buyer: 'corrfirst', appraisal: { present: true, transferred: true, transfer_letter: true } });
  assert.ok(!byCode(cfOk, 'isg_cf_transferred_appraisal_letter'), 'CorrFirst + letter → no finding');
  const cfBad = g.review({ note_buyer: 'corrfirst', appraisal: { present: true, transferred: true, transfer_letter: false } });
  assert.ok(byCode(cfBad, 'isg_cf_transferred_appraisal_letter'), 'CorrFirst + no letter → fatal');
  ok('transferred appraisal: Blue Lake not-eligible; CorrFirst needs a transfer letter');
}

// 5 — FICO mismatch is fatal and cites both scores; a match raises nothing.
{
  const f = g.review({ note_buyer: 'all', fico_file: 700, fico_credit: 680 });
  const m = byCode(f, 'isg_fico_mismatch');
  assert.ok(m && m.severity === 'fatal', 'mismatch is fatal');
  assert.strictEqual(m.expected_value, '680');
  assert.strictEqual(m.actual_value, '700');
  assert.deepStrictEqual(codes(g.review({ fico_file: 700, fico_credit: 700 })), [], 'match → no finding');
  ok('FICO mismatch → fatal restructure with both scores cited; a match is silent');
}

// 6 — experience: claimed>verified is fatal; a stale exit is a warning.
{
  const f = g.review({ claimed_exp: 5, verified_exp: 2, has_stale_exit: true });
  assert.strictEqual(byCode(f, 'isg_experience_claimed_over_verified').severity, 'fatal');
  assert.strictEqual(byCode(f, 'isg_experience_stale_exit').severity, 'warning');
  assert.deepStrictEqual(codes(g.review({ claimed_exp: 2, verified_exp: 5 })), [], 'claimed ≤ verified → none');
  ok('experience: claimed>verified fatal; stale exit warning');
}

// 7 — price vs value only AFTER the appraisal is in (never before).
{
  const before = g.review({ purchase_price: 300_000, as_is_value: 200_000, appraisal_present: false });
  assert.ok(!byCode(before, 'isg_price_value_over_requirement'), 'no price concern before the appraisal');
  const after = g.review({ purchase_price: 300_000, as_is_value: 200_000, appraisal: { present: true } });
  assert.ok(byCode(after, 'isg_price_value_over_requirement'), 'price>as-is fatal once the appraisal is in');
  ok('price-vs-value only fires once the appraisal is present');
}

// 8 — null-safe / never throws on hostile input.
{
  for (const bad of [null, undefined, 42, 'x', [], { note_buyer: {} }]) {
    assert.doesNotThrow(() => g.review(bad));
    assert.ok(Array.isArray(g.review(bad)), 'always returns an array');
  }
  ok('null-safe: hostile input never throws, always an array');
}

console.log(`\ninvestor-guideline-review: ${n} checks passed`);
