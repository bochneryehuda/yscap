'use strict';
/**
 * LONG-TERM — the MERGED pricing board: Lender Price + LoanNEX, one answer.
 *
 * Mounted at `/api/lt/dscr/merged` (staff-gated at the LT mount, exactly like the
 * Lender Price pricer) and again behind the secret-gated diagnostics seam.
 *
 * ── NOT LIVE ───────────────────────────────────────────────────────────────
 * Owner-directed 2026-08-30: *"Don't take it live till I'm telling you."* So the
 * merged board is OFF BY DEFAULT and stays off until `LT_MERGED_PRICING=on` is
 * set in the environment. With the flag unset every path here answers 404 —
 * hidden, not merely refused, so nothing can start depending on it by accident.
 * Turning the flag on changes nothing about Lender Price: `/api/lt/dscr/*`
 * remains exactly what it is today, and this router only ADDS a second board.
 *
 * ── DEGRADED IS NOT FAILED ─────────────────────────────────────────────────
 * The two programs are priced CONCURRENTLY and independently. If one refuses,
 * the board is still returned from the other, with the failure named in
 * `sources`. A pricing board that vanishes because a second vendor is down is
 * worse than one that says which half it is missing.
 *
 * ── THE BOARD IS ROUTED, AND WHAT IS HIDDEN SAYS SO ────────────────────────
 * Owner-directed 2026-08-30: Button Finance is not displayed at all, and each
 * investor can be pulled from whichever program the owner chooses. Both live in
 * `pricing/investor-routing.js`; every removal comes back in `hidden[]` with its
 * reason, so a board showing six investors where the vendors priced nine can
 * always account for the other three.
 *
 * ── ONE QUOTE SHAPE ────────────────────────────────────────────────────────
 * `?shape=options` returns both programs' quotes in the SAME option object
 * (`pricing/quote-shape.js`) — the shape the Lender Price screen already reads —
 * so a row cannot be told apart by where it came from. The itemized LLPAs on a
 * LoanNEX row need one extra call per quote; `POST /loannex/explain` is that
 * call, and until it is made the row's `adjustments` is NULL rather than empty.
 *
 * ── READ-ONLY ──────────────────────────────────────────────────────────────
 * Both clients are pricing VIEWERS. Nothing here locks, registers or books.
 *
 * SEPARATION: LT-only. Imports no RTL code.
 */
const express = require('express');

const lp = require('../lenderprice/client');
const lpPrograms = require('../lenderprice/investor-programs');
const { validateScenario } = require('../lenderprice/search-model');
const nex = require('../loannex/client');
const { merge } = require('../pricing/merge');
const routing = require('../pricing/investor-routing');
const quoteShape = require('../pricing/quote-shape');

/** The owner's not-live gate. Hidden (404) unless explicitly switched on. */
function enabled() { return String(process.env.LT_MERGED_PRICING || '').trim().toLowerCase() === 'on'; }

function scenarioOf(req) {
  const b = req.body || {};
  return b && typeof b === 'object' && b.scenario && typeof b.scenario === 'object' ? b.scenario : b;
}

/** An upstream failure, reduced to a reason string a caller may safely see. */
function reasonOf(e) {
  if (!e) return 'unknown_error';
  const code = e.code || e.name || 'error';
  const msg = String(e.message || '').slice(0, 300);
  return msg || String(code);
}

/**
 * OUR OWN SETUP GAP IS NOT AN UPSTREAM FAILURE, and answering 502 for one is a
 * lie about whose fault it is. Every code below describes THIS deployment — no
 * credentials set, a ticket that is spent or single-use, or credentials the
 * portal refused — and in none of them did LoanNEX fail at anything. A
 * diagnostic route reports that as a successful reading of a known state; only a
 * genuine vendor failure is a 502.
 *
 * It matters on the first step somebody takes: switching the flag on before
 * setting a username used to answer "Bad Gateway", which reads as "LoanNEX is
 * down" when the truth is "you have not told me who to sign in as".
 *
 * DELIBERATELY ABSENT: `loannex_antiforgery_not_found` and
 * `loannex_portal_redirect_loop`. Those mean the sign-in PAGE no longer looks
 * the way it did when it was recorded — a change at their end, not a gap at
 * ours — so they stay a 502 and read as something to go and look at.
 */
const NOT_CONFIGURED = new Set([
  'loannex_login_not_configured',
  'loannex_token_exchange_failed',
  'loannex_login_failed',
]);
function isNotConfigured(e) { return !!(e && NOT_CONFIGURED.has(e.code)); }

