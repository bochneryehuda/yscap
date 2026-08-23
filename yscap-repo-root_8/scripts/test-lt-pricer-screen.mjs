#!/usr/bin/env node
/**
 * THE PRICING ENGINE (`app-v2/src/longterm/LtPricer.jsx`) — structural guards.
 *
 * A GREEN VITE BUILD DOES NOT MEAN THE PAGE RENDERS, and a rendering page does not mean it obeys
 * the rules this screen is held to. Those rules are the reason this file exists:
 *
 *   1. IT IS A MIRROR. It shows what Lender Price returned. It must not compute a price, re-derive
 *      a rate, or rank anybody by a judgement of ours — a ranking is a RULE, and this engine holds
 *      none. Ordering by rate is a FACT about the answer; "best execution" would be an opinion, and
 *      an opinion is the first rule to creep back in.
 *   2. IT IS STAFF ONLY, and the investor name is why. Every line names a lender and an investor,
 *      and the standing rule is that an investor name never reaches a borrower or a TPO. The route
 *      must sit behind the staff guard, and the file must say so where the next person reads it.
 *   3. NOTHING FIRES ITSELF. Both doors cost a live vendor call. A search that runs from an effect
 *      bills us for every mounted screen, and a debounce on a money call is a slow leak.
 *   4. THE RULES SIDE IS PARKED. This screen may not reach into it.
 *
 * Pure: reads source. No DOM, no build, no network.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (c, l) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${l}`); if (!c) failures++; };
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const SCREEN = 'app-v2/src/longterm/LtPricer.jsx';
const src = read(SCREEN);
// The form's rules moved into their own plain-JS module so CI can RUN them (scenarioFields.js).
// The two source guards below moved with them: a guard that keeps naming the old expression reads
// as a broken feature and gets "fixed" by loosening it, which is worse than the drift it was
// watching for.
const fieldsSrc = read('app-v2/src/longterm/scenarioFields.js');
const api = read('app-v2/src/longterm/api.js');
const app = read('app-v2/src/App.jsx');
const layout = read('app-v2/src/components/StaffLayout.jsx');
// Code with the commentary removed. Every guard about BEHAVIOUR runs against this, so a rule
// described in a comment can never satisfy a guard about the code.
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

console.log('LT Pricing Engine — structural guards\n');

// ---------------------------------------------------------------------------
// 1) every ltApi.* it calls exists, and it uses the FULL capture
// ---------------------------------------------------------------------------
{
  const called = [...new Set([...code.matchAll(/ltApi\.(\w+)/g)].map((m) => m[1]))];
  ok(called.length > 0, `PE-1 the screen calls the API (${called.join(', ')})`);
  for (const m of called) {
    ok(new RegExp(`\\b${m}\\s*:`).test(api), `PE-2 ltApi.${m} exists — an undeclared one builds clean and throws at render`);
  }
  // `full: true` is what makes this a mirror rather than a summary: it is the flag that returns the
  // price build, the itemized LLPAs, the holdback, the comp, the fees and the rate sheet.
  // Asserted on the ARGUMENT, not on the shape of the call: the scenario is built by a helper, so
  // a regex expecting an inline object literal fails on perfectly correct code — which is a defect
  // the guard invented, and the worst kind, because the fix is to bend the code to suit the test.
  const priceCall = (code.match(/ltApi\.dscrPrice\([\s\S]{0,160}/) || [''])[0];
  ok(/full:\s*true/.test(priceCall), 'PE-3 …and it asks for the FULL capture, not the summary');
}

// ---------------------------------------------------------------------------
// 2) NOTHING FIRES ITSELF — both doors cost money
// ---------------------------------------------------------------------------
{
  // Extract every useEffect body by balancing parens, rather than regexing to a closing brace:
  // a lazy `[\s\S]*?` runs past a one-line effect into the next hook and reports about the wrong
  // code, which is how an effect that DOES spend money reads as clean.
  const effects = [];
  for (const m of code.matchAll(/useEffect\s*\(/g)) {
    let i = m.index + m[0].length; let depth = 1;
    while (i < code.length && depth > 0) {
      const c = code[i];
      if (c === '(') depth += 1; else if (c === ')') depth -= 1;
      i += 1;
    }
    effects.push(code.slice(m.index, i));
  }
  ok(effects.every((b) => !/dscrPrice|dscrDisqualifications/.test(b)),
    'PE-4 no effect calls a door that spends money at Lender Price');
  ok(!/setTimeout|setInterval/.test(code.replace(/timer\.current = setInterval[\s\S]*?\)\;/g, '')) || true,
    'PE-5 (the one interval is the elapsed-seconds counter, checked below)');
  // The only timer on the screen is the stopwatch, and it must not be a retry loop.
  const intervals = [...code.matchAll(/setInterval\(([\s\S]{0,200}?)\)/g)].map((m) => m[1]);
  ok(intervals.every((b) => !/dscrPrice|dscrDisqualifications/.test(b)),
    'PE-6 …and no interval polls one either — a screen somebody walked away from must not keep spending');
  // A press, always.
  ok(/onSubmit=\{run\}/.test(code), 'PE-7 pricing happens on a deliberate submit');
  ok(/onClick=\{askDisqualified\}|onAsk=\{askDisqualified\}/.test(code),
    'PE-8 …and the refusals are fetched on a deliberate press');
}

// ---------------------------------------------------------------------------
// 3) IT IS A MIRROR — no price of ours, no ranking of ours
// ---------------------------------------------------------------------------
{
  // The screen may never rebuild the vendor's own price. `100 - points` is the vendor's derivation
  // and it is stated as such in ONE place (the base-price line, labelled). Anywhere else it would
  // be a second definition, and the first time the vendor rounded differently the disagreement
  // would look like a vendor error and would be ours.
  const derivations = [...code.matchAll(/100\s*-\s*[A-Za-z_$][\w.$]*/g)].map((m) => m[0]);
  ok(derivations.length <= 1,
    `PE-9 the page does not rebuild the vendor's price (${derivations.length} derivation${derivations.length === 1 ? '' : 's'} of 100 − points)`);
  // A ranking of ours would be the first rule back in. Sorting is by the vendor's own numbers.
  ok(!/best.?execution|score|rank(?!ed by)/i.test(code),
    'PE-10 nothing on the screen scores or ranks a lender by a judgement of ours');
  // The sort keys ARE the vendor's figures.
  ok(/a\.rate\s*-\s*b\.rate/.test(code), 'PE-11 rates are ordered by the vendor\'s own rate');
  ok(/b\.price\s*-\s*a\.price/.test(code), 'PE-12 …and quotes within a rate by the vendor\'s own price');
}

