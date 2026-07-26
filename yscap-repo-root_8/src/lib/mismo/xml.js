/**
 * Tiny, dependency-free XML writer + reader for the MISMO 3.4 engine.
 *
 * The repo installs ONLY `express` + `pg` (no native deps, clean Render builds),
 * so we hand-roll XML the same way `src/lib/tpr-export.js` hand-rolls its OOXML.
 * This is intentionally small and MISMO-shaped, not a general XML toolkit:
 *   - the WRITER builds an element tree and serializes it (pretty-printed),
 *     omitting empty leaves so a MISMO file never carries blank data points;
 *   - the READER is a forgiving recursive-descent parser that produces a node
 *     tree and namespace-agnostic navigation helpers (MISMO puts its elements in
 *     a default namespace and only prefixes attributes like `xlink:label`, so we
 *     always match on the LOCAL name — the part after any `prefix:`).
 *
 * The reader deliberately handles only what a real MISMO file contains
 * (elements, attributes, text, self-closing tags, comments, the XML/DOCTYPE
 * prologue and standard entities) — never DTD internals, CDATA sections, or
 * processing instructions beyond the declaration, none of which appear in
 * GSE/AUS MISMO output.
 */

// ----------------------------------------------------------------- WRITER -----
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * An element node: { name, attrs, kids }. `kids` is an array of element nodes
 * and/or plain strings (text). Null/undefined kids are dropped so callers can
 * write `el('X', {}, [ leaf('A', maybeNull), leaf('B', val) ])` and have the
 * empty ones disappear.
 */
function el(name, attrs, kids) {
  const children = (Array.isArray(kids) ? kids : (kids == null ? [] : [kids])).filter((k) => k != null && k !== false);
  return { name, attrs: attrs || {}, kids: children };
}

/**
 * A data-point element carrying a single text value, e.g.
 * `<BaseLoanAmount>250000</BaseLoanAmount>`. Returns null when the value is
 * blank so the whole element is omitted (MISMO best practice — never emit an
 * empty data point). Attributes are supported for the rare valued+attributed
 * element.
 */
function leaf(name, value, attrs) {
  if (value == null) return null;
  const s = String(value);
  if (s.trim() === '') return null;
  return { name, attrs: attrs || {}, kids: [s], _leaf: true };
}

// True when a node has no element children (only text, or nothing).
function isLeafish(node) {
  return node.kids.every((k) => typeof k === 'string');
}

function renderNode(node, indent) {
  const pad = '  '.repeat(indent);
  const attrStr = Object.keys(node.attrs)
    .filter((k) => node.attrs[k] != null && node.attrs[k] !== '')
    .map((k) => ` ${k}="${esc(node.attrs[k])}"`)
    .join('');
  if (node.kids.length === 0) return `${pad}<${node.name}${attrStr}/>`;
  if (isLeafish(node)) {
    const text = node.kids.join('');
    return `${pad}<${node.name}${attrStr}>${esc(text)}</${node.name}>`;
  }
  const inner = node.kids
    .filter((k) => typeof k !== 'string') // whitespace-only text between elements is ignored on write
    .map((k) => renderNode(k, indent + 1))
    .join('\n');
  return `${pad}<${node.name}${attrStr}>\n${inner}\n${pad}</${node.name}>`;
}

/** Serialize a root element node to a full XML document string. */
function render(root) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + renderNode(root, 0) + '\n';
}

// ----------------------------------------------------------------- READER -----
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : m;
  });
}

const localOf = (name) => {
  const i = name.indexOf(':');
  return i === -1 ? name : name.slice(i + 1);
};

/**
 * Parse an XML string into a node tree. Each element node is
 *   { name, local, attrs, children, text }
 * where `children` holds child element nodes and `text` is the direct text
 * content (trimmed, entity-decoded) — populated for data-point elements.
 * Throws on malformed input rather than guessing.
 */
