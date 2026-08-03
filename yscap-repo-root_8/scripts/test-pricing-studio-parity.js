'use strict';
/**
 * THE SERVER'S STUDIO ANSWER === WHAT THE BROWSER COMPUTES. (issue #7, phase 1)
 *
 * `src/lib/pricing-studio.js` exists so the term-sheet studio can stop running
 * the pricing engines in the visitor's browser — which is the only reason the
 * guideline book is still readable in the public web root. Phase 1 ships the
 * server answer and CHANGES NOTHING a user sees; this test is what makes that
 * worth anything, by proving the answer is identical before any surface moves.
 *
 * HOW IT PROVES IT. The browser's calls are not re-described here — that would
 * only test my reading of them. The engines are evaluated in a fabricated
 * non-Node scope (exactly what a <script> tag does, the same technique
 * test-engine-browser-view.js uses), the studio's own calls are made against
 * THAT browser view, and the results are compared field-for-field against
 * studioQuote(). A difference in any numeric field, status, reason or ladder row
 * fails.
 *
 * Pure — no DB, no network, no browser process.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.join(__dirname, '..');
const studio = require(path.join(REPO, 'src/lib/pricing-studio.js'));

let failures = 0, checks = 0;
const ok = (c, m) => { checks++; if (!c) { failures++; console.log(`FAIL ${m}`); } };

/* A real browser scope: the three engines evaluated in order into one global,
   because gold and silver read `root.YSP` the way they do in a page. */
function browserEngines() {
  // In a real page `window === self` and both are the global — title-cost.js
  // assigns onto `window`, the other three onto `self`, so a sandbox that
  // defines only one of them is not a browser.
  const sandbox = { self: null, window: null, console };
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  for (const f of ['standard-program.js', 'gold-standard.js', 'silver-program.js', 'title-cost.js']) {
    vm.runInContext(fs.readFileSync(path.join(REPO, 'web/tools', f), 'utf8'), ctx, { filename: f });
  }
  return ctx;
}
const B = browserEngines();
ok(!!(B.YSP && B.GSP && B.SVP && B.YSTitle), 'the four engines load in a browser-shaped scope');
ok(studio.enginesReady(), 'and the server module has them too');

/* Deliberately wide: every branch the studio can take — purchase and refinance,
   all four strategies, the tier ladder, the reserve in months AND as an amount,
   an assignment, an admin manual basis, an out-of-pocket rehab slice, and states
   on both sides of the eligibility line. */