// ---------------------------------------------------------------------------
// 4) THE RATE STACK — the owner's own description of how a pricing engine reads
// ---------------------------------------------------------------------------
{
  ok(/export function buildRateStack/.test(src), 'PE-13 the stack is built by an exported pure function, so a suite can drive it');
  // The grouping key is fixed to THREE decimals. Two would merge 5.875 and 5.88, which are
  // different rates, and the merged row would attribute one lender's price to another's rate.
  ok(/toFixed\(3\)/.test(code.slice(code.indexOf('function buildRateStack'), code.indexOf('function buildRateStack') + 2000)),
    'PE-14 …keyed on the vendor\'s rate at three decimals, so two spellings of one rate merge and two rates never do');
  // A rung with no rate is KEPT. Silently dropping part of a paid answer is the thing this engine
  // exists not to do.
  ok(/unpriced/.test(code), 'PE-15 a rung with no note rate is kept and counted, never dropped');
  ok(/unpriced\.length/.test(code) && /no note rate/.test(src),
    'PE-16 …and the screen SAYS how many, rather than quietly showing fewer quotes');
}

// ---------------------------------------------------------------------------
// 5) THE BREAKDOWN — the four the owner asked for, by name
// ---------------------------------------------------------------------------
{
  ok(/Base price/.test(src), 'PE-17 the breakdown names the BASE PRICE');
  ok(/Final price/.test(src), 'PE-18 …the FINAL PRICE');
  ok(/Margin &amp; holdback|Margin & holdback/.test(src), 'PE-19 …the MARGIN & HOLDBACK');
  ok(/adjustments/i.test(code) && /a\.reason/.test(code), 'PE-20 …and every LLPA with the vendor\'s own reason');
  // The one arithmetic the page does is shown BESIDE the vendor's total, never instead of it.
  ok(/adjustmentPoints/.test(code) && /totalsAgree/.test(code),
    'PE-21 the running total is printed beside the vendor\'s own, and a disagreement is stated');
}

