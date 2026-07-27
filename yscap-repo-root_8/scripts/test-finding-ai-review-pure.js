'use strict';
/**
 * Pure tests for the AI finding-review GATE (src/lib/underwriting/finding-ai-review.js). No DB /
 * network / keys. Proves: the gate only ever SUPPRESSES a confidently-rejected finding (never a
 * confirmed / uncertain / un-reviewed one), the fingerprint is stable + value-sensitive, the display
 * pass splits + enriches correctly, and reviewFindings is best-effort (returns a skip, never throws)
 * when the AI is unavailable.
 */
const assert = require('assert');
const r = require('../src/lib/underwriting/finding-ai-review');

// --- ON by default; only an explicit '0' turns it off ---
delete process.env.FINDING_AI_REVIEW_ENABLED;
assert.strictEqual(r.enabled(), true, 'AI review is ON by default (still gated by Azure + cost cap)');
process.env.FINDING_AI_REVIEW_ENABLED = '0';
assert.strictEqual(r.enabled(), false, "only '0' turns it off");
process.env.FINDING_AI_REVIEW_ENABLED = '1';
assert.strictEqual(r.enabled(), true);

// --- fingerprintOf is stable and value-sensitive ---
const fA = { code: 'tieout_entity_name', field: 'entity_name', docValue: 'Old Owner LLC', fileValue: 'New Vesting LLC', title: 'X', documentId: 'd1' };
const fA2 = { ...fA };
assert.strictEqual(r.fingerprintOf(fA), r.fingerprintOf(fA2), 'same finding → same fingerprint');
assert.notStrictEqual(r.fingerprintOf(fA), r.fingerprintOf({ ...fA, docValue: 'Different LLC' }), 'a changed compared value → new fingerprint (re-review)');
assert.ok(typeof r.fingerprintOf({}) === 'string' && r.fingerprintOf({}).length > 0, 'never throws on empty');

// --- shouldShow: suppress ONLY a confident rejected; show everything else ---
assert.strictEqual(r.shouldShow(null), true, 'no verdict yet → show (fail-open)');
assert.strictEqual(r.shouldShow({ verdict: 'confirmed', is_real_concern: true }), true);
assert.strictEqual(r.shouldShow({ verdict: 'uncertain', is_real_concern: false }), true, 'uncertain is never hidden');
assert.strictEqual(r.shouldShow({ verdict: 'rejected', is_real_concern: false }), false, 'a confident false alarm is suppressed');
assert.strictEqual(r.shouldShow({ verdict: 'rejected', is_real_concern: true }), true, 'rejected but still-a-concern is NOT hidden (conservative)');

// --- annotateFindings splits shown/suppressed and attaches the AI review ---
{
  const findings = [
    { code: 'a', field: 'x', docValue: '1', fileValue: '2', title: 'A', documentId: 'd1' },   // confirmed → shown+enriched
    { code: 'b', field: 'y', docValue: '3', fileValue: '4', title: 'B', documentId: 'd2' },   // rejected → suppressed
    { code: 'c', field: 'z', docValue: '5', fileValue: '6', title: 'C', documentId: 'd3' },   // no verdict → shown, unenriched
  ];
  const mem = new Map();
  mem.set(r.fingerprintOf(findings[0]), { verdict: 'confirmed', is_real_concern: true, confidence: 0.9, reasoning: 'real', suggested_resolution: 'do X', suggested_document: 'bank statement', suggested_severity: 'unchanged' });
  mem.set(r.fingerprintOf(findings[1]), { verdict: 'rejected', is_real_concern: false, confidence: 0.95, reasoning: 'wrong compare', suggested_resolution: null, suggested_document: null, suggested_severity: 'unchanged' });
  const { shown, suppressed } = r.annotateFindings(findings, mem);
  assert.strictEqual(shown.length, 2, 'confirmed + un-reviewed are shown');
  assert.strictEqual(suppressed.length, 1, 'the rejected one is suppressed');
  assert.strictEqual(suppressed[0].code, 'b');
  const a = shown.find((s) => s.code === 'a');
  assert.ok(a.aiReview && a.aiReview.verdict === 'confirmed', 'confirmed finding carries its aiReview');
  assert.strictEqual(a.aiReview.suggestedResolution, 'do X', 'the AI suggestion is attached for building suggestions on top');
  assert.strictEqual(a.aiReview.suggestedDocument, 'bank statement');
  const c = shown.find((s) => s.code === 'c');
  assert.ok(!c.aiReview, 'an un-reviewed finding is shown with no aiReview (fail-open)');
}
// annotateFindings never throws on bad input.
assert.deepStrictEqual(r.annotateFindings(null, null).shown, []);
assert.deepStrictEqual(r.annotateFindings([{ code: 'x' }], 'not-a-map').shown.length, 1, 'a non-Map memory is treated as empty → shows');

