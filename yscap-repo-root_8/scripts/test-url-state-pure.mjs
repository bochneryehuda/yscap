/* A REFRESH KEEPS YOUR PLACE — the properties of the one mechanism
   (owner-reported 2026-08-21: "When you refresh in the middle of the draw center, it
   loses your place completely and it goes back to the top … this is a major issue …
   also on the application detail and Campus Thinking. Dig in and find more places.")

   Every screen that lost your place had its OWN private useState, so each lost it its
   own way and a new screen inherited the bug by default. `useUrlState` is the single
   mechanism; these are the properties that make it worth having, asserted against the
   pure decision core the React hook is a thin wrapper over — so a property proven here
   holds for every screen that uses it.

   Pure — no DOM, no browser, no database. */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
/* Strip comments before any "must not appear" check: the file necessarily NAMES the
   pattern it exists to replace, and a guard that read comments would fail on its own
   explanation — and then get "fixed" by deleting it. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

let fail = 0;
const ok = (cond, what) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${what}`); if (!cond) fail++; };

/* The PURE core — imported directly from its own React-free module. Importing the HOOK
   instead pulls in `react` and `react-router-dom` through its top-level imports, which
   live in app-v2/node_modules; CI installs only the root package, so that passed locally
   and died on the runner with ERR_MODULE_NOT_FOUND. The hook is still checked below, as
   TEXT, which needs no import at all. */
const U = await import('../app-v2/src/lib/urlState.js');
const SRC = read('app-v2/src/lib/useUrlState.js');

// ---------------------------------------------------------------------------
// A. PRECEDENCE — a shared link beats what this tab was doing beats the default.
// ---------------------------------------------------------------------------
console.log('\nA. which value wins');
ok(U.pickValue({ url: 'encompass', memory: 'people', fallback: 'deal' }) === 'encompass',
  'an explicit URL wins — a shared or bookmarked link always lands where it says');
ok(U.pickValue({ url: null, memory: 'people', fallback: 'deal' }) === 'people',
  'with the URL silent, what this tab was last doing wins — that is the refresh case');
ok(U.pickValue({ url: null, memory: null, fallback: 'deal' }) === 'deal',
  'with neither, the default');
ok(U.pickValue({ url: '', memory: '', fallback: 'deal' }) === 'deal',
  'an EMPTY value is absent, not a selection');

// A stale link to a tab that no longer exists must land somewhere real, never on a
// blank screen — so a rejected URL value falls THROUGH rather than being selected.
const TABS = ['deal', 'people', 'encompass'];
ok(U.pickValue({ url: 'retired-tab', memory: 'people', fallback: 'deal', allow: TABS }) === 'people',
  'a URL naming a tab that no longer exists falls through instead of rendering nothing');
ok(U.pickValue({ url: 'retired-tab', memory: null, fallback: 'deal', allow: TABS }) === 'deal',
  '…all the way to the default when there is nothing else');
ok(U.pickValue({ url: 'encompass', memory: null, fallback: 'deal', allow: TABS }) === 'encompass',
  'a listed value is still selected (the control — the allow-list is not just refusing everything)');
ok(U.pickValue({ url: 'x', memory: null, fallback: 'd', allow: () => { throw new Error('boom'); } }) === 'd',
  'an allow-list that throws refuses rather than taking the screen down with it');

// ---------------------------------------------------------------------------
// B. THE DEFAULT IS THE ABSENCE OF THE KEY — a clean address for a clean screen.
// ---------------------------------------------------------------------------
console.log('\nB. defaults are elided');
const q = (p) => p.toString();
ok(q(U.nextParams(new URLSearchParams(''), 'tab', 'encompass', 'deal')) === 'tab=encompass',
  'choosing a non-default writes the key');
ok(q(U.nextParams(new URLSearchParams('tab=encompass'), 'tab', 'deal', 'deal')) === '',
  'going BACK to the default deletes it — ?tab=deal never appears');
ok(q(U.nextParams(new URLSearchParams('tab=encompass'), 'tab', '', 'deal')) === '',
  'clearing deletes it');
ok(q(U.nextParams(new URLSearchParams('tab=encompass'), 'tab', null, 'deal')) === '',
  'so does null — never the literal string "null" in somebody\'s address bar');

