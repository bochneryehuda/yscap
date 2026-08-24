/**
 * A MODULE'S DEFAULT EXPORT IS THE THING ITS IMPORTERS THINK THEY ARE MOUNTING —
 * the crash-free class that took the whole construction-draw centre down on
 * 2026-08-21 and stayed down, silently, for three days.
 *
 * WHAT HAPPENED. A documentation comment was inserted between `export default`
 * and the function it belonged to, while a NEW function was added underneath it:
 *
 *     export default /* THE PAYOFF DEMAND, SAID BIG …
 *        … eleven lines of comment …                          *\/
 *     function PayoffDemandBanner({ payoff, started }) {       // <-- exported
 *       if (!payoff || !payoff.at) return null;
 *     }
 *
 *     function DrawsPanel({ appId }) {                         // <-- NOT exported
 *
 * A comment is whitespace to the parser, so `export default` bound itself to the
 * next declaration it found — the banner. `StaffFileDraws.jsx` still said
 * `import DrawsPanel from '../components/DrawsPanel.jsx'`, so it mounted the
 * BANNER under that name, handed it `{ appId }`, and the banner's own first line
 * — `if (!payoff || !payoff.at) return null` — returned null. Every draw centre
 * in the system rendered its header, its breadcrumb and its two buttons over an
 * empty page.
 *
 * WHY NOTHING CAUGHT IT, WHICH IS THE ACTUAL DEFECT.
 *   · It is VALID JAVASCRIPT. There is no syntax error, so `vite build` is green,
 *     `test-source-parses-pure.js` is green, and eslint `no-undef` is green.
 *   · NOTHING THREW. The wrong component rendered perfectly — it just rendered
 *     nothing — so the ErrorBoundary never fired and no console error appeared.
 *     An empty page is indistinguishable from a page with no data.
 *   · The feature's OWN guard passed. `test-draw-routes-wired-pure.js` asserts
 *     `/<PayoffDemandBanner payoff=\{payoff_demand\}/` appears in the panel's
 *     source — and it did, inside a function nothing could reach any more. That
 *     suite's own header warns that "a back end is not a feature"; this is the
 *     same lesson one layer up: SOURCE TEXT IS NOT A MOUNTED COMPONENT.
 *
 * THE TWO RULES, both mechanical, both zero-false-positive on this tree.
 *
 *   A. `export default` is IMMEDIATELY followed by its declaration. A comment
 *      between the two is the defect above, and it is never worth writing on
 *      purpose — put the comment above the `export default`, which is where every
 *      other component in this repo already puts it.
 *
 *   B. Every default IMPORT binds the name its target module actually DECLARES.
 *      Measured across app-v2: 367 default-import bindings, 367 agreements. So a
 *      file that says `import DrawsPanel from './DrawsPanel.jsx'` is asserting a
 *      fact this repo keeps everywhere, and a violation means the importer is
 *      mounting something other than what it is named for.
 *
 * Rule A catches the exact bug; rule B catches the class it belongs to — any
 * future rebinding, however it is spelled. A file whose default export is a
 * deliberate expression (`export default withThing(X)`, an inline arrow, an
 * object) is not a component-mount contract and is skipped by rule B, but is
 * still held to rule A.
 *
 * Pure — it reads the source. No DB, no network, no execution.
 * Run: node scripts/test-default-export-binding-pure.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'app-v2', 'src');

let n = 0;
const ok = (cond, what) => { assert.ok(cond, what); n++; };

// Every front-end source file, once.
function sourceFiles(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|jsx|mjs)$/.test(e.name)) out.push(p);
    }
  })(dir);
  return out.sort();
}

const files = sourceFiles(APP);
ok(files.length > 100, 'the front-end tree was found (a moved folder must fail loudly, not pass vacuously)');

/* ── RULE A ─────────────────────────────────────────────────────────────────────
   `export default` immediately followed by its declaration.

   Matched on the RAW source deliberately: the whole defect is a comment sitting
   where the parser sees whitespace, so stripping comments first would erase the
   very thing being looked for. */
{
  const offenders = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    // `export default` followed by anything that opens a comment before the
    // declaration starts. Also catches `export default // …` on one line.
    const re = /\bexport\s+default\s*(\/\*|\/\/)/g;
    let m;
    while ((m = re.exec(src))) {
      const line = src.slice(0, m.index).split('\n').length;
      offenders.push(`${path.relative(ROOT, f)}:${line}`);
    }
  }
  ok(offenders.length === 0,
    'no `export default` is separated from its declaration by a comment — a comment there '
    + 'silently binds the export to whatever function comes next, with no syntax error and no '
    + 'crash. Move the comment ABOVE the `export default`. Offenders: ' + offenders.join(', '));
}

