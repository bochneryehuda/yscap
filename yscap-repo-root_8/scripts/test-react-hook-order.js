'use strict';
/**
 * GUARD — no React hook may be called AFTER a conditional early `return` (owner-reported outage,
 * 2026-07-26: "we can't even access the document review section").
 *
 * Root cause of that outage, and the reason this test exists: React identifies a hook by its CALL
 * ORDER within a render. A hook placed after an early return runs on the renders that get past the
 * return and NOT on the ones that bail out — so the count changes between renders and React aborts
 * the entire tree with "Rendered more hooks than during the previous render" (minified #310). The
 * app's ErrorBoundary turns that into the full-screen "Something went wrong" card, so ONE misplaced
 * hook takes down the whole file page for every user.
 *
 * `UnderwritingPanel` had exactly this: `if (loading) return <p>Loading…</p>;` and then a `useMemo`
 * further down. First paint returned early, the second paint reached the useMemo, and the page died.
 *
 * Why a bespoke check instead of a lint rule: eslint's `react-hooks/rules-of-hooks` catches a hook
 * inside an `if`/loop/callback, but it does NOT catch a hook that merely sits after an early return
 * — the one shape that actually broke production. Nor does the Vite build: this compiles perfectly
 * and only fails at render time (the same trap CLAUDE.md logs for undeclared identifiers — "a green
 * build does NOT mean the page renders").
 *
 * Pure: parses the source, no browser, no DB, no network.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// @babel/parser ships inside the app's own toolchain; if it isn't installed (a backend-only
// checkout) the guard SKIPS rather than failing the suite for an unrelated reason.
let parser = null;
try { parser = require(path.join(ROOT, 'app-v2/node_modules/@babel/parser')); } catch (_e) { /* below */ }
if (!parser) {
  console.log('test-react-hook-order: SKIPPED (app-v2 toolchain not installed)');
  process.exit(0);
}

const HOOK_NAME = /^use[A-Z]/;
const FN = /Function(Declaration|Expression)|ArrowFunctionExpression/;

function sourceFiles(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.jsx?$/.test(e.name)) out.push(p);
    }
  })(dir);
  return out;
}

// Does this statement return on some path at its own top level? (`return x` or `if (…) return x`)
function isEarlyReturn(st) {
  if (st.type === 'ReturnStatement') return true;
  if (st.type !== 'IfStatement' || !st.consequent) return false;
  const c = st.consequent;
  if (c.type === 'ReturnStatement') return true;
  return c.type === 'BlockStatement' && c.body.some((s) => s.type === 'ReturnStatement');
}

// Hook calls belonging to THIS render pass — descend through the statement but stop at a nested
// function boundary (a callback's hooks are that function's problem, not this render's).
function hookCallsIn(node) {
  const out = [];
  (function walk(n) {
    if (!n || typeof n.type !== 'string') return;
    if (FN.test(n.type)) return;
    if (n.type === 'CallExpression' && n.callee) {
      const c = n.callee;
      const name = c.type === 'Identifier' ? c.name
        : (c.type === 'MemberExpression' && c.property && c.property.name) || null;   // React.useMemo(…)
      if (name && HOOK_NAME.test(name)) out.push({ name, line: n.loc.start.line });
    }
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach((x) => x && typeof x.type === 'string' && walk(x));
      else if (v && typeof v.type === 'string') walk(v);
    }
  })(node);
  return out;
}

const violations = [];
let scanned = 0;

for (const file of sourceFiles(path.join(ROOT, 'app-v2/src'))) {
  const src = fs.readFileSync(file, 'utf8');
  let ast;
  try {
    ast = parser.parse(src, { sourceType: 'module', plugins: ['jsx'] });
  } catch (e) {
    violations.push(`${path.relative(ROOT, file)}: could not be parsed — ${e.message}`);
    continue;
  }
  scanned++;
  (function visit(n) {
    if (!n || typeof n.type !== 'string') return;
    if (FN.test(n.type) && n.body && n.body.type === 'BlockStatement') {
      let returnedAt = null;
      for (const st of n.body.body) {
        if (isEarlyReturn(st)) { if (returnedAt == null) returnedAt = st.loc.start.line; continue; }
        if (returnedAt != null) {
          for (const h of hookCallsIn(st)) {
            violations.push(
              `${path.relative(ROOT, file)}:${h.line} — ${h.name}() is called AFTER an early return `
              + `on line ${returnedAt}. Move every hook above the first return, or React will crash `
              + `the page with "Rendered more hooks than during the previous render".`);
          }
        }
      }
    }
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && visit(c));
      else if (v && typeof v.type === 'string') visit(v);
    }
  })(ast.program);
}

if (violations.length) {
  console.log(`test-react-hook-order: ${violations.length} violation(s) in ${scanned} file(s)\n`);
  for (const v of violations) console.log('  FAIL: ' + v);
  process.exit(1);
}
console.log(`test-react-hook-order: ${scanned} files scanned, 0 hooks after an early return`);
process.exit(0);
