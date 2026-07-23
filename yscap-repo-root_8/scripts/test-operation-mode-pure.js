'use strict';
/**
 * #221 — pure tests for the staged live-operation mode controller. Proves:
 *   • shadow is the always-allowed floor (even with zero data / hostile input);
 *   • assisted needs a real sample + zero false clears + not-red + no canary rollback;
 *   • controlled needs GREEN production over a real sample AND a passing golden replay;
 *   • the gates are MONOTONIC (a broken lower rung blocks every higher rung);
 *   • decideMode returns min(configured, allowed) — intent ∧ safety;
 *   • a super-admin override can force a higher mode, flagged `forced`, never silent;
 *   • nothing is ever a hard block (overridable is always true);
 *   • nothing ever throws.
 */
const assert = require('assert');
const om = require('../src/lib/underwriting/operation-mode');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// signal builders
const green = (sample = 60) => ({ status: 'green', falseClears: 0, sampleSize: sample, missedMaterialRate: 0 });
const goldenPass = { release: { pass: true, blockers: [] }, ran: 30 };
const goldenFail = { release: { pass: false, blockers: ['1 false clear(s) — the release bar is 0'] }, ran: 30 };

// 1. shadow is always allowed — even with no data at all.
{
  const r = om.evaluateModes({ production: { status: 'insufficient_data', sampleSize: 0 }, golden: null });
  assert.strictEqual(r.byMode.shadow.allowed, true, 'shadow is the floor');
  assert.strictEqual(r.allowed, 'shadow', 'no evidence → only shadow is earned');
  assert.strictEqual(r.byMode.assisted.allowed, false);
  ok('shadow is the always-allowed floor; no evidence earns nothing higher');
}

// 2. assisted needs a real sample, zero false clears, not-red.
{
  // enough clean sample, no false clears → assisted allowed, controlled not (no golden).
  const r = om.evaluateModes({ production: green(30), golden: null });
  assert.strictEqual(r.byMode.assisted.allowed, true, 'a clean 30-sample earns assisted');
  assert.strictEqual(r.byMode.controlled.allowed, false, 'no golden replay → not controlled');
  assert.strictEqual(r.allowed, 'assisted');

  // a false clear kills assisted (and therefore everything above).
  const fc = om.evaluateModes({ production: { status: 'red', falseClears: 1, sampleSize: 40 }, golden: goldenPass });
  assert.strictEqual(fc.byMode.assisted.allowed, false, 'a false clear blocks assisted');
  assert.ok(fc.byMode.assisted.blockers.some((b) => /false clear/i.test(b)));
  assert.strictEqual(fc.allowed, 'shadow', 'a dangerous AI is held at shadow');
  ok('assisted requires a real sample + zero false clears + not-red');
}

// 3. too-small a sample holds at shadow even when clean.
{
  const r = om.evaluateModes({ production: green(5), golden: goldenPass });
  assert.strictEqual(r.byMode.assisted.allowed, false, '5 scored is below the assisted minimum');
  assert.ok(r.byMode.assisted.blockers.some((b) => /at least 20/.test(b)));
  assert.strictEqual(r.allowed, 'shadow');
  ok('a sub-threshold sample holds at shadow');
}

// 4. controlled needs GREEN + a real sample + a passing golden replay.
{
  // green + big sample + golden pass → controlled allowed.
  const good = om.evaluateModes({ production: green(60), golden: goldenPass });
  assert.strictEqual(good.byMode.controlled.allowed, true, 'green + 60 sample + golden pass → controlled');
  assert.strictEqual(good.allowed, 'controlled');

  // green + big sample but golden FAILS → controlled blocked, assisted still fine.
  const noGolden = om.evaluateModes({ production: green(60), golden: goldenFail });
  assert.strictEqual(noGolden.byMode.controlled.allowed, false, 'a failing golden replay blocks controlled');
  assert.ok(noGolden.byMode.controlled.blockers.some((b) => /golden replay/i.test(b)));
  assert.strictEqual(noGolden.byMode.assisted.allowed, true, 'assisted is unaffected by the golden gate');
  assert.strictEqual(noGolden.allowed, 'assisted');

  // amber production (not green) → controlled blocked even with golden pass.
  const amber = om.evaluateModes({ production: { status: 'amber', falseClears: 0, sampleSize: 60 }, golden: goldenPass });
  assert.strictEqual(amber.byMode.controlled.allowed, false, 'amber is not green');
  assert.ok(amber.byMode.controlled.blockers.some((b) => /GREEN/i.test(b)));
  assert.strictEqual(amber.allowed, 'assisted', 'amber still earns assisted');
  ok('controlled requires green production + real sample + passing golden replay');
}