/**
 * Price one scenario on BOTH programs, concurrently, and merge.
 *
 * ONE ENRICHED SCENARIO, ASKED TWICE. The ZIP is resolved to state + county
 * ONCE, up front, and both vendors are asked about that same enriched scenario.
 * Enriching separately would let a merged board compare two DIFFERENT loans and
 * present the difference as a pricing advantage.
 *
 * A REFUSAL IS NOT AN EMPTY BOARD — the sharpest trap here. The Lender Price
 * client REPORTS failure as `{ ok: false }` rather than throwing, so a missing
 * credential or an upstream 500 arrives as a fulfilled promise. Treated as data
 * it would look like "Lender Price quoted nothing", every investor would be
 * elected to LoanNEX unopposed, and the board would state that with full
 * confidence. So `ok === false` is converted to an ERROR here, and an
 * unanswered program is never merged as an empty one.
 */
async function priceBoth(scenario, opts = {}) {
  // ZIP → state + county, once, for both. A location we cannot resolve is a
  // caller error and stops the whole request rather than half of it.
  const chk = validateScenario(scenario || {});
  if (!chk.ok) {
    const err = new Error(chk.message || 'invalid scenario');
    err.code = chk.error; err.field = chk.field; err.status = chk.status || 422;
    throw err;
  }
  const sc = chk.scenario;

  const [lpRes, nxRes] = await Promise.allSettled([
    (async () => {
      const r = await lp.price(sc, opts.lenderprice || {});
      if (!r || r.ok === false) {
        const err = new Error(r && (r.message || r.error) ? `${r.error || 'lp_error'}: ${r.message || ''}`.trim() : 'lp_error');
        err.code = (r && r.error) || 'lp_error';
        throw err;
      }
      const parsed = lp.parse(r.raw);
      // Stamp canonical identity + white-label on the Lender Price side exactly
      // as the existing pricer does, so both halves reach the merge decorated the
      // same way. `decorate` takes the PROGRAMS ARRAY and answers
      // { programs, roster, unmapped }.
      const deco = lpPrograms.decorate(parsed.programs) || {};
      return { ...parsed, programs: deco.programs || parsed.programs, searchKey: r.searchKey || null, provenance: r.provenance || null };
    })(),
    nex.price(sc, opts.loannex || {}),
  ]);

  const boards = {
    lenderprice: lpRes.status === 'fulfilled' ? lpRes.value : null,
    loannex: nxRes.status === 'fulfilled' ? nxRes.value.board : null,
  };
  const errors = {
    lenderprice: lpRes.status === 'rejected' ? reasonOf(lpRes.reason) : null,
    loannex: nxRes.status === 'rejected' ? reasonOf(nxRes.reason) : null,
  };
  const merged = routing.applyRouting(merge(boards, { errors }), { routes: opts.routes });

  // The unified option list, on request. Built from the ROUTED board so a
  // suppressed or routed-away investor cannot reappear through a second door.
  let options;
  if (opts.shape === 'options') {
    const io = sc.io;
    const rows = [];
    for (const e of merged.investors) {
      for (const src of e.shownFrom) {
        const built = src === 'loannex'
          ? quoteShape.optionsFromLoanNex({ programs: e.programs.loannex }, { loanAmount: sc.loan, fico: sc.fico, ltv: sc.ltv, loanPurpose: sc.purpose })
          : quoteShape.optionsFromLenderPrice(e.programs.lenderprice);
        for (const o of built) rows.push({ ...o, investorKey: e.key, whiteLabel: e.whiteLabel });
      }
    }
    // Interest-only: an INPUT on Lender Price, a PRODUCT on LoanNEX. Narrowing
    // here is what makes the two boards answer the same question.
    const f = quoteShape.filterInterestOnly(rows, io);
    options = { count: f.options.length, filteredByInterestOnly: f.filtered, unclassifiedCount: f.unknown.length, rows: f.options };
  }

  return {
    merged,
    options,
    scenario: { requested: scenario || {}, priced: sc, countyEnrichment: chk.countyEnrichment || null },
    // How each half was ASKED — a merged number nobody can trace back to a
    // request is not a number anybody should price a loan on.
    provenance: {
      lenderprice: lpRes.status === 'fulfilled' ? { searchKey: lpRes.value.searchKey, provenance: lpRes.value.provenance } : null,
      loannex: nxRes.status === 'fulfilled'
        ? { portal: nxRes.value.portal, portalId: nxRes.value.portalId, transactionId: nxRes.value.transactionId, county: nxRes.value.county, registry: nxRes.value.registry }
        : null,
    },
  };
}

