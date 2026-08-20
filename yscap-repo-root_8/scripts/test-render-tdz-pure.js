/**
 * THE FRONT END MAY NOT READ A `const` BEFORE IT IS DECLARED — the crash class
 * that took every file's order section down on 2026-08-20.
 *
 * WHAT HAPPENED. ClosingPrepCard mounted the shared "send it later" control and
 * keyed its hook on `placed`:
 *
 *     const sched = useScheduledSends(appId, [placed]);      // line 312
 *     …
 *     const placed = order.status !== 'not_ordered' && …;    // line 404
 *
 * `const` is hoisted but stays UNINITIALISED until its declaration runs (the
 * temporal dead zone), so line 312 threw
 *
 *     ReferenceError: Cannot access 'placed' before initialization
 *
 * on EVERY render, unconditionally. The Orders desk renders that card for every
 * file, and the file screen restores the room the reader was last in — so the
 * order section died in the ErrorBoundary on every file, and every file whose
 * remembered room WAS Orders died the moment it opened. Users saw only
 * "Something went wrong".
 *
 * WHY NOTHING CAUGHT IT, WHICH IS THE ACTUAL DEFECT.
 *   · `vite build` does not care: TDZ is a RUNTIME error, and the bug survived
 *     minification intact into the shipped bundle (`P=L2(t,[B])`, with `B`
 *     declared 2,520 characters later).
 *   · `test-source-parses-pure.js` walks `src/` and `scripts/` only — it has
 *     never read a line of `app-v2/`.
 *   · The feature's own guard, `test-schedule-send-ui-pure.mjs`, asserts that the
 *     control is MOUNTED (`/<ScheduleButton\b/`). It passed on a component that
 *     could not render at all. A source-text assertion is not a proof.
 * So the front end had no mechanism that reads it as CODE. This is that
 * mechanism, and it is deliberately about the class, not this one line.
 *
 * WHAT IT FLAGS, AND WHY THE RULE IS EXACTLY THIS SHAPE. For every function, a
 * reference to a `const`/`let`/`class` binding of that SAME function's scope that
 * (a) appears textually before the declaration and (b) is reached SYNCHRONOUSLY
 * when the function runs — i.e. is not nested inside another function body. Both
 * halves are load-bearing:
 *   · same scope only. A component that reads a module-level `const TH = …`
 *     declared at the bottom of its own file is FINE: the module finished
 *     evaluating long before React called the component. This repo has ~120 of
 *     those and every one is correct. A rule that flagged them would be turned
 *     off within a week, which is worth more than the handful it would catch.
 *   · synchronous only. `const f = () => placed;` written above `const placed`
 *     is FINE — the arrow body runs later, after the declaration. Event handlers
 *     and effect callbacks are the overwhelming majority of the "used before
 *     defined" hits in this tree, and none of them can throw.
 * What is left is precisely the set that throws the instant the function is
 * called, which for a component means the instant it renders.
 *
 * Pure — @babel/parser (already a dependency) reads the source; nothing executes,
 * so no browser global is needed and no module with side effects is loaded.
 * Run: node scripts/test-render-tdz-pure.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');

const ROOT = path.join(__dirname, '..');
// The whole front end, both products. `longterm/` is included deliberately: the
// LT build is a separate product (AGENTS.md §2) but this is a JavaScript fact
// about JavaScript files, not an RTL rule reaching across the wall.
// An explicit directory argument exists so the guard can be pointed at a mutated
// copy of the tree and PROVEN to fail — a checker nobody has watched fail is a
// decoration. With no argument it checks the real front end.
const DIRS = process.argv[2] ? [process.argv[2]] : ['app-v2/src'];
const SKIP_DIR = new Set(['node_modules', 'dist', '__fixtures__', 'fixtures']);
const EXT = new Set(['.js', '.jsx', '.mjs']);

function walk(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) walk(p, out); }
    else if (e.isFile() && EXT.has(path.extname(e.name))) out.push(p);
  }
  return out;
}

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression',
  'ObjectMethod', 'ClassMethod', 'ClassPrivateMethod',
]);
// A binding in one of these is in a temporal dead zone before its declarator.
// `var` and `function` are hoisted AND initialised, so they are never TDZ.
const TDZ_KINDS = new Set(['const', 'let']);

/** Every Identifier bound by a declarator's id pattern (handles destructuring). */
function patternNames(node, out) {
  if (!node || typeof node !== 'object') return out;
  switch (node.type) {
    case 'Identifier': out.push(node.name); break;
    case 'ObjectPattern': for (const p of node.properties) patternNames(p.type === 'RestElement' ? p.argument : p.value, out); break;
    case 'ArrayPattern': for (const el of node.elements) if (el) patternNames(el.type === 'RestElement' ? el.argument : el, out); break;
    case 'AssignmentPattern': patternNames(node.left, out); break;
    case 'RestElement': patternNames(node.argument, out); break;
    default: break;
  }
  return out;
}

/** Walk every child node, calling visit(node, parent). */
function eachChild(node, fn) {
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue;
    const v = node[key];
    if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') fn(c); }
    else if (v && typeof v.type === 'string') fn(v);
  }
}

/**
 * Collect the TDZ bindings declared DIRECTLY in a block's own statement list
 * (not inside a nested block or function), each with the offset at which it
 * becomes initialised.
 *
 * The offset is the DECLARATOR's end, never the statement's — `const a = 1, b =
 * a + 1;` is legal, and keying on the statement end would flag `b`'s perfectly
 * good read of `a`.
 */
