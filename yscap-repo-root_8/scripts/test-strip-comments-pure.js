'use strict';
/**
 * TEST — THE SHARED COMMENT STRIPPER, and the real defect it was written for.
 *
 * A source guard must read the CODE: a rule's own explanation names the thing the
 * rule forbids, so a guard that reads comments fails on its own explanation. 103
 * guards in `scripts/` grew the same two-line regex to strip them, and that idiom
 * removes BLOCK comments FIRST — so it cannot know that a `/*` it found is inside
 * a LINE comment or inside a string.
 *
 * THE DEFECT IT CAUSED, reproduced verbatim in section A. Line 3 of
 * `app-v2/src/longterm/api.js` is prose containing `/api/lt/*`. While that file
 * held no closing `*` `/` anywhere, every guard over it was correct BY LUCK; the
 * moment a genuine block comment was added 282 lines later, that stray `/*`
 * opened a "block comment" that ran to it and ate 19,048 of 20,012 characters —
 * so `clickupStatusReviews`, plainly present, read as ABSENT.
 *
 * AND THE DIRECTION THAT IS WORSE: an assertion of the shape "X must NOT appear"
 * PASSES over a file the stripper swallowed. A guard reporting a clean bill of
 * health on a file it never read is invisible in a green build, which is why the
 * fix is one shared correct definition rather than a patch to the one file that
 * happened to go red.
 *
 * PURE. No database, no network, no browser.
 */

const fs = require('fs');
const path = require('path');
const { stripComments, stripToProse } = require('./lib/strip-comments.js');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

/** The idiom this module replaces, kept EXACTLY as the 103 guards spell it — the
    control that proves each case below is about the fix and not about the fixture. */
const naive = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

// ── A. The reported defect, on the real file ────────────────────────────────
console.log('the file that actually broke');

const apiRaw = read('app-v2/src/longterm/api.js');
const NEEDLE = /clickupStatusReviews: \(limit\) =>/;

check(NEEDLE.test(apiRaw), 'the call really is in the file — the guard was not wrong about the rule');
check(!NEEDLE.test(naive(apiRaw)),
  'and the OLD stripper loses it, so this test is about a real defect and not a hypothetical');
check(NEEDLE.test(stripComments(apiRaw)), 'the shared stripper keeps it');
/* HOW BIG THE DAMAGE IS, COUNTED IN LIVE CODE — not in bytes.
   This asked for a 5:1 BYTE ratio and went red on a commit that added a block
   comment to `api.js` around line 240. Nothing about the defect changed: the
   stray `/*` on line 3 still opens a fake block, it simply now runs to that new
   `*` `/` instead of to the one 282 lines down, so it swallows fewer BYTES.
   A byte ratio is a statement about how much COMMENTARY the file happens to
   carry, which moves every time anybody writes a note in it; the defect is
   about how much CODE is lost. So the claim is made in the terms it is really
   about — and it comes out stronger for it: the naive idiom does not lose a
   token, it loses the module's own `import` and its `export const ltApi = {`,
   which is to say it loses the file. The floor sits far under the measured
   figure (86 of 156 live lines at the time of writing) because the exact count
   legitimately moves with the file; what cannot move, while a line comment
   above the export contains a stray `/*`, is that the loss is a long
   contiguous run rather than a slip. */
