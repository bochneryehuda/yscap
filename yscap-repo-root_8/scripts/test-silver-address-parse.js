'use strict';
/**
 * Silver Program (EMCAP) — AGGRESSIVE address / geography capability battery.
 *
 * Owner directive (2026-07-30): "test the capability of our system when he's
 * putting in the address because it's not splitting separately per city and
 * per zip we need to test the capability that he's realizing which city and
 * which zip is blocked or pricing different or leverage difference we need to
 * go like crazy on this one aggressive like never before".
 *
 * WHAT THIS FILE IS
 *  - A deterministic, generated-permutation battery (thousands of cases,
 *    seeded PRNG where random) over the FROZEN Silver engine's geography
 *    classification (web/v2/tools/silver-program.js: geoCheck / marketOf /
 *    evaluate) and its PRICING CONSEQUENCE (market grid, exact note rate,
 *    exact sized loan, leverage cap per market).
 *  - Every EXPECTED value derives from the SPEC tables at the top of this
 *    file (transcribed from docs/SILVER-PROGRAM-EMCAP.md "Geography" + the
 *    EMCAP workbook fixture scripts/fixtures/emcap-pricing-tool-v1.json) —
 *    NEVER from re-running the engine's own logic.
 *  - STRICT since 2026-07-30: the seven KNOWN-GAPs this battery originally
 *    reported (A city 'New York', B NYC-zip/state contradiction, C1/C2
 *    spelled-out state names, D ZIP→state fallback for the banned states,
 *    E borough abbreviations + whitespace, F trailing ', USA') were FIXED in the
 *    engine under the owner's 2026-07-30 geography directive, so every case now
 *    asserts the SPEC directly. The `gap`/`observed` machinery below is kept
 *    (unused) so a future divergence can be pinned the same way; `GAPS` is now a
 *    HISTORY record of what was fixed.
 *
 * HARD RULES HONORED
 *  - No DB, no network. Pure Node. Runtime well under 60s.
 *
 * Run:  node scripts/test-silver-address-parse.js
 * Suggested npm-test placement: right after scripts/test-silver-program.js.
 */

const path = require('path');
const SVP = require(path.join(__dirname, '..', 'web', 'v2', 'tools', 'silver-program.js'));
let FIX = null;
try { FIX = require(path.join(__dirname, 'fixtures', 'emcap-pricing-tool-v1.json')); } catch (e) { FIX = null; }

/* ===================================================================== *
 * SPEC TABLES — the single source of every EXPECTED value below.
 * Transcribed from docs/SILVER-PROGRAM-EMCAP.md ("Geography — hard
 * exclusions", "Products, purposes, markets") and the EMCAP workbook
 * fixture. NOT read out of the engine.
 * ===================================================================== */

// --- excluded geography (doc: "ZIP-based ... State-based ...") -----------
const SPEC_EXCLUDED_ZIP3 = {
  '191': { label: 'Greater Philadelphia', state: 'PA', city: 'Philadelphia' },
  '606': { label: 'Greater Chicago', state: 'IL', city: 'Chicago' },
  '607': { label: 'Greater Chicago', state: 'IL', city: 'Chicago' },
  '608': { label: 'Greater Chicago', state: 'IL', city: 'Chicago' },
  '481': { label: 'Greater Detroit', state: 'MI', city: 'Detroit' },
  '482': { label: 'Greater Detroit', state: 'MI', city: 'Detroit' },
  '483': { label: 'Greater Detroit', state: 'MI', city: 'Detroit' },
};
const SPEC_EXCLUDED_ZIP5 = ['21201', '21202', '21205', '21215', '21216', '21217', '21223', '21229'];
const BALTIMORE = { label: 'Greater Baltimore', state: 'MD', city: 'Baltimore' };
const SPEC_EXCLUDED_STATES = { NV: 'Nevada', MN: 'Minnesota', ND: 'North Dakota', SD: 'South Dakota' };
// USPS zip3 allocations of the four excluded STATES (used to prove the
// "state banned but only the 2-letter state field is checked" gap — a ZIP
// provably inside NV/MN/ND/SD is a banned-state property):
const SPEC_EXCLUDED_STATE_ZIP3 = {
  NV: ['889', '890', '891', '893', '894', '895', '897', '898'],
  MN: ['550', '551', '553', '554', '555', '556', '557', '558', '559', '560', '561', '562', '563', '564', '565', '566', '567'],
  ND: ['580', '581', '582', '583', '584', '585', '586', '587', '588'],
  SD: ['570', '571', '572', '573', '574', '575', '576', '577'],
};

// --- NYC five boroughs (doc: "NYC five boroughs (own rate grid)") --------
const SPEC_NYC_ZIP3 = ['100', '101', '102', '103', '104', '111', '112', '113', '114', '116'];
const SPEC_NYC_ZIP5 = ['11004', '11005'];             // Queens pockets inside 110xx (Nassau)
// Borough names that MUST classify NYC (city field or free-text address):
const SPEC_NYC_NAMES = ['New York City', 'Manhattan', 'Brooklyn', 'The Bronx', 'Bronx', 'Queens', 'Staten Island', 'NYC', 'Queens Village'];
// Common messy spellings that must ALSO classify NYC (owner's directive; was
// KNOWN-GAP E, fixed 2026-07-30 — borough aliases + internal-whitespace collapse):
const SPEC_NYC_NAMES_GAP = ['Bklyn', 'S.I.', 'Staten  Island', 'New  York  City'];
// Near-miss names that must STAY Standard market:
const SPEC_NYC_LOOKALIKES_STD = [
  { city: 'Queensbury', state: 'NY' },   // upstate NY
  { city: 'Bronxville', state: 'NY' },   // Westchester
  { city: 'Yonkers', state: 'NY' },
  { city: 'New Rochelle', state: 'NY' },
  { city: 'White Plains', state: 'NY' },
  { city: 'Hempstead', state: 'NY' },
  { city: 'Buffalo', state: 'NY' },
  { city: 'Albany', state: 'NY' },
  { city: 'Brooklyn', state: 'CT' },     // Brooklyn, Connecticut
  { city: 'Manhattan', state: 'KS' },    // Manhattan, Kansas
  { city: 'Manhattan Beach', state: 'CA' },
  { city: 'West New York', state: 'NJ' },
];
// Real NY zips that are NOT the five boroughs:
const SPEC_NON_NYC_NY_ZIPS = ['10501', '10601', '10701', '10801', '10901', '11001', '11003', '11050', '11530', '11550', '11743', '11901', '12207', '13201', '13501', '14201', '14604', '12901'];

/* --- fixed deal shapes + the exact pricing consequence per market --------
   The FF/GUC/FF680 shapes are chosen so the workbook prices them in BOTH
   markets (or, for FF680, in STD only — proving NYC never falls back to the
   STD grid). Numbers derive from the workbook fixture + doc rules, spelled
   out here so nothing is recomputed from the engine:

   FF  (fico 740, P, 12mo, T1, price 500k, rehab 100k, ARV 800k):
     STD: caps 90/75/92.5 → initial min(450k, 500k, 455k)=450k → loan 550,000
          LTC 91.67% (band 90-92.5), AR-LTV 68.75% (band 65-70)
          grid STD|S|FF|P|12|T1|65-70|700+|90-92.5 = 6.900% ⇒ note 6.900+0.5=... (rate units below)
     NYC: the NYC grid has NO FF cell above 80% LTC ⇒ leverage steps DOWN to
          the 80% band edge → loan 480,000, LTC 80.00%, AR-LTV 60% (<64.99)
          grid NYC|S|FF|P|12|T1|<64.99|700+|75-80 ⇒ same buy rate, LESS loan.
   GUC (fico 740, 5 ground-ups): STD loan 500,000 @ grid 0.08125+markup;
        NYC loan 480,000 @ grid 0.08875+markup — the RATE differs by market.
   FF680 (fico 680): STD prices (grid 0.09125+markup); NYC T1 F&F has NO
        sub-700-FICO cells at ANY leverage ⇒ MANUAL "no priced grid cell"
        (and the rateKey stays NYC| — never the STD grid).
   Markup: borrower note = workbook grid buy rate + 0.5% (doc).            */
