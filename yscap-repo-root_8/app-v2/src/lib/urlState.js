/* THE PURE CORE of "the URL is the state" — the three decisions useUrlState makes,
   as plain functions of their inputs.

   ITS OWN FILE, AND WITH NO REACT IMPORT, ON PURPOSE. These are the properties worth
   testing exhaustively, and a test must be able to import them ANYWHERE — CI installs
   only the root package, so `app-v2/node_modules` (react, react-router-dom) does not
   exist there. Leaving them beside the hook meant the test pulled React in through the
   hook's own top-level import and died with ERR_MODULE_NOT_FOUND on the runner while
   passing locally, where a build had populated app-v2/node_modules.

   Same shape as gate.js / gate-disposition.js: the decision is pure and testable, the
   thin React wrapper next door supplies today's URL. A property proven here holds for
   every screen that uses the hook. */

/* Namespaced so two hubs can both own a `tab` without colliding — ElementixProfile's
   tabs live inside StaffBorrowerDetail's, and EmailCenter is mounted both standalone
   and inside the loan file. */
export const paramKey = (key, opts) => (opts && opts.prefix ? `${opts.prefix}.${key}` : key);

/** Is this a value we are willing to select? An unlisted value is treated as absent. */
export function acceptsValue(v, allow) {
  if (v === null || v === undefined || v === '') return false;
  if (!allow) return true;
  if (typeof allow === 'function') { try { return !!allow(v); } catch (_) { return false; } }
  return Array.isArray(allow) ? allow.includes(v) : true;
}

/**
 * PRECEDENCE, in one place: an explicit URL (a shared or bookmarked link) beats what
 * this tab was last doing, which beats the default.
 *
 * A url value the caller REJECTS falls through to the memory and then the default
 * rather than being selected — a stale link to a tab that no longer exists must land
 * somewhere real instead of rendering an empty screen.
 */
export function pickValue({ url, memory, fallback, allow }) {
  if (acceptsValue(url, allow)) return url;
  if (acceptsValue(memory, allow)) return memory;
  return fallback;
}

/**
 * THE WRITE: derive the next query from the previous one, and ELIDE THE DEFAULT.
 * Takes and returns a URLSearchParams, and never mutates its input — which is what
 * makes several keys written in one tick compose instead of clobbering each other.
 */
export function nextParams(prev, key, value, fallback) {
  const n = new URLSearchParams(prev);
  const v = value === null || value === undefined ? '' : String(value);
  if (!v || v === fallback) n.delete(key); else n.set(key, v);
  return n;
}

/** The many-at-once encoding: one short comma-separated key, order preserved. */
export function parseSet(raw) {
  const s = new Set();
  for (const p of String(raw || '').split(',')) { const t = p.trim(); if (t) s.add(t); }
  return s;
}
export function joinSet(ids) {
  const out = [];
  for (const id of ids || []) { const t = String(id || '').trim(); if (t && !out.includes(t)) out.push(t); }
  return out.join(',');
}

export const memKey = (name) => `pilot.urlState.${name}`;

export function readMemory(name) {
  if (!name || typeof sessionStorage === 'undefined') return null;
  try {
    const v = sessionStorage.getItem(memKey(name));
    return v === null ? null : v;
  } catch (_) { return null; }
}

export function writeMemory(name, value) {
  if (!name || typeof sessionStorage === 'undefined') return;
  try {
    if (value === null || value === undefined || value === '') sessionStorage.removeItem(memKey(name));
    else sessionStorage.setItem(memKey(name), String(value));
  } catch (_) { /* courtesy only — a full or blocked store must never break a screen */ }
}

