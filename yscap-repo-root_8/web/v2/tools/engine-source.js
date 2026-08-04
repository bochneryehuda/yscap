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

  /* TWO HELPERS THE PAGE CALLS BEFORE ANY DEAL EXISTS — captured, not guessed.
     ============================================================================
     `normStrategy(s)` maps a strategy label to a code and `projectCount(code,
     exp)` adds up experience. The page calls both SYNCHRONOUSLY for display
     branching long before a quote has been asked for, so a server round trip
     cannot answer them, and the first version of this file served them from
     whatever answer happened to land last. Measured cost of that (audit
     2026-08-03, real browser): on a ground-up deal `normStrategy` returned null
     on the first call, so termsheet.js never bumped the term from 12 to 18 —
     and because it stamps `lastDeal` regardless, it never ran again. The deal
     then priced on the wrong term end to end, and the Gold card flipped from
     Eligible to Manual review. `projectCount` was worse: it ignored its
     arguments entirely and returned the last answer's number, which prints on
     the exported term-sheet PDF as the borrower's claimed experience.

     So capture the REAL ones off the local engines while they are still loaded
     — this file runs after their <script> tags. Neither is guideline data (one
     is a substring map, the other an addition), so nothing is duplicated and
     nothing leaks by keeping them local.

     PHASE 4 OPENS THIS AGAIN, DELIBERATELY UNRESOLVED HERE: deleting the
     engines from the public web root removes the very functions this captures.
     At that point the choice is a small non-guideline shim or having the server
     publish the strategy map itself. Both are real designs with a trade-off,
     so neither is invented on the way past — the fallbacks below keep this
     honest in the meantime (they answer "not known yet", never a wrong code). */
  var localYSP = root.YSP || null;
  var LOCAL_NORM = localYSP && typeof localYSP.normStrategy === 'function'
    ? function (s) { return localYSP.normStrategy(s); } : null;
  var LOCAL_COUNT = localYSP && typeof localYSP.projectCount === 'function'
    ? function (code, exp) { return localYSP.projectCount(code, exp); } : null;

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
      if (answer) { cache[key] = answer; announce(key); return; }
      /* THE ANSWER IS NOT COMING. Clear the pending mark anyway.
         Before this, `finish(null)` deleted the in-flight entry and returned —
         so markPending(false) was never reached on an aborted fetch, an HTTP
         500, a 429 from this door's own rate limit, `available:false`, or even
         from the 12-second timeout below. Measured (audit 2026-08-03, all four
         cases identical): the page stayed dimmed past 15 seconds, kept
         asserting "Not eligible / $0 / Couldn't size a loan from these
         inputs", showed no error wording anywhere, and re-fired the same
         request about 47 times a minute forever with no backoff — which under
         a 429 keeps the visitor's own bucket pinned.
         Leaving it dimmed forever is the worst of the options: it reads as a
         settled refusal. Clear the mark and say plainly that pricing is
         unavailable, so the page is honest about not knowing. */
      markPending(false);
      note('unavailable');
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

  /* THE DEAL ON SCREEN, not the fetch that happened to land last.
     ==========================================================================
     `lastAnswer` used to be stamped ONLY by onSettled — i.e. by whichever
     request resolved most recently — and three helpers resolve through it:
     YSTitle.estimate, caps, and the two pure helpers' fallbacks. None of those
     is called with anything that identifies the deal (the title global takes
     state/loan/txnType; caps takes four values read off the evaluation), so
     "the last answer" was standing in for "the deal being rendered". They are
     not the same thing, and the gap is not a flicker — it is sticky, because
     nothing fires another fetch to correct it.

     Measured (audit 2026-08-03, three independent passes over ~9.1M fields):
       * termsheet.js goldLadder() evaluates the deal once PER LEVERAGE RUNG
         with a different targetLTC. Each rung is its own cache key and its own
         POST, so the last rung to land leaves lastAnswer on a REDUCED-leverage
         deal. YSTitle.estimate then misses, returns {total:0}, and
         termsheet.js's `titleCost = title.total || 0` drops the whole title
         estimate out of cash-to-close and liquidity — rendered as a SETTLED
         number, and carried into the exported XLSX. Gold + slider: 7 of 7
         rungs wrong, deterministically. Cash to close $130,190 -> $126,845.
       * A plain retype (backspace, type the same digit back) is a CACHE HIT,
         which announced nothing, so lastAnswer stayed on the intermediate
         deal and the same title dropped out.
       * caps() answered from that stale deal too, printing "Max LTC 85%" on a
         card whose true program maximum is 92.5%.

     The fix is to make the seam track the deal it is CURRENTLY ANSWERING
     ABOUT. `evaluate(deal)` and `priceLadder(deal)` DO receive the deal, so
     they stamp it; everything that cannot identify a deal resolves through
     `current()` instead. `lastAnswer` is kept as the fallback for the window
     before the first evaluate, and is still refreshed on settle. */
  var currentKey = null;
  function answerFor(deal) {
    var a = cache[keyOf(deal)] || null;
    if (a) lastAnswer = a;          // a cache HIT is an answer too — announce() never fires for one
    return a;
  }
  function noteCurrent(deal) { currentKey = keyOf(deal); }
  function current() { return (currentKey && cache[currentKey]) || lastAnswer || null; }

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

  /* SAY WHEN PRICING IS UNAVAILABLE. A page that silently shows nothing is
     indistinguishable from a page that has decided against you — which is
     exactly what a visitor saw when this door was slow, erroring or rate
     limited. `data-ts-note` is a plain hook the host page styles; it is
     cleared the moment a real answer lands. */
  function note(kind) {
    try {
      var el = root.document && root.document.documentElement;
      if (!el) return;
      if (kind) el.setAttribute('data-ts-note', kind);
      else el.removeAttribute('data-ts-note');
    } catch (e) { /* cosmetic only */ }
  }

  /* One program's view. The signatures are the frozen engines' signatures —
     this is a drop-in, not a new interface. */
  function viewFor(name) {
    return {
      evaluate: function (deal) {
        noteCurrent(deal);          // whatever else runs, THIS is the deal on screen
        var a = answerFor(deal);
        if (!a) { want(deal); markPending(true); return pendingQuote(); }
        markPending(false);
        return (a[name] && a[name].evaluate) || pendingQuote();
      },
      priceLadder: function (deal) {
        // NOT noteCurrent: the ladder is asked about the SAME deal the card is
        // showing, and stamping here would be harmless — but goldLadder() walks
        // the rungs through evaluate(), which is where the deal genuinely
        // changes, so leave the stamp to the one caller that means it.
        var a = answerFor(deal);
        if (!a) { want(deal); return pendingLadder(); }
        return (a[name] && a[name].ladder) || pendingLadder();
      },
      caps: function () {
        // The page asks for caps using values it read off the evaluation it just
        // got, so the answer is already in that same payload — there is nothing
        // to look up by argument. Resolve it from the deal being RENDERED, not
        // from whichever fetch landed last (audit 2026-08-03: that printed a
        // 85% program maximum on a card whose real ceiling is 92.5%).
        var a = current();
        return (a && a[name] && a[name].caps) || null;
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
    if (LOCAL_NORM) return LOCAL_NORM(s);
    // No local engine to ask. Answer only about the strategy actually priced —
    // for anything else say "not known yet" rather than hand back the code of a
    // DIFFERENT strategy, which is what the previous version did (both of its
    // branches returned the same expression, so the test above was dead code).
    var a = current();
    if (a && a.deal && String(a.deal.strategy) === String(s)) {
      return (a.derived && a.derived.strategyCode) || null;
    }
    return null;
  }
  function projectCount(code, exp) {
    if (LOCAL_COUNT) return LOCAL_COUNT(code, exp);
    // Same rule: only answer about the deal that was priced. `null` rather than
    // 0 — "we do not know" and "the borrower has done none" are different
    // claims, and this number is printed on the term sheet.
    var a = current();
    var d = a && a.deal;
    var derived = a && a.derived;
    if (!d || !derived) return null;
    var sameCode = code == null || String(derived.strategyCode) === String(code);
    var sameExp = !exp || (
      Number(exp.flips || 0) === Number(d.expFlips || 0)
      && Number(exp.holds || 0) === Number(d.expHolds || 0)
      && Number(exp.ground || 0) === Number(d.expGround || 0)
    );
    return sameCode && sameExp ? derived.projectCount : null;
  }

  root.YSP = viewFor('standard');
  root.GSP = viewFor('gold');
  root.SVP = viewFor('silver');
  root.YSTitle = {
    /* THE THIRD ARGUMENT IS LOAD-BEARING. The frozen engine is
       `estimate(state, loan, txnType)` and the page passes all three
       (termsheet.js:551/611/672). The previous stub declared only two, matched
       on the floored loan amount alone, and — worse — fell back to the STANDARD
       program's figure on a miss. Audit 2026-08-03 measured that live: $3,600
       against $3,615 and $3,025 against $3,155 on ordinary deals, and on an
       ineligible deal a cash-to-close $2,520 short, all rendered as settled
       numbers. Match on everything the estimate depends on, and NEVER
       substitute one loan's title for another's. */
    estimate: function (state, loan, loanType) {
      // The deal being RENDERED — not the last fetch to resolve. Reading
      // lastAnswer here is what silently dropped the whole title estimate out
      // of cash-to-close and liquidity on every Gold leverage rung; see the
      // note above answerFor().
      var last = current();
      if (!last || !last.title || !last.titleFor) return { total: 0, pending: true };
      var names = ['standard', 'gold', 'silver'];
      var want = Math.floor(Number(loan) || 0);
      for (var i = 0; i < names.length; i++) {
        var f = last.titleFor[names[i]];
        if (!f) continue;
        if (Math.floor(Number(f.loan) || 0) !== want) continue;
        if (String(f.state || '') !== String(state || '')) continue;
        if (String(f.loanType || '') !== String(loanType || '')) continue;
        return last.title[names[i]] || { total: 0, pending: true };
      }
      // Nothing we hold was computed for THIS loan. Say so — a pending title
      // reads as an em-dash, which is honest; a substituted one reads as money.
      return { total: 0, pending: true };
    }
  };

  /* When an answer lands, tell the page to draw again. termsheet.js exposes its
     recompute as YS.recompute (or the page re-renders on an input event), so
     nudge whichever exists rather than reaching into its internals. */
  onSettled(function () {
    markPending(false);
    note(null);                 // a real answer landed — drop any 'unavailable' mark
    try {
      if (root.YS && typeof root.YS.recompute === 'function') { root.YS.recompute(); return; }
      var el = root.document && root.document.getElementById('price');
      if (el) el.dispatchEvent(new root.Event('input', { bubbles: true }));
    } catch (e) { /* the next keystroke will redraw anyway */ }
  });

  root.YS_ENGINE_SOURCE_ACTIVE = 'server';
})(typeof self !== 'undefined' ? self : this);
