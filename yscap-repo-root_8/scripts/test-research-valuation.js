/**
 * THE VALUATION ENGINE (src/lib/research/valuation.js) — the sales-comparison
 * grid: adjust each comparable to the subject, reconcile the adjusted prices, and
 * say out loud everything a reviewer would object to.
 *
 * What this test is really protecting:
 *   1. THE SIGN CONVENTION. adjusted = sale price + adjustments, and a comp that
 *      is better than the subject carries a NEGATIVE one. Getting this backwards
 *      is the classic grid bug and it looks perfectly plausible on screen.
 *   2. THE REFUSALS. Every derived rate is allowed to come back null — too small
 *      a sample, or a sample pointing the wrong way — because a fabricated
 *      $/sqft is worse than an empty box.
 *   3. THE WARNINGS. A weak answer still produces a number; it must never
 *      produce a number with the caveats quietly dropped.
 *
 * Pure. No database, no network.
 */
const V = require('../src/lib/research/valuation');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`FAIL ${m}`); } };
const near = (a, b, tol, m) => ok(a != null && Math.abs(a - b) <= tol, `${m} (got ${a}, wanted ~${b})`);

const TODAY = '2026-08-02';
const subject = { gla: 1500, beds: 3, baths_full: 2, baths_half: 1, condition_uad: 'C4',
  city: 'Piscataway', state: 'NJ', property_type: 'SFR (1 unit)' };

// ---- 1. adjusting one comp --------------------------------------------------
{
  const c = { sale_price: 400000, gla: 1400 };
  const a = V.adjustComp(c, { gla: 10000, condition: -5000 });
  ok(a.adjustedPrice === 405000, 'adjusted price = sale price PLUS the adjustments (400k + 10k - 5k)');
  ok(a.netAdjustment === 5000, 'net adjustment is the signed sum');
  ok(a.grossAdjustment === 15000, 'gross adjustment is the sum of the ABSOLUTE values — the two do not cancel');
  near(a.netAdjPct, 1.25, 0.01, 'net % is against the sale price');
  near(a.grossAdjPct, 3.75, 0.01, 'gross % is against the sale price');
  ok(a.lines.length === 2 && a.lines[0].key === 'condition' && a.lines[1].key === 'gla',
    'lines come back in the order the appraisal form prints them, not the order they were typed');
}
{
  const a = V.adjustComp({ sale_price: 400000 }, { not_a_real_line: 50000, gla: 1000 });
  ok(a.adjustedPrice === 401000,
    'an UNKNOWN grid line is dropped, never silently summed into the total');
}
{
  const a = V.adjustComp({ sale_price: 400000 }, [{ key: 'gla', amount: 0 }]);
  ok(a.lines.length === 0 && a.adjustedPrice === 400000, 'a zero adjustment is not a line');
}
{
  const a = V.adjustComp({ sale_price: null }, { gla: 1000 });
  ok(a.adjustedPrice === null, 'a comp with no sale price cannot produce an adjusted price');
}

// ---- 2. reconciling ---------------------------------------------------------
{
  const comps = [
    { id: 'a', sale_price: 400000, gla: 1450, sale_date: '2026-06-01', sale_status: 'closed', adjustments: { gla: 5000 } },
    { id: 'b', sale_price: 420000, gla: 1550, sale_date: '2026-05-01', sale_status: 'closed', adjustments: { gla: -5000 } },
    { id: 'c', sale_price: 460000, gla: 1900, sale_date: '2026-04-01', sale_status: 'closed', adjustments: { gla: -60000, condition: -20000 } },
  ];
  const g = V.buildGrid(subject, comps, { today: TODAY });
  ok(g.comps.map((c) => c.adjustedPrice).join(',') === '405000,415000,380000', 'each comp adjusts independently');
  ok(g.value.median === 405000, 'the median is the middle adjusted price');
  ok(g.value.low === 380000 && g.value.high === 415000, 'the outer range is the full spread of adjusted prices');
  ok(g.value.compCount === 3 && g.value.closedCompCount === 3, 'the comp counts are reported');
  // The heavily-adjusted comp must pull LESS weight than the clean ones.
  const w = Object.fromEntries(g.value.weights.map((x) => [x.id, x.weight]));
  ok(w.a > w.c && w.b > w.c, 'the comp that needed the most correcting carries the LEAST weight');
  ok(g.value.indicatedValue >= g.value.low && g.value.indicatedValue <= g.value.high,
    'the answer sits inside the range of the sales it came from');
  ok(g.value.disclaimer && /NOT an appraisal/i.test(g.value.disclaimer),
    'every result carries the not-an-appraisal disclaimer');
}
{
  // A pinned weight is the human's judgement and beats the formula entirely.
  const comps = [
    { id: 'a', sale_price: 400000, sale_date: '2026-06-01', adjustments: {} },
    { id: 'b', sale_price: 500000, sale_date: '2026-06-01', adjustments: {}, weight: 99 },
  ];
  const g = V.buildGrid(subject, comps, { today: TODAY });
  ok(g.value.indicatedValue > 495000, 'a weight the user pinned overrides the automatic weighting');
}
{
  const comps = [{ id: 'a', sale_price: 400000, sale_date: '2026-06-01', adjustments: {}, include: false },
    { id: 'b', sale_price: 300000, sale_date: '2026-06-01', adjustments: {} }];
  const g = V.buildGrid(subject, comps, { today: TODAY });
  ok(g.value.compCount === 1 && g.value.indicatedValue === 300000,
    'a comp switched OFF is excluded from the value but stays in the grid');
}
{
  const g = V.buildGrid(subject, [], { today: TODAY });
  ok(g.value.indicatedValue === null && g.value.compCount === 0, 'no comps means no value, not a zero');
  ok(g.warnings.some((w) => w.code === 'too_few_comps' && w.severity === 'fatal'),
    'no comps is called out as fatal');
}

