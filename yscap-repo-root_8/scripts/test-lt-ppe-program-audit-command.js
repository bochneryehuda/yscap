#!/usr/bin/env node
'use strict';
/**
 * LT PPE — THE PROGRAM-AUDIT COMMAND'S OWN LOGIC (`src/longterm/ppe/program-audit-command.js`, which
 * `scripts/lt-ppe-program-audit.js` launches).
 *
 * `test-lt-ppe-program-audit.js` proves the DIGEST (src/longterm/ppe/program-audit.js). This proves the
 * COMMAND that runs it against the real catalog — the parts that decide what the run MEANS, which is
 * where a runner goes wrong quietly:
 *
 *  A) IT CANNOT REPORT "ALL CLEAR" HAVING MEASURED NOTHING. The exact failure this codebase keeps
 *     finding is a runner that exits green because it ran nothing — an empty catalog, an empty battery,
 *     a program it could not enumerate. Those produce ZERO findings, which is byte-identical to a clean
 *     run unless the runner itself refuses. Every one of them is proven here to come back not-ok, with
 *     a non-zero exit and a headline that does not read as an all-clear.
 *  B) THE THREE-WAY DEAD-RULE ANSWER. A rule that never fired is reported as one of "the battery tried
 *     it and it never fired" (a real question), "the battery never tried it" (naming the condition
 *     nothing satisfied), or "cannot tell" — never collapsed into one verdict.
 *  C) THE RULE CATALOG IS DERIVED FROM THE PROGRAMS, not kept by hand in the command — so a rule added
 *     to an investor's data document, or a cut added to an overlay table, is audited the day it lands.
 *  D) THE BATTERY IS COMPLETE. Every leg is a full grid; a strided one would make every never-fired
 *     verdict meaningless, so a truncated battery is a hard failure and is proven to be one.
 *  E) IT RUNS FOR REAL against the shipped catalog (on a small battery, for speed).
 *  F) THE LAUNCHER STAYS A LAUNCHER. `scripts/lt-ppe-program-audit.js` must never `require()` Long-Term
 *     code — that is the crossing the product-separation gate exists to catch — so it is proven here to
 *     start the audit as its own process and to import nothing.
 *
 * LT-only. Pure: no database, no network, no clock.
 */

const cmd = require('../src/longterm/ppe/program-audit-command');
const compiledRegistry = require('../src/longterm/ppe/layer-data-registry');
const handWritten = require('../src/longterm/ppe/program-registry');
const { DEEPHAVEN_OVERLAY_CUTS } = require('../src/longterm/ppe/deephaven-overlay-rules');

let pass = 0; let fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } }

console.log('LT PPE — the program-audit COMMAND\n');

// A report shaped exactly like `auditCatalog` returns one, with nothing wrong in it. Used to prove that
// the "measured nothing" refusals are what makes a run fail, not the presence of findings.
function cleanReport(over = {}) {
  const program = {
    investor: 'X', programName: 'X program', source: 'test', sourceModule: 'test',
    declaredCodeCount: 3, notEnumerable: [], anyEnumerable: true,
    digest: { total: 100, eligible: 40, ineligible: 60, layerHitCounts: {}, declineCodeCounts: {} },
    firedCodes: [], overlaysArmed: [], stillFlagged: [], stillUnverifiable: [], observedUndeclared: [],
    findings: [], questions: [], untested: [], cannotTell: [],
    ...(over.program || {}),
  };
  return {
    battery: { total: 100, truncated: false, legs: [] },
    programsAudited: 1,
    scenariosAudited: 100,
    programs: [program],
    ...(over.report || {}),
  };
}

