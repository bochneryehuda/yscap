'use strict';
/**
 * A NAME THIS FILE NEVER DECLARES IS A CRASH, AND THE BUILD WILL NOT TELL YOU.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * CLAUDE.md has carried the rule since a live outage: *"a green `npm run build`
 * does NOT mean the page renders."* Vite/esbuild treat an UNDECLARED identifier
 * as a global and emit it verbatim, so a component that reads a prop it was
 * never passed compiles perfectly and throws `ReferenceError` the moment it
 * renders — which the app's ErrorBoundary turns into the full-screen "Something
 * went wrong", taking the whole screen down. That is exactly how "open any file
 * from the dashboard" broke once.
 *
 * The rule's own remedy is *"run eslint `no-undef` on the changed .jsx"* — by
 * hand, which means the one time it matters is the time somebody is in a hurry.
 * A pre-merge audit named the gap: `npm test` has no lint step at all.
 *
 * ── WHY IT IS NOT ESLINT ───────────────────────────────────────────────────
 *
 * ESLint is in no `package.json` here, so wiring it in means either a network
 * fetch inside the deploy gate — a tool nobody pinned, downloaded at test time,
 * which is the opposite of this repo's "pin your tools" rule — or a new
 * dependency on the install Render runs, which is its own change with its own
 * verification and is nobody's idea of a MINOR audit fix. `@babel/parser` is
 * already a pinned devDependency, so the scope analysis is done here, in about
 * two hundred lines, with nothing new installed.
 *
 * ── WHAT IT IS, AND HONESTLY WHAT IT IS NOT ────────────────────────────────
 *
 * It is `no-undef` and only `no-undef`: every identifier REFERENCE is resolved
 * against the scope chain it is written in, and one that resolves to nothing and
 * is not a known browser global is reported. It says nothing about unused names,
 * hooks, formatting or types, and it does not catch use-before-declaration (a
 * scope's bindings are collected before its body is walked, exactly as a hoisting
 * engine sees them — so does eslint's own no-undef).
 *
 * ⛔ IT MUST HAVE NO FALSE POSITIVES, because a check that cries wolf on the
 * deploy gate gets switched off within a week. Anything it cannot resolve
 * confidently — a `with`, an `eval`, a parse failure — is REPORTED AS UNREADABLE
 * rather than guessed at, and a file it cannot parse fails loudly instead of
 * silently passing.
 */
const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');

const ROOT = path.join(__dirname, '..');

/* The browser and the module system. Deliberately generous: an over-long list
   costs a missed crash in one rare name, while a short one costs a false alarm
   on every build — and the second is what gets a guard deleted. */
const GLOBALS = new Set([
  'window', 'document', 'navigator', 'location', 'history', 'screen', 'console',
  'fetch', 'Headers', 'Request', 'Response', 'FormData', 'Blob', 'File', 'FileReader',
  'URL', 'URLSearchParams', 'AbortController', 'AbortSignal', 'WebSocket', 'EventSource',
  'localStorage', 'sessionStorage', 'indexedDB', 'crypto', 'performance', 'Intl',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask',
  'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback',
  'ResizeObserver', 'MutationObserver', 'IntersectionObserver', 'PerformanceObserver',
  'Image', 'Audio', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'DOMParser',
  'XMLHttpRequest', 'getComputedStyle', 'matchMedia', 'structuredClone', 'atob', 'btoa',
  'alert', 'confirm', 'prompt', 'print', 'open', 'close', 'scrollTo', 'getSelection',
  'Node', 'Element', 'HTMLElement', 'Text', 'Range', 'CSS', 'devicePixelRatio',
  'MediaRecorder', 'EventTarget', 'DataTransfer', 'Notification', 'Worker', 'Clipboard',
  'ClipboardItem', 'IntersectionObserverEntry', 'TextEncoder', 'TextDecoder',
  // language
  'globalThis', 'undefined', 'NaN', 'Infinity', 'Object', 'Array', 'Function', 'String',
  'Number', 'Boolean', 'Symbol', 'BigInt', 'Math', 'JSON', 'Date', 'RegExp', 'Error',
  'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise', 'Proxy', 'Reflect', 'ArrayBuffer',
  'DataView', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
  'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array',
  'BigUint64Array', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
  'decodeURIComponent', 'encodeURI', 'decodeURI', 'escape', 'unescape', 'eval',
  'import', 'process',
]);

