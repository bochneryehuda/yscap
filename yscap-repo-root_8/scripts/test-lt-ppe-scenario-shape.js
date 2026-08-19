'use strict';
/**
 * LT PPE — THE SCENARIO-SHAPE CONTRACT OF THE TWO PRICING DOORS (§2.123).
 *
 * THE DEFECT CLASS THIS SUITE EXISTS FOR. Two functions in this codebase take a parameter called
 * `scenario` and mean OPPOSITE things by it:
 *   · `lp.price(scenario)` / `search-model.validateScenario` — a LENDER PRICE scenario: `value`,
 *     `loan`, `dscr` as a RATIO (1.25), `zip`, `propertyType` in the vendor's words.
 *   · `quote.quoteProgram({ scenario })` — ENGINE FACTS: `loan_amount`, `ltv` and `dscr` in MILLI,
 *     `occupancy` in the engine's words, plus ~30 facts `lpScenarioToFacts` derives.
 * Handing one object to both is silent: every function involved is a scenario-taking function that
 * returns an object, so the wiring reads as correct and the wrong answer looks like a verdict. It has
 * now been found three times — the canary's `theirs` leg (§2.106), the canary's `ours` leg (§2.122),
 * and the live `/quote` shadow (§2.123). Section D is the guard that makes a fourth impossible to
 * merge: no route may hand ONE identifier to BOTH engines.
 *
 * Everything here is MEASURED against the real modules — the real battery, the real Deephaven sheet,
 * the real validator, the real route source. Nothing is asserted from reading the code.
 *
 * PURE: no database, no network, no Lender Price session. LT-only.
 */

const fs = require('fs');
const path = require('path');
const searchModel = require('../src/longterm/lenderprice/search-model');
const legs = require('../src/longterm/ppe/lp-agreement-legs');
const quote = require('../src/longterm/ppe/quote');
const { rateSheetToProgram } = require('../src/longterm/ppe/ratesheet');
const { gridToRateSheet } = require('../src/longterm/ppe/deephaven-grid');
const { buildDeephavenGrid } = require('../src/longterm/ppe/deephaven-dscr-sheet');
const settingsMod = require('../src/longterm/ppe/settings');
const { buildAgreementScenarios } = require('../src/longterm/ppe/agreement-scenarios');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures += 1; }
function attemptSync(fn) { try { return fn(); } catch (e) { console.log(`  (threw: ${String((e && e.message) || e).slice(0, 110)})`); return null; } }

const ROUTE_PATH = path.join(__dirname, '..', 'src', 'longterm', 'routes', 'ppe.js');
const RAW_ROUTE = fs.readFileSync(ROUTE_PATH, 'utf8');
// Comments are stripped for every SOURCE assertion below. A guard that can be satisfied by a comment
// is a guard that goes green the day somebody writes the pattern out to explain why it is wrong —
// which is precisely what the headers in that file now do, at length.
const ROUTE = RAW_ROUTE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const settings = settingsMod.resolveAll().values;
const program = rateSheetToProgram(gridToRateSheet(buildDeephavenGrid()),
  { code: 'DHVN_DSCR30', name: 'Deephaven DSCR 30yr', investorCode: 'DHVN' });
const battery = buildAgreementScenarios().scenarios;

console.log('\n=== A. the two vocabularies are not interchangeable — measured against the real validator ===\n');

function bare(s) { const { _label, _group, _ineligible, ...rest } = s; return rest; }

const lpOne = bare(battery[0]);
const vLp = attemptSync(() => searchModel.validateScenario(lpOne));
ok(vLp && vLp.ok === true, 'A1 a battery scenario IS a Lender Price scenario — validateScenario accepts it');

const factsOne = attemptSync(() => legs.lpScenarioToFacts(lpOne));
const vFacts = factsOne ? attemptSync(() => searchModel.validateScenario(factsOne)) : null;
ok(vFacts && vFacts.ok === false, 'A2 the SAME deal as engine facts is REFUSED by Lender Price — the two shapes are not interchangeable');
if (vFacts && !vFacts.ok) console.log(`      (Lender Price refuses the facts form with: ${vFacts.error} — ${String(vFacts.message || '').slice(0, 90)})`);

