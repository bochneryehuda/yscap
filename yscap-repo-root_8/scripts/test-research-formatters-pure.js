/**
 * A FORMATTER IS NOT A PARSER, AND THE NAMES DO NOT SAY SO.
 *
 * There are two `num` in this repo and they return different KINDS of thing:
 *
 *   src/lib/research/valuation.js   num(v) -> number | null   (a parser)
 *   app-v2/src/lib/research.js      num(v) -> string, '—'     (a formatter)
 *
 * The server-side one is what every rate in the valuation engine is built on, so
 * reaching for `num` in a portal screen and expecting `number | null` is the
 * natural mistake — and it is silent, because a string is truthy and `'—' == null`
 * is false. It shipped: `money(num(35250))` is `money('35,250')` is
 * `Number('35,250')` is **NaN**, so every per-bedroom / per-bath /
 * per-condition-grade row on the valuation screen rendered "$NaN", and the
 * "no rate" branch beside it was unreachable.
 *
 * Neither eslint nor a green build can see it: it is well-formed JavaScript that
 * produces the wrong string. So the guard is here.
 *
 * TWO HALVES, and the second is the one that lasts:
 *   (A) pin what the formatters ARE, so a future change that makes one return a
 *       number is a decision somebody takes on purpose rather than by accident;
 *   (B) refuse any source that feeds one formatter's output to another, or to
 *       arithmetic — the shape of the bug, wherever it is written.
 *
 * Pure — no DB, no browser. Run: node scripts/test-research-formatters-pure.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// ---------------------------------------------------------------------------
// (A) WHAT THEY ARE
// ---------------------------------------------------------------------------
// Read rather than import: the module is ESM with JSX siblings, and the point is
// the CONTRACT, which the source states.
const lib = fs.readFileSync(path.join(ROOT, 'app-v2/src/lib/research.js'), 'utf8');

// Each of these returns the em-dash for a null, which is only possible from a
// function that returns a STRING.
for (const fn of ['money', 'num', 'sqft', 'pct']) {
  const re = new RegExp(`export const ${fn} = [^;]*'—'`, 's');
  ok(re.test(lib), `app-v2 \`${fn}\` is a FORMATTER — it answers '—' for a null, so it never returns null`);
}

// And the server-side one is a PARSER, which is the whole reason for the mix-up.
const engine = fs.readFileSync(path.join(ROOT, 'src/lib/research/valuation.js'), 'utf8');
ok(/const num = \(v\) => \{[^}]*Number\.isFinite\(n\) \? n : null/s.test(engine),
  'the valuation engine\'s `num` is a PARSER — it answers number | null');

// The live behaviour, so the failure is demonstrated and not merely asserted.
const num = (v, digits = 0) =>
  (v == null || v === '' ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: digits }));
const money = (v) => (v == null || v === '' ? '—' : '$' + Math.round(Number(v)).toLocaleString('en-US'));
ok(String(money(num(35250))) === '$NaN',
  'feeding a formatter to a formatter really does produce "$NaN" — this is the bug, reproduced');
ok(num(0.42) === '0' && num(0.42, 2) === '0.42',
  'and a formatter rounds to WHOLE numbers by default — a +0.42%/month trend prints as "0%" without a digit count');
ok(num(null) !== null && num(null) === '—',
  'a formatter NEVER answers null, so a `== null` refusal check placed after one is dead code');

// ---------------------------------------------------------------------------
// (B) NOBODY DOES IT AGAIN
// ---------------------------------------------------------------------------
// The shape of the mistake: one formatter's result handed to another, or to
// arithmetic. Written as an alternation of the real formatter names rather than a
// generic rule, so it cannot fire on unrelated code.
const F = '(?:money|money0|num|sqft|pct)';
const NESTED = new RegExp(`\\b${F}\\(\\s*${F}\\(`);
const ARITH = new RegExp(`\\b(?:Number|parseInt|parseFloat)\\(\\s*${F}\\(`);

function jsxFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) jsxFiles(p, out);
    else if (/\.(jsx|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

// ONE LINE IS NOT WHERE THE BUG WAS WRITTEN, and a check that only reads one line
// would have missed the real thing. It shipped as two statements:
//
//     const d = num(rate.approxDollarsOnTypicalHouse);   // d is now a STRING
//     return money(d);                                   // …and this is "$NaN"
//
// So the variable is followed: anything assigned from a formatter is a string
// from then on, and handing THAT to a formatter or to arithmetic is the same
// mistake spelled across two lines. Scoping is per FILE, which is deliberately
// blunt — a false positive here is a prompt to rename, and missing the actual
// shape of the defect is the failure that matters.
const ASSIGN = new RegExp(`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${F}\\(`);
const offenders = [];
for (const file of jsxFiles(path.join(ROOT, 'app-v2/src'))) {
  const src = fs.readFileSync(file, 'utf8');
  // A COMMENT EXPLAINING THE TRAP IS NOT THE TRAP — including a one-line block
  // comment. Stripping only `//` and a continuation `*` meant that documenting
  // the bug (`/* money(num(x)) produces "$NaN" */`) tripped the guard written to
  // catch it, and this runs in `npm test`, so a false positive is a red build.
  const lines = src.split('\n').map((l) => l
    .replace(/\/\*[^]*?\*\//g, '')   // a block comment opened and closed on one line
    .replace(/\/\/.*$/, '')          // a line comment
    .replace(/^\s*\*.*$/, '')        // a continuation line of a block comment
    .replace(/^\s*\/\*.*$/, ''));     // the opening line of a multi-line block comment
  const stringVars = new Set();
  for (const code of lines) {
    const m = ASSIGN.exec(code);
    if (m) stringVars.add(m[1]);
  }
  const viaVar = stringVars.size
    ? new RegExp(`(?:\\b${F}|\\bNumber|\\bparseInt|\\bparseFloat)\\(\\s*(?:${[...stringVars]
      .map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\s*[),]`)
    : null;
  lines.forEach((code, i) => {
    if (NESTED.test(code) || ARITH.test(code) || (viaVar && viaVar.test(code))) {
      offenders.push(`${path.relative(ROOT, file)}:${i + 1}  ${src.split('\n')[i].trim().slice(0, 90)}`);
    }
  });
}
ok(offenders.length === 0,
  'no screen feeds a formatter\'s output to another formatter or to arithmetic');
offenders.forEach((o) => console.log('   ' + o));

// The screen that had the bug now reads through its own parser, and that parser
// must be a real one — a `Number.isFinite` test, not a truthiness test, because
// a legitimate rate of 0 is finite and must not read as a refusal.
const screen = fs.readFileSync(path.join(ROOT, 'app-v2/src/screens/StaffValuation.jsx'), 'utf8');
ok(/function readNum\(v\) \{[^}]*Number\.isFinite\(n\) \? n : null/s.test(screen),
  'the valuation screen parses with its own `readNum`, which answers number | null');
ok(/readNum\(kind === 'group' \? rate\.valuePerSqft : rate\.value\)/.test(screen),
  'and every rate row goes through it, so a refusal is a refusal and a zero is a zero');

console.log(failures
  ? `\ntest-research-formatters-pure: ${failures} failed`
  : '\ntest-research-formatters-pure: all passed');
process.exit(failures ? 1 : 0);
