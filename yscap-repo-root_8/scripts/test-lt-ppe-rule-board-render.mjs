#!/usr/bin/env node
/**
 * LT PPE — the RULE BOARD renders, and it renders the RIGHT SENTENCES.
 *
 * ⛔ THIS ASSERTS RENDERED TEXT, NOT SOURCE, AND THAT IS THE WHOLE POINT. A guard that proves a NAME
 * IS MENTIONED proves nothing: `{false && <Thing/>}` still contains "Thing", and a source grep for
 * `ppeRules(` is satisfied by the api client's own comment. So every assertion below runs
 * `renderToString` over the board's PRESENTATIONAL half with real payloads and reads the TEXT a
 * person would see — which means a mutation replacing every render condition with `false` empties the
 * page and takes every assertion with it. Each one was proven to fail that way, for the right reason.
 *
 * TWO MECHANICAL FACTS THIS SUITE IS SHAPED AROUND:
 *
 *   · `renderToString` NEVER RUNS `useEffect`, so a component that fetches its own data can only ever
 *     be tested EMPTY. That is why `RuleBoard.jsx` is split: `RuleBoardView` takes everything it
 *     draws, so the LOADED states are renderable. The container is still checked — it BUNDLES, it
 *     renders its first paint without throwing, and it is MOUNTED on the screen.
 *
 *   · SSR SPLITS AN INTERPOLATED SENTENCE with `<!-- -->` markers, so `{n} rules in force.` comes out
 *     as `3<!-- --> rules in force.` and a plain substring match on the sentence FAILS. Every
 *     assertion runs against `stripHtml()`, which drops the markers and the tags and normalizes
 *     whitespace — so what is asserted is the sentence a human reads.
 *
 * WHAT IS NOT COVERED HERE: the fetching, the refusals coming back from the server, and the admin
 * gate. Those are HTTP facts and are proven end to end over a real server and a real Postgres by
 * `scripts/test-lt-ppe-rule-drafts-db.js`.
 *
 *   node scripts/test-lt-ppe-rule-board-render.mjs
 *
 * LT-only.
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

/**
 * The TEXT a person reads. SSR emits `<!-- -->` between an interpolation and its neighbouring
 * literal, so a sentence assembled from both is broken up in the raw markup; the tags and the
 * markers come out and the whitespace is normalized, leaving exactly what is on screen.
 */
const stripHtml = (html) => String(html || '')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/\s+/g, ' ')
  .trim();

const esbuild = require2('esbuild');

// The api module is stubbed: this suite is about RENDERING, and a real fetch would make it about the
// network instead. Every method answers a promise that never settles, which is what the first paint
// of the container legitimately sees.
const STUB_API = `
export const ltApi = new Proxy({}, { get: () => () => new Promise(() => {}) });
export default ltApi;
`;