// ---- A) THE MEASURED-NOTHING GUARD -----------------------------------------------------------------
{
  const clean = cmd.verdictOf(cleanReport());
  ok(clean.ok === true && clean.measured === true && clean.exitCode === 0, 'control: a run that measured 100 loans against an enumerable program with nothing wrong is ok, exit 0');

  const noPrograms = cmd.verdictOf({ battery: { total: 500, truncated: false, legs: [] }, programsAudited: 0, scenariosAudited: 500, programs: [] });
  ok(noPrograms.ok === false && noPrograms.measured === false && noPrograms.exitCode === 1, 'AUDITED NOTHING: an empty program catalog is a FAILURE, not a clean run (exit 1)');
  ok(noPrograms.counts.questions === 0 && noPrograms.counts.untested === 0, '…and it fails with ZERO findings — which is the whole point: no findings is exactly what an empty run produces');
  ok(/^THIS RUN DID NOT MEASURE/.test(noPrograms.headline) && !/fired at least once|nothing looks dead/i.test(noPrograms.headline), '…and its headline LEADS with "this run did not measure what it claims to" — it can never read as the all-clear wording');

  const noScenarios = cmd.verdictOf(cleanReport({ report: { scenariosAudited: 0, battery: { total: 0, truncated: false, legs: [] } }, program: { digest: { total: 0, eligible: 0, ineligible: 0, layerHitCounts: {}, declineCodeCounts: {} } } }));
  ok(noScenarios.ok === false && noScenarios.exitCode === 1, 'MEASURED NOTHING: an empty scenario battery is a FAILURE (every rule would look dead and none of it would mean anything)');

  const starved = cmd.verdictOf(cleanReport({ program: { digest: { total: 0, eligible: 0, ineligible: 0, layerHitCounts: {}, declineCodeCounts: {} } } }));
  ok(starved.ok === false && starved.exitCode === 1 && starved.reasons.some((r) => /was handed no scenarios/.test(r)), 'MEASURED NOTHING: a program handed no scenarios fails even when the battery itself is not empty');

  const blind = cmd.verdictOf(cleanReport({ program: { anyEnumerable: false, declaredCodeCount: 0, notEnumerable: [{ layer: 'eligibility', label: 'the eligibility matrix', why: 'code, not data' }] } }));
  ok(blind.ok === false && blind.exitCode === 1 && blind.reasons.some((r) => /NO PROGRAM IN THE CATALOG PUBLISHES A RULE CATALOG/.test(r)), 'CANNOT ANSWER ITS QUESTION: when NO program publishes a rule catalog the run fails — it cannot tell a dead rule from a quiet one');

  const truncated = cmd.verdictOf(cleanReport({ report: { battery: { total: 100, truncated: true, legs: [] } } }));
  ok(truncated.ok === false && truncated.exitCode === 1 && truncated.reasons.some((r) => /CUT SHORT/.test(r)), 'A CUT-SHORT BATTERY IS A FAILURE: a strided battery can skip the very loan that arms a rule');

  // A partly-blind catalog is a LIMITATION, not a failure — but it must never disappear.
  const partly = cmd.verdictOf({
    battery: { total: 100, truncated: false, legs: [] }, programsAudited: 2, scenariosAudited: 100,
    programs: [cleanReport().programs[0], { ...cleanReport().programs[0], anyEnumerable: false, declaredCodeCount: 0 }],
  });
  ok(partly.ok === true && partly.limitations.some((l) => /publishes no rule catalog/.test(l)), 'a catalog where SOME program is un-enumerable still runs, but says so as a limitation — never silently');

  const q = cleanReport();
  q.programs[0].questions = [{ code: 'z', layer: 'eligibility', verdict: 'exercised_but_never_fired' }];
  q.programs[0].findings = q.programs[0].questions;
  ok(cmd.verdictOf(q).ok === false && cmd.verdictOf(q).exitCode === 0, 'an open dead-rule QUESTION is not ok, but does not fail the command by default — a question is for a person, not a gate');
  ok(cmd.verdictOf(q, { strict: true }).exitCode === 1, '…and --strict turns that same question into a non-zero exit');
}

