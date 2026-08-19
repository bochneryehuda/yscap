'use strict';
/**
 * LT PPE — A QUOTE ANSWERS IN THREE STATES, AND EVERY CONSUMER MUST ASK FOR ALL THREE (§2.124).
 *
 * THE DEFECT CLASS. `quoteProgram` returns `priced`, `declined`, or — since §2.108 — INCOMPLETE: a
 * scenario whose price-bearing facts it could not read. `incompleteQuote` is built to say so
 * (`priced:false`, `incomplete:true`, a reason, and NO `ladder` key). But it carries `eligible`
 * UNCHANGED, deliberately, because refusing to price is not a decline and inventing one would
 * fabricate a refusal we never made. So a consumer reading `q.eligible` ALONE reads "I could not
 * tell" as a confident "yes".
 *
 * MEASURED, on a scenario LENDER PRICE ITSELF ACCEPTS: `parity-detectors` reported, at HIGH
 * severity, "Lender Price declined this program; our engine priced it" about a quote our engine had
 * explicitly refused to price. That sentence lands in the findings ledger and in the agreement rate
 * the go-live gate reads.
 *
 * AND THE HALF-FIX IS ITS OWN DEFECT: suppressing that finding without abstaining turns the same
 * scenario into `verdict:'agree'` — a confidently wrong agreement in place of a confidently wrong
 * disagreement. Section C pins BOTH.
 *
 * PURE: no database, no network. LT-only.
 */

const fs = require('fs');
const path = require('path');
const verdict = require('../src/longterm/ppe/quote-verdict');
const quote = require('../src/longterm/ppe/quote');
const legs = require('../src/longterm/ppe/lp-agreement-legs');
const detectors = require('../src/longterm/ppe/parity-detectors');
const breakdown = require('../src/longterm/ppe/pricing-breakdown');
const registry = require('../src/longterm/ppe/program-registry');
const searchModel = require('../src/longterm/lenderprice/search-model');
const { rateSheetToProgram } = require('../src/longterm/ppe/ratesheet');
const { gridToRateSheet } = require('../src/longterm/ppe/deephaven-grid');
const { buildDeephavenGrid } = require('../src/longterm/ppe/deephaven-dscr-sheet');
const settingsMod = require('../src/longterm/ppe/settings');
const { buildAgreementScenarios } = require('../src/longterm/ppe/agreement-scenarios');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures += 1; }
function attempt(fn) { try { return fn(); } catch (e) { console.log(`  (threw: ${String((e && e.message) || e).slice(0, 110)})`); return null; } }

const settings = settingsMod.resolveAll().values;
const program = rateSheetToProgram(gridToRateSheet(buildDeephavenGrid()),
  { code: 'DHVN_DSCR30', name: 'Deephaven DSCR 30yr', investorCode: 'DHVN' });
const { _label, _group, _ineligible, ...FULL_LP } = buildAgreementScenarios().scenarios.filter((s) => !s._ineligible)[0];

console.log('\n=== A. the three-valued reading, and what it does with anything it cannot recognise ===\n');

ok(verdict.verdictOf({ eligible: true, ladder: [{ rate: 6125 }] }) === 'priced',
  'A1 a quote with a ladder behind it reads as PRICED');
ok(verdict.verdictOf({ eligible: false, declines: [{ code: 'x' }] }) === 'declined',
  'A2 a quote an eligibility rule refused reads as DECLINED');
ok(verdict.verdictOf({ eligible: true, priced: false, incomplete: true, reason: 'missing_price_bearing_fact' }) === 'undetermined',
  'A3 THE ONE THAT MATTERS: `eligible:true` with `priced:false` reads as UNDETERMINED, never as a yes');
ok(verdict.verdictOf(null) === 'undetermined' && verdict.verdictOf(undefined) === 'undetermined'
   && verdict.verdictOf({}) === 'undetermined' && verdict.verdictOf('nonsense') === 'undetermined',
  'A4 …and anything it cannot recognise falls to UNDETERMINED — an unreadable quote is never scored either way');
ok(verdict.pricedAnswer({ eligible: true, priced: false, incomplete: true }) === false
   && verdict.pricedAnswer({ eligible: true }) === true
   && verdict.pricedAnswer({ eligible: false }) === false,
  'A5 `pricedAnswer` is "we actually priced it", not "the eligible flag is set"');
ok(verdict.couldNotPrice({ priced: false }) === true && verdict.couldNotPrice({ incomplete: true }) === true
   && verdict.couldNotPrice({ eligible: false }) === false,
  'A6 `couldNotPrice` reads EITHER stamp — a declined quote is an ANSWER and is never confused with an absent one');

console.log('\n=== B. it is reachable through the live door — Lender Price accepts the scenario ===\n');

const sparse = { ...FULL_LP }; delete sparse.dscr;
const vLp = attempt(() => searchModel.validateScenario(sparse));
ok(vLp && vLp.ok === true,
  'B1 an LP scenario carrying no `dscr` is ACCEPTED by Lender Price\'s own validator — so a caller can send one');
