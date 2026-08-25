// LONG-TERM — THE ENCOMPASS SYNCING SECTION RENDERS, AND SAYS THE THINGS THE OWNER
// ASKED FOR (#52, owner-directed 2026-08-25).
//
// A green Vite build proves parsing and nothing else: esbuild emits an undeclared
// identifier VERBATIM and the screen throws at render, which the error boundary
// turns into the full-screen "Something went wrong" card. So this bundles the real
// component with the real React and renders it — and it renders the LOADED states,
// not only the loading one, because the loading state is the state nobody has a
// problem with.
//
// That is possible because the section is split: `EncompassSectionBody` is a pure
// function of its payload and the default export is the loader around it. Server
// rendering cannot run effects, so a fetch-and-draw component could only ever be
// proven to render "Loading…" — which would leave every fact the owner asked to see
// unproven.
//
// AND THE PAYLOAD IS BUILT BY THE REAL SERVER FUNCTION. `fileSyncView` is pure, so
// the screen is rendered against exactly what the route would send rather than
// against somebody's recollection of the shape — which is the class of bug that
// makes a section render perfectly in a test and blank on a real file.

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '../app-v2');
const requireApp = createRequire(path.join(appDir, 'package.json'));

let esbuild;
try { esbuild = requireApp('esbuild'); requireApp('react-dom/server'); } catch {
  console.log('app-v2/node_modules is not installed here — the render smoke needs the front-end toolchain. Skipped (run `cd app-v2 && npm install` to enable).');
  process.exit(0);
}

let checks = 0;
const ok = (c, w) => { if (!c) { console.error('FAIL:', w); process.exit(1); } console.log('  ok  ', w); checks++; };

// ── The payloads, built by the REAL server module ───────────────────────────
const requireSrv = createRequire(path.join(here, '..', 'package.json'));
const view = requireSrv(path.join(here, '..', 'src', 'longterm', 'encompass', 'file-sync-view.js'));
const readState = requireSrv(path.join(here, '..', 'src', 'longterm', 'read-state.js'));

// THE FIXTURE STAMPS ARE RELATIVE TO NOW, ON PURPOSE. The screen prints "30
// minutes ago" from the REAL wall clock (that is the whole point of the phrase),
// so a fixed calendar date would drift a little further from its expected wording
// every day until the suite failed on a Tuesday for no reason. Same flake, same
// fix, as the `needsRead` cases in test-lt-loan-sync-pure.js.
const NOW = Date.now();
const agoIso = (mins) => new Date(NOW - mins * 60000).toISOString();

const NEVER_READ = {
  loan_number: 'YSCAP258134857',
  encompass_loan_guid: '11111111-2222-3333-4444-555555555555',
  loan_folder: 'Pipeline',
  borrower_name: 'wolf rosenbaum',
  loan_amount: 512000,
  program_name: 'Investor DSCR',
  term_months: 360,
  milestone_name: 'Started',
  stage_key: 'new',
  encompass_last_modified: agoIso(20 * 60),
  encompass_synced_at: null,
};

const READ_IN_FULL = {
  ...NEVER_READ,
  encompass_synced_at: agoIso(30),
  conditions_synced_at: agoIso(90),
  borrower_first_name: 'Wolf',
  borrower_last_name: 'Rosenbaum',
  borrower_email: 'wolf@example.test',
  vesting_type: 'Individual',
  ms_status: 'Cond. Approval',
  ms_status_date: '2026-08-24',
  encompass_nudged_at: agoIso(32),
  encompass_nudged_via: 'sweep',
  encompass_nudge_count: 7,
};

const REFUSED = { ...READ_IN_FULL, encompass_sync_error: 'HTTP 401 from Encompass' };

const payload = (row, switches) => view.fileSyncView(row, {
  readState: readState.readStateOf(row),
  switches: switches || { enabled: true, configured: true, blocked: null, throttleSec: 30 },
  now: NOW,
});

