#!/usr/bin/env node
/**
 * LT PPE — the CANARY console: it renders, it states the cost before it spends it, and it never
 * reports an agreement rate without saying what could not be compared.
 *
 * WHAT IT IS FOR. `POST /api/lt/ppe/canary` is the ONLY producer of the findings ledger and the
 * per-band parity series, and it had no caller anywhere in the product — so the two screens that
 * read those records could only ever show what a hand-run `curl` had put there, and an empty
 * differences queue was indistinguishable from two engines that agree. The three schedule routes
 * were the same one layer up: a cadence could be stored and read by curl and by nothing else.
 *
 * WHAT IS ACTUALLY COVERED, stated exactly:
 *   · the console and its whole import graph BUNDLE, and the first paint renders without throwing
 *     (a green Vite build proves neither — esbuild emits an undeclared identifier verbatim and it
 *     throws at render);
 *   · every branch of the pure helpers, called for real out of the bundle rather than re-implemented
 *     here: the schedule's delete key, the battery count, the cadence in words, what could not be
 *     compared, and where the three durable records went;
 *   · THE COST. A canary is one live Lender Price call per scenario. The first paint must SAY so and
 *     must offer no control that fires one, and the arming panel must state the number of calls in
 *     the sentence a person reads before pressing;
 *   · WHAT IT COULD NOT COMPARE. The agreement rate is measured over comparable scenarios only, so a
 *     battery of 200 that compared 4 reports the agreement of those 4 — the incomparable count, the
 *     engine failures and the overlay abstentions are rendered, with the reason;
 *   · THE THREE PERSISTS, which fail independently: "measured but not stored" must never read as
 *     "measured";
 *   · the schedule list: the row's own verdict in the SERVER's wording, and the recorded defect —
 *     nothing ticks a saved schedule — said on the page rather than left for somebody to discover
 *     from a quiet scoreboard;
 *   · the dark-text rule, no browser dialog, no hand-written /api/lt URL, and that the console is
 *     MOUNTED on the PPE screen, which is the whole point.
 *
 * THE LOADED STATES *ARE* RENDERED HERE. `renderToString` never runs an effect and never presses a
 * button, so a component that fetches its own data can only be tested empty — and every part worth
 * guarding lives in the loaded state. The presentational halves are therefore their own exports
 * (`CanaryRunView`, `CanaryScheduleView`, `ArmPanel`) which this suite hands real data. ASSERTIONS
 * ARE ON THE RENDERED TEXT, never on the source: a guard that proves a NAME IS MENTIONED survives a
 * mutation that replaces every render condition with `false`, and therefore proves nothing about
 * what a person sees.
 *
 * NOT covered: the fetches, the button presses and the two-step arming transition, which need a
 * browser. The route itself is exercised by the LT PPE route suites.
 *
 *   node scripts/test-lt-ppe-canary-console.mjs
 *
 * LT-only. No database, no network, no vendor call.
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

// The console calls `ltApi` inside effects, which `renderToString` never runs — but the module is
// imported at load, so the graph still has to bundle. A never-settling stub keeps this about
// RENDERING rather than about the network, and records every call so the suite can prove the first
// paint asks the vendor for nothing.
const STUB_API = `
globalThis.__ltCalls = [];
const handler = { get: (_t, name) => (...args) => { globalThis.__ltCalls.push({ name, args }); return new Promise(() => {}); } };
export const ltApi = new Proxy({}, handler);
export default ltApi;
`;

const SRC = path.join(appv2, 'src/longterm/CanaryConsole.jsx');
const entry = `
import React from 'react';
import { renderToString } from 'react-dom/server';
import CanaryConsole, {
  CanaryRunView, CanaryScheduleView, ArmPanel,
  scheduleTarget, batteryCount, cadence, unmeasuredLines, persistLines,
} from ${JSON.stringify(SRC)};
globalThis.__React = React;
globalThis.__renderToString = renderToString;
globalThis.__Console = CanaryConsole;
globalThis.__RunView = CanaryRunView;
globalThis.__SchedView = CanaryScheduleView;
globalThis.__ArmPanel = ArmPanel;
globalThis.__pure = { scheduleTarget, batteryCount, cadence, unmeasuredLines, persistLines };
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-canary-console-'));
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

console.log('LT PPE canary console — it renders, and it says what it costs');

try {
  await esbuild.build({
    stdin: { contents: entry, resolveDir: appv2, loader: 'jsx' },
    bundle: true, outfile, platform: 'node', format: 'cjs', jsx: 'automatic',
    logLevel: 'silent', plugins: [stubPlugin], absWorkingDir: appv2,
  });
} catch (e) {
  ok(false, `C0 the console bundles at all: ${String(e && e.message).slice(0, 300)}`);
  console.log(`\n${failures} FAILED of ${n}`);
  process.exit(1);
}
ok(true, 'C0 the console and everything it imports bundle');

require2(outfile);
const React = globalThis.__React;
const renderToString = globalThis.__renderToString;
const Console = globalThis.__Console;
const RunView = globalThis.__RunView;
const SchedView = globalThis.__SchedView;
const ArmPanel = globalThis.__ArmPanel;
const { scheduleTarget, batteryCount, cadence, unmeasuredLines, persistLines } = globalThis.__pure;

/**
 * The rendered HTML as the TEXT a person reads.
 *
 * React's server renderer splits `{a} literal {b}` into separate text nodes divided by `<!-- -->`
 * comment markers, so a regex over raw HTML fails on any sentence that interpolates a value — which
 * is every sentence worth asserting here. Matching the stripped text is what makes these assertions
 * about what a person SEES rather than about React's node boundaries.
 */