const STATES = ['NJ', 'TX', 'GA', 'NC', 'PA', 'MD', 'VA', 'OH', 'TN', 'IN'];
const CASES = [];
for (const state of STATES) {
  for (const strategy of ['Fix & Flip', 'Ground-Up Construction', 'Bridge', 'Fix & Hold']) {
    for (const [price, rehab, arvm] of [[400000, 80000, 1.5], [250000, 60000, 1.56], [150000, 400000, 5.0], [1800000, 400000, 1.61], [95000, 25000, 1.74]]) {
      for (const [f, h, g] of [[0, 0, 0], [3, 0, 0], [12, 2, 0], [0, 0, 9]]) {
        for (const fico of [640, 700, 760]) {
          for (const irMonths of [0, 6]) {
            CASES.push({
              loanType: 'Purchase', cashOut: false, strategy, state, city: '', address: '',
              propertyType: 'SFR', fico, expFlips: f, expHolds: h, expGround: g,
              purchasePrice: price, asIsValue: price, arv: Math.round(price * arvm), rehabBudget: rehab,
              term: 12, irMonths, irAmount: 0, accrual: 'Non-Dutch', sqftAddition: false,
              heavyRehab: false, isAssignment: false, sellerPrice: 0,
            });
          }
        }
      }
    }
  }
}
// The awkward shapes, spelled out rather than generated.
CASES.push({ loanType: 'Refinance', cashOut: true, strategy: 'Fix & Flip', state: 'PA', city: '', address: '', propertyType: 'SFR', fico: 710, expFlips: 6, expHolds: 1, expGround: 0, purchasePrice: 350000, asIsValue: 350000, arv: 520000, rehabBudget: 90000, term: 12, irMonths: 6, irAmount: 0, accrual: 'Non-Dutch', sqftAddition: false, heavyRehab: false, isAssignment: false, sellerPrice: 0 });
CASES.push({ loanType: 'Purchase', cashOut: false, strategy: 'Fix & Flip', state: 'NJ', city: '', address: '', propertyType: 'SFR', fico: 740, expFlips: 12, expHolds: 0, expGround: 0, purchasePrice: 400000, asIsValue: 400000, arv: 600000, rehabBudget: 80000, term: 12, irMonths: 0, irAmount: 14000, accrual: 'Non-Dutch', sqftAddition: false, heavyRehab: false, isAssignment: false, sellerPrice: 0 });
CASES.push({ loanType: 'Purchase', cashOut: false, strategy: 'Fix & Flip', state: 'NJ', city: '', address: '', propertyType: 'SFR', fico: 720, expFlips: 8, expHolds: 0, expGround: 0, purchasePrice: 320000, asIsValue: 320000, arv: 520000, rehabBudget: 70000, term: 12, irMonths: 3, irAmount: 0, accrual: 'Non-Dutch', sqftAddition: false, heavyRehab: false, isAssignment: true, sellerPrice: 260000 });
CASES.push({ loanType: 'Purchase', cashOut: false, strategy: 'Fix & Flip', state: 'NJ', city: '', address: '', propertyType: 'SFR', fico: 700, expFlips: 2, expHolds: 0, expGround: 0, purchasePrice: 300000, asIsValue: 300000, arv: 450000, rehabBudget: 50000, term: 12, irMonths: 0, irAmount: 0, accrual: 'Non-Dutch', sqftAddition: false, heavyRehab: true, isAssignment: false, sellerPrice: 0, forcePrice: true, ovrAcqLTV: 0.9, ovrARLTV: 0.75, ovrLTC: 0.92, ovrRate: 0.115 });
CASES.push({ loanType: 'Purchase', cashOut: false, strategy: 'Fix & Flip', state: 'NJ', city: '', address: '', propertyType: 'SFR', fico: 740, expFlips: 12, expHolds: 0, expGround: 0, purchasePrice: 400000, asIsValue: 400000, arv: 600000, rehabBudget: 80000, term: 12, irMonths: 6, irAmount: 0, accrual: 'Non-Dutch', sqftAddition: false, heavyRehab: false, isAssignment: false, sellerPrice: 0, oopRehab: 20000 });

/* Compare every leaf. `constants` is skipped for the reason the browser view
   exists at all; nothing else is exempt. */
function leaves(o, p = '', out = []) {
  if (o == null) { out.push([p, null]); return out; }
  const t = typeof o;
  if (t === 'number' || t === 'string' || t === 'boolean') { out.push([p, o]); return out; }
  if (Array.isArray(o)) { o.forEach((v, i) => leaves(v, `${p}[${i}]`, out)); return out; }
  if (t === 'object') { for (const k of Object.keys(o).sort()) { if (k === 'constants') continue; leaves(o[k], p ? `${p}.${k}` : k, out); } }
  return out;
}
function sameShape(label, a, b) {
  const ma = new Map(leaves(a)), mb = new Map(leaves(b));
  const keys = new Set([...ma.keys(), ...mb.keys()]);
  let bad = 0;
  for (const k of keys) {
    const va = ma.get(k), vb = mb.get(k);
    if (JSON.stringify(va) !== JSON.stringify(vb)) {
      if (bad < 3) console.log(`   ${label} | ${k}: browser=${JSON.stringify(va)} server=${JSON.stringify(vb)}`);
      bad++;
    }
  }
  ok(bad === 0, `${label}: ${bad} field(s) differ`);
  return keys.size;
}

/* The markup the studio pushes in before every recompute. Exercise BOTH a stated
   markup and the engines' own, because "absent" must not silently mean zero. */
const MARKUP_SETS = [
  { name: 'engine default', markups: {} },
  { name: 'company 0.5%', markups: { standard: 0.005, gold: 0.005, silver: 0.005 } },
  { name: 'raised 2%', markups: { standard: 0.02, gold: 0.02, silver: 0.02 } },
];