// ── Render ──────────────────────────────────────────────────────────────────
const stub = (name, source) => ({ name, setup(b) {
  for (const [filter, contents] of source) {
    b.onResolve({ filter }, (a) => ({ path: a.path, namespace: name }));
    b.onLoad({ filter, namespace: name }, () => ({ contents, loader: 'jsx', resolveDir: appDir }));
  }
} });

// The api client is stubbed because the BODY never calls it — proving that is part
// of the point: a body that reached for the network could not be rendered here.
const plugins = [stub('lt-enc-stubs', [
  [/\.\/api\.js$/, 'export const ltApi = new Proxy({}, { get: () => () => Promise.resolve({}) });'],
])];

async function render(exportName, propsJson) {
  const entry = './src/longterm/LtEncompassSection.jsx';
  const imp = exportName === 'default'
    ? `import C from ${JSON.stringify(entry)};`
    : `import { ${exportName} as C } from ${JSON.stringify(entry)};`;
  const out = await esbuild.build({
    stdin: {
      contents: `import React from 'react'; import { renderToString } from 'react-dom/server';
        ${imp}
        globalThis.__HTML__ = renderToString(React.createElement(C, ${propsJson}));`,
      resolveDir: appDir, loader: 'jsx',
    },
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', plugins,
  });
  const fn = new Function('require', 'module', 'exports', out.outputFiles[0].text);
  fn(requireApp, { exports: {} }, {});
  return globalThis.__HTML__;
}

const props = (row, switches) => `{ data: ${JSON.stringify(payload(row, switches))}, onRead: () => {}, notice: null }`;

// 1) It renders at all — the undeclared-identifier crash a green build hides.
console.log('the section renders');
const loading = await render('default', `{ loanId: 'x' }`);
ok(loading.includes('Loading the Encompass section'),
  'the loader renders its first paint without throwing');

// 2) A FILE THAT HAS NEVER BEEN READ — the owner's three Sherman Ave files. This is
//    the state the whole section exists for, so it is the one asserted hardest.
console.log('');
console.log('a file PILOT has found but never read');
const neverHtml = await render('EncompassSectionBody', props(NEVER_READ));
ok(neverHtml.includes('YSCAP258134857'), 'the loan number is drawn');
ok(neverHtml.includes('has not read this file from Encompass yet'),
  'THE ONE THAT MATTERS: it says plainly that the file has NOT been read — the fact that was recorded on the row and readable nowhere');
ok(neverHtml.includes('never — this file has not been opened and read yet'),
  'the last pull says "never" in words rather than an empty cell');
ok(neverHtml.includes('never — Encompass has not pinged PILOT about this file'),
  'and so does the webhook — "we were never pinged" is an ANSWER about the webhook, not missing data');
ok(neverHtml.includes('Read this file from Encompass now'),
  'the read button is offered');
// The two lists: discovery filled, the full read empty. That contrast IS the
// explanation for a half-empty file.
// THE TOTALS COME FROM THE MODULE, NOT FROM A NUMBER TYPED HERE. Both lists are
// hand-kept and both are meant to grow — the full-read list gained the note rate,
// the DSCR, the housing expense and the purpose the day the owner reported a file
// showing none of them. A literal "9" turns every such addition into a failing test
// that says nothing about what broke, and the temptation is then to bump the number
// rather than read it. What this line actually means is "all of the first list, none
// of the second", so that is what it now says.
const DISC_N = view.DISCOVERY_FIELDS.length;
const FULL_N = view.FULL_READ_FIELDS.length;
ok(DISC_N > 0 && FULL_N > 0, `both lists are non-empty (${DISC_N} from the search, ${FULL_N} from opening the loan)`);
ok(neverHtml.includes(`${DISC_N} of ${DISC_N} filled in`), 'the pipeline search shows everything it brings back is there');
ok(neverHtml.includes(`0 of ${FULL_N} filled in`), '…and the full read shows nothing has arrived yet');