const MARKUP = 0.005;
const GRID = { // workbook grid buy rates (verified against the fixture below)
  FF_STD: 0.08625, FF_NYC: 0.08625,
  GUC_STD: 0.08125, GUC_NYC: 0.08875,
  FF680_STD: 0.09125,
};
const GRID_ANCHORS = { // fixture keys proving the GRID numbers above come from the workbook
  'STD|S|FF|P|12|T1|65.00%-70.00%|FICO 700+|90.00%-92.50%': GRID.FF_STD,
  'NYC|S|FF|P|12|T1|<64.99%|FICO 700+|75.00%-80.00%': GRID.FF_NYC,
  'STD|S|GUC|P|12|T1|<64.99%|FICO 700+|80.01%-85.00%': GRID.GUC_STD,
  'NYC|S|GUC|P|12|T1|<64.99%|FICO 700+|75.00%-80.00%': GRID.GUC_NYC,
  'STD|S|FF|P|12|T1|65.00%-70.00%|FICO 660-699|90.00%-92.50%': GRID.FF680_STD,
};
const SHAPES = {
  FF: { loanType: 'Purchase', strategy: 'Fix & Flip', fico: 740, purchasePrice: 500000, rehabBudget: 100000, arv: 800000, expFlips: 4, term: 12 },
  GUC: { loanType: 'Purchase', strategy: 'Ground-Up Construction', fico: 740, purchasePrice: 500000, rehabBudget: 100000, arv: 800000, expGround: 5, term: 12 },
  FF680: { loanType: 'Purchase', strategy: 'Fix & Flip', fico: 680, purchasePrice: 500000, rehabBudget: 100000, arv: 800000, expFlips: 4, term: 12 },
};
const PRICING = {
  FF: {
    STD: { rate: GRID.FF_STD + MARKUP, loan: 550000, keyPrefix: 'STD|S|FF|P|12|T1|', ltcMin: 0.91, ltcMax: 0.9251 },
    NYC: { rate: GRID.FF_NYC + MARKUP, loan: 480000, keyPrefix: 'NYC|S|FF|P|12|T1|', ltcMin: 0.0, ltcMax: 0.8001 },
  },
  GUC: {
    STD: { rate: GRID.GUC_STD + MARKUP, loan: 500000, keyPrefix: 'STD|S|GUC|P|12|T1|', ltcMin: 0.83, ltcMax: 0.8401 },
    NYC: { rate: GRID.GUC_NYC + MARKUP, loan: 480000, keyPrefix: 'NYC|S|GUC|P|12|T1|', ltcMin: 0.0, ltcMax: 0.8001 },
  },
  FF680: {
    STD: { rate: GRID.FF680_STD + MARKUP, loan: 550000, keyPrefix: 'STD|S|FF|P|12|T1|65.00%-70.00%|FICO 660-699|', ltcMin: 0.91, ltcMax: 0.9251 },
    // NYC: no cell at any leverage — expressed as an explicit expectation below.
  },
};

/* ===================================================================== *
 * GAP HISTORY — all seven were FIXED in the engine on 2026-07-30 (owner
 * geography directive). Every case that used to be marked with one of these
 * ids is now STRICT. Kept as the record of what the fix had to deliver; the
 * reporter below prints a section only if a case is ever re-marked.
 * ===================================================================== */
const GAPS = {
  'GAP-A': {
    title: "City 'New York' with NO zip is not in the NYC name list — prices on the STD grid",
    spec: 'market NYC (five-borough treatment: NYC grid, 80% LTC cap, no >$2.5M, no F&F refi)',
    observed: "market STD — the deal silently prices on the Standard grid at Standard leverage",
    repro: "SVP.marketOf({city:'New York', state:'NY'}) → 'STD'  (also 'new york', and address '... New York NY' without a comma; 'New York City'/'New York, NY'/'NYC' DO work)",
  },
  'GAP-B': {
    title: 'NYC zip + contradicting typed state silently prices STD — the excluded-ZIP path treats the SAME contradiction as MANUAL',
    spec: "two typed fields disagreeing is a data problem → MANUAL review (mirror of geoCheck's 'zipstate' path)",
    observed: "ELIGIBLE, priced on the STD grid with STD leverage (state wins with no review)",
    repro: "evaluate({zip:'11215', state:'NJ', ...}) → status ELIGIBLE, rateKey 'STD|...'  — while geoCheck({zip:'60601', state:'NY'}) → MANUAL/'zipstate'",
  },
  'GAP-C1': {
    title: 'Spelled-out excluded state names bypass the NV/MN/ND/SD exclusion',
    spec: "state 'Nevada'/'Minnesota'/'North Dakota'/'South Dakota' → INELIGIBLE (doc: State-based: NV, MN, ND, SD)",
    observed: 'geoCheck returns null — the deal prices on the STD grid',
    repro: "SVP.geoCheck({state:'Nevada'}) → null  (expected INELIGIBLE; only the exact 2-letter code matches)",
  },
  'GAP-C2': {
    title: "Spelled-out / dotted New York state ('New York', 'N.Y.') forces STD market even with an NYC zip or borough city",
    spec: 'market NYC — the state means NY, the zip/city is five-borough',
    observed: "marketOf returns 'STD' the moment state ≠ literal 'NY' (before even looking at the zip)",
    repro: "SVP.marketOf({state:'New York', zip:'11215'}) → 'STD';  SVP.marketOf({state:'N.Y.', city:'Brooklyn'}) → 'STD'",
  },
  'GAP-D': {
    title: 'Excluded-STATE properties identified only by ZIP (or free-text address) are never excluded — there is no ZIP→state fallback for NV/MN/ND/SD',
    spec: 'a ZIP provably inside a banned state blocks (typed zip → INELIGIBLE; text zip → MANUAL), exactly like the banned-metro ZIP lists',
    observed: 'geoCheck returns null — Las Vegas / Minneapolis / Fargo / Sioux Falls deals price on the STD grid when the 2-letter state field is blank or the address is one unsplit line',
    repro: "SVP.geoCheck({zip:'89109'}) → null;  SVP.geoCheck({address:'2880 Las Vegas Blvd S, Las Vegas, NV 89109'}) → null",
  },
  'GAP-E': {
    title: "Borough abbreviations & multi-word spacing: 'Bklyn', 'S.I.', 'Staten  Island' (double space) are not recognized as NYC",
    spec: 'common borough spellings classify NYC (owner: address data arrives unsplit and messy)',
    observed: "market STD — the deal prices on the Standard grid at Standard leverage",
    repro: "SVP.marketOf({city:'Bklyn', state:'NY'}) → 'STD';  marketOf({city:'Staten  Island'}) → 'STD' (double space defeats the multi-word name match)",
  },
  'GAP-F': {
    title: "Trailing ', USA' / punctuation after the ZIP defeats the free-text ZIP reader (legacy ClickUp addresses end ', USA')",
    spec: 'the trailing zip still reads: excluded zips → MANUAL, NYC zips → NYC market',
    observed: "zipFromText's regex requires the zip at end-of-string, so '..., PA 19023, USA' has NO zip: excluded-zip addresses price, NYC-zip addresses price STD (only a borough/city token can still save the classification)",
    repro: "SVP.geoCheck({address:'12 Oak St, Darby, PA 19023, USA'}) → null;  SVP.marketOf({address:'90-11 160th St, Jamaica, NY 11432, USA'}) → 'STD'",
  },
};

/* Pinned engine behaviors worth knowing (NOT gaps — printed as NOTES). */
const NOTES = [
  "N1 ASYMMETRY: excluded STATE + contradicting allowed typed ZIP → hard INELIGIBLE (state checked first, no MANUAL) — while excluded ZIP + contradicting state → MANUAL 'zipstate'. Pinned: geoCheck({state:'NV', zip:'07030'}) → INELIGIBLE/state.",
  "N2 text-parsed excluded ZIP + contradicting typed state → prices with NO review (engine's house-number doctrine; the city fallback is state-scoped away). Pinned: geoCheck({address:'9 Elm St, Springfield 48201', state:'NJ'}) → null.",
  "N3 street names containing an excluded city token (no zip, no typed state) → MANUAL (conservative false positive, safe direction; a ZIP or the typed state resolves it). Pinned: '60629 Chicago Ave, Nashville' → MANUAL/address.",
  "N4 name-guess without a state: 'Brooklyn Park' / 'Manhattan' city-only → NYC market (substring/word match with no state to anchor it). Pinned.",
  "N5 enclave cities are caught by ZIP only: 'Hamtramck' (inside Detroit) and 'Cicero' (Chicago enclave) city-only PRICE; their zips 48212/60804 block. Pinned.",
  "N6 NYC neighborhoods not in the name list ('Far Rockaway', 'Long Island City', 'Harlem', 'Williamsburg') classify STD by name; their ZIPs classify NYC. Pinned pairs.",
  "N7 Baltimore is ZIP5-precise: only the 8 listed zips block; 21230/21250 (typed, consistent) price. Pinned.",
  "N8 a good, consistent ZIP is decisive over any city name: zip 11215 + city 'Chicago' → eligible NYC; zip 60601 + city 'Brooklyn' → INELIGIBLE Chicago. Pinned.",
];

/* ===================================================================== *
 * Harness
 * ===================================================================== */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(0x51C0DE);   // fixed seed — fully deterministic