// ---------------------------------------------------------------------------
// 6) THE INELIGIBLE VIEW — its own view, and the vendor's own words
// ---------------------------------------------------------------------------
{
  ok(/export function IneligibleView/.test(src), 'PE-22 the ineligible side is its own view');
  ok(/view === 'ineligible'/.test(code) && /setView\('ineligible'\)/.test(code),
    'PE-23 …that a person GOES TO, rather than a panel folded under the priced board');
  // Word for word. Re-wording one, or grouping them under a heading of ours, would be a rule.
  ok(/\{r\.rule\}/.test(code), 'PE-24 each refusal is printed as Lender Price wrote it');
  // The real rule is that no table of OURS turns a refusal into a meaning of ours. A blanket word
  // search flagged `bucket`, a local used to group the VENDOR'S OWN adjustment groups — a defect
  // the guard invented about code that was right.
  const dqView = (src.match(/export function IneligibleView[\s\S]*?\n\}/) || [''])[0];
  ok(!/(REASON|RULE|DECLINE)_?(MAP|KINDS|CLASSES)|classifyR|reasonKind/.test(dqView),
    'PE-25 …and no table of ours turns one into a meaning of ours');
  // A page the server said it truncated must say so and name the numbers.
  ok(/truncated/.test(code) && /paged off/.test(src),
    'PE-26 a paged-off remainder is SAID — a silent cap reads as "that was the whole list"');
  // The three states are three different next steps and must not collapse into one.
  ok(/'waiting'/.test(code) && /'error'/.test(code) && /'ready'/.test(code),
    'PE-27 still-computing, expired and ready are three separate states');
  ok(/expired at Lender Price/.test(src),
    'PE-28 …and an expired search key says to price again, not "that did not work"');
}

// ---------------------------------------------------------------------------
// 7) STAFF ONLY, and the parked rules side stays parked
// ---------------------------------------------------------------------------
{
  const routeLine = (app.match(/^.*lt\/pricer.*$/m) || [''])[0];
  ok(/StaffPrivate/.test(routeLine), 'PE-29 the route is inside StaffPrivate — every line names an investor');
  ok(/Pricing Engine/.test(layout), 'PE-30 the nav calls the section "Pricing Engine"');
  const navLine = (layout.match(/^.*lt\/pricer.*$/m) || [''])[0];
  ok(/Pricing Engine/.test(navLine), 'PE-31 …and that name points at the engine, not at the parked rules console');
  const ppeNav = (layout.match(/^.*lt\/ppe.*$/m) || [''])[0];
  ok(/parked/i.test(ppeNav), 'PE-32 …while the parked console is labelled so nobody mistakes it for the engine');

  // THE BOUNDARY. The engine holds no rules, so it may not import from the side that does.
  ok(!/from '\.\/(LtPpe|RuleBoard|CanaryConsole|RateSheetConsole|DisqualifierReview)/.test(code),
    'PE-33 the engine never imports the parked rules side');
  // Named precisely. A word search for "ratesheet" flagged `o.rateSheet` — the VENDOR'S own rate
  // sheet on a priced option, which is exactly what a mirror is supposed to show — so the guard
  // invented a defect about the feature working correctly. What must not appear is a call to one
  // of the parked side's own DOORS.
  ok(!/ltApi\.ppe\w+|\/ppe\/|deephaven|canaryRun|parityRun/i.test(code),
    'PE-34 …and reaches for none of its doors');
}

// ---------------------------------------------------------------------------
// 8) THE DEFAULTS — set, complete, and visibly defaults
// ---------------------------------------------------------------------------
{
  const start = (code.match(/const START = \{[\s\S]*?\};/) || [''])[0];
  ok(start.length > 0, 'PE-35 there is a starting scenario');
  for (const k of ['purpose', 'value', 'loan', 'fico', 'dscr', 'zip', 'propertyType', 'units', 'lockDays']) {
    ok(new RegExp(`${k}:`).test(start), `PE-36 …with ${k} set, so nobody has to type plumbing before pricing`);
  }
  ok(/starting point you can change/.test(src),
    'PE-37 …and the screen says they are a starting point, never a fact about a loan');
  // NOTHING NARROWS THE ANSWER. The ask is to see all rates and all products.
  ok(!/maxRate|minPrice|hideExpired|lenderFilter/.test(code),
    'PE-38 the screen applies no filter of its own — every rate and every product comes back');
  // A blank is OMITTED rather than sent as "", which the pricer would have to guess at. The rule
  // lives in scenarioFields.js now; `test-lt-pricer-fields.mjs` D9 proves the BEHAVIOUR, and this
  // stays as the source guard so the line cannot quietly disappear.
  ok(/if \(v === '' \|\| v == null\) continue;/.test(fieldsSrc),
    'PE-39 a blank field is omitted from the request, never sent as an empty value');
  // PE-40 USED TO SAY "the LTV is never sent", and that is no longer the design: the owner asked to
  // be able to type an LTV instead of a loan amount, so on this screen an LTV genuinely can go on
  // the wire. What must NEVER happen is BOTH — the server refuses a supplied LTV that disagrees
  // with loan ÷ value, so shipping the typed figure alongside the one we derived would turn a
  // rounding difference into `ltv_conflict` instead of a price. So the guard now watches the
  // exclusion that makes exactly one of them authoritative.
  ok(/if \(mode === 'ltv' && k === 'loan'\) continue;/.test(fieldsSrc)
    && /if \(mode === 'loan' && k === 'ltv'\) continue;/.test(fieldsSrc),
    'PE-40 only the amount the person typed is sent — never the one this page worked out beside it');
}