// ---- B) THE THREE-WAY DEAD-RULE ANSWER --------------------------------------------------------------
{
  // A synthetic program shaped exactly like a compiled one: a rule catalog + published triggers.
  //   live_code    — fires in the battery below
  //   dead_code    — every condition it needs is met somewhere, yet it never fires (a real question)
  //   untried_code — needs fico < 500, which NO scenario in the battery has (the battery never tried it)
  //   opaque_code  — publishes no trigger at all (cannot tell)
  const descriptor = {
    investor: 'Syn', programName: 'Syn program',
    pppInputFromFacts: (f) => ({ state: f.state }),
    compiledLayers: {
      eligibility: {
        derivedFacts: {},
        catalog: {
          r_live: { code: 'live_code', declineReason: 'live' },
          r_dead: { code: 'dead_code', declineReason: 'dead' },
          r_untried: { code: 'untried_code', declineReason: 'untried' },
          r_opaque: { code: 'opaque_code', declineReason: 'opaque' },
          r_bound: { role: 'bound' },
        },
        rules: [
          { code: 'r_live', when: { fact: 'fico', op: 'lt', value: 700 } },
          { code: 'r_dead', when: { all: [{ fact: 'fico', op: 'lt', value: 700 }, { fact: 'ltv', op: 'gt', value: 70000 }] } },
          { code: 'r_untried', when: { fact: 'fico', op: 'lt', value: 500 } },
          { code: 'r_opaque', when: null },
          { code: 'r_bound', when: { fact: 'fico', op: 'lt', value: 700 } },
        ],
      },
    },
  };
  const cat = cmd.declaredCodes(descriptor);
  ok(cat.codes.length === 4 && cat.codes.includes('live_code') && !cat.codes.includes(undefined), 'catalog: the four decline codes are enumerated and the BOUND rule (which can never decline) is left out');

  // fico 600 and 800; ltv 60% and 80%. Both of dead_code's conditions are met somewhere (600 < 700, and
  // 80000 > 70000) but the battery is deliberately built so they are never met on the SAME loan.
  const scenarios = [
    { fico: 600, ltv: 60000, state: 'NY' },
    { fico: 800, ltv: 80000, state: 'NY' },
  ];
  const findings = cmd.classifyNeverFired(descriptor, cat, ['dead_code', 'untried_code', 'opaque_code'], scenarios, { truncated: false });
  const by = Object.fromEntries(findings.map((f) => [f.code, f]));

  ok(by.dead_code.verdict === 'exercised_but_never_fired', 'a rule whose every condition the battery met somewhere, yet which never fired, is a QUESTION — "the battery tried it and it never fired"');
  ok(by.untried_code.verdict === 'battery_never_tried_it', 'a rule whose trigger no loan in the battery meets is reported as UNTESTED — "the battery never tried it", not as a dead rule');
  ok(by.untried_code.untried && /fico < 500/.test(JSON.stringify(by.untried_code.untried)), '…and it NAMES the exact condition nothing tried (fico < 500), so widening the battery is a five-second job');
  ok(by.opaque_code.verdict === 'cannot_tell', 'a rule that publishes no trigger we can re-read is "cannot tell" — never rounded down to fine');
  ok(by.dead_code.verdict !== by.untried_code.verdict && by.untried_code.verdict !== by.opaque_code.verdict, 'the three answers are genuinely distinct — a dead rule, an untried one and an unknowable one never collapse into one verdict');

  const cut = cmd.classifyNeverFired(descriptor, cat, ['dead_code', 'untried_code'], scenarios, { truncated: true });
  ok(cut.every((f) => f.verdict === 'cannot_tell'), 'over a CUT-SHORT battery every never-fired verdict degrades to "cannot tell" — a strided grid cannot support a dead-rule claim');
}