function blockBindings(block) {
  const map = new Map();
  const body = block && (block.type === 'BlockStatement' || block.type === 'Program' ? block.body : null);
  if (!body) return map;
  for (const stmt of body) {
    if (stmt.type === 'VariableDeclaration' && TDZ_KINDS.has(stmt.kind)) {
      for (const d of stmt.declarations) {
        for (const name of patternNames(d.id, [])) if (!map.has(name)) map.set(name, d.end);
      }
    } else if (stmt.type === 'ClassDeclaration' && stmt.id) {
      if (!map.has(stmt.id.name)) map.set(stmt.id.name, stmt.end);
    }
  }
  return map;
}

/** Every name a block introduces, whatever the kind — used only for shadowing. */
function shadowNames(block) {
  const out = new Set();
  const body = block && block.type === 'BlockStatement' ? block.body : null;
  if (!body) return out;
  for (const stmt of body) {
    if (stmt.type === 'VariableDeclaration') {
      for (const d of stmt.declarations) for (const n of patternNames(d.id, [])) out.add(n);
    } else if ((stmt.type === 'ClassDeclaration' || stmt.type === 'FunctionDeclaration') && stmt.id) {
      out.add(stmt.id.name);
    }
  }
  return out;
}

/**
 * Every identifier READ synchronously inside this function body — descending
 * through blocks, conditionals and loops, but STOPPING at any nested function
 * (its body runs later, by which time the declaration has executed).
 *
 * `shadowed` carries the names an inner scope has re-declared: inside
 * `if (…) { const a = 1; use(a); }` the `a` is a DIFFERENT binding from a later
 * function-scope `const a`, and reporting it would be a false alarm.
 */
function syncReads(bodyBlock, out) {
  const visit = (node, parent, shadowed) => {
    if (FUNCTION_TYPES.has(node.type)) return;             // deferred — not our problem

    // A declarator's `id` is the binding itself, not a read of it. Only its
    // initialiser runs. (Without this, every `const [a, setA] = useState()`
    // reports both names as read-before-declared.)
    if (node.type === 'VariableDeclarator') {
      if (node.init) visit(node.init, node, shadowed);
      return;
    }
    // Neither is the name in a class/function declaration, an import, or a label.
    if (node.type === 'ClassDeclaration' || node.type === 'FunctionDeclaration') return;
    if (node.type.startsWith('Import')) return;
    if (node.type === 'LabeledStatement') { if (node.body) visit(node.body, node, shadowed); return; }
    if (node.type === 'BreakStatement' || node.type === 'ContinueStatement') return;

    if (node.type === 'Identifier') {
      if (shadowed.has(node.name)) return;
      if (parent) {
        // `a.b` reads `a`, never `b`. Same for `a?.b`.
        if ((parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression')
          && parent.property === node && !parent.computed) return;
        // `{ key: value }` — the key is not a read.
        if ((parent.type === 'ObjectProperty' || parent.type === 'ObjectMethod')
          && parent.key === node && !parent.computed) return;
        if (parent.type === 'JSXAttribute' && parent.name === node) return;
      }
      out.push(node);
      return;
    }

    // A nested block can re-declare a name; inside it, that name is not ours.
    let inner = shadowed;
    if (node.type === 'BlockStatement') {
      const names = shadowNames(node);
      if (names.size) { inner = new Set(shadowed); for (const n of names) inner.add(n); }
    }
    eachChild(node, (c) => visit(c, node, inner));
  };
  if (bodyBlock) eachChild(bodyBlock, (c) => visit(c, bodyBlock, new Set()));
  return out;
}

/** Every function node in the file. */
function allFunctions(ast, out) {
  const visit = (node) => {
    if (FUNCTION_TYPES.has(node.type)) out.push(node);
    eachChild(node, visit);
  };
  visit(ast);
  return out;
}

let checked = 0;
const findings = [];

for (const file of DIRS.flatMap((d) => walk(path.resolve(ROOT, d), []))) {
  const src = fs.readFileSync(file, 'utf8');
  let ast;
  try {
    ast = parser.parse(src, {
      sourceType: 'module',
      plugins: ['jsx', 'classProperties', 'optionalChaining', 'nullishCoalescingOperator', 'dynamicImport'],
    });
  } catch (e) {
    findings.push({ file, line: (e.loc && e.loc.line) || 0, name: '(parse)', why: `does not parse: ${e.message}` });
    continue;
  }
  checked++;
  for (const fn of allFunctions(ast, [])) {
    const bindings = blockBindings(fn.body);
    if (!bindings.size) continue;
    for (const id of syncReads(fn.body, [])) {
      const declEnd = bindings.get(id.name);
      if (declEnd == null) continue;
      if (id.start < declEnd) {
        findings.push({
          file, line: id.loc.start.line, name: id.name,
          why: `read at line ${id.loc.start.line}, but its \`const\`/\`let\` is declared at line ${src.slice(0, declEnd).split('\n').length} of the same scope`,
        });
      }
    }
  }
}

console.log(`\nTEMPORAL DEAD ZONE in the front end — ${checked} file(s) parsed under app-v2/src`);
if (!findings.length) {
  console.log('  ok  no binding is read before it is initialised on any synchronous render path');
  console.log('\nPASS');
  process.exit(0);
}

// Deduplicate by file+name+line so one identifier does not report twice.
const seen = new Set();
for (const f of findings) {
  const k = `${f.file}|${f.name}|${f.line}`;
  if (seen.has(k)) continue;
  seen.add(k);
  console.error(`  FAIL ${path.relative(ROOT, f.file)}:${f.line}  '${f.name}' ${f.why}`);
}
console.error(`
This is a ReferenceError at RUNTIME, not a build error — the bundle compiles and
minifies happily, and the component throws the moment it renders. If the value is
genuinely needed above its declaration, derive it from something already in scope
(see isPlacedStatus in ClosingPrepCard.jsx); never move a hook below an early
return to reach it.
`);
console.error('FAIL');
process.exit(1);
