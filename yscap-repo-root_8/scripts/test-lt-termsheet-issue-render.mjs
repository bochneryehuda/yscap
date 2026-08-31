#!/usr/bin/env node
/**
 * ISSUING A TERM SHEET FROM ONE OPTION'S OWN ROW — it renders, and it asks for the right things.
 *
 * OWNER-DIRECTED 2026-08-30: *"where that button is, you should be able to issue a term sheet.
 * Which means you can only select one option. And if you enter the full scenario, you can right
 * away issue the term sheet. And if not, you need to enter the numbers over there … the same way
 * you enter by the Calculate and it verifies that the ratio that you're searching is the correct
 * ratio and it issues a full term sheet. You can put in property addresses … and a name of the
 * person and/or a name of the entity."*
 *
 * WHY THIS RENDERS RATHER THAN READING THE SOURCE. A green `npm run build` does NOT mean the page
 * renders: esbuild emits an undeclared identifier verbatim, so a component reading a prop nobody
 * passed it builds cleanly and throws `ReferenceError` at render — which the ErrorBoundary turns
 * into the full-screen "Something went wrong". That is the likeliest way this change breaks, and
 * only a render catches it.
 *
 * WHAT IS COVERED, exactly:
 *   · the whole import graph BUNDLES (an unresolved import — the new address field — is caught here);
 *   · the row control renders and offers ISSUING as the primary action, with collecting beside it;
 *   · raw pricing still refuses in place, with its reason, rather than the button vanishing;
 *   · the inline panel renders EVERY box a term sheet needs, each reachable by its own label;
 *   · the ratio check draws the agreeing and the differing verdict, and draws NOTHING on an
 *     incomplete scenario — a confident "they match" on half a scenario is worse than silence;
 *   · the issue button is never disabled by the gate (the server refuses and says why).
 *
 * NOT covered here: the click that opens the panel, and the round trip to the server. `renderToString`
 * runs no effects and no state changes. Those are pinned by `test-lt-termsheet-issue-survives-pure.mjs`
 * and by the server's own `test-lt-termsheet-party-pure.mjs`.
 *
 * LT-only. No DOM, no network, no database.
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

console.log('LT term sheets — issuing one option from its own row\n');

// ⛔ LOUD SKIP, NEVER A QUIET ONE. esbuild lives under app-v2/, which no CI job installs, so this
// file has nothing to render with there. A silent skip would drop every assertion below out of CI
// while the log still read like a pass, so the skip names what did not run.
let esbuild;
try {
  esbuild = require2('esbuild');
} catch {
  console.log('SKIPPED — esbuild is not installed under app-v2/, so the panel cannot be bundled here.');
  console.log('  Expected on CI: no CI job installs the front end.');
  console.log('  NOT RUN: every assertion in this file (the row control, the inline boxes, the ratio check).');
  console.log('  STILL RUN on CI: test-lt-termsheet-issue-survives-pure.mjs and test-lt-termsheet-party-pure.mjs.');
  process.exit(0);
}

const STUB_API = `
export const ltApi = new Proxy({}, { get: () => () => new Promise(() => {}) });
export default ltApi;
`;

const entry = `
import React from 'react';
import { renderToString } from 'react-dom/server';
import { QuoteTermSheetActions, IssueFields, RatioCheck, ComparisonWorkflowPanel, COMPARISON_WORKFLOWS, workflowMismatch, ComparisonStrip } from ${JSON.stringify(path.join(appv2, 'src/longterm/TermSheetPanel.jsx'))};
import AddressField, { oneLineFrom } from ${JSON.stringify(path.join(appv2, 'src/longterm/AddressField.jsx'))};
globalThis.__React = React;
globalThis.__renderToString = renderToString;
globalThis.__QuoteTermSheetActions = QuoteTermSheetActions;
globalThis.__IssueFields = IssueFields;
globalThis.__RatioCheck = RatioCheck;
globalThis.__ComparisonWorkflowPanel = ComparisonWorkflowPanel;
globalThis.__COMPARISON_WORKFLOWS = COMPARISON_WORKFLOWS;
globalThis.__workflowMismatch = workflowMismatch;
globalThis.__ComparisonStrip = ComparisonStrip;
globalThis.__AddressField = AddressField;
globalThis.__oneLineFrom = oneLineFrom;
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-ts-issue-render-'));
const outfile = path.join(tmp, 'bundle.cjs');

// The panel imports `./api.js`, which reaches for the browser's fetch at CALL time only — but the
// module is imported at LOAD, so the whole graph still has to bundle. It is stubbed because this
// file is about RENDERING; a real fetch would make it about the network instead. Same shape as
// `test-lt-pricer-screen-render.mjs` — and it must be the ASYNC build: esbuild's synchronous API
// refuses plugins outright.
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

try {
  await esbuild.build({
    stdin: { contents: entry, resolveDir: appv2, loader: 'jsx' },
    bundle: true, outfile, platform: 'node', format: 'cjs', jsx: 'automatic',
    logLevel: 'silent', plugins: [stubPlugin], absWorkingDir: appv2,
  });
} catch (e) {
  ok(false, `the panel bundles at all: ${String(e && e.message).slice(0, 400)}`);
  console.log(`\nFAILURES: ${failures}`);
  process.exit(1);
}
ok(true, 'the panel and its whole import graph bundle — the new address field resolves');

require2(outfile);
const React = globalThis.__React;
const render = globalThis.__renderToString;
const h = React.createElement;
const draw = (C, props) => render(h(C, props));

const CALC = {
  rent: '3900', tax: '620', taxBasis: 'monthly',
  insurance: '145', insBasis: 'monthly', hoa: '', rate: '',
};
const PREPARED = { borrowerName: '', entityName: '', propertyAddress: '' };
const issueObj = (over) => ({
  selectionNow: () => ({}),
  prepared: PREPARED,
  setPrepared: () => {},
  calc: CALC,
  setCalc: () => {},
  ratioCheck: () => ({ state: 'unknown' }),
  ...(over || {}),
});

console.log('A. the row control');
{
  const html = draw(globalThis.__QuoteTermSheetActions, {
    sel: {}, enabled: true, mode: 'borrowerPaid', cartCount: 0, issue: issueObj(),
  });
  ok(html.includes('Issue term sheet'), 'A1 issuing this ONE option is offered — the owner\'s "where that button is"');
  ok(html.includes('Add to comparison'), 'A2 …and collecting several is still there beside it, the other workflow');
  const i = html.indexOf('Issue term sheet'); const a = html.indexOf('Add to comparison');
  ok(i >= 0 && a >= 0 && i < a, 'A3 …with issuing FIRST — a term sheet is one option, so it leads');
}
{
  // No `issue` = the board did not hand the deal's facts down (an older screen, or the
  // ineligible board). The control must fall back, never offer a button that cannot finish.
  const html = draw(globalThis.__QuoteTermSheetActions, {
    sel: {}, enabled: true, mode: 'borrowerPaid', cartCount: 2, issue: null,
  });
  ok(!html.includes('Issue term sheet'), 'A4 with no deal facts the issue button is absent, not broken');
  ok(html.includes('Add to comparison'), 'A5 …and collecting still works');
}
{
  const html = draw(globalThis.__QuoteTermSheetActions, {
    sel: {}, enabled: true, mode: 'raw', cartCount: 0, issue: issueObj(),
  });
  ok(!html.includes('Issue term sheet') && html.includes('never goes'),
    'A6 raw pricing refuses IN PLACE with its reason — a vanished button teaches nobody why');
}
{
  ok(draw(globalThis.__QuoteTermSheetActions, { sel: {}, enabled: false, issue: issueObj() }) === '',
    'A7 term sheets switched off draws nothing at all');
}

console.log('\nB. the boxes, on the row');
{
  const gate = { ok: false, missing: ['partyName', 'propertyAddress'], message: 'A term sheet states the whole loan…' };
  const html = draw(globalThis.__IssueFields, {
    issue: issueObj(), gate, onChanged: () => {}, busy: null, onIssue: () => {}, onCancel: () => {},
  });
  for (const label of ['Monthly rent', 'Property tax', 'Hazard insurance', 'Monthly HOA',
    'Property address', 'Vesting entity']) {
    ok(html.includes(label), `B1 the panel asks for ${label.toLowerCase()}`);
  }
  ok(/Borrower(&#x27;|&#39;|’)s name/.test(html) || html.includes('Borrower'),
    'B1 the panel asks for the borrower\'s name');
  ok(html.includes('Mo') && html.includes('Yr'),
    'B2 …tax and insurance carry the monthly/yearly switch, so a yearly bill is never read as monthly');
  ok(html.includes('Either name is enough'),
    'B3 …and it SAYS either name will do — the server reports one shortfall, so one job is shown');
  ok(html.includes('Blank means none'), 'B4 …HOA states its default in place');
  ok(html.includes(CALC.rent) && html.includes(CALC.tax),
    'B5 the boxes are filled from the board\'s OWN calculator state — one property, one set of facts');
  ok(html.includes('A term sheet states the whole loan'),
    'B6 the server\'s own sentence is printed, not a local restatement of the rule');
  // ⛔ THE ATTRIBUTE, NOT THE SUBSTRING. `aria-disabled="false"` contains the word "disabled", so a
  // bare search for it reports a live button as greyed — the first cut of this assertion did
  // exactly that and went red on a button that was working perfectly.
  const beforeIssue = html.split('Issue the term sheet')[0].slice(-300);
  ok(!/\sdisabled=""/.test(beforeIssue),
    'B7 a shortfall of FIELDS does not grey the issue button — each one is a box on this panel, and '
    + 'the server names them all at once');
}

console.log('\nC. the ratio check says only what it can prove');
{
  ok(draw(globalThis.__RatioCheck, { check: { state: 'unknown' } }) === '',
    'C1 an incomplete scenario draws NOTHING — a confident "they match" would be worse than silence');
  ok(draw(globalThis.__RatioCheck, { check: null }) === '',
    'C2 …and so does no check at all');
  const agree = draw(globalThis.__RatioCheck, { check: { state: 'agree', computed: '1.24', priced: '1.24' } });
  // RE-POINTED 2026-08-31, not loosened: the rule became a BAND test at the owner's direction, so
  // an agreeing ratio is now confirmed as being in the same band rather than as the same number.
  // The subject is unchanged — a matching ratio is stated back, never left silent.
  ok(agree.includes('1.24') && /same band this was priced in/.test(agree),
    'C3 an agreeing ratio is confirmed as being in the band this was priced in');
  const differs = draw(globalThis.__RatioCheck, { check: { state: 'differs', computed: '1.18', priced: '1.24' } });
  ok(differs.includes('1.18') && differs.includes('1.24'),
    'C4 a differing ratio names BOTH figures — the officer needs to see the gap, not be told there is one');
  // ⛔ RE-POINTED, NOT LOOSENED (owner-directed 2026-08-30). This used to assert that the ratio
  // mismatch merely ADVISED re-running the search; the owner found that a sheet issued at a lower
  // ratio than it was priced at hands the borrower a rate bought in a band they do not qualify for
  // — money out of the door on every such sheet. It is a REFUSAL now, and the remedy is a button.
  ok(/cannot be issued/i.test(differs),
    'C5 a ratio below the one the price was obtained at REFUSES — it is money, not a nicety');
  ok(/re-price/i.test(differs),
    'C5a …and names the re-price, so the refusal is never a dead end');
  const withButton = draw(globalThis.__RatioCheck, {
    check: { state: 'differs', computed: '1.18', priced: '1.24' }, onReprice: () => {},
  });
  ok(/Re-price at 1\.18/.test(withButton),
    'C5b …and offers the button, at the ratio the figures actually produce');
  ok(!/Re-price at/.test(draw(globalThis.__RatioCheck, { check: { state: 'agree', computed: '1.24', priced: '1.24' } })),
    'C5c …and never offers it when the ratio agrees — there is nothing to re-price');
}

{
  // ⛔ AND THE BUTTON IS GREYED FOR THIS ONE THING ALONE. Every other shortfall is a box on the
  // panel, so greying would explain nothing the sentence does not; a ratio below the priced one is
  // not a box anybody can fill, it is a re-price. The SERVER refuses it either way — this only
  // stops an officer pressing something that cannot succeed.
  const blocked = draw(globalThis.__IssueFields, {
    issue: issueObj({ ratioCheck: () => ({ state: 'differs', computed: '1.18', priced: '1.24' }) }),
    gate: { ok: true, missing: [] }, onChanged: () => {}, busy: null, onIssue: () => {}, onCancel: () => {},
  });
  const before = blocked.split('Issue the term sheet')[0].slice(-300);
  ok(/\sdisabled=""/.test(before),
    'C6 a ratio below the priced one GREYS the issue button, even with every field filled');
  ok(/Re-price at the ratio/.test(blocked),
    'C6a …and the line beside it says the re-price is the way through');
}

console.log('\nD. the address box');
{
  const html = draw(globalThis.__AddressField, { value: '12 Oak St', onChange: () => {} });
  ok(html.includes('12 Oak St'), 'D1 it renders what is typed');
  ok(!html.includes('<ul'), 'D2 …and shows no suggestion list until there is one — no empty dropdown on first paint');
  const one = globalThis.__oneLineFrom;
  // ⛔ THE LABEL IS PASSED TOO, DELIBERATELY. Without it both orderings of the fallback return the
  // same string and the assertion proves nothing — the parts must be shown to BEAT a label, not
  // merely to be used when there is none. A suggestion label is written to be scanned in a list
  // (some providers put the county or the country in it); a term sheet needs the mailing address.
  ok(one({ line1: '12 Oak St', city: 'Lakewood', state: 'NJ', zip: '08701' },
    '12 Oak Street, Lakewood, Ocean County, New Jersey, 08701, United States')
    === '12 Oak St, Lakewood, NJ 08701',
  'D3 the one-line address is built from the PARTS and BEATS the picker\'s own label');
  ok(one(null, 'A label the provider wrote') === 'A label the provider wrote',
    'D4 …falling back to the label when there are no parts — something they recognise beats a blank box');
  ok(one({ line1: '12 Oak St' }) === '12 Oak St',
    'D5 …and a partial answer yields what it has, never an empty string with stray commas');
}

console.log('\nE. the two comparison documents, chosen by name');
{
  const W = globalThis.__COMPARISON_WORKFLOWS;
  ok(W.length === 2, 'E1 exactly two options — the owner asked for two, and a third would be a document nobody named');
  ok(W.map((w) => w.docKind).sort().join('|') === 'comparison|scenario_comparison',
    'E2 …and they are the two documents the SERVER already produces, not new ones');
  ok(!W.some((w) => w.docKind === 'term_sheet'),
    'E3 …with the term sheet deliberately absent: one option is the row\'s own button, not a comparison');
  const html = draw(globalThis.__ComparisonWorkflowPanel, {
    enabled: true, chosen: null, onChoose: () => {}, count: 0, docKind: null,
  });
  for (const w of W) ok(html.includes(w.title), `E4 the board offers "${w.title}"`);
  ok(html.includes('Nothing collected yet'),
    'E5 …and it renders with an empty cart — an entry point that appears only once you have started is not an entry point');
  ok(draw(globalThis.__ComparisonWorkflowPanel, { enabled: false, chosen: null, onChoose: () => {}, count: 0 }) === '',
    'E6 term sheets switched off draws nothing at all');
}

console.log('\nF. the intent is checked against what was actually collected');
{
  const m = globalThis.__workflowMismatch;
  ok(m(null, 'comparison') === null, 'F1 nothing chosen, nothing said');
  ok(m('prices', null) === null, 'F2 …and nothing said before the server has answered');
  ok(m('prices', 'comparison') === null, 'F3 a price comparison of one scenario agrees — silent');
  ok(m('scenarios', 'scenario_comparison') === null, 'F4 …and a comparison of deals agrees — silent');
  const a = m('prices', 'scenario_comparison');
  ok(typeof a === 'string' && /different scenarios/i.test(a),
    'F5 options priced on DIFFERENT scenarios are called out against a price comparison');
  const b = m('scenarios', 'comparison');
  ok(typeof b === 'string' && /same scenario/i.test(b),
    'F6 …and options priced on the SAME scenario are called out against a comparison of deals');
  const one = m('prices', 'term_sheet');
  ok(typeof one === 'string' && /term sheet/i.test(one),
    'F7 one option would be a TERM SHEET, and it says so rather than sitting silent');
  ok(/switch to/i.test(a) && /switch to/i.test(b),
    'F8 …and every warning names a way out — a warning with no remedy is a dead end');
  const warned = draw(globalThis.__ComparisonWorkflowPanel, {
    enabled: true, chosen: 'prices', onChoose: () => {}, count: 2, docKind: 'scenario_comparison',
  });
  ok(warned.includes('different scenarios'),
    'F9 …and the panel actually prints it, so the check is not one nobody sees');
}

console.log('\nG. the comparison strip asks for the same two names');
{
  // The strip is the OTHER place a sheet's parties are typed. It carried ONE box
  // labelled "Borrower or entity name", which is the muddle the owner's "and/or"
  // resolves — the two sign different lines, so one box put whichever was typed
  // onto whichever line the sheet happened to draw.
  const members = [{ id: 'm1', position: 0, label: 'Platinum', mode: 'borrowerPaid',
    program: { ratePct: 7.375, consumerLabel: 'Platinum' } }];
  const html = draw(globalThis.__ComparisonStrip, {
    open: true, cart: { anchor_position: 0 }, members, onChange: () => {},
    onIssued: () => {}, onPlan: () => {},
  });
  ok(html.includes('Vesting entity'), 'G1 the strip asks for the vesting entity on its own');
  ok(/Borrower(&#x27;|&#39;|’)s name/.test(html), 'G2 …and for the borrower\'s name on its own');
  ok(!html.includes('Borrower or entity name'), 'G3 …and the one-box muddle is gone');
  ok(html.includes('Either name is enough'), 'G4 …and it says either will do');
}

console.log('\nH. evening out a price — the control RENDERS on all three documents (§40)');
{
  /* ⛔ RENDERED, NOT COUNTED. A source guard can count `<PriceAdjuster` twice and be
     satisfied by a mount that can never draw — `{null && <PriceAdjuster …>}` leaves
     the literal in the file and renders nothing. That mutation was run and the
     count-based guard reported a pass, which is exactly why this section exists:
     only a render tells a mounted control from a dead one. */
  const single = draw(globalThis.__IssueFields, {
    issue: issueObj(), gate: null, onChanged: () => {}, busy: null,
    onIssue: () => {}, onCancel: () => {},
    mode: 'borrowerPaid', adjust: null, onAdjust: () => {},
  });
  ok(single.includes('Even out the price'),
    'H1 ⛔ the SINGLE term sheet offers it');

  const members = [{ id: 'm1', position: 0, label: 'Platinum', mode: 'borrowerPaid',
    program: { ratePct: 7.375, consumerLabel: 'Platinum', rawPrice: 103.1 } }];
  const strip = draw(globalThis.__ComparisonStrip, {
    open: true, cart: { anchor_position: 0 }, members, onChange: () => {},
    onIssued: () => {}, onPlan: () => {},
  });
  ok(strip.includes('Even out the price'),
    'H2 ⛔ …and so does every collected option, which is the other two documents');

  /* ⛔ RAW PRICING OFFERS NOTHING, because there is no compensation of ours to give
     away — the control returns null rather than a button that would only ever
     refuse. Asserted here rather than in the source, because "renders nothing" is
     precisely what a source count cannot see. */
  const raw = draw(globalThis.__IssueFields, {
    issue: issueObj(), gate: null, onChanged: () => {}, busy: null,
    onIssue: () => {}, onCancel: () => {},
    mode: 'raw', adjust: null, onAdjust: () => {},
  });
  ok(!raw.includes('Even out the price'),
    'H3 ⛔ raw pricing is offered nothing — there is nothing of ours in it to even out');

  /* And a form given no handler is byte-for-byte the form that shipped before §40,
     so nothing about the existing screens moved. */
  const before = draw(globalThis.__IssueFields, {
    issue: issueObj(), gate: null, onChanged: () => {}, busy: null,
    onIssue: () => {}, onCancel: () => {},
  });
  ok(!before.includes('Even out the price'),
    'H4 …and a caller that does not pass the handler renders exactly what it always did');

  /* An adjustment already made SAYS SO on the closed control. An officer who set one
     an hour ago and came back must be able to see it at a glance — a price that was
     evened out and looks exactly like one that was not is how a sheet goes out at a
     number nobody remembers choosing. (The explanation of whose money it comes out
     of lives inside the open panel, which `renderToString` cannot reach — it runs no
     state changes — so it is not asserted here.) */
  const set = draw(globalThis.__IssueFields, {
    issue: issueObj(), gate: null, onChanged: () => {}, busy: null,
    onIssue: () => {}, onCancel: () => {},
    mode: 'borrowerPaid', adjust: -0.1, onAdjust: () => {},
  });
  ok(/Price evened out by -0\.1/.test(set),
    'H5 an adjustment already made is visible without opening anything');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${failures === 0 ? `OFFLINE: all ${n} passed` : `OFFLINE: ${failures} of ${n} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
