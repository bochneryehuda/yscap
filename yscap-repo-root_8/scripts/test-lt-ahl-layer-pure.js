#!/usr/bin/env node
'use strict';
/**
 * AHL — the additional layer changes ONE investor and nothing else (pure, offline).
 *
 * THE OWNER'S CONSTRAINT IS THE TEST. *"Add this as an additional layer only for
 * this investor."* The failure that instruction is protecting against is not a
 * crash — it is an AHL integration that quietly reshuffles, re-elects or
 * re-prices some OTHER investor's row, which nobody would notice until a
 * borrower was quoted from it. So the central assertion here is a byte-for-byte
 * comparison of every other investor's row before and after the layer runs.
 *
 * PROVEN TO FAIL: let the layer touch `chosen`/`electionBasis` and ISOLATE-2
 * goes red; graft a board before the holdback and HOLDBACK-1 goes red; let
 * `both` sweep AHL in and ROUTE-3 goes red; drop the AHL fingerprint fields from
 * the strip list and STRIP-1 goes red; count declined programs as offers and
 * PRESENT-2 goes red.
 *
 * LT-only. No network, no DB, no RTL imports.
 */
const fs = require('fs');
const path = require('path');
const parse = require('../src/longterm/ahl/parse');
const layer = require('../src/longterm/pricing/ahl-layer');
const margin = require('../src/longterm/pricing/vendor-margin');
const routing = require('../src/longterm/pricing/investor-routing');
const settings = require('../src/longterm/pricing/investor-settings');
const quoteShape = require('../src/longterm/pricing/quote-shape');
const captured = require('../src/longterm/ahl/capture/legs.json');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass += 1; console.log(`  ok   ${msg}`); } else { fail += 1; console.log(`  FAIL ${msg}`); } }
const CAP = path.join(__dirname, '..', 'src', 'longterm', 'ahl', 'capture');
const boardFor = (k) => parse.parse(fs.readFileSync(path.join(CAP, captured.legs[k].file), 'utf8'), captured.legs[k].leg);
const rawBoard = () => parse.mergeLegs(Object.keys(captured.legs).map(boardFor));

/** A merged board with two ordinary investors on it, standing in for the real merge. */
function mergedFixture() {
  const prog = (src, rate, price) => ({ source: src, lender: 'X', investor: 'X', program: 'P', rungs: [{ rate, price, points: 100 - price, lockDays: 30 }], rungCount: 1 });
  return {
    sources: { lenderprice: { answered: true, programCount: 2 }, loannex: { answered: true, programCount: 1 } },
    summary: { investorCount: 2, inBoth: 1 },
    investors: [
      { key: 'deephaven', investor: 'Deephaven Mortgage LLC', whiteLabel: 'Sterling', presentIn: ['lenderprice', 'loannex'], chosen: 'loannex', electionBasis: 'better_execution', reason: 'r', comparison: { comparedPoints: 1 }, best: { lenderprice: { rate: 7 }, loannex: { rate: 6.9 } }, programCounts: { lenderprice: 1, loannex: 1 }, programs: { lenderprice: [prog('lenderprice', 7, 99)], loannex: [prog('loannex', 6.9, 99.5)] } },
      { key: 'acra', investor: 'Acra Lending', whiteLabel: 'Summit', presentIn: ['loannex'], chosen: 'loannex', electionBasis: 'only_source', reason: 'r', comparison: null, best: { lenderprice: null, loannex: { rate: 7.1 } }, programCounts: { lenderprice: 0, loannex: 1 }, programs: { lenderprice: [], loannex: [prog('loannex', 7.1, 98) ] } },
    ],
    unmapped: [],
  };
}

