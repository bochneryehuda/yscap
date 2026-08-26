// LONG-TERM — THE FORMATTERS THAT DECIDE WHAT A VALUE LOOKS LIKE ON SCREEN.
//
// `app-v2/src/longterm/format.js` is the one place a long-term value is written
// down, and three of its rules are the kind that go wrong quietly:
//
//   · A CODE FROM ENCOMPASS becomes English (owner-reported 2026-08-25: the purpose
//     "should be nicely displayed, not with these lines"). The danger is a formatter
//     that changes what a value MEANS while tidying it — lower-casing DSCR, or
//     dropping a spelling nobody has met yet.
//   · A TIMESTAMP said in words ("30 minutes ago"), which must refuse a FUTURE
//     instant rather than print "in -4 hours ago" on the one screen whose subject is
//     timing.
//   · The standing rule under all of them: a value NOBODY STATED is a dash, and a
//     stated ZERO is a zero. "We have not read this" and "it is nothing" are
//     different facts, and on money the second one is a lie a desk would act on.
//
// Loaded through esbuild rather than re-implemented, so what is tested is the module
// the screens actually import.

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

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

const built = await esbuild.build({
  entryPoints: [path.join(appDir, 'src/longterm/format.js')],
  bundle: true, write: false, format: 'cjs', platform: 'node',
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', built.outputFiles[0].text)(requireApp, mod, mod.exports);
const F = mod.exports;

// ── The loan purpose, in words ───────────────────────────────────────────────
console.log('a code from Encompass, written the way a person writes it');

ok(F.purpose('rate_term_refinance') === 'Rate & term refinance',
  'THE ONE THE OWNER REPORTED: rate_term_refinance reads as English, not as a database code');
ok(F.purpose('cash_out_refinance') === 'Cash-out refinance',
  'cash_out_refinance takes the hyphen that de-underscoring alone could never invent');
ok(F.purpose('purchase') === 'Purchase', 'a plain one is simply capitalised');
ok(F.purpose('RATE_TERM_REFINANCE') === 'Rate & term refinance',
  'the tenant’s casing does not decide the wording — Encompass returns these several ways');
ok(F.purpose('rate-term-refinance') === 'Rate & term refinance',
  '…and neither does a hyphen where an underscore was expected');

// A SPELLING NOBODY HAS MET IS STILL SHOWN, tidied but never re-worded. Dropping it
// would hide a real purpose because our table had not caught up.
ok(F.purpose('some_new_purpose') === 'Some new purpose',
  'a purpose nobody has words for is de-underscored and shown, never dropped');
ok(F.purpose('DSCR_loan') === 'DSCR loan',
  'THE ONE THAT MATTERS: a word already capitalised KEEPS its capitals — lower-casing DSCR or LLC to look tidy would change the value');
ok(F.purpose(null) === '—' && F.purpose('') === '—' && F.purpose('   ') === '—',
  'nothing stated is a dash');

// ── How long ago ─────────────────────────────────────────────────────────────
console.log('');
console.log('how long ago, in words');

const T = Date.parse('2026-08-25T12:00:00Z');
const at = (mins) => new Date(T - mins * 60000).toISOString();
ok(F.ago(at(0.5), T) === 'just now', 'under a minute is "just now" — nobody acts on 30 seconds');
ok(F.ago(at(20), T) === '20 minutes ago', 'minutes');
ok(F.ago(at(60), T) === '1 hour ago', '…and one hour is singular');
ok(F.ago(at(600), T) === '10 hours ago', 'hours');
ok(F.ago(at(60 * 24 * 5), T) === '5 days ago', 'days');
ok(F.ago(null, T) === null && F.ago('junk', T) === null,
  'nothing to measure answers nothing — the caller words the absence, because "never read" and "never changed" are different sentences');
ok(F.ago(new Date(T + 3600000).toISOString(), T) === null,
  'THE ONE THAT MATTERS: a FUTURE stamp answers nothing rather than "in -1 hours ago" — the only way that happens is a clock disagreement, and this is the screen whose whole subject is timing');

// ── A timestamp, and the difference from a calendar day ──────────────────────
console.log('');
console.log('a stamp is an instant; a day is a day');

ok(F.stamp(null) === null, 'no stamp answers null, so the caller can word it');
ok(typeof F.stamp('2026-08-25T12:00:00Z') === 'string', 'a real one is written out');
ok(F.day('2019-08-01') === '8/1/2019',
  'a CALENDAR day is read as the day it says — `new Date("2019-08-01")` is UTC midnight and prints the day BEFORE in every US timezone');

// ── Nothing stated is a dash; a stated zero is a zero ────────────────────────
console.log('');
console.log('nothing stated is a dash, and a zero is a zero');

ok(F.money(null) === '—' && F.money(0) === '$0',
  'money: "we have not read it" and "it is nothing" are different loans');
ok(F.pct(null) === '—' && F.pct(0) === '0%', 'a percent too');
ok(F.ratio(null) === '—', 'and a DSCR nobody stated is never drawn as 0.000');
ok(F.yesNo(true) === 'Yes' && F.yesNo(false) === 'No' && F.yesNo(0) === '—',
  'a yes/no answered false is "No"; anything that is not a boolean states nothing');

console.log(`\nAll ${checks} checks passed.`);
