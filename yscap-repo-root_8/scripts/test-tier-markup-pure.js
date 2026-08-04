/* =====================================================================
   test-tier-markup-pure.js — per-experience-tier markup (owner item 15).

   Proves the tier-markup OVERLAY behaves exactly as designed, WITHOUT a DB
   (the company defaults are stubbed on pricing-settings.current), so it runs
   in the pure `npm test` set. The frozen engines' byte-identical-when-unset
   property is proven separately over 77,760 scenarios; this pins the FEATURE:

     A. UNSET is inert — with no per-tier config and no per-file override the
        note rate is the historic one (Gold Tier 1 = 0 markup, Standard = the
        base 0.5%).
     B. A configured tier is applied EXACTLY — note rate = pure grid rate +
        the configured markup, to the fraction.
     C. Gold's top tier (Tier 1) is now CONTROLLABLE — the owner's core ask.
     D. ISOLATION — configuring one (program, tier) moves only that program's
        that-tier scenarios; every other tier and program is byte-unchanged.
     E. The PER-FILE studio override (markupGoldT1Pct) moves Gold Tier 1
        exactly like the company map, and touches nothing else.

   The note rate is asserted directly (quote.noteRate = grid + markup), so any
   regression that makes the overlay leak, mis-scale, or apply to the wrong
   tier fails here.
   ===================================================================== */
'use strict';
const assert = require('assert');
const pricing = require('../src/lib/pricing');
const settings = require('../src/lib/pricing-settings');

if (!pricing.enginesReady || !pricing.enginesReady()) {
  console.error('engines not loadable:', pricing.loadErr && pricing.loadErr());
  process.exit(1);
}

// ---- stub the company pricing defaults (no DB) -----------------------------
const BASE = Object.assign({}, settings.SYSTEM_DEFAULTS);   // markupTiers: null
let CURRENT = Object.assign({}, BASE);
settings.current = () => CURRENT;                           // pricing.js calls this dynamically
const withTiers = (map) => { CURRENT = Object.assign({}, BASE, { markupTiers: map }); };
const reset = () => { CURRENT = Object.assign({}, BASE); };

const EPS = 1e-6;
const near = (a, b) => Math.abs(a - b) < EPS;
let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };

// A clean purchase with NO interest reserve, so a markup change cannot feed
// back into sizing/band — the note-rate delta is then exactly the markup delta.
function app(state, exp) {
  return {
    property_address: { state }, fico: 740,
    requested_exp_flips: exp.flips || 0, requested_exp_holds: exp.holds || 0, requested_exp_ground: exp.ground || 0,
    property_type: 'Single Family', units: 1,
    loan_type: 'Purchase', program: 'Fix and Flip',
    purchase_price: 300000, as_is_value: 300000, arv: 450000, rehab_budget: 90000, term: 12,
  };
}
function quote(prog, state, exp, overrides) {
  return pricing.quoteProgram(prog, pricing.buildInputs(app(state, exp), exp, overrides || {}));
}

const EXP_LADDER = [
  { flips: 0, holds: 0, ground: 0 },
  { flips: 1, holds: 0, ground: 0 },
  { flips: 2, holds: 0, ground: 0 },
  { flips: 3, holds: 1, ground: 0 },
  { flips: 5, holds: 2, ground: 1 },
  { flips: 8, holds: 3, ground: 2 },
  { flips: 12, holds: 5, ground: 4 },
];
const STATES = ['NJ', 'TX', 'FL', 'PA', 'NY'];

// Find a state+experience that lands a program on a given tier (tiers unset),
// with a real, non-null note rate. Returns { state, exp } or null.
function findScenario(prog, tier) {
  reset();
  for (const state of STATES) {
    for (const exp of EXP_LADDER) {
      let q;
      try { q = quote(prog, state, exp); } catch (_) { continue; }
      if (q && q.eligible && q.tier === tier && q.noteRate != null) return { state, exp };
    }
  }
  return null;
}

// Discover a scenario per (program, tier). Gold's Tier 1 is REQUIRED (the ask).
const PROGRAMS = ['standard', 'gold', 'silver'];
const scen = {};                       // scen[prog][tier] = { state, exp, base }
for (const prog of PROGRAMS) {
  scen[prog] = {};
  for (const tier of [1, 2, 3]) {
    const s = findScenario(prog, tier);
    if (!s) continue;
    reset();
    const q = quote(prog, s.state, s.exp);
    scen[prog][tier] = { state: s.state, exp: s.exp, base: q.noteRate };
  }
}
ok(scen.gold[1], 'found a Gold Tier-1 (top experience) scenario');
ok(scen.standard[1] || scen.standard[2] || scen.standard[3], 'found at least one Standard tier scenario');
console.log('discovered tiers:', PROGRAMS.map((p) => p + ':[' + Object.keys(scen[p]).join(',') + ']').join('  '));

