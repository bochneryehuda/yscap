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
 * — the one shape that actually broke production. (There is also no eslint config in this repo, so
 * this scanner is the only automated defense against the class.) Nor does the Vite build: this
 * compiles perfectly and only fails at render time — the same trap CLAUDE.md logs for undeclared
 * identifiers ("a green build does NOT mean the page renders").
 *
 * Pure: parses the source, no browser, no DB, no network.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// `@babel/parser` is a ROOT devDependency on purpose. CI runs `npm ci` in this folder ONLY — it
// never installs app-v2/node_modules — so resolving the parser from the app's toolchain made this
// guard SKIP in CI, i.e. look green while gating nothing. A guard that quietly opts out of the one
// place it matters is worse than no guard. Root first, app-v2 second (a dev who has the frontend
// toolchain but an older root install still gets coverage).
let parser = null;
for (const spec of ['@babel/parser', path.join(ROOT, 'app-v2/node_modules/@babel/parser')]) {
  try { parser = require(spec); break; } catch (_e) { /* try the next */ }
}
if (!parser) {
  // Deliberately a FAILURE, not a skip: the parser is a declared devDependency, so a missing one
  // means the install is broken — and silently passing would re-open the hole described above.
  console.log('test-react-hook-order: FAILED — @babel/parser could not be resolved. It is a root '
    + 'devDependency; run `npm ci` in yscap-repo-root_8. (Never turn this back into a skip: this '
    + 'guard is the only thing standing between a misplaced hook and a full-page outage.)');
  process.exit(1);
}

// BOTH front-ends. V1 (app/src) is frozen and served at /v1, but it is still real React with the
// identical failure mode, and "fix the root, then every place it can surface" applies to the guard
// as much as to the bug.
const ROOTS = ['app-v2/src', 'app/src'];
const FN = /Function(Declaration|Expression)|ArrowFunctionExpression/;

// A call is a hook candidate if it is `useX(...)` or `Something.useX(...)`. That pattern also
// matches ordinary methods (`cache.useEntry(id)`), so it is only TRUSTED inside a function that is
// itself a component or a custom hook — see isComponentLike. Without that scoping the guard
// false-fails on plain code, and because `npm test` gates the deploy job, a false failure would
// block publishing over a non-bug.
const HOOK_CALL = /^use[A-Z]/;
// A React component (PascalCase) or a custom hook (useX) — the only places hook rules apply.
const COMPONENT_LIKE = /^([A-Z]|use[A-Z])/;

function sourceFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(jsx?|tsx?)$/.test(e.name)) out.push(p);
    }
  })(dir);
  return out;
}

// The function's own name, including `const Foo = () => {}` / `const Foo = function () {}`.
function functionName(node, parent) {
  if (node.id && node.id.name) return node.id.name;
  if (parent && parent.type === 'VariableDeclarator' && parent.id && parent.id.name) return parent.id.name;
  if (parent && parent.type === 'Property' && parent.key && parent.key.name) return parent.key.name;
  return null;
}

/**
 * Does this statement return on SOME path, at this function's own level?
 *
 * The first version only understood `return` and `if (c) return` — which silently missed a return
 * inside try/catch, an `else`, a `switch` case, a loop body, a labeled or bare block, and a nested
 * `if (a) if (b) return`. Each of those produces exactly the same crash, so each is handled here.
 * Function boundaries are never crossed: a `return` inside a callback belongs to the callback.
 */
function returnsAtThisLevel(node) {
  if (!node || typeof node.type !== 'string') return false;
  if (node.type === 'ReturnStatement') return true;
  if (FN.test(node.type)) return false;                       // a nested function's return is its own
  switch (node.type) {
    case 'IfStatement':
      return returnsAtThisLevel(node.consequent) || returnsAtThisLevel(node.alternate);
    case 'BlockStatement':
    case 'Program':
      return node.body.some(returnsAtThisLevel);
    case 'TryStatement':
      return returnsAtThisLevel(node.block)
        || (node.handler && returnsAtThisLevel(node.handler.body))
        || returnsAtThisLevel(node.finalizer);
    case 'SwitchStatement':
      return node.cases.some((c) => c.consequent.some(returnsAtThisLevel));
    case 'LabeledStatement':
      return returnsAtThisLevel(node.body);
    case 'ForStatement': case 'ForInStatement': case 'ForOfStatement':
    case 'WhileStatement': case 'DoWhileStatement':
      return returnsAtThisLevel(node.body);
    case 'WithStatement':
      return returnsAtThisLevel(node.body);
    default:
      return false;
  }
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
      if (name && HOOK_CALL.test(name)) out.push({ name, line: n.loc.start.line });
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
let scanned = 0, componentsChecked = 0;

for (const rel of ROOTS) {
  for (const file of sourceFiles(path.join(ROOT, rel))) {
    const src = fs.readFileSync(file, 'utf8');
    let ast;
    try {
      ast = parser.parse(src, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
    } catch (e) {
      violations.push(`${path.relative(ROOT, file)}: could not be parsed — ${e.message}`);
      continue;
    }
    scanned++;
    (function visit(n, parent) {
      if (!n || typeof n.type !== 'string') return;
      if (FN.test(n.type) && n.body && n.body.type === 'BlockStatement') {
        // Only a component / custom hook is bound by the rules of hooks. This keeps an ordinary
        // helper that happens to call `something.useEntry()` after a guard clause from failing CI.
        const name = functionName(n, parent);
        if (name && COMPONENT_LIKE.test(name)) {
          componentsChecked++;
          let returnedAt = null;
          for (const st of n.body.body) {
            // Scan the statement for hooks FIRST, then decide whether it returns. A returning
            // statement can itself contain a hook (`return <div>{useMemo(...)}</div>`), which the
            // first version skipped entirely by `continue`ing past every return.
            if (returnedAt != null) {
              for (const h of hookCallsIn(st)) {
                violations.push(
                  `${path.relative(ROOT, file)}:${h.line} — ${h.name}() is called AFTER an early `
                  + `return on line ${returnedAt}, inside ${name}(). Move every hook above the first `
                  + 'return, or React will crash the page with "Rendered more hooks than during the '
                  + 'previous render".');
              }
            }
            if (returnedAt == null && returnsAtThisLevel(st)) returnedAt = st.loc.start.line;
          }
        }
      }
      for (const k of Object.keys(n)) {
        const v = n[k];
        if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && visit(c, n));
        else if (v && typeof v.type === 'string') visit(v, n);
      }
    })(ast.program, null);
  }
}

if (violations.length) {
  console.log(`test-react-hook-order: ${violations.length} violation(s) in ${scanned} file(s)\n`);
  for (const v of violations) console.log('  FAIL: ' + v);
  process.exit(1);
}
console.log(`test-react-hook-order: ${scanned} files scanned (${componentsChecked} components/hooks), `
  + '0 hooks after an early return');
process.exit(0);
