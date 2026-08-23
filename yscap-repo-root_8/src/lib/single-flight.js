'use strict';
/* =====================================================================
   single-flight.js — run an expensive async job ONCE, however many callers
   ask for it at the same moment.

   WHY THIS EXISTS AS ITS OWN MODULE. Owner-reported 2026-08-23: the draw
   report *"takes a very long time, and sometimes it's not even opening."*
   Building one is a synchronous jsPDF render over every archived photo — it
   holds the Node event loop for as long as it runs. Nothing stopped two clicks
   (or two tabs, or a forwarded borrower email opened by three people) from
   starting the SAME render two or three times, and two of those in flight is a
   web service that has stopped answering anything at all. From the outside that
   is indistinguishable from a slow page, which is exactly why it was reported
   as "sometimes it's not even opening" rather than as an outage.

   The rule is small enough to be tempting to inline, which is precisely why it
   is not: there are two report builders (Sitewire draws and TrustPoint draws),
   and the whole defect being fixed was FOUR copies of the same build sequence
   in four routes, where a fix applied to one left the other three stalling the
   service. One definition, used by both.

   CONTRACT — deliberately narrow:
     · Callers with the same key share ONE promise and one execution.
     · The entry is removed when the job settles, so a FAILURE is retryable
       rather than cached as the answer forever. That is the difference between
       "the render blew up once" and "this report is broken until a redeploy".
     · Each caller sees the real resolution or the real rejection — nothing is
       swallowed, and a rejection is never converted into a value.
     · It is per-process by construction. Coordinating ACROSS processes is a
       different problem with a different tool (an advisory lock); conflating
       the two in one helper would hide which guarantee a caller actually has.
   ===================================================================== */

/**
 * @param {Map} map   the caller's own in-flight registry (so two features never
 *                    share a key space by accident)
 * @param {string} key what makes two requests "the same job"
 * @param {() => Promise<any>} fn the work
 */
function singleFlight(map, key, fn) {
  const existing = map.get(key);
  if (existing) return existing;
  // `Promise.resolve().then(fn)` rather than `fn()` so a fn that throws
  // SYNCHRONOUSLY becomes a rejected promise like any other failure, instead of
  // throwing out of singleFlight and leaving the map entry behind.
  const p = Promise.resolve().then(fn).finally(() => {
    // Only delete OUR entry: if the job already settled and a later caller
    // started a fresh one under the same key, deleting blindly would evict the
    // new job's promise and let a third caller start a duplicate.
    if (map.get(key) === p) map.delete(key);
  });
  map.set(key, p);
  return p;
}

/** Is a job for this key running right now? (For a status/health answer only.) */
function inFlight(map, key) { return map.has(key); }

module.exports = { singleFlight, inFlight };