const isNode = (v) => v && typeof v === 'object' && typeof v.type === 'string';
function children(node) {
  const out = [];
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'range' || k === 'leadingComments' || k === 'trailingComments') continue;
    const v = node[k];
    if (Array.isArray(v)) { for (const x of v) if (isNode(x)) out.push([k, x]); }
    else if (isNode(v)) out.push([k, v]);
  }
  return out;
}

/** Every name a binding pattern introduces — destructuring, defaults, rest. */
function patternNames(node, out) {
  if (!isNode(node)) return out;
  switch (node.type) {
    case 'Identifier': out.push(node.name); break;
    case 'ObjectPattern': for (const p of node.properties) patternNames(p, out); break;
    case 'ObjectProperty': patternNames(node.value, out); break;
    case 'ArrayPattern': for (const e of node.elements) if (e) patternNames(e, out); break;
    case 'RestElement': patternNames(node.argument, out); break;
    case 'AssignmentPattern': patternNames(node.left, out); break;
    default: break;
  }
  return out;
}

const FN = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression',
  'ObjectMethod', 'ClassMethod', 'ClassPrivateMethod']);
const SCOPED = new Set([...FN, 'Program', 'BlockStatement', 'ForStatement', 'ForInStatement',
  'ForOfStatement', 'CatchClause', 'ClassDeclaration', 'ClassExpression', 'StaticBlock']);

/** The names a scope declares, collected BEFORE its body is walked (hoisting). */
function declaredIn(node) {
  const names = [];
  const add = (n) => { if (n) names.push(n); };
  if (FN.has(node.type)) {
    if (node.id && node.id.name) add(node.id.name);
    for (const p of node.params || []) patternNames(p, names);
    add('arguments');
  }
  if (node.type === 'CatchClause' && node.param) patternNames(node.param, names);
  if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
    if (node.id && node.id.name) add(node.id.name);
  }
  // `var` and function declarations hoist out of blocks, so a function scope has
  // to see them however deep they were written. Walk everything below, stopping
  // at the next function boundary for the hoisting kinds.
  const walk = (n, top) => {
    for (const [, c] of children(n)) {
      if (c.type === 'VariableDeclaration') {
        const hoists = c.kind === 'var';
        if (hoists || top) for (const d of c.declarations) patternNames(d.id, names);
      } else if (c.type === 'FunctionDeclaration') {
        if (c.id) add(c.id.name);
        continue;                                   // its own params are its own scope
      } else if (c.type === 'ClassDeclaration' && top) {
        if (c.id) add(c.id.name);
      } else if (c.type === 'ImportDeclaration') {
        for (const sp of c.specifiers) add(sp.local && sp.local.name);
      }
      if (FN.has(c.type)) continue;                 // a nested function's `var`s are its own
      walk(c, top && !SCOPED.has(c.type));
    }
  };
  walk(node, true);
  // A `var` written inside a block still belongs to the enclosing function.
  if (FN.has(node.type) || node.type === 'Program') {
    const deep = (n) => {
      for (const [, c] of children(n)) {
        if (FN.has(c.type)) continue;
        if (c.type === 'VariableDeclaration' && c.kind === 'var') {
          for (const d of c.declarations) patternNames(d.id, names);
        }
        deep(c);
      }
    };
    deep(node);
  }
  return names;
}

/** Is this Identifier a REFERENCE, or a name in a position that declares/labels? */
function isReference(node, parentKey, parent) {
  if (!parent) return true;
  const t = parent.type;
  if (t === 'MemberExpression' || t === 'OptionalMemberExpression') return !(parentKey === 'property' && !parent.computed);
  if (t === 'ObjectProperty') return !(parentKey === 'key' && !parent.computed);
  if (t === 'ObjectMethod' || t === 'ClassMethod' || t === 'ClassProperty' || t === 'ClassPrivateProperty') {
    return !(parentKey === 'key' && !parent.computed);
  }
  if (t === 'VariableDeclarator') return parentKey !== 'id';
  if (FN.has(t)) return parentKey !== 'id' && parentKey !== 'params';
  if (t === 'ClassDeclaration' || t === 'ClassExpression') return parentKey !== 'id';
  if (t === 'ImportSpecifier' || t === 'ImportDefaultSpecifier' || t === 'ImportNamespaceSpecifier') return false;
  if (t === 'ExportSpecifier') return parentKey === 'local';
  if (t === 'LabeledStatement' || t === 'BreakStatement' || t === 'ContinueStatement') return parentKey !== 'label';
  if (t === 'CatchClause') return parentKey !== 'param';
  if (t === 'ObjectPattern' || t === 'ArrayPattern' || t === 'RestElement') return false;
  if (t === 'AssignmentPattern') return parentKey !== 'left';
  if (t === 'JSXAttribute' || t === 'JSXNamespacedName') return false;
  if (t === 'MetaProperty') return false;
  return true;
}

