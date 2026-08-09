/**
 * Dependency-free MISMO 3.x XML reader — the UAD 3.6 side of the appraisal module.
 *
 * WHY A THIRD READER IN THIS REPO. There are already two, and they are both wrong for
 * this document:
 *
 *  - `src/lib/appraisal/xml.js` reads UAD **2.6**, whose payload lives entirely in
 *    ATTRIBUTES (`<STRUCTURE GrossLivingAreaSquareFeetCount="1533"/>`). It DELIBERATELY
 *    DROPS ELEMENT TEXT so multi-MB base64 blobs stream past cheaply. In MISMO 3.6 the
 *    payload IS the element text (`<GrossLivingAreaSquareFeetNumber>1533</…>`), so that
 *    reader would parse a 3.6 file into a tree of empty nodes and extract nothing.
 *  - `src/lib/mismo/xml.js` reads MISMO 3.4 and is text-aware and namespace-agnostic —
 *    the right SHAPE — but it belongs to the loan-interchange module. Wiring the
 *    appraisal module into it would cross the boundary fixed in
 *    `docs/appraisal-xml/mismo-modules-boundary.md` ("Do not merge the two modules"),
 *    and it has two properties an appraisal reader must not have: it PARSES RECURSIVELY
 *    (a deep report can exhaust the call stack and abort an import) and it THROWS on
 *    malformed input (an appraisal that is 99% readable must still import 99%, with the
 *    damage reported — never a 500).
 *
 * So this reader is: iterative (no recursion anywhere, parse or navigate), tolerant
 * (never throws — a malformed document yields the tree recovered so far plus a
 * `damaged` flag), namespace-agnostic (MISMO puts elements in a default namespace and
 * only prefixes attributes like `xlink:label`, so EVERYTHING matches on the LOCAL name),
 * and text-bearing.
 *
 * A node = { name, local, attrs, children, text, parent }.
 *   `text`     direct text content of the element, trimmed and entity-decoded
 *   `local`    the tag name with any `prefix:` stripped
 *   `parent`   set on every node (needed to ask "is this inside a COMPARABLE?")
 *
 * All navigation helpers are pure and null-safe: pass them a missing node and they
 * answer with null / '' / [], never a TypeError.
 */

'use strict';

// ------------------------------------------------------------------ entities ---
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/**
 * Decode the five XML entities plus numeric references. Mirrors the 2.6 reader's
 * hardening: `String.fromCodePoint` THROWS a RangeError above U+10FFFF, so a corrupt
 * or hostile `&#x999999;` would otherwise take the whole import down. Anything that is
 * not a real Unicode scalar is left as the literal text it was.
 */
function decodeEntities(s) {
  if (s == null) return s;
  if (s.indexOf('&') === -1) return s;
  return String(s).replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isInteger(cp) && cp >= 0 && cp <= 0x10FFFF ? String.fromCodePoint(cp) : m;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : m;
  });
}

/** `gse:PROPERTY` → `PROPERTY`. The whole reader matches on this. */
function localOf(name) {
  const i = name.indexOf(':');
  return i === -1 ? name : name.slice(i + 1);
}

// A single data point can be a long narrative (UAD 3.6 moved commentary into discrete
// fields, and an appraiser can type an essay into one). Nothing we read is longer than
// this, and an unbounded read of a corrupt file is how a parser becomes an OOM.
const MAX_TEXT = 1 << 20; // 1 MiB per element

/**
 * Parse `name="value" name2='value2'`. MISMO always quotes; an unquoted attribute is
 * malformed and is skipped rather than guessed at.
 */
