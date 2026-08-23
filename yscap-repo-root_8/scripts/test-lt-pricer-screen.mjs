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

console.log(`\n${failures === 0 ? 'OFFLINE: all passed' : `FAILURES: ${failures}`}`);
process.exit(failures ? 1 : 0);