const text = (html) => String(html).replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Render, and turn a THROW into text an assertion can read.
 *
 * A component that throws takes the whole suite down with it, and a suite that dies is red for the
 * wrong reason — it looks exactly like proof while proving nothing about the assertion underneath.
 * Every render here goes through this, so a broken component FAILS the assertion about what a
 * person sees rather than ending the run.
 */
const safeText = (el) => { try { return text(renderToString(el)); } catch (e) { return `THREW ${e && e.message}`; } };

// ---- 1. the first paint, and the cost it must lead with -----------------------------------------
{
  globalThis.__ltCalls.length = 0;
  let html = null; let err = null;
  try { html = renderToString(React.createElement(Console, { investors: [{ id: 'i1', code: 'DH', name: 'Deephaven' }] })); }
  catch (e) { err = e; }
  ok(!err, `C1 the first paint renders without throwing${err ? `: ${err.message}` : ''}`);

  const t = text(html || '');
  ok(/Every scenario is one live Lender Price call, billed/.test(t),
    'C2 THE COST IS ON THE SCREEN BEFORE ANYTHING IS PRESSED — a canary spends real money per '
    + 'scenario, and a screen that only mentioned it after the fact would be telling somebody what '
    + 'they had already bought');
  ok(/Nothing on this page runs a canary on its own/.test(t),
    'C3 …and it says the page fires nothing by itself, which is the promise the next assertion checks');
  ok(globalThis.__ltCalls.every((c) => c.name !== 'ppeCanary'),
    'C4 the first paint calls the vendor route ZERO times');
  ok(/Count this battery/.test(t),
    'C5 the only control offered on the first paint is the free one — the count, not the run');
  ok(!/Call Lender Price now/.test(t),
    'C6 …and the button that spends money is NOT on the page until a person has armed it');

  // With no investors it must still render — a console that needs a list it has not been given is a
  // blank screen on exactly the day somebody first opens it.
  let bare = null;
  try { bare = renderToString(React.createElement(Console, {})); } catch (e) { bare = `THREW ${e.message}`; }
  ok(typeof bare === 'string' && bare.includes('Run a canary'),
    'C7 it renders with no investor list at all rather than throwing on one');
}

// ---- 2. the arming step — the sentence a person reads before spending ----------------------------
{
  const t = safeText(React.createElement(ArmPanel, { count: 240, busy: false, onFire: () => {}, onCancel: () => {} }));
  ok(/This will make 240 live Lender Price calls right now/.test(t),
    'C8 THE ONE THAT MATTERS: the arming step states the NUMBER of live vendor calls, in a sentence, '
    + 'before the run — "this costs money" without a number is not a decision anybody can make');
  ok(/Nothing has been sent yet/.test(t),
    'C9 …and says nothing has been sent, so the panel is a question rather than a receipt');
  ok(/Call Lender Price now — 240 scenarios/.test(t),
    'C10 …and the button itself carries the count, so the last thing read before the press is the bill');
  const one = safeText(React.createElement(ArmPanel, { count: 1, busy: false, onFire: () => {}, onCancel: () => {} }));
  ok(/1 live Lender Price call right now/.test(one) && !/1 live Lender Price calls/.test(one),
    'C11 a battery of one reads as one call — a plural on a single-scenario run reads as a typo, and '
    + 'a screen that cannot count is not believed about the number that matters');
}