let fields = 0;
for (const set of MARKUP_SETS) {
  console.log(`\n=== markup: ${set.name} ===`);
  let compared = 0;
  for (let i = 0; i < CASES.length; i++) {
    const deal = CASES[i];
    const label = `${set.name}/${i} ${deal.state}/${deal.strategy}/${deal.purchasePrice}`;

    // THE BROWSER, doing exactly what termsheet.js does: push the markup in,
    // then ask the engines.
    const bres = {};
    for (const [p, g] of [['standard', 'YSP'], ['gold', 'GSP'], ['silver', 'SVP']]) {
      const e = B[g];
      const m = set.markups[p];
      if (m != null && typeof e.setMarkup === 'function') e.setMarkup(m);
      const blk = {};
      try {
        blk.evaluate = e.evaluate(deal);
        if (deal.forcePrice && blk.evaluate && blk.evaluate.status === 'INELIGIBLE') { blk.evaluate.status = 'MANUAL'; blk.evaluate.exitShortfall = 0; }
      } catch (err) { blk.evaluate = null; }
      if (typeof e.priceLadder === 'function') {
        try {
          const pl = e.priceLadder(deal);
          blk.ladder = (pl && pl.eligible && pl.rows && pl.rows.length) ? { eligible: true, maxLtc: pl.maxLtc, binding: pl.binding, rows: pl.rows } : { eligible: false, rows: [] };
        } catch (err) { blk.ladder = { eligible: false, rows: [] }; }
      }
      if (typeof e.caps === 'function' && blk.evaluate) {
        try { const ev = blk.evaluate; blk.caps = e.caps(ev.regime, ev.loanType, ev.strategyCode, ev.tier); } catch (err) { blk.caps = null; }
      }
      if (m != null && typeof e.setMarkup === 'function') e.setMarkup(null);
      bres[p] = blk;
    }
    const btitle = {};
    for (const p of ['standard', 'gold', 'silver']) {
      const sized = bres[p].evaluate && bres[p].evaluate.sizing;
      const total = sized ? Number(sized.totalLoan) || 0 : 0;
      btitle[p] = total ? B.YSTitle.estimate(deal.state, total, deal.loanType) : null;
    }
    const bderived = {
      strategyCode: B.YSP.normStrategy(deal.strategy),
      projectCount: B.YSP.projectCount(B.YSP.normStrategy(deal.strategy), { flips: deal.expFlips || 0, holds: deal.expHolds || 0, ground: deal.expGround || 0 }),
    };

    // THE SERVER.
    const s = studio.studioQuote(deal, set.markups);

    for (const p of ['standard', 'gold', 'silver']) {
      fields += sameShape(`${label} ${p}.evaluate`, bres[p].evaluate, s[p].evaluate);
      if (bres[p].ladder !== undefined) fields += sameShape(`${label} ${p}.ladder`, bres[p].ladder, s[p].ladder);
      if (bres[p].caps !== undefined) fields += sameShape(`${label} ${p}.caps`, bres[p].caps, s[p].caps);
    }
    fields += sameShape(`${label} title`, btitle, s.title);
    fields += sameShape(`${label} derived`, bderived, s.derived);
    compared++;
  }
  console.log(`  ${compared} deals compared`);
}

console.log('\n=== the module never throws and never silently prices at zero ===');
{
  const junk = studio.studioQuote(null, null);
  ok(junk && junk.available === true, 'a null deal still returns a shaped answer');
  const noMarkup = studio.studioQuote(CASES[0], {});
  const withMarkup = studio.studioQuote(CASES[0], { standard: 0.02 });
  const rate = (q) => q.standard.evaluate && (q.standard.evaluate.noteRate != null ? q.standard.evaluate.noteRate : q.standard.evaluate.maxNoteRate);
  ok(rate(noMarkup) !== rate(withMarkup), 'a stated markup actually moves the rate (so "absent" is not being read as 0)');
  const again = studio.studioQuote(CASES[0], {});
  ok(rate(again) === rate(noMarkup), 'and the markup is RESET afterwards — no leak into the next caller');
}

console.log(`\n${checks} checks · ${fields} fields compared · ${failures} failure(s)`);
console.log(failures ? 'FAILED' : 'All pricing-studio parity checks passed');
process.exit(failures ? 1 : 0);