(async () => {
  console.log('\nAHL — an additional layer, for one investor\n');

  const held = margin.applyToBoard(rawBoard(), 'ahl');

  // ── The holdback ────────────────────────────────────────────────────────
  {
    let refused = false;
    try { layer.applyAhlLayer(mergedFixture(), rawBoard()); } catch (e) { refused = e.code === 'holdback_not_applied'; }
    ok(refused, 'HOLDBACK-1 a RAW AHL board is refused by the layer — grafting it would show 0.25 of better execution than the board is entitled to, silently');
    ok(held.marginHoldback === 0.25 && held.marginHoldbackOrigin === 'default',
      `HOLDBACK-2 the owner's 0.25 pre-fill is what a board with no setting gets (${held.marginHoldback}, ${held.marginHoldbackOrigin})`);
    const p = held.programs.find((x) => x.rungCount > 0);
    const r = p.rungs[0];
    ok(Math.abs((r.vendorPrice - 0.25) - r.price) < 1e-9,
      `HOLDBACK-3 the price moved down by exactly the holdback (vendor ${r.vendorPrice} → ${r.price}) and the vendor's own number is still there`);
    ok(Math.abs((r.price + r.points) - 100) < 1e-9,
      'HOLDBACK-4 points were SHIFTED with the price, so the row does not contradict itself by a thousandth');
    const twice = margin.applyToBoard(held, 'ahl');
    const pricedAt = (b) => b.programs.find((x) => x.rungCount > 0).rungs[0].price;
    ok(pricedAt(twice) === pricedAt(held),
      'HOLDBACK-5 applying it a second time is a no-op — a holdback taken in two places is a holdback taken twice');
    const removed = margin.applyToBoard(rawBoard(), 'ahl', { saved: 0 });
    ok(removed.marginHoldback === 0 && removed.marginHoldbackOrigin === 'setting',
      'HOLDBACK-6 it can be REMOVED, and a deliberate zero is stamped as a decision rather than looking like a failure to load');
    const typo = margin.applyToBoard(rawBoard(), 'ahl', { saved: 25 });
    ok(typo.marginHoldback === 0.25 && typo.marginHoldbackProblem && typo.marginHoldbackProblem.error === 'too_large',
      'HOLDBACK-7 a slipped decimal keeps the standing 0.25 and SAYS it was refused — this setting fails toward the owner\'s number, never toward zero');
  }

  // ── Isolation: nothing but American Heritage moves ──────────────────────
  {
    const before = mergedFixture();
    const snapshot = JSON.stringify(before.investors);
    const after = layer.applyAhlLayer(before, held);
    ok(JSON.stringify(before.investors) === snapshot, 'ISOLATE-1 the input board is not mutated');
    const others = after.investors.filter((e) => e.key !== layer.AHL_INVESTOR_KEY);
    ok(JSON.stringify(others.map((e) => ({ ...e }))) === JSON.stringify(before.investors.map((e) => ({ ...e }))),
      'ISOLATE-2 every other investor\'s row is byte-for-byte what it was — the layer is additive, not a re-merge');
    const ahl = after.investors.find((e) => e.key === layer.AHL_INVESTOR_KEY);
    ok(ahl && ahl.chosen == null && ahl.electionBasis == null && ahl.comparison == null,
      'ISOLATE-3 AHL is not "elected" against anything — it prices one counterparty, so an election would be a verdict with one candidate');
    ok(after.investors.length === before.investors.length + 1,
      'ISOLATE-4 exactly one investor was added');
  }

  // ── What the layer places, and what it counts ───────────────────────────
  {
    const after = layer.applyAhlLayer(mergedFixture(), held);
    const ahl = after.investors.find((e) => e.key === layer.AHL_INVESTOR_KEY);
    ok(ahl.presentIn.includes('ahl'), 'PRESENT-1 American Heritage is present from the AHL source');
    ok(ahl.programCounts.ahl === 2 && ahl.programs.ahl.length === 8,
      `PRESENT-2 the two PRICED products count as offers; all eight programs stay on the board so their refusal reasons survive (${ahl.programCounts.ahl} priced of ${ahl.programs.ahl.length})`);
    ok(ahl.best.ahl && ahl.best.ahl.rate != null,
      `PRESENT-3 a headline is computed from the priced rungs (${ahl.best.ahl && ahl.best.ahl.rate} @ ${ahl.best.ahl && ahl.best.ahl.price})`);
    ok(ahl.whiteLabel && ahl.whiteLabel !== 'American Heritage Lending',
      `PRESENT-4 the row carries the client-safe name from the existing sheet (${ahl.whiteLabel}), never the investor's own`);
    ok(after.sources.ahl.answered === true && after.sources.ahl.marginHoldback === 0.25 && after.sources.ahl.channel,
      `PRESENT-5 the source stamp says the channel it was priced on (${after.sources.ahl.channel}) and what was held back — both change the numbers`);
    const down = layer.applyAhlLayer(mergedFixture(), null, { error: 'timeout' });
    ok(down.sources.ahl.answered === false && down.sources.ahl.error === 'timeout',
      'PRESENT-6 an AHL outage is REPORTED as a source that did not answer, so the routing layer can word it — not omitted');
  }

  // ── The settings and the routing ────────────────────────────────────────
  {
    ok(settings.SOURCES.includes('ahl'), 'ROUTE-1 `ahl` is an offerable source in the settings');
    const row = settings.settingFor('american_heritage', {});
    ok(row.source === 'ahl' && row.sourceOrigin === 'owner_directed',
      'ROUTE-2 American Heritage is PRE-FILLED to AHL, owner-directed, and the prefill offers the way back');
    ok(row.prefill.source === 'ahl', 'ROUTE-2b the way back is shown, so "use the pre-fill" can be pressed rather than only described');
    ok(routing.sourcesUnder('both', ['lenderprice', 'loannex', 'ahl']).join(',') === 'lenderprice,loannex',
      "ROUTE-3 `both` still means the two AGGREGATORS — adding a third source did not quietly widen what `both` means");
    ok(routing.sourcesUnder('ahl', ['lenderprice']).length === 0,
      'ROUTE-4 an investor set to AHL whose AHL row is absent shows NOTHING — never the other vendor\'s price wearing AHL\'s name');
    const misuse = settings.readSettings(JSON.stringify({ deephaven: { source: 'ahl' } }));
    ok(misuse.problems.some((p) => p.error === 'single_investor_source'),
      'ROUTE-5 pointing another investor at AHL is kept and REPORTED — AHL is that lender\'s own pricer and can never quote anybody else');
    // Every other investor still resolves exactly as before.
    ok(settings.settingFor('deephaven', {}).source === 'lenderprice' && settings.settingFor('acra', {}).source === 'loannex',
      'ROUTE-6 no other investor\'s source moved');
  }

  // ── One system: the vendor fingerprint comes off the displayed row ──────
  {
    const after = layer.applyAhlLayer(mergedFixture(), held);
    const shown = routing.applyRouting(after, { routes: {} });
    const ahl = shown.investors.find((e) => e.key === layer.AHL_INVESTOR_KEY);
    const rung = ahl.programs.flatMap((p) => p.rungs || [])[0];
    ok(rung && rung.marginHoldback === undefined && rung.vendorPrice === undefined && rung.rebateDollars === undefined && rung.targetPrice === undefined,
      'STRIP-1 the displayed rung carries no AHL fingerprint — not the holdback trail, and not the three figures only AHL states');
    ok(rung && rung.price != null && rung.basePrice != null && rung.baseRate != null,
      'STRIP-2 but the PRICE and the base it was built from stay — they are first-class on the common shape, so they identify nobody');
    ok(ahl.programs.every((p) => p.source === undefined),
      'STRIP-3 no row says which program produced it, unless the source was explicitly asked for');
    const revealed = routing.applyRouting(after, { routes: {}, revealSource: true });
    const rAhl = revealed.investors.find((e) => e.key === layer.AHL_INVESTOR_KEY);
    ok(rAhl.source === 'ahl' && rAhl.bySource.ahl.length > 0,
      'STRIP-4 nothing is discarded — an admin who asks for the source gets it, with the per-vendor split');
  }

  // ── The layout: base → adjustments → holdback → price ───────────────────
  {
    const opts = quoteShape.optionsFromAhl(held, { loanAmount: 350000, fico: 760 });
    const o = opts.find((x) => x.evidence && x.evidence.fetched);
    ok(o && o.priceBuild.basePrice != null && o.priceBuild.adjustmentPoints != null && o.holdback && o.priceBuild.price != null,
      `SHAPE-1 one AHL option reads base ${o && o.priceBuild.basePrice} + adj ${o && o.priceBuild.adjustmentPoints} = vendor ${o && o.priceBuild.vendorPrice} − holdback ${o && o.holdback.points} = ${o && o.priceBuild.price}`);
    ok(o.evidence.appliesToThisRate === true && o.reconciledAgainst === 'vendorPrice',
      "SHAPE-2 the stack is reconciled against the VENDOR's price, not ours — checking it against the held-back price fails by exactly the holdback on a board where nothing is wrong");
    ok(o.evidence.reason === 'inline_with_search',
      'SHAPE-3 the itemization is marked as arriving WITH the search — AHL charges no second call for it, exactly like Lender Price');
    ok(Array.isArray(o.adjustments) && o.adjustments.every((a) => typeof a.description === 'string' && a.description.length > 10),
      'SHAPE-4 every adjustment carries AHL\'s own rule text — the grid AND the cell, which is the whole of "why is this price this price"');
    const empty = quoteShape.emptyOption();
    ok(Object.keys(empty).every((k) => k in o),
      'SHAPE-5 an AHL option fills the SAME field set the screen already reads — the layout cannot tell which vendor it is looking at');
    const declined = opts.length && held.programs.filter((p) => !p.rungCount).length > 0;
    ok(declined, 'SHAPE-6 declined programs are still on the board beside the priced ones, carrying their reasons');
  }

  console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
  process.exit(fail === 0 ? 0 : 1);
})();