// 5. gates are monotonic — a broken lower rung blocks every higher rung.
{
  // false clear present but golden passes + green-ish: assisted broken → controlled must also be false.
  const r = om.evaluateModes({ production: { status: 'green', falseClears: 1, sampleSize: 60 }, golden: goldenPass });
  assert.strictEqual(r.byMode.assisted.allowed, false, 'a false clear breaks assisted');
  assert.strictEqual(r.byMode.controlled.allowed, false, 'and therefore controlled too (monotonic)');
  assert.strictEqual(r.allowed, 'shadow');
  ok('the ladder is monotonic — a broken rung blocks everything above it');
}

// 6. decideMode returns min(configured, allowed).
{
  const signals = { production: green(60), golden: goldenPass }; // earns controlled
  // configured LOWER than earned → configured wins (ops asked for less).
  const d1 = om.decideMode('assisted', signals);
  assert.strictEqual(d1.allowed, 'controlled');
  assert.strictEqual(d1.effective, 'assisted', 'intent below the safety ceiling caps the effective mode');
  assert.strictEqual(d1.forced, false);
  assert.deepStrictEqual(d1.blockers, [], 'no blockers when intent is the limiter');

  // configured HIGHER than earned → clamped to earned, with blockers explaining why.
  const weak = { production: green(30), golden: null }; // earns only assisted
  const d2 = om.decideMode('controlled', weak);
  assert.strictEqual(d2.allowed, 'assisted');
  assert.strictEqual(d2.effective, 'assisted', 'clamped down to the safety ceiling');
  assert.strictEqual(d2.forced, false);
  assert.ok(d2.blockers.length > 0, 'blockers explain why controlled is not earned');
  assert.strictEqual(d2.overridable, true);
  ok('decideMode = min(configured, allowed); blockers explain a clamp-down');
}

// 7. a super-admin override forces a higher mode, flagged forced — never a hard block.
{
  const weak = { production: green(30), golden: null }; // earns only assisted
  const forced = om.decideMode('controlled', weak, { override: true });
  assert.strictEqual(forced.effective, 'controlled', 'the override runs hotter than the metrics earn');
  assert.strictEqual(forced.forced, true, 'and it is flagged forced, never silent');
  assert.strictEqual(forced.overridable, true, 'nothing here is ever a hard block');
  // an override that is NOT above the ceiling is not "forced".
  const notForced = om.decideMode('assisted', { production: green(60), golden: goldenPass }, { override: true });
  assert.strictEqual(notForced.forced, false, 'an override at/below the ceiling is not a force');
  ok('a super-admin can force a higher mode (flagged forced); never a hard block');
}

// 8. helpers + hostile input never throw.
{
  assert.strictEqual(om.normalizeMode('CONTROLLED'), 'controlled');
  assert.strictEqual(om.normalizeMode('nonsense'), 'shadow', 'unknown mode → the safe floor');
  assert.strictEqual(om.normalizeMode(null), 'shadow');
  assert.strictEqual(om.modeForSignals({ production: green(60), golden: goldenPass }), 'controlled');
  for (const bad of [null, undefined, 42, 'x', {}, { production: 'x', golden: 7 }]) {
    assert.doesNotThrow(() => om.evaluateModes(bad));
    assert.doesNotThrow(() => om.decideMode(bad, bad));
    assert.doesNotThrow(() => om.modeForSignals(bad));
    const d = om.decideMode('controlled', bad);
    assert.strictEqual(d.effective, 'shadow', 'hostile signals degrade to the safe floor');
  }
  ok('helpers + hostile input never throw; everything degrades to shadow');
}

console.log(`\noperation-mode pure — ${passed} checks passed`);