const entry = `
import React from 'react';
import { renderToString } from 'react-dom/server';
import RuleBoard, { RuleBoardView, scopeTextOf } from ${JSON.stringify(path.join(appv2, 'src/longterm/RuleBoard.jsx'))};
globalThis.__React = React;
globalThis.__renderToString = renderToString;
globalThis.__RuleBoard = RuleBoard;
globalThis.__RuleBoardView = RuleBoardView;
globalThis.__scopeTextOf = scopeTextOf;
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-rule-board-'));
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

try {
  await esbuild.build({
    stdin: { contents: entry, resolveDir: appv2, loader: 'jsx' },
    bundle: true, outfile, platform: 'node', format: 'cjs', jsx: 'automatic',
    logLevel: 'silent', plugins: [stubPlugin],
    absWorkingDir: appv2,
  });
} catch (e) {
  ok(false, `the rule board bundles at all: ${String(e && e.message).slice(0, 300)}`);
  console.log(`\n${failures} FAILED of ${n}`);
  process.exit(1);
}
ok(true, 'R0 the rule board and everything it imports bundle');

require2(outfile);
const React = globalThis.__React;
const renderToString = globalThis.__renderToString;
const RuleBoard = globalThis.__RuleBoard;
const RuleBoardView = globalThis.__RuleBoardView;
const scopeTextOf = globalThis.__scopeTextOf;

// ---------------------------------------------------------------------------
// 1. the container's first paint — the state before any fetch resolves
// ---------------------------------------------------------------------------
{
  let html = null; let err = null;
  try { html = renderToString(React.createElement(RuleBoard)); } catch (e) { err = e; }
  ok(err === null, `R1 the first paint renders without throwing${err ? ` — ${err.message}` : ''}`);
  const text = stripHtml(html);
  ok(/Rules in force/.test(text), 'R2 …with the rules card');
  ok(/Rule drafts/.test(text), 'R3 …and the drafts card');
  // Even with NOTHING loaded, the one thing this screen must never leave unsaid is said.
  ok(/A draft is not in force\./.test(text),
    'R4 …and it says a draft is not in force before a single fetch has resolved');
}

// ---------------------------------------------------------------------------
// 2. THE LOADED PAGE — every payload the five reachable routes answer with
// ---------------------------------------------------------------------------
const loaded = {
  rules: [
    { id: 1, code: 'house_llpa', kind: 'pricing', source: 'overlay', investor_id: null, program_id: null, description: 'A house LLPA' },
    { id: 2, code: 'inv_decline', kind: 'eligibility', source: 'base', investor_id: 'INV-1', program_id: null, decline_reason: 'FICO under 660' },
    { id: 3, code: 'prg_bound', kind: 'bound', source: 'overlay', investor_id: 'INV-1', program_id: 'PRG-1' },
  ],
  names: { programs: { 'PRG-1': 'Deephaven DSCR 30yr' }, investors: { 'INV-1': 'Deephaven' } },
  coverage: {
    overlaps: [{ detail: 'llpa_a and llpa_b both charge on the fico dimension across fico [640, 660) — a loan in there is adjusted twice.' }],
    gaps: [{ detail: 'nothing charges on the ltv dimension across ltv [70%, 75%), while rules on either side of it do.' }],
    analyzed: { pricingRules: 9, banded: 4, gapsSkippedOn: ['dscr', 'ltv'] },
  },
  programs: { programs: [{ id: 'PRG-1', code: 'DSCR30', name: 'Deephaven DSCR 30yr', investorId: 'INV-1', investorName: 'Deephaven' }] },
  mine: { ok: true, saved: 3, suggestionCount: 7, investorCount: 2, unmappedCount: 4 },
  diff: {
    against: { id: 'v1', versionNo: 1 },
    changed: [{ key: 'a' }, { key: 'b' }],
    added: [{ key: 'c' }],
    removed: [],
    unchanged: 41,
    needsReading: [{ key: 'a' }],
    ordinary: [{ key: 'b' }],
  },
  lpScope: { describe: 'Lender Price programs whose name matches "Deephaven DSCR"', setBy: 'admin@ys', note: null },
  drafts: [
    { id: 11, code: 'llpa_fico_640', kind: 'pricing', status: 'draft', note: 'from the rule board' },
    { id: 12, code: 'llpa_old', kind: 'pricing', status: 'discarded', note: null },
  ],
  catalog: { intents: [{ op: 'add_llpa', label: 'add an LLPA' }, { op: 'add_eligibility', label: 'add an eligibility rule' }] },
  openDraft: { id: 11, code: 'llpa_fico_640', createdBy: 'author@ys', status: 'draft' },
  rendered: {
    render: {
      headline: 'When FICO score is from 640 up to (but not including) 660, add 0.250 points.',
      liveNote: 'This is a draft. It prices nothing and declines nobody until somebody publishes it.',
    },
    warnings: [{ message: 'A partial overlap with llpa_wide was found on the fico dimension.' }],
    blockedBy: [],
    publishNote: 'Publishing a pricing rule has no door on this server, because who may do it has not been decided.',
  },
  draftOp: 'add_llpa',
  draftRefusals: [{ message: 'There is already a rule called "llpa_fico_640" here.' }],
  draftWarnings: [{ message: 'This structure already carries a holdback of 0.125 from the prepayment library.' }],
};

let full = null;
{
  let err = null;
  try { full = stripHtml(renderToString(React.createElement(RuleBoardView, loaded))); } catch (e) { err = e; }
  ok(err === null, `R5 the LOADED board renders without throwing${err ? ` — ${err.message}` : ''}`);
}

// ---- the rules in force, WITH their scope ---------------------------------
ok(/3 rules in force\./.test(full), 'R6 the rules card states how many rules are in force');
ok(/House rule — applies to every investor/.test(full),
  'R7 …and a rule that reaches every investor SAYS SO on screen');
ok(/This investor only — Deephaven/.test(full),
  'R8 …an investor-scoped rule names the investor it is narrowed to');
ok(/This program only — Deephaven DSCR 30yr/.test(full),
  'R9 …and a program-scoped rule names the program');
ok(/house_llpa/.test(full) && /inv_decline/.test(full) && /prg_bound/.test(full),
  'R10 …every rule is listed, not only the first');
ok(/Declines with: FICO under 660/.test(full),
  'R11 …and an eligibility rule states the reason a borrower would be given');

// ---- the coverage read ----------------------------------------------------
ok(/4 of 9 pricing rules could be read as a band\./.test(full),
  'R12 the coverage card states how many rules it could actually READ — a clean report over 1 of 9 means nothing');
ok(/both charge on the fico dimension across fico \[640, 660\)/.test(full),
  'R13 …an overlap is stated in the server\'s own words (a loan adjusted twice)');
ok(/nothing charges on the ltv dimension across ltv \[70%, 75%\)/.test(full),
  'R14 …and a hole between banded rules is stated too');
ok(/Holes were not looked for on dscr, ltv/.test(full),
  'R15 …and where holes were NOT looked for is SAID, so an empty list is not read as a clean bill of health');

// ---- the miner: a button, and its cost said out loud ----------------------
ok(/Mine suggestions \(costs a Lender Price call\)/.test(full),
  'R16 the miner is a BUTTON whose label carries its cost');
ok(/It costs a live Lender Price call, so it only runs when this button is pressed\./.test(full),
  'R17 …and the card says plainly that it never runs on its own');
ok(/Saved 3 proposals out of 7 mined, across 2 investors\./.test(full),
  'R18 …a completed mining run reports what it saved, not just that it ran');
ok(/4 of their declines could not be mapped onto anything we price/.test(full),
  'R19 …and what it could NOT map is reported rather than silently dropped');

// ---- the rate-sheet version diff -----------------------------------------
ok(/2 cells moved, 1 added, 0 removed, 41 unchanged\./.test(full),
  'R20 the diff states every count — including the UNCHANGED one, so a clean diff is not an empty read');
ok(/1 of those need reading .* and 1 are ordinary numeric refreshes/.test(full),
  'R21 …split into what needs reading and what is an ordinary refresh');
ok(/Nothing here was applied, published or accepted\./.test(full),
  'R22 …and it says out loud that it decided nothing');

// ---- a program's stored Lender Price scope --------------------------------
ok(/Stored scope: Lender Price programs whose name matches "Deephaven DSCR"/.test(full),
  'R23 the scope card shows what the SERVER holds, in the server\'s own words');
ok(/Set by admin@ys\./.test(full), 'R24 …and who set it');

// ---- the drafts -----------------------------------------------------------
ok(/A draft is not in force\. It prices nothing and declines nobody, whatever it says\./.test(full),
  'R25 THE ONE THAT MATTERS: the drafts card leads with "a draft is not in force"');
ok(/There is no publish button on this screen and no publish route on the server\./.test(full),
  'R26 …and says there is no publish door, rather than leaving a person hunting for a missing button');
ok(/who is allowed to do that has not been decided yet/.test(full),
  'R27 …naming the open owner question as the reason');
ok(/llpa_fico_640/.test(full) && /llpa_old/.test(full), 'R28 every draft is listed');
ok(/draft — not in force/.test(full) && /discarded — not in force/.test(full),
  'R29 …and EVERY draft row repeats that it is not in force — saying it once at the top is saying it where it scrolls away');
ok(/add an LLPA/.test(full) && /add an eligibility rule/.test(full),
  'R30 the create form offers the SERVER\'s authoring vocabulary, not a list typed into the screen');
ok(/There is already a rule called "llpa_fico_640" here\./.test(full),
  'R31 a refusal from the server is shown in the server\'s own words');
ok(/already carries a holdback of 0\.125 from the prepayment library/.test(full),
  'R32 …and a warning that is not a refusal is shown too, separately');
ok(/drafted by author@ys, status draft\. It is not in force\./.test(full),
  'R33 opening a draft shows what the table holds — and says again that it is not in force');
ok(/When FICO score is from 640 up to \(but not including\) 660, add 0\.250 points\./.test(full),
  'R34 checking a draft renders the rule IN WORDS');
ok(/This is a draft\. It prices nothing and declines nobody until somebody publishes it\./.test(full),
  'R35 …carrying the service\'s own live-note verbatim');
ok(/A partial overlap with llpa_wide was found on the fico dimension\./.test(full),
  'R36 …and the findings re-computed against the rules in force right now');
ok(/Publishing a pricing rule has no door on this server/.test(full),
  'R37 …and the server\'s own note that there is nothing to publish with');

// ---------------------------------------------------------------------------
// 3. the states that must NOT read as good news
// ---------------------------------------------------------------------------
{
  const failed = stripHtml(renderToString(React.createElement(RuleBoardView, {
    rulesError: 'Could not read the rules in force.',
    coverageError: 'Could not read the rule coverage.',
    draftsError: 'Could not read the drafts.',
  })));
  ok(/Could not read the rules in force\./.test(failed),
    'R38 a FAILED read is SAID — an empty list would read as "our engine enforces nothing"');
  ok(!/No rules are in force/.test(failed),
    'R39 …and the empty-state sentence is NOT drawn on top of a failure');
  ok(/Could not read the rule coverage\./.test(failed) && /Could not read the drafts\./.test(failed),
    'R40 …each card reports its own failure rather than one swallowing the others');
}
{
  const empty = stripHtml(renderToString(React.createElement(RuleBoardView, {
    rules: [], coverage: { overlaps: [], gaps: [], analyzed: { pricingRules: 0, banded: 0, gapsSkippedOn: [] } }, drafts: [],
  })));
  ok(/No rules are in force\./.test(empty),
    'R41 a genuinely empty rule set says so, and says our engine prices from the sheet alone');
  ok(/No overlap and no hole was found in what could be read\./.test(empty),
    'R42 …a clean coverage report is worded as "in what could be read", never as an unqualified all-clear');
  ok(/Nobody is drafting a rule right now\./.test(empty), 'R43 …and an empty draft list says so');
  ok(/A draft is not in force\./.test(empty),
    'R44 …while the not-in-force statement stands even with no drafts on screen');
}

// ---------------------------------------------------------------------------
// 4. the scope wording is DERIVED, and falls back to the id rather than lying
// ---------------------------------------------------------------------------
{
  ok(scopeTextOf({ investor_id: null, program_id: null }) === 'House rule — applies to every investor',
    'R45 a rule with no investor and no program is a HOUSE rule');
  ok(scopeTextOf({ investor_id: 'X', program_id: null }, {}) === 'This investor only — X',
    'R46 …an unnamed investor falls back to its id rather than reading as a house rule');
  ok(scopeTextOf({ investor_id: 'X', program_id: 'Y' }, {}) === 'This program only — Y',
    'R47 …and a program-scoped rule is never described as investor-wide');
}

// ---------------------------------------------------------------------------
// 5. the dark-text rule, and no browser dialogs
// ---------------------------------------------------------------------------
{
  const src = fs.readFileSync(path.join(appv2, 'src/longterm/RuleBoard.jsx'), 'utf8');
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(!/color:\s*['"`]?var\(--ink/.test(stripped),
    'R48 the board never uses a --ink* token as a text colour (they are LIGHT paper colours — white on white)');
  ok(!/\bwindow\.(alert|confirm|prompt)\s*\(/.test(stripped) && !/(^|[^.\w])(alert|confirm|prompt)\s*\(/.test(stripped),
    'R49 …and raises no browser dialog — refusals are shown inline beside the control that was refused');
  // ⛔ THE PUBLISH CONTROL — the one thing on this screen that changes what a borrower is quoted.
  // This assertion used to say the screen had NO publish call at all, which was right while the
  // authority was an open owner question and is wrong now that it is answered (§2.57). It asserts the
  // ANSWER instead of the old absence, and it asserts the three properties that make the control safe.
  ok(/ppePublishRuleDraft/.test(stripped),
    'R50 the screen reaches the publish door — a rule can be put in force by a person, not only by a script');
  ok(/publishArmedId/.test(stripped) && /Press again to publish it/.test(stripped),
    'R50b …and it ARMS FIRST: the first press only states what the second one does');
  ok(/String\(publishArmedId\) !== String\(d\.id\)/.test(stripped),
    'R50c …armed per DRAFT, never a single boolean — arming one row must not arm the button on every other row');
  ok(!/role\s*===\s*['"`]super_admin|isSuperAdmin/.test(stripped),
    'R50d …and the button is never hidden by role: this screen cannot know the role, and the server\'s 403 names who may');
}

// ---------------------------------------------------------------------------
// 6. the board is actually MOUNTED — a component nothing renders is the same
//    defect one layer up
// ---------------------------------------------------------------------------
{
  const screen = fs.readFileSync(path.join(appv2, 'src/longterm/LtPpe.jsx'), 'utf8');
  ok(/import RuleBoard from '\.\/RuleBoard\.jsx'/.test(screen), 'R51 LtPpe imports the rule board');
  // The composed form, on its own line: `{false && <RuleBoard />}` matches a bare tag and renders
  // nothing, which is the very defect this assertion exists to catch.
  ok(/^\s*<RuleBoard\s*\/>\s*$/m.test(screen),
    'R52 …and MOUNTS it UNCONDITIONALLY — a guarded mount renders nothing and the routes stay unreachable');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${failures ? `${failures} FAILED of ${n}` : `all ${n} passed`}`);
process.exit(failures ? 1 : 0);
