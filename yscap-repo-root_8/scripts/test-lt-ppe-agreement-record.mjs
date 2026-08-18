#!/usr/bin/env node
/**
 * LT PPE — the agreement RECORD panel: it renders, and it never rounds a cap off to silence.
 *
 * WHAT IT IS FOR. The ≥200-scenario Lender Price agreement gate decides whether a rate sheet may be
 * published, and everything behind that verdict was already stored — which scenarios disagreed, where
 * in the price build-up they diverged, why each side declined when the two declined differently. None
 * of it was displayed: `ltApi.ppeRateSheetAgreement` had a route and no caller, so the only way to
 * read a run that costs real vendor calls was to query the database by hand. A publish refusal with no
 * evidence beside it is a dead end: "never measured" sends somebody to a button, "3 of 214 disagreed
 * on the cash-out LLPA" sends them to the cell that is wrong.
 *
 * WHAT IS ACTUALLY COVERED, stated exactly:
 *   · the component and its whole import graph BUNDLE, and the first paint renders without throwing
 *     (a green build proves neither — esbuild emits an undeclared identifier verbatim);
 *   · every branch of the pure helpers, called for real out of the bundle rather than re-implemented
 *     here: the verdict wording, the build-up stage, the scenario line, the points formatter;
 *   · the CAPS. `disagreementsOmitted` / `dimensionsOmitted` / `declineRowsOmitted` / `notStored` must
 *     each reach the screen, because a sample nobody is told is a sample reads as the whole story —
 *     the exact failure this workstream keeps finding;
 *   · the dark-text rule, and that the panel defines no second copy of a shared formatter;
 *   · that it is MOUNTED in the console, which is the whole point.
 *
 * THE LOADED STATES *ARE* RENDERED HERE, and that took a change to the component. `renderToString`
 * never runs an effect, so a component that fetches its own data can only be tested empty — and every
 * part worth guarding (the caps, the evidence, the override wording) lives in the loaded state. The
 * presentational half is therefore its own export (`AgreementRecordView`) which the suite hands a real
 * record. THE FIRST CUT ASSERTED ON THE SOURCE INSTEAD, and a mutation that replaced every cap's
 * condition with `false` — leaving the unreachable render line in place — passed all four assertions:
 * a guard that proves a NAME IS MENTIONED proves nothing about what a person sees.
 *
 * NOT covered: the fetch itself, and the toggle, which need a browser. `test-lt-ppe-console-db.js`
 * drives the real route end to end.
 *
 *   node scripts/test-lt-ppe-agreement-record.mjs
 *
 * LT-only. No database, no network.
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

// The panel calls `ltApi` inside an effect, which `renderToString` never runs — but the module is
// imported at load, so the graph still has to bundle. A never-settling stub keeps this about
// RENDERING rather than about the network.
const STUB_API = `
export const ltApi = new Proxy({}, { get: () => () => new Promise(() => {}) });
export default ltApi;
`;

const SRC = path.join(appv2, 'src/longterm/AgreementRecord.jsx');
const entry = `
import React from 'react';
import { renderToString } from 'react-dom/server';
import AgreementRecord, { AgreementRecordView, verdictOf, rungStage, scenarioLine, pts, whenOf } from ${JSON.stringify(SRC)};
globalThis.__React = React;
globalThis.__renderToString = renderToString;
globalThis.__Panel = AgreementRecord;
globalThis.__View = AgreementRecordView;
globalThis.__pure = { verdictOf, rungStage, scenarioLine, pts, whenOf };
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-agree-record-'));
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
    logLevel: 'silent', plugins: [stubPlugin], absWorkingDir: appv2,
  });
} catch (e) {
  ok(false, `the panel bundles at all: ${String(e && e.message).slice(0, 300)}`);
  console.log(`\n${failures} FAILED of ${n}`);
  process.exit(1);
}
ok(true, 'A0 the panel and everything it imports bundle');

require2(outfile);
const React = globalThis.__React;
const renderToString = globalThis.__renderToString;
const Panel = globalThis.__Panel;
const View = globalThis.__View;
const { verdictOf, rungStage, scenarioLine, pts, whenOf } = globalThis.__pure;

/**
 * The rendered HTML as the TEXT a person reads.
 *
 * React's server renderer splits `{a} literal {b}` into separate text nodes divided by `<!-- -->`
 * comment markers, so a regex over raw HTML fails on any sentence that interpolates a value — which
 * is every sentence worth asserting here. Matching the stripped text is what makes these assertions
 * about what a person SEES rather than about React's node boundaries.
 */
const text = (html) => String(html).replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

// ---- 1. the first paint ----------------------------------------------------------------------
{
  let html = null; let err = null;
  try { html = renderToString(React.createElement(Panel, { versionId: 'v1' })); } catch (e) { err = e; }
  ok(!err, `A1 the first paint renders without throwing${err ? `: ${err.message}` : ''}`);
  ok(typeof html === 'string' && text(html).includes('agreement record'),
    'A2 …and names itself, so the section is not an unlabelled blank');

  // With no version there is nothing to read about, and rendering an empty verdict beside a sheet
  // nobody has loaded would read as a finding about that sheet.
  let none = null;
  try { none = renderToString(React.createElement(Panel, { versionId: null })); } catch (e) { none = `THREW ${e.message}`; }
  ok(none === '', 'A3 with no rate-sheet version it renders NOTHING rather than an empty verdict');
}

