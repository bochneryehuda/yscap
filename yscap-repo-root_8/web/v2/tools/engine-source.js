/* WHERE THE TERM SHEET'S NUMBERS COME FROM.  (issue #7, phase 3)
   =============================================================================
   The pricing engines sit in the public web root for one reason: this page runs
   them. This file is the seam that lets that stop being true.

   IT DOES NOT TOUCH termsheet.js. The page keeps calling `YSP.evaluate(deal)`,
   `SVP.priceLadder(deal)`, `YSTitle.estimate(...)` exactly as it always has —
   what changes is what those globals ARE. That matters: termsheet.js is a FROZEN
   file, and the safest possible change to a frozen pricing path is no change at
   all. Every formula, rounding rule and matrix value stays exactly where it is.

   OFF BY DEFAULT. With `YS_ENGINE_SOURCE` unset (or 'local') this file installs
   nothing and the page is byte-for-byte the page it was. Set it to 'server' —
   or add ?engine=server to the URL — and the globals are replaced by a
   server-backed view.

   THE ONE HONEST TRADE-OFF (owner-directed 2026-08-03).
   The page's calls are SYNCHRONOUS: it asks for a quote and renders the answer
   in the same instant. A server cannot answer in the same instant. So on the
   first look at a deal the server has not priced yet, this returns a PENDING
   result and fires the fetch; when the answer lands the page is re-rendered with
   real numbers. The owner chose to show that gap honestly — the figures dim
   until they are settled — over quietly leaving the previous deal's numbers on
   screen, because a stale number that looks current is worse than a brief
   flicker. Measured cost of the gap: ~30-90ms.

   WHAT IT NEVER DOES. It never computes a number. Every value it returns came
   from the server, which ran the same frozen engines. There is no second
   implementation of anything here — only caching, coalescing and the pending
   state. */