/* ── RULE B ─────────────────────────────────────────────────────────────────────
   A default import binds the name its target declares. */
{
  // module path -> the name it declares on its default export (function or class).
  const declares = new Map();
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const m = /\bexport\s+default\s+(?:async\s+)?(?:function\*?|class)\s+([A-Za-z0-9_$]+)/.exec(src);
    if (m) declares.set(path.resolve(f), m[1]);
  }
  ok(declares.size > 100, 'named default exports were found (a regex that stops matching must fail, not pass)');

  // Resolve a relative specifier the way the bundler does, so an extensionless
  // or directory import still finds its file.
  const resolve = (fromFile, rel) => {
    const base = path.resolve(path.dirname(fromFile), rel);
    for (const c of [base, base + '.jsx', base + '.js', base + '.mjs',
      path.join(base, 'index.jsx'), path.join(base, 'index.js')]) {
      if (declares.has(c)) return c;
    }
    return null;
  };

  const offenders = [];
  let bindings = 0;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    // `import Name from './x.jsx'` and `import Name, { a, b } from './x.jsx'`.
    // A pure named import (`import { a } from …`) has no default binding and is
    // skipped by the leading identifier requirement.
    const re = /\bimport\s+([A-Za-z0-9_$]+)\s*(?:,\s*\{[^}]*\}\s*)?from\s*['"](\.[^'"]+)['"]/g;
    let m;
    while ((m = re.exec(src))) {
      const target = resolve(f, m[2]);
      if (!target) continue;              // not a named-default module — nothing to compare
      bindings++;
      if (declares.get(target) !== m[1]) {
        offenders.push(`${path.relative(ROOT, f)} imports "${m[1]}" from ${m[2]}, `
          + `which declares "${declares.get(target)}"`);
      }
    }
  }
  ok(bindings > 200, 'default-import bindings were found (the scan must not silently match nothing)');
  ok(offenders.length === 0,
    'every default import binds the name its module declares — a mismatch means the importer is '
    + 'mounting something other than what it calls it. Offenders: ' + offenders.join('; '));
}

/* ── THE FILE THIS WAS BORN FROM ────────────────────────────────────────────────
   Named explicitly as well as covered by the rules above, so the specific
   regression is legible in the failure output rather than only in a list. */
{
  const panel = fs.readFileSync(path.join(APP, 'components', 'DrawsPanel.jsx'), 'utf8');
  ok(/\bexport\s+default\s+function\s+DrawsPanel\b/.test(panel),
    'DrawsPanel.jsx default-exports DrawsPanel — the construction-draw desk itself, not the '
    + 'payoff-demand banner that sits above it');

  const screen = fs.readFileSync(path.join(APP, 'screens', 'StaffFileDraws.jsx'), 'utf8');
  ok(/import\s+DrawsPanel\s+from\s+'\.\.\/components\/DrawsPanel\.jsx'/.test(screen)
    && /<DrawsPanel\s+appId=/.test(screen),
  '…and the full-window draw centre still mounts it');
}

console.log(`test-default-export-binding-pure: all ${n} checks passed `
  + `(${files.length} front-end files scanned).`);