// ---- C) THE CATALOG IS DERIVED FROM THE PROGRAMS ----------------------------------------------------
{
  const compiled = compiledRegistry.programFor('Deephaven');
  ok(compiled, 'the compiled Deephaven program resolves out of the layer-data registry');
  const cat = cmd.declaredCodes(compiled);
  ok(cat.layers.eligibility.enumerable && cat.layers.ppp.enumerable && cat.layers.overlay.enumerable, 'all THREE layers of the compiled program publish a rule catalog the audit can hold them to');

  // Derived, never hand-listed: the eligibility codes must be exactly the distinct decline codes in the
  // registered DATA DOCUMENT, so a rule added to that file is audited without touching the command.
  const doc = compiledRegistry.getData('Deephaven', 'eligibility', '2026-08-04').doc;
  const fromDoc = new Set(doc.rules.filter((r) => r.code).map((r) => r.code));
  for (const c of Object.values(doc.grid.codes || {})) fromDoc.add(c);
  const fromCat = new Set(cat.layers.eligibility.codes);
  ok(fromDoc.size === fromCat.size && [...fromDoc].every((c) => fromCat.has(c)), `eligibility: the audited code list IS the data document's own (${fromCat.size} codes) — nothing hand-kept in the command`);

  // Same for the overlay layer: its codes must be exactly the cut table's.
  const fromTable = new Set(DEEPHAVEN_OVERLAY_CUTS.flatMap((g) => (g.cuts || []).map((c) => c.code)));
  const overlayCodes = new Set(cat.layers.overlay.codes);
  ok(fromTable.size === overlayCodes.size && [...fromTable].every((c) => overlayCodes.has(c)), `overlay: the audited code list IS the overlay cut table's own (${overlayCodes.size} cuts) — add a cut and it is audited the same day`);

  const hand = handWritten.programFor('Deephaven');
  const handCat = cmd.declaredCodes(hand);
  ok(handCat.layers.overlay.enumerable === true, 'the hand-written descriptor also carries its overlay cut table, so that layer is enumerable for it too');
  ok(handCat.notEnumerable.length > 0 && handCat.notEnumerable.every((x) => typeof x.why === 'string' && x.why.length > 20), 'a layer the audit CANNOT list is reported with a plain-language reason, never omitted');

  const bare = cmd.declaredCodes({ investor: 'B', programName: 'B' });
  ok(bare.anyEnumerable === false && bare.codes.length === 0 && bare.notEnumerable.length === 3, 'a program that publishes nothing at all is fully un-enumerable — and the audit says so for all three layers');
}

// ---- D) THE BATTERY IS COMPLETE ---------------------------------------------------------------------
{
  const battery = cmd.buildBattery();
  ok(battery.truncated === false, 'every leg of the shipped battery is a FULL grid — nothing strided, so a never-fired verdict off it is trustworthy');
  ok(battery.legs.every((l) => l.size === l.fullSize && l.size > 0), 'each leg audited exactly as many loans as its own full set of combinations');
  ok(battery.total > 100000 && battery.total === battery.legs.reduce((s, l) => s + l.size, 0), `the battery is ${battery.total.toLocaleString('en-US')} loans and the parts add up to the whole`);
  ok(battery.legs.every((l) => typeof l.why === 'string' && l.why.length > 20), 'every leg says in plain words what it is there to exercise');

  const squeezed = cmd.buildBattery(cmd.LEGS, { maxScenarios: 50 });
  ok(squeezed.truncated === true, 'a battery built under a small ceiling comes back marked CUT SHORT rather than silently sampled');
  ok(cmd.verdictOf(cmd.auditCatalog([], squeezed)).exitCode === 1, '…and a run on a cut-short battery exits non-zero');
}

