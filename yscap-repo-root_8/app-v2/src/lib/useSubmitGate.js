import { useMemo, useRef } from 'react';

/* Synchronous re-entry guard for create/submit handlers.
 *
 * `disabled={busy}` is React STATE — it only takes effect on the next render, so
 * a second click, an Enter-submit, or a slow first click that the user taps
 * twice can all slip a second call through in the same tick and write a DUPLICATE
 * row (a duplicate loan file, reminder, vendor, contact, LLC, term sheet…). A ref
 * flips instantly, before the first `await`, so the second call is dropped.
 *
 * This is the reusable form of the `sendingRef` pattern ChatThread already uses.
 *
 *   const gate = useSubmitGate();
 *   async function submit() {
 *     ...validation (may return early without entering)...
 *     if (!gate.enter()) return;          // a submit is already in flight
 *     setBusy(true);
 *     try { await api.create(...); ...success... }
 *     catch (e) { setErr(e.message); }
 *     finally { setBusy(false); gate.leave(); }
 *   }
 *
 * When success navigates away (the component unmounts), calling leave() is
 * optional — but harmless, so keep it in a finally for symmetry.
 */
export function useSubmitGate() {
  const inFlight = useRef(false);
  return useMemo(() => ({
    enter() { if (inFlight.current) return false; inFlight.current = true; return true; },
    leave() { inFlight.current = false; },
    get busy() { return inFlight.current; },
  }), []);
}