// ---- 3. the warnings a reviewer would raise ---------------------------------
{
  const comps = [{ id: 'a', sale_price: 400000, gla: 1400, sale_date: '2026-06-01', sale_status: 'closed',
    distance_miles: 0.3, adjustments: { gla: 90000 } }];
  const codes = V.buildGrid(subject, comps, { today: TODAY }).comps[0].warnings.map((w) => w.code);
  ok(codes.includes('net_adj_high'), 'a 22% net adjustment is flagged (over the 15% we watch for)');
  ok(!codes.includes('gross_adj_high'), 'but 22% GROSS is under the 25% mark, so that one stays quiet');
  ok(codes.includes('line_adj_high'), 'one line worth 22% of the price is flagged on its own');
}
{
  // Net and gross diverge as soon as the adjustments pull in both directions: these
  // two cancel to a small net while the gross keeps climbing, which is exactly the
  // case the gross test exists to catch.
  const comps = [{ id: 'a', sale_price: 400000, gla: 1450, sale_date: '2026-06-01', sale_status: 'closed',
    adjustments: { gla: 60000, condition: -55000 } }];
  const codes = V.buildGrid(subject, comps, { today: TODAY }).comps[0].warnings.map((w) => w.code);
  ok(!codes.includes('net_adj_high'), 'the adjustments nearly cancel, so the NET reads as small');
  ok(codes.includes('gross_adj_high'),
    'the GROSS is 29% and IS flagged — a comp corrected that hard in both directions is not really comparable');
}
{
  const comps = [{ id: 'a', sale_price: 400000, gla: 1450, sale_date: '2024-01-01', sale_status: 'closed', adjustments: {} }];
  const codes = V.buildGrid(subject, comps, { today: TODAY }).comps[0].warnings.map((w) => w.code);
  ok(codes.includes('comp_stale'), 'a sale over a year old is flagged');
}
{
  const comps = [{ id: 'a', sale_price: 400000, gla: 1450, sale_date: '2026-06-01', sale_status: 'active', adjustments: {} }];
  const g = V.buildGrid(subject, comps, { today: TODAY });
  ok(g.comps[0].warnings.some((w) => w.code === 'not_closed'),
    'A LISTING IS NOT A SALE — an active listing is called out as an asking price');
  ok(g.value.closedCompCount === 0, 'a listing does not count towards the closed-comp floor');
}
{
  const comps = [{ id: 'a', sale_price: 400000, gla: 900, sale_date: '2026-06-01', sale_status: 'closed', adjustments: {} }];
  ok(V.buildGrid(subject, comps, { today: TODAY }).comps[0].warnings.some((w) => w.code === 'gla_off'),
    'a comp 40% smaller than the subject is flagged');
}
{
  const comps = [{ id: 'a', sale_price: 400000, gla: 400000, sale_date: '2026-06-01', adjustments: {} },
    { id: 'b', sale_price: 900000, gla: 1500, sale_date: '2026-06-01', adjustments: {} }];
  ok(V.buildGrid(subject, comps, { today: TODAY }).warnings.some((w) => w.code === 'wide_spread'),
    'a set whose adjusted prices are miles apart says so — the answer is a range, not a number');
}
{
  const comps = [
    { id: 'a', sale_price: 400000, gla: 1700, sale_date: '2026-06-01', sale_status: 'closed', adjustments: {} },
    { id: 'b', sale_price: 410000, gla: 1800, sale_date: '2026-06-01', sale_status: 'closed', adjustments: {} },
    { id: 'c', sale_price: 405000, gla: 1750, sale_date: '2026-06-01', sale_status: 'closed', adjustments: {} }];
  ok(V.buildGrid(subject, comps, { today: TODAY }).warnings.some((w) => w.code === 'no_gla_bracket'),
    'comps that are ALL bigger than the subject are called out — a value with no bracketing is an extrapolation');
}
{
  const comps = [{ id: 'a', sale_price: 400000, gla: 1450, sale_date: '2026-06-01', sale_status: 'closed', adjustments: {} }];
  ok(V.buildGrid(subject, comps, { today: TODAY }).warnings.some((w) => w.code === 'too_few_comps'),
    'fewer than three closed sales is flagged, and a value is still produced');
}

