'use strict';
/**
 * ISG-2 — pure tests for the CorrFirst "Fix & Flip Purchase" note-buyer condition spec.
 * Proves the checked-in spec is well-formed and the applicability helpers route each row to
 * the right note buyer:
 *   • all 47 conditions, unique cond_no, valid scope/lifecycle/clears_by enums;
 *   • checks are [{text, note_buyer_specific}] and every note-buyer-specific limit is flagged;
 *   • appliesToNoteBuyer: all_note_buyers → everyone; note_buyer → CorrFirst only;
 *     all_but_note_buyer_limits → everyone (universal condition, note-buyer-only limits);
 *   • CorrFirst sees EVERY active condition; another note buyer sees only the universal ones;
 *   • the PILOT crosswalk (pilot_template_code + match_quality) is present and consistent.
 */
const assert = require('assert');
const spec = require('../src/lib/underwriting/investor-guidelines/corrfirst-fnf-spec');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// 1. spec integrity — 47 rows, unique cond_no, valid enums, well-formed shape.
{
  const C = spec.CONDITIONS;
  assert.strictEqual(C.length, 47, '47 conditions from the sheet');
  const nums = new Set(C.map((c) => c.cond_no));
  assert.strictEqual(nums.size, 47, 'cond_no is unique');
  for (const c of C) {
    assert.ok(Number.isInteger(c.cond_no) && c.cond_no > 0, `cond_no int (${c.name})`);
    assert.ok(c.name && typeof c.name === 'string', 'name present');
    assert.ok(spec.SCOPES.includes(c.scope), `valid scope ${c.scope}`);
    assert.ok(spec.LIFECYCLES.includes(c.lifecycle), `valid lifecycle ${c.lifecycle}`);
    assert.ok(c.clears_by == null || spec.CLEARS_BY.includes(c.clears_by), `valid clears_by ${c.clears_by}`);
    assert.ok(c.trigger && typeof c.trigger === 'object' && !Array.isArray(c.trigger), 'trigger is an object');
    assert.ok(Array.isArray(c.checks), 'checks is an array');
    for (const k of c.checks) {
      assert.ok(k && typeof k.text === 'string' && typeof k.note_buyer_specific === 'boolean', 'check shape {text, note_buyer_specific}');
    }
    assert.ok(['exact', 'partial', 'new'].includes(c.match_quality), `match_quality ${c.match_quality}`);
    // an exact/partial match names a PILOT template; a new one does not.
    if (c.match_quality === 'new') assert.strictEqual(c.pilot_template_code, null, `new → no pilot code (${c.cond_no})`);
    else assert.ok(c.pilot_template_code, `exact/partial → has pilot code (${c.cond_no})`);
  }
  ok('47 conditions, unique cond_no, valid enums + well-formed checks + crosswalk');
}

// 2. scope tally matches the decoded sheet (35 all / 11 corrfirst / 1 limits-only).
{
  const by = (s) => spec.CONDITIONS.filter((c) => c.scope === s).length;
  assert.strictEqual(by('all_note_buyers'), 35, 'all_note_buyers');
  assert.strictEqual(by('note_buyer'), 11, 'corrfirst-only');
  assert.strictEqual(by('all_but_note_buyer_limits'), 1, 'universal-but-limits');
  ok('scope tally 35 / 11 / 1 matches the decoded sheet');
}