// --- A/B: a configured tier is applied EXACTLY (rate = pure grid + markup) ---
// For each discovered (prog, tier): set that tier to 0% → the PURE grid rate G;
// set it to TEST% → the rate must be exactly G + TEST/100.
const TESTS = { standard: 0.75, gold: 0.6, silver: 0.9 };   // all under Silver's 1.00 cap
for (const prog of PROGRAMS) {
  for (const tier of [1, 2, 3]) {
    const s = scen[prog][tier];
    if (!s) continue;
    withTiers({ [prog]: { [tier]: 0 } });
    const grid = quote(prog, s.state, s.exp).noteRate;
    const pct = TESTS[prog];
    withTiers({ [prog]: { [tier]: pct } });
    const marked = quote(prog, s.state, s.exp).noteRate;
    ok(near(marked - grid, pct / 100),
      `${prog} tier ${tier}: note rate = grid + ${pct}% exactly (Δ=${(marked - grid).toFixed(6)}, want ${(pct / 100).toFixed(6)})`);
  }
}

// --- A/C: UNSET Gold Tier 1 carries NO markup; Standard carries the base 0.5% ---
{
  const g1 = scen.gold[1];
  withTiers({ gold: { 1: 0 } });
  const gridG1 = quote('gold', g1.state, g1.exp).noteRate;
  ok(near(g1.base, gridG1), 'UNSET Gold Tier 1 already prices at zero markup (base == pure grid)');

  const sTier = scen.standard[1] || scen.standard[2] || scen.standard[3];
  const st = Object.keys(scen.standard).find((t) => scen.standard[t] === sTier);
  withTiers({ standard: { [st]: 0 } });
  const gridS = quote('standard', sTier.state, sTier.exp).noteRate;
  ok(near(sTier.base - gridS, 0.005), `UNSET Standard tier ${st} carries the historic 0.5% markup (Δ=${(sTier.base - gridS).toFixed(6)})`);
}

// --- C: Gold Tier 1 is CONTROLLABLE — set 0.5% → rate rises by exactly 0.5% ----
{
  const g1 = scen.gold[1];
  withTiers({ gold: { 1: 0.5 } });
  const q = quote('gold', g1.state, g1.exp);
  ok(near(q.noteRate - g1.base, 0.005), `Gold Tier 1 markup 0.5% raises the note rate by exactly 0.5% (Δ=${(q.noteRate - g1.base).toFixed(6)})`);
}

// --- D: ISOLATION — configuring Gold Tier 1 changes ONLY Gold Tier 1 ----------
{
  withTiers({ gold: { 1: 0.5 } });
  // Gold Tier 1 moved (proven in C). Everything else must be byte-unchanged.
  for (const prog of PROGRAMS) {
    for (const tier of [1, 2, 3]) {
      const s = scen[prog][tier];
      if (!s) continue;
      if (prog === 'gold' && tier === 1) continue;   // the one that SHOULD move
      const q = quote(prog, s.state, s.exp);
      ok(near(q.noteRate, s.base), `isolation: ${prog} tier ${tier} note rate unchanged when only Gold Tier 1 is configured`);
    }
  }
}

// --- D2: per-tier isolation within a program — set Standard tier 2 only --------
if (scen.standard[2] && (scen.standard[1] || scen.standard[3])) {
  withTiers({ standard: { 2: 0.9 } });
  const q2 = quote('standard', scen.standard[2].state, scen.standard[2].exp);
  ok(!near(q2.noteRate, scen.standard[2].base), 'Standard tier 2 note rate moves when tier 2 is configured');
  for (const tier of [1, 3]) {
    const s = scen.standard[tier];
    if (!s) continue;
    const q = quote('standard', s.state, s.exp);
    ok(near(q.noteRate, s.base), `per-tier isolation: Standard tier ${tier} unchanged when only tier 2 is configured`);
  }
}

// --- E: the PER-FILE studio override (markupGoldT1Pct) moves Gold Tier 1 -------
{
  reset();   // NO company map — only the per-file override
  const g1 = scen.gold[1];
  const q = quote('gold', g1.state, g1.exp, { markupGoldT1Pct: 0.5 });
  ok(near(q.noteRate - g1.base, 0.005), `per-file markupGoldT1Pct 0.5% raises Gold Tier 1 by exactly 0.5% (Δ=${(q.noteRate - g1.base).toFixed(6)})`);

  // …and it touches nothing else: Gold Tier 2/3, Standard, Silver unchanged.
  for (const prog of PROGRAMS) {
    for (const tier of [1, 2, 3]) {
      const s = scen[prog][tier];
      if (!s) continue;
      if (prog === 'gold' && tier === 1) continue;
      const qq = quote(prog, s.state, s.exp, { markupGoldT1Pct: 0.5 });
      ok(near(qq.noteRate, s.base), `per-file override isolation: ${prog} tier ${tier} unchanged`);
    }
  }
  // A per-file override on a NON-gold program quote is ignored (gold-only key).
  const sTier = scen.standard[1] || scen.standard[2] || scen.standard[3];
  const qs = quote('standard', sTier.state, sTier.exp, { markupGoldT1Pct: 0.5 });
  ok(near(qs.noteRate, sTier.base), 'markupGoldT1Pct never affects a Standard quote');
}

reset();
console.log(`\nAll per-tier markup checks passed (${passed} assertions).`);
