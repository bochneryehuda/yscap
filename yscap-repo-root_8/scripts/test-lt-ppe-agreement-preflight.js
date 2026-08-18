#!/usr/bin/env node
'use strict';
/**
 * LT PPE - WE MUST NOT PAY LENDER PRICE TO DISCOVER OUR OWN SHEET PRICES NOTHING.
 *
 * OFFLINE: pure. No database, no vendor call - which is the whole point of the thing under test.
 *
 * WHAT WAS MISSING. `runAgreementRoute` refuses to spend before it starts on four counts: no program,
 * no Lender Price scope, no vendor credentials, an empty battery. **Every one of them is about THEIR
 * side or about the inputs. Nothing looked at ours.** So a sheet whose own leg declines or throws on
 * every scenario still made the full ~299 paid vendor calls and came back a wall of eligibility
 * disagreements that were our own misconfiguration - the same outcome this route's settings comment
 * records from the day a mis-read margin "filled the findings ledger with our own misconfiguration",
 * arriving through another door and costing money on the way.
 *
 * Our side is PURE, so the whole battery can be run against ourselves for nothing. `program-audit.js`
 * was built for exactly this and `LT-UNREACHED.md` named its home: *"the free pre-flight beside
 * GET …/coverage"*. This is that pre-flight.
 *
 * WHAT IT MAY AND MAY NOT DO is the load-bearing part, and most of this suite is about the second half:
 * it refuses ONE thing - a battery our engine priced NOTHING in, which is the same statement as "empty
 * battery" rather than a judgement - and everything else it REPORTS. Picking a threshold ("refuse if
 * more than half decline") would be inventing a business rule, because a sheet legitimately declines
 * most of a deliberately hostile battery.
 */
const path = require('path');
const fs = require('fs');

const PPE = path.join(__dirname, '..', 'src', 'longterm', 'ppe');
const preflightMod = require(path.join(PPE, 'agreement-preflight'));
const agreementScenarios = require(path.join(PPE, 'agreement-scenarios'));