// ---- 4. deriving rates from our own sales -----------------------------------
function corpus(n, f) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(f(i));
  return out;
}
{
  const thin = corpus(4, (i) => ({ sale_price: 400000, gla: 1500, sale_status: 'closed', sale_date: '2026-0' + (i + 1) + '-01' }));
  const r = V.deriveMarketRates(thin, { today: TODAY });
  ok(r.pricePerSqft.value === null && /need 8/.test(r.pricePerSqft.why),
    'FOUR SALES IS NOT A RATE — it refuses, and says how many it needs');
  ok(r.glaAdjustmentPerSqft.value === null, 'with no price per foot there is no GLA adjustment either');
  ok(r.monthlyMarketChangePct.value === null, 'no market trend off a handful of sales');
}
{
  // A clean market at a flat $250/sqft, bigger houses and better condition worth more.
  const rows = corpus(30, (i) => {
    const gla = 1200 + (i % 6) * 150;
    const beds = 2 + (i % 3);
    const cond = ['C3', 'C4', 'C5'][i % 3];
    const bump = { C3: 30, C4: 0, C5: -30 }[cond];
    return { sale_price: Math.round((250 + bump + beds * 5) * gla), gla, beds,
      baths_full: 2, baths_half: i % 2, condition_uad: cond, sale_status: 'closed',
      sale_date: `2025-${String(1 + (i % 12)).padStart(2, '0')}-01` };
  });
  const r = V.deriveMarketRates(rows, { today: TODAY });
  ok(r.pricePerSqft.value > 200 && r.pricePerSqft.value < 320, 'the price per foot is read off the sales');
  ok(r.glaAdjustmentPerSqft.value < r.pricePerSqft.value,
    'THE GLA ADJUSTMENT IS A FRACTION OF THE AVERAGE FOOT — an extra foot of the same house is worth less');
  ok(r.glaAdjustmentPerSqft.low < r.glaAdjustmentPerSqft.value && r.glaAdjustmentPerSqft.value < r.glaAdjustmentPerSqft.high,
    'the GLA rate publishes the quarter-to-half range it sits inside');
  ok(r.perConditionGrade.valuePerSqft > 0,
    'a better condition grade is worth MORE per foot (the scale is inverted, C1 is best)');
  ok(r.pricePerSqft.basis && r.perConditionGrade.basis, 'every rate carries the words explaining where it came from');
  // The bedroom count in this corpus moves in step with the SIZE, so the per-bedroom
  // read is confounded and the engine correctly declines it. That is the honest
  // answer — the clean case is asserted separately below.
  ok(r.perBedroom.valuePerSqft == null,
    'a corpus where bedrooms and size move together yields no per-bedroom rate, rather than a confounded one');
}
{
  // Bedrooms as the ONLY thing that varies: every house is the same size and grade.
  const rows = corpus(30, (i) => {
    const beds = 2 + (i % 3);
    return { sale_price: (240 + beds * 10) * 1500, gla: 1500, beds, baths_full: 2,
      condition_uad: 'C4', sale_status: 'closed', sale_date: '2025-06-01' };
  });
  const r = V.deriveMarketRates(rows, { today: TODAY });
  ok(r.perBedroom.valuePerSqft > 0, 'when bedrooms are the only difference, an extra bedroom reads as worth more');
  ok(r.perBedroom.groups.length >= 2, 'the per-bedroom rate reports the groups it compared');
}
{
  // A market where the four-bedrooms happen to be the tired ones: the naive read
  // says a bedroom is worth NEGATIVE money, and that must be refused.
  const rows = corpus(30, (i) => {
    const beds = 2 + (i % 3);
    return { sale_price: (300 - beds * 25) * 1500, gla: 1500, beds, baths_full: 2,
      condition_uad: 'C4', sale_status: 'closed', sale_date: '2025-06-01' };
  });
  const r = V.deriveMarketRates(rows, { today: TODAY });
  ok(r.perBedroom.valuePerSqft == null && /wrong way/.test(r.perBedroom.why || ''),
    'A RATE WITH THE WRONG SIGN IS REFUSED — better to leave the grid line blank than subtract money for a bedroom');
}
{
  const rows = corpus(24, (i) => ({ sale_price: 400000, gla: 1500, beds: 3, sale_status: 'closed',
    sale_date: '2025-06-01' }));
  const r = V.deriveMarketRates(rows, { today: TODAY });
  ok(r.monthlyMarketChangePct.value === null,
    'sales all on one day carry no time trend, however many there are');
}

