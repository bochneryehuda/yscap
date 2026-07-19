/**
 * Dependency-free MISMO 2.6 XML reader.
 *
 * The appraisal XMLs are attribute-heavy (`<STRUCTURE GrossLivingAreaSquareFeetCount="1533"/>`),
 * well-formed, and namespace-free on the elements we read. We do NOT add an XML library
 * (the repo keeps to express + pg with zero native deps), so this is a small, correct
 * tokenizer → node tree supporting exactly what extraction needs: find elements by tag name
 * anywhere in the tree, read their attributes, and walk parent/child.
 *
 * Text content is intentionally dropped (we never need element text, and skipping it lets the
 * multi-MB base64 `<DOCUMENT>` blobs stream past cheaply). To pull the embedded PDF, use
 * `embeddedPdfBase64()` which regexes the one blob out directly rather than DOM-ing it.
 *
 * A node = { tag, attrs:{}, children:[], parent }. All helpers below are pure.
 */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unescapeXml(s) {
  if (s == null) return s;
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, code) => {
    if (code[0] === '#') {
      const cp = code[1] === 'x' || code[1] === 'X'
        ? parseInt(code.slice(2), 16)
        : parseInt(code.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, code) ? ENTITIES[code] : m;
  });
}

// Parse `name="value" name2='value2'` (quotes required, MISMO always quotes). Returns {}.
function parseAttrs(src) {
  const attrs = {};
  const re = /([:A-Za-z_][\w:.\-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    attrs[m[1]] = unescapeXml(m[3] !== undefined ? m[3] : m[4]);
  }
  return attrs;
}

/**
 * Tokenize + build the tree. Correctly skips comments, CDATA, and the XML/PI declaration,
 * and finds each tag's end while respecting quotes (so a `>` inside an attribute value never
 * terminates a tag early).
 */
function parse(xml) {
  const root = { tag: '#root', attrs: {}, children: [], parent: null };
  let cur = root;
  const n = xml.length;
  let i = 0;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) break;
    i = lt;
    if (xml.startsWith('<!--', i)) { const e = xml.indexOf('-->', i + 4); i = e === -1 ? n : e + 3; continue; }
    if (xml.startsWith('<![CDATA[', i)) { const e = xml.indexOf(']]>', i + 9); i = e === -1 ? n : e + 3; continue; }
    if (xml.startsWith('<?', i)) { const e = xml.indexOf('?>', i + 2); i = e === -1 ? n : e + 2; continue; }
    if (xml.startsWith('<!', i)) { const e = xml.indexOf('>', i + 2); i = e === -1 ? n : e + 1; continue; }

    // closing tag
    if (xml[i + 1] === '/') {
      const gt = xml.indexOf('>', i);
      if (gt === -1) break;
      if (cur.parent) cur = cur.parent;
      i = gt + 1;
      continue;
    }

    // opening or self-closing tag — find the real '>' respecting quotes
    let j = i + 1;
    let quote = null;
    while (j < n) {
      const c = xml[j];
      if (quote) { if (c === quote) quote = null; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
      j++;
    }
    if (j >= n) break;
    const selfClose = xml[j - 1] === '/';
    const inner = xml.slice(i + 1, selfClose ? j - 1 : j);
    const nameMatch = /^([:A-Za-z_][\w:.\-]*)/.exec(inner);
    if (!nameMatch) { i = j + 1; continue; }
    const node = {
      tag: nameMatch[1],
      attrs: parseAttrs(inner.slice(nameMatch[1].length)),
      children: [],
      parent: cur,
    };
    cur.children.push(node);
    if (!selfClose) cur = node;
    i = j + 1;
  }
  return root;
}

// Depth-first: first descendant with this tag (or null).
function find(node, tag) {
  const stack = [...node.children];
  while (stack.length) {
    const el = stack.shift();
    if (el.tag === tag) return el;
    for (let k = el.children.length - 1; k >= 0; k--) stack.unshift(el.children[k]);
  }
  return null;
}

// All descendants with this tag, in document order.
function findAll(node, tag) {
  const out = [];
  (function walk(n) {
    for (const el of n.children) {
      if (el.tag === tag) out.push(el);
      if (el.children.length) walk(el);
    }
  })(node);
  return out;
}

// Attribute read on a possibly-null node.
function attr(node, name) {
  return node && node.attrs ? (node.attrs[name] != null ? node.attrs[name] : null) : null;
}

// First non-empty attribute from a node, given several candidate names.
function attrAny(node, names) {
  if (!node) return null;
  for (const nm of names) {
    const v = node.attrs[nm];
    if (v != null && String(v).trim() !== '') return v;
  }
  return null;
}

/**
 * Pull the base64 of the embedded appraisal PDF directly (there is exactly one
 * `<EMBEDDED_FILE _Type="PDF">…<DOCUMENT>base64</DOCUMENT>` per file). Regex, not DOM,
 * because the payload is multi-MB. Returns the base64 string or null.
 */
function embeddedPdfBase64(xml) {
  // Find an EMBEDDED_FILE whose attributes say PDF, then the next DOCUMENT payload.
  const re = /<EMBEDDED_FILE\b([^>]*)>\s*<DOCUMENT>([\s\S]*?)<\/DOCUMENT>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const a = m[1] || '';
    if (/_Type\s*=\s*"PDF"/i.test(a) || /MIMEType\s*=\s*"application\/pdf"/i.test(a)) {
      const b64 = m[2].replace(/\s+/g, '');
      if (b64 && !/\[BASE64/.test(b64)) return b64;
    }
  }
  return null;
}

module.exports = { parse, find, findAll, attr, attrAny, unescapeXml, embeddedPdfBase64 };