// --- normalize coerces + clamps ---
{
  const { normalize } = r._internals;
  const n = normalize({ verdict: 'rejected', isRealConcern: false, confidence: 1.4, reasoning: 'r', suggestedResolution: 's', suggestedDocument: 'd', suggestedSeverity: 'warning' });
  assert.strictEqual(n.verdict, 'rejected');
  assert.strictEqual(n.confidence, 1, 'confidence clamped to [0,1]');
  const n2 = normalize({ verdict: 'nonsense', confidence: 'x' });
  assert.strictEqual(n2.verdict, 'uncertain', 'an unknown verdict degrades to uncertain (never hides a finding)');
  assert.strictEqual(n2.confidence, null);
  assert.strictEqual(n2.suggested_severity, 'unchanged');
}

// --- economicsRecap feeds the AI the whole deal picture (owner-directed 2026-07-27) ---
{
  const { economicsRecap } = r._internals;
  const asg = economicsRecap({ is_assignment: true, purchase_price: 474000, underlying_contract_price: 438000, assignment_fee: 36000,
    loan_amount: 355500, as_is_value: 500000, arv: 620000, rehab_budget: 80000, ltv: 71.1, loan_to_cost: 64, loan_to_arv: 57.3, registered_program: 'gold' });
  assert.ok(/ASSIGNMENT/.test(asg), 'assignment status is stated');
  assert.ok(/seller contract/.test(asg) && /assignment fee/.test(asg), 'assignment seller price + fee are included');
  assert.ok(/loan amount/.test(asg) && /as-is value/.test(asg) && /ARV/.test(asg), 'loan amount + as-is + ARV included');
  assert.ok(/LTV/.test(asg) && /LTC/.test(asg) && /LTARV/.test(asg), 'the leverage ratios are included');
  const straight = economicsRecap({ is_assignment: false, purchase_price: 300000 });
  assert.ok(/straight purchase/.test(straight), 'a straight purchase is labeled so');
  const none = economicsRecap(null);
  assert.ok(typeof none === 'string' && /\(missing\)/.test(none), 'never throws on missing fields — shows (missing), not a crash');
}

// --- reviewFindings is best-effort: AI unavailable in this env → a skip, never a throw ---
(async () => {
  process.env.FINDING_AI_REVIEW_ENABLED = '1';
  const res = await r.reviewFindings({ client: null, appId: null, findings: null });
  assert.ok(res && typeof res.skipped === 'string', 'returns a shaped skip result, never throws');
  const res2 = await r.reviewFindings({ client: {}, appId: 'a', findings: [{ code: 'x', title: 't' }] });
  assert.strictEqual(res2.skipped, 'ai_unavailable', 'no Azure config → skipped ai_unavailable (no calls, no throw)');

  // disabled path
  process.env.FINDING_AI_REVIEW_ENABLED = '0';
  const res3 = await r.reviewFindings({ client: {}, appId: 'a', findings: [{ code: 'x', title: 't' }] });
  assert.strictEqual(res3.skipped, 'disabled');
  process.env.FINDING_AI_REVIEW_ENABLED = '1';

  console.log('✓ test-finding-ai-review-pure: gate suppresses only confident rejections + fingerprint + best-effort pass');
})().catch((e) => { console.error(e); process.exit(1); });