// ---- E) IT RUNS FOR REAL ----------------------------------------------------------------------------
{
  const programs = cmd.catalogPrograms();
  ok(programs.length >= 2 && programs.some((p) => /hand-written/.test(p.source)) && programs.some((p) => /compiled/.test(p.source)), `the catalog is read from BOTH registries (${programs.length} programs: the hand-written descriptors and the ones compiled from data)`);
  ok(programs.every((p) => p.descriptor && typeof p.descriptor.evaluateEligibility === 'function'), 'every catalogued program came back as a real runnable descriptor — none hand-built here');

  // A small but genuine battery: one full leg, so the run is honest and fast.
  const small = cmd.buildBattery([cmd.LEGS.find((l) => l.name === 'property and structure'), cmd.LEGS.find((l) => l.name === 'cash-out proceeds')]);
  const report = cmd.auditCatalog(programs, small);
  const verdict = cmd.verdictOf(report);
  ok(report.programsAudited === programs.length && report.scenariosAudited === small.total, 'the report counts what it actually audited');
  ok(report.programs.every((p) => p.digest.total === small.total && p.digest.eligible + p.digest.ineligible === p.digest.total), 'every program saw every loan, and its eligible + not-eligible add up');
  ok(report.programs.every((p) => p.findings.length === p.questions.length + p.untested.length + p.cannotTell.length), 'every never-fired rule landed in exactly one of the three buckets — none is silently dropped');
  ok(report.programs.some((p) => p.untested.length > 0), 'on this deliberately narrow battery some rules ARE reported untested — the untested branch is reachable, not decoration');
  ok(report.programs.every((p) => p.untested.every((f) => Array.isArray(f.untried) && f.untried.length > 0)), '…and each of those names the conditions the battery never tried');
  // The same investor is in the catalog twice — hand-written and compiled from data. Every loan must get
  // the same answer from both, and the run must SAY whether it did rather than leave it to be assumed.
  ok(report.crossChecks.length === 1 && report.crossChecks[0].investor === 'Deephaven', 'the run cross-checks the two encodings of the same investor against each other');
  ok(report.crossChecks[0].agree === true && report.crossChecks[0].differences.length === 0, `…and on this battery the hand-written and the data-compiled Deephaven programs agree on all ${small.total} loans`);
  const drifted = cmd.crossCheck([
    { investor: 'D', source: 'hand-written', digest: { eligible: 10, declineCodeCounts: { a: 5, b: 1 } } },
    { investor: 'D', source: 'compiled', digest: { eligible: 9, declineCodeCounts: { a: 6, b: 1 } } },
  ]);
  ok(drifted.length === 1 && drifted[0].agree === false && drifted[0].differences.length === 2, 'a drift between the two encodings is reported as a DEFECT with the exact rule and counts that differ');
  ok(cmd.crossCheck([{ investor: 'Solo', source: 'x', digest: { eligible: 1, declineCodeCounts: {} } }]).length === 0, 'an investor encoded only once has nothing to cross-check and produces no noise');

  const text = cmd.renderReport(report, verdict);
  ok(/A QUESTION, NOT A VERDICT/.test(text) && /WHAT ALL OF THIS MEANS, IN PLAIN WORDS/.test(text), 'the printed report frames a never-fired rule as a question and explains itself in plain words');
  ok(/never tried:/.test(text), '…and prints the untried conditions where there are any');
  ok(!/undefined|NaN|\[object Object\]/.test(text), 'the printed report contains no undefined / NaN / [object Object]');
}

// ---- F) THE LAUNCHER STAYS A LAUNCHER ---------------------------------------------------------------
{
  const fs = require('fs');
  const path = require('path');
  const launcherPath = path.join(__dirname, 'lt-ppe-program-audit.js');
  const src = fs.readFileSync(launcherPath, 'utf8');
  // Only lines that are CODE — the header explains the rule and necessarily names the module it must
  // not import, so a guard that read comments would fail on its own explanation.
  const code = src.split('\n').filter((l) => { const t = l.trim(); return t && !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*'); }).join('\n');
  ok(!/require\s*\(\s*['"][^'"]*longterm/.test(code), 'the launcher does not require() Long-Term code — the crossing the product-separation gate exists to catch');
  ok(!/require\s*\(\s*(?!['"])/.test(code), '…and it uses no computed require() either — the point is that there is no crossing, not that the gate cannot see one');
  ok(/spawnSync/.test(code) && /program-audit-command/.test(code), '…it starts the audit as its own process instead');
  ok(/process\.exit\(run\.status/.test(code), '…and passes the audit\'s own exit code through, so a failed audit fails the command');

  const run = require('child_process').spawnSync(process.execPath, [launcherPath, '--json'], { encoding: 'utf8', timeout: 600000 });
  let parsed = null;
  try { parsed = JSON.parse(run.stdout); } catch (_e) { parsed = null; }
  ok(run.status === 0 && parsed && parsed.programsAudited >= 2 && parsed.scenariosAudited > 100000, `the launcher really runs the audit end to end (${parsed ? parsed.scenariosAudited.toLocaleString('en-US') : '?'} loans, exit ${run.status})`);
  ok(parsed && parsed.verdict && parsed.verdict.measured === true, '…and the run it produced genuinely measured something');
}

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