// ---- 3. the pure helpers, every branch ----------------------------------------------------------
{
  ok(scheduleTarget(null) === '-' && scheduleTarget('') === '-' && scheduleTarget('   ') === '-',
    'C12 the company-wide schedule addresses as "-" — an empty path segment is a different route '
    + 'altogether, so without this the one schedule with no investor could never be removed');
  ok(scheduleTarget('DEEPHAVEN') === 'DEEPHAVEN', 'C13 …and a named investor addresses as itself');

  const m = batteryCount('matrix', '{"fico":[700,720,740],"ltv":[65,70]}');
  ok(m.count === 6 && !m.error, 'C14 a matrix counts as the product of its axes — 3 × 2 = 6 calls');
  const l = batteryCount('scenarios', '[{"fico":720},{"fico":700}]');
  ok(l.count === 2 && !l.error, 'C15 a scenario list counts as its length');
  ok(/no values/.test(batteryCount('matrix', '{"fico":[]}').error),
    'C16 an axis with no values is named — it expands to nothing, and that is worth knowing BEFORE '
    + 'a paid button rather than after');
  ok(batteryCount('matrix', '{}').count === 0 && /carrying no facts/.test(batteryCount('matrix', '{}').error),
    'C17 an empty matrix is refused as a battery nobody chose, never priced as one blank scenario');
  ok(/not readable JSON/.test(batteryCount('matrix', '{oops').error), 'C18 unreadable JSON says so');
  ok(/JSON array/.test(batteryCount('scenarios', '{"a":1}').error),
    'C19 …and a matrix pasted into the scenario box is named rather than counted as one object');
  ok(/nothing here invents one/i.test(batteryCount('matrix', '').error),
    'C20 an empty box states the rule: nothing here invents a battery');

  ok(cadence(86400000) === 'every 1 day', 'C21 a cadence prints in words, not milliseconds');
  ok(cadence(4 * 3600000) === 'every 4 hours' && cadence(90 * 60000) === 'every 90 minutes',
    'C22 …at whichever unit divides evenly');
  ok(cadence(null) === 'no cadence' && cadence(0) === 'no cadence',
    'C23 …and an unreadable interval says so rather than printing "every 0 days"');

  ok(unmeasuredLines({ scenarios: 10, comparable: 10, incomparable: 0, errors: 0, byKind: {} }).length === 0,
    'C24 a run where everything was compared produces no "could not compare" lines — never a '
    + 'reassuring "0 problems" row');
  const u = unmeasuredLines({ scenarios: 200, comparable: 4, incomparable: 196, errors: 3, byKind: { eligibility_overlay: 2 } });
  ok(u.length === 3 && u.map((x) => x.key).join(',') === 'incomparable,errors,overlay',
    'C25 the three separate reasons a scenario went unmeasured are reported separately');
  // Read defensively: a mutation that empties this list must FAIL an assertion, never CRASH the
  // suite — a crash is red for the wrong reason and reads as proof it is not.
  ok(/measured over the 4 that could be compared, not over the 200/.test(String((u[0] || {}).why || '')),
    'C26 THE SHARP ONE: the incomparable line spells out that the rate is measured over what could be '
    + 'compared — 196 of 200 unmeasured with a beautiful rate is the most reassuring possible way to '
    + 'show a broken measurement');

  const p = persistLines({ persisted: false, persistError: 'db down', runPersisted: true, cellsPersisted: true });
  ok(p.length === 3 && p[0].ok === false && p[0].detail === 'db down',
    'C27 the three durable records are reported separately — they fail independently, and "the run '
    + 'landed but the cells did not" is its own problem');
  ok(persistLines({}).every((x) => x.ok),
    'C28 …and a run that reported no failure is not drawn as having lost anything');
}