// The pricing-transparency screen's OWN field vocabulary, typed exactly as its hints instruct
// ("LTV milli-% (72500 = 72.5%)", "DSCR milli (1200 = 1.20)"). This is the body the shadow-compare
// control has been posting to /quote.
const SCREEN_BODY = {
  fico: 740, ltv: 72500, dscr: 1200, loan_amount: 400000,
  purpose: 'purchase', occupancy: 'investment', property_type: 'sfr',
};
const vScreen = attemptSync(() => searchModel.validateScenario(SCREEN_BODY));
ok(vScreen && vScreen.ok === false, 'A3 the transparency screen\'s own body is REFUSED by Lender Price — so the shadow control has never compared anything');
const vScreenZip = attemptSync(() => searchModel.validateScenario({ ...SCREEN_BODY, zip: '11211' }));
ok(vScreenZip && vScreenZip.ok === false, 'A4 …and adding the one field it is missing does not rescue it — the VALUES are the vendor\'s too');
if (vScreenZip && !vScreenZip.ok) console.log(`      (with a ZIP it still fails: ${vScreenZip.error} on "${vScreenZip.field}")`);

// The failure is FAIL-CLOSED, and that matters: a milli DSCR silently read as a ratio would have
// priced a phantom deal at the vendor's expense rather than refusing.
const vMilliDscr = attemptSync(() => searchModel.validateScenario({ ...lpOne, dscr: 1250 }));
ok(vMilliDscr && vMilliDscr.ok === false && vMilliDscr.field === 'dscr',
  'A5 a MILLI dscr in an otherwise valid Lender Price scenario is refused on the dscr field — it fails closed, it does not price a phantom');

console.log('\n=== B. what the wrong shape does to our own engine — measured over the whole battery ===\n');

function tally(mk) {
  let el = 0; let inel = 0; let err = 0; let unknown = 0; let named = 0;
  for (const s of battery) {
    let q;
    try { q = quote.quoteProgram({ scenario: mk(s), program, settings }); } catch (_) { err += 1; continue; }
    if (q && q.eligible) el += 1; else inel += 1;
    if (q && Array.isArray(q.unknownFacts) && q.unknownFacts.length) unknown += 1;
    if (q && !q.eligible && Array.isArray(q.declines) && q.declines.length) named += 1;
  }
  return { el, inel, err, unknown, named };
}

const raw = attemptSync(() => tally((s) => s));
const conv = attemptSync(() => tally((s) => legs.lpScenarioToFacts(s)));
ok(battery.length === 305, `B1 the canonical battery is ${battery.length} scenarios`);
ok(raw && raw.el === 0, `B2 the RAW Lender Price scenario prices ${raw ? raw.el : '?'} of ${battery.length} against the Deephaven sheet`);
ok(conv && conv.el > 250, `B3 the SAME deals as engine facts price ${conv ? conv.el : '?'} of ${battery.length}`);
ok(raw && raw.unknown === battery.length, `B4 every one of the ${battery.length} raw quotes could not read at least one fact it needed (${raw ? raw.unknown : '?'} of ${battery.length})`);
ok(conv && conv.unknown === 0, `B5 …and the converted form leaves ${conv ? conv.unknown : '?'} scenarios with an unreadable fact`);
// The sharp part: the raw form does not fall silent, it DECIDES. A blank refusal would at least look
// broken; a refusal that names one rule reads like a verdict.
ok(raw && raw.named === raw.inel && raw.inel > 0,
  `B6 all ${raw ? raw.inel : '?'} raw declines NAME a sheet rule — a confidently wrong reason, not a blank one, which is why this was invisible`);

console.log('\n=== C. the doors declare their shape, and the source agrees with the declaration ===\n');

function fnBody(name) {
  const i = ROUTE.indexOf(`async function ${name}(`);
  if (i === -1) return '';
  const j = ROUTE.indexOf('\n}\n', i);
  return j === -1 ? ROUTE.slice(i) : ROUTE.slice(i, j);
}