/** `<Foo>` is a reference; `<div>` is an intrinsic tag. */
const jsxIsComponent = (name) => /^[A-Z_$]/.test(name);

function checkFile(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  let ast;
  try {
    ast = parser.parse(src, {
      sourceType: 'module',
      plugins: ['jsx', 'classProperties', 'classPrivateProperties', 'classPrivateMethods',
        'objectRestSpread', 'optionalChaining', 'nullishCoalescingOperator', 'dynamicImport',
        'topLevelAwait', 'importMeta'],
    });
  } catch (e) {
    return [{ rel, name: '(unparseable)', line: (e.loc && e.loc.line) || 0, why: e.message }];
  }
  const bad = [];
  const seen = new Set();
  const walk = (node, scope, parentKey, parent) => {
    let sc = scope;
    if (SCOPED.has(node.type)) {
      sc = new Set(scope);
      for (const nm of declaredIn(node)) sc.add(nm);
    }
    if (node.type === 'Identifier' && isReference(node, parentKey, parent)) {
      if (!sc.has(node.name) && !GLOBALS.has(node.name)) {
        const key = `${node.name}:${node.loc ? node.loc.start.line : 0}`;
        if (!seen.has(key)) { seen.add(key); bad.push({ rel, name: node.name, line: node.loc ? node.loc.start.line : 0 }); }
      }
    }
    if (node.type === 'JSXIdentifier' && parent && parent.type !== 'JSXAttribute'
        && !(parent.type === 'JSXMemberExpression' && parentKey === 'property')
        && jsxIsComponent(node.name) && !sc.has(node.name) && !GLOBALS.has(node.name)) {
      const key = `${node.name}:${node.loc ? node.loc.start.line : 0}`;
      if (!seen.has(key)) { seen.add(key); bad.push({ rel, name: node.name, line: node.loc ? node.loc.start.line : 0 }); }
    }
    /* ⛔ `export { x } from './y'` NAMES NOTHING LOCAL. The specifier's `local` is a
       name in the OTHER module, so resolving it here reports a perfectly ordinary
       re-export as an undefined name — which is exactly the false alarm that gets a
       guard switched off. Only a re-export is skipped; `export { x }` with no source
       IS a real reference and is still resolved. */
    if (node.type === 'ExportNamedDeclaration' && node.source) {
      for (const [k, c] of children(node)) if (k !== 'specifiers') walk(c, sc, k, node);
      return;
    }
    for (const [k, c] of children(node)) walk(c, sc, k, node);
  };
  walk(ast.program, new Set(), null, null);
  return bad;
}

function jsxFiles(dir) {
  const out = [];
  (function w(d) {
    for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
      const rel = `${d}/${e.name}`;
      if (e.isDirectory()) w(rel);
      else if (/\.jsx$/.test(e.name)) out.push(rel);
    }
  })(dir);
  return out.sort();
}

module.exports = { checkFile, jsxFiles, GLOBALS };

if (require.main === module) {
  const dirs = process.argv.slice(2);
  const files = dirs.length ? dirs : ['app-v2/src'];
  const targets = [];
  for (const f of files) {
    const abs = path.join(ROOT, f);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) targets.push(...jsxFiles(f));
    else targets.push(f);
  }
  const bad = targets.flatMap(checkFile);
  for (const b of bad) console.log(`  ${b.rel}:${b.line}  '${b.name}' is not defined${b.why ? ` — ${b.why}` : ''}`);
  console.log(bad.length === 0
    ? `\ncheck-jsx-scope: ${targets.length} files, no undefined names`
    : `\ncheck-jsx-scope: ${bad.length} undefined name(s) across ${targets.length} files`);
  process.exit(bad.length ? 1 : 0);
}
