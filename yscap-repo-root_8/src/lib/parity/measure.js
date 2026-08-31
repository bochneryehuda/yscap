'use strict';

/**
 * WHO USES WHAT — the measurement half of the two-product parity engine.
 *
 * Owner-directed 2026-08-31: *"start a full side-to-side comparison of a few
 * engines that compare the condition center and the features on the condition
 * center. Each and every feature, side-to-side comparison on the FileContacts
 * side, on the [orders], and on the entity, to make sure that every single
 * feature that is available on the short-term side, every single guard, every
 * single way of operating, is also on the long-term side. A lot of stuff was
 * invested in the short-term side, and we don't want to reinvent. We just want
 * to share the code."*
 *
 * ── WHAT A "FEATURE" IS HERE, AND WHY IT IS DERIVED ─────────────────────────
 *
 * A hand-typed list of features is a list that goes stale the day somebody adds
 * the eleventh one — which is the failure this whole engine exists to catch, so
 * it must not be the engine's own shape. Instead the feature list is DERIVED
 * from the SHARED MODULES themselves: a module lives in `src/lib/**` and is
 * called by both products precisely because it carries a capability neither
 * product should own alone, so **every function it exports is a feature**, and
 * the question "does Long-Term have it?" is "does Long-Term reach it?".
 *
 * Add an export to a shared module and this engine asks about it on the next
 * run, with nobody having to remember.
 *
 * ── TWO MEASURES, BECAUSE ONE OF THEM LIES ──────────────────────────────────
 *
 * DIRECT: a file belonging to that product names the function. This is the
 * measure that finds real gaps — one product's door calling a guard the other's
 * door does not.
 *
 * REACHED: the product's own code reaches the function through a chain of
 * requires. This is what stops the engine crying wolf: Long-Term never calls
 * `takeUpload` by name because it calls it through the shared condition-document
 * door, and reporting that as a gap would train everybody to ignore the report.
 *
 * BOTH are returned, and the gate reads them together: a function ONE product
 * calls directly and the other only REACHES is not a gap; one the other neither
 * calls nor reaches is either a gap or a recorded decision.
 *
 * PURE apart from reading the repository: no database, no network, no requiring
 * of application modules. It parses text, so it can never be broken by a module
 * that needs a live Postgres to load.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');

/**
 * WHICH PRODUCT A FILE BELONGS TO — and the SHARED zones are neither.
 *
 * This distinction is the difference between a report worth reading and one that
 * cries wolf. `src/lib/**` and `app-v2/src/{lib,components}/**` are the shared
 * zones by this repo's own convention — every entry in the crossing ledger names
 * a file in one of them — so a shared module calling another shared module is
 * not the short-term product using a capability. Counting it as one made a rule
 * that had just been EXTRACTED for both products still read as "short-term
 * only", which is the opposite of the truth and exactly the noise that gets a
 * report ignored.
 */
const SHARED_PREFIXES = ['src/lib/', 'app-v2/src/lib/', 'app-v2/src/components/'];

function productOf(rel) {
  if (rel.startsWith('src/longterm/') || rel.startsWith('app-v2/src/longterm/')) return 'lt';
  if (SHARED_PREFIXES.some((p) => rel.startsWith(p))) return null;
  if (rel.startsWith('src/') || rel.startsWith('app-v2/src/')) return 'rtl';
  return null;
}

/**
 * REACH IS MEASURED FROM A PRODUCT'S OWN FILES, all of them.
 *
 * The first cut rooted it at a handful of entry points and immediately reported
 * a false gap: Long-Term's order inbox is not mounted by the two routers that
 * were listed, so every inbound-mail capability it calls read as unreached. A
 * product's capability set is what its OWN code reaches, and "its own code" is
 * the folder the separation rule already defines — which is also the definition
 * this repo enforces everywhere else, so there is no second answer to keep in
 * step.
 */
function productRoots(files, product) {
  return files.filter((rel) => productOf(rel) === product);
}

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }); }
  catch (_) { return out; }
  for (const e of entries) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      walk(rel, out);
    } else if (/\.(js|jsx|mjs)$/.test(e.name)) out.push(rel);
  }
  return out;
}

/** Every source file in the two products plus the shared library. */
function sourceFiles() {
  return [...walk('src'), ...walk('app-v2/src')];
}

