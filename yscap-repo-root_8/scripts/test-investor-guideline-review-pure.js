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

// 4 — appraisal not in our name (owner 2026-07-27): Blue Lake = BIG FATAL, no letter can fix it;
// EVERY OTHER note buyer = advisory (warning) to request a transfer letter, silent once it's on file.
{
  const bl = g.review({ note_buyer: 'bluelake', appraisal: { present: true, transferred: true } });
  assert.ok(byCode(bl, 'isg_bl_transferred_appraisal'), 'Blue Lake transferred → not eligible');
  assert.strictEqual(byCode(bl, 'isg_bl_transferred_appraisal').severity, 'fatal');
  // Blue Lake gets the FATAL only — never the request-a-letter advisory (a letter cannot fix it).
  assert.ok(!byCode(bl, 'isg_transferred_appraisal_letter'), 'Blue Lake never gets the request-a-letter advisory');
  // A non-Blue-Lake buyer (CorrFirst here, but the rule is audience:all) → the request-a-letter
  // advisory (WARNING), and it goes SILENT once a transfer letter is on file.
  const cfNoLetter = g.review({ note_buyer: 'corrfirst', appraisal: { present: true, transferred: true, transfer_letter: false } });
  const adv = byCode(cfNoLetter, 'isg_transferred_appraisal_letter');
  assert.ok(adv, 'a non-Blue-Lake transferred appraisal → request a transfer letter');
  assert.strictEqual(adv.severity, 'warning', 'the transfer-letter ask is an advisory, not a decline');
  const cfWithLetter = g.review({ note_buyer: 'corrfirst', appraisal: { present: true, transferred: true, transfer_letter: true } });
  assert.ok(!byCode(cfWithLetter, 'isg_transferred_appraisal_letter'), 'a transfer letter already on file → no finding');
  // An in-our-name appraisal (not transferred) → nothing at all, for any buyer.
  const fidOurs = g.review({ note_buyer: 'fidelis', appraisal: { present: true, transferred: false } });
  assert.ok(!byCode(fidOurs, 'isg_transferred_appraisal_letter') && !byCode(fidOurs, 'isg_bl_transferred_appraisal'),
    'an appraisal in our name raises no transfer finding');
  ok('appraisal not in our name: Blue Lake fatal (no letter fix); every other buyer = advisory request-letter, silent once on file');
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

// 7b — RECOGNIZED price, not the gross contract price, is compared to value. On an
// assignment the gross price includes a fee the loan isn't sized on; firing this FATAL on
// the gross price would be a FALSE fire when the recognized (sized) price is within value.
{
  // Gross 200k > as-is 180k, BUT the loan is sized on the recognized 172.5k (≤ value) → NO fatal.
  const withinValue = g.review({
    purchase_price: 200_000, effective_purchase_price: 172_500, as_is_value: 180_000,
    is_assignment: true, appraisal: { present: true } });
  assert.ok(!byCode(withinValue, 'isg_price_value_over_requirement'),
    'recognized price within value → no false FATAL even though gross price exceeds value');

  // Recognized price itself exceeds value → the FATAL still fires (real problem).
  const overValue = g.review({
    purchase_price: 260_000, effective_purchase_price: 240_000, as_is_value: 200_000,
    is_assignment: true, appraisal: { present: true } });
  const f = byCode(overValue, 'isg_price_value_over_requirement');
  assert.ok(f, 'recognized price over value → FATAL still fires');
  assert.strictEqual(f.actual_value, '$240,000', 'the finding cites the recognized price, not the gross price');

  // No effective price on file (a straight purchase) → falls back to the gross price (unchanged).
  const straight = g.review({ purchase_price: 300_000, as_is_value: 200_000, appraisal: { present: true } });
  assert.ok(byCode(straight, 'isg_price_value_over_requirement'),
    'a straight purchase with no recognized price still fires on the gross price');
  ok('price-vs-value compares the recognized (loan-sized) price, not the gross contract price');
}

// 7c — note-buyer KEYING CONTRACT: a buyer-specific rule matches the canonical dropdown
// label regardless of spacing/casing (the shared normNoteBuyer key), and does NOT match a
// different buyer — a Blue Lake escalation must never fire on a CorrFirst (or unknown) file.
{
  // Every spelling of the canonical label resolves to the Blue Lake audience.
  for (const label of ['Blue Lake', 'blue lake', 'BLUELAKE', 'Blue  Lake']) {
    const f = g.review({ note_buyer: label, property_state: 'NY' });
    assert.ok(byCode(f, 'isg_bl_ny_loan'), `Blue Lake NY rule fires for lender label "${label}"`);
  }
  // A different buyer never triggers the Blue Lake escalation (no cross-buyer over-fire).
  const cf = g.review({ note_buyer: 'CorrFirst', property_state: 'NY' });
  assert.ok(!byCode(cf, 'isg_bl_ny_loan'), 'Blue Lake NY rule does NOT fire on a CorrFirst file');
  // An unknown/blank buyer never triggers a buyer-specific rule (needs a known buyer).
  const unknown = g.review({ note_buyer: '', property_state: 'NY' });
  assert.ok(!byCode(unknown, 'isg_bl_ny_loan'), 'a buyer-specific rule needs a known note buyer');
  // buyerMatches keys with the SHARED normalizer (agrees with the engine/desk keying).
  assert.strictEqual(g.buyerMatches('bluelake', 'Blue Lake'), true, 'canonical label matches its audience');
  assert.strictEqual(g.buyerMatches('bluelake', 'CorrFirst'), false, 'a different buyer does not match');
  assert.strictEqual(g.buyerMatches('all', 'anything'), true, "the 'all' audience always matches");
  ok('note-buyer keying: canonical labels match their audience; no cross-buyer over-fire');
}

// 8 — null-safe / never throws on hostile input.
{
  for (const bad of [null, undefined, 42, 'x', [], { note_buyer: {} }]) {
    assert.doesNotThrow(() => g.review(bad));
    assert.ok(Array.isArray(g.review(bad)), 'always returns an array');
  }
  ok('null-safe: hostile input never throws, always an array');
}

// 9 — EMCAP rental rules (owner-directed 2026-07-26; all WARN).
{
  const emcap = (extra) => g.review(Object.assign({ note_buyer: 'EMCAP', is_fix_hold: true, appraisal_present: true }, extra));
  // Missing 1007: fix-hold, appraisal present, NOT a 1025, no market rent → warn.
  const miss = emcap({ appraisal_is_1025: false });
  assert.ok(byCode(miss, 'isg_emcap_missing_1007') && byCode(miss, 'isg_emcap_missing_1007').severity === 'warning', 'EMCAP missing-1007 warns');
  // A 1025 includes the rent schedule → no missing-1007.
  assert.ok(!byCode(emcap({ appraisal_is_1025: true, appraisal_market_rent: 2500, loan_estimated_rent: 2500 }), 'isg_emcap_missing_1007'), '1025 satisfies the 1007 requirement');
  // Before the appraisal is in → silent (no guessing).
  assert.ok(g.review({ note_buyer: 'EMCAP', is_fix_hold: true, appraisal_present: false }).length === 0, 'no findings before the appraisal is in');
  // Rent mismatch is EXACT: any difference warns; an exact match is clean.
  assert.ok(byCode(emcap({ appraisal_is_1025: false, appraisal_market_rent: 2500, loan_estimated_rent: 2400 }), 'isg_emcap_rent_mismatch'), 'exact rent mismatch warns');
  assert.ok(!byCode(emcap({ appraisal_is_1025: true, appraisal_market_rent: 2500, loan_estimated_rent: 2500 }), 'isg_emcap_rent_mismatch'), 'an exact rent match is clean');
  // "Exact" is to the CENT — a sub-dollar difference still flags (not rounded away).
  assert.ok(byCode(emcap({ appraisal_is_1025: true, appraisal_market_rent: 2500.5, loan_estimated_rent: 2500 }), 'isg_emcap_rent_mismatch'), 'a sub-dollar rent difference (2500.50 vs 2500.00) warns');
  assert.ok(!byCode(emcap({ appraisal_is_1025: true, appraisal_market_rent: 2500.1, loan_estimated_rent: 2500.1 }), 'isg_emcap_rent_mismatch'), 'equal-to-the-cent rents are clean (no float noise)');
  // Not fix-and-hold → the 1007 rule is inert; missing a signal → silent.
  assert.ok(!byCode(g.review({ note_buyer: 'EMCAP', is_fix_hold: false, appraisal_present: true, appraisal_is_1025: false }), 'isg_emcap_missing_1007'), 'a non-fix-hold EMCAP loan needs no 1007');
  assert.ok(g.review({ note_buyer: 'EMCAP' }).length === 0, 'EMCAP with no signals → no findings (omit-don’t-guess)');
  // Never fires on another buyer.
  assert.ok(g.review({ note_buyer: 'Fidelis', is_fix_hold: true, appraisal_present: true, appraisal_is_1025: false, appraisal_market_rent: 2500, loan_estimated_rent: 2400 }).filter((f) => f.code.startsWith('isg_emcap')).length === 0, 'EMCAP rules never fire on another buyer');
  ok('EMCAP rental rules: 1007 (warn, 1025-satisfied, post-appraisal), exact rent match, buyer-scoped');
}

{
  // EMCAP >10-months housing supply (owner-directed 2026-07-30) — an ADVISORY
  // escalation off the appraisal's own 1004MC number, never a fatal, never
  // fabricated. Silent with no signal; ≤10 is clean; >10 warns; buyer-scoped.
  const byCode = (fs, c) => fs.find((f) => f.code === c);
  const g = require('../src/lib/underwriting/investor-guideline-review');
  const emcap = (x) => g.review({ note_buyer: 'EMCAP Financial', ...x });
  const hit = byCode(emcap({ housing_months_supply: 11.5 }), 'isg_emcap_high_housing_supply');
  require('assert').ok(hit && hit.severity === 'warning', '>10 months of supply raises the EMCAP WARNING');
  require('assert').ok(/11\.5/.test(hit.explanation) && /MSA/.test(hit.explanation), 'the explanation names the number and the MSA-level judgment');
  require('assert').ok(!byCode(emcap({ housing_months_supply: 10 }), 'isg_emcap_high_housing_supply'), 'exactly 10 months is clean (rule is strictly over 10)');
  require('assert').ok(!byCode(emcap({ housing_months_supply: 4 }), 'isg_emcap_high_housing_supply'), 'a normal market is clean');
  require('assert').ok(!byCode(emcap({}), 'isg_emcap_high_housing_supply'), 'no 1004MC signal → silent (omit-don’t-guess)');
  require('assert').ok(!byCode(g.review({ note_buyer: 'Blue Lake', housing_months_supply: 14 }), 'isg_emcap_high_housing_supply'), 'never fires for another note buyer');
  ok('EMCAP >10-month housing-supply advisory: fires >10 only, silent unknown, buyer-scoped');
}

console.log(`\ninvestor-guideline-review: ${n} checks passed`);
