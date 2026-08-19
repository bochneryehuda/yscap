#!/usr/bin/env node
'use strict';
/**
 * LT PPE — WAS THE PREPAYMENT LAYER ASKED? (§2.116), offline.
 *
 * THE DEFECT. The agreement harness prices a SHEET. A state's prepayment-penalty law lives in the
 * INVESTOR's Layer 3 (`deephaven-ppp-matrix`) and no rate sheet carries a borrower-type rule at all, so
 * a leg built without the investor's descriptor is blind to that whole layer — and blind SILENTLY.
 * #99 handed the descriptor to the agreement RUN ROUTE. **The hand-run paid CLI never got it**, so the
 * two doors have been measuring different engines and every paid run taken from the script has been the
 * blind one.
 *
 * Measured here, against the REAL Deephaven grid and the REAL registry (no network, no database): the
 * battery's own `NJ Individual PPP prohibited` probe is PRICED, on 28 rungs, by a leg with no
 * descriptor — and DECLINED, by name, once the layer is asked. On a live run that scenario came back as
 * "we price it, Lender Price refuses it": a disagreement reported as a sheet defect that was really our
 * own omission.
 *
 * Three things are pinned: the ONE definition of "whose layer, and was it asked" (wording included, so
 * three callers cannot describe the same gap three ways); the MEASUREMENT above, which is what proves
 * the descriptor is load-bearing rather than decorative; and that both doors actually pass it.
 *
 *   node scripts/test-lt-ppe-ppp-layer-asked.js
 */
const fs = require('fs');
const path = require('path');
const registry = require('../src/longterm/ppe/program-registry');
const legs = require('../src/longterm/ppe/lp-agreement-legs');
const { rateSheetToProgram } = require('../src/longterm/ppe/ratesheet');
const { gridToRateSheet } = require('../src/longterm/ppe/deephaven-grid');
const { buildPrepayMaxPriceGrid } = require('../src/longterm/ppe/deephaven-dscr-prepay-maxprice');
const { buildAgreementScenarios } = require('../src/longterm/ppe/agreement-scenarios');
const settings = require('../src/longterm/ppe/settings');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

console.log('LT PPE — was the prepayment layer asked? — offline\n');

// A) ONE definition, and an unasked layer always says WHY.
{
  const asked = registry.pppLayerFor('Deephaven Mortgage');
  ok(asked.asked === true && asked.descriptor && asked.descriptor.investor === 'Deephaven',
    'a registered investor resolves its program, through the same aliases the rest of the PPE uses');
  ok(asked.investor === 'Deephaven Mortgage', '…and reports the name it was ASKED about, not the registered one');

  const none = registry.pppLayerFor('Acme Capital');
  ok(none.asked === false && none.descriptor === null, 'an unregistered investor is NOT quietly given somebody else\'s program');
  ok(none.reason === 'no_registered_program' && /Acme Capital/.test(none.note),
    'the gap NAMES the investor, so it can be acted on');
  const blank = registry.pppLayerFor(null);
  ok(blank.asked === false && blank.reason === 'investor_unknown', 'no investor at all is its OWN reason — a different thing to fix');
  ok(blank.note !== none.note, 'the two gaps never share one sentence');
  ok(registry.pppLayerFor('').reason === 'investor_unknown'
    && registry.pppLayerFor('   ').reason === 'investor_unknown',
    'a blank or whitespace-only investor is no NAME at all — its own gap, not a missing registration');
  // Deliberately NOT asserted as `investor_unknown`: a junk-but-present value IS a name we could not
  // register, and saying so by name ("no program is registered for “0”") is the honest, actionable
  // answer. This assertion was written the other way first and the code was right.
  ok(registry.pppLayerFor(0).reason === 'no_registered_program' && registry.pppLayerFor(0).descriptor === null,
    'a junk investor is named as unregistered — never quietly given a program');
}