// ---- 5. suggested adjustments -----------------------------------------------
{
  const rates = { glaAdjustmentPerSqft: { value: 100, basis: 'test rate' },
    perConditionGrade: { valuePerSqft: 2, basis: 'test grade rate' },
    perBedroom: { valuePerSqft: 1, basis: 'test bed rate' },
    perBath: { value: null }, monthlyMarketChangePct: { value: null } };
  const comp = { sale_price: 400000, gla: 1300, beds: 3, condition_uad: 'C5', concession_amount: 6000 };
  const lines = V.suggestAdjustments(subject, comp, rates, { today: TODAY });
  const byKey = Object.fromEntries(lines.map((l) => [l.key, l]));
  ok(byKey.gla && byKey.gla.amount > 0,
    'the subject is BIGGER, so the smaller comp is adjusted UP towards it');
  ok(byKey.condition && byKey.condition.amount > 0,
    'the subject (C4) is in better shape than the comp (C5), so the comp is adjusted UP');
  ok(byKey.sale_concessions && byKey.sale_concessions.amount === -6000,
    'seller concessions come straight off the recorded price — a fact, not a judgement');
  ok(lines.every((l) => l.source === 'suggested' && l.note),
    'every suggestion is marked as one and says where it came from');
}
{
  const empty = { glaAdjustmentPerSqft: { value: null }, perConditionGrade: { value: null },
    perBedroom: { value: null }, perBath: { value: null }, monthlyMarketChangePct: { value: null } };
  const lines = V.suggestAdjustments(subject, { sale_price: 400000, gla: 1000, condition_uad: 'C6' }, empty, { today: TODAY });
  ok(lines.length === 0,
    'WITH NO SUPPORTABLE RATES THE GRID STAYS BLANK — it never zero-fills, because a zero reads as "no difference"');
}
{
  const rates = { glaAdjustmentPerSqft: { value: 100, basis: 'x' }, perConditionGrade: { value: null },
    perBedroom: { value: null }, perBath: { value: null }, monthlyMarketChangePct: { value: null } };
  const lines = V.suggestAdjustments(subject, { sale_price: 400000, gla: 1490 }, rates, { today: TODAY });
  ok(!lines.some((l) => l.key === 'gla'), 'a 10 sq ft difference is noise — no adjustment is suggested for it');
}