function parse(xml) {
  const src = String(xml).replace(/^﻿/, ''); // strip BOM
  let i = 0;
  const n = src.length;

  function skipMisc() {
    // Skip whitespace, comments, the XML declaration, and DOCTYPE.
    for (;;) {
      while (i < n && /\s/.test(src[i])) i++;
      if (src.startsWith('<?', i)) { const e = src.indexOf('?>', i); if (e === -1) throw new Error('unterminated processing instruction'); i = e + 2; continue; }
      if (src.startsWith('<!--', i)) { const e = src.indexOf('-->', i); if (e === -1) throw new Error('unterminated comment'); i = e + 3; continue; }
      if (src.startsWith('<!', i)) { const e = src.indexOf('>', i); if (e === -1) throw new Error('unterminated declaration'); i = e + 1; continue; }
      break;
    }
  }

  function parseAttrs(str) {
    const attrs = {};
    const re = /([^\s=\/]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = re.exec(str))) {
      attrs[m[1]] = decodeEntities(m[3] != null ? m[3] : m[4]);
    }
    return attrs;
  }

  function parseElement() {
    if (src[i] !== '<') throw new Error(`expected '<' at ${i}`);
    i++; // consume '<'
    const start = i;
    while (i < n && !/[\s\/>]/.test(src[i])) i++;
    const name = src.slice(start, i);
    if (!name) throw new Error(`empty tag name at ${start}`);
    // read up to the end of the open tag
    const tagOpen = i;
    while (i < n && src[i] !== '>') i++;
    if (i >= n) throw new Error(`unterminated tag <${name}>`);
    let attrText = src.slice(tagOpen, i);
    const selfClose = /\/\s*$/.test(attrText);
    if (selfClose) attrText = attrText.replace(/\/\s*$/, '');
    i++; // consume '>'
    const node = { name, local: localOf(name), attrs: parseAttrs(attrText), children: [], text: '' };
    if (selfClose) return node;

    // parse content until the matching close tag
    let text = '';
    for (;;) {
      if (i >= n) throw new Error(`unexpected end of input inside <${name}>`);
      if (src[i] === '<') {
        if (src.startsWith('</', i)) {
          i += 2;
          const cs = i;
          while (i < n && src[i] !== '>') i++;
          const closeName = src.slice(cs, i).trim();
          i++; // consume '>'
          if (closeName !== name) throw new Error(`mismatched close: <${name}> vs </${closeName}>`);
          break;
        }
        if (src.startsWith('<!--', i)) { const e = src.indexOf('-->', i); if (e === -1) throw new Error('unterminated comment'); i = e + 3; continue; }
        if (src.startsWith('<![CDATA[', i)) { const e = src.indexOf(']]>', i); if (e === -1) throw new Error('unterminated CDATA'); text += src.slice(i + 9, e); i = e + 3; continue; }
        node.children.push(parseElement());
      } else {
        const nextLt = src.indexOf('<', i);
        const chunk = src.slice(i, nextLt === -1 ? n : nextLt);
        text += chunk;
        i = nextLt === -1 ? n : nextLt;
      }
    }
    node.text = decodeEntities(text).trim();
    return node;
  }

  skipMisc();
  if (i >= n) throw new Error('no root element');
  const root = parseElement();
  return root;
}

// ------------------------------------------------------- navigation helpers ---
// All matching is on the LOCAL name (namespace-prefix-agnostic).

/** First direct child element with the given local name, or null. */
function kid(node, local) {
  if (!node) return null;
  return node.children.find((c) => c.local === local) || null;
}
/** All direct child elements with the given local name. */
function kids(node, local) {
  if (!node) return [];
  return node.children.filter((c) => c.local === local);
}
/** Follow a path of local names from `node`; returns the node or null. */
function path(node, ...locals) {
  let cur = node;
  for (const l of locals) { cur = kid(cur, l); if (!cur) return null; }
  return cur;
}
/** Text of the element at a local-name path, or '' if any step is missing. */
function textAt(node, ...locals) {
  const target = path(node, ...locals);
  return target ? target.text : '';
}
/** Attribute value (matched on local name of the attribute) or ''. */
function attr(node, localAttr) {
  if (!node) return '';
  if (Object.prototype.hasOwnProperty.call(node.attrs, localAttr)) return node.attrs[localAttr];
  for (const k of Object.keys(node.attrs)) if (localOf(k) === localAttr) return node.attrs[k];
  return '';
}
/**
 * Depth-first search for the first descendant (including self) whose local name
 * matches. Useful for pulling a well-known data point out of a subtree without
 * hard-coding the full container path.
 */
function firstDeep(node, local) {
  if (!node) return null;
  if (node.local === local) return node;
  for (const c of node.children) { const found = firstDeep(c, local); if (found) return found; }
  return null;
}
/** All descendants (including self) with the given local name. */
function allDeep(node, local, out) {
  out = out || [];
  if (!node) return out;
  if (node.local === local) out.push(node);
  for (const c of node.children) allDeep(c, local, out);
  return out;
}

module.exports = {
  // writer
  el, leaf, render, esc,
  // reader
  parse, decodeEntities, localOf,
  // navigation
  kid, kids, path, textAt, attr, firstDeep, allDeep,
};