const liveLines = (t) => new Set(String(t).split('\n').map((l) => l.trim()).filter(Boolean));
{
  const kept = liveLines(stripComments(apiRaw));
  const naiveKept = liveLines(naive(apiRaw));
  const lost = [...kept].filter((l) => !naiveKept.has(l));
  check(lost.length >= 10,
    `the old idiom loses a long run of this file's live code, not a token (${lost.length} lines)`);
  check(lost.some((l) => /^export const ltApi = \{/.test(l)),
    '…including the module\u2019s own export, which is to say it loses the file');
}
check(/\/api\/lt\//.test(apiRaw) && !/Every call goes to/.test(stripComments(apiRaw)),
  'the line comment carrying the stray slash-star is itself removed, comment and all');

// ── B. A `/*` that is not a comment ─────────────────────────────────────────
console.log('a slash-star that is not a comment opens nothing');

const inLine = `// a note about /api/lt/*, harmless\nconst keep = 1;\n/* a real block */\nconst also = 2;\n`;
check(/const keep = 1/.test(stripComments(inLine)) && /const also = 2/.test(stripComments(inLine)),
  'inside a LINE comment — the case that broke, reduced');
check(!/const keep = 1/.test(naive(inLine)), '…which the old idiom loses (control)');

const inStr = `const glob = 'src/**/*.js';\nconst after = 3;\n/* later */\nconst tail = 4;\n`;
check(/const after = 3/.test(stripComments(inStr)) && /const tail = 4/.test(stripComments(inStr)),
  'inside a STRING — a glob or a wildcard MIME type is ordinary code');
check(/'src\/\*\*\/\*\.js'/.test(stripComments(inStr)), 'and the string itself is returned byte for byte');

const inTpl = 'const u = `${base}/api/lt/*`;\nconst z = 5;\n/* x */\nconst w = 6;\n';
check(/const z = 5/.test(stripComments(inTpl)) && /const w = 6/.test(stripComments(inTpl)),
  'inside a TEMPLATE LITERAL');

// ── C. A `//` that is not a comment ─────────────────────────────────────────
console.log('a double slash that is not a comment deletes nothing');

const url = `const u = 'https://example.com/x';\nconst v = 7;\n`;
check(/example\.com\/x/.test(stripComments(url)) && /const v = 7/.test(stripComments(url)),
  'a URL in a string keeps its path');
const tplUrl = 'const u = `https://example.com/${id}`;\n';
check(/example\.com/.test(stripComments(tplUrl)) && /\$\{id\}/.test(stripComments(tplUrl)),
  'a URL in a template literal keeps its path and its expression');
const re = `const r = /[//]/;\nconst q = 8;\n`;
check(/const q = 8/.test(stripComments(re)), 'a REGEX containing a double slash does not eat its own line');

// ── D. Real comments are still removed — the whole point ────────────────────
console.log('and every real comment is still removed');

check(!/secret/.test(stripComments('const a = 1; // secret\n')), 'a line comment goes');
check(!/secret/.test(stripComments('/* secret */ const a = 1;\n')), 'a block comment goes');
check(!/secret/.test(stripComments('const a = 1; /* secret\n still secret */ const b = 2;\n')),
  'a multi-line block comment goes entirely');
check(/const b = 2/.test(stripComments('const a = 1; /* x\n y */ const b = 2;\n')),
  'and the code after it survives');
check(!/inner/.test(stripComments('const t = `${ /* inner */ x }`;\n')),
  'a comment inside a template expression is a real comment');
check(/text/.test(stripComments('const t = `text // not a comment`;\n')),
  'while a double slash in the literal TEXT is not');

// ── E. Line numbers do not move ─────────────────────────────────────────────
console.log('the output has the same shape as the input');

const lines = 'const a = 1;\n/* one\n two\n three */\nconst b = 2;\n';
const count = (s) => (s.match(/\n/g) || []).length;
check(count(stripComments(lines)) === count(lines),
  'a block comment leaves its newlines, so a line-oriented assertion still means what it says');
check(count(naive(lines)) !== count(lines), '…which the old idiom does not (control)');

// ── F. It never throws, whatever it is handed ───────────────────────────────
console.log('it answers for anything, including nonsense');

for (const [label, input] of [
  ['an unterminated block comment', 'const a = 1;\n/* never closed\n'],
  ['an unterminated string', "const a = 'never closed\nconst b = 2;\n"],
  ['an unterminated template', 'const a = `never closed\n'],
  ['an unterminated regex', 'const a = /never closed\n'],
  ['an empty file', ''],
  ['null', null],
  ['undefined', undefined],
  ['a number', 42],
]) {
  let ok = true;
  try { stripComments(input); } catch (_) { ok = false; }
  check(ok, `${label} is answered rather than thrown at`);
}

// ── G. The prose form ───────────────────────────────────────────────────────
console.log('the prose form collapses wrapping, which is what a wording check needs');
check(stripToProse('const s = "a\n   b";\n') === 'const s = "a b"; ',
  'every run of whitespace becomes one space');
check(!/note/.test(stripToProse('// note\nconst a = 1;\n')), 'and comments are gone from it too');

// ── H. The whole repo, both directions ──────────────────────────────────────
console.log('measured across the repo, not asserted');

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'portal') continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|jsx|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}
const root = path.join(__dirname, '..');
const files = [...walk(path.join(root, 'src')), ...walk(path.join(root, 'app-v2/src'))];
check(files.length > 500, `every source file is read (${files.length} files)`);

let swallowed = 0;
let mismatched = 0;
for (const f of files) {
  const raw = fs.readFileSync(f, 'utf8');
  const mine = stripComments(raw);
  // The stripper may only ever REMOVE. Anything it keeps must be in the original.
  if (mine.replace(/\s+/g, '').length > raw.replace(/\s+/g, '').length) mismatched += 1;
  if (naive(raw).replace(/\s+/g, '').length + 40 < mine.replace(/\s+/g, '').length) swallowed += 1;
}
check(mismatched === 0, 'the stripper never invents a character — it only ever removes');
check(swallowed > 0,
  `the old idiom really does swallow live code (${swallowed} source files), which is why this is shared`);

// ── I. The strongest proof available: it still parses ───────────────────────
// A regex over the output can only show that some string survived. Handing the
// result to the JavaScript parser asks the real question — did removing the
// comments leave a valid program? — over every server file at once. It judges
// only files that parsed BEFORE, so a file broken for its own reasons is not
// blamed on the stripper.
console.log('and the stripped output is still a valid program');

const vm = require('vm');
const srcFiles = walk(path.join(root, 'src'));
let parsable = 0;
const brokeMine = [];
const brokeNaive = [];
for (const f of srcFiles) {
  if (!/\.js$/.test(f)) continue;
  const raw = fs.readFileSync(f, 'utf8');
  try { new vm.Script(raw, { filename: f }); } catch (_) { continue; }
  parsable += 1;
  try { new vm.Script(stripComments(raw), { filename: f }); } catch (e) { brokeMine.push(f); }
  try { new vm.Script(naive(raw), { filename: f }); } catch (e) { brokeNaive.push(f); }
}
check(parsable > 800, `every server file that parses on its own is re-parsed after stripping (${parsable} files)`);
check(brokeMine.length === 0,
  `the shared stripper leaves every one of them a valid program${brokeMine.length ? ` — broke ${brokeMine[0]}` : ''}`);
check(brokeNaive.length > 0,
  `while the old idiom produces code that will not parse (${brokeNaive.length} files) — the control`);

console.log(failures ? `\n${failures} FAILED` : `\nstrip-comments (pure): all checks passed`);
process.exit(failures ? 1 : 0);