const cache = new Map();
function readFile(rel) {
  if (!cache.has(rel)) {
    try { cache.set(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8')); }
    catch (_) { cache.set(rel, ''); }
  }
  return cache.get(rel);
}

/** Resolve a relative require/import to a repo-relative path, or null. */
function resolveRel(fromRel, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.posix.join(path.posix.dirname(fromRel), spec);
  for (const cand of [base, `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}/index.js`]) {
    if (fs.existsSync(path.join(ROOT, cand)) && fs.statSync(path.join(ROOT, cand)).isFile()) return cand;
  }
  return null;
}

const DEP_RE = /(?:require\(\s*['"]([^'"]+)['"]\s*\)|from\s+['"]([^'"]+)['"])/g;

/** Every repo-relative module one file pulls in. */
function depsOf(rel) {
  const out = new Set();
  const src = readFile(rel);
  let m;
  DEP_RE.lastIndex = 0;
  while ((m = DEP_RE.exec(src))) {
    const target = resolveRel(rel, m[1] || m[2]);
    if (target) out.add(target);
  }
  return [...out];
}

/** Everything reachable from a set of entry files, following requires. */
function reachableFrom(entries) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const rel = queue.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    for (const d of depsOf(rel)) if (!seen.has(d)) queue.push(d);
  }
  return seen;
}

/**
 * The names a module exports, read from its SOURCE rather than by requiring it —
 * several of these modules open a database connection at load time, and an
 * engine that needs a live Postgres to answer "what does this export" is an
 * engine nobody runs.
 *
 * Handles the two shapes this repo uses: `module.exports = { a, b, c }` and
 * `module.exports.x = ...`.
 */
function exportsOf(rel) {
  const src = readFile(rel);
  const names = new Set();
  /* BOTH SHAPES. The multi-line object is matched to its closing `\n};`, and a
     SINGLE-LINE one (`module.exports = { A, b, c };`) to its closing brace on
     the same line — `review.js` is written that way, and the first cut of this
     reader returned NOTHING for it, so its five capabilities were silently
     absent from the whole report. A reader that answers "no features" for a
     module full of them is worse than one that throws. */
  const block = src.match(/module\.exports\s*=\s*\{([\s\S]*?)\n\};?/)
    || src.match(/module\.exports\s*=\s*\{([^\n]*?)\};?/);
  if (block) {
    // Strip nested objects (an `_internals: { … }` bag is not a public feature)
    // and comments, then take the keys at the top level.
    let body = block[1].replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
    body = body.replace(/\{[^{}]*\}/g, '');
    for (const part of body.split(',')) {
      const key = part.trim().replace(/:.*$/s, '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(key)) names.add(key);
    }
  }
  for (const m of src.matchAll(/module\.exports\.([A-Za-z_$][\w$]*)\s*=/g)) names.add(m[1]);
  return [...names];
}

/** Is this name a public capability, or a constant / test seam? */
function isCapability(name) {
  if (name.startsWith('_')) return false;              // _internals, _seam, _resetSeed
  if (/^[A-Z0-9_]+$/.test(name)) return false;         // SHOUTING constants
  return true;
}

/**
 * MEASURE ONE SHARED MODULE.
 *
 * @returns Array<{ name, rtlDirect, ltDirect, rtlReached, ltReached, callers }>
 */
function measureModule(moduleRel, opts = {}) {
  const files = opts.files || sourceFiles();
  const reach = opts.reach || {
    rtl: reachableFrom(productRoots(files, 'rtl')),
    lt: reachableFrom(productRoots(files, 'lt')),
  };
  const names = exportsOf(moduleRel).filter(isCapability);

  return names.map((name) => {
    /* A USE IS A MENTION, NOT ONLY A CALL. `binaryIntake` is handed to Express
       as middleware and never invoked by this codebase, so a call-shaped test
       reported the streaming door as used by NEITHER product — which is the
       opposite of the truth. A property being ASSIGNED (`.x =`) or written as an
       object KEY (`x:`) is not a use of the shared one, so both are excluded. */
    const re = new RegExp(`\\.${name}\\b(?!\\s*[:=][^=])`);
    const callers = [];
    for (const rel of files) {
      if (rel === moduleRel) continue;
      if (re.test(readFile(rel))) callers.push(rel);
    }
    const has = (product) => callers.some((c) => productOf(c) === product);
    // REACHED asks whether the product's own graph contains a file that calls
    // it — including the SHARED module that calls it on the product's behalf,
    // which is the whole point of sharing.
    const reaches = (product) => callers.some((c) => reach[product].has(c));
    return {
      name,
      rtlDirect: has('rtl'),
      ltDirect: has('lt'),
      rtlReached: reaches('rtl'),
      ltReached: reaches('lt'),
      callers,
    };
  });
}

module.exports = {
  ROOT,
  SHARED_PREFIXES, productOf, productRoots, sourceFiles, depsOf, reachableFrom, exportsOf, isCapability, measureModule,
  _internals: { resolveRel, readFile, walk },
};
