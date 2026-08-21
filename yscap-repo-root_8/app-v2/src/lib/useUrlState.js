/* THE URL IS THE STATE — one mechanism for "a refresh keeps your place"
   (owner-reported 2026-08-21: "When you refresh in the middle of the draw center, it
   loses your place completely and it goes back to the top … this is a major issue …
   also on the application detail and Campus Thinking [Encompass]. Dig in and find
   more places.").

   WHY A HOOK AND NOT THIRTY FIXES. Every one of those screens had its own private
   `useState`, so every one lost its place its own way and a new screen inherited the
   bug by default. A shared hook makes the CORRECT shape the easy one, and the audit
   that found the offenders can be re-run against it.

   Five properties, each answering a real failure that is (or was) in this tree:

   1. DERIVED, NEVER MIRRORED. The value is read from the URL on every render — there
      is no `useState` copy. That is what makes the BACK and FORWARD buttons work for
      free. The alternative (seed a `useState` from the params at mount, then write
      through to both) survives a refresh and leaves the back button dead, because the
      copy is never re-derived; StaffArena did exactly that.

   2. DEFAULTS ARE ELIDED. Setting a value back to its fallback DELETES the key, so a
      file sitting on its default tab has a clean address and a shared link carries
      only what somebody actually chose. Reading is symmetric: an absent key IS the
      fallback.

   3. FUNCTIONAL WRITES ONLY. Every write derives the next params from the PREVIOUS
      ones. Screens here set two, three, four keys in one tick (a view and a tab, a
      filter and a sort); the read-then-write-a-captured-`params` shape silently drops
      all but the last, and this makes that shape unavailable.

   4. `replace` BY DEFAULT. Choosing a tab is not navigation — with `push`, Back walks
      back through twelve tab clicks instead of leaving the screen. `push: true` is the
      opt-in for a change that genuinely IS navigation (picking a different subject).

   5. IT NEVER THROWS, and it never blocks a render. Remembering a place is a courtesy;
      an unreadable URL or a full sessionStorage must never be able to break a screen.

   THE MEMORY IS A FALLBACK, NOT A REPLACEMENT. `remember` mirrors the value into
   sessionStorage and reads it back ONLY when the URL is silent, so the precedence is
   always: an explicit URL (a shared or bookmarked link) > what you were last doing in
   this tab > the default. sessionStorage, not local, for the same reasons file-place.js
   gives: it survives a reload of the same tab, clears when the tab closes, and never
   leaks one person's place to the next on a shared machine. */

import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { paramKey, pickValue, nextParams, parseSet, joinSet, readMemory, writeMemory } from './urlState.js';

// Re-exported so a caller needs one import, and so the pure module stays the ONE
// definition rather than a second copy.
export { paramKey, acceptsValue, pickValue, nextParams, parseSet, joinSet } from './urlState.js';

/**
 * One scalar that lives in the URL: a tab, a filter, a view, a sort.
 *
 * @param {string} key      the query-string key ('tab', 'view', 'filter'…)
 * @param {string} fallback the value that means "nothing chosen" — elided from the URL
 * @param {object} [opts]
 *   - prefix   {string}  namespace for an embedded hub → `?<prefix>.<key>=`
 *   - push     {boolean} add a history entry (default false: a tab is not navigation)
 *   - remember {string}  a sessionStorage name; used ONLY when the URL is silent
 *   - allow    {string[]|function} accepted values — anything else reads as the fallback,
 *                        so a hand-edited or stale URL can never select a tab that does
 *                        not exist and render an empty screen
 * @returns {[string, (v:string)=>void]}
 */
export function useUrlState(key, fallback, opts) {
  const [params, setParams] = useSearchParams();
  const k = paramKey(key, opts);
  const remember = opts && opts.remember;
  const allow = opts && opts.allow;

  const value = useMemo(() => {
    let raw = null;
    try { raw = params.get(k); } catch (_) { raw = null; }
    return pickValue({ url: raw, memory: remember ? readMemory(remember) : null, fallback, allow });
  }, [params, k, allow, remember, fallback]);

  const set = useCallback((next) => {
    const v = next === null || next === undefined ? '' : String(next);
    if (remember) writeMemory(remember, v && v !== fallback ? v : '');
    // Property 3: derived from the PREVIOUS params, never from a captured copy.
    setParams((prev) => nextParams(prev, k, v, fallback), { replace: !(opts && opts.push) });
  }, [setParams, k, fallback, remember, opts && opts.push]);   // eslint-disable-line react-hooks/exhaustive-deps

  return [value, set];
}

/** A boolean in the URL. Absent = false, so `?x=1` is the only shape that appears. */
export function useUrlFlag(key, opts) {
  const [raw, setRaw] = useUrlState(key, '', opts);
  const set = useCallback((on) => setRaw(on ? '1' : ''), [setRaw]);
  return [raw === '1', set];
}

/**
 * MANY at once — which accordions are open, which rows are expanded.
 *
 * Stored as one comma-separated key rather than a key each, so a dozen open sections
 * cost one short parameter and the address stays readable. An empty set deletes the
 * key (property 2), so a screen at its defaults still has a clean URL.
 *
 * @returns {[Set<string>, (id:string, on?:boolean)=>void, (ids:Iterable<string>)=>void]}
 */
export function useUrlSet(key, opts) {
  const [raw, setRaw] = useUrlState(key, '', opts);

  const value = useMemo(() => parseSet(raw), [raw]);

  // Both writers take the CURRENT set from `value`, which is itself derived from the
  // URL on this render — so they compose with property 3 rather than around it.
  const toggle = useCallback((id, on) => {
    const t = String(id || '').trim();
    if (!t) return;
    const next = new Set(value);
    const want = on === undefined ? !next.has(t) : !!on;
    if (want) next.add(t); else next.delete(t);
    setRaw(joinSet(next));
  }, [value, setRaw]);

  const setAll = useCallback((ids) => setRaw(joinSet(ids)), [setRaw]);

  return [value, toggle, setAll];
}

// (The store helpers are exported from urlState.js — one place, not two.)