// ---- 2. the verdict, every branch ---------------------------------------------------------------
{
  // Each reason sends the reader somewhere DIFFERENT, which is the whole reason they are not one
  // "not proven" line. Collapsing them is how "something else is broken" gets read as "press the
  // button", which is the wrong instruction on the one case that matters.
  const proven = verdictOf({ proven: true });
  ok(/agreed/i.test(proven.headline), 'A4 a proven sheet says the two engines agreed');

  const never = verdictOf({ proven: false, reason: 'never_measured' });
  ok(/never measured/i.test(never.headline) && /Measure against Lender Price/i.test(never.hint),
    'A5 never measured names the button that fixes it');

  const unread = verdictOf({ proven: false, reason: 'unreadable' });
  ok(/could not be read/i.test(unread.headline) && !/never measured/i.test(unread.headline),
    'A6 UNREADABLE is not reported as "never measured" — one means something else is broken');

  const over = verdictOf({ proven: false, reason: 'overridden' });
  ok(/override/i.test(over.headline) && /proves nothing/i.test(over.hint),
    'A7 an override is shown as a decision, never as a measurement');

  ok(verdictOf(null).headline && !/agreed/i.test(verdictOf(null).headline),
    'A8 with nothing read yet it never claims agreement');

  const odd = verdictOf({ proven: false, reason: 'something_new', message: 'A reason from the future.' });
  ok(odd.headline === 'A reason from the future.',
    'A9 an unrecognised reason shows the SERVER\'s own message rather than a guess');
}

// ---- 3. WHERE the build-up diverged — the half the itemized list cannot say ----------------------
{
  // A base-grid or margin difference itemizes as NO dimension rows at all, so a reader holding only
  // the cell list would hunt for a wrong cell that does not exist.
  ok(rungStage({ baseDeltaMilli: 0, adjustmentTotalDeltaMilli: 0, marginDeltaMilli: 0, finalDeltaMilli: 0 }) === null,
    'A10 a rung whose every stage agrees names no stage — never a confident "diverges at the base grid"');
  ok(rungStage(null) === null, 'A11 …and neither does a rung the record did not keep');

  const base = rungStage({ baseDeltaMilli: -250, adjustmentTotalDeltaMilli: -250, finalDeltaMilli: -250 });
  ok(base && base.name === 'base grid',
    'A12 THE ONE THAT MATTERS: the EARLIEST diverging stage is named — a base-grid gap explains every '
    + 'number downstream, so naming the final price would send a reader to the wrong place');

  const marg = rungStage({ baseDeltaMilli: 0, adjustmentTotalDeltaMilli: 0, marginDeltaMilli: 125, finalDeltaMilli: 125 });
  ok(marg && marg.name === 'margin', 'A13 …and a margin-only difference is named as the margin');
}

// ---- 4. the scenario line, and the two directions --------------------------------------------
{
  const line = scenarioLine({
    scenario: { purpose: 'Refinance', state: 'NJ', fico: 720, ltv: 70 },
    ourEligible: true, lpEligible: false,
  });
  ok(/Refinance/.test(line) && /NJ/.test(line) && /FICO 720/.test(line),
    'A14 the disagreeing scenario is named by what it IS, not by a row id');
  ok(/we priced it/.test(line) && /they declined it/.test(line),
    'A15 …and which way it went — the dangerous direction is the one worth seeing first');
  ok(/did not name/.test(scenarioLine({})),
    'A16 a scenario the record did not keep says so rather than rendering an empty heading');
}

// ---- 5. the points formatter -------------------------------------------------------------------
{
  ok(pts(250) === '+0.25 pts', 'A17 a milli-point delta prints as points, signed');
  ok(pts(-1000) === '-1 pts', 'A18 …in both directions');
  ok(pts(null) === '—' && pts('nonsense') === '—',
    'A19 an absent delta is a dash — never 0, which would read as "they agreed"');
  ok(whenOf(0) === 'an unrecorded time' && whenOf(null) === 'an unrecorded time',
    'A20 a missing timestamp says so rather than printing the epoch');
}