// B) THE MEASUREMENT — the descriptor is load-bearing, and this is the scenario it moves.
{
  const program = rateSheetToProgram(gridToRateSheet(buildPrepayMaxPriceGrid()), { code: 'DHVN_DSCR30', investorCode: 'DHVN' });
  const s = settings.resolveAll().values;
  const scenario = buildAgreementScenarios().scenarios.find((x) => x._label === 'NJ Individual PPP prohibited');
  ok(!!scenario && scenario._ineligible === true, 'the battery still carries the NJ probe, and still labels it ineligible');

  const blind = legs.buildOursLeg(program, s, { factsFromLp: true })(scenario);
  ok(blind.eligible === true && Array.isArray(blind.ladder) && blind.ladder.length > 0,
    `WITHOUT the layer our sheet PRICES a loan the state forbids — ${(blind.ladder || []).length} rungs`);

  const layer = registry.pppLayerFor('Deephaven');
  const asked = legs.buildOursLeg(program, s, {
    factsFromLp: true, pppDescriptor: layer.descriptor, onUnresolvedPpp: 'flag',
  })(scenario);
  ok(asked.eligible === false, 'WITH the layer asked, the same scenario is DECLINED');
  const d = (asked.declines || []).find((x) => x && x.source === 'ppp_matrix');
  ok(!!d, '…by the prepayment matrix itself, not by some unrelated rule that happened to fire');
  ok(!!d && /NJ/i.test(d.reason) && /prepayment/i.test(d.reason),
    `…and the refusal says what it is about — got ${d ? JSON.stringify(d.reason).slice(0, 90) : 'nothing'}`);
  ok(!!d && d.citation, '…with the investor document it comes from, so it can be checked');

  // The layer must not be a blunt instrument: the SAME sheet, same investor, an ordinary NY scenario is
  // untouched by asking. A descriptor that declined everything would also make section B pass.
  const ny = buildAgreementScenarios().scenarios.find((x) => x._group === 'ficoxcltv');
  const nyBlind = legs.buildOursLeg(program, s, { factsFromLp: true })(ny);
  const nyAsked = legs.buildOursLeg(program, s, { factsFromLp: true, pppDescriptor: layer.descriptor, onUnresolvedPpp: 'flag' })(ny);
  ok(nyBlind.eligible === true && nyAsked.eligible === true, 'an ordinary scenario is still priced once the layer is asked');
  ok(JSON.stringify(nyBlind.ladder) === JSON.stringify(nyAsked.ladder),
    'and its ladder is BYTE-IDENTICAL — asking the layer changes the loans it governs and nothing else');
}

// C) BOTH DOORS ASK IT, through the one definition. The measurement above is what proves the option is
// load-bearing; this is what proves each door passes one. Keyed on the `buildOursLeg` CALL, because the
// defect is exactly an option missing from that call — not on how many times a file mentions a word.
{
  const cli = read('scripts/test-lt-lp-agreement-run.js');
  const call = cli.slice(cli.indexOf('legs.buildOursLeg('));
  const callBody = call.slice(0, call.indexOf('});') + 3);
  ok(/pppDescriptor/.test(callBody), 'the paid CLI hands buildOursLeg a prepayment descriptor');
  ok(/onUnresolvedPpp/.test(callBody), '…and asks for an unresolved answer to be FLAGGED, never guessed');
  ok(/pppLayerFor\(/.test(cli), '…resolved through the ONE definition, not a private lookup');
  ok(!/programRegistry\.programFor\(/.test(cli), '…and it does not re-inline the registry lookup beside it');

  const route = read('src/longterm/routes/ppe.js');
  ok(!/programRegistry\.programFor\(investorName\)/.test(route),
    'the route no longer builds the layer itself — both doors read the same definition');
  const layerUses = (route.match(/pppLayerFor\(/g) || []).length;
  ok(layerUses >= 3, `every route site that needs the layer asks for it — found ${layerUses}`);
  ok(!/reason: investorName \? 'no_registered_program'/.test(route),
    'the route\'s hand-written copy of the wording is gone — one sentence, one home');
}

console.log(`\n${failures ? failures + ' FAILED' : 'all passed'}`);
process.exit(failures ? 1 : 0);

/* ---------------------------------------------------------------------------------------------
 * MUTATION LOG — each applied on its own, unmutated control green either side.
 *   M1  pppLayerFor: return the descriptor for any investor       → A fails (somebody else's program)
 *   M2  pppLayerFor: one note for both gaps                       → A fails (two problems, one sentence)
 *   M3  the CLI's buildOursLeg call: drop `pppDescriptor`         → C fails — the EXACT pre-fix state
 *   M4  route: restore the inline programFor + hand-written note  → C fails (the second copy back)
 *   M5  lp-agreement-legs: ignore opts.pppDescriptor              → B fails (the option decorative)
 * ------------------------------------------------------------------------------------------- */
