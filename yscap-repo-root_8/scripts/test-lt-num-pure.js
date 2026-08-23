'use strict';
/**
 * LT test — A THING THAT IS NOT A FIGURE NEVER BECOMES ONE.
 *
 * Everything on this side arrives as JSON from Encompass or as a row from
 * Postgres, and reading a figure out of one had been written FOUR times
 * (`application/mapper.js`, `file.js`, `locks.js`, `workspace.js`) with four
 * different degrees of care. Only the mapper's tested the TYPE, and only the
 * mapper's wrote down why: `Number(null)`, `Number('')`, `Number(false)` and
 * `Number([])` are ALL a finite, perfectly innocent 0.
 *
 * The other three did not, and it was not theoretical. Handed a lock section
 * whose `lockedRate` arrived as the boolean `true`, `locks.js` reported a NOTE
 * RATE OF 1%; an empty array in `lockedPrice` reported a PRICE OF 0; `[45]` was
 * read as a 45-day lock term. Each is a confident, plausible, entirely wrong
 * figure on the desk somebody locks a loan from, and nothing errors — that is
 * simply what these conversions do when handed the wrong kind of thing.
 *
 * `src/longterm/num.js` is now the one definition for the three that can share
 * it. THE MAPPER DELIBERATELY KEEPS ITS OWN COPY: it is held to "requires
 * nothing at all, so it cannot reach a network or a database even by accident",
 * which is a stronger and more checkable property than any argument about what a
 * required module happens to contain today — and it is not weakened to fit a
 * refactor. The cost of that decision is a second copy, so the cost is paid the
 * way this repo pays it everywhere else (the browser twins of `dealBasis` and
 * `entity-type`): a test that FAILS THE MOMENT THE TWO DISAGREE, over the whole
 * battery, so the copy can never drift into being a different rule.
 *
 * No database, no network.
 */

const fs = require('fs');
const path = require('path');

const shared = require('../src/longterm/num');
const mapper = require('../src/longterm/application/mapper');
const locks = require('../src/longterm/locks');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// ── THE ONE THAT MATTERS ───────────────────────────────────────────────────
console.log('a thing that is not a figure reads as absent, never as a number');

const NOT_FIGURES = [
  ['the boolean true', true, 'Number(true) is 1 — a 1% rate'],
  ['the boolean false', false, 'Number(false) is 0 — a rate of nothing'],
  ['an empty array', [], 'Number([]) is 0 — a price of zero'],
  ['a one-element array', [45], 'Number([45]) is 45 — a lock term nobody typed'],
  ['an object', {}, 'an object is not a figure'],
  ['a Date', new Date(0), 'a Date converts to a number of milliseconds'],
];
for (const [label, v, why] of NOT_FIGURES) {
  check(shared.num(v) === null, `${label} reads as absent — ${why}`);
}
check(shared.num('') === null && shared.num('   ') === null && shared.num(null) === null
  && shared.num(undefined) === null, 'and a blank is absent rather than zero');

console.log('\nand a real figure is read exactly as it is');
check(shared.num(7.125) === 7.125, 'a number');
check(shared.num('7.125') === 7.125, 'a numeric string — which is how Postgres returns a `numeric` column, so refusing these would blank every money figure on this side');
check(shared.num(0) === 0 && shared.num('0') === 0,
  'and a ZERO is a real answer, kept — a fee of nothing is not the same as a fee nobody stated');
check(shared.num(-0.25) === -0.25, 'sign and all');
check(shared.num('abc') === null && shared.num(Infinity) === null && shared.num(NaN) === null,
  'while something that cannot be a number is absent');

console.log('\nand a word is a word, never an object stringified into one');
check(shared.text({}) === null && shared.text([]) === null,
  'an object reads as absent — `String({})` is "[object Object]", which this repository has printed on a screen before');
check(shared.text('  hello  ') === 'hello' && shared.text('') === null && shared.text('  ') === null,
  'text is trimmed, and a blank is absent');
check(shared.text(0) === '0' && shared.text(false) === 'false',
  'a number or a boolean somebody stored as a value is still readable as itself');

// ── The mapper's copy is a copy, not a second rule ─────────────────────────
console.log('\nthe mapper keeps its own copy, and it is the SAME rule');

const mapperSrc = read('src/longterm/application/mapper.js');
check(!/require\(/.test(mapperSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')),
  'the mapper still requires nothing at all — the reason it does not share this module, and a stronger property than any claim about what a required file contains');

const mapperNum = mapper._internals && mapper._internals.num;
const mapperText = mapper._internals && mapper._internals.text;
check(typeof mapperNum === 'function' && typeof mapperText === 'function',
  'the mapper exposes its copy so the two can be compared — an unexported copy is one nothing can hold to anything');

if (typeof mapperNum === 'function') {
  const BATTERY = [
    7.125, '7.125', 0, '0', -0.25, '-0.25', '', '   ', null, undefined, true, false,
    [], [45], {}, new Date(0), 'abc', NaN, Infinity, -Infinity, '1e3', '  12  ', '0.0',
  ];
  const disagree = BATTERY.filter((v) => !Object.is(mapperNum(v), shared.num(v)));
  check(disagree.length === 0,
    `THE ONE THAT MATTERS: the mapper's copy answers identically on every case (${BATTERY.length} of them)${disagree.length ? ` — it does not on: ${disagree.map((d) => JSON.stringify(d)).join(', ')}` : ''}`);
  const disagreeText = BATTERY.filter((v) => !Object.is(mapperText(v), shared.text(v)));
  check(disagreeText.length === 0,
    `…and so does the way it reads a word${disagreeText.length ? ` — except on: ${disagreeText.map((d) => JSON.stringify(d)).join(', ')}` : ''}`);
}

// ── The three that CAN share it, do ────────────────────────────────────────
console.log('\nand the three that can share the one definition do');

for (const f of ['src/longterm/file.js', 'src/longterm/locks.js', 'src/longterm/workspace.js']) {
  const src = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check(/require\('\.\/num'\)/.test(src), `${path.basename(f)} reads its figures through num.js`);
  check(!/^(const|function) num\b/m.test(src),
    `…and no longer carries a private copy, which is how the four drifted apart`);
}

// ── Through the REAL lock reader, which is where it bit ────────────────────
//
// The helper being right in isolation is not the claim. The claim is that the
// lock desk cannot be told a loan is locked at 1%.
console.log('\nand the lock desk can no longer be told a rate nobody set');

const lockOf = (section) => locks.lockFromLoan({ rateLock: section }, {}, {});

const real = lockOf({ lockStatus: 'Locked', lockedRate: 7.125, lockedPrice: 101.5, lockDays: 30 });
check(real.noteRatePct === 7.125 && real.price === 101.5 && real.lockDays === 30,
  'a real lock reads exactly as it always did — nothing was traded for this');

const junk = lockOf({ lockStatus: 'Locked', lockedRate: true, lockedPrice: [], lockDays: [45] });
check(junk.noteRatePct === null,
  'THE ONE THAT MATTERS: a rate that arrived as `true` is absent, not a locked 1%');
check(junk.price === null, '…a price that arrived as an empty array is absent, not 0');
check(junk.lockDays === null, '…and a lock term that arrived as an array is absent, not 45 days');

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