// 3. appliesToNoteBuyer routes each scope correctly.
{
  const corr = spec.CONDITIONS.find((c) => c.cond_no === 2193); // corrfirst-only (construction feasibility)
  const univ = spec.CONDITIONS.find((c) => c.cond_no === 1015); // all note buyers (credit)
  const lim = spec.CONDITIONS.find((c) => c.cond_no === 2186);  // all_but_note_buyer_limits (hazard)
  assert.strictEqual(spec.appliesToNoteBuyer(corr, 'corrfirst'), true);
  assert.strictEqual(spec.appliesToNoteBuyer(corr, 'bluelake'), false, 'corrfirst-only never applies to another buyer');
  assert.strictEqual(spec.appliesToNoteBuyer(univ, 'bluelake'), true, 'universal applies to everyone');
  assert.strictEqual(spec.appliesToNoteBuyer(univ, ''), true, 'universal applies even with no note buyer');
  assert.strictEqual(spec.appliesToNoteBuyer(lim, 'bluelake'), true, 'universal-but-limits condition applies to everyone');
  // hostile input never throws
  for (const bad of [null, undefined, 42, 'x', []]) assert.doesNotThrow(() => spec.appliesToNoteBuyer(bad, bad));
  ok('appliesToNoteBuyer: all→everyone, corrfirst-only→CorrFirst, limits-only→everyone; hostile safe');
}

// 4. limitsApplyToNoteBuyer — the note-buyer-specific numbers are CorrFirst's only.
{
  const lim = spec.CONDITIONS.find((c) => c.cond_no === 2186);
  const univ = spec.CONDITIONS.find((c) => c.cond_no === 1015);
  assert.strictEqual(spec.limitsApplyToNoteBuyer(lim, 'corrfirst'), true, 'CorrFirst gets the exact limits');
  assert.strictEqual(spec.limitsApplyToNoteBuyer(lim, 'bluelake'), false, 'another buyer follows industry standard');
  assert.strictEqual(spec.limitsApplyToNoteBuyer(univ, 'bluelake'), true, 'a universal condition\'s checks apply to all');
  // every condition carrying a note_buyer_specific check is note-buyer- or limits-scoped.
  for (const c of spec.CONDITIONS) {
    if (c.checks.some((k) => k.note_buyer_specific)) {
      assert.ok(c.scope === 'note_buyer' || c.scope === 'all_but_note_buyer_limits',
        `cond ${c.cond_no} has a note-buyer-specific limit → must be note_buyer/limits-scoped`);
    }
  }
  ok('limitsApplyToNoteBuyer + every note-buyer-specific limit sits on a note-buyer-scoped condition');
}

// 5. CorrFirst sees EVERY active condition; another note buyer sees only the universal ones.
{
  const active = spec.activeConditions();
  assert.ok(active.length > 0 && active.every((c) => c.lifecycle === 'active_now'), 'activeConditions all active_now');
  const corrActive = spec.applicableFor('corrfirst');
  const otherActive = spec.applicableFor('bluelake');
  assert.strictEqual(corrActive.length, active.length, 'CorrFirst sees every active condition');
  assert.ok(otherActive.length < corrActive.length, 'another note buyer sees strictly fewer');
  // the extra ones CorrFirst sees are exactly the note_buyer-scoped active conditions.
  assert.ok(otherActive.every((c) => c.scope === 'all_note_buyers' || c.scope === 'all_but_note_buyer_limits'),
    'a non-CorrFirst buyer never gets a corrfirst-only condition');
  // includeDeferred surfaces the attorney-hold / post-closing ones too.
  const withDeferred = spec.applicableFor('corrfirst', { includeDeferred: true });
  assert.ok(withDeferred.length > corrActive.length, 'includeDeferred surfaces the held/deferred conditions');
  ok('CorrFirst sees all active; other buyers see only universal; includeDeferred adds the held set');
}

// 6. lifecycle tally — 32 active_now, 15 deferred/held (10 attorney-hold + 4 post-closing + 1 closing).
{
  const by = (l) => spec.CONDITIONS.filter((c) => c.lifecycle === l).length;
  assert.strictEqual(by('active_now'), 32, 'active_now');
  assert.strictEqual(by('hold_attorney_closing'), 10, 'attorney-hold');
  assert.strictEqual(by('defer_post_closing'), 4, 'post-closing');
  assert.strictEqual(by('closing_phase'), 1, 'closing-phase');
  ok('lifecycle tally 32 / 10 / 4 / 1 matches the decoded sheet');
}

console.log(`\ninvestor-guidelines pure — ${passed} checks passed`);