// ---- 6. ranking a candidate comp --------------------------------------------
{
  const close = V.scoreComp(subject, { gla: 1500, beds: 3, condition_uad: 'C4', sale_date: '2026-07-01',
    distance_miles: 0.2, property_type: 'SFR (1 unit)' }, { today: TODAY });
  const far = V.scoreComp(subject, { gla: 900, beds: 1, condition_uad: 'C6', sale_date: '2024-01-01',
    distance_miles: 8, property_type: 'Condo' }, { today: TODAY });
  ok(close.score > far.score, 'a near, recent, same-sized, same-condition sale outranks a far, old, different one');
  ok(close.score <= 100 && far.score >= 0, 'the score stays inside 0–100');
  ok(close.parts.length && close.parts.every((p) => p.label), 'the score shows its working, line by line');

  // A FACT NOBODY STATED IS NOT A BAD MATCH. The score used to count an unknown at
  // its full weight with nothing earned, so our own missing data looked like a poor
  // comparable — and since no subject property was ever geocoded, the distance
  // weight (a quarter of the total) was dragging EVERY comparison down.
  const perfect = V.scoreComp(subject, { gla: 1500, beds: 3, condition_uad: 'C3', sale_date: TODAY,
    distance_miles: 0.05, property_type: 'SFR (1 unit)' }, { today: TODAY });
  ok(perfect.score >= 95 && perfect.coverage === 100,
    `a near-identical sale next door scores near 100 on full coverage (${perfect.score}/${perfect.coverage})`);

  const sparse = V.scoreComp(subject, { beds: 3, sale_date: TODAY, city: subject.city }, { today: TODAY });
  ok(sparse.score >= 80,
    `A GOOD MATCH WE ONLY PARTLY KNOW STILL SCORES WELL (${sparse.score}) — it used to be capped near 45 by facts nobody had stated`);
  ok(sparse.coverage < 100 && sparse.coverage > 0,
    `and the coverage SAYS how much of it we could actually judge (${sparse.coverage}%) — the two numbers mean different things`);
  ok(sparse.parts.some((p) => p.unknown === true && p.weight === 0),
    'the unknowns are still listed, at zero weight, so nothing is hidden');

  const blank = V.scoreComp(subject, {}, { today: TODAY });
  ok(blank.score === 0 && blank.coverage === 0,
    'KNOWING NOTHING IS NOT A PERFECT MATCH — with no facts to compare, the score is 0 and says its coverage is 0');

  // The same-town fallback is a real but weaker signal, and must never outrank a
  // measured distance.
  const sameTown = V.scoreComp(subject, { gla: 1500, beds: 3, condition_uad: 'C3', sale_date: TODAY,
    city: subject.city, property_type: 'SFR (1 unit)' }, { today: TODAY });
  const measured = V.scoreComp(subject, { gla: 1500, beds: 3, condition_uad: 'C3', sale_date: TODAY,
    distance_miles: 0.1, property_type: 'SFR (1 unit)' }, { today: TODAY });
  ok(measured.score > sameTown.score,
    'a MEASURED distance beats "same town", which is the weaker statement it is');
}

// ---- 7. the review thresholds are OURS, not a GSE rule -----------------------
{
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'lib', 'research', 'valuation.js'), 'utf8');
  ok(/Fannie REMOVED those hard adjustment limits/.test(src),
    'the code records that the 15%/25% pair is NOT a current Fannie Mae rule, so nobody re-labels it as one');
  ok(V.THRESHOLDS.netAdjPct === 15 && V.THRESHOLDS.grossAdjPct === 25 && V.THRESHOLDS.minClosedComps === 3,
    'the thresholds the UI shows are the ones the engine tests');
}

// ---- 4b. THE TIME TREND IS A RATE, AND A RATE NEEDS A SPAN --------------------
// This used to gate only on HOW MANY dated sales there were, never on how far
// apart they sat. Sixteen sales bunched into one month passed the count check,
// and a 4% price gap divided by ONE month became 3.95% A MONTH. The identical
// readings spread over a year read 0.33%/month — a twelve-fold swing driven
// entirely by the spacing. `suggestAdjustments` then multiplied it by the months
// since a comp sold with no ceiling, offering a human +$190,750 on a $400,000
// comparable as a "suggestion".
{
  // Sixteen sales, the newer half 4% dearer, ALL INSIDE ONE MONTH.
  const bunched = corpus(16, (i) => ({
    sale_price: i < 8 ? 375000 : 390000, gla: 1500, sale_status: 'closed',
    sale_date: i < 8 ? '2026-01-05' : '2026-02-05',
  }));
  const r = V.deriveMarketRates(bunched, { today: TODAY });
  ok(r.monthlyMarketChangePct.value === null,
    'sales bunched into a single month are NOT a market trend, however many of them there are');
  ok(/cover about/.test(r.monthlyMarketChangePct.why || '')
    && /about a year of sales/.test(r.monthlyMarketChangePct.why || ''),
  'and the refusal explains it is the SPACING, not the count');
  // AND IT NAMES A SPAN THE USER CAN SEE. `monthsApart` is between the two half
  // MIDPOINTS — roughly half the set's real span — so quoting it told a user who
  // supplied nine months of sales that they had supplied five.
  ok(/cover about 1 month/.test(r.monthlyMarketChangePct.why || ''),
    'quoting the SET\'s span, not the distance between its halves');

  // The same readings spread over two years ARE a trend, and a modest one.
  const spread = corpus(16, (i) => ({
    sale_price: i < 8 ? 375000 : 390000, gla: 1500, sale_status: 'closed',
    sale_date: i < 8 ? '2024-09-05' : '2026-01-05',
  }));
  const r2 = V.deriveMarketRates(spread, { today: TODAY });
  ok(r2.monthlyMarketChangePct.value != null && Math.abs(r2.monthlyMarketChangePct.value) < 1.5,
    'the SAME price gap spread over two years reads as a small, believable monthly rate');

  // A rate no market moves at is refused even with a long span — the two halves
  // differ for some reason other than time.
  const wild = corpus(16, (i) => ({
    sale_price: i < 8 ? 200000 : 600000, gla: 1500, sale_status: 'closed',
    sale_date: i < 8 ? '2025-01-05' : '2026-01-05',
  }));
  const r3 = V.deriveMarketRates(wild, { today: TODAY });
  ok(r3.monthlyMarketChangePct.value === null,
    'a rate faster than a market moves is refused — that is the method failing, not the market');
  ok(/faster than a market moves/.test(r3.monthlyMarketChangePct.why || ''),
    'and it says so, instead of returning a confident number');

  // THE DOLLARS ARE CAPPED TOO. A legal rate compounded over a long-ago sale gets
  // to an absurd figure on its own.
  const rates = { pricePerSqft: { value: null }, glaAdjustmentPerSqft: { value: null },
    perBedroom: { value: null }, perBath: { value: null }, perConditionGrade: { value: null },
    monthlyMarketChangePct: { value: 1.4, basis: 'test' } };
  const lines = V.suggestAdjustments(
    { gla: 1500 }, { sale_price: 400000, sale_date: '2022-08-02', gla: 1500 },
    rates, { today: TODAY });
  const mc = lines.find((l) => l.key === 'market_conditions');
  ok(mc && Math.abs(mc.amount) <= 400000 * 0.15,
    'a time adjustment can never exceed 15% of the sale price, however long ago the comp sold');
  ok(mc && /held at 15%/.test(mc.note),
    'and when it is held back it SAYS so, rather than quietly shrinking');
}

