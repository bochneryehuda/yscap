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

/** Wait until this caller may hit Nominatim. Never rejects. */
function osmGate() {
  const turn = chain.then(async () => {
    const wait = MIN_GAP_MS - (Date.now() - last);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
  });
  chain = turn.then(() => {}, () => {});
  return turn;
}

/** Run `fn` on OpenStreetMap's turn. The caller still sees fn's own outcome. */
async function osmRun(fn) {
  await osmGate();
  return fn();
}

module.exports = { osmGate, osmRun, MIN_GAP_MS, _internals: { reset() { chain = Promise.resolve(); last = 0; } } };