const quoteBody = fnBody('quoteRoute');
const bdBody = fnBody('breakdownRoute');
ok(quoteBody.length > 500 && bdBody.length > 500, 'C1 both route bodies were located in the source');

ok(/lp\.price\(scenario\)/.test(quoteBody) || /priceLp:\s*\(sc\)\s*=>\s*lp\.price\(sc\)/.test(quoteBody),
  'C2 /quote posts the body scenario to Lender Price — so its contract IS the Lender Price shape');
ok(/searchModel\.validateScenario\(scenario\)/.test(quoteBody),
  'C3 …and it says so at the door, with Lender Price\'s OWN validator, before it prices anything');
ok(/buildOursLeg\(program, settings, \{[\s\S]{0,200}factsFromLp: true/.test(quoteBody),
  'C4 …and our engine\'s leg converts that scenario to facts through the one shared definition (§2.123)');
ok(!/quote\.quoteProgram\(/.test(quoteBody),
  'C5 …and /quote no longer prices through a hand-wired quoteProgram call at all');

ok(!/lp\.price\(scenario\)/.test(bdBody),
  'C6 /breakdown never posts the body scenario to Lender Price — it is an ENGINE-FACTS door');
ok(/quote\.quoteProgram\(\{ scenario, program, settings, marginHoldback: marginFor\(scenario\) \}\)/.test(bdBody),
  'C7 …and it prices those facts directly, which is correct for facts and only for facts');
ok(/THIS DOOR TAKES ENGINE FACTS/.test(RAW_ROUTE) && /THIS DOOR TAKES A LENDER PRICE SCENARIO/.test(RAW_ROUTE),
  'C8 both doors state their vocabulary in their own header — the parameter name says `scenario` on both');

console.log('\n=== D. THE CLASS GUARD — no route may hand ONE object to BOTH engines ===\n');

// An object cannot be both shapes, so a name handed to Lender Price AND to our engine is this defect,
// whichever way round it was written.
//
// THE SCAN IS PER FUNCTION, NOT PER FILE, and the first draft of this guard was not — it collected
// every name in the file and intersected the two sets, which reported `/breakdown`'s own `scenario`
// (engine facts, correct) as colliding with `/quote`'s `scenario` (a Lender Price scenario, also
// correct) purely because two unrelated locals share a common noun. A guard that fires on a name
// collision it cannot distinguish from the real thing trains a reader to ignore it, so it is scoped
// to the function body where an actual variable lives.
function fnSpans(src) {
  const spans = [];
  const rx = /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  const starts = [];
  while ((m = rx.exec(src)) !== null) starts.push({ name: m[1], at: m.index });
  for (let i = 0; i < starts.length; i += 1) {
    const from = starts[i].at;
    const to = i + 1 < starts.length ? starts[i + 1].at : src.length;
    spans.push({ name: starts[i].name, body: src.slice(from, to) });
  }
  return spans;
}
function namesIn(body, re) {
  const out = new Set();
  const rx = new RegExp(re.source, 'g');
  let m;
  while ((m = rx.exec(body)) !== null) out.add(m[1]);
  return out;
}
// `{ scenario }` and `{ scenario, program }` are the SHORTHAND for `scenario: scenario` and name the
// same variable without spelling it twice — so the pattern reads the explicit and the shorthand form.
// An INDEXED argument (`scenario: scenarios[i]`, the coverage profiler's sweep) is read as the array
// it indexes: every element of a list handed to our engine has that list's shape, so the collision
// question is asked of the name, not of the element.
const OURS_RE = /quote\.quoteProgram\(\{\s*scenario(?::\s*([A-Za-z_$][\w$]*)(?:\[[^\]]*\])?)?\s*[,}]/;
const LP_RE = /lp\.price\(\s*([A-Za-z_$][\w$]*)\s*\)/;

const spans = fnSpans(ROUTE);
let lpSites = 0; let oursSites = 0;
const collisions = [];
for (const sp of spans) {
  const toLp = namesIn(sp.body, LP_RE);
  const toOurs = new Set();
  const rx = new RegExp(OURS_RE.source, 'g');
  let m;
  while ((m = rx.exec(sp.body)) !== null) toOurs.add(m[1] || 'scenario');
  lpSites += toLp.size; oursSites += toOurs.size;
  for (const n of toLp) if (toOurs.has(n)) collisions.push(`${sp.name}(): ${n}`);
  if (toLp.size || toOurs.size) {
    console.log(`      ${sp.name}(): lp.price(${[...toLp].join(', ') || '—'})  quoteProgram(${[...toOurs].join(', ') || '—'})`);
  }
}
ok(spans.length > 20, `D1 the scan walked ${spans.length} route functions — it is not passing by finding nothing`);
ok(lpSites > 0 && oursSites > 0, `D2 …and found ${lpSites} Lender Price call site(s) and ${oursSites} direct engine call site(s) to check`);
ok(collisions.length === 0, `D3 no function hands ONE name to BOTH engines${collisions.length ? ` — found: ${collisions.join('; ')}` : ''}`);
// The guard must be able to SEE the defect it is named for. This reconstructs §2.122/§2.123's exact
// wiring in a throwaway string and requires the scan to catch it — a guard nobody has ever watched
// fail is a guard nobody knows the shape of.
const PLANTED = 'async function plantedRoute(req, res) {\n  const scenario = req.body.scenario;\n  const a = await lp.price(scenario);\n  const b = quote.quoteProgram({ scenario, program, settings });\n  return [a, b];\n}\n';
const plantedSpans = fnSpans(PLANTED);
let caught = false;
for (const sp of plantedSpans) {
  const toLp = namesIn(sp.body, LP_RE);
  const rx2 = new RegExp(OURS_RE.source, 'g');
  let mm; const toOurs = new Set();
  while ((mm = rx2.exec(sp.body)) !== null) toOurs.add(mm[1] || 'scenario');
  for (const n of toLp) if (toOurs.has(n)) caught = true;
}
ok(caught, 'D4 …and the scan DOES catch the defect when it is planted — including the `{ scenario }` shorthand');

console.log('\n=== E. the one converting definition, and no second copy of it ===\n');

const legOffsets = [];
for (let i = ROUTE.indexOf('buildOursLeg('); i !== -1; i = ROUTE.indexOf('buildOursLeg(', i + 1)) legOffsets.push(i);
ok(legOffsets.length === 5, `E1 ${legOffsets.length} legs are built from buildOursLeg — the agreement run, the pre-flight, the review sweep, the canary (§2.122) and /quote (§2.123)`);
ok(legOffsets.every((i) => /factsFromLp: true/.test(ROUTE.slice(i, i + 700))),
  'E2 …and every one of them converts the Lender Price scenario rather than trusting its shape');
ok(!/lpScenarioToFacts\(/.test(ROUTE.replace(/factsOf: lpAgreementLegs\.lpScenarioToFacts/g, '')),
  'E3 no route converts by hand — the conversion happens inside the leg, so there is one definition of it');

console.log('\n=== F. the coverage profiler is NOT this defect — its scenarios are facts by construction ===\n');

const genSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'longterm', 'ppe', 'agreement-scenario-generator.js'), 'utf8');
ok(/the scenario is a flat bag of facts in the engine's integer units/.test(genSrc),
  'F1 the per-program generator documents that it emits ENGINE FACTS');
const gen = require('../src/longterm/ppe/agreement-scenario-generator');
const built = attemptSync(() => gen.buildProgramAgreementScenarios({ program, opts: { maxScenarios: 40 } }));
const genScs = built && Array.isArray(built.scenarios) ? built.scenarios : [];
ok(genScs.length > 0, `F2 …and it generated ${genScs.length} of them to check that claim against`);
const genRejected = genScs.filter((s) => { const v = attemptSync(() => searchModel.validateScenario(s)); return v && v.ok === false; }).length;
ok(genScs.length > 0 && genRejected === genScs.length,
  `F3 Lender Price refuses ${genRejected} of ${genScs.length} generated scenarios — they are facts, so the profiler pricing them directly is correct`);

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`);
process.exit(failures === 0 ? 0 : 1);
