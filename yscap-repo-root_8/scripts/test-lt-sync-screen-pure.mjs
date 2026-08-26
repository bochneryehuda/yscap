// LONG-TERM — THE FULL PULL WATCHES ITSELF THROUGH AND SAYS WHAT IT DID (#54,
// owner-reported 2026-08-25: *"when I'm clicking 'Pull everything from Encompass',
// it doesn't sound like that button is actually working ... I'm clicking it, then
// nothing happens."*).
//
// The ROOT CAUSE of that report was arithmetic, fixed elsewhere: a zoneless
// Encompass stamp read as UTC meant the pass correctly found no loan due, so the
// button worked perfectly and looked dead. But the button also earned the
// complaint on its own terms — it answers "started" and works in the background,
// and NOTHING ever told anybody it had finished or what it found. That half is
// what this file guards.
//
// Two rules, both learned the hard way and both pinned here:
//
//   · THE SCREEN READS THE SERVER'S OWN KEYS. Writing the watcher, `lastRun` was
//     used where the route sends `lastLoanRun` — so the sentence would have been
//     silently skipped on every single pull, and the button would have gone right
//     back to saying nothing. A test that only rendered the screen would never
//     have noticed: a missing key is `undefined`, not a crash.
//   · A REFUSAL IS NOT A PASS. `started:false` (the connection is off, a pass is
//     already running) must not be watched for — a watcher waiting on a pass that
//     was never started ends by giving up, which reads as a second failure.

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '../app-v2');
const requireApp = createRequire(path.join(appDir, 'package.json'));

let esbuild;
try { esbuild = requireApp('esbuild'); } catch {
  console.log('app-v2/node_modules is not installed here — this needs the front-end toolchain. Skipped (run `cd app-v2 && npm install` to enable).');
  process.exit(0);
}

let checks = 0;
const ok = (c, w) => { if (!c) { console.error('FAIL:', w); process.exit(1); } console.log('  ok  ', w); checks++; };

const SCREEN = path.join(appDir, 'src/longterm/LtSync.jsx');
const ui = readFileSync(SCREEN, 'utf8');
const server = readFileSync(path.join(here, '..', 'src/longterm/routes/sync.js'), 'utf8');

// ── 1. The keys the WATCHER reads are keys the route explicitly names ────────
// Narrowed to the watcher on purpose, and that narrowing is the honest part: the
// rest of the payload arrives through a `...rows[0]` spread of a SQL count query,
// so its keys are not in the route's source at all and a whole-screen sweep would
// report every one of them as a stray. What CAN be proven — and what actually
// broke while this was written — is that the two keys the watcher turns on are
// named right there in the response.
console.log('the watcher reads the server’s own keys');

const named = new Set([...server.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((m) => m[1]));
ok(named.has('lastLoanRun') && named.has('running'),
  'the route names both keys the watcher turns on (lastLoanRun, running)');
ok(!named.has('lastRun'),
  '…and does NOT send `lastRun` — which is what makes the next check worth having');

const watcher = (ui.match(/const watchPull = \(\) => \{[\s\S]*?\n  \};/) || [''])[0];
ok(watcher.length > 100, 'the watcher is readable in the screen');
const watcherKeys = [...watcher.matchAll(/\bs2\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
ok(watcherKeys.length >= 2, `the watcher's state reads are readable (${watcherKeys.join(', ')})`);
const strays = watcherKeys.filter((k) => !named.has(k));
ok(strays.length === 0,
  `THE ONE THAT MATTERS: every key the watcher reads is one the route sends${strays.length ? ` — stray: ${strays.join(', ')}` : ''}`);
ok(watcherKeys.includes('lastLoanRun'),
  '…including lastLoanRun, the key the last-run box also reads, so the sentence and that box can never describe different passes');

// ── 2. A refusal is never watched for ────────────────────────────────────────
console.log('');
console.log('a refusal is not a pass');
ok(/out\.started === false\)\s*return;/.test(ui.replace(/\s+/g, ' ')) || /started === false/.test(ui),
  'the pull stands down when the server answers started:false, rather than watching for a pass nobody started');

// ── 3. Every timer is cancellable ────────────────────────────────────────────
console.log('');
console.log('every timer this screen sets can be cancelled');
ok(/timers\s*=\s*useRef\(\[\]\)/.test(ui), 'the timers are held in a ref');
ok(/timers\.current\.forEach\(clearTimeout\)/.test(ui), '…and cleared on unmount');
ok(!/(?<!\.)\bsetTimeout\(load,/.test(ui),
  'no bare setTimeout is left behind — the two the pull used to set were never cleared, under a comment claiming they were');

// ── 4. The sentence itself, which is what somebody actually reads ────────────
console.log('');
console.log('what a finished pull says');

const out = await esbuild.build({
  stdin: {
    contents: `export { pullOutcomeNote } from ${JSON.stringify('./src/longterm/LtSync.jsx')};`,
    resolveDir: appDir, loader: 'js',
  },
  bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
  external: ['react', 'react-dom', 'react-router-dom'],
  plugins: [{ name: 'stubs', setup(b) {
    b.onResolve({ filter: /\.\/(api|LtLayout)\.jsx?$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'export const ltApi = {}; export default function X(){ return null; }', loader: 'js' }));
  } }],
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', out.outputFiles[0].text)(requireApp, mod, mod.exports);
const note = mod.exports.pullOutcomeNote;

ok(note(null) === null,
  'no pass recorded says NOTHING — the box below already says so, and a second line would claim a pass that did not happen');
ok(/did not work: Encompass refused/.test(note({ ok: false, reason: 'Encompass refused' })),
  'a failed pass quotes its own reason');
ok(/connection worked, the book is empty/.test(note({ discovered: 0, read_count: 0 })),
  'THE ONE THAT MATTERS: finding NOTHING is reported as an answer — "the connection worked and the book is empty" is what tells somebody the button is fine');
ok(!/did not work|could not/.test(note({ discovered: 0, read_count: 0 })),
  '…and never as a failure');
const full = note({ discovered: 772, read_count: 25, remaining: 747 });
ok(/Found 772 loans/.test(full) && /read 25 in full/.test(full),
  'a real pass says what it found AND what it read — the two are different numbers and only the second means a file filled in');
ok(/747 still to go/.test(full), '…and says how many are still queued rather than implying it finished the book');
ok(/2 could not be read/.test(note({ discovered: 10, read_count: 8, failed: 2 })),
  'loans it could not read are counted out loud, never swallowed');
ok(!/still to go/.test(note({ discovered: 10, read_count: 10, remaining: 0 })),
  'a pass that finished the book does not claim leftovers');

console.log(`\nAll ${checks} checks passed.`);
