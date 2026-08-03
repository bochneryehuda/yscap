/**
 * EVERY SOURCE FILE PARSES — and the specific trap that keeps breaking them.
 *
 * A BACKTICK INSIDE A SQL COMMENT INSIDE A JS TEMPLATE LITERAL ENDS THE STRING.
 * This repo writes long SQL in template literals and documents its SQL in `--`
 * comments, so the two meet constantly, and a comment that names a column the way
 * prose names a column — with backticks around it — silently terminates the query
 * and turns the rest of the file into garbage:
 *
 *     const SQL = `SELECT a, b
 *       -- `eff_latitude` is generated (db/412)      <-- the string ends HERE
 *       FROM t`;
 *
 * It has now happened three times (`flips.js`, `search.js` twice) and CLAUDE.md
 * carries a warning about it, which is evidently not a mechanism. This is the
 * mechanism.
 *
 * WHY A WHOLE-TREE PARSE RATHER THAN A REGEX FOR BACKTICKS: the failure is
 * ALWAYS a SyntaxError, whatever produced it, so parsing catches this class and
 * every sibling (an unclosed literal, a stray `${`, a mangled patch) with no
 * false positives and nothing to keep in sync. A regex would have to model JS
 * string state to avoid flagging every legitimate nested backtick.
 *
 * WHY IT IS WORTH ITS OWN TEST rather than relying on the suite: the error only
 * surfaces when something REQUIREs the file, so it lands hundreds of tests deep,
 * attributed to whichever unrelated test happened to pull it in first — the last
 * one reported it as `uncaughtException: Unexpected identifier 'eff_'` inside the
 * email-threading tests. Running first, it names the file and the line.
 *
 * Pure — a parse, no execution, so a module with side effects is never run.
 * Run: node scripts/test-source-parses-pure.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const DIRS = ['src', 'scripts'];
const SKIP_DIR = new Set(['node_modules', '.git', 'fixtures', '__fixtures__']);

let pass = 0;
const bad = [];

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) walk(path.join(dir, e.name), out); }
    else if (e.isFile() && e.name.endsWith('.js')) out.push(path.join(dir, e.name));
  }
  return out;
}

const files = DIRS.flatMap((d) => walk(path.join(ROOT, d), []));
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  try {
    // COMPILE, NEVER RUN. `new vm.Script` parses and throws the identical
    // SyntaxError `require` would, without executing a line — so a module that
    // opens a database or starts a server on load is safe to check.
    // eslint-disable-next-line no-new
    new vm.Script(src, { filename: f, produceCachedData: false });
    pass++;
  } catch (e) {
    bad.push({ file: path.relative(ROOT, f), message: String(e && e.message || e) });
  }
}

for (const b of bad) console.log(`FAIL ${b.file} — ${b.message}`);

// The trap itself, proven to be what we think it is, so this file explains the
// failure to whoever hits it next.
const TRAP = 'const SQL = `SELECT a\n  -- `col` is generated\n  FROM t`;';
let trapThrew = false;
try { new vm.Script(TRAP, { filename: 'trap.js' }); } catch (_) { trapThrew = true; }
if (!trapThrew) {
  bad.push({ file: '(self-check)', message: 'a backtick inside a SQL comment in a template literal no longer breaks the parse — this test has stopped testing what it claims' });
  console.log('FAIL the backtick trap no longer reproduces — this guard is no longer guarding anything');
}

console.log(bad.length
  ? `\ntest-source-parses-pure: ${pass} files parsed, ${bad.length} FAILED`
  : `\ntest-source-parses-pure: ${pass} files parsed, all clean`);
process.exit(bad.length ? 1 : 0);