function parseAttrs(src) {
  const attrs = {};
  if (!src) return attrs;
  const re = /([:A-Za-z_][\w:.\-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    attrs[m[1]] = decodeEntities(m[3] !== undefined ? m[3] : m[4]);
  }
  return attrs;
}

/**
 * Tokenize + build the tree, iteratively.
 *
 * Returns `{ root, damaged }`. `damaged` is true when the document ended inside an
 * element, carried a stray close tag, or was otherwise not well-formed — the caller
 * decides whether that is fatal. `root` is always a node (`#root`), never null, so no
 * caller has to null-check the parse itself.
 *
 * A closing tag pops to the NEAREST MATCHING OPEN ANCESTOR rather than blindly to the
 * parent (the same recovery the 2.6 reader does): on well-formed input that is always
 * the current node, so behaviour is identical, and on malformed input it keeps the rest
 * of the tree correctly parented instead of silently re-homing every later sibling.
 */
function parse(xml) {
  const src = String(xml == null ? '' : xml).replace(/^﻿/, '');
  const root = { name: '#root', local: '#root', attrs: {}, children: [], text: '', parent: null };
  let cur = root;
  let damaged = false;
  const n = src.length;
  let i = 0;
  // Text is accumulated per open element and flushed when it closes, so a data point
  // split by a comment or a CDATA section still reads as one value.
  const buf = new Map();
  const push = (node, chunk) => {
    if (!chunk) return;
    const have = buf.get(node) || '';
    if (have.length >= MAX_TEXT) return;
    buf.set(node, have + chunk);
  };
  const flush = (node) => {
    const raw = buf.get(node);
    buf.delete(node);
    if (raw == null) return;
    node.text = decodeEntities(raw.length > MAX_TEXT ? raw.slice(0, MAX_TEXT) : raw).trim();
  };

  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt === -1) { push(cur, src.slice(i)); break; }
    if (lt > i) push(cur, src.slice(i, lt));
    i = lt;

    if (src.startsWith('<!--', i)) { const e = src.indexOf('-->', i + 4); if (e === -1) { damaged = true; break; } i = e + 3; continue; }
    if (src.startsWith('<![CDATA[', i)) {
      const e = src.indexOf(']]>', i + 9);
      if (e === -1) { damaged = true; break; }
      // CDATA is literal — push it WITHOUT entity decoding by pre-escaping nothing;
      // decodeEntities runs on flush, so an `&amp;` inside CDATA would be decoded. Real
      // MISMO does not use CDATA; if it appears, taking the literal text is the honest read.
      push(cur, src.slice(i + 9, e).replace(/&/g, '&amp;'));
      i = e + 3;
      continue;
    }
    if (src.startsWith('<?', i)) { const e = src.indexOf('?>', i + 2); if (e === -1) { damaged = true; break; } i = e + 2; continue; }
    if (src.startsWith('<!', i)) { const e = src.indexOf('>', i + 2); if (e === -1) { damaged = true; break; } i = e + 1; continue; }

    // ---- closing tag ----
    if (src[i + 1] === '/') {
      const gt = src.indexOf('>', i);
      if (gt === -1) { damaged = true; break; }
      const cm = /^\/\s*([:A-Za-z_][\w:.\-]*)/.exec(src.slice(i + 1, gt));
      if (cm) {
        const name = cm[1];
        let p = cur;
        while (p && p.name !== name && p.local !== localOf(name)) p = p.parent;
        if (p && p.parent) {
          // Flush every element we are closing, innermost first.
          let q = cur;
          while (q && q !== p.parent) { flush(q); q = q.parent; }
          cur = p.parent;
        } else {
          damaged = true; // stray close — ignore it rather than misalign the tree
        }
      } else if (cur.parent) {
        flush(cur);
        cur = cur.parent;
      }
      i = gt + 1;
      continue;
    }

    // ---- opening / self-closing tag ---- find the real '>' respecting quotes
    let j = i + 1;
    let quote = null;
    while (j < n) {
      const c = src[j];
      if (quote) { if (c === quote) quote = null; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
      j++;
    }
    if (j >= n) { damaged = true; break; }
    const selfClose = src[j - 1] === '/';
    const inner = src.slice(i + 1, selfClose ? j - 1 : j);
    const nameMatch = /^([:A-Za-z_][\w:.\-]*)/.exec(inner);
    if (!nameMatch) { damaged = true; i = j + 1; continue; }
    const name = nameMatch[1];
    const node = {
      name,
      local: localOf(name),
      attrs: parseAttrs(inner.slice(name.length)),
      children: [],
      text: '',
      parent: cur,
    };
    cur.children.push(node);
    if (!selfClose) cur = node;
    i = j + 1;
  }

  // End of input with elements still open: flush what we have and say so.
  if (cur !== root) damaged = true;
  let q = cur;
  while (q) { flush(q); q = q.parent; }

  return { root, damaged };
}

// ------------------------------------------------------- navigation helpers ----
// Every helper matches on the LOCAL name and tolerates a null node.

/** First direct child with this local name, or null. */
function kid(node, local) {
  if (!node || !node.children) return null;
  for (const c of node.children) if (c.local === local) return c;
  return null;
}

/** All direct children with this local name, in document order. */
function kids(node, local) {
  if (!node || !node.children) return [];
  return node.children.filter((c) => c.local === local);
}

/** Walk a path of local names from `node`. Returns the node or null. */
function path(node, locals) {
  let cur = node;
  for (const l of locals) { cur = kid(cur, l); if (!cur) return null; }
  return cur;
}

/** Direct text of a node, or '' — null-safe. */
function text(node) { return node && node.text ? node.text : ''; }

/** Text at a local-name path, or ''. */
function textAt(node, locals) { return text(path(node, locals)); }

/** Attribute by local name (so `xlink:label` is reachable as `label`), or ''. */
function attr(node, localAttr) {
  if (!node || !node.attrs) return '';
  if (Object.prototype.hasOwnProperty.call(node.attrs, localAttr)) return node.attrs[localAttr];
  for (const k of Object.keys(node.attrs)) if (localOf(k) === localAttr) return node.attrs[k];
  return '';
}

/**
 * First descendant (self included) with this local name. ITERATIVE, pre-order — a
 * pathologically deep but well-formed document must not blow the stack mid-import.
 */
function firstDeep(node, local) {
  if (!node) return null;
  const stack = [node];
  while (stack.length) {
    const el = stack.pop();
    if (el.local === local) return el;
    for (let k = el.children.length - 1; k >= 0; k--) stack.push(el.children[k]);
  }
  return null;
}