// ---- 6. THE CAPS — RENDERED, not merely mentioned ------------------------------------------------
{
  // ASSERTED ON THE HTML, deliberately. The first cut of this section tested that the identifier
  // APPEARED IN THE SOURCE, and a mutation that replaced every cap's condition with `false` — leaving
  // the now-unreachable render line in place — passed all four assertions. A guard that proves a name
  // is mentioned proves nothing about what a person sees. This is why the view was split out: an
  // effect never runs under renderToString, so the loaded state can only be reached by handing the
  // presentational half a record.
  const RECORD = {
    proven: false,
    reason: 'disagreed',
    message: 'Measured, and the two engines did not agree.',
    minComparableScenarios: 200,
    note: 'An agreement run is recorded by the harness, never typed in here.',
    history: [{
      id: 1, kind: 'run', recordedAt: 1755000000000, recordedBy: 'a.person@example.com',
      scenarios: 214, comparable: 210, agreed: 207, disagreed: 3, errors: 0,
      summary: {
        agreementRate: 0.9857,
        notStored: 'The per-coupon digest is not stored on this record.',
        disagreementsOmitted: 7,
        disagreements: [{
          scenario: { purpose: 'Cash-out', state: 'NJ', fico: 700, ltv: 65 },
          ourEligible: true, lpEligible: true,
          worstDeltaMilli: 375,
          categories: ['llpa'],
          dimensions: [{ rate: 7.5, dimension: 'cash_out', status: 'llpa_mismatch', deltaMilli: 375 }],
          dimensionsOmitted: 4,
          boundsFailed: [],
          worstRung: { baseDeltaMilli: 0, adjustmentTotalDeltaMilli: 375, marginDeltaMilli: 0, finalDeltaMilli: 375 },
          declineVerdict: null, declineMismatch: [], declineRowsOmitted: 2,
        }],
      },
    }],
  };
  let html = '';
  let err = null;
  try {
    html = renderToString(React.createElement(View, { data: RECORD, error: '', open: true, onToggle: () => {} }));
  } catch (e) { err = e; }
  ok(!err, `A21 the LOADED state renders${err ? `: ${err.message}` : ''}`);

  ok(/7 further disagreeing scenario/.test(text(html)),
    'A22 the omitted-SCENARIO count is on the screen — the sample is 1 of 8, and a reader told only '
    + 'about the 1 reads it as the whole story');
  ok(/4 further dimension/.test(text(html)), 'A23 …the omitted per-scenario dimensions too');
  ok(/2 further decline row/.test(text(html)), 'A24 …and the omitted decline rows');
  ok(text(html).includes('The per-coupon digest is not stored on this record.'),
    'A25 THE SHARP ONE: the record\'s OWN statement of what it does not hold is printed — without it '
    + 'nobody can know a fuller digest ever existed');
  ok(/at least 200 comparable scenarios/.test(text(html)),
    'A26 the gate\'s threshold is a number on the screen, not a mood');

  // The evidence itself, which is the whole reason the panel exists.
  ok(/Cash-out/.test(text(html)) && /FICO 700/.test(text(html)),
    'A27 the disagreeing scenario is named');
  ok(/cash_out/.test(text(html)) && /\+0\.375 pts/.test(text(html)),
    'A28 …with the dimension and the gap that make it actionable');
  ok(/adjustment stack/.test(text(html)),
    'A29 …and WHERE in the build-up it diverged');
  ok(/98\.6%/.test(text(html)), 'A30 the agreement rate is printed through the shared formatter');

  // An OVERRIDE must never render as a measurement.
  const OVER = { proven: false, reason: 'overridden', message: 'x', history: [{ id: 2, kind: 'override', recordedAt: 1755000000000, reason: 'onboarding', scenarios: 0, comparable: 0, agreed: 0, disagreed: 0, errors: 0, summary: null }] };
  const oh = renderToString(React.createElement(View, { data: OVER, error: '', open: false, onToggle: () => {} }));
  ok(/an override/.test(text(oh)) && /records a decision, not a measurement/.test(text(oh)),
    'A31 an override is rendered as a decision, never as a run that measured something');
  ok(!/scenarios/.test(text(oh).split('override')[1] || ''),
    'A32 …and carries no scenario counts, which it does not have');

  // A read failure is SAID.
  const eh = renderToString(React.createElement(View, { data: null, error: 'the ledger is unreadable', open: false, onToggle: () => {} }));
  ok(/the ledger is unreadable/.test(text(eh)),
    'A33 a read failure is shown — rendering nothing would look exactly like "never measured"');
}

// ---- 7. it defines no second formatter, and its text is dark ------------------------------------
{
  const src = fs.readFileSync(SRC, 'utf8');
  ok(/from '\.\/format\.js'/.test(src),
    'A34 the agreement RATE comes from the shared formatter — a second copy is how one screen prints '
    + '0.97% where another prints 97%');
  ok(!/(const|function)\s+rate\s*[=(]/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')),
    'A35 …and it defines none of its own (the same rule test-lt-pipeline-columns-pure enforces)');
  ok(!/var\(--ink/.test(src),
    'A36 no `--ink*` token is used as a text colour — every one of them is a LIGHT paper colour here');
}

// ---- 8. it is MOUNTED — a panel nothing renders is the same defect one layer up ------------------
{
  const console_ = fs.readFileSync(path.join(appv2, 'src/longterm/RateSheetConsole.jsx'), 'utf8');
  ok(/import AgreementRecord from '\.\/AgreementRecord\.jsx'/.test(console_),
    'A37 the console imports the panel');
  ok(/<AgreementRecord\s/.test(console_), 'A38 …and mounts it');
  ok(/<AgreementRecord[^>]*reloadKey/.test(console_),
    'A39 …with a reload key, so it cannot sit on a verdict the measurement above just replaced');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${failures ? `${failures} FAILED of ${n}` : `all ${n} passed`}`);
process.exit(failures ? 1 : 0);