// ---- 4. THE RESULT — rendered, not merely mentioned ----------------------------------------------
const RESULT = {
  ok: true,
  scope: 'company',
  investor: 'DEEPHAVEN',
  scenarios: 200,
  agreementRate: 0.75,
  findings: 12,
  summary: {
    scenarios: 200, agreed: 3, disagreed: 1, comparable: 4, incomparable: 196, errors: 3,
    byKind: { price_mismatch: 1, incomparable: 196, eligibility_overlay: 2 },
  },
  report: {
    verdict: '3 of 200 scenarios agree (75%); 1 disagree (3 could not be priced by one side).',
    byKind: [{ kind: 'price_mismatch', label: 'Price disagreements', count: 1 }],
    worstPriceGaps: [{ rate: 7500, deltaMilli: 375, scenario: 'NJ / 720 / 65' }],
    worstPriceGapsOmitted: 9,
    errors: [],
  },
  worstCells: [{ dimension: 'fico', key: 'b700', label: '700–719', total: 40, agreementRate: 0.5, worstAbsMilli: 1250 }],
  persisted: false,
  persistError: 'the findings table refused the write',
  runPersisted: true,
  cellsPersisted: false,
  cellPersistError: 'the parity cells could not be written',
  cellsWritten: 8,
  cellsTruncated: true,
};
{
  let html = ''; let err = null;
  try { html = renderToString(React.createElement(RunView, { result: RESULT, error: '', running: false })); }
  catch (e) { err = e; }
  ok(!err, `C29 the LOADED result renders${err ? `: ${err.message}` : ''}`);
  const t = text(html);

  ok(/75\.0%/.test(t), 'C30 the agreement rate is printed through the shared formatter');
  ok(/of what could be compared/.test(t),
    'C31 …labelled as what it is, because it is NOT a rate over the battery that was paid for');
  ok(/3 of 200 scenarios agree/.test(t), 'C32 the run\'s own plain-language verdict is on the screen');
  ok(/196 of 200 scenarios could not be compared at all/.test(t),
    'C33 THE ONE THAT MATTERS: what could NOT be compared is on the screen beside the rate, in the '
    + 'same size — a 75% agreement measured on 4 of 200 is a broken measurement, not a good score');
  ok(/3 scenarios an engine failed on/.test(t), 'C34 …the engine failures too');
  ok(/2 scenarios declined on an overlay Lender Price cannot see/.test(t),
    'C35 …and the overlay abstentions, which are neither agreement nor mismatch');
  ok(/NOT stored in the findings ledger — the findings table refused the write/.test(t),
    'C36 a findings ledger that refused the write is SAID — a measurement nobody stored is not a '
    + 'measurement the go-live gate can ever read');
  ok(/NOT stored in the per-band parity series/.test(t),
    'C37 …and the per-band series separately, because the three stores fail independently');
  ok(/Stored in the run series the promotion gate reads/.test(t),
    'C38 …while the one that DID land says so, so a reader can tell which record is missing');
  ok(/newest cells are missing from that series/.test(t),
    'C39 a capped per-band write is SAID — a series missing its tail reads as a clean stretch');
  ok(/8 band measurements written/.test(t), 'C40 …and how many band measurements did land');
  ok(/Price disagreements: 1/.test(t), 'C41 the disagreements are broken down by type');
  ok(/\+0\.375 pts apart/.test(t), 'C42 a price gap prints in POINTS, signed — the raw milli would '
    + 'report a 0.375-point gap as "375", which reads as a catastrophe on a sheet quoted in points');
  ok(/and 9 further price gaps this list does not show/.test(t),
    'C43 the omitted price gaps are counted on the page — a sample nobody is told is a sample reads '
    + 'as the whole story');
  ok(/fico · 700–719 — 50\.0% agreement over 40 scenarios/.test(t),
    'C44 the worst BAND is named with its own rate — one agreement rate says the engines disagree '
    + 'and never where');
  ok(/12/.test(t), 'C45 the number of findings this run wrote is on the screen');

  // A clean run must read as clean, and must not borrow the wording of a broken one.
  const CLEAN = {
    scenarios: 40, agreementRate: 1, findings: 0,
    summary: { scenarios: 40, agreed: 40, disagreed: 0, comparable: 40, incomparable: 0, errors: 0, byKind: {} },
    report: { verdict: 'All 40 scenarios agree with Lender Price.', byKind: [], worstPriceGaps: [], worstPriceGapsOmitted: 0 },
    worstCells: [], persisted: true, runPersisted: true, cellsPersisted: true,
  };
  const ct = safeText(React.createElement(RunView, { result: CLEAN, error: '', running: false }));
  ok(/Every scenario in this battery could be compared/.test(ct),
    'C46 a fully comparable run says so — silence there would be indistinguishable from a screen '
    + 'that simply does not check');
  ok(!/could not be compared/.test(ct.replace('could be compared', '')),
    'C47 …and it raises none of the unmeasured warnings');

  const et = safeText(React.createElement(RunView, { result: null, error: 'that canary was refused: you are not an administrator', running: false }));
  ok(/you are not an administrator/.test(et),
    'C48 a REFUSAL shows the server\'s own wording — a generic "that did not work" cannot tell "you '
    + 'may not do this" from "that battery is too large"');

  const rt = safeText(React.createElement(RunView, { result: null, error: '', running: true }));
  ok(/live and it is being billed/.test(rt),
    'C49 while it runs the screen says the vendor is being billed right now — the one moment a '
    + 'person might otherwise press again');

  let nt = null;
  try { nt = renderToString(React.createElement(RunView, { result: null, error: '', running: false })); } catch (e) { nt = `THREW ${e.message}`; }
  ok(nt === '', 'C50 with no run yet it renders NOTHING rather than an empty result nobody measured');
}