// ---- 4c. A FORCED SALE IS NOT A MARKET PRICE ---------------------------------
// A bank selling REO, a short sale, an estate or a relocation transacts under a
// constraint an ordinary buyer and seller do not have. Measured: 8 REO alongside
// 8 arm's-length dragged the median to $217/sqft. They were neither filtered out
// NOR selectable, so every derived rate quietly averaged two different markets.
{
  const arms = corpus(10, (i) => ({ sale_price: 375000, gla: 1500, sale_status: 'closed',
    sale_type: 'Arms Length', sale_date: `2025-0${(i % 9) + 1}-01` }));
  const reo = corpus(8, (i) => ({ sale_price: 225000, gla: 1500, sale_status: 'closed',
    sale_type: 'REO', sale_date: `2025-0${(i % 9) + 1}-01` }));
  const r = V.deriveMarketRates([...reo, ...arms], { today: TODAY });
  ok(r.pricePerSqft.value === 250,
    'the price per foot is the ARM\'S-LENGTH market ($250), not a blend of two different markets');
  ok(r.distressedSetAside === 8, 'and the forced sales are counted, not silently dropped');
  ok(/forced sale/.test(r.distressedNote || ''), 'with a plain-language note saying what was set aside');

  // AN UNREAD SALE TYPE IS AN ORDINARY SALE. Excluding on a hunch would quietly
  // shrink the sample, and an unread fact is never a "yes" in this warehouse.
  const unknown = corpus(10, (i) => ({ sale_price: 375000, gla: 1500, sale_status: 'closed',
    sale_type: null, sale_date: `2025-0${(i % 9) + 1}-01` }));
  const r2 = V.deriveMarketRates(unknown, { today: TODAY });
  ok(r2.distressedSetAside === 0 && r2.pricePerSqft.value === 250,
    'a sale whose type the report never stated still counts — we do not guess "distressed" from a low price');
}

// ---- 4d. SIZE IS THE CONFOUND, AND IT IS NOT SUBTLE --------------------------
// Price per foot runs INVERSELY to size, and more bathrooms come with more house,
// so the price-per-foot gap between bath groups is mostly measuring SIZE.
// Multiplied back by the subject's living area that produced a measured $86,940
// for one bathroom — while the identical confound pointing the other way was
// correctly refused as "the wrong sign", with a message blaming the sample size.
{
  const small = corpus(8, () => ({ sale_price: 300000, gla: 1200, baths_full: 2, baths_half: 0,
    sale_status: 'closed', sale_date: '2025-03-01' }));
  const big = corpus(8, () => ({ sale_price: 480000, gla: 2400, baths_full: 3, baths_half: 0,
    sale_status: 'closed', sale_date: '2025-03-01' }));
  const r = V.deriveMarketRates([...small, ...big], { today: TODAY });
  ok(r.perBath.valuePerSqft == null && r.perBath.value === null,
    'a bathroom rate read off groups that differ in SIZE is refused — asserted on the SUCCESS\n     shape (`valuePerSqft`), because `.value` is absent from it and `.value == null` would be\n     true whether the rate was refused or published');
  ok(/BIGGER houses/.test(r.perBath.why || '') && /measuring the size/.test(r.perBath.why || ''),
    'and the refusal names the CONFOUND — "get more sales" is the wrong advice for a problem more sales will not fix');

  // Matched for size, the same shape reads normally.
  const matchedA = corpus(8, () => ({ sale_price: 300000, gla: 1500, baths_full: 2, baths_half: 0,
    sale_status: 'closed', sale_date: '2025-03-01' }));
  const matchedB = corpus(8, () => ({ sale_price: 330000, gla: 1550, baths_full: 3, baths_half: 0,
    sale_status: 'closed', sale_date: '2025-03-01' }));
  const r2 = V.deriveMarketRates([...matchedA, ...matchedB], { today: TODAY });
  ok(r2.perBath.valuePerSqft != null, 'two size-matched groups still yield a bathroom rate');
  ok(r2.perBath.approxDollarsOnTypicalHouse != null,
    'and it reports what that comes to in DOLLARS on a typical house — the figure a human can sanity-check');
  ok(r2.perBath.groups.every((g) => g.medianGla != null),
    'each group publishes its median size, so the confound is visible even when it passes');
}