const NEUTRAL_CITIES = ['Springfield', 'Dayton', 'Fairview', 'Georgetown', 'Franklin', 'Clinton', 'Salem', 'Madison', 'Greenville', 'Riverton'];
const NEUTRAL_STREETS = ['Main St', 'Oak Ave', 'Maple Dr', 'Cedar Ln', 'Elm St.', 'Park Pl', 'Washington Blvd', '2nd Street'];
const CONTRA_STATES = ['NJ', 'TX', 'FL', 'CT', 'GA'];  // never PA/IL/MI/MD/NY-implied
function pick(arr) { return arr[Math.floor(rnd() * arr.length)]; }
function houseNo() { return String(1 + Math.floor(rnd() * 9899)); }
function randSuffix2() { return String(10 + Math.floor(rnd() * 90)); }
function altCase(s) { let o = ''; for (const ch of s) o += rnd() < 0.5 ? ch.toLowerCase() : ch.toUpperCase(); return o; }

const CASES = [];
function C(id, desc, input, spec, opts) {
  opts = opts || {};
  CASES.push({ id, desc, input, spec, gap: opts.gap || null, observed: opts.observed || null, shape: opts.shape || 'FF' });
}

// expectation builders (spec-level classification + pricing consequence)
function ELIG(mkt, extra) { return Object.assign({ geo: 'NONE', status: 'ELIGIBLE', market: mkt, priced: mkt }, extra || {}); }
function EXCL(source, labelHas) { return { geo: 'INELIGIBLE', geoSource: source, labelHas, status: 'INELIGIBLE', priced: false, noSizing: true }; }
function MAN(source, labelHas) { return { geo: 'MANUAL', geoSource: source, labelHas, status: 'MANUAL', priced: false, noSizing: true }; }

function classify(input, shape) {
  const geo = SVP.geoCheck(input);
  const market = SVP.marketOf(input);
  const ev = SVP.evaluate(Object.assign({}, SHAPES[shape], input));
  return {
    geoLevel: geo ? geo.level : 'NONE',
    geoSource: geo ? geo.source : null,
    geoLabel: geo ? geo.label : null,
    market,
    status: ev.status,
    noteRate: ev.noteRate || 0,
    totalLoan: ev.sizing ? ev.sizing.totalLoan : null,
    ltcPct: ev.sizing ? (ev.sizing.ltcPct || 0) : null,
    rateKey: ev.rateKey || '',
  };
}

function check(exp, o, shape) {
  const m = [];
  if (exp.geo && o.geoLevel !== exp.geo) m.push(`geoLevel ${o.geoLevel} ≠ ${exp.geo}`);
  if (exp.geoSource && o.geoSource !== exp.geoSource) m.push(`geoSource ${o.geoSource} ≠ ${exp.geoSource}`);
  if (exp.labelHas && String(o.geoLabel || '').indexOf(exp.labelHas) === -1) m.push(`label '${o.geoLabel}' misses '${exp.labelHas}'`);
  if (exp.market && o.market !== exp.market) m.push(`market ${o.market} ≠ ${exp.market}`);
  if (exp.status && o.status !== exp.status) m.push(`status ${o.status} ≠ ${exp.status}`);
  if (exp.priced === false && o.noteRate !== 0) m.push(`priced (rate ${o.noteRate}) but spec says NOT priced`);
  if (exp.noSizing && o.totalLoan != null) m.push(`sizing present (${o.totalLoan}) but spec says none`);
  if (exp.keyStartsWith && String(o.rateKey).indexOf(exp.keyStartsWith) !== 0) m.push(`rateKey '${o.rateKey}' !startsWith '${exp.keyStartsWith}'`);
  if (exp.pricedAny && !(o.noteRate > 0)) m.push('expected some priced rate, got none');
  if (exp.priced === 'STD' || exp.priced === 'NYC') {
    const P = PRICING[shape] && PRICING[shape][exp.priced];
    if (!P) m.push(`no PRICING row for shape ${shape}/${exp.priced}`);
    else {
      if (Math.abs(o.noteRate - P.rate) > 1e-9) m.push(`noteRate ${o.noteRate} ≠ ${P.rate} (${exp.priced} grid)`);
      if (o.totalLoan !== P.loan) m.push(`totalLoan ${o.totalLoan} ≠ ${P.loan}`);
      if (String(o.rateKey).indexOf(P.keyPrefix) !== 0) m.push(`rateKey '${o.rateKey}' !startsWith '${P.keyPrefix}'`);
      if (!(o.ltcPct >= P.ltcMin - 1e-9 && o.ltcPct <= P.ltcMax + 1e-9)) m.push(`ltcPct ${o.ltcPct} outside [${P.ltcMin}, ${P.ltcMax}]`);
      // cross-grid guard: an NYC deal must never carry an STD key and vice versa
      const wrong = exp.priced === 'NYC' ? 'STD|' : 'NYC|';
      if (String(o.rateKey).indexOf(wrong) === 0) m.push(`rateKey on the WRONG market grid: ${o.rateKey}`);
    }
  }
  return m;
}

/* ===================================================================== *
 * S0 — spec ↔ engine-constant ↔ workbook-fixture cross-checks
 * ===================================================================== */
let s0Pass = 0; const s0Fail = [];
function s0(name, cond) { if (cond) s0Pass++; else s0Fail.push(name); }
(function crossChecks() {
  const c = SVP.constants;
  s0('EXCLUDED_ZIP3 matches doc', JSON.stringify(c.EXCLUDED_ZIP3.slice().sort()) === JSON.stringify(Object.keys(SPEC_EXCLUDED_ZIP3).sort()));
  s0('EXCLUDED_ZIP5 matches doc', JSON.stringify(c.EXCLUDED_ZIP5.slice().sort()) === JSON.stringify(SPEC_EXCLUDED_ZIP5.slice().sort()));
  s0('EXCLUDED_STATES matches doc', JSON.stringify(c.EXCLUDED_STATES.slice().sort()) === JSON.stringify(Object.keys(SPEC_EXCLUDED_STATES).sort()));
  if (FIX && FIX.rates) {
    for (const k of Object.keys(GRID_ANCHORS)) {
      s0(`workbook fixture anchor ${k}`, Math.abs((FIX.rates[k] || 0) - GRID_ANCHORS[k]) < 1e-9);
    }
  } else {
    s0('workbook fixture readable', false);
  }
})();

/* ===================================================================== *
 * S1 — EXHAUSTIVE zip3 sweep: every prefix 000–999 × 2 suffixes.
 *      Proves the complete "which zip is blocked / which zip is NYC" map.
 * ===================================================================== */
(function sweep() {
  const stateOfZip3 = {};
  for (const st of Object.keys(SPEC_EXCLUDED_STATE_ZIP3)) {
    for (const p of SPEC_EXCLUDED_STATE_ZIP3[st]) stateOfZip3[p] = st;
  }
  for (let n = 0; n < 1000; n++) {
    const p = String(n).padStart(3, '0');
    for (const suf of ['01', '50']) {
      const zip = p + suf;
      const id = `S1-${zip}`;
      const meta = SPEC_EXCLUDED_ZIP3[p];
      const isZip5 = SPEC_EXCLUDED_ZIP5.indexOf(zip) > -1;
      const nyc = SPEC_NYC_ZIP3.indexOf(p) > -1 || SPEC_NYC_ZIP5.indexOf(zip) > -1;
      const bannedState = stateOfZip3[p];
      if (meta || isZip5) {
        C(id, `typed excluded zip ${zip}`, { zip }, EXCL('zip', meta ? meta.label : BALTIMORE.label));
      } else if (bannedState) {
        // a ZIP provably inside a banned state blocks exactly like a typed state
        // (ZIP→state fallback, fixed 2026-07-30)
        C(id, `typed banned-state zip ${zip} (${bannedState})`, { zip },
          EXCL('zip', SPEC_EXCLUDED_STATES[bannedState]));
      } else if (nyc) {
        C(id, `typed NYC zip ${zip}`, { zip }, ELIG('NYC'));
      } else {
        C(id, `typed ordinary zip ${zip}`, { zip }, ELIG('STD'));
      }
    }
  }
  // NYC zip5 specials + their non-NYC 110xx neighbors
  C('S1-11004', 'typed 11004 (Queens pocket)', { zip: '11004' }, ELIG('NYC'));
  C('S1-11005', 'typed 11005 (Queens pocket)', { zip: '11005' }, ELIG('NYC'));
  for (const z of ['11001', '11002', '11003', '11010', '11020', '11050', '11096']) {
    C(`S1-${z}`, `typed ${z} (110xx Nassau — NOT NYC)`, { zip: z }, ELIG('STD'));
  }
  for (const z of SPEC_NON_NYC_NY_ZIPS) {
    C(`S1-NY-${z}`, `typed NY-but-not-NYC zip ${z} (state NY)`, { zip: z, state: 'NY' }, ELIG('STD'));
  }
})();