// ---------------------------------------------------------------------------
// C. INDEPENDENT KEYS COMPOSE — the failure that makes functional writes mandatory.
// ---------------------------------------------------------------------------
console.log('\nC. several keys in one tick');
{
  // Screens here set a view AND a tab, or four keys at once. The read-then-write-a-
  // captured-params shape drops all but the last; this proves the hook's shape does not.
  let p = new URLSearchParams('');
  p = U.nextParams(p, 'view', 'grid', 'list');
  p = U.nextParams(p, 'tab', 'encompass', 'deal');
  p = U.nextParams(p, 'sort', 'age', 'name');
  ok(p.get('view') === 'grid' && p.get('tab') === 'encompass' && p.get('sort') === 'age',
    'three keys written in a row all survive');
  const before = new URLSearchParams('tab=encompass');
  const after = U.nextParams(before, 'view', 'grid', 'list');
  ok(before.toString() === 'tab=encompass' && after.get('tab') === 'encompass',
    'the previous params are never mutated, so a concurrent write cannot lose one');
  // A key that belongs to something else on the page is untouched.
  ok(U.nextParams(new URLSearchParams('finding=abc&esign=1'), 'tab', 'people', 'deal').get('finding') === 'abc',
    'a param owned by another feature on the screen is left alone');
}

// ---------------------------------------------------------------------------
// D. MANY-AT-ONCE — which sections are open, in one short readable key.
// ---------------------------------------------------------------------------
console.log('\nD. sets');
ok([...U.parseSet('a,b,c')].join('|') === 'a|b|c', 'a set round-trips');
ok(U.parseSet('').size === 0 && U.parseSet(null).size === 0, 'empty and null are the empty set');
ok([...U.parseSet(' a , ,b ')].join('|') === 'a|b', 'blanks and spaces are ignored');
ok(U.joinSet(['a', 'b', 'a']) === 'a,b', 'a repeat is not written twice');
ok(U.joinSet([]) === '' , 'an empty set writes nothing…');
ok(q(U.nextParams(new URLSearchParams('sec=a,b'), 'sec', U.joinSet([]), '')) === '',
  '…so a screen back at its defaults has a clean address again');
ok([...U.parseSet(U.joinSet(['dsec-wire', 'dsec-ledger']))].length === 2, 'parse(join(x)) is x');

// ---------------------------------------------------------------------------
// E. NAMESPACING — two hubs may both own a `tab`.
// ---------------------------------------------------------------------------
console.log('\nE. namespacing');
ok(U.paramKey('tab') === 'tab', 'unprefixed by default');
ok(U.paramKey('tab', { prefix: 'draws' }) === 'draws.tab',
  'an embedded hub gets its own key, so a nested tab cannot hijack its host’s');

// ---------------------------------------------------------------------------
// F. THE SHAPE ITSELF — the properties a value test cannot see.
// ---------------------------------------------------------------------------
console.log('\nF. the hook’s shape');
{
  const body = code(SRC);
  ok(!/\buseState\b/.test(body),
    'the hook holds NO useState copy of the value — that is what keeps Back and Forward working');
  ok(/setParams\(\(prev\) =>/.test(body),
    'every write derives from the previous params (functional), never from a captured copy');
  ok(/replace: !\(opts && opts\.push\)/.test(body),
    'replace by default — choosing a tab is not navigation, so Back leaves the screen');
  // These two are properties of the MECHANISM, which is the pair of files — the guards
  // and the store live in the pure half, the React wiring in the hook. Checked over both
  // so the split cannot quietly lose either.
  const both = body + code(read('app-v2/src/lib/urlState.js'));
  ok((both.match(/catch \(_\)/g) || []).length >= 3,
    'every store and parse is guarded — remembering a place may never break a screen');
  ok(/sessionStorage/.test(both) && !/localStorage/.test(both),
    'the memory is sessionStorage: it survives a reload of THIS tab and never leaks to the next person');
  // And the split itself must hold: the pure half is what a test can import anywhere, so
  // it may never grow a React import (that is what broke CI the first time).
  ok(!/from '(react|react-router-dom)'/.test(read('app-v2/src/lib/urlState.js')),
    'the pure half imports no React — so its properties can be tested where app-v2/node_modules does not exist');
}

console.log(`\n${fail === 0 ? 'ALL' : 'SOME'} url-state assertions: ${fail} failed`);
process.exit(fail ? 1 : 0);
