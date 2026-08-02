'use strict';

/* =====================================================================
   nul-strip.js — remove U+0000 from a parsed request body, once, before any
   route sees it (third audit of the column-bounds work, 2026-08-02).

   WHY THIS EXISTS AT ALL. Postgres cannot store a NUL byte in a text column
   (22021 `invalid byte sequence for encoding "UTF8": 0x00`) or inside a jsonb
   string (22P05 `unsupported Unicode escape sequence`). Either way the route's
   catch-all turns it into a 500 "server error".

   THE CLASS WAS FIXED THREE TIMES AND SURVIVED ALL THREE, because each fix was a
   list of places rather than a rule:
     · round 1 — `fields.textColumn` NUL-strips, but only the columns routed
       through it (the payoff pair, a few others);
     · round 2 — `fields.jsonbText` for jsonb binds, applied to the sites an
       audit enumerated: 4 of ~17, so both borrower-profile doors still 500'd;
     · round 3 — the remaining jsonb binds, including the PUBLIC lead door…
       whose `name`, `phone`, `subject` and `message` are plain TEXT columns and
       kept losing the lead with a 500 on the visitor's own name box. The public
       intake door lost an entire application the same way, on `firstName`.

   So the rule, not the list: a NUL is never meaningful in a JSON request to this
   API. No field wants one. Nobody can type one (it is invisible, and no browser
   input produces it). Every storage layer refuses it. It is removed here, once,
   and the two helpers above stay in place for values that arrive by some other
   road — a webhook mounted before the JSON parser, a ClickUp pull, a parsed
   document — which this middleware never sees.

   DESIGN NOTES, each deliberate:
   · MUTATES IN PLACE. Re-assigning `req.body` is not enough on its own for code
     that captured a reference, and copying a 32 MB body would be the expensive
     thing this is trying to avoid.
   · BOUNDED. Depth and node count are capped so a deeply nested or enormous
     hostile body cannot turn every request into a tree walk. Hitting a cap
     leaves the rest untouched — the storage layers still refuse a NUL, so the
     worst case is the 500 we had before, not a new failure.
   · NEVER THROWS. A body it cannot walk (a getter that throws, a circular
     structure, a frozen object) is left exactly as it was. A sanitizer that can
     500 a request is worse than the bug it prevents.
   · KEYS TOO. `{"na\u0000me": "x"}` is as fatal to jsonb as the value is.
   · Buffers, Dates and anything with its own `toJSON` are left alone — they are
     not text the user typed, and rewriting them would change what they mean.

   PURE apart from the mutation; unit-tested by scripts/test-nul-strip.js.
   ===================================================================== */

const NUL = /\u0000/g;
const MAX_DEPTH = 40;
const MAX_NODES = 200000;

function hasNul(s) { return s.indexOf('\u0000') !== -1; }

/**
 * Strip NUL from every string in `node`, in place. Returns the (possibly
 * replaced) node so a caller can reassign a top-level string.
 */
function stripInto(node, depth, budget) {
  if (budget.n++ > MAX_NODES || depth > MAX_DEPTH) { budget.capped = true; return node; }
  if (typeof node === 'string') return hasNul(node) ? node.replace(NUL, '') : node;
  if (node === null || typeof node !== 'object') return node;
  // Not user-typed text: a Buffer, a Date, anything that serializes itself.
  if (Buffer.isBuffer(node) || typeof node.toJSON === 'function') return node;

  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const v = node[i];
      const out = stripInto(v, depth + 1, budget);
      if (out !== v) node[i] = out;
    }
    return node;
  }

  for (const key of Object.keys(node)) {
    const v = node[key];
    const out = stripInto(v, depth + 1, budget);
    // A NUL in the KEY is just as fatal to jsonb as one in the value.
    if (hasNul(key)) {
      const clean = key.replace(NUL, '');
      delete node[key];
      // A collision means the clean name already exists; the existing value wins
      // rather than being silently overwritten by the malformed twin.
      if (!Object.prototype.hasOwnProperty.call(node, clean)) node[clean] = out;
    } else if (out !== v) {
      node[key] = out;
    }
  }
  return node;
}

/** Strip NUL from a whole parsed body. Never throws; returns the same reference. */
function stripNulBody(body) {
  if (body == null || typeof body !== 'object') {
    return typeof body === 'string' && hasNul(body) ? body.replace(NUL, '') : body;
  }
  try {
    return stripInto(body, 0, { n: 0, capped: false });
  } catch (_) {
    // A body we cannot walk is left as-is — the storage layers still refuse a
    // NUL, so this degrades to the old behavior instead of inventing a new 500.
    return body;
  }
}

function middleware(req, _res, next) {
  try { if (req.body != null) req.body = stripNulBody(req.body); } catch (_) {}
  next();
}

module.exports = { middleware, stripNulBody, MAX_DEPTH, MAX_NODES };