/** All descendants (self included) with this local name, in document order. */
function allDeep(node, local) {
  const out = [];
  if (!node) return out;
  const stack = [node];
  while (stack.length) {
    const el = stack.pop();
    if (el.local === local) out.push(el);
    for (let k = el.children.length - 1; k >= 0; k--) stack.push(el.children[k]);
  }
  return out;
}

/** Text of the first descendant with this local name, or ''. */
function deepText(node, local) { return text(firstDeep(node, local)); }

/** True when `ancestorLocal` is somewhere above `node`. */
function isInside(node, ancestorLocal) {
  let p = node && node.parent;
  while (p) { if (p.local === ancestorLocal) return true; p = p.parent; }
  return false;
}

/** The nearest ancestor with this local name, or null. */
function closest(node, ancestorLocal) {
  let p = node && node.parent;
  while (p) { if (p.local === ancestorLocal) return p; p = p.parent; }
  return null;
}

/**
 * Resolve ONE value from an ordered list of candidate locators, strongest first.
 *
 * A locator is either
 *   - an array of local names       → an exact child path from `node`
 *   - a string 'A/B/C'              → the same, written compactly
 *   - a string of the form `**` + `/NAME` → the first descendant named NAME, anywhere below
 *
 * Returns `{ value, via }` where `via` is the locator that produced it (or null when
 * nothing matched). The PROVENANCE IS THE POINT: this reader is being written against a
 * specification we could not fetch (see docs/appraisal-xml/uad-3.6-research.md §Access),
 * so every field records which of its candidate paths actually fired. When the first
 * real UAD 3.6 samples arrive, the coverage report says exactly which guesses were right
 * and which paths need correcting — instead of a screen full of silent nulls.
 */
function pick(node, locators) {
  if (!node || !Array.isArray(locators)) return { value: null, via: null };
  for (const loc of locators) {
    let v = '';
    if (Array.isArray(loc)) v = textAt(node, loc);
    else if (typeof loc === 'string' && loc.startsWith('**/')) v = deepText(node, loc.slice(3));
    else if (typeof loc === 'string') v = textAt(node, loc.split('/').filter(Boolean));
    if (v != null && String(v).trim() !== '') return { value: String(v).trim(), via: Array.isArray(loc) ? loc.join('/') : loc };
  }
  return { value: null, via: null };
}

/** `pick`, when only the value is wanted. */
function pickValue(node, locators) { return pick(node, locators).value; }

/**
 * Collect every node reachable by any of the candidate locators (used for repeatable
 * containers whose exact nesting we cannot yet pin down — e.g. the comparable list).
 * De-duplicated by identity, document order preserved.
 */
function pickAll(node, locators) {
  const out = [];
  const seen = new Set();
  if (!node || !Array.isArray(locators)) return out;
  for (const loc of locators) {
    let found = [];
    if (typeof loc === 'string' && loc.startsWith('**/')) found = allDeep(node, loc.slice(3));
    else {
      const parts = Array.isArray(loc) ? loc : String(loc).split('/').filter(Boolean);
      const container = path(node, parts.slice(0, -1));
      found = kids(container, parts[parts.length - 1]);
    }
    for (const f of found) if (!seen.has(f)) { seen.add(f); out.push(f); }
  }
  return out;
}

/**
 * MISMO's `xlink` arrangement, indexed.
 *
 * MISMO 3.x expresses "this comparable belongs to that valuation" with labels rather
 * than nesting: elements carry `xlink:label`, and `RELATIONSHIP` elements carry
 * `xlink:from` / `xlink:to` / `xlink:arcrole`. Reading structure from nesting alone is
 * therefore only ever a best guess. This returns
 *   { byLabel: Map(label → node), arcs: [{ from, to, arcrole }] }
 * so a caller can answer "what is this node related to" without walking the tree again.
 */
function arrangement(root) {
  const byLabel = new Map();
  const arcs = [];
  if (!root) return { byLabel, arcs };
  const stack = [root];
  while (stack.length) {
    const el = stack.pop();
    const label = attr(el, 'label');
    if (label && !byLabel.has(label)) byLabel.set(label, el);
    if (el.local === 'RELATIONSHIP') {
      const from = attr(el, 'from'), to = attr(el, 'to');
      if (from || to) arcs.push({ from, to, arcrole: attr(el, 'arcrole') });
    }
    for (let k = el.children.length - 1; k >= 0; k--) stack.push(el.children[k]);
  }
  return { byLabel, arcs };
}

/** Every distinct local element name in the document, with counts. A survey tool: run it
 * against the first real 3.6 file to see what the vendor actually emitted. */
function tagCensus(root) {
  const counts = new Map();
  if (!root) return counts;
  const stack = [root];
  while (stack.length) {
    const el = stack.pop();
    if (el.local !== '#root') counts.set(el.local, (counts.get(el.local) || 0) + 1);
    for (let k = el.children.length - 1; k >= 0; k--) stack.push(el.children[k]);
  }
  return counts;
}

module.exports = {
  parse, decodeEntities, localOf,
  kid, kids, path, text, textAt, attr,
  firstDeep, allDeep, deepText, isInside, closest,
  pick, pickValue, pickAll, arrangement, tagCensus,
};
