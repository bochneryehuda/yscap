'use strict';
/**
 * ONE CLOCK FOR OPENSTREETMAP — because the limit is one request per second for
 * the PROCESS, not one per module that happens to remember to pace itself.
 *
 * Nominatim's usage policy is a hard published limit of one request per second,
 * and exceeding it is a policy breach that gets a user agent blocked — for
 * everyone using it, not just the caller who overshot. Four places in this
 * codebase call it: the address autocomplete (`routes/address.js`), the research
 * warehouse's geocoding sweep (`lib/research/geocode.js`), the ClickUp address
 * canonicaliser (`lib/address-canon.js`) and the API-health probe. Three of them
 * had a pacer; each had its OWN, so any two of them running together could fire
 * twice inside the same second while every one of them looked correct in
 * isolation. The comments even claimed the process-wide limit was handled.
 *
 * So the clock lives here and there is only one of it. `await osmGate()` returns
 * when it is this caller's turn; callers are served in the order they ask.
 *
 * IT IS A GATE, NOT A QUEUE MANAGER. It has no opinion about how many callers may
 * be waiting — a caller that must not queue unboundedly (a public endpoint) sheds
 * load before it gets here. It also never carries a rejection forward: the chain
 * gate swallows every outcome, because one failed lookup chaining a rejected
 * promise would break every future lookup until the process restarted (which is
 * exactly what a naive `chain = chain.then(fn)` does, and it happened once).
 */

// 1100ms rather than 1000: the limit is measured at the far end, and a request
// that leaves here exactly one second after the last one can still arrive inside
// the same second.
const MIN_GAP_MS = Number(process.env.OSM_MIN_GAP_MS || 1100);

let chain = Promise.resolve();
let last = 0;
// How many callers are waiting. A caller that must not queue behind a sweep reads
// this and gives up instead (see `osmWouldWait`).
let waiting = 0;

/** Wait until this caller may hit Nominatim. Never rejects. */
function osmGate() {
  waiting += 1;
  const turn = chain.then(async () => {
    const wait = MIN_GAP_MS - (Date.now() - last);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    // CLAMPED. `reset()` (tests) or any future re-initialisation can zero the
    // counter while turns are still pending, and their decrements would then drive
    // it NEGATIVE — which would make `osmWouldWait` report a negative wait and the
    // shed check silently stop shedding. A counter that cannot go below zero is
    // the honest floor.
  }).then(() => { waiting = Math.max(0, waiting - 1); }, () => { waiting = Math.max(0, waiting - 1); });
  chain = turn.then(() => {}, () => {});
  return turn;
}

/**
 * ROUGHLY HOW LONG A NEW CALLER WOULD WAIT, in milliseconds.
 *
 * A BACKGROUND SWEEP MUST NOT MAKE SOMEBODY'S TYPING STALL. One clock is right —
 * the limit is per process — but it means a 25-address ClickUp backfill tick
 * parks 27 seconds of work in front of the next keystroke on the public loan
 * application. Measured at 27,535ms against 0ms before the clocks were merged.
 *
 * An interactive caller therefore asks BEFORE it queues and answers "no
 * suggestions" instantly rather than making somebody watch a spinner for half a
 * minute. Nothing is lost: address autocomplete degrades to plain typing, which is
 * exactly what it does when the provider is down. A background sweep, which nobody
 * is watching, queues normally.
 */
function osmWouldWait() {
  const untilFree = Math.max(0, MIN_GAP_MS - (Date.now() - last));
  return Math.max(0, untilFree + waiting * MIN_GAP_MS);
}

/** Run `fn` on OpenStreetMap's turn. The caller still sees fn's own outcome. */
async function osmRun(fn) {
  await osmGate();
  return fn();
}

module.exports = {
  osmGate, osmRun, osmWouldWait, MIN_GAP_MS,
  _internals: { reset() { chain = Promise.resolve(); last = 0; waiting = 0; } },
};