/* ===================================================================== *
 * S2 — every excluded ZIP prefix / explicit ZIP, in 8 input FORMS each
 *      (typed field, matching state, contradicting state, realistic
 *      address strings, ZIP+4, borough-name distraction, house numbers).
 * ===================================================================== */
(function excludedForms() {
  const prefixEntries = Object.keys(SPEC_EXCLUDED_ZIP3).map((p) => ({ zip3: p, meta: SPEC_EXCLUDED_ZIP3[p] }));
  const zips = [];
  for (const e of prefixEntries) {
    const sufs = ['01', '15', '30', '52', '77', '99', randSuffix2(), randSuffix2(), randSuffix2()];
    for (const s of sufs) zips.push({ zip: e.zip3 + s, meta: e.meta });
  }
  for (const z5 of SPEC_EXCLUDED_ZIP5) zips.push({ zip: z5, meta: BALTIMORE });

  let i = 0;
  for (const { zip, meta } of zips) {
    i++;
    const st = meta.state, city = meta.city, label = meta.label;
    const contra = pick(CONTRA_STATES);
    const ncity = pick(NEUTRAL_CITIES), street = pick(NEUTRAL_STREETS), hn = houseNo();
    C(`S2-${zip}-a`, `typed zip only`, { zip }, EXCL('zip', label));
    C(`S2-${zip}-b`, `typed zip + matching state ${st}`, { zip, state: st }, EXCL('zip', label));
    C(`S2-${zip}-c`, `typed zip + contradicting state ${contra} → MANUAL (zipstate)`, { zip, state: contra, city: ncity }, MAN('zipstate', label));
    C(`S2-${zip}-d`, `address '<hn> <street>, ${city}, ${st} ${zip}' (text zip)`, { address: `${hn} ${street}, ${city}, ${st} ${zip}` }, MAN('address', label));
    C(`S2-${zip}-e`, `address with NEUTRAL city '${ncity}' + trailing zip`, { address: `${hn} ${street}, ${ncity}, ${st} ${zip}` }, MAN('address', label));
    C(`S2-${zip}-f`, `address ZIP+4 '${zip}-1234'`, { address: `${hn} ${street}, ${city} ${st} ${zip}-1234` }, MAN('address', label));
    C(`S2-${zip}-g`, `typed zip + borough city name (zip wins)`, { zip, city: 'Brooklyn' }, EXCL('zip', label));
    C(`S2-${zip}-h`, `address text zip + typed MATCHING state`, { address: `${hn} ${street}, ${city} ${zip}`, state: st }, MAN('address', label));
    // house-number collision: the excluded zip as a HOUSE NUMBER must not trip
    if (i % 2 === 0) {
      C(`S2-${zip}-i`, `house number '${zip} ${street}, ${ncity} TX 75001' (no zip logic tripped)`, { address: `${zip} ${street}, ${ncity} TX 75001` }, ELIG('STD'));
      C(`S2-${zip}-j`, `house number '${zip} ${street}, ${ncity} TX' (no trailing zip at all)`, { address: `${zip} ${street}, ${ncity} TX` }, ELIG('STD'));
    }
  }
  // typed zip field carrying ZIP+4 for a couple of prefixes
  C('S2-zip4-19104', 'typed zip field 19104-2201', { zip: '19104-2201' }, EXCL('zip', 'Greater Philadelphia'));
  C('S2-zip4-21215', 'typed zip field 21215-1234', { zip: '21215-1234' }, EXCL('zip', 'Greater Baltimore'));
  // Baltimore ZIP5-precision (N7): non-listed 212xx zips price
  C('S2-21230', 'typed 21230 + MD (NOT on the Baltimore list)', { zip: '21230', state: 'MD', city: 'Baltimore' }, ELIG('STD'));
  C('S2-21250', 'typed 21250 (NOT on the Baltimore list)', { zip: '21250' }, ELIG('STD'));
  // N2 pin: text-parsed excluded zip + contradicting typed state → prices
  C('S2-N2', "address '9 Elm St, Springfield 48201' + typed state NJ", { address: '9 Elm St, Springfield 48201', state: 'NJ' }, ELIG('STD'));
})();

/* ===================================================================== *
 * S3 — every NYC zip3 (+11004/11005) in multiple forms; non-NYC controls.
 * ===================================================================== */
(function nycForms() {
  const zips = [];
  for (const p of SPEC_NYC_ZIP3) {
    for (const s of ['01', '25', '50', '75', '99', randSuffix2(), randSuffix2()]) zips.push(p + s);
  }
  zips.push('11004', '11005');
  for (const zip of zips) {
    const street = pick(NEUTRAL_STREETS), hn = houseNo();
    C(`S3-${zip}-a`, 'typed zip, state NY', { zip, state: 'NY' }, ELIG('NYC'));
    C(`S3-${zip}-b`, 'typed zip, no state', { zip }, ELIG('NYC'));
    C(`S3-${zip}-c`, `address '${hn} ${street}, New York, NY ${zip}'`, { address: `${hn} ${street}, New York, NY ${zip}` }, ELIG('NYC'));
    C(`S3-${zip}-d`, `address ZIP+4 '${zip}-1234'`, { address: `${hn} ${street}, Fairview, NY ${zip}-1234` }, ELIG('NYC'));
    // house-number collision: NYC zip as HOUSE NUMBER in a NJ deal
    C(`S3-${zip}-e`, `house number '${zip} ${street}, Trenton NJ 08601'`, { address: `${zip} ${street}, Trenton NJ 08601` }, ELIG('STD'));
  }
  // NYC zip + contradicting typed state → MANUAL 'zipstate' (mirrors the
  // excluded-ZIP contradiction path; fixed 2026-07-30)
  for (const zip of ['11215', '10001', '10451', '11693', '11004']) {
    for (const st of ['NJ', 'CT', 'PA']) {
      C(`S3-B-${zip}-${st}`, `NYC zip ${zip} + contradicting state ${st}`, { zip, state: st, city: 'Hoboken' },
        MAN('zipstate', 'NYC five boroughs'));
    }
  }
  // multiple 5-digit runs in one address — trailing run decides
  C('S3-multi-1', 'runs 10001…60601…38118: trailing 38118 decides', { address: '10001 Industrial Pkwy Suite 60601, Memphis TN 38118' }, ELIG('STD'));
  C('S3-multi-2', 'runs 08601…11215: trailing 11215 decides → NYC', { address: '08601 Warehouse Row Unit 5, Brooklyn NY 11215' }, ELIG('NYC'));
  C('S3-multi-3', 'zip mid-string only (no trailing zip, no NYC token)', { address: '123 Main St 60629 Apt 4, Nashville TN' }, ELIG('STD'));
})();

/* ===================================================================== *
 * S4 — borough names + casing/spacing/punctuation torture; lookalikes.
 * ===================================================================== */
