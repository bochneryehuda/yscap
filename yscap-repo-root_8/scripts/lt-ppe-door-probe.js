'use strict';
/**
 * LT PPE — the DOOR PROBE. Preloaded (`node --require`) into a test suite by
 * `check-lt-ppe-route-tests.js`; it records which doors of `src/longterm/routes/ppe.js` that suite
 * actually INVOKED, and writes one JSON line per process on exit.
 *
 * WHY A PROBE AND NOT A GREP. "Does a suite test this door?" answered by scanning the suite's text is
 * answered by the word `quoteRoute` appearing in a comment — the same shape as the source-regex
 * assertions this workstream keeps finding, where a rule is proven by the presence of the sentence
 * that states it. Running the suite and watching the function be called is the only reading that
 * cannot be satisfied by a mention.
 *
 * IT WATCHES BOTH WAYS IN, because both are legitimate and they prove different things:
 *   · `route:<METHOD> <path>` — the request went through the ROUTER, so the mount, the gate chain and
 *     `wrap()` ran too;
 *   · `handler:<name>`        — the exported handler was called directly with a stub req/res, which
 *     covers the handler's own logic and nothing around it.
 *
 * It NEVER changes behaviour: every wrapper calls through and returns the original value, and a
 * failure to instrument is swallowed — a checker must not be able to fail the suite it is measuring.
 *
 * PURE instrumentation. No database, no network. LT-only.
 */
const Module = require('module');
const fs = require('fs');
const path = require('path');

const TARGET = process.env.LT_PPE_PROBE_TARGET ? path.resolve(process.env.LT_PPE_PROBE_TARGET) : null;
const OUT = process.env.LT_PPE_PROBE_OUT || null;
const SUITE = process.env.LT_PPE_PROBE_SUITE || 'unknown';

if (TARGET && OUT) {
  const hits = Object.create(null);
  const bump = (k) => { hits[k] = (hits[k] || 0) + 1; };

  let written = false;
  const flush = () => {
    if (written) return;
    written = true;
    try { fs.appendFileSync(OUT, `${JSON.stringify({ suite: SUITE, hits })}\n`); } catch (_) { /* the measurement is best-effort */ }
  };
  process.on('exit', flush);

  const instrument = (m) => {
    if (!m || m.__ltPpeProbed) return;
    try { Object.defineProperty(m, '__ltPpeProbed', { value: true, enumerable: false }); } catch (_) { return; }
    try {
      if (m.handlers) {
        for (const k of Object.keys(m.handlers)) {
          const fn = m.handlers[k];
          if (typeof fn !== 'function') continue;
          m.handlers[k] = function probed(...a) { bump(`handler:${k}`); return fn.apply(this, a); };
        }
      }
      // ONLY THE TERMINAL HANDLE of each route — the `wrap(handler)` one — and both halves of that
      // matter. Counting a request that the ADMIN GATE refused would let a suite that pings all 35
      // routes with an ordinary staff token report every gated door as covered while proving nothing
      // about any handler; and wrapping the gate itself would replace `requirePpeAdmin` with this
      // wrapper, breaking the identity check a suite uses to ask which routes are gated. So the probe
      // is invisible to the middleware chain and records only "the handler ran, through the router".
      for (const layer of (m.stack || [])) {
        if (!layer.route) continue;
        const p = layer.route.path;
        const chain = layer.route.stack || [];
        const s = chain[chain.length - 1];
        if (!s || !s.method) continue;
        const h = s.handle;
        const method = String(s.method).toUpperCase();
        s.handle = function probed(...a) { bump(`route:${method} ${p}`); return h.apply(this, a); };
      }
    } catch (_) { /* never break the suite being measured */ }
  };

  const origLoad = Module._load;
  Module._load = function ltPpeProbeLoad(request, parent, isMain) {
    const m = origLoad.apply(this, arguments);
    try {
      let resolved = null;
      try { resolved = Module._resolveFilename(request, parent, isMain); } catch (_) { resolved = null; }
      if (resolved === TARGET) instrument(m);
    } catch (_) { /* resolution is best-effort */ }
    return m;
  };
}