function makeRouter() {
  const router = express.Router();

  // The gate. Every path below is invisible until the owner switches it on.
  router.use((req, res, next) => (enabled() ? next() : res.status(404).json({ error: 'not_found', hint: 'merged pricing is off (LT_MERGED_PRICING)' })));

  /** Is each program configured? No login attempted. */
  router.get('/health', (req, res) => {
    const nx = nex.configured();
    res.json({
      ok: true, live: false, flag: 'LT_MERGED_PRICING=on',
      programs: {
        // `lp.configured()` answers a plain boolean — read it as one rather than
        // probing it for a shape it does not have.
        lenderprice: { configured: !!lp.configured() },
        loannex: {
          configured: nx.ok, via: nx.tokenKey ? 'token_key' : (nx.login ? 'login' : null),
          portal: nx.portal,
          // Implemented is not the same as PROVEN. Said plainly so nobody reads a
          // green tick as "we have signed in successfully".
          loginImplemented: nx.loginImplemented,
          loginExercised: nx.loginExercised,
          note: nx.ok ? 'The portal sign-in is implemented from the recording but has not yet been run against the live site. The first login-check is what proves it.'
            : 'Not configured: set NEX_USERNAME and NEX_PASSWORD, or paste NEX_TOKEN_KEY from a live browser session.',
        },
      },
    });
  });

  /** Actually authenticate against LoanNEX and report who the session belongs to. */
  router.get('/loannex/login-check', (req, res) => {
    nex.loginCheck(req.query.portal)
      .then((r) => res.json(r))
      .catch((e) => {
        // Reporting "we are not set up yet" IS this route's job, so it is a 200
        // with ok:false — never a 502, which would blame LoanNEX for our gap.
        const body = { ok: false, error: e.code || 'loannex_login_error', message: reasonOf(e) };
        if (isNotConfigured(e)) return res.json({ ...body, configured: false });
        return res.status(502).json(body);
      });
  });

  /** The merged board. `?shape=options` for the one-shape quote list. */
  router.post('/price', (req, res) => {
    const b = req.body || {};
    priceBoth(scenarioOf(req), {
      loannex: { portal: b.portal },
      shape: b.shape || req.query.shape,
      routes: b.routes,   // an explicit map overrides the environment's
    })
      .then((r) => res.json({ ok: true, ...r }))
      .catch((e) => res.status(e.status || 400).json({ ok: false, error: e.code || 'lt_merged_price_error', field: e.field || null, message: reasonOf(e) }));
  });

  /** LoanNEX alone — for comparing the two boards side by side. */
  router.post('/loannex/price', (req, res) => {
    nex.price(scenarioOf(req), { portal: (req.body || {}).portal, raw: !!(req.body || {}).raw })
      .then((r) => res.json({ ok: true, ...r }))
      .catch((e) => res.status(400).json({ ok: false, error: e.code || 'loannex_price_error', field: e.field || null, message: reasonOf(e) }));
  });

  /**
   * WHY each investor said no. A plain GET against LoanNEX — no polling window,
   * unlike the Lender Price disqualify flow.
   */
  router.get('/loannex/disqualify/:transactionId', (req, res) => {
    nex.fails(req.params.transactionId, { portal: req.query.portal })
      .then((r) => res.json({ ok: true, ...r }))
      .catch((e) => res.status(isNotConfigured(e) ? 503 : 502)
        .json({ ok: false, error: e.code || 'loannex_fails_error', message: reasonOf(e) }));
  });

  /**
   * The routes in force, and what they hide. Answers "why is this lender not on
   * my board?" without anybody reading code.
   */
  router.get('/routing', (req, res) => {
    const cfg = routing.readRoutes();
    res.json({
      ok: true,
      defaultRoute: routing.DEFAULT_ROUTE,
      choices: routing.ROUTES,
      routes: cfg.routes,
      problems: cfg.problems,
      neverDisplayed: routing.SUPPRESSED.map((s) => ({ investor: s.label, reason: s.reason })),
      note: 'An investor with no route is shown from BOTH programs. Set LT_PRICING_ROUTES to a JSON map of investorKey -> both|lenderprice|loannex|off.',
    });
  });

  /**
   * EXPLAIN ONE LOANNEX QUOTE — the itemized LLPAs behind it.
   *
   * One call per quote, which is how LoanNEX's own screen works. The board
   * itself needs no such call: the complete rate/lock ladder for every program
   * already arrives with the single pricing request (measured — the vendor's
   * own /rate-stacks answer is that same ladder, identical to the thousandth).
   */
  router.post('/loannex/explain', (req, res) => {
    const b = req.body || {};
    const quote = b.quote || b;
    if (!quote || !quote.priceHashKey) {
      return res.status(400).json({ ok: false, error: 'missing_quote', message: 'Send the quote to explain, including its priceHashKey (the `explain` block on any LoanNEX option row).' });
    }
    nex.evidence(scenarioOf(req), quote, { portal: b.portal, transactionId: b.transactionId })
      .then((r) => res.json({ ok: true, ...r }))
      .catch((e) => res.status(isNotConfigured(e) ? 503 : 502)
        .json({ ok: false, error: e.code || 'loannex_evidence_error', message: reasonOf(e) }));
  });

  return router;
}

module.exports = { makeRouter, _internals: { enabled, priceBoth, scenarioOf, reasonOf, routing, quoteShape } };