(function names() {
  let i = 0;
  for (const name of SPEC_NYC_NAMES) {
    i++;
    const street = pick(NEUTRAL_STREETS), hn = houseNo();
    C(`S4-${i}-a`, `city '${name}' + NY`, { city: name, state: 'NY' }, ELIG('NYC'));
    C(`S4-${i}-b`, `city '${name.toUpperCase()}'`, { city: name.toUpperCase(), state: 'NY' }, ELIG('NYC'));
    C(`S4-${i}-c`, `city '${altCase(name)}' (random casing)`, { city: altCase(name), state: 'NY' }, ELIG('NYC'));
    C(`S4-${i}-d`, `city '  ${name}  ' (padded)`, { city: `  ${name}  `, state: 'NY' }, ELIG('NYC'));
    C(`S4-${i}-e`, `city '${name}.' (trailing period)`, { city: `${name}.`, state: 'NY' }, ELIG('NYC'));
    C(`S4-${i}-f`, `address '${hn} ${street}, ${name}, NY' (no zip)`, { address: `${hn} ${street}, ${name}, NY` }, ELIG('NYC'));
    C(`S4-${i}-g`, `address 'Apt 4B, ${hn} Water Street, ${name} NY'`, { address: `Apt 4B, ${hn} Water Street, ${name} NY` }, ELIG('NYC'));
    C(`S4-${i}-h`, `city '${name}', no state at all`, { city: name }, ELIG('NYC'));
  }
  // borough abbreviations / internal double-space (fixed 2026-07-30)
  let j = 0;
  for (const name of SPEC_NYC_NAMES_GAP) {
    j++;
    C(`S4-E-${j}a`, `city '${name}' + NY (common spelling → NYC)`, { city: name, state: 'NY' }, ELIG('NYC'));
    C(`S4-E-${j}b`, `address '1 Richmond Ter, ${name} NY'`, { address: `1 Richmond Ter, ${name} NY` }, ELIG('NYC'));
  }
  // plain 'New York' city / no-comma address form (fixed 2026-07-30)
  C('S4-A-1', "city 'New York', state NY, no zip", { city: 'New York', state: 'NY' }, ELIG('NYC'));
  C('S4-A-2', "city 'new york' lowercase", { city: 'new york', state: 'NY' }, ELIG('NYC'));
  C('S4-A-3', "city 'New York', NO state field", { city: 'New York' }, ELIG('NYC'));
  C('S4-A-4', "address '350 5th Ave, New York NY' (no comma before NY)", { address: '350 5th Ave, New York NY' }, ELIG('NYC'));
  // …but 'New York' as the spelled-out STATE at the END of free text is NOT the
  // city (a bare trailing 'New York' in an address stays Standard market):
  C('S4-A-8', "address '12 Oak St, Rochester, New York' → STD (state, not the city)", { address: '12 Oak St, Rochester, New York' }, ELIG('STD'));
  // …while the comma form and the full name DO work (strict pins):
  C('S4-A-5', "address '350 5th Ave, New York, NY' (comma form works)", { address: '350 5th Ave, New York, NY' }, ELIG('NYC'));
  C('S4-A-6', "city 'New York City' works", { city: 'New York City', state: 'NY' }, ELIG('NYC'));
  C('S4-A-7', "city 'NYC' works", { city: 'NYC', state: 'NY' }, ELIG('NYC'));
  // lookalikes must stay STD
  let k = 0;
  for (const lk of SPEC_NYC_LOOKALIKES_STD) {
    k++;
    C(`S4-L-${k}`, `lookalike city '${lk.city}', ${lk.state}`, lk, ELIG('STD'));
  }
  C('S4-L-addr-1', 'address Bronxville trap', { address: '10 Pondfield Rd, Bronxville, NY' }, ELIG('STD'));
  C('S4-L-addr-2', 'address Queensbury trap', { address: '742 Aviation Rd, Queensbury, NY' }, ELIG('STD'));
  // N4 pins: name-guess with NO state
  C('S4-N4-1', "city 'Brooklyn Park', no state → engine guesses NYC (pinned note)", { city: 'Brooklyn Park' }, ELIG('NYC'));
  C('S4-N4-2', "city 'Manhattan', no state → NYC (pinned note)", { city: 'Manhattan' }, ELIG('NYC'));
  // N6 pins: neighborhoods STD by name, NYC by zip
  const hoods = [['Far Rockaway', '11691'], ['Long Island City', '11101'], ['Harlem', '10027'], ['Williamsburg', '11211']];
  let h = 0;
  for (const [hood, zip] of hoods) {
    h++;
    C(`S4-N6-${h}a`, `city '${hood}' (name only) → STD (pinned note)`, { city: hood, state: 'NY' }, ELIG('STD'));
    C(`S4-N6-${h}b`, `city '${hood}' + zip ${zip} → NYC (zip decides)`, { city: hood, state: 'NY', zip }, ELIG('NYC'));
  }
})();

/* ===================================================================== *
 * S5 — states: 2-letter, spelled-out, dotted; contradictions both ways;
 *      excluded-state zips (GAP-D).
 * ===================================================================== */