// ---- 5. THE SCHEDULES — rendered, including the defect the page must not hide ---------------------
{
  const DATA = {
    ok: true,
    scope: 'company',
    schedules: [
      {
        investor: 'DEEPHAVEN', enabled: true, intervalMs: 86400000,
        rateSheetVersionId: 'v-77', note: 'the overnight battery', updatedBy: 'a.person@example.com',
        batteryKind: 'matrix', runnable: true, reason: null, message: null,
      },
      {
        investor: null, enabled: false, intervalMs: 3600000,
        rateSheetVersionId: null, note: null, updatedBy: 'b.person@example.com',
        batteryKind: 'scenarios', runnable: false, reason: 'disabled',
        message: 'This canary schedule is saved but paused.',
      },
    ],
    runnable: 1,
    note: null,
  };
  let html = ''; let err = null;
  try {
    html = renderToString(React.createElement(SchedView, {
      data: DATA, error: '', confirming: null, busy: false,
      onConfirmRemove: () => {}, onRemove: () => {}, onCancelRemove: () => {},
    }));
  } catch (e) { err = e; }
  ok(!err, `C51 the LOADED schedule list renders${err ? `: ${err.message}` : ''}`);
  const t = text(html);

  ok(/Nothing fires these schedules yet/.test(t),
    'C52 THE SHARP ONE: the page says on its face that nothing ticks a saved schedule. That is a '
    + 'recorded defect, and a schedule editor that drew a stored cadence as armed would be the '
    + 'surface that finally hid it');
  ok(/no cron, worker or timer in the running system calls it/.test(t),
    'C53 …and says what is missing, so the sentence is a finding rather than a shrug');
  ok(/DEEPHAVEN/.test(t) && /Every investor \(no investor named\)/.test(t),
    'C54 both rows are named — including the company-wide one, which has no investor to print');
  ok(/would run/.test(t) && /would not run/.test(t),
    'C55 each row carries the RUNNER\'s own verdict — a list saying "saved" beside a schedule that '
    + 'can never fire is exactly how a measurement gap hides');
  ok(/This canary schedule is saved but paused\./.test(t),
    'C56 …in the SERVER\'s own wording, which names WHICH rule stopped it; a paraphrase names none');
  ok(/every 1 day/.test(t) && /every 1 hour/.test(t), 'C57 the cadence is printed in words per row');
  ok(/a saved matrix/.test(t) && /a saved scenario list/.test(t),
    'C58 …and which shape of battery each one would price');
  ok(/Prices against rate sheet v-77/.test(t), 'C59 the sheet a schedule prices against is named');
  ok(/No rate sheet named, so a run would be refused/.test(t),
    'C60 …and a schedule with none says the run would be refused, rather than looking armed');
  ok(/Armed by a.person@example.com/.test(t),
    'C61 who armed the vendor loop is on the row — the first question asked when it starts costing money');

  const empty = safeText(React.createElement(SchedView, {
    data: { ok: true, schedules: [], runnable: 0, note: 'No canary schedule can run, so the agreement series only grows when somebody fires one by hand.' },
    error: '', confirming: null, busy: false, onConfirmRemove: () => {}, onRemove: () => {}, onCancelRemove: () => {},
  }));
  ok(/No canary schedule is saved/.test(empty),
    'C62 an empty list says nothing is measured on a cadence, never a blank panel');
  ok(/the clean-day streak the promotion gate reads has nothing feeding it/.test(empty),
    'C63 …and names the consequence, which is what makes it worth reading');
  ok(/only grows when somebody fires one by hand/.test(empty),
    'C64 the server\'s own note about a list with nothing runnable is printed');

  const errText = safeText(React.createElement(SchedView, {
    data: null, error: 'the schedule table is unreadable', confirming: null, busy: false,
    onConfirmRemove: () => {}, onRemove: () => {}, onCancelRemove: () => {},
  }));
  ok(/the schedule table is unreadable/.test(errText),
    'C65 a READ FAILURE is shown — rendering an empty list instead would read as "nothing is '
    + 'scheduled", which is a different fact and sends a person somewhere else');

  // Removing asks first, INLINE. Long-Term may not import RTL's dialog helper, and a browser confirm
  // is banned outright — so the question is asked on the row that is about to be removed.
  const confirming = safeText(React.createElement(SchedView, {
    data: DATA, error: '', confirming: 'DEEPHAVEN', busy: false,
    onConfirmRemove: () => {}, onRemove: () => {}, onCancelRemove: () => {},
  }));
  ok(/Yes, remove it/.test(confirming) && /Keep it/.test(confirming),
    'C66 removing a schedule asks first, inline on the row — never a browser dialog, which this '
    + 'product may not use and Long-Term may not import a helper for');
  ok(!/Yes, remove it/.test(t),
    'C67 …and the question is asked only for the row being removed, never on every row at once');
}

