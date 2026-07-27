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

// --- THE SECOND AI: consensus is required to HIDE a finding (owner-directed 2026-07-27) ---
// A confident primary rejection alone still hides (single-model / fail-open); but once a second
// model has weighed in, it must ALSO reject — a disagreement keeps the finding VISIBLE.
assert.strictEqual(r.shouldShow({ verdict: 'rejected', is_real_concern: false }), false, 'single-model reject still hides (no second model)');
assert.strictEqual(r.shouldShow({ verdict: 'rejected', is_real_concern: false, verdict2: 'rejected' }), false, 'BOTH models reject → hide (consensus)');
assert.strictEqual(r.shouldShow({ verdict: 'rejected', is_real_concern: false, verdict2: 'confirmed' }), true, 'models DISAGREE (2nd confirms) → keep visible');
assert.strictEqual(r.shouldShow({ verdict: 'rejected', is_real_concern: false, verdict2: 'uncertain' }), true, 'models disagree (2nd unsure) → keep visible');
assert.strictEqual(r.shouldShow({ verdict: 'confirmed', is_real_concern: true, verdict2: 'rejected' }), true, 'a confirmed primary always shows regardless of the 2nd');
// The second opinion is OFF in this env (no ANTHROPIC_API_KEY) — enablement is false, so the gate
// is byte-identical to the single-model behavior.
delete process.env.FINDING_AI_SECOND_OPINION_ENABLED;
// secondOpinionEnabled is internal; assert its effect via the fact anthropic is unavailable here.
assert.strictEqual(require('../src/lib/ai/anthropic').available(), false, 'no second model configured in test env (gate falls back to single model)');

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
  // Borrower-facing condition wording is captured AND scrubbed of any note-buyer name.
  const nb = normalize({ verdict: 'confirmed', isRealConcern: true, confidence: 0.9, reasoning: 'r',
    suggestedResolution: 's', suggestedDocument: 'd', suggestedSeverity: 'unchanged',
    borrowerLabel: 'Recent bank statements', borrowerHint: 'Please upload your two most recent Blue Lake statements' });
  assert.strictEqual(nb.borrower_label, 'Recent bank statements', 'borrower label captured');
  assert.ok(nb.borrower_hint && !/blue\s*lake/i.test(nb.borrower_hint), 'a note-buyer name is scrubbed from the borrower hint');
  const nEmpty = normalize({ verdict: 'rejected', isRealConcern: false, confidence: 0.9, reasoning: 'r',
    suggestedResolution: '', suggestedDocument: '', suggestedSeverity: 'unchanged', borrowerLabel: '', borrowerHint: '' });
  assert.strictEqual(nEmpty.borrower_label, null, 'empty borrower wording → null');
}

// --- PERSISTED (snake_case) findings are read the same as DERIVED (camelCase) ones ---
// (pre-merge audit 2026-07-27): a document_findings row uses doc_value/file_value/how_to/document_id;
// these are exactly the findings judged against their source document, so they must not be blanked.
{
  const { describeFinding } = r._internals;
  const persisted = { code: 'contract_price_mismatch', field: 'purchase_price', doc_value: '$500,000', file_value: '$412,000', how_to: 'Reconcile the price', title: 'Price mismatch', document_id: 'doc-123' };
  const camel = { code: 'contract_price_mismatch', field: 'purchase_price', docValue: '$500,000', fileValue: '$412,000', howTo: 'Reconcile the price', title: 'Price mismatch', documentId: 'doc-123' };
  // Same identity whether the finding is snake_case or camelCase.
  assert.strictEqual(r.fingerprintOf(persisted), r.fingerprintOf(camel), 'snake_case and camelCase of the SAME finding fingerprint identically');
  // The source document + values reach the prompt for a persisted finding.
  const desc = describeFinding(persisted, { docType: 'purchase_contract', fields: { price: 500000 } });
  assert.ok(/What the loan file says: \$412,000/.test(desc), 'persisted file_value reaches the prompt');
  assert.ok(/What the document says: \$500,000/.test(desc), 'persisted doc_value reaches the prompt');
  assert.ok(/Reconcile the price/.test(desc), "persisted how_to (PILOT's reasoning) reaches the prompt");
  assert.ok(/source document PILOT used \(purchase_contract\)/.test(desc), 'the source document is described for a persisted finding');
  // A changed file_value on a persisted finding yields a new fingerprint (re-review).
  assert.notStrictEqual(r.fingerprintOf(persisted), r.fingerprintOf({ ...persisted, file_value: '$999,999' }), 'a changed persisted value re-reviews');
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