(function states() {
  // exact 2-letter codes block, any casing/padding
  for (const st of Object.keys(SPEC_EXCLUDED_STATES)) {
    const name = SPEC_EXCLUDED_STATES[st];
    C(`S5-${st}-a`, `state '${st}'`, { state: st }, EXCL('state', name));
    C(`S5-${st}-b`, `state '${st.toLowerCase()}'`, { state: st.toLowerCase() }, EXCL('state', name));
    C(`S5-${st}-c`, `state ' ${st} ' padded`, { state: ` ${st} ` }, EXCL('state', name));
    C(`S5-${st}-d`, `state ${st} + allowed zip 07030 (contradiction: state wins — N1)`, { state: st, zip: '07030' }, EXCL('state', name));
    C(`S5-${st}-e`, `state ${st} + borough city`, { state: st, city: 'Brooklyn' }, EXCL('state', name));
    // spelled-out names normalize to the 2-letter code and block (fixed 2026-07-30)
    for (const v of [name, name.toLowerCase(), name.toUpperCase()]) {
      C(`S5-${st}-f-${v}`, `state '${v}' (spelled out)`, { state: v, city: 'Anytown' }, EXCL('state', name));
    }
  }
  // excluded state trumps an excluded-METRO zip too (label = the state)
  C('S5-order-1', 'state SD + zip 19104 → South Dakota (state checked first)', { state: 'SD', zip: '19104' }, EXCL('state', 'South Dakota'));
  C('S5-order-2', 'state MN + zip 60601 → Minnesota', { state: 'MN', zip: '60601' }, EXCL('state', 'Minnesota'));
  // NY spellings for the MARKET map
  C('S5-NY-1', "state 'NY' + zip 11215 → NYC", { state: 'NY', zip: '11215' }, ELIG('NYC'));
  C('S5-NY-2', "state 'ny' lowercase + zip 10001 → NYC", { state: 'ny', zip: '10001' }, ELIG('NYC'));
  C('S5-NY-3', "state ' NY ' padded + Brooklyn", { state: ' NY ', city: 'Brooklyn' }, ELIG('NYC'));
  // dotted / spelled-out New York state normalizes to NY BEFORE the market map
  // (fixed 2026-07-30)
  C('S5-C2-1', "state 'New York' + zip 11215", { state: 'New York', zip: '11215' }, ELIG('NYC'));
  C('S5-C2-2', "state 'N.Y.' + city Brooklyn", { state: 'N.Y.', city: 'Brooklyn' }, ELIG('NYC'));
  C('S5-C2-3', "state 'N.Y.' + zip 10001", { state: 'N.Y.', zip: '10001' }, ELIG('NYC'));
  C('S5-C2-4', "state 'new york' + address '1 Court St, Brooklyn'", { state: 'new york', address: '1 Court St, Brooklyn' }, ELIG('NYC'));
  // allowed state + excluded zip (both typed) → MANUAL zipstate (strict pins; both directions per prefix family)
  C('S5-ct-1', 'state NY + zip 60601 → MANUAL zipstate', { state: 'NY', zip: '60601' }, MAN('zipstate', 'Greater Chicago'));
  C('S5-ct-2', 'state NJ + zip 19104 → MANUAL zipstate', { state: 'NJ', zip: '19104' }, MAN('zipstate', 'Greater Philadelphia'));
  C('S5-ct-3', 'state TX + zip 48226 → MANUAL zipstate', { state: 'TX', zip: '48226' }, MAN('zipstate', 'Greater Detroit'));
  C('S5-ct-4', 'state FL + zip 21215 → MANUAL zipstate', { state: 'FL', zip: '21215' }, MAN('zipstate', 'Greater Baltimore'));
  // …and the matching-state controls (block hard):
  C('S5-ct-5', 'state IL + zip 60601 → INELIGIBLE', { state: 'IL', zip: '60601' }, EXCL('zip', 'Greater Chicago'));
  C('S5-ct-6', 'state PA + zip 19104 → INELIGIBLE', { state: 'PA', zip: '19104' }, EXCL('zip', 'Greater Philadelphia'));
  // iconic banned-state zips / free-text addresses — the ZIP names the state
  // when the state field is blank (fixed 2026-07-30)
  const dCases = [
    ['89109', '2880 Las Vegas Blvd S, Las Vegas, NV 89109', 'Nevada'],
    ['89501', '100 N Virginia St, Reno, NV 89501', 'Nevada'],
    ['55401', '100 N 1st St, Minneapolis, MN 55401', 'Minnesota'],
    ['55901', '201 4th St SE, Rochester, MN 55901', 'Minnesota'],
    ['58102', '505 Broadway N, Fargo, ND 58102', 'North Dakota'],
    ['57104', '300 N Phillips Ave, Sioux Falls, SD 57104', 'South Dakota'],
    ['57701', '512 Main St, Rapid City, SD 57701', 'South Dakota'],
  ];
  let d = 0;
  for (const [zip, addr, stName] of dCases) {
    d++;
    C(`S5-D-${d}a`, `typed banned-state zip ${zip}, no state field`, { zip }, EXCL('zip', stName));
    C(`S5-D-${d}b`, `one-line address '${addr}' (owner's unsplit-address scenario)`, { address: addr }, MAN('address', stName));
  }
  // …the ZIP→state fallback only applies when the state field is BLANK: a typed
  // state is still the authority (a banned-state ZIP + an allowed typed state
  // stays the engine's existing house-number/typed-field doctrine).
  C('S5-D-strict-1', 'banned-state zip 89109 + typed state NJ → typed state wins (prices)', { zip: '89109', state: 'NJ' }, ELIG('STD'));
  C('S5-D-strict-2', 'banned-state zip 55401 + typed state MN → INELIGIBLE by state', { zip: '55401', state: 'MN' }, EXCL('state', 'Minnesota'));

  /* ---- fix round 2026-07-30, item 5: AP-style abbreviations of the four banned
     states normalize like the spelled-out names ("N.D."/"S.D." already did,
     because they compact to two letters). ---- */
  const AP = [['Nev.', 'Nevada'], ['nev', 'Nevada'], ['Minn.', 'Minnesota'], ['minn', 'Minnesota'],
    ['N.Dak.', 'North Dakota'], ['N. Dakota', 'North Dakota'], ['S. Dak.', 'South Dakota'], ['S.Dakota', 'South Dakota'],
    ['N.D.', 'North Dakota'], ['S.D.', 'South Dakota'], ['n.v.', 'Nevada']];
  let ap = 0;
  for (const [txt, name] of AP) {
    ap++;
    C(`S5-AP-${ap}`, `state '${txt}' (AP abbreviation) → INELIGIBLE`, { state: txt, city: 'Anytown' }, EXCL('state', name));
  }
  // …and abbreviations of ALLOWED states are deliberately NOT invented: a form
  // the map does not know stays unresolvable and simply prices.
  C('S5-AP-neg-1', "state 'Calif.' (not in the map) still prices", { state: 'Calif.', zip: '90210' }, ELIG('STD'));
  C('S5-AP-neg-2', "state 'Tex.' (not in the map) still prices", { state: 'Tex.', zip: '75201' }, ELIG('STD'));

  /* ---- fix round 2026-07-30, item 2: an UNRESOLVABLE but non-blank state must
     not disable the ZIP→banned-state fallback. Each of these funded a Las Vegas
     property before the fix. ---- */
  const UNRES = ['Nevada, USA', 'Las Vegas', 'Minn', 'unknown', '??', 'N/A', 'Clark County', 'n/a', '-'];
  let ur = 0;
  for (const st of UNRES) {
    ur++;
    if (/^minn$/i.test(st)) continue;                       // resolves to MN → covered by S5-AP
    C(`S5-UR-${ur}a`, `banned-state zip 89101 + unresolvable state '${st}' → MANUAL zipstate`,
      { zip: '89101', state: st }, MAN('zipstate', 'Nevada'));
    C(`S5-UR-${ur}b`, `banned-state zip 55401 + unresolvable state '${st}' → MANUAL zipstate`,
      { zip: '55401', state: st }, MAN('zipstate', 'Minnesota'));
  }
  // the asymmetry that proved it wrong stays intact, both directions
  C('S5-UR-asym-1', "excluded-METRO zip 19103 + unresolvable state → MANUAL zipstate (unchanged)",
    { zip: '19103', state: 'Nevada, USA' }, MAN('zipstate', 'Greater Philadelphia'));
  C('S5-UR-asym-2', 'banned-state zip 89101 + NO state at all → INELIGIBLE (unchanged)',
    { zip: '89101' }, EXCL('zip', 'Nevada'));
  // a typed VALID state stays authoritative
  C('S5-UR-auth-1', 'banned-state zip 89101 + typed state CA → typed state wins (prices)', { zip: '89101', state: 'CA' }, ELIG('STD'));
  C('S5-UR-auth-2', 'banned-state zip 89101 + typed state NV → INELIGIBLE by state', { zip: '89101', state: 'NV' }, EXCL('state', 'Nevada'));
  // a text-parsed banned-state ZIP + unresolvable state text → still never priced
  C('S5-UR-txt-1', "address '12 Elm St, Las Vegas 89101' + state 'N/A' → MANUAL zipstate",
    { address: '12 Elm St, Las Vegas 89101', state: 'N/A' }, MAN('zipstate', 'Nevada'));

  /* ---- fix round 2026-07-30, item 4: an excluded STATE named only in the FREE
     TEXT (no ZIP, no typed state). Las Vegas / Minneapolis / Fargo / Sioux Falls
     are not excluded CITIES, so nothing caught them. ---- */
  const TXT = [
    ['123 Main St, Las Vegas, Nevada', 'Nevada'],
    ['123 Main St, Las Vegas, NV', 'Nevada'],
    ['123 Main St, Minneapolis, Minnesota', 'Minnesota'],
    ['123 Main St, Minneapolis, MN', 'Minnesota'],
    ['123 Main St, Fargo, North Dakota', 'North Dakota'],
    ['123 Main St, Fargo, ND', 'North Dakota'],
    ['123 Main St, Sioux Falls, South Dakota', 'South Dakota'],
    ['123 Main St, Sioux Falls, SD', 'South Dakota'],
    ['123 Main St, Reno, Nev.', 'Nevada'],
    ['123 Main St, Las Vegas, Nevada, USA', 'Nevada'],
    ['123 Main St, Bismarck, N.Dak.', 'North Dakota'],
  ];
  let tx = 0;
  for (const [addr, name] of TXT) {
    tx++;
    C(`S5-TXT-${tx}`, `address '${addr}' → MANUAL (state named in free text)`, { address: addr }, MAN('address', name));
  }
  // the typed STATE FIELD carrying unresolvable text that still NAMES a banned
  // state, with no ZIP to fall back on
  C('S5-TXT-st-1', "state 'Nevada, USA', no zip → MANUAL", { state: 'Nevada, USA' }, MAN('address', 'Nevada'));
  C('S5-TXT-st-2', "state 'Minnesota USA', no zip → MANUAL", { state: 'Minnesota USA' }, MAN('address', 'Minnesota'));
  // NEGATIVE controls — position is what makes this safe: only the TRAILING name
  // is a state, so a street/city carrying a state word never fires.
  C('S5-TXT-neg-1', "'123 Nevada Ave, Denver, CO' → prices (Nevada is the STREET)", { address: '123 Nevada Ave, Denver, CO' }, ELIG('STD'));
  C('S5-TXT-neg-2', "'123 Nevada Ave, Denver' (no state at all) → prices", { address: '123 Nevada Ave, Denver' }, ELIG('STD'));
  C('S5-TXT-neg-3', "'55 Dakota Blvd, Austin, TX' → prices", { address: '55 Dakota Blvd, Austin, TX' }, ELIG('STD'));
  C('S5-TXT-neg-4', "'900 Minnesota Ave, Kansas City, KS' → prices", { address: '900 Minnesota Ave, Kansas City, KS' }, ELIG('STD'));
  C('S5-TXT-neg-5', "'12 Oak St, Rochester, New York' → prices STD (state, not NYC)", { address: '12 Oak St, Rochester, New York' }, ELIG('STD'));
  C('S5-TXT-neg-6', "'123 2nd St, Boise, ID' → prices (a digit run can never read as ND)", { address: '123 2nd St, Boise, ID' }, ELIG('STD'));
  C('S5-TXT-neg-7', "'123 2nd St, Boise' → prices", { address: '123 2nd St, Boise' }, ELIG('STD'));
  C('S5-TXT-neg-8', "typed state TN wins over free text naming Nevada", { address: '123 Main St, Las Vegas, Nevada', state: 'TN' }, ELIG('STD'));
  C('S5-TXT-neg-9', "a good typed ZIP is decisive over free text naming Nevada", { address: '123 Main St, Las Vegas, Nevada', zip: '75201' }, ELIG('STD'));
})();

/* ===================================================================== *
 * S6 — house-number collisions, ', USA' legacy suffix, punctuation.
 * ===================================================================== */
