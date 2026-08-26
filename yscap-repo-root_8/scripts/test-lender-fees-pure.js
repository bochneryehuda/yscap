'use strict';
/**
 * OUR OWN FEE, SPLIT IN TWO, AND THE NEW YORK LEGAL LADDER — owner-authorized 2026-08-26, and this
 * suite is what the frozen-pricing HARD RULE demands beside any authorized fee change: a proof,
 * over a broad battery, that the ONLY thing that moved is the thing the owner asked to move.
 *
 * The owner: *"Right now, we have $2,195 for our total fees. I want to split it up for: general
 * products: $1,200 underwriting, processing; $995 legal fee for general files … So the total stays
 * the same for general loans."* … *"For any New York file, remove the extra settlement fee that we
 * have now listed for New York files and replace it with higher legal fees instead of $995 … If
 * it's in the five boroughs or the construction's worth $100,000, then it's $2,500. For any
 * ground-up, the standard price is $2,000 in general. If it's in New York, then it's $2,500."* …
 * *"Pre-fill an optional settlement fee of $500 to $750 … it should say on the term sheet
 * everywhere that it's optional, but it should be included in calculating the cash to close."*
 *
 * WHAT IS PROVEN HERE:
 *   A. THE LADDER — every rung, in the owner's own words, and the ORDER that makes it right.
 *   B. THE TOTAL IS PRESERVED BY CONSTRUCTION on a general file — 1,200 + 995 = 2,195 — and, over
 *      a priced battery, a general deal is BYTE-IDENTICAL to the same deal before the split.
 *   C. THE FIVE BOROUGHS ARE THE SHARED DEFINITION. `gov-charges.js` already answers "is this
 *      property in New York City?" (it decides the NYC mortgage recording tax, the largest single
 *      number on a New York City closing). A second list here would be a second copy of one rule,
 *      and the copy that drifts is the one that leaks — so this asserts we DELEGATE, agree with it
 *      over a battery, and carry no list of our own.
 *   D. THE MANUAL BOXES behave as the owner described, per part.
 *   E. THE OPTIONAL SETTLEMENT FEE — and that the MANDATORY one it replaces is gone from the code
 *      fallback as well as from the database, because either one alone leaves a double charge.
 *   F. THE BROWSER MIRROR AGREES WITH THE SERVER, over the same battery — and the RULE is asserted
 *      on both sides, not only their agreement (two copies of one mistake read as a pass).
 *   G. IT GOES TO AN ADMIN FOR APPROVAL, per part, with the right zero rule for each.
 *   H. THE FEES ARE NAMED ON EVERY SURFACE THAT PRINTS FEES — folding an amount into a total is
 *      HALF a fee, and that is exactly how the feasibility fee shipped invisible for five days.
 *   I. ONE WRITER for the per-file columns, which is why db/632 does not widen the reopen trigger.
 *
 * Run: node scripts/test-lender-fees-pure.js
 */
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const eq = (name, got, exp) => { if (JSON.stringify(got) === JSON.stringify(exp)) pass++; else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`); } };

const L = require('../src/lib/lender-fees');
const O = require('../src/lib/pricing-overrides');
const GOV = require('../src/lib/closing-costs');

// ── A. The ladder ────────────────────────────────────────────────────────────
{
  const legal = (deal) => L.legalFeeFor(deal, L.SYSTEM_LENDER_FEES);

  eq('A1 a general file is the owner\'s $995', legal({ state: 'NJ' }), { amount: 995, basis: 'general' });
  eq('A2 "for any ground-up, the standard price is $2,000 in general"',
    legal({ state: 'NJ', groundUp: true }), { amount: 2000, basis: 'ground_up' });
  eq('A3 "…if it\'s in New York, then it\'s $2,500"',
    legal({ state: 'NY', city: 'Albany', groundUp: true }), { amount: 2500, basis: 'ground_up_ny' });
  eq('A4 "any New York file should populate a base fee of $2,000 legal fee"',
    legal({ state: 'NY', city: 'Albany', county: 'Albany' }), { amount: 2000, basis: 'ny_base' });
  eq('A5 "if it\'s in the five boroughs … then it\'s $2,500"',
    legal({ state: 'NY', city: 'Brooklyn' }), { amount: 2500, basis: 'ny_five_boroughs' });
  eq('A6 "…or the construction\'s worth $100,000, then it\'s $2,500"',
    legal({ state: 'NY', city: 'Albany', construction: 100000 }), { amount: 2500, basis: 'ny_construction' });
  eq('A7 "the base fee for a smaller construction (less than $100,000)" stays at $2,000',
    legal({ state: 'NY', city: 'Albany', construction: 99999 }), { amount: 2000, basis: 'ny_base' });
  eq('A8 "on heavier rehab in New York … should pre-populate as $2,500"',
    legal({ state: 'NY', city: 'Albany', heavyRehab: true }), { amount: 2500, basis: 'ny_heavy_rehab' });

  /* THE $100,000 BOUNDARY IS INCLUSIVE, and it is a reading of the owner's words rather than a
     coin toss: they described the LOWER fee as being for "a smaller construction (less than
     $100,000)" and the HIGHER one as "the construction's worth $100,000". */
  ok('A9 the $100,000 boundary is INCLUSIVE of $100,000', legal({ state: 'NY', construction: 100000 }).amount === 2500
    && legal({ state: 'NY', construction: 99999.99 }).amount === 2000);

  /* THE ORDER IS LOAD-BEARING. A ground-up carries its OWN base wherever it is, so deciding New
     York first would price a non-New-York ground-up at the general $995 — and asking heavy rehab
     first would put every New York ground-up on the heavy-rehab rung by a different route. */
  eq('A10 ground-up is decided FIRST — a New York ground-up is a ground-up, not "a New York file"',
    legal({ state: 'NY', city: 'Brooklyn', groundUp: true, heavyRehab: true, construction: 500000 }).basis, 'ground_up_ny');
  eq('A11 …and a non-New-York ground-up keeps its own base rather than the general fee',
    legal({ state: 'TX', groundUp: true }).amount, 2000);
  /* A11b PINS THE ORDER INSIDE NEW YORK ON ITS OWN, not only through the mirror-agreement check in
     section F. Both New York rungs are $2,500, so mis-ordering them charges the same money and
     changes only the reason a screen gives for it — which the money-comparing assertions cannot
     see, and which a mutation applied to BOTH copies would sail past (a mirror-agreement test
     proves consistency, never correctness). A Brooklyn heavy rehab is a New York CITY file: that
     is the more informative answer, and it is the one the ladder is documented to give. */
  eq('A11b a Brooklyn heavy rehab is explained as a New York City file, not as a heavy rehab',
    legal({ state: 'NY', city: 'Brooklyn', heavyRehab: true, construction: 500000 }).basis, 'ny_five_boroughs');
  eq('A11c …and an upstate heavy rehab with a big budget is explained by the budget',
    legal({ state: 'NY', city: 'Albany', heavyRehab: true, construction: 500000 }).basis, 'ny_construction');

  /* A NON-NEW-YORK HEAVY REHAB IS DELIBERATELY NOT ON THE LADDER — the owner named heavy rehab
     only inside New York. It is a PRE-FILL either way, editable on the file. */
  eq('A12 a heavy rehab OUTSIDE New York stays at the general fee — the owner named it only for NY',
    legal({ state: 'NJ', heavyRehab: true }), { amount: 995, basis: 'general' });
  eq('A13 …and so does a big construction budget outside New York',
    legal({ state: 'NJ', construction: 900000 }), { amount: 995, basis: 'general' });

  // The state is matched on the code or the full name — a file can carry either.
  eq('A14 "New York" spelled out is New York', legal({ state: 'New York' }).basis, 'ny_base');
  eq('A15 …in any casing', legal({ state: ' ny ' }).basis, 'ny_base');
  ok('A16 a blank state is not New York', legal({ state: '' }).basis === 'general' && legal({}).basis === 'general');

  // Every rung has words a screen can explain the number with.
  const rungs = ['general', 'ground_up', 'ground_up_ny', 'ny_base', 'ny_five_boroughs', 'ny_construction', 'ny_heavy_rehab', 'manual', 'typed_total'];
  ok('A17 every rung the ladder can land on has plain words beside it',
    rungs.every((r) => typeof L.LEGAL_BASIS_TEXT[r] === 'string' && L.LEGAL_BASIS_TEXT[r].length > 5));
}

// ── B. The total is preserved by construction ────────────────────────────────
{
  const g = L.lenderFeesFor({ state: 'NJ' }, {}, {});
  eq('B1 the general split is the owner\'s two numbers', [g.underwriting, g.legal], [1200, 995]);
  eq('B2 "so the total stays the same for general loans" — 1,200 + 995 = 2,195', g.total, 2195);
  ok('B3 …and that is the literal the system used before the split',
    g.total === require('../src/lib/pricing-settings').SYSTEM_DEFAULTS.lenderFee);
  ok('B4 a general file reports itself as SPLIT, so a surface knows to itemise it', g.split === true);

  /* THE LEGACY WHOLE-NUMBER BOX still wins, and then nothing is split: a quote registered before
     today rides that key, and inventing two figures nobody chose would put a split on a term sheet
     that was signed without one. */
  const t = L.lenderFeesFor({ state: 'NY', city: 'Brooklyn' }, {}, { total: 2195 });
  eq('B5 a typed whole-number TOTAL wins over the ladder', t.total, 2195);
  ok('B6 …and reports split:false, so the sheet prints the one combined line it always printed',
    t.split === false && t.legalBasis === 'typed_total');
}

// ── C. The five boroughs are the SHARED definition ───────────────────────────
{
  /* C1 IS A SOURCE GUARD, and it is the one that matters. A second borough list here would pass
     every behavioural test in this file on the day it was written and silently drift afterwards —
     so what is asserted is that there is no list to drift. */
  const src = fs.readFileSync(path.join(REPO, 'src/lib/lender-fees.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');   // the header NAMES the boroughs while explaining why they are not here
  ok('C1 the module keeps no borough list of its own — it delegates',
    !/brooklyn|staten\s*island|\bkings\b|\bqueens\b|manhattan/i.test(src));
  ok('C2 …and reaches the ONE definition through the shared closing-cost module',
    /require\(['"]\.\/closing-costs['"]\)/.test(src) && /gov\.NYC_COUNTIES/.test(src) && /gov\.isNycCity/.test(src));

  // C3: it answers exactly what gov-charges answers, over every spelling a file carries.
  const CITY = ['Brooklyn', 'BROOKLYN', 'New York', 'New York City', 'NYC', 'Bronx', 'Queens',
    'Staten Island', 'Manhattan', 'Albany', 'Buffalo', 'Yonkers', 'Rochester', '', 'Richmond Hill'];
  const COUNTY = ['Kings', 'Kings County', 'KINGS CO.', 'Richmond', 'Queens', 'Bronx', 'New York',
    'Albany', 'Erie', 'Westchester', '', 'Suffolk'];
  let disagree = 0, hits = 0;
  for (const city of CITY) {
    for (const county of COUNTY) {
      const mine = L.isFiveBoroughs({ city, county });
      const theirs = GOV.NYC_COUNTIES.has(GOV.normCounty(county)) || GOV.isNycCity(city);
      if (mine !== theirs) { disagree++; if (disagree < 4) console.log(`   …disagree on ${city}/${county}`); }
      if (mine) hits++;
    }
  }
  eq('C3 the module and the shared rule agree on every city × county spelling', disagree, 0);
  ok('C4 …over a battery that actually reaches the boroughs', hits > 40 && hits < CITY.length * COUNTY.length);

  /* C5 THE NEGATIVE CONTROL, and it is not academic: Richmond is a borough county in New York AND
     a city in Virginia. The state is established before the borough is ever asked, so the Virginia
     property can never read as Staten Island. */
  eq('C5 Richmond, VIRGINIA is not Staten Island',
    L.legalFeeFor({ state: 'VA', city: 'Richmond', county: 'Richmond' }, L.SYSTEM_LENDER_FEES),
    { amount: 995, basis: 'general' });
  eq('C6 …while Richmond COUNTY, New York is', L.legalFeeFor({ state: 'NY', county: 'Richmond' }, L.SYSTEM_LENDER_FEES).basis, 'ny_five_boroughs');
  /* C7 A property address reliably carries a CITY and only some carry a county, so the county is
     asked first and the city is the fallback — Richmond Hill is in Queens and its city name is in
     no borough list, which is exactly the case a hand-written list gets wrong. */
  eq('C7 a borough resolved by COUNTY where the city name is in no list', L.isFiveBoroughs({ city: 'Richmond Hill', county: 'Queens' }), true);
}

// ── D. The manual boxes ──────────────────────────────────────────────────────
{
  const ny = { state: 'NY', city: 'Brooklyn' };
  eq('D1 a typed legal fee overrides this deal\'s rung', L.lenderFeesFor(ny, {}, { legal: 1500 }).legal, 1500);
  eq('D2 …and says it was typed, not which rung it took', L.lenderFeesFor(ny, {}, { legal: 1500 }).legalBasis, 'manual');
  eq('D3 …while the other part is untouched', L.lenderFeesFor(ny, {}, { legal: 1500 }).underwriting, 1200);
  eq('D4 a typed underwriting fee overrides only its own part',
    [L.lenderFeesFor(ny, {}, { underwriting: 900 }).underwriting, L.lenderFeesFor(ny, {}, { underwriting: 900 }).legal], [900, 2500]);
  eq('D5 a typed 0 WAIVES that part — a number somebody typed, never "unset"',
    L.lenderFeesFor(ny, {}, { legal: 0 }).total, 1200);
  eq('D6 a BLANK box means "use this deal\'s own rung", never a waiver',
    L.lenderFeesFor(ny, {}, { legal: '' }).legal, 2500);
  eq('D7 junk states nothing rather than becoming a zero fee', L.lenderFeesFor(ny, {}, { legal: 'abc' }).legal, 2500);
  eq('D8 …and so does a negative', L.lenderFeesFor(ny, {}, { legal: -50 }).legal, 2500);
  eq('D9 a decimal slip past five figures is refused rather than quietly charged',
    L.lenderFeesFor(ny, {}, { legal: 250000 }).legal, 2500);
  eq('D10 both parts typed', L.lenderFeesFor(ny, {}, { underwriting: 100, legal: 200 }).total, 300);

  // The company can move any rung — "everything of this should not be hardwired".
  const co = { lenderFees: { underwriting: 1000, legal: 800, legalNyHigh: 3000 } };
  eq('D11 a company-configured rung is used', L.lenderFeesFor(ny, co, {}).legal, 3000);
  eq('D12 …and a company-configured underwriting number', L.lenderFeesFor(ny, co, {}).underwriting, 1000);
  eq('D13 an unreadable stored value falls back to the owner\'s number, never to nothing',
    L.cleanLenderFees({ legal: 'oops', underwriting: null }), { ...L.SYSTEM_LENDER_FEES });
}

// ── E. The optional New York settlement agent fee ────────────────────────────
{
  const s = L.settlementFeeFor({ state: 'NY' }, {}, {});
  ok('E1 a New York file is pre-filled with the fee', s && s.amount === 750);
  ok('E2 …at the TOP of the owner\'s $500–$750 range, the end that cannot leave a borrower short',
    s.amount === 750 && L.SYSTEM_LENDER_FEES.settlementNy === 750);
  ok('E3 …and it SAYS it is optional, on its face', s.optional === true && /optional/i.test(s.label));
  ok('E4 …with the explanation that rides with it', (s.note || '').length > 30 && /optional/i.test(s.note));
  eq('E5 a file outside New York carries none', L.settlementFeeFor({ state: 'NJ' }, {}, {}), null);
  eq('E6 a typed amount overrides the pre-fill', L.settlementFeeFor({ state: 'NY' }, {}, { settlement: 500 }).amount, 500);
  eq('E7 a typed 0 DECLINES it — which is what "optional" means', L.settlementFeeFor({ state: 'NY' }, {}, { settlement: 0 }), null);
  ok('E8 …and a typed amount applies even outside New York, which is the point of a manual box',
    (L.settlementFeeFor({ state: 'NJ' }, {}, { settlement: 400 }) || {}).amount === 400);
  eq('E9 a company that sets it to zero offers nothing',
    L.settlementFeeFor({ state: 'NY' }, { lenderFees: { settlementNy: 0 } }, {}), null);

  /* E10-E12: THE MANDATORY ONE IT REPLACES IS GONE FROM THE CODE FALLBACK TOO. `extraFees` in
     SYSTEM_DEFAULTS is the COLD-CACHE fallback — an unwarmed process reads it — so removing the
     $2,000 New York row from the database and leaving it here would re-apply it on any process
     that had not yet loaded the settings row, and bill a New York borrower for both. */
  const PS = require('../src/lib/pricing-settings');
  const nySettlement = (PS.SYSTEM_DEFAULTS.extraFees || []).filter(
    (f) => String(f.state || '').toUpperCase() === 'NY' && /settlement/i.test(String(f.name || '')));
  eq('E10 the mandatory New York settlement fee is gone from the cold-cache fallback', nySettlement, []);
  eq('E11 …and the fallback carries no extra fee at all now', PS.SYSTEM_DEFAULTS.extraFees, []);
  ok('E12 the migration removes it from the settings row as well — either one alone leaves the double charge',
    /extra_fees/.test(fs.readFileSync(path.join(REPO, 'db/632_lender_fee_split_underwriting_legal_ny_ladder_settlement.sql'), 'utf8')));
}

// ── E2. The New York CEMA ────────────────────────────────────────────────────
{
  const cema = (deal, opts) => L.cemaFeeFor(deal, {}, opts || {});
  const NYR = { state: 'NY', refinance: true };
  eq('E13 "it should be turned off by default" — a New York refinance carries none unless asked',
    cema(NYR, {}), null);
  ok('E14 …and answering YES populates the owner\'s $1,000',
    (cema(NYR, { cema: true }) || {}).amount === 1000);
  ok('E15 …named, with the explanation that rides with it',
    /CEMA/i.test((cema(NYR, { cema: true }) || {}).label) && ((cema(NYR, { cema: true }) || {}).note || '').length > 40);
  /* A CEMA CONSOLIDATES AN EXISTING MORTGAGE, so it can only exist on a refinance — and only in
     New York, where the instrument is. Both are refusals, not warnings: the fee is simply absent. */
  eq('E16 a New York PURCHASE can never be a CEMA', cema({ state: 'NY', refinance: false }, { cema: true }), null);
  eq('E17 …and neither can a refinance outside New York', cema({ state: 'NJ', refinance: true }, { cema: true }), null);
  eq('E18 a typed amount overrides the pre-fill', cema(NYR, { cema: true, cemaFee: 600 }).amount, 600);
  eq('E19 …and a typed 0 waives it on that file', cema(NYR, { cema: true, cemaFee: 0 }), null);
  eq('E20 a company-configured amount is used', L.cemaFeeFor(NYR, { lenderFees: { cemaNy: 1500 } }, { cema: true }).amount, 1500);
  /* "Should a screen ASK?" and "is it one?" are different questions — a prompt that only appeared
     once the answer was already yes would be useless, which is why `cemaApplies` exists. */
  ok('E21 the question is asked on a New York refinance and nowhere else',
    L.cemaApplies(NYR) === true && L.cemaApplies({ state: 'NY', refinance: false }) === false
    && L.cemaApplies({ state: 'NJ', refinance: true }) === false);
  /* ANY truthy-but-not-true answer is a NO. The flag reaches this module through a boolean
     override, and reading a stray string as a yes would charge a fee nobody agreed to. */
  ok('E22 only an explicit TRUE turns it on', cema(NYR, { cema: 'yes' }) === null && cema(NYR, { cema: 1 }) === null);
}

// ── F. The browser mirror agrees with the server ─────────────────────────────
//
// The Term Sheet Studio cannot require server code, so `web/v2/tools/termsheet.js` carries its own
// copy of these rules — the same arrangement `lib/payoff.js` and the feasibility fee already use.
// A studio that PRINTS one fee while the register BOOKS another is precisely the drift the "one
// definition" rule exists to stop.
{
  const ts = fs.readFileSync(path.join(REPO, 'web/v2/tools/termsheet.js'), 'utf8');
  const grab = (name) => {
    const m = new RegExp(`\\n  function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`).exec(ts);
    return m ? m[0] : null;
  };
  const parts = ['isNyFile', 'nycFile', 'coLenderFees', 'legalRung', 'lenderFeeParts', 'settlementFee', 'feasKind'];
  const srcs = parts.map(grab);
  ok('F1 the studio\'s own copy of the rules was found', srcs.every(Boolean));

  if (srcs.every(Boolean)) {
    /* Rebuilt with the studio's DOM and engine dependencies stubbed, so the RULE is what is
       compared and not the browser around it. `YSGov` is handed in for REAL — it is the same
       module the server reaches through closing-costs.js, which is the whole point of C1. */
    // eslint-disable-next-line no-new-func
    const mirror = new Function('deal', 'CO', 'YSGov', `
      var YSP = { normStrategy: function (x) { var s = String(x || '').toLowerCase();
        if (s.indexOf('ground') > -1 || s.indexOf('construction') > -1 || s === 'nc') return 'NC';
        if (s.indexOf('bridge') > -1 || s === 'br') return 'BR';
        return 'FF'; } };
      function dealType() { return deal.strategy || ''; }
      function govCity() { return deal.city || ''; }
      function val(id) {
        if (id === 'propState') return deal.state || '';
        if (id === 'tsTaxCounty') return deal.county || '';
        if (id === 'rehabScope') return deal.heavyRehab ? 'heavy' : '';
        return '';
      }
      function num(id) { return id === 'construction' ? (Number(deal.construction) || 0) : 0; }
      function adminNumRaw(id) {
        var t = deal.typed || {};
        if (id === 'tsFeeUW') return t.total == null ? null : t.total;
        if (id === 'tsFeeUwPart') return t.underwriting == null ? null : t.underwriting;
        if (id === 'tsFeeLegal') return t.legal == null ? null : t.legal;
        if (id === 'tsFeeSettlement') return t.settlement == null ? null : t.settlement;
        return null;
      }
      ${srcs.join('\n')}
      return { parts: lenderFeeParts(), settlement: settlementFee() };`);

    // The same battery both sides are asked about.
    const CASES = [];
    for (const state of ['NJ', 'NY', 'TX', 'New York', '']) {
      for (const city of ['Brooklyn', 'Albany', 'Staten Island', '', 'New York']) {
        for (const county of ['Kings', 'Albany', '', 'Richmond']) {
          for (const strategy of ['Fix & Flip', 'Ground-up Construction', 'Bridge / Stabilized']) {
            for (const heavyRehab of [true, false]) {
              for (const construction of [0, 40000, 100000, 400000]) {
                for (const typed of [{}, { legal: 1500 }, { underwriting: 800 }, { total: 2195 }, { settlement: 0 }, { legal: 0 }]) {
                  CASES.push({ state, city, county, strategy, heavyRehab, construction, typed });
                }
              }
            }
          }
        }
      }
    }
    let bad = 0;
    for (const c of CASES) {
      const b = mirror(c, {}, GOV);
      const server = L.lenderFeesFor({
        state: c.state, city: c.city, county: c.county,
        groundUp: require('../src/lib/feasibility-fee').isGroundUpDeal({ strategy: c.strategy }),
        heavyRehab: c.heavyRehab, construction: c.construction,
      }, {}, c.typed);
      const sSet = L.settlementFeeFor({ state: c.state }, {}, c.typed);
      const sAmt = sSet ? sSet.amount : 0;
      if (b.parts.underwriting !== server.underwriting || b.parts.legal !== server.legal
        || b.parts.total !== server.total || b.parts.split !== server.split
        || b.parts.basis !== server.legalBasis || b.settlement !== sAmt) {
        bad++;
        if (bad < 4) console.log(`   …disagree on ${JSON.stringify(c)}: browser=${JSON.stringify(b)} server=${JSON.stringify(server)}/${sAmt}`);
      }
    }
    eq('F2 the studio and the server quote the SAME fees on every case', bad, 0);
    ok('F3 …over a battery big enough to mean something', CASES.length >= 1000);

    /* F4-F6: AND THE RULE ITSELF, ON BOTH SIDES. A mirror-agreement test proves CONSISTENCY, never
       CORRECTNESS — the feasibility fee's own B5 passed for months while both copies charged a
       bridge for construction that was not happening. So the owner's headline cases are asserted
       against the BROWSER directly, not only against the server. */
    const bParts = (d) => mirror(d, {}, GOV).parts;
    eq('F4 the studio prices a general file at the owner\'s split',
      [bParts({ state: 'NJ', strategy: 'Fix & Flip' }).underwriting, bParts({ state: 'NJ', strategy: 'Fix & Flip' }).legal], [1200, 995]);
    eq('F5 …a Brooklyn file at $2,500 legal', bParts({ state: 'NY', city: 'Brooklyn', strategy: 'Fix & Flip' }).legal, 2500);
    eq('F6 …and a non-New-York ground-up at its own $2,000',
      bParts({ state: 'TX', strategy: 'Ground-up Construction' }).legal, 2000);
    eq('F7 the studio pre-fills the optional settlement fee on a New York file only',
      [mirror({ state: 'NY' }, {}, GOV).settlement, mirror({ state: 'NJ' }, {}, GOV).settlement], [750, 0]);
  }
}

// ── G. It goes to an admin for approval ──────────────────────────────────────
{
  const keys = (o, d) => O.pricingOverridesEngaged(o, d || {}).map((x) => x.key);
  const CD = { underwritingFee: 1200 };
  ok('G1 a DISCOUNTED underwriting fee needs an admin approval', keys({ underwritingFee: 900 }, CD).includes('underwritingFee'));
  ok('G2 …typing the company default back is not a change', !keys({ underwritingFee: 1200 }, CD).includes('underwritingFee'));
  ok('G3 …and charging MORE than the default earns the company more, so it needs none',
    !keys({ underwritingFee: 1500 }, CD).includes('underwritingFee'));
  ok('G4 a typed legal fee needs an approval — its default is keyed on the deal, so any amount is a departure',
    keys({ legalFee: 1500 }).includes('legalFee'));
  ok('G5 …and so does WAIVING it, which is the decision an admin most wants to see',
    keys({ legalFee: 0 }).includes('legalFee'));
  ok('G6 a typed settlement fee needs an approval', keys({ settlementFee: 500 }).includes('settlementFee'));
  /* G7 IS THE ONE PLACE THE ZERO RULE IS DELIBERATELY THE OTHER WAY. The settlement fee is
     OPTIONAL by the owner's own description, so declining it is its ordinary state — routing every
     declined optional fee to an admin would fill the queue with non-decisions. */
  ok('G7 …but DECLINING the optional one does not, because declining it is what "optional" means',
    !keys({ settlementFee: 0 }).includes('settlementFee'));
  ok('G8 an untouched box needs nothing', !keys({}).length);
  ok('G9 …and neither does an explicitly blanked one', !keys({ legalFee: '', underwritingFee: '', settlementFee: '' }, CD).length);
  // A borrower can never set any of them.
  const b = O.borrowerPricingOverrides({ underwritingFee: 1, legalFee: 1, settlementFee: 1, lenderFee: 1 });
  eq('G10 a borrower can never send a fee override', Object.keys(b).filter((k) => /Fee$/.test(k)), []);
}

// ── H. The fees are NAMED on every surface that prints fees ──────────────────
//
// Folding an amount into a total is HALF a fee — the rule the feasibility fee was written into
// this file to enforce after it shipped charged-but-unnamed on the one document that goes out for
// signature. CI has no browser, so what is enforced on every build is that each surface still
// REFERENCES the parts, keyed on that surface's OWN data variable so one column cannot cover
// for another.
{
  const ts = fs.readFileSync(path.join(REPO, 'web/v2/tools/termsheet.js'), 'utf8');
  const between = (from, to) => {
    const a = ts.indexOf(from); if (a < 0) return '';
    const b = ts.indexOf(to, a); return b < 0 ? ts.slice(a) : ts.slice(a, b);
  };
  const pdfBlock = between('cardHead(xR, colW, "Estimated cash to close"', 'liqLbl');
  ok('H1 the term sheet PDF names both parts', /d\.uwFee/.test(pdfBlock) && /d\.legalFee/.test(pdfBlock));
  ok('H2 …and the optional settlement fee, by its own optional-bearing label',
    /d\.settleFee/.test(pdfBlock) && /d\.settleLabel/.test(pdfBlock));
  ok('H3 …and still prints the single combined line for a file that typed a whole-number total',
    /d\.feeSplit/.test(pdfBlock) && /d\.lenderFee/.test(pdfBlock));
  // Each spreadsheet column, keyed on its own data variable. `var silver;` (with the semicolon)
  // because `var silver` also matches `var silverChosenRung` thousands of lines earlier.
  ok('H4 the spreadsheet Standard column names them', /\bd\.uwFee\b/.test(between('var std = [', 'var gold')) && /\bd\.settleFee\b/.test(between('var std = [', 'var gold')));
  ok('H5 the spreadsheet Gold column names them', /\bgd\.uwFee\b/.test(between('var gold;', 'var silver;')) && /\bgd\.settleFee\b/.test(between('var gold;', 'var silver;')));
  ok('H6 the spreadsheet Silver column names them', /\bsd\.uwFee\b/.test(between('var silver;', 'return {')) && /\bsd\.settleFee\b/.test(between('var silver;', 'return {')));
  // And the studio panel the officer prices against.
  ok('H7 the studio panel names them', /rLenderSub/.test(ts) && /rSettle/.test(ts));
  ok('H7b the term sheet PDF names the New York CEMA fee', /d\.cemaFee/.test(pdfBlock) && /d\.cemaLabel/.test(pdfBlock));
  ok('H7c the spreadsheet Standard column names it', /\bd\.cemaFee\b/.test(between('var std = [', 'var gold')));
  ok('H7d the spreadsheet Gold column names it', /\bgd\.cemaFee\b/.test(between('var gold;', 'var silver;')));
  ok('H7e the spreadsheet Silver column names it', /\bsd\.cemaFee\b/.test(between('var silver;', 'return {')));
  ok('H7f the studio panel names it', /rCemaRow/.test(ts));
  const html = fs.readFileSync(path.join(REPO, 'web/v2/tools/term-sheet.html'), 'utf8');
  ok('H8 …and the panel has somewhere to put them', /id="rLenderSub"/.test(html) && /id="rSettle"/.test(html));
  ok('H9 every manual box exists on the admin zone',
    /id="tsFeeUwPart"/.test(html) && /id="tsFeeLegal"/.test(html) && /id="tsFeeSettlement"/.test(html));
  ok('H9b …including the CEMA question and its amount', /id="tsCemaOn"/.test(html) && /id="tsFeeCema"/.test(html));
  /* THE QUESTION IS ONLY PUT IN FRONT OF THE OFFICER IT CAN APPLY TO. An always-visible "is this a
     New York CEMA?" on a Texas purchase is a question nobody can answer, and the row that carries
     it starts hidden and is shown by `cemaApplies()`. */
  ok('H9c …and the CEMA row is hidden unless the file is a New York refinance',
    /id="tsCemaRow"[^>]*display:none/.test(html) && /cmAsk\.style\.display = cemaApplies\(\)/.test(ts));
  /* H10 THE LEGACY BOX KEEPS ITS MEANING, and this is a real hazard rather than tidiness:
     `adminStateFromEngineInputs` restores a stored `lenderFee` into `tsFeeUW`, so repurposing that
     box as the underwriting PART would have restored an old file's frozen $2,195 into it and
     silently re-registered that file at $3,190. */
  ok('H10 the legacy whole-number box still sends the TOTAL, so an old registration re-prices identically',
    /lenderFee: f\.tsFeeUW/.test(fs.readFileSync(path.join(REPO, 'app-v2/src/components/ProductStudioPanel.jsx'), 'utf8')));
  ok('H11 …and the new per-part boxes send the new keys',
    /underwritingFee: f\.tsFeeUwPart/.test(fs.readFileSync(path.join(REPO, 'app-v2/src/components/ProductStudioPanel.jsx'), 'utf8')));
  const studio = fs.readFileSync(path.join(REPO, 'app-v2/src/components/TermSheetStudio.jsx'), 'utf8');
  ok('H12 …and re-opening a file restores them', /tsFeeUwPart: moneyVal\('tsFeeUwPart'\)/.test(studio)
    && /put\('tsFeeUwPart', inp\.underwritingFee\)/.test(studio));
}

// ── I. Runtime equivalence + one writer, against the REAL pricing path ───────
const pricing = require('../src/lib/pricing');
if (!pricing.enginesReady || !pricing.enginesReady()) {
  console.log('SKIP the runtime-equivalence section: engines not loadable', pricing.loadErr && pricing.loadErr());
} else {
  const exp = { flips: 5, holds: 2, ground: 3 };
  const quote = (app, ov) => pricing.quoteProgram(app.__program || 'standard', pricing.buildInputs(app, exp, ov || {}));

  const mk = (over) => Object.assign({
    purchase_price: 400000, as_is_value: 400000, arv: 640000, rehab_budget: 60000,
    fico: 730, term: 12, program: 'Fix & Flip', rehab_type: 'Light rehab', loan_type: 'Purchase',
    property_type: 'Single Family', units: 1, property_address: { state: 'NJ', city: 'Newark' },
    requested_exp_flips: 5, requested_exp_holds: 2, requested_exp_ground: 3,
  }, over || {});

  // I1-I4: THE GENERAL FILE IS UNMOVED. The baseline is the module NEUTRALIZED to the pre-split
  // single number, which is exactly "the system before this change" — built by neutralizing rather
  // than by reading git, because a git baseline degenerates into "the engine equals itself" the
  // moment the change is committed.
  const modPath = require.resolve('../src/lib/lender-fees');
  const real = require.cache[modPath].exports;
  const preSplit = {
    ...real,
    lenderFeesFor: () => ({ underwriting: 2195, legal: 0, total: 2195, legalBasis: 'typed_total', split: false, manualUnderwriting: false, manualLegal: false }),
    settlementFeeFor: () => null,
  };
  const APPS = [];
  for (const st of ['TX', 'NJ', 'FL', 'PA']) {
    for (const rehab of ['Light rehab', '']) {
      for (const price of [200000, 640000]) {
        for (const eng of ['standard', 'gold', 'silver']) {
          APPS.push(mk({ __program: eng, property_address: { state: st, city: 'Somewhere' }, rehab_type: rehab, purchase_price: price, as_is_value: price, arv: Math.round(price * 1.6) }));
        }
      }
    }
  }
  const run = (mod) => {
    require.cache[modPath].exports = mod;
    const out = APPS.map((a) => { try { return quote(a); } catch (e) { return { __err: String(e && e.message) }; } });
    require.cache[modPath].exports = real;
    return out;
  };
  const before = run(preSplit);
  const after = run(real);
  let drift = 0;
  for (let i = 0; i < APPS.length; i++) {
    const b = before[i], a = after[i];
    if (b.__err || a.__err) continue;
    // The named PARTS are new on the object, so compare everything else.
    const strip = (q) => { const c = JSON.parse(JSON.stringify(q)); delete c.closingCosts.lenderFeeParts; return c; };
    if (JSON.stringify(strip(a)) !== JSON.stringify(strip(b))) {
      drift++;
      if (drift < 3) console.log('   …a general file MOVED:', APPS[i].property_address.state, APPS[i].__program);
    }
  }
  eq('I1 a general (non-New-York, non-ground-up) deal is BYTE-IDENTICAL to the pre-split system', drift, 0);
  ok('I2 …over a battery that means something', APPS.length >= 40);
  ok('I3 …and the split really is live on those deals, so I1 is not vacuous',
    after[0].closingCosts.lenderFeeParts.split === true && after[0].closingCosts.lenderFeeParts.underwriting === 1200);
  ok('I4 …with the total still $2,195', after[0].closingCosts.lenderFee === 2195);

  // I5-I9: on a New York file ONLY the cost moves — the owner's authorized change.
  const nyc = mk({ property_address: { state: 'NY', city: 'Brooklyn' } });
  const nj = mk({ property_address: { state: 'NJ', city: 'Newark' } });
  const qNyc = quote(nyc), qNj = quote(nj);
  eq('I5 a Brooklyn file books the $2,500 legal rung', qNyc.closingCosts.lenderFeeParts.legal, 2500);
  eq('I6 …its total is 1,200 + 2,500', qNyc.closingCosts.lenderFee, 3700);
  eq('I7 …and it carries the optional settlement fee', qNyc.closingCosts.settlementFee, 750);
  ok('I8 …named, and named optional', /optional/i.test(qNyc.closingCosts.settlement.label) && qNyc.closingCosts.settlement.optional === true);
  // The whole point of quoting it as a closing cost: it reaches the liquidity the borrower must SHOW.
  ok('I9 the New York fees reach the cash to close AND the liquidity to show',
    qNyc.cashToClose > qNj.cashToClose && qNyc.liquidityRequired > qNj.liquidityRequired);

  // I10: the sizing is untouched — the thing that must never happen.
  {
    const base = mk({ property_address: { state: 'NY', city: 'Albany', county: 'Albany' } });
    const a = quote(base), b = quote(base, { legalFee: 9000 });
    eq('I10 a legal fee nine times bigger moves NO sizing number', JSON.stringify(a.sizing), JSON.stringify(b.sizing));
    eq('I11 …and no rate', a.noteRate, b.noteRate);
    eq('I12 …while the cash to close rises by exactly the difference',
      Math.round((b.cashToClose - a.cashToClose) * 100) / 100, 9000 - a.closingCosts.lenderFeeParts.legal);
  }

  // I13: the legacy typed total still governs, so an old registration re-prices identically.
  {
    const q = quote(mk({ property_address: { state: 'NY', city: 'Brooklyn' } }), { lenderFee: 2195 });
    eq('I13 a stored whole-number total wins over the New York ladder', q.closingCosts.lenderFee, 2195);
    ok('I14 …and reports split:false so the sheet prints the one line it always printed',
      q.closingCosts.lenderFeeParts.split === false);
  }
}

// ── J. One writer for the per-file columns ──────────────────────────────────
//
// db/632 deliberately does NOT widen the economics-reopen trigger for the three per-file columns,
// on the grounds that they can only ever be written as part of a REGISTRATION — so there is never
// a stale registration for the trigger to catch. That claim has to be enforced, or the next door
// added quietly invalidates it.
{
  const skip = new Set(['db', 'node_modules', 'web', 'app', 'app-v2', '.git', 'docs', 'scripts']);
  for (const col of ['file_underwriting_fee', 'file_legal_fee', 'file_settlement_fee', 'file_cema_fee', 'ny_cema']) {
    const hits = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (skip.has(e.name)) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.js$/.test(e.name)) {
          const src = fs.readFileSync(p, 'utf8');
          if (new RegExp(`\\b${col}\\b`).test(src) && /UPDATE\s+applications|INSERT\s+INTO\s+applications/i.test(src)) {
            hits.push(path.relative(REPO, p));
          }
        }
      }
    })(path.join(REPO, 'src'));
    eq(`J1 exactly one module writes ${col}, and it is the register path`, hits, ['src/routes/staff.js']);
  }
}

console.log(fail ? `test-lender-fees-pure: ${pass} passed, ${fail} FAILED` : `test-lender-fees-pure: all ${pass} checks passed.`);
process.exit(fail ? 1 : 0);