const q = attempt(() => quote.quoteProgram({ scenario: legs.lpScenarioToFacts(sparse), program, settings }));
ok(q && q.priced === false && q.incomplete === true,
  `B2 …and our engine refuses to price it, saying so: ${q && q.reason}`);
ok(q && q.eligible === true,
  'B3 …while `eligible` stays TRUE — deliberate (refusing to price is not a decline), and exactly the trap');
ok(q && q.ladder === undefined,
  'B4 …and there is NO ladder key at all, so a caller reading `q.ladder` fails loudly rather than seeing an empty one');
ok(verdict.verdictOf(q) === 'undetermined', 'B5 …and the one reading calls it what it is');
const qFull = attempt(() => quote.quoteProgram({ scenario: legs.lpScenarioToFacts(FULL_LP), program, settings }));
ok(qFull && verdict.verdictOf(qFull) === 'priced',
  'B6 CONTROL: the same deal WITH its dscr prices normally — the refusal is about the missing fact, not the sheet');

console.log('\n=== C. every consumer, and the half-fix that would have been its own defect ===\n');

const lpDeclined = { declined: [{ program: 'DHVN', reasons: [{ rule: 'dhvn_min_dscr', text: 'Minimum DSCR' }] }] };
const d = attempt(() => detectors.detectDifferences({ ours: q, lp: { eligible: false, rungs: [] }, lpDisqualified: lpDeclined }));
ok(d && !(d.differences || []).some((x) => /our engine priced it/.test(x.detail || '')),
  'C1 the parity detectors no longer claim "our engine priced it" about a quote it refused to price');
ok(d && d.verdict === 'incomparable' && d.incomparable === true,
  `C2 …AND they do not call it agreement either — they ABSTAIN (verdict: ${d && d.verdict}). Trading a wrong `
  + 'disagreement for a wrong agreement is not a fix');
ok(d && typeof d.reason === 'string' && /missing_price_bearing_fact/.test(d.reason),
  'C3 …carrying the ENGINE\'S OWN reason, so the scenario is visible as unmeasured rather than silently dropped');

const dPriced = attempt(() => detectors.detectDifferences({ ours: qFull, lp: { eligible: false, rungs: [] }, lpDisqualified: lpDeclined }));
ok(dPriced && dPriced.verdict === 'disagree'
   && (dPriced.differences || []).some((x) => /our engine priced it/.test(x.detail || '')),
  'C4 CONTROL: on a quote we DID price, the same finding still fires — the abstain narrowed nothing else');

const bd = attempt(() => breakdown.buildPricingBreakdown({ quote: q }));
ok(bd && bd.eligible === null,
  'C5 the transparency breakdown renders it as UNKNOWN, not as eligible — it must not tell a reader we would do a loan we never assessed');
const bdFull = attempt(() => breakdown.buildPricingBreakdown({ quote: qFull }));
ok(bdFull && bdFull.eligible === true, 'C6 CONTROL: a priced quote still renders as eligible');

const ppp = registry.pppLayerFor('Deephaven');
const leg = legs.buildOursLeg(program, settings, {
  factsFromLp: true,
  pppDescriptor: ppp.descriptor,
  ...(ppp.descriptor ? { onUnresolvedPpp: 'decline' } : {}),
});
const viaLeg = attempt(() => leg(sparse));
ok(viaLeg && viaLeg.incomplete === true && !(viaLeg.declines || []).some((x) => x.source === 'ppp_matrix'),
  'C7 the prepayment layer is never asked about a quote we could not price — a state-law decline as THE reason '
  + 'on a loan we never assessed is a fabricated refusal');

console.log('\n=== D. THE GUARD — no consumer may read `.eligible` on a quote without asking ===\n');

const FILES = [
  'src/longterm/ppe/parity-detectors.js',
  'src/longterm/ppe/pricing-breakdown.js',
  'src/longterm/ppe/lp-agreement-legs.js',
];
let asks = 0;
for (const f of FILES) {
  const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const uses = /quoteVerdict\.(pricedAnswer|couldNotPrice|verdictOf)\(/.test(src);
  ok(uses, `D1 ${path.basename(f)} asks the shared reading rather than testing the flag itself`);
  if (uses) asks += 1;
}
ok(asks === FILES.length, `D2 …all ${FILES.length} of them`);

// The definition lives in ONE place. `quote.js` re-exports it so existing callers are unchanged, and
// the small module has no requires so a PURE consumer can ask without pulling in the pricing engine.
const vSrc = fs.readFileSync(path.join(__dirname, '..', 'src/longterm/ppe/quote-verdict.js'), 'utf8');
ok(!/^\s*(const|let|var).*=\s*require\(/m.test(vSrc.replace(/\/\*[\s\S]*?\*\//g, '')),
  'D3 the definition module has NO requires — which is what lets the pure parity-detectors ask it at all');
ok(quote.verdictOf === verdict.verdictOf && quote.pricedAnswer === verdict.pricedAnswer
   && quote.couldNotPrice === verdict.couldNotPrice,
  'D4 `quote` re-exports the SAME functions, never a second copy — one definition, two doors to it');

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`);
process.exit(failures === 0 ? 0 : 1);