(function collisions() {
  C('S6-1', "house# '11215 Main St, Trenton NJ 08601'", { address: '11215 Main St, Trenton NJ 08601' }, ELIG('STD'));
  C('S6-2', "house# '19104 Elm St, Houston TX 77002'", { address: '19104 Elm St, Houston TX 77002' }, ELIG('STD'));
  C('S6-3', "house# '19103 Roosevelt Blvd, Dallas TX' (no trailing zip)", { address: '19103 Roosevelt Blvd, Dallas TX' }, ELIG('STD'));
  C('S6-4', "house# '48227 Gratiot Ave, Nashville TN 37011'", { address: '48227 Gratiot Ave, Nashville TN 37011' }, ELIG('STD'));
  C('S6-5', "house# '60606 5th Ave, Miami FL 33101'", { address: '60606 5th Ave, Miami FL 33101' }, ELIG('STD'));
  C('S6-6', "house# '21215 Cedar Ln, Boise ID 83702'", { address: '21215 Cedar Ln, Boise ID 83702' }, ELIG('STD'));
  // N3 pins: excluded-city token as STREET name (no zip, no typed state) → conservative MANUAL
  C('S6-N3-1', "'60629 Chicago Ave, Nashville' no state → MANUAL (street-name token, pinned note)", { address: '60629 Chicago Ave, Nashville' }, MAN('address', 'Greater Chicago'));
  C('S6-N3-2', 'same + typed state TN → prices (state-scoped)', { address: '60629 Chicago Ave, Nashville', state: 'TN' }, ELIG('STD'));
  C('S6-N3-3', "'12 Detroit St, Denver' no state → MANUAL (pinned note)", { address: '12 Detroit St, Denver' }, MAN('address', 'Greater Detroit'));
  C('S6-N3-4', 'same + typed state CO → prices', { address: '12 Detroit St, Denver', state: 'CO' }, ELIG('STD'));
  // legacy ', USA' suffix / trailing punctuation no longer defeats zipFromText
  // (fixed 2026-07-30). NOTE: the original S6-F-1 case used Darby's real ZIP
  // 19023, whose prefix 190 is NOT on the exclusion list (SPEC_EXCLUDED_ZIP3 is
  // 191xx only) — the case was mis-authored, so it now uses a genuine 191xx ZIP
  // and 19023 is pinned as the price-normally control below.
  C('S6-F-1', "'12 Oak St, Darby, PA 19143, USA' (neutral city + excluded zip + USA)", { address: '12 Oak St, Darby, PA 19143, USA' },
    MAN('address', 'Greater Philadelphia'));
  C('S6-F-1b', "'12 Oak St, Darby, PA 19023, USA' (190xx is NOT excluded — prices)", { address: '12 Oak St, Darby, PA 19023, USA' },
    ELIG('STD'));
  C('S6-F-2', "'90-11 160th St, Jamaica, NY 11432, USA' (NYC zip + USA)", { address: '90-11 160th St, Jamaica, NY 11432, USA' },
    ELIG('NYC'));
  C('S6-F-3', "'12 Oak St, Springfield, PA 19104.' (trailing period)", { address: '12 Oak St, Springfield, PA 19104.' },
    MAN('address', 'Greater Philadelphia'));
  C('S6-F-4', "'55 Court St, Cicero, IL 60804, USA' (enclave + USA)", { address: '55 Court St, Cicero, IL 60804, USA' },
    MAN('address', 'Greater Chicago'));
  // the ', USA' strip must NOT chop a city that merely ENDS in "us"
  C('S6-F-7', "'9 Elm St, Columbus, OH 43215' (city ends in 'us')", { address: '9 Elm St, Columbus, OH 43215' }, ELIG('STD'));
  C('S6-F-8', "'9 Elm St, Columbus, OH 43215, USA'", { address: '9 Elm St, Columbus, OH 43215, USA' }, ELIG('STD'));
  C('S6-F-9', "house# survives the USA strip: '19104 Elm St, Houston TX 77002, USA'", { address: '19104 Elm St, Houston TX 77002, USA' }, ELIG('STD'));
  C('S6-F-10', "house# with no trailing zip + USA: '19104 Elm St, Houston TX, USA'", { address: '19104 Elm St, Houston TX, USA' }, ELIG('STD'));
  // …strict pins where a CITY/BOROUGH token still saves the classification:
  C('S6-F-5', "'123 Main St, Philadelphia, PA 19104, USA' → MANUAL via city token", { address: '123 Main St, Philadelphia, PA 19104, USA' }, MAN('address', 'Greater Philadelphia'));
  C('S6-F-6', "'349 Court St, Brooklyn, NY 11231, USA' → NYC via borough token", { address: '349 Court St, Brooklyn, NY 11231, USA' }, ELIG('NYC'));
  // punctuation/spacing torture that must NOT break the trailing-zip read
  C('S6-7', "double space before zip: '9 Elm St, Erie, PA  16501'", { address: '9 Elm St, Erie, PA  16501' }, ELIG('STD'));
  C('S6-8', "comma before zip: '9 Elm St, Erie, PA, 16501'", { address: '9 Elm St, Erie, PA, 16501' }, ELIG('STD'));
  C('S6-9', "trailing spaces after zip: '1 Court St, Brooklyn, NY 11201   '", { address: '1 Court St, Brooklyn, NY 11201   ' }, ELIG('NYC'));
  C('S6-10', "'St.' vs 'Street': '77 Water Street, Philadelphia PA 19106'", { address: '77 Water Street, Philadelphia PA 19106' }, MAN('address', 'Greater Philadelphia'));
  C('S6-11', "leading unit: 'Suite 300, 1650 Market St, Philadelphia, PA 19103'", { address: 'Suite 300, 1650 Market St, Philadelphia, PA 19103' }, MAN('address', 'Greater Philadelphia'));
  C('S6-12', "leading unit NYC: 'Apt 4B, 123 Court St, Brooklyn, NY 11201'", { address: 'Apt 4B, 123 Court St, Brooklyn, NY 11201' }, ELIG('NYC'));
})();

/* ===================================================================== *
 * S7 — near-match city traps (Standard's ineligible-cities interplay).
 *      NOTE: Silver carries its OWN state-scoped EXCLUDED_CITIES list
 *      (Philadelphia/PA, Chicago/IL, Baltimore/MD, Detroit/MI) — the
 *      Standard engine's STANDARD_INELIGIBLE_CITIES is NOT consulted.
 * ===================================================================== */
(function traps() {
  C('S7-1', "'Chicago Heights' IL, no zip → MANUAL (substring; a zip resolves)", { city: 'Chicago Heights', state: 'IL' }, MAN('city', 'Greater Chicago'));
  C('S7-2', "'Chicago Heights' + its real zip 60411 → prices (zip decides)", { city: 'Chicago Heights', state: 'IL', zip: '60411' }, ELIG('STD'));
  C('S7-3', "'North Chicago' IL, no zip → MANUAL", { city: 'North Chicago', state: 'IL' }, MAN('city', 'Greater Chicago'));
  C('S7-4', "'North Chicago' + 60064 → prices", { city: 'North Chicago', state: 'IL', zip: '60064' }, ELIG('STD'));
  C('S7-5', "'Chicago Ridge' + 60415 → prices", { city: 'Chicago Ridge', state: 'IL', zip: '60415' }, ELIG('STD'));
  C('S7-6', "'West Philadelphia' PA → MANUAL (it IS Philadelphia)", { city: 'West Philadelphia', state: 'PA' }, MAN('city', 'Greater Philadelphia'));
  C('S7-7', "'Philadelphia' PA + 19104 → INELIGIBLE", { city: 'Philadelphia', state: 'PA', zip: '19104' }, EXCL('zip', 'Greater Philadelphia'));
  C('S7-8', "'Philadelphia' NY (13673) → prices (state-scoped city list)", { city: 'Philadelphia', state: 'NY', zip: '13673' }, ELIG('STD'));
  C('S7-9', "'Philadelphia' NY, no zip → prices (state-scoped)", { city: 'Philadelphia', state: 'NY' }, ELIG('STD'));
  C('S7-10', "'Philadelphia' MS → prices (state-scoped)", { city: 'Philadelphia', state: 'MS' }, ELIG('STD'));
  C('S7-11', "'Hamtramck' MI, city only → prices (enclave — pinned note N5)", { city: 'Hamtramck', state: 'MI' }, ELIG('STD'));
  C('S7-12', "'Hamtramck' + 48212 → INELIGIBLE (the zip catches the enclave)", { city: 'Hamtramck', state: 'MI', zip: '48212' }, EXCL('zip', 'Greater Detroit'));
  C('S7-13', "'Cicero' IL, city only → prices (pinned note N5)", { city: 'Cicero', state: 'IL' }, ELIG('STD'));
  C('S7-14', "'Cicero' + 60804 → INELIGIBLE", { city: 'Cicero', state: 'IL', zip: '60804' }, EXCL('zip', 'Greater Chicago'));
  C('S7-15', "'Detroit Lakes' MN → INELIGIBLE (state MN wins)", { city: 'Detroit Lakes', state: 'MN' }, EXCL('state', 'Minnesota'));
  C('S7-16', "'Detroit Lakes', no state → MANUAL ('detroit' substring)", { city: 'Detroit Lakes' }, MAN('city', 'Greater Detroit'));
  C('S7-17', "'New York Mills' MN → INELIGIBLE (state)", { city: 'New York Mills', state: 'MN' }, EXCL('state', 'Minnesota'));
  C('S7-18', "'New York Mills' + spelled 'Minnesota' → INELIGIBLE (state normalizes)", { city: 'New York Mills', state: 'Minnesota' },
    EXCL('state', 'Minnesota'));
  C('S7-19', "'New York Mills' NY (13417) → prices STD (correct — upstate)", { city: 'New York Mills', state: 'NY' }, ELIG('STD'));
  C('S7-20', "'Baltimore' MD, no zip → MANUAL", { city: 'Baltimore', state: 'MD' }, MAN('city', 'Greater Baltimore'));
  C('S7-21', "'New Baltimore' MI (48047) → prices (state-scoped away from MD)", { city: 'New Baltimore', state: 'MI', zip: '48047' }, ELIG('STD'));
  C('S7-22', "'New Baltimore', no state, no zip → MANUAL ('baltimore' substring)", { city: 'New Baltimore' }, MAN('city', 'Greater Baltimore'));
  // N8 pins: a good consistent zip is decisive over any city name
  C('S7-23', "zip 11215 + city 'Chicago' → eligible NYC (zip decisive)", { zip: '11215', city: 'Chicago' }, ELIG('NYC'));
  C('S7-24', "zip 60601 + city 'Brooklyn' → INELIGIBLE Chicago (zip decisive)", { zip: '60601', city: 'Brooklyn' }, EXCL('zip', 'Greater Chicago'));
})();