// 3) A FILE READ IN FULL.
console.log('');
console.log('a file read in full');
const readHtml = await render('EncompassSectionBody', props(READ_IN_FULL));
ok(readHtml.includes('This file has been read from Encompass'), 'it says the file has been read');
ok(readHtml.includes('30 minutes ago'), 'the last pull is said in words a person reads, not only as a timestamp');
// THE STAMP ITSELF, not only the count beside it. Found by mutation: blanking the
// webhook time left the count and the shape-of-ping words rendering happily, so
// the section could have said "7 pings, PILOT asked Encompass which loans had
// changed" while claiming, one line up, that Encompass has never pinged us — and
// every assertion here passed. The count is not the fact the owner asked for.
ok(readHtml.includes('32 minutes ago'),
  'THE WEBHOOK TIME is drawn — "last webhooks" is the fact, and a count without it can contradict the line it sits under');
ok(!readHtml.includes('Encompass has not pinged PILOT about this file'),
  '…so a file that HAS been pinged never also says it never was');
ok(readHtml.includes('7 pings about this file in total'),
  'the webhook count is drawn — a recent ping with a count of 1 and an old one with a count of 41 are different stories');
ok(readHtml.includes('PILOT asked Encompass which loans had changed'),
  'and the SHAPE of the ping is said in words, never as the stored code');
// The rota is 12 hours after the last read, so on a file read 30 minutes ago it is
// still 11-and-a-bit hours out — which the screen states as a FUTURE stamp with no
// "ago" beside it (`ago` refuses a future instant rather than printing "in -11
// hours ago"). Asserting the exact clock time would pin the machine's timezone, so
// what is asserted is that the row is drawn and explains itself.
ok(readHtml.includes('Next automatic re-read')
  && readHtml.includes('at least every 12 hours'),
  'the next automatic re-read is drawn from the rota, and the rota explains itself');

// 4) A READ THAT WAS REFUSED — the third state, and the one that must never be
//    collapsed into "not read yet": a file showing week-old figures is a different
//    problem from a file showing none.
console.log('');
console.log('a read Encompass refused');
const refusedHtml = await render('EncompassSectionBody', props(REFUSED));
ok(refusedHtml.includes('The last read from Encompass was refused'), 'the refusal leads');
ok(refusedHtml.includes('HTTP 401 from Encompass'), '…and quotes what Encompass actually said');
ok(refusedHtml.includes('may be out of date'),
  '…and warns that the figures on screen are the LAST GOOD read, not nothing');

// 5) THE BUTTON CANNOT BE A DEAD END. A greyed control with no explanation is the
//    same complaint this section answers.
console.log('');
console.log('a connection that is switched off');
const offHtml = await render('EncompassSectionBody',
  props(NEVER_READ, { enabled: false, configured: true, blocked: 'Encompass is switched off for the whole of PILOT.', throttleSec: 30 }));
ok(offHtml.includes('Encompass is switched off for the whole of PILOT.'),
  'the reason the button cannot run is drawn beside it, never only as a disabled attribute');

// 6) COLOUR RULE. Every `--ink*` token in this palette is LIGHT, so one used as a
//    text colour renders white on white — the bug that made a whole staff card
//    invisible. This section states its darks explicitly and must keep doing so.
console.log('');
console.log('the colour rule holds');
const { readFileSync } = await import('fs');
const src = readFileSync(path.join(appDir, 'src/longterm/LtEncompassSection.jsx'), 'utf8');
ok(!/color:\s*['"`]?var\(--ink/.test(src),
  'no --ink* token is used as a text colour — every one of them is a LIGHT paper colour in this palette');
ok(!/window\.(confirm|alert|prompt)\s*\(/.test(src),
  'no browser dialog — Long-Term may not import RTL’s dialog library, so confirmations are the inline two-step button');

console.log(`\nAll ${checks} checks passed.`);