let pass = 0;
const failures = [];
function ok(cond, what) { if (cond) { pass += 1; return; } failures.push(what); }
const eq = (a, b, what) => ok(a === b, `${what} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

const priced = () => ({ eligible: true, ladder: [{ rate: 7.5, finalPriceMilli: 101000 }] });
const declined = (code) => ({ eligible: false, ladder: [], declines: [{ code, reason: 'no' }] });
const battery = (n) => Array.from({ length: n }, (_, i) => ({ _label: `scenario ${i + 1}` }));

// ---------------------------------------------------------------------------
// A - THE ONE REFUSAL, and it costs nothing to reach.
// ---------------------------------------------------------------------------
{
  const out = preflightMod.preflight({ battery: battery(299), ours: () => declined('dhvn_min_fico') });
  ok(!out.ok, 'A1 a battery our own engine prices NOTHING in is refused - before a single vendor call');
  eq(out.reason, 'our_engine_priced_nothing', 'A2 ...with a reason a caller can branch on');
  ok(/priced NONE/.test(out.detail) && /no vendor calls were made/.test(out.detail),
    'A3 ...and a detail that says plainly what happened and that nothing was spent');
  eq(out.ours.declined, 299, 'A4 ...counting where it refused');
  eq(out.ours.declineCodeCounts.dhvn_min_fico, 299, 'A5 ...and under which decline code, so the report is actionable');
}

// ---------------------------------------------------------------------------
// B - AND ONLY THAT ONE. Everything else is reported, never gated.
// ---------------------------------------------------------------------------
{
  // A hostile battery legitimately declines most of itself. ONE priced scenario is something to
  // measure, so the run proceeds - refusing here would be inventing a business rule.
  const mostlyDeclined = preflightMod.preflight({
    battery: battery(299),
    ours: (s) => (s._label === 'scenario 1' ? priced() : declined('dhvn_max_ltv')),
  });
  ok(mostlyDeclined.ok, 'B1 298 of 299 declining does NOT refuse - a sheet declining a hostile battery is doing its job');
  eq(mostlyDeclined.ours.priced, 1, 'B2 ...and the one that priced is counted');

  // A leg that throws is counted, not swallowed and not fatal on its own.
  let i = 0;
  const flaky = preflightMod.preflight({
    battery: battery(10),
    ours: () => { i += 1; if (i <= 4) throw new Error('boom: fact key drifted'); return priced(); },
  });
  ok(flaky.ok, 'B3 a leg that throws on some scenarios does not refuse while others still price');
  eq(flaky.ours.threw, 4, 'B4 ...the failures are COUNTED, never swallowed');
  ok(/boom/.test(flaky.ours.threwSamples[0].error) && flaky.ours.threwSamples[0].scenario === 'scenario 1',
    'B5 ...with an example naming the scenario and the error, because a count alone is unactionable');
  ok(flaky.ours.threwSamples.length <= 5, 'B6 ...capped, and the cap is a NAMED sample list rather than a silent truncation');

  // A leg that throws on EVERYTHING prices nothing, so it lands on the one refusal.
  const allThrew = preflightMod.preflight({ battery: battery(6), ours: () => { throw new Error('x'); } });
  ok(!allThrew.ok && allThrew.ours.threw === 6, 'B7 a leg that fails on everything is the same refusal - nothing was priced');
}

// ---------------------------------------------------------------------------
// C - ELIGIBLE WITH NO RUNGS IS NOT PRICED. This is the §2.61 refusal, and it must not read as proof.
// ---------------------------------------------------------------------------
{
  const refused = preflightMod.preflight({
    battery: battery(5),
    ours: () => ({ eligible: true, priced: false, ladder: [], incomplete: [{ code: 'missing_fact' }] }),
  });
  ok(!refused.ok, 'C1 an engine that says "eligible but I refuse to price" has produced nothing to compare');
  eq(refused.ours.unpriced, 5, 'C2 ...counted in its own bucket, never as priced and never as declined');
  eq(refused.ours.priced, 0, 'C3 ...so it cannot read as proof there is something to measure');

  const emptyLadder = preflightMod.preflight({ battery: battery(3), ours: () => ({ eligible: true, ladder: [] }) });
  eq(emptyLadder.ours.unpriced, 3, 'C4 an empty ladder is the same thing by another route - no coupon to compare');
}

// ---------------------------------------------------------------------------
// D - IT NEVER THROWS, AND IT NEVER GUESSES.
// ---------------------------------------------------------------------------
{
  let threw = false;
  for (const junk of [undefined, null, {}, { battery: null }, { battery: 'nope', ours: 3 }]) {
    try { preflightMod.preflight(junk); } catch (_) { threw = true; }
  }
  ok(!threw, 'D1 junk input never throws - this sits in front of a paid run and must not be the thing that breaks it');

  const noLeg = preflightMod.preflight({ battery: battery(4) });
  ok(noLeg.ours.legMissing === true, 'D2 no leg at all is STATED, never reported as "everything declined"');

  const empty = preflightMod.preflight({ battery: [], ours: () => priced() });
  ok(empty.ok, 'D3 an EMPTY battery is not this check\'s refusal - the route already has its own, and two refusals for one fact is one too many');

  // The dead-rule half is optional, and its absence says so rather than reading as "no dead rules".
  const noProfile = preflightMod.preflight({ battery: battery(3), ours: () => priced() });
  eq(noProfile.deadRules.ran, false, 'D4 with no investor descriptor the dead-rule profile did not run');
  ok(/no investor program descriptor/.test(noProfile.deadRules.why),
    'D5 ...and SAYS so - "we did not look" must never render as "we looked and found nothing"');

  // A profile that blows up is reported and does not take the pre-flight down with it.
  const badProfile = preflightMod.preflight({
    battery: battery(3), ours: () => priced(),
    pppDescriptor: {}, factsOf: () => { throw new Error('facts blew up'); },
  });
  ok(badProfile.ok, 'D6 a failed dead-rule profile never stops a run whose own leg prices fine');
  ok(badProfile.deadRules.ran === false && /could not be built/.test(badProfile.deadRules.why),
    'D7 ...and is reported as failed rather than as clean');
}

// ---------------------------------------------------------------------------
// E - AGAINST THE REAL BATTERY, so the shape is proven on what actually runs.
// ---------------------------------------------------------------------------
{
  const built = agreementScenarios.buildAgreementScenarios();
  const real = Array.isArray(built && built.scenarios) ? built.scenarios : [];
  ok(real.length > 200, `E1 the canonical battery is a real size (${real.length}) - this is what a run pays for`);

  const out = preflightMod.preflight({ battery: real, ours: () => priced() });
  eq(out.checked, real.length, 'E2 every scenario in it is checked, free');
  eq(out.ours.priced, real.length, 'E3 ...and a healthy leg prices all of them');
  ok(out.ok, 'E4 ...so the paid run would start');
}

// ---------------------------------------------------------------------------
// F - THE CALL SITE. No unit test of a pure module can see whether the paid route actually asks it, and
//     that wiring IS the fix - the module existing changes nothing on its own.
// ---------------------------------------------------------------------------
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'longterm', 'routes', 'ppe.js'), 'utf8');
  const stripped = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

  // ⛔ SCOPED TO THE PAID ROUTE'S OWN BODY. A file-wide `indexOf` finds the FREE DOOR's call first
  // (`rateSheetPreflightRoute` is defined earlier in the file), so an ordering check against it is
  // comparing the wrong pair and passes however the paid route is arranged - which is exactly what
  // happened on the first cut, and only one of the two ordering mutations was caught. The body is cut
  // out by brace-matching from the function's own declaration.
  const fnAt = stripped.indexOf('async function runAgreementRoute(');
  ok(fnAt !== -1, 'F0 the paid route is where it was');
  let depth = 0; let bodyEnd = -1;
  for (let i = stripped.indexOf('{', fnAt); i < stripped.length; i += 1) {
    if (stripped[i] === '{') depth += 1;
    else if (stripped[i] === '}') { depth -= 1; if (depth === 0) { bodyEnd = i; break; } }
  }
  ok(bodyEnd !== -1, 'F0b ...and its body was read cleanly (balanced braces)');
  const body = stripped.slice(fnAt, bodyEnd === -1 ? stripped.length : bodyEnd);

  const runAt = body.indexOf('runRatesheetAgreement(');
  const preAt = body.indexOf('agreementPreflight.preflight(');
  ok(preAt !== -1, 'F1 the paid route asks the pre-flight');
  ok(runAt !== -1, 'F2 ...and the paid run is where it was');
  ok(preAt !== -1 && runAt !== -1 && preAt < runAt,
    'F3 ...BEFORE it spends - a pre-flight that ran after the vendor calls would answer a question already paid for');

  // The refusal must actually stop the run, not merely be recorded.
  const between = body.slice(preAt, runAt);
  ok(/if\s*\(!preflight\.ok\)/.test(between) && /return res\.status\(422\)/.test(between),
    'F4 ...and a failed pre-flight RETURNS, rather than being reported beside a run that went ahead anyway');

  // One leg, shared. A pre-flight built on its own leg answers about a different engine.
  ok(/const oursLeg = lpAgreementLegs\.buildOursLeg\(/.test(body) && /ours: oursLeg,/.test(body),
    'F5 the pre-flight and the paid run share ONE leg - the thing that says "we can price this" IS the thing that prices it');

  // And the advisory half reaches the answer too, or it is a report nobody sees.
  ok(/\n\s*preflight,\n/.test(body), 'F6 the pre-flight rides on the successful answer as well as on the refusal');

  // The free door exists and is a GET (it changes nothing and calls no vendor).
  ok(/router\.get\('\/rate-sheets\/:id\/preflight'/.test(stripped),
    'F7 there is a free door to ask it before pressing the paid button');
}

console.log(failures.length
  ? `FAIL - lt ppe agreement preflight (${pass} passed, ${failures.length} failed)\n  ${failures.join('\n  ')}`
  : `ok - lt ppe agreement preflight (${pass} assertions)`);
process.exit(failures.length ? 1 : 0);