/* ===================================================================== *
 * S8 — pricing / leverage consequence per classified market
 *      (GUC rate split, NYC grid holes, NYC product/size limits).
 * ===================================================================== */
(function pricingConsequence() {
  // GUC: the RATE itself differs by market (STD 8.625% vs NYC 9.375% note)
  C('S8-1', 'GUC STD (Dallas TX 75201)', { city: 'Dallas', state: 'TX', zip: '75201' }, ELIG('STD'), { shape: 'GUC' });
  C('S8-2', 'GUC NYC (Brooklyn NY 11215)', { city: 'Brooklyn', state: 'NY', zip: '11215' }, ELIG('NYC'), { shape: 'GUC' });
  C('S8-3', 'GUC NYC by borough name only', { city: 'Queens', state: 'NY' }, ELIG('NYC'), { shape: 'GUC' });
  C('S8-4', 'GUC NYC by zip 11004', { zip: '11004' }, ELIG('NYC'), { shape: 'GUC' });
  // FICO 680: STD prices, NYC has NO cell at any leverage → MANUAL, key stays NYC|
  C('S8-5', 'FF fico680 STD prices', { city: 'Dallas', state: 'TX', zip: '75201' }, ELIG('STD'), { shape: 'FF680' });
  C('S8-6', 'FF fico680 NYC → MANUAL no-priced-cell (never falls back to STD grid)',
    { city: 'Brooklyn', state: 'NY', zip: '11215' },
    { geo: 'NONE', market: 'NYC', status: 'MANUAL', priced: false, keyStartsWith: 'NYC|S|FF|P|12|T1' }, { shape: 'FF680' });
  // NYC market limits ride the geography classification
  C('S8-7', 'NYC F&F REFI → INELIGIBLE (not offered in the five boroughs)',
    { zip: '11215', state: 'NY', loanType: 'Refinance', asIsValue: 500000 },
    { geo: 'NONE', market: 'NYC', status: 'INELIGIBLE', priced: false });
  C('S8-8', 'STD F&F refi control (prices)',
    { zip: '75201', state: 'TX', loanType: 'Refinance', asIsValue: 500000 },
    { geo: 'NONE', market: 'STD', status: 'ELIGIBLE', pricedAny: true, keyStartsWith: 'STD|' });
  // (large band needs 5+ comparable projects for Tier 1 — give 6 flips so the
  //  STD control is tier-eligible and the NYC refusal is purely geographic)
  C('S8-9', 'NYC loan over $2.5M → INELIGIBLE',
    { zip: '11215', state: 'NY', loanAmount: 3000000, purchasePrice: 4000000, rehabBudget: 500000, arv: 7000000, expFlips: 6 },
    { geo: 'NONE', market: 'NYC', status: 'INELIGIBLE', priced: false });
  C('S8-10', 'STD loan over $2.5M control (prices on the LARGE grid)',
    { zip: '75201', state: 'TX', loanAmount: 3000000, purchasePrice: 4000000, rehabBudget: 500000, arv: 7000000, expFlips: 6 },
    { geo: 'NONE', market: 'STD', status: 'ELIGIBLE', pricedAny: true, keyStartsWith: 'STD|L|FF|P|12|T1' });
  // the zip/state contradiction is caught BEFORE pricing, so the wrong-market
  // rate can never be charged (fixed 2026-07-30)
  C('S8-11', 'GUC + NYC zip 11215 + state NJ → MANUAL zipstate, never priced',
    { zip: '11215', state: 'NJ' }, MAN('zipstate', 'NYC five boroughs'), { shape: 'GUC' });
})();

/* ===================================================================== *
 * Run
 * ===================================================================== */
const t0 = Date.now();
let pass = 0;
const failures = [];
const gapStanding = {}; // gapId -> [case]
const gapFixed = {};    // gapId -> [case]

for (const c of CASES) {
  let o;
  try {
    o = classify(c.input, c.shape);
  } catch (e) {
    failures.push({ c, why: ['classify threw: ' + e.message] });
    continue;
  }
  const mSpec = check(c.spec, o, c.shape);
  if (!c.gap) {
    if (mSpec.length) failures.push({ c, why: mSpec, o });
    else pass++;
    continue;
  }
  if (!mSpec.length) {
    (gapFixed[c.gap] = gapFixed[c.gap] || []).push(c);
    pass++;
    continue;
  }
  const mObs = check(c.observed, o, c.shape);
  if (!mObs.length) {
    (gapStanding[c.gap] = gapStanding[c.gap] || []).push(c);
    pass++;
  } else {
    failures.push({ c, why: ['matches NEITHER spec nor recorded observed behavior', 'vs spec: ' + mSpec.join(' | '), 'vs observed: ' + mObs.join(' | ')], o });
  }
}

/* ---------------- report ---------------- */
const total = CASES.length + s0Pass + s0Fail.length;
console.log('Silver address-capability battery');
console.log(`  spec cross-checks: ${s0Pass} ok${s0Fail.length ? `, ${s0Fail.length} FAILED: ${s0Fail.join('; ')}` : ''}`);
console.log(`  generated cases:   ${CASES.length}  (seeded, deterministic)`);

if (failures.length || s0Fail.length) {
  console.log('\n================ FAILURES ================');
  for (const f of failures.slice(0, 40)) {
    console.log(`FAIL ${f.c.id} — ${f.c.desc}`);
    console.log(`   input:    ${JSON.stringify(f.c.input)}  shape=${f.c.shape}`);
    if (f.o) console.log(`   observed: ${JSON.stringify(f.o)}`);
    for (const w of f.why) console.log(`   - ${w}`);
  }
  if (failures.length > 40) console.log(`   … and ${failures.length - 40} more`);
}

const standingIds = Object.keys(gapStanding);
if (standingIds.length) {
  console.log('\n============================================================');
  console.log(' KNOWN-GAPS — engine disagrees with the geography spec.');
  console.log(' The battery is GREEN because each case pins the OBSERVED');
  console.log(' behavior; fix the engine (owner authority), re-run, and');
  console.log(' flip the reported-fixed cases to strict.');
  console.log('============================================================');
  for (const g of standingIds.sort()) {
    const meta = GAPS[g] || {};
    const cs = gapStanding[g];
    console.log(`\n${g} — ${meta.title || ''}   [${cs.length} case${cs.length === 1 ? '' : 's'}]`);
    console.log(`   spec:     ${meta.spec || ''}`);
    console.log(`   observed: ${meta.observed || ''}`);
    console.log(`   repro:    ${meta.repro || ''}`);
    for (const c of cs.slice(0, 3)) console.log(`   e.g. ${c.id}: ${c.desc}  input=${JSON.stringify(c.input)}`);
    if (cs.length > 3) console.log(`   … and ${cs.length - 3} more cases`);
  }
}

const fixedIds = Object.keys(gapFixed);
if (fixedIds.length) {
  console.log('\n============ GAPS FIXED — flip these cases to strict ============');
  for (const g of fixedIds.sort()) {
    console.log(`${g}: ${gapFixed[g].length} case(s) now match the SPEC — remove their gap/observed marking.`);
  }
}

console.log('\n---------------- NOTES (pinned engine behaviors, not gaps) ----------------');
for (const n of NOTES) console.log('  ' + n);

const gapCaseCount = standingIds.reduce((a, g) => a + gapStanding[g].length, 0);
const fixedCaseCount = fixedIds.reduce((a, g) => a + gapFixed[g].length, 0);
console.log('\n---------------- SUMMARY ----------------');
console.log(`  total checks:      ${total}`);
console.log(`  passed:            ${pass + s0Pass}`);
console.log(`  strict passes:     ${pass - gapCaseCount - fixedCaseCount + s0Pass}`);
console.log(`  KNOWN-GAP pinned:  ${gapCaseCount} case(s) across ${standingIds.length} gap(s)`);
console.log(`  gap-fixed:         ${fixedCaseCount}`);
console.log(`  failures:          ${failures.length + s0Fail.length}`);
console.log(`  runtime:           ${((Date.now() - t0) / 1000).toFixed(1)}s`);

if (failures.length || s0Fail.length) {
  console.error('\nsilver address battery: FAILED');
  process.exit(1);
} else {
  console.log('\nsilver address battery: OK' + (standingIds.length ? ` (with ${standingIds.length} standing KNOWN-GAPs — see above)` : ''));
}