// ---- AN ASKING PRICE IS NOT A SALE -------------------------------------------
// `reconcile` halves a listing's weight, but a half-weighted listing in a small
// set still carries a lot — a recent, well-matched one was measured at 36% of the
// total — and it counts in FULL toward the median, the range and the price per
// foot, which are plain unweighted statistics over the same rows. The value is
// still produced; the reader is told how much of it is an asking price.
{
  const subject = { gla: 1500, beds: 3, baths_full: 2 };
  const comps = [
    { sale_price: 400000, gla: 1500, sale_date: '2026-06-01', sale_status: 'closed', adjustedPrice: 400000, grossAdjPct: 5 },
    { sale_price: 410000, gla: 1500, sale_date: '2026-05-01', sale_status: 'closed', adjustedPrice: 410000, grossAdjPct: 5 },
    { sale_price: 520000, gla: 1500, sale_date: '2026-07-01', sale_status: 'active', adjustedPrice: 520000, grossAdjPct: 2 },
  ];
  const r = V.reconcile(subject, comps, { today: TODAY });
  ok(typeof r.listingWeightPct === 'number' && r.listingWeightPct > 0,
    'the answer REPORTS what share of its weight is an asking price rather than a sale');
  ok(r.listingWeightPct < 100, 'and that share is a percentage of the whole, not a count');
  const w = V.setWarnings(subject, comps, { today: TODAY });
  const flag = w.find((x) => x.code === 'listings_in_the_answer');
  ok(flag && flag.severity === 'warning', 'and a third of the set being unsold raises a warning');
  ok(flag && /ASKING/.test(flag.text) && /lead the market/.test(flag.text),
    'which says plainly that an asking price is not what anybody paid');

  // All closed → no flag, and nothing rests on an asking price.
  const allClosed = comps.map((c) => Object.assign({}, c, { sale_status: 'closed' }));
  const r2 = V.reconcile(subject, allClosed, { today: TODAY });
  ok(r2.listingWeightPct === 0, 'a set of closed sales reports a zero share');
  ok(!V.setWarnings(subject, allClosed, { today: TODAY }).some((x) => x.code === 'listings_in_the_answer'),
    'and raises no listing warning');
  // A SWITCHED-OFF listing is not in the answer, so it must not be counted in it.
  const off = comps.map((c) => (c.sale_status === 'active' ? Object.assign({}, c, { include: false }) : c));
  ok(V.reconcile(subject, off, { today: TODAY }).listingWeightPct === 0,
    'a comparable the user switched OFF carries none of the answer');
}

// ---- A CONFOUNDED STEP COUNTS AGAINST THE READING ---------------------------
// The first version of the size guard SKIPPED a confounded step and medianed
// whatever survived — which turned a CORRECT refusal into a confident wrong
// answer. On the live NJ segment the discarded step was the strongly negative
// one that used to trigger the "wrong sign" refusal, and the single surviving
// step then published $23.54/sqft: $35,250 for one bathroom. The guard built to
// stop "$86,940 for one bathroom" produced $35,250 on the first real market.
{
  const mk = (n, gla, baths, price) => corpus(n, () => ({
    sale_price: price, gla, baths_full: baths, baths_half: 0,
    sale_status: 'closed', sale_date: '2025-03-01' }));
  // Two steps: 2→2.5 is size-matched, 2.5→3 is wildly not.
  const rows = [...mk(8, 1600, 2, 320000), ...mk(8, 1480, 2.5, 310000), ...mk(4, 3152, 3, 700000)];
  const r = V.deriveMarketRates(rows, { today: TODAY });
  ok(r.perBath.valuePerSqft == null,
    'ONE confounded step condemns the whole reading — the rest of the sample is not made trustworthy by dropping it');
  ok(r.perBath.confoundedSteps >= 1, 'and the refusal reports how many steps were unreadable');
}

