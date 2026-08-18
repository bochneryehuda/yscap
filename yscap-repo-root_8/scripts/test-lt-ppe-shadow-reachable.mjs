#!/usr/bin/env node
/**
 * LT PPE — the shadow comparison is REACHABLE from the product, and a run that compared
 * nothing never draws as a clean board.
 *
 * WHAT THIS IS FOR. `facade.priceWithShadow` — Lender Price answers, our engine prices the
 * same scenario beside it, six parity detectors categorize the difference, `divergence`
 * diagnoses it and `finding-store.persistRun` writes it down — runs inside exactly ONE HTTP
 * route, `POST /api/lt/ppe/quote`. Measured on this branch before the change: `ppeQuote` did
 * not exist on `app-v2/src/longterm/api.js` and the string appeared nowhere in the repo, so
 * no screen could reach it. The findings ledger and the parity-cell series therefore had NO
 * producer a person could trigger, and an EMPTY pricing-engine board was indistinguishable
 * from a CLEAN one — a measurement surface reporting success by having never run.
 *
 * WHAT IS ACTUALLY COVERED, stated exactly:
 *   · the client method exists and posts to the right path — a screen calling a method
 *     nobody defined BUILDS CLEANLY (esbuild emits an undeclared identifier verbatim) and
 *     throws `ReferenceError` at first paint;
 *   · the control BUNDLES and its FIRST PAINT renders, with the vendor-call cost on the
 *     screen BEFORE anything is pressed — a cost disclosed after it is incurred is not a
 *     disclosure — and with no verdict about a run that never happened;
 *   · NOTHING FIRES ON LOAD: rendering the container never touches the client at all, and
 *     the module contains no effect that could;
 *   · the refusal that stops a live vendor call being spent to learn nothing;
 *   · THE HONESTY RULE, every branch: `shadow: null`, an `incomparable` verdict, an
 *     `engine_error`, a real disagreement, an `agreed: true` whose deep half never ran, and
 *     an `agreed: true` whose eligibility axis was only half-tested. Five of those six are
 *     states in which `shadow.agreed` is true or missing, and every one of them would draw
 *     green on a screen that asked only that;
 *   · the LOADED states are RENDERED and asserted on the TEXT A PERSON READS — including the
 *     held-back rows, because a reader who counts the differences on screen and finds fewer
 *     on the ledger has been misled about which is the record.
 *
 * WHY THE VIEW IS SPLIT OUT. `renderToString` never runs an effect and never fires a click
 * handler, so a component that fetches its own answer can only be tested EMPTY — and every
 * state worth guarding here exists only after a run. The presentational half takes the façade
 * response as a prop, so the suite hands it real ones.
 *
 * WHY THE ASSERTIONS MATCH STRIPPED TEXT. React's server renderer splits `{a} literal {b}`
 * into separate text nodes divided by `<!-- -->` markers, so a regex over raw HTML fails on
 * any sentence that interpolates a value.
 *
 * NOT covered here: the click itself and the route's own behaviour. `test-lt-ppe-route.js`
 * drives `POST /ppe/quote`; `test-lt-ppe-facade.js` and `test-lt-ppe-shadow-e2e.js` drive the
 * comparison. This suite is about the front end being able to reach any of it.
 *
 *   node scripts/test-lt-ppe-shadow-reachable.mjs
 *
 * LT-only. No database, no network, no browser.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const appv2 = path.join(repo, 'app-v2');
const require2 = createRequire(path.join(appv2, 'package.json'));

let n = 0; let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); n += 1; if (!cond) failures += 1; };

const esbuild = require2('esbuild');

const SRC = path.join(appv2, 'src/longterm/LtShadowCompare.jsx');
const SCREEN = path.join(appv2, 'src/longterm/LtPricingBreakdown.jsx');
const API = path.join(appv2, 'src/longterm/api.js');

// A RECORDING stub. It never settles, which keeps this suite about RENDERING rather than the
// network — and it counts every call, which is how "nothing fires on load" is proven rather
// than asserted. A real client here would make the suite depend on a session and a vendor.
const STUB_API = `
globalThis.__apiCalls = [];
export const ltApi = new Proxy({}, {
  get: (_t, name) => (...args) => {
    globalThis.__apiCalls.push({ name: String(name), args });
    return new Promise(() => {});
  },
});
export default ltApi;
`;

const entry = `
import React from 'react';
import { renderToString } from 'react-dom/server';
import LtShadowCompare, {
  ShadowCompareView, shadowOutcome, quoteRequest, skippedReason,
  ladderDifferences, deepDifferences, heldBack, COST_NOTICE, NEEDS_SHEET,
} from ${JSON.stringify(SRC)};
globalThis.__React = React;
globalThis.__renderToString = renderToString;
globalThis.__Panel = LtShadowCompare;
globalThis.__View = ShadowCompareView;
globalThis.__pure = { shadowOutcome, quoteRequest, skippedReason, ladderDifferences, deepDifferences, heldBack, COST_NOTICE, NEEDS_SHEET };
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-shadow-reach-'));
const outfile = path.join(tmp, 'bundle.cjs');
const stubPlugin = {
  name: 'stub-api',
  setup(build) {
    build.onResolve({ filter: /(^|\/)api\.js$/ }, (args) => {
      if (args.importer.includes(path.join('src', 'longterm'))) return { path: 'lt-api-stub', namespace: 'stub' };
      return null;
    });
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: STUB_API, loader: 'js' }));
  },
};

console.log('LT PPE — the shadow comparison, reachable and honest\n');

try {
  await esbuild.build({
    stdin: { contents: entry, resolveDir: appv2, loader: 'jsx' },
    bundle: true, outfile, platform: 'node', format: 'cjs', jsx: 'automatic',
    logLevel: 'silent', plugins: [stubPlugin], absWorkingDir: appv2,
  });
} catch (e) {
  ok(false, `S0 the control and everything it imports bundle: ${String(e && e.message).slice(0, 300)}`);
  console.log(`\n${failures} FAILED of ${n}`);
  process.exit(1);
}
ok(true, 'S0 the control and everything it imports bundle');

require2(outfile);
const React = globalThis.__React;
const renderToString = globalThis.__renderToString;
const Panel = globalThis.__Panel;
const View = globalThis.__View;
const {
  shadowOutcome, quoteRequest, skippedReason, ladderDifferences, deepDifferences, heldBack,
  COST_NOTICE, NEEDS_SHEET,
} = globalThis.__pure;

const text = (html) => String(html).replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const render = (el) => { try { return renderToString(el); } catch (e) { return `THREW ${e.message}`; } };

// ---- 1. the client method exists, and reaches the ONE route that runs the shadow ----------------
{
  const api = fs.readFileSync(API, 'utf8');
  ok(/^\s*ppeQuote:/m.test(api),
    'S1 THE DEFECT ITSELF: `ltApi.ppeQuote` exists — before this change the string was nowhere in the '
    + 'repo, so no screen could reach the only route that runs facade.priceWithShadow');
  ok(/ppeQuote:\s*\(body\)\s*=>\s*ltPost\(lt\('\/ppe\/quote'\)/.test(api),
    'S2 …and it POSTs to /api/lt/ppe/quote through the lt() prefix (a GET, or a typo\'d path, is a '
    + 'method that exists and still reaches nothing)');

  const screen = fs.readFileSync(SCREEN, 'utf8');
  ok(/import LtShadowCompare from '\.\/LtShadowCompare\.jsx'/.test(screen) && /<LtShadowCompare\s/.test(screen),
    'S3 …and a real screen MOUNTS the control — a client method no screen calls is the same dead end, '
    + 'one step nearer the user');
  ok(/<LtShadowCompare[^>]*buildBody=\{buildBody\}/.test(screen),
    'S4 …fed THIS form\'s scenario, so the deal broken down and the deal measured are the same deal');
}

// ---- 2. the first paint: the cost is stated BEFORE the press, and nothing has run ---------------
{
  globalThis.__apiCalls = [];
  const html = render(React.createElement(Panel, { buildBody: () => ({}) }));
  ok(!String(html).startsWith('THREW'), `S5 the first paint renders without throwing (${String(html).slice(0, 160)})`);

  const t = text(html);
  ok(t.includes('one live vendor call each time you press it'),
    'S6 THE COST IS ON THE SCREEN BEFORE THE PRESS — a disclosure after the fact is not a disclosure');
  ok(t.includes('It never runs on its own.'),
    'S7 …and says plainly that it never fires by itself');
  ok(/Run the comparison/.test(t), 'S8 the control names the deliberate action');

  ok(globalThis.__apiCalls.length === 0,
    'S9 RENDERING CALLS NOTHING: the first paint made zero client calls, so a page load cannot spend a '
    + 'vendor call or write a finding');

  // S9 CANNOT SEE AN EFFECT — `renderToString` never runs one — so on its own it would pass a
  // component that fires itself on mount in the browser. That is exactly why S10 exists, and the
  // mutation that adds `useEffect(() => run())` is caught by S10 alone. Neither is redundant.
  const src = fs.readFileSync(SRC, 'utf8');
  ok(!/useEffect|useLayoutEffect|setInterval|setTimeout/.test(src),
    'S10 …and the module holds no effect, interval or timer that could ever fire it on its own');

  // Asserted on the VERDICT BLOCK, not on the word "disagreement" — the cost notice legitimately
  // uses that word to say what a run would write, and a cruder regex flagged the disclosure itself.
  ok(!/\bnot compared\b/.test(t) && !/\bpartly compared\b/.test(t) && !/(^|[^y]) compared /.test(t),
    'S11 with nothing run it renders NO verdict block — an empty panel wearing a comparison label is the '
    + 'exact defect this whole change is about');
  ok(!/Both engines agreed/.test(t) && !/engines disagreed/.test(t),
    'S11b …and no headline claiming either engine said anything');
}

// ---- 3. a live vendor call is never spent to learn nothing --------------------------------------
{
  const refused = quoteRequest({ scenario: { fico: 720 } });
  ok(refused.ok === false && refused.refusal === NEEDS_SHEET,
    'S12 with no rate-sheet version the call is REFUSED before it is made — /quote would answer with a '
    + 'live Lender Price call and `shadow: null`, spending a vendor call whose whole result is '
    + '"nothing was compared"');
  ok(/vendor call spent to learn nothing/.test(NEEDS_SHEET) && /rate-sheet version/.test(NEEDS_SHEET),
    'S13 …and the refusal says what to do about it, not just that it was refused');

  const sent = quoteRequest({ scenario: { fico: 720 }, investor: 'DH', rateSheetVersionId: 'v9', rate: 7.5, source: 'lp' });
  ok(sent.ok === true, 'S14 with a version it goes');
  ok(JSON.stringify(Object.keys(sent.body).sort()) === JSON.stringify(['investor', 'rateSheetVersionId', 'scenario']),
    'S15 …carrying ONLY the three keys /quote reads — `rate` and `source` belong to the breakdown\'s view '
    + 'and would be a second, half-honoured contract');
}

// ---- 4. THE HONESTY RULE — every way a run can compare nothing, or half of it -------------------
{
  // 4a. our engine never ran: Lender Price answered and there was nothing to compare it against.
  const none = shadowOutcome({ ok: true, mode: 'shadow', answer: {}, shadow: null, shadowSkipped: 'program_not_found' });
  ok(none.state === 'nothing' && none.compared === false,
    'S16 THE SHARPEST ONE: `shadow: null` is reported as NOTHING COMPARED — `agreed` does not exist on '
    + 'that response, so a screen reading `shadow && shadow.agreed` draws an absence as a pass');
  ok(/Nothing was compared/.test(none.headline) && !/agree/i.test(none.headline),
    'S17 …and never in words that read as agreement');
  ok(/not on file/.test(none.detail),
    'S18 …naming the server\'s own reason, so it is actionable rather than a shrug');
  ok(skippedReason('program_load_failed: relation "x" does not exist') === 'program_load_failed: relation "x" does not exist',
    'S19 an unrecognised skip reason is printed VERBATIM — the database\'s own message is the only thing '
    + 'that says what broke, and a friendly replacement would throw it away');

  // 4b. the façade REFUSED to score. `agree` is already false here, so a screen asking only
  // "did it agree?" prints "they disagreed" and sends somebody hunting a defect that does not exist.
  const inc = shadowOutcome({
    shadow: {
      agreed: false,
      findings: [{ kind: 'incomparable', side: 'theirs', detail: 'Lender Price returned 17 programs and this comparison is not scoped to one' }],
      deep: { ran: false, why: 'not scoped' },
    },
  });
  ok(inc.state === 'incomparable' && inc.compared === false,
    'S20 an INCOMPARABLE verdict is "nothing was compared", not "they disagreed" — the difference is '
    + 'between a wiring fact and a pricing defect, and they send a person to opposite places');
  ok(/17 programs/.test(inc.detail) && /never having happened/.test(inc.detail),
    'S21 …carrying the façade\'s own reason and saying outright that the comparison did not happen');

  // 4c. our engine threw. A real, recorded finding — but not a disagreement about a price.
  const err = shadowOutcome({
    shadow: { agreed: false, findings: [{ kind: 'engine_error', side: 'ours', detail: 'our engine threw: no base grid' }], deep: { ran: false } },
  });
  ok(err.state === 'engine_error' && err.compared === false && /could not price/i.test(err.headline),
    'S22 an engine_error is our engine failing, never "the two engines disagreed on 1 point"');

  // 4d. a genuine disagreement.
  const dis = shadowOutcome({
    shadow: {
      agreed: false,
      findings: [{ kind: 'price_mismatch', rate: 7.5, detail: 'price disagrees by 375 milli-points on coupon 7.5' }],
      deep: { ran: true, verdict: 'differ', disqualifyReady: true, differences: [{ category: 'margin', detail: 'margin differs by 125 milli' }] },
    },
  });
  ok(dis.state === 'disagreed' && dis.compared === true && /disagreed on 2 points/.test(dis.headline),
    'S23 a real disagreement counts BOTH halves — the ladder finding and the categorized axis are two '
    + 'things to work, and reporting one would understate the run');

  // 4e. agreed on the ladder, and the six categorized axes never ran at all.
  const half = shadowOutcome({
    shadow: { agreed: true, findings: [], deep: { ran: false, why: 'no full Lender Price capture was provided' } },
  });
  ok(half.state === 'partial' && half.compared === 'partly',
    'S24 THE QUIET ONE: `agreed: true` with the deep half NEVER RUN is reported as PARTLY compared — the '
    + 'base grid, the margin, the itemized adjustments and the three eligibility axes were not measured, '
    + 'and half a comparison is not a pass');
  ok(!/^Both engines agreed/.test(half.headline) && /not compared/.test(half.headline),
    'S25 …and does not open with agreement');
  ok(/no full Lender Price capture was provided/.test(half.detail),
    'S26 …quoting the façade\'s own stated reason for abstaining');

  // 4f. everything matched, but Lender Price had not finished working out its declines.
  const notReady = shadowOutcome({
    shadow: { agreed: true, findings: [], deep: { ran: true, verdict: 'agree', disqualifyReady: false, differences: [] } },
  });
  ok(notReady.state === 'partial' && notReady.compared === 'partly',
    'S27 an unready disqualify tree is HALF-TESTED eligibility — Lender Price naming no declines because '
    + 'it had not finished is not evidence that it declined nothing');
  ok(/half-tested/i.test(notReady.headline), 'S28 …and says so in the headline, where it is read');

  // 4g. the only state that may draw green.
  const agreed = shadowOutcome({
    shadow: { agreed: true, findings: [], deep: { ran: true, verdict: 'agree', disqualifyReady: true, differences: [] } },
  });
  ok(agreed.state === 'agreed' && agreed.tone === 'good' && agreed.compared === true,
    'S29 ONLY a run that compared every axis with both sides fully read may read as agreement');
  ok(/Nothing was written to the findings ledger/.test(agreed.detail),
    'S30 …and says the ledger got nothing, so an unchanged board is explained rather than ambiguous');

  ok(shadowOutcome(null) === null,
    'S31 nothing run yet is NOT an outcome — rendering a verdict about a run that never happened is the '
    + 'whole class of defect here');
}

// ---- 5. the LOADED states, rendered — asserted on the words a person reads ----------------------
{
  const RESULT = {
    ok: true, mode: 'shadow', authoritative: 'lp', answer: {},
    shadow: {
      agreed: false,
      findings: [
        {
          kind: 'price_mismatch', rate: 7.5, detail: 'price disagrees by 375 milli-points on coupon 7.5 (tolerance 125)',
          explanation: {
            kind: 'price_mismatch', rate: 7.5, confidence: 'strong',
            summary: 'Our price is 0.375 pts higher than Lender Price (coupon 7.5). The gap exactly equals our cash-out adjustment (0.375 pts) — most likely Lender Price treats that one differently; check it first.',
          },
        },
        { kind: 'eligibility_mismatch', detail: 'we say eligible, Lender Price says ineligible' },
      ],
      deep: {
        ran: true, verdict: 'differ', disqualifyReady: true,
        differences: [{ category: 'margin', severity: 'high', detail: 'our margin is 125 milli above theirs on coupon 7.5', rate: 7.5 }],
        recorded: 1,
        notRecorded: [{ category: 'final_price', why: 'the ladder comparison already records this disagreement under its own name' }],
        supersededLadderKinds: ['eligibility_mismatch'],
      },
    },
  };

  const html = render(React.createElement(View, { outcome: shadowOutcome(RESULT), result: RESULT, error: '' }));
  ok(!String(html).startsWith('THREW'), `S32 the LOADED state renders (${String(html).slice(0, 160)})`);
  const t = text(html);

  ok(/disagreed on 3 points/.test(t), 'S33 the verdict is on the screen');
  ok(/price disagrees by 375 milli-points on coupon 7\.5/.test(t),
    'S34 the ladder difference is shown in the SERVER\'s own words — this page re-phrases nothing');
  ok(/our margin is 125 milli above theirs/.test(t),
    'S35 …and so is the categorized axis, which the ladder comparison structurally cannot see');
  ok(/coupon 7\.5/.test(t), 'S36 …with the coupon it is about');

  // THE ONE THAT MATTERS MOST after the honesty rule: a reader counting rows here and finding
  // fewer on the ledger has been misled about which is the record.
  ok(/Shown here, not written twice/.test(t),
    'S37 the held-back rows are RENDERED, not merely computed');
  ok(/already records this disagreement under its own name/.test(t),
    'S38 …each with the reason it was not written a second time');
  ok(/eligibility mismatch/.test(t) && /recorded this same disagreement under a richer name/.test(t),
    'S39 …including a ladder finding the deep pass superseded, which is a different mechanism and would '
    + 'otherwise vanish silently');

  // The helpers, called for real out of the bundle rather than re-implemented here.
  ok(ladderDifferences(RESULT).length === 2 && deepDifferences(RESULT).length === 1,
    'S40 the two halves are read separately');
  ok(heldBack(RESULT).length === 2,
    'S41 …and both held-back mechanisms are surfaced (a suppressed row and a superseded one)');
  ok(ladderDifferences({ shadow: { findings: [{ kind: 'incomparable', detail: 'x' }] } }).length === 0,
    'S42 an `incomparable` verdict is never listed as a difference — it is the absence of one');
  ok(ladderDifferences({ shadow: { findings: [{ kind: 'engine_error', detail: 'x' }] } }).length === 0,
    'S42b …and neither is an `engine_error`, which is our engine producing no ladder at all — listing it '
    + 'under "where the price ladders differ" would name a disagreement that does not exist');

  // WHY it diverged — the one part of a finding anybody can act on, and it can only be computed at
  // the moment our reconstruction exists (`our_payload` is NULL on every stored finding).
  ok(/The gap exactly equals our cash-out adjustment/.test(t),
    'S42c the façade\'s DIAGNOSIS is rendered — the finding says the prices differ, this says where to look');
  ok(/strong match — a hypothesis, not a verdict/.test(t),
    'S42d …carrying its own confidence and labelled a hypothesis, because Lender Price publishes no '
    + 'breakdown of its own and the suspect is ranked by numeric proximity alone');

  const noDiag = text(render(React.createElement(View, {
    outcome: shadowOutcome({ shadow: { agreed: false, findings: [{ kind: 'rate_mismatch', detail: 'the coupon differs' }], deep: { ran: true, disqualifyReady: true, differences: [] } } }),
    result: { shadow: { agreed: false, findings: [{ kind: 'rate_mismatch', detail: 'the coupon differs' }], deep: { ran: true, disqualifyReady: true, differences: [] } } },
    error: '',
  })));
  ok(/the coupon differs/.test(noDiag) && !/likely cause/.test(noDiag),
    'S42e a finding the façade could not narrow draws NO "likely cause" line — an empty diagnosis '
    + 'heading reads as a diagnosis nobody wrote down');

  // A COMPARED-NOTHING run, rendered end to end.
  const NONE = { shadow: null, shadowSkipped: 'no_program_requested' };
  const nh = text(render(React.createElement(View, { outcome: shadowOutcome(NONE), result: NONE, error: '' })));
  ok(/not compared/.test(nh) && /Nothing was compared/.test(nh),
    'S43 a compared-nothing run RENDERS as not compared — the label a person reads at a glance');
  ok(!/\bagreed\b/.test(nh), 'S44 …and the word "agreed" appears nowhere on it');

  // A refusal is SAID.
  const eh = text(render(React.createElement(View, { outcome: null, result: null, error: NEEDS_SHEET })));
  ok(/rate-sheet version/.test(eh),
    'S45 a refusal is shown — rendering nothing would look exactly like a run that has not happened yet');
}

// ---- 6. the board no longer reads an empty list as a clean one ----------------------------------
{
  // JSX wraps its copy across source lines, so the whitespace is collapsed first — the same
  // reason the rendered assertions above match stripped text.
  const board = fs.readFileSync(path.join(appv2, 'src/longterm/LtPpe.jsx'), 'utf8').replace(/\s+/g, ' ');
  ok(/two different things this list cannot tell apart/.test(board),
    'S46 the findings board says outright that an empty list is two different things — it has no way to '
    + 'tell "everything agreed" from "nothing was measured"');
  ok(/Differences only arrive here when somebody runs a comparison/.test(board),
    'S47 …and names where a measurement comes from, so an empty board points at the fix');
}

// ---- 7. the separation and colour rules -----------------------------------------------------
{
  const src = fs.readFileSync(SRC, 'utf8');
  const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const nonLocal = imports.filter((p) => p !== 'react' && !p.startsWith('./'));
  ok(nonLocal.length === 0,
    `S48 no import reaches outside longterm/ (${nonLocal.join(', ') || 'none'}) — Long-Term starts at zero`);
  ok(!/var\(--ink/.test(src),
    'S49 no `--ink*` token anywhere — every one of them is a LIGHT paper colour in this palette, so using '
    + 'one as a text colour renders white-on-white');
  ok(!/window\.(alert|confirm|prompt)\s*\(|[^.\w](alert|confirm|prompt)\s*\(/.test(src),
    'S50 no browser dialog — the shared helper is RTL\'s and Long-Term may not import it');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${failures ? `${failures} FAILED of ${n}` : `all ${n} passed`}`);
process.exit(failures ? 1 : 0);