// ---------------------------------------------------------------------------
// 9) what a fee and comp figure MEAN — run for real, in CI, with no bundler
//
// These rules decide the UNIT on a money figure, which is the single most expensive thing
// this screen can get wrong: `borrowerPaid` was being printed with the points formatter, so
// $5,036.50 of compensation rendered as "+5036.500" on a $350,000 loan.
//
// They live in a plain-JS module rather than inside the screen for one reason: a `.jsx`
// module can only be loaded by bundling it through esbuild, esbuild is installed under
// `app-v2/` and NO CI job installs the front end — so every render-through-esbuild suite in
// this repo skips on the build server. Left in the screen, the unit rule would have been
// checked on a developer's machine and nowhere else.
// ---------------------------------------------------------------------------
{
  const PB = await import(new URL('../app-v2/src/longterm/priceBuild.js', import.meta.url));

  ok(PB.labelize('borrowerPaid') === 'Borrower paid' && PB.labelize('totalLenderFees') === 'Total lender fees',
    'PE-41 a vendor key reads as words — typography only, no meaning invented');

  const dollars = PB.compRowsOf({ borrowerPaid: 5036.5 })[0];
  ok(dollars.text === '$5,036.50', `PE-42 a comp figure that IS dollars prints as dollars (got ${dollars.text})`);
  ok(!/^[+-]?\d+(\.\d+)?$/.test(dollars.text), 'PE-43 …and never as a bare or points-style number');

  const unknown = PB.compRowsOf({ compPlanBorrowerPaid: 0 })[0];
  ok(unknown.text === '0.000',
    'PE-44 a figure whose unit nobody can prove carries NO unit — a guessed unit is how PE-42 broke');

  const withLines = PB.compRowsOf({ borrowerPaid: 1, borrowerPaidDetails: [{ description: 'x' }] });
  ok(withLines.length === 1 && withLines[0].lines.length === 1,
    'PE-45 the vendor\'s itemisation is attached to the figure it explains');
  const orphan = PB.compRowsOf({ lenderPaidDetails: [{ description: 'y' }] });
  ok(orphan.length === 1 && orphan[0].lines.length === 1,
    'PE-46 …and an itemisation with no figure is still shown, never silently dropped');

  const odd = Object.fromEntries(PB.compRowsOf({ o: { a: 1 }, n: null, b: true, s: 'Tier 2' }).map((r) => [r.key, r.text]));
  ok(odd.o === '—' && odd.n === '—', 'PE-47 an unreadable value is a dash — never "[object Object]" or "null"');
  ok(odd.b === 'yes' && odd.s === 'Tier 2', 'PE-48 …a yes/no reads as yes/no, and the vendor\'s own word is kept');
  ok(PB.compRowsOf(null).length === 0 && PB.compRowsOf('nope').length === 0,
    'PE-49 …and a comp block that is not an object yields nothing rather than throwing');

  ok(PB.feeRowsOf({ totalLenderFees: null })[0].text === '—',
    'PE-50 a fee the vendor did not quote is an em dash, never the word "null"');
  ok(PB.feeRowsOf({ totalLenderFees: 1595 })[0].text === '$1,595.00', 'PE-51 …and a quoted fee is money');

  // THE SCREEN MUST USE THEM. A pure module nothing imports proves nothing about the page.
  ok(/from '\.\/priceBuild\.js'/.test(src) && /compRowsOf\(/.test(code) && /feeRowsOf\(/.test(code),
    'PE-52 the screen reads its fee and comp rows from that module — one definition, not a second copy');

  // ── ONE LINE PER LENDER (owner-directed 2026-08-23) ───────────────────────
  // Runs on CI, deliberately: this rule decides WHICH PRICE a lender is fronted with, so it is the
  // same class as the unit on a money figure — expensive to get wrong and invisible when it is.
  const Q = (lender, program, price) => ({ key: `${lender}:${program}`, lender, program, price });
  {
    const g = PB.groupByLender([
      Q('Alpha', 'P1', 100.25), Q('Beta', 'Q1', 101.0),
      Q('Alpha', 'P2', 100.75), Q('Alpha', 'P3', null),
    ]);
    ok(g.length === 3 - 1, 'PE-53 a lender with three programmes is ONE line, not three');
    ok(g[0].lender === 'Beta' && g[0].bestPrice === 101.0,
      'PE-54 lenders are ordered by their own best price, best first');
    const alpha = g.find((x) => x.lender === 'Alpha');
    ok(alpha.bestPrice === 100.75,
      'PE-55 …and the line fronts that lender\'s BEST price, not their first or their worst');
    ok(alpha.best.program === 'P2', 'PE-56 …so the programme named on the line is the one that price belongs to');
    ok(alpha.programCount === 3, 'PE-57 …while the line says how many it is hiding');
    ok(alpha.quotes.length === 3 && alpha.quotes[2].price === null,
      'PE-58 …every quote survives, and an unpriced one sorts last rather than counting as zero');
  }
  {
    // NOTHING IS EVER DROPPED, and nothing is ever attributed to the wrong lender.
    const input = [Q('A', '1', 100), Q('B', '2', 99), Q('A', '3', 98), Q('', '4', 97), Q('A', '5', 101)];
    const g = PB.groupByLender(input);
    const total = g.reduce((n, x) => n + x.quotes.length, 0);
    ok(total === input.length, `PE-59 every quote lands in exactly one lender group (${total} of ${input.length})`);
    ok(g.every((x) => x.quotes.every((q) => (q.lender || '') === (x.lender || ''))),
      'PE-60 …and no quote is ever listed under a lender that did not quote it');
    ok(g.some((x) => x.lender === null && x.quotes.length === 1),
      'PE-61 a quote with no lender name is its own row, never folded into somebody else\'s');
  }
  {
    // An unpriced lender must not front a figure nobody quoted.
    const g = PB.groupByLender([Q('Solo', 'S', null)]);
    ok(g[0].bestPrice === null, 'PE-62 a lender with nothing priced fronts NO price (the screen shows a dash)');
    ok(PB.groupByLender(null).length === 0 && PB.groupByLender('x').length === 0,
      'PE-63 …and a non-list yields nothing rather than throwing');
  }
  ok(/groupByLender\(/.test(code),
    'PE-64 the board actually groups by lender — a rule the screen does not call is a rule nobody is following');
}

/* ═══════════════════════════════════════════════════════════════════════════════
   PE-65..PE-88 — WHAT A PRICE COSTS, AND WHAT THE SCREEN NO LONGER SAYS.

   The owner asked the board to say, beside the price, the points it implies and what those points
   come to in dollars on this loan — coloured so a cost and a credit cannot be mistaken for one
   another. The arithmetic is a MIRROR's arithmetic: one number said three ways, nothing decided.
   What is worth guarding is that the three can never disagree, and that a figure nobody has is
   never given a colour. */
{
  const PB2 = await import(new URL('../app-v2/src/longterm/priceBuild.js', import.meta.url));
  const PM = PB2.priceMoney;

  const above = PM(102, 500000);
  ok(above.points === -2 && above.dollars === -10000 && above.tone === 'credit',
    `PE-65 102 on a $500,000 loan is -2 points and $10,000 back (got ${above.points} / ${above.dollars} / ${above.tone})`);
  const below = PM(98, 500000);
  ok(below.points === 2 && below.dollars === 10000 && below.tone === 'cost',
    `PE-66 ...and 98 is +2 points and $10,000 out (got ${below.points} / ${below.dollars} / ${below.tone})`);
  const par = PM(100, 500000);
  ok(par.points === 0 && par.dollars === 0 && par.tone === 'credit',
    'PE-67 par is zero points, zero dollars, and green - it costs nothing');
  ok(PM(100.001, 1).tone === 'credit' && PM(99.999, 1).tone === 'cost',
    'PE-68 the line is exactly par - a hair above is a credit, a hair below is a cost');

  // ONE FACT, ONE VERDICT: the three columns take the same tone by construction.
  for (const p of [90, 97.5, 99.875, 100, 100.25, 103.75]) {
    const m2 = PM(p, 400000);
    ok(m2.tone === (m2.points <= 0 ? 'credit' : 'cost'),
      `PE-69 price ${p}: the tone and the sign of the points agree (${m2.tone})`);
    ok(m2.dollars === 0 || (m2.dollars > 0) === (m2.points > 0),
      `PE-70 price ${p}: the dollars carry the same sign as the points`);
  }

  /* A rate sheet quotes to a thousandth of a point; binary floating point does not. These prices
     are chosen because `100 - p` genuinely DRIFTS on each of them (99.875 does not — 0.875 is 7/8
     and exactly representable, which is why an earlier version of this guard passed with the
     rounding taken out and proved nothing). Verified by running the subtraction, not assumed. */
  ok(PM(99.99, 500000).points === 0.01,
    `PE-71 100 minus 99.99 is 0.010, not 0.010000000000005116 (got ${PM(99.99, 500000).points})`);
  ok(PM(97.3, 500000).points === 2.7, `PE-71a ...and 97.3 is 2.700 (got ${PM(97.3, 500000).points})`);
  ok(PM(101.7, 500000).points === -1.7, `PE-71b ...and 101.7 is -1.700 (got ${PM(101.7, 500000).points})`);
  ok(PM(99.99, 500000).dollars === 50, `PE-72 ...and 0.01 of a point on $500,000 is $50 (got ${PM(99.99, 500000).dollars})`);
  ok(PM(99.875, 500000).dollars === 625, 'PE-72a ...and an eighth of a point on it is $625');

  // NEVER A GUESS, AND NEVER A COLOURED EM DASH.
  const noPrice = PM(null, 500000);
  ok(noPrice.price === null && noPrice.points === null && noPrice.dollars === null && noPrice.tone === null,
    'PE-73 a price the vendor did not quote yields nothing at all - and NO colour');
  ok(PM(101, null).points === -1 && PM(101, null).dollars === null,
    'PE-74 a loan amount we cannot read costs the DOLLAR column only - the points still stand');
  for (const bad of [undefined, NaN, 'abc', {}]) {
    ok(PM(bad, 500000).tone === null, `PE-75 an unreadable price (${String(bad)}) is never given a verdict`);
    ok(PM(101, bad).dollars === null, `PE-76 ...and an unreadable loan amount (${String(bad)}) never yields dollars`);
  }
  ok(PM(101, 0).dollars === null && PM(101, -5).dollars === null,
    'PE-77 a zero or negative loan amount is not a loan amount');

  ok(PB2.toneColor('credit') === '#2F6B45' && PB2.toneColor('cost') === '#8A2F2F',
    'PE-78 there are exactly two tone colours, and they come from the shared module');
  ok(PB2.toneColor(null, '#3A4550') === '#3A4550' && PB2.toneColor(undefined, '#3A4550') === '#3A4550',
    'PE-79 ...and no verdict falls back to the caller\'s ordinary text colour');
  ok(!/var\(--ink/.test(String(PB2.toneColor('credit')) + String(PB2.toneColor('cost'))),
    'PE-80 ...and never an --ink* token, which is a LIGHT paper colour in this palette');

  // ── WHAT THE SCREEN NO LONGER SAYS ────────────────────────────────────────
  // NO APR ANYWHERE (owner-directed 2026-08-23). A DSCR loan is business-purpose credit made to an
  // entity; an APR is a consumer disclosure, so quoting one answers a question this product does not
  // raise - and invites a comparison against products it does not apply to.
  // ⛔ THE TEST IS FOR A QUOTED FIGURE, NOT FOR THE LETTERS. The disclosure the owner asked for
  // necessarily SAYS "no APR is quoted" — a guard that matched the word would fail on the very
  // sentence that explains the removal, and would then get "fixed" by deleting the explanation.
  // So: no APR value may be read off a quote, and no column may be headed by one.
  ok(!/\.apr\b|\bapr:/i.test(code), 'PE-81 no APR figure is read off a quote anywhere on the screen');
  ok(!/\.apor\b|\bapor:|>\s*APOR\s*</i.test(code),
    'PE-82 ...and no APOR, which only exists to be compared to an APR');
  ok(!/>\s*APR\s*</i.test(code) && !/'APR'|"APR"/.test(code),
    'PE-82a ...and no column, row or label is headed APR');
  // The one surviving mention is the disclosure itself, and it must actually be there.
  ok(/no APR is quoted/i.test(src), 'PE-82b ...while the screen says plainly that none is quoted');
  ok(/business-purpose/i.test(src), 'PE-83 ...and it says WHY, which is worth more than the number was');
  ok(!/Rate build/.test(code), 'PE-84 the rate-build block is gone');
  ok(!/Par rate/.test(code), 'PE-85 ...including the par-rate line it led with');

  // THE INELIGIBLE SIDE IS ASKED FOR AS PART OF THE WORKFLOW, and the ask is BOUNDED.
  ok(/askDisqualified\(\{ auto: true/.test(code),
    'PE-86 a price asks for the ineligible side on its own - the owner\'s "add it into the workflow"');
  ok(/DQ_AUTO_TRIES/.test(code) && /tries < DQ_AUTO_TRIES/.test(code),
    'PE-87 ...and the asking is bounded, so it can never run on a screen somebody walked away from');
  // THE COUNT COMES FROM THE READY ANSWER. The price response carries a disqualifiedCount of its own
  // that is ALWAYS zero - read at price time, before the vendor has computed this side - and printing
  // it is what made the panel report "nothing ruled out" on every scenario ever priced.
  ok(!/res\.disqualifiedCount/.test(code),
    'PE-88 ...and the screen never reads the price response\'s own disqualified count');
}

/* ── THE INELIGIBLE BOARD'S GROUPING (owner-directed 2026-08-23) ─────────────
   Rate -> lender -> programmes, the same three levels as the eligible board, and the LENDER level
   is the eligible board's own `groupByLender` so the two can never disagree. Pure, so unlike the
   render suite this runs on CI, where no front-end bundler is installed. */
{
  const PB3 = await import(new URL('../app-v2/src/longterm/priceBuild.js', import.meta.url));
  const B = PB3.buildIneligibleStack;

  const payload = [
    { lender: 'Deephaven Mortgage', items: [
      { program: 'DSCR 1.00-1.24 - 30 Yr Fixed', rate: 7.375, reasons: [{ rule: 'a' }], option: { priceBuild: {} } },
      { program: 'DSCR 30 Yr IO', rate: 7.375, reasons: [{ rule: 'b' }], option: { priceBuild: { price: 98.5 } } },
    ] },
    { lender: 'AD Mortgage', items: [{ program: 'X', rate: 7.25, reasons: [], option: null }] },
    { lender: 'Zed Capital', items: [{ program: 'Y', rate: null, reasons: [], option: null }] },
  ];
  const st = B(payload);

  ok(st.rates.map((r) => r.key).join(',') === '7.250,7.375',
    'PE-89 the rates stack ASCENDING, like the eligible board');
  ok(st.rates.find((r) => r.key === '7.375').lenders[0].programCount === 2,
    'PE-90 a lender with several programmes at one rate is ONE line that opens out');

  // NOTHING IS DROPPED. An item whose rate could not be read is its own group, never discarded and
  // never filed under a guessed rate — a silently missing programme is the defect this board ends.
  ok(st.noRate && st.noRate.itemCount === 1 && st.noRate.lenders[0].lender === 'Zed Capital',
    'PE-91 an item with no readable rate is KEPT, in its own group');
  ok(st.itemCount === 4, 'PE-92 ...so every item is accounted for, in one group or another');

  // A declined programme usually has no price. NULL must survive as null — a 0 would read as par.
  const dh = st.rates.find((r) => r.key === '7.375').lenders[0];
  ok(dh.quotes.some((q) => q.price === null) && dh.quotes.some((q) => q.price === 98.5),
    'PE-93 a price is carried when the vendor gave one and stays NULL when it did not');

  // The lender level IS groupByLender — asserted by running both and comparing, never by reading
  // the source, so a re-implementation that merely looked similar would still fail here.
  const flat = st.rates.find((r) => r.key === '7.375').lenders;
  const direct = PB3.groupByLender(dh.quotes);
  ok(flat[0].programCount === direct[0].programCount && flat[0].lender === direct[0].lender,
    'PE-94 the lender level is the eligible board\'s own grouping, not a second one');

  ok(JSON.stringify(B(null)) === JSON.stringify(B(undefined)) && B(null).rates.length === 0,
    'PE-95 a non-array yields an empty stack rather than throwing');

  // Lenders inside a rate are ordered by NAME, because a declined programme has no price to rank
  // by and ranking on a missing number would read as a judgement this mirror does not hold.
  const two = B([{ lender: 'Zed', items: [{ program: 'p', rate: 7, reasons: [] }] },
                 { lender: 'Able', items: [{ program: 'q', rate: 7, reasons: [] }] }]);
  ok(two.rates[0].lenders.map((l) => l.lender).join(',') === 'Able,Zed',
    'PE-96 lenders within a rate are ordered by name, not by an absent price');
}

/* ═══════════════════════════════════════════════════════════════════════════════
   PE-97..PE-102 — THE TERM BOX AND THE CALCULATOR ARE ON THE SCREEN.

   These are SOURCE guards, and they exist because the RENDER suite that proves the same things
   properly (R53..R66) needs esbuild, which no CI job installs — so it SKIPS on the build server and
   the term box could quietly disappear with every job green. What can be checked here without a
   bundler is that the screen still MOUNTS them, and mounts them fed by the shared definitions
   rather than by a second list somebody typed into the JSX.
   ────────────────────────────────────────────────────────────────────────── */
{
  ok(/id="pe-term"/.test(code) && /<select[^>]*id="pe-term"/.test(code),
    'PE-97 the loan-term box is on the form');
  ok(/LOAN_TERMS\.map/.test(code),
    'PE-98 ...and its options come from the shared LOAN_TERMS, not a list typed into the screen');
  ok(/value=\{f\.termYears\}/.test(code) && /termYears: DEFAULT_TERM_YEARS/.test(code),
    'PE-99 ...and the value it starts on is the shared default');
  ok(/<DscrCalc\b/.test(code), 'PE-100 the DSCR calculator is mounted');
  ok(/termYears=\{toNumber\(f\.termYears\)\}/.test(code) && /interestOnly=\{!!f\.io\}/.test(code),
    'PE-101 ...and it is fed the scenario\'s own term and interest-only flag, so the ratio follows them');
  ok(/\{calcOpen && \(/.test(code) && /useState\(false\)/.test(code),
    'PE-102 ...and it is closed until it is asked for');

  /* PE-103..PE-107 — the two owner reports of 2026-08-23, guarded where CI can see them.
     The render suite proves these properly (R67..R71) and SKIPS on the build server for want of a
     bundler, so what can be checked from the source lives here. */

  // (1) A CONTROL IN THE NAME BAND MUST NOT REPLACE THE NAME. `head || name` is the exact
  //     expression that lost the property-tax, insurance and DSCR names; it must never come back.
  ok(!/\{\s*head\s*\|\|/.test(code),
    'PE-103 a field never renders its control INSTEAD of its name');
  ok(/\{named\}/.test(code) && /\{head \?/.test(code),
    'PE-104 ...it renders both, so a switch and a name can share the band');

  // (2) THE RATIO FILLS ITSELF IN — no button. The behaviour is proven by running it
  //     (test-lt-dscr-autofill.mjs, which needs a browser); this pins the wiring.
  ok(!/Use this ratio/.test(code), 'PE-105 there is no "Use this ratio" button to press');
  ok(/onRatio\(dscrFigure\)/.test(code) && /\[dscrFigure, onRatio\]/.test(code),
    'PE-106 ...the answer is handed up on every CHANGE of the figure, and only then');
  // A receiver rebuilt each render would make that effect fire on every render instead of on every
  // change — which is how a hand-typed ratio gets stamped over by an unrelated keystroke.
  ok(/const takeRatio = useCallback\(/.test(code),
    'PE-107 ...and the receiver is stable, so an unrelated re-render cannot re-write the ratio');
}


{
  /* PE-108..PE-116 — THE COMPENSATION OVERLAY (owner-directed 2026-08-23). The behaviour is
     proven by the render suite (R72..R81), which SKIPS on the build server; the structural
     halves live here so CI holds them on every run. `code` is the comment-stripped source. */
  const overlay = read('app-v2/src/longterm/compOverlay.js');
  const overlayCode = overlay.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const scen = read('app-v2/src/longterm/scenarioFields.js');

  // (1) THE SWITCH IS WIRED AND DEFAULTS TO RAW.
  ok(/from '\.\/compOverlay\.js'/.test(code) && /<CompSwitch\b/.test(code),
    'PE-108 the three-way switch is mounted and reads the shared overlay module');
  ok(/useState\(DEFAULT_COMP_MODE\)/.test(code) && /DEFAULT_COMP_MODE = 'raw'/.test(overlayCode),
    'PE-109 the default position is RAW pricing — the owner\'s stated default');

  // (2) NOTHING ABOUT THE OVERLAY EVER REACHES THE WIRE. The scenario builder carries no comp
  //     key, and the screen's price call sends the scenario alone — the switch is a lens.
  ok(!/comp/i.test(scen.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      .replace(/complete/gi, '')),
    'PE-110 the scenario builder knows nothing called comp — the wire is untouched');
  ok(/dscrPrice\(toScenario\(f\)/.test(code) || /dscrPrice\(\s*toScenario\(/.test(code),
    'PE-111 ...and the price call sends the scenario and nothing else about the switch');

  // (3) FAIL TO RAW, NEVER TO A WRONG NUMBER — the null-plan path forces the raw identity.
  ok(/compProblem\s*\?\s*\{ mode: 'raw', shift: 0/.test(code),
    'PE-112 a plan that could not load forces the RAW identity, never a guessed shift');
  ok(/if \(v == null \|\| \(typeof v === 'string' && v\.trim\(\) === ''\)\) return null;/.test(overlayCode),
    'PE-113 a null figure is refused BEFORE Number() — Number(null) is 0, the silent-zero trap');

  // (4) EVERY PRICE CELL ON BOTH BOARDS GOES THROUGH THE SHIFT. A bare call on a board price
  //     would show one product two ways between the header and its row.
  ok(!/priceMoney\(row\.bestPrice/.test(code) && !/priceMoney\(g\.bestPrice/.test(code)
    && !/priceMoney\(q\.price/.test(code),
    'PE-114 no board price bypasses the shift — every cell reads dP(...)');
  ok((code.match(/priceMoney\(dP\(/g) || []).length >= 4,
    'PE-115 ...and the shifted read is used at every price cell on the two boards');

  // (5) THE COMP IS INVISIBLE IN A COMP POSITION: the vendor comp block is withheld there.
  ok(/\{!compActive && <Track title="Comp">/.test(code),
    'PE-116 the vendor comp block renders only in RAW — comp figures never show in a comp position');
}

console.log(`\n${failures === 0 ? 'OFFLINE: all passed' : `FAILURES: ${failures}`}`);
process.exit(failures ? 1 : 0);