// ---- THE DISTRESSED FILTER MUST MATCH WHAT WE ACTUALLY STORE ----------------
// `extract.js` whitelists exactly six values and `ingest.js` stores them
// verbatim: CamelCase, no spaces. A `\b`-anchored pattern could not match
// `REOSale` at all, so the filter was a no-op on every real row while the test
// used spellings ("REO", "Arms Length") that nothing in the system writes.
{
  for (const stored of ['REOSale', 'EstateSale', 'ShortSale', 'CourtOrderedSale']) {
    const arms = corpus(10, (i) => ({ sale_price: 375000, gla: 1500, sale_status: 'closed',
      sale_type: 'ArmsLengthSale', sale_date: `2025-0${(i % 9) + 1}-01` }));
    const bad = corpus(8, (i) => ({ sale_price: 225000, gla: 1500, sale_status: 'closed',
      sale_type: stored, sale_date: `2025-0${(i % 9) + 1}-01` }));
    const r = V.deriveMarketRates([...bad, ...arms], { today: TODAY });
    ok(r.distressedSetAside === 8, `"${stored}" — the spelling the parser actually stores — is set aside`);
    ok(r.pricePerSqft.value === 250, `and the rate is the arm's-length market, not a blend (${stored})`);
  }
  const clean = corpus(10, (i) => ({ sale_price: 375000, gla: 1500, sale_status: 'closed',
    sale_type: 'ArmsLengthSale', sale_date: `2025-0${(i % 9) + 1}-01` }));
  ok(V.deriveMarketRates(clean, { today: TODAY }).distressedSetAside === 0,
    'and an arm\'s-length sale is never mistaken for a forced one');
}


// ---------------------------------------------------------------------------
// A MEASURED PEER RATE BEATS THE TRADE CONVENTION (db/441).
//
// The GLA adjustment rate was 40% of the average price per foot — a rule of
// thumb about a national trade habit. `peerGlaRate` is what appraisers in THIS
// market actually wrote on their grids: each size adjustment divided by the size
// difference it was made for. Measured over the 152 real reports: 468 usable,
// ZERO negative, median $40/sq ft.
//
// The two are NEVER blended. They are different kinds of claim — what local
// appraisers did, against a national habit — and an average of them would be
// neither, with a `basis` that could not honestly describe it.
// ---------------------------------------------------------------------------
{
  const obs = [];
  for (let i = 0; i < 12; i++) {
    obs.push({ sale_price: 400000 + i * 1000, gla: 1500 + i * 10, beds: 3, baths_full: 2,
      baths_half: 0, sale_status: 'closed', sale_type: 'ArmsLengthSale', sale_date: '2026-01-01' });
  }
  const rate = (peerGlaRate) => V.deriveMarketRates(obs, { peerGlaRate }).glaAdjustmentPerSqft;

  ok(rate(undefined).source === 'convention',
    'with no peer rate the trade convention is used, exactly as before');
  const peer = rate({ ok: true, n: 40, median: 52, q1: 38, q3: 65 });
  ok(peer.source === 'peer' && peer.value === 52, `a measured peer rate WINS ($${peer.value}/sq ft)`);
  ok(/actually adjusted/.test(peer.basis),
    'and its basis says it is what appraisers here actually did, not a rule of thumb');
  ok(peer.low === 38 && peer.high === 65,
    'and it carries the real observed spread rather than a fabricated band');

  ok(rate({ ok: false, reason: 'too few' }).source === 'convention',
    'a REFUSED peer rate falls back to the convention');
  ok(rate({ ok: true, n: 3, median: 52 }).source === 'convention',
    'a peer rate under the sample floor does not win — three adjustments is a coincidence');
  ok(rate({ ok: true, n: 40, median: -10 }).source === 'convention',
    'a NEGATIVE peer rate is refused: the adjustment pointed the wrong way, which is a misread');
  ok(rate(null).source === 'convention' && rate({}).source === 'convention',
    'null and an empty object are both safe');

  const noSales = V.deriveMarketRates([], { peerGlaRate: { ok: true, n: 40, median: 52, q1: 38, q3: 65 } });
  ok(noSales.glaAdjustmentPerSqft.source === 'peer',
    'and with no closed sales at all it still stands on its own evidence');
}

console.log(`test-research-valuation: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