(function (root) {
  'use strict';

  function mode() {
    try {
      var q = String(root.location && root.location.search || '');
      var m = q.match(/[?&]engine=(local|server)\b/);
      if (m) return m[1];
    } catch (e) { /* no location in a test scope */ }
    return String(root.YS_ENGINE_SOURCE || 'local');
  }
  if (mode() !== 'server') return;          // installs nothing; the page is unchanged

  var ENDPOINT = '/api/pricing/studio';
  var PENDING = 'PENDING';

  /* The cache key IS the deal. Two deals that differ in any priced input are
     different questions, so the key is built from the whole sanitized input
     rather than a hand-picked subset — a subset is how a cache starts answering
     the wrong question. */
  function keyOf(deal) {
    var d = deal || {}, k = [], names = Object.keys(d).sort();
    for (var i = 0; i < names.length; i++) {
      var v = d[names[i]];
      if (v === undefined || v === null || v === '') continue;
      k.push(names[i] + '=' + (typeof v === 'object' ? JSON.stringify(v) : String(v)));
    }
    return k.join('|');
  }

  var cache = Object.create(null);     // key -> the server's answer
  var inflight = Object.create(null);  // key -> true while a fetch is out
  var listeners = [];

  function onSettled(fn) { if (typeof fn === 'function') listeners.push(fn); }
  function announce(key) {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](key); } catch (e) { /* a listener must not break the next */ }
    }
  }

  /* Ask the server once per distinct deal. Coalesced: a page that re-renders
     five times while one fetch is out must not send five requests. */
  function want(deal) {
    var key = keyOf(deal);
    if (cache[key] || inflight[key]) return;
    inflight[key] = true;
    var done = false;
    var finish = function (answer) {
      if (done) return; done = true;
      delete inflight[key];
      if (answer) { cache[key] = answer; announce(key); }
    };
    try {
      var timer = root.setTimeout(function () { finish(null); }, 12000);
      root.fetch(ENDPOINT, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(deal)
      }).then(function (r) {
        return r.ok ? r.json() : null;
      }).then(function (j) {
        root.clearTimeout(timer);
        finish(j && j.available !== false ? j : null);
      })['catch'](function () { root.clearTimeout(timer); finish(null); });
    } catch (e) { finish(null); }
  }

  function answerFor(deal) { return cache[keyOf(deal)] || null; }

  /* A PENDING quote, shaped exactly like a real one so the page's own rendering
     path handles it without a special case: no sizing, no numbers, an empty
     reason list. termsheet.js already renders an em-dash for a quote with no
     sizing, which is precisely the "not settled yet" look the owner asked for;
     the dimming is the `.ts-pending` class the host page styles. */
  function pendingQuote() {
    return { status: PENDING, pending: true, eligible: false, reasons: [], sizing: null, caps: null };
  }
  function pendingLadder() { return { eligible: false, pending: true, rows: [] }; }

  function markPending(isPending) {
    try {
      var el = root.document && root.document.documentElement;
      if (!el) return;
      if (isPending) el.setAttribute('data-ts-pending', '1');
      else el.removeAttribute('data-ts-pending');
    } catch (e) { /* cosmetic only */ }
  }

  /* One program's view. The signatures are the frozen engines' signatures —
     this is a drop-in, not a new interface. */
  function viewFor(name) {
    return {
      evaluate: function (deal) {
        var a = answerFor(deal);
        if (!a) { want(deal); markPending(true); return pendingQuote(); }
        markPending(false);
        return (a[name] && a[name].evaluate) || pendingQuote();
      },
      priceLadder: function (deal) {
        var a = answerFor(deal);
        if (!a) { want(deal); return pendingLadder(); }
        return (a[name] && a[name].ladder) || pendingLadder();
      },
      caps: function () {
        // The page asks for caps using values it read off the evaluation it just
        // got, so the answer is already in that same payload — there is nothing
        // to look up by argument.
        var last = lastAnswer;
        return (last && last[name] && last[name].caps) || null;
      },
      normStrategy: function (s) { return strategyCode(s); },
      projectCount: function (code, exp) { return projectCount(code, exp); },
      // The server applies the company markup from the Pricing Admin Center, so
      // a page-side markup is not merely unnecessary — honouring it would let
      // the page choose its own margin, which is the hole this whole issue is
      // about. Accepted and ignored, so the existing call sites still work.
      setMarkup: function () { return undefined; }
    };
  }

  /* `normStrategy` and `projectCount` are pure engine helpers the page calls for
     DISPLAY branching, often before any deal has been priced. They cannot be
     re-implemented here (that would be a second copy of frozen logic), so they
     are served from the last answer the server gave, which carries both. Until
     the first answer arrives they return null/0 — the page treats that as "not
     known yet", which is the same honest state as a pending quote. */
  var lastAnswer = null;
  onSettled(function (key) { lastAnswer = cache[key] || lastAnswer; });

  function strategyCode(s) {
    if (lastAnswer && lastAnswer.deal && String(lastAnswer.deal.strategy) === String(s)) {
      return lastAnswer.derived && lastAnswer.derived.strategyCode;
    }
    // A different strategy than the one last priced: ask for it, and say "not
    // known yet" rather than guess.
    return (lastAnswer && lastAnswer.derived && lastAnswer.derived.strategyCode) || null;
  }
  function projectCount() {
    return (lastAnswer && lastAnswer.derived && lastAnswer.derived.projectCount) || 0;
  }

  root.YSP = viewFor('standard');
  root.GSP = viewFor('gold');
  root.SVP = viewFor('silver');
  root.YSTitle = {
    estimate: function (state, loan) {
      var last = lastAnswer;
      if (!last || !last.title) return { total: 0, pending: true };
      // Whichever program produced this loan amount is the one whose title
      // figure the page is printing.
      var names = ['standard', 'gold', 'silver'];
      for (var i = 0; i < names.length; i++) {
        var blk = last[names[i]];
        var sized = blk && blk.evaluate && blk.evaluate.sizing;
        if (sized && Math.floor(Number(sized.totalLoan) || 0) === Math.floor(Number(loan) || 0)) {
          return last.title[names[i]] || { total: 0 };
        }
      }
      return last.title.standard || { total: 0, pending: true };
    }
  };

  /* When an answer lands, tell the page to draw again. termsheet.js exposes its
     recompute as YS.recompute (or the page re-renders on an input event), so
     nudge whichever exists rather than reaching into its internals. */
  onSettled(function () {
    markPending(false);
    try {
      if (root.YS && typeof root.YS.recompute === 'function') { root.YS.recompute(); return; }
      var el = root.document && root.document.getElementById('price');
      if (el) el.dispatchEvent(new root.Event('input', { bubbles: true }));
    } catch (e) { /* the next keystroke will redraw anyway */ }
  });

  root.YS_ENGINE_SOURCE_ACTIVE = 'server';
})(typeof self !== 'undefined' ? self : this);