// ---- 6. the rules a render cannot show: dark text, no dialogs, no stray URL, and it is MOUNTED ----
{
  const src = fs.readFileSync(SRC, 'utf8');
  ok(!/color:\s*['"]?var\(--ink/.test(src),
    'C68 no `--ink*` token is used as a text colour — every one of them is a LIGHT paper colour in '
    + 'this palette, so it renders white-on-white; this has shipped before, on a whole card');
  ok(!/\bwindow\.(alert|confirm|prompt)\s*\(/.test(src) && !/(^|[^.\w])(alert|confirm|prompt)\s*\(/.test(src),
    'C69 no browser dialog is raised — the repo\'s three guards, and a `confirm` whose promise is '
    + 'never awaited reads as "the user said yes"');
  ok(!/['"`]\/api\/lt\//.test(src),
    'C70 it writes no `/api/lt/` URL of its own — a hand-rolled request is invisible to the '
    + 'HTTP-reachability scan, which is how a live route comes to read as dead');
  ok(!/(const|function)\s+rate\s*[=(]/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')),
    'C71 it defines no formatter of its own — a second copy of `rate` is how one screen prints 0.97% '
    + 'where another prints 97%');

  const api = fs.readFileSync(path.join(appv2, 'src/longterm/api.js'), 'utf8');
  for (const m of [...new Set([...src.matchAll(/ltApi\.([a-zA-Z0-9_]+)\s*\(/g)].map((x) => x[1]))]) {
    ok(new RegExp(`^\\s{2}${m}[:(]`, 'm').test(api),
      `C72-${m} ltApi.${m} really exists — a missing method builds fine and throws at render`);
  }
  ok(/ppeCanary:/.test(api) && /ppeCanarySchedules:/.test(api)
    && /ppeSaveCanarySchedule:/.test(api) && /ppeDeleteCanarySchedule:/.test(api),
    'C73 all four canary methods are on the ONE client, so the reachability scan can see them');

  const screen = fs.readFileSync(path.join(appv2, 'src/longterm/LtPpe.jsx'), 'utf8');
  ok(/import CanaryConsole from '\.\/CanaryConsole\.jsx'/.test(screen), 'C74 the PPE screen imports the console');
  ok(/<CanaryConsole\s/.test(screen),
    'C75 …and MOUNTS it — a console nothing renders is the same defect one layer up, which is exactly '
    + 'the state the route was in');

  const ledger = fs.readFileSync(path.join(repo, 'docs/longterm/LT-ROUTES-UNREACHED.md'), 'utf8');
  for (const row of ['POST /api/lt/ppe/canary`', 'GET /api/lt/ppe/canary/schedules', 'POST /api/lt/ppe/canary/schedules', 'DELETE /api/lt/ppe/canary/schedules/:investor']) {
    ok(!ledger.includes(`\`${row}\` |`), `C76 the ledger no longer claims ${row.replace('`', '')} is unreachable`);
  }
  // The ROW, not a mention: the prose under the table quotes this route by name, so asking whether
  // the file merely CONTAINS the string passes on a ledger whose table row has been deleted.
  ok(/^\|\s*`POST \/api\/lt\/ppe\/canary\/tick`\s*\|/m.test(ledger),
    'C77 …while the TICK stays recorded, because nothing calls it and this console deliberately does '
    + 'not — a manual tick button is not a scheduler, and it would blur the defect');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${failures ? `${failures} FAILED of ${n}` : `all ${n} passed`}`);
process.exit(failures ? 1 : 0);
