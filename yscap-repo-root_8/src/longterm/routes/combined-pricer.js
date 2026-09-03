'use strict';
/**
 * LONG-TERM — THE COMBINED PRICING ENGINE: Lender Price + LoanNEX, one answer.
 *
 * Mounted at `/api/lt/dscr/combined` and again behind the secret-gated
 * diagnostics seam.
 *
 * ── A SECOND ENGINE, BESIDE THE FIRST — NEVER ON TOP OF IT ─────────────────
 * Owner-directed 2026-08-30:
 *
 *   *"Don't touch our current setup that we currently have: our General Pricing
 *   Engine. Just make this totally separate, but copy everything from the
 *   General Pricing Engine and add this as it is… I am going to test the system
 *   that works on both together: Lender Price and LoanNEX. If it's going to be
 *   good, then I am going to merge everything into the General Pricing Engine
 *   and bring in the features of this one."*
 *
 * So `/api/lt/dscr/*` — the General Pricing Engine — is byte-for-byte what it
 * was, and this router only ADDS a second engine beside it. Nothing here is
 * reachable from the general engine's screen, and nothing the general engine
 * answers passes through here.
 *
 * ── SUPER ADMIN ONLY, AND LIVE ─────────────────────────────────────────────
 * Owner-directed, same day: *"Merge this live into domain only for super admin
 * to be able to see it and super admin to be able to test it… so I can audit
 * everything before I want to go live to the general pricing engine."*
 *
 * So this is DEPLOYED — the earlier *"don't take it live till I'm telling you"*
 * is superseded FOR THIS SURFACE, and only for this one — and the gate is the
 * ROLE, not a flag: every path answers 404 to anybody who is not a super admin.
 * 404, not 403, so its existence is not advertised to the rest of the team.
 *
 * ⛔ THE GATE READS THE REAL STAFF ROLE (`req.actor.role`, which authenticate()
 * takes from the staff row rather than the token's own claim) and DELIBERATELY
 * NOT the long-term role from `access.js`. That one can be OVERRIDDEN in
 * settings so somebody's long-term job title can be corrected — which is right
 * for a pipeline scope and exactly wrong here: an engine under audit must not be
 * reachable by a settings edit.
 *
 * `LT_COMBINED_PRICING` remains as a KILL SWITCH, default ON: setting it to
 * `off` hides the engine from super admins too, without a deploy.
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
const lpModel = require('../lenderprice/search-model');
const { validateScenario } = lpModel;
const nex = require('../loannex/client');
const mergeMod = require('../pricing/merge');
const { merge } = mergeMod;
const routing = require('../pricing/investor-routing');
const investorConfig = require('../pricing/investor-config');
const settingsRoutes = require('./investor-settings-routes');
const investorLinks = require('../pricing/investor-links');
// The canonical investor roster and the client-safe names, both read-only here —
// the pick-list a person chooses from is DERIVED from the one registry, never a
// second list this route keeps for itself.
const { whiteLabelOf } = require('../lenderprice/investor-programs');
const quoteShape = require('../pricing/quote-shape');
const productFilter = require('../pricing/product-filter');
const breakdown = require('../pricing/breakdown');
const nearTier = require('../pricing/near-tier');
const vendorMargin = require('../pricing/vendor-margin');
const settingsStore = require('../settings/store');
const rosterContext = require('../pricing/roster-context');
const roster = require('../pricing/investor-roster');
const sealedPrice = require('../pricing/sealed-price');
/* ⛔ THE EXPLAIN DOOR AND ITS HELPERS — ONE DEFINITION, MOUNTED BY BOTH ENGINES.
   These functions used to live in this file; they were moved so the General Pricing
   Engine could mount the SAME door rather than grow a second one. Required back under
   their own names, so every other door in this file reads exactly as it did. */
const explainDoor = require('./explain-door');
const {
  stripExplainedTrail, searchIdentity, quoteFromBody, vendorQuote, holdbackOnRow,
  scenarioOf, explainScenario, scenarioRefused, askedOf, reasonOf, isNotConfigured,
} = explainDoor;

/**
 * An investor with nothing shapeable — never a guess, always an honest empty.
 *
 * This replaces a `groupBySource(programs)` helper that split an investor's flat
 * list back up by each row's own `source`. It could not work where it was used:
 * the one-system view STRIPS `source` before anybody outside sees it, so on the
 * ordinary board every row read as sourceless, was dropped as unshapeable, and
 * `?shape=options` answered with an empty list. The split now comes from a
 * revealing pass over the same merged board (see the options branch below),
 * which is the only place it can honestly come from.
 *
 * The rule it enforced still stands and still matters: a row whose vendor we do
 * not know is DROPPED rather than guessed at, because shaping a LoanNEX row with
 * the Lender Price mapper silently produces an option with no price.
 */
const EMPTY_SPLIT = { lenderprice: [], loannex: [] };

/**
 * WHICH SAVED COPY OF THE INVESTOR SETTINGS IS IN FORCE.
 *
 * ONE resolution, shared by the settings screen's read, its write, and the board
 * — see the note on `readSettings` in pricing/investor-settings.js. NEVER
 * THROWS: an unreadable settings store must not take the pricing engine down
 * with it, so it falls back to the environment (and then to the pre-fills) and
 * REPORTS the problem rather than swallowing it.
 */
/* ⛔ ONE DEFINITION, in `pricing/investor-config.js`. The General Pricing Engine reads
   these same four settings now (owner-directed 2026-09-03), and the settings are
   addressed by KEY STRINGS — two engines each holding their own copy of
   'pricing.combinedInvestors' is one rename away from a screen saving to a key the
   other never reads, which would look like an investor that will not turn off. */
const settingsRaw = () => investorConfig.investorsRaw();

/**
 * THE SAVED MARGIN HOLDBACK, or nothing if nobody has set one.
 *
 * NEVER THROWS, and — unlike every other reader here — a failure must not fall
 * toward doing nothing. `resolveHoldback` treats an absent value as "use the
 * owner's standing 0.25", so returning `undefined` on an unreadable store keeps
 * the holdback ON. A settings outage that quietly stopped holding it back would
 * hand every borrower 0.25 of better execution nobody decided to give them.
 */
const holdbackRaw = () => investorConfig.holdbackRaw();






/**
 * Every grid CELL a board already carries, in the shape `near-tier` reads.
 *
 * ⛔ IT READS THE MERGED-RAW BOARD, never the routed one: the routed copy strips
 * provenance for the one-system rule, and a cell is the vendor's own words about
 * its own sheet. Nothing here is shown — the cells are read for their BAND and
 * the flag that comes out names a tier, never a vendor.
 *
 * Defensive at every hop: this walks two vendors' parsed answers, and a board
 * that is a shape short must cost the flag, never the board.
 */
function cellsOnBoard(board) {
  const out = [];
  try {
    for (const p of (board && board.programs) || []) {
      for (const r of (p && p.rungs) || []) {
        for (const a of (r && r.adjustments) || []) {
          if (!a || typeof a !== 'object') continue;
          out.push({ label: a.label || a.reason || a.name || null, detail: a.detail || a.description || null });
        }
      }
    }
  } catch (_) { /* a hint is never worth a board */ }
  return out;
}

/** Every investor name a board actually returned, in the order it returned them. */
function namesOf(board) {
  const out = [];
  for (const p of (board && board.programs) || []) {
    const n = p.investor || p.lender;
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * The human's "these two names are the same investor" map.
 *
 * Read exactly like the routing settings above and with the same posture: an
 * unreadable store yields NO links, which is the behaviour this engine had
 * before links existed — a broken setting can cost the links, never the board.
 */
const linksRaw = () => investorConfig.linksRaw();

/**
 * THE INVESTORS SOMEBODY ADDED BY HAND, as a Map every roster reader takes.
 *
 * Same posture again, and it matters most here: an unreadable store yields the
 * REGISTRY ALONE. A hand-added investor then prices exactly as it did before it
 * was added — it drops off the board as an unmapped name rather than pricing
 * under a white label nobody could verify — and `customInvestors.problem` on the
 * answer says why, so the screen can tell somebody instead of showing a shorter
 * list as though that were the truth.
 */
const customRaw = () => investorConfig.customRaw();

/**
 * The kill switch. DEFAULT ON — the owner asked for this engine to be live on the
 * domain for super admins to test. Setting `LT_COMBINED_PRICING=off` hides it
 * from everybody, including a super admin, with no deploy.
 *
 * Deliberately "anything other than off is on", the opposite reading to the old
 * not-live flag: a typo in the switch must leave the engine WORKING rather than
 * silently 404-ing the one surface the owner is auditing.
 */
function enabled() { return String(process.env.LT_COMBINED_PRICING || '').trim().toLowerCase() !== 'off'; }

/**
 * SUPER ADMIN ONLY. Read the REAL staff role, never the long-term override.
 *
 * `authenticate()` builds `req.actor` as `{ id, kind, role, sid }` and sets
 * `role` from the staff row of the token's subject — so a forged claim cannot
 * reach this, and neither can `access.roleOverrides`, which is a settings map
 * for correcting somebody's long-term job title.
 *
 * FAILS CLOSED: no actor (the diagnostics seam has none) is not a super admin,
 * which is why that seam passes `superAdminOnly: false` explicitly and carries
 * its own shared-secret gate instead.
 */
function isSuperAdmin(req) {
  const a = req && req.actor;
  return !!(a && a.kind === 'staff' && String(a.role || '') === 'super_admin');
}







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

  // Read BEFORE the vendors are called: the holdback has to be in hand at the
  // moment LoanNEX's answer lands, and an explicit value in the request still
  // wins so a caller can price a what-if without saving it (the same rule the
  // investor routes follow).
  const heldSetting = opts.marginHoldback !== undefined ? opts.marginHoldback : await holdbackRaw();
  /**
   * EACH INVESTOR'S OWN EXTRA, read from the SAME saved settings the routing and
   * the settings screen read (owner-directed 2026-08-30). Resolved BEFORE the
   * vendors are called for the same reason the global figure is: the answer has
   * to be in hand at the moment a board lands.
   *
   * ⛔ THE INVESTOR A ROW BELONGS TO IS RESOLVED BY `merge.resolveInvestor`, the
   * ONE resolver — the same one the merge itself uses, with the same recorded
   * links. A second lookup here would eventually put one investor's extra on
   * another investor's rows, and the price on the board is what somebody quotes.
   */
  // THE INVESTORS ADDED BY HAND, READ ONCE FOR THE WHOLE BOARD. Every reader
  // below takes the map as an argument, so the holdback, the merge, the routing
  // and the pairing all answer about the SAME roster — reading it per-reader is
  // how one of them ends up not knowing about an investor the others priced.
  const customCtx = opts.custom !== undefined
    ? { custom: roster.asCustom(opts.custom), problems: [], problem: null }
    : await customRaw();
  const custom = customCtx.custom;
  const savedForHoldback = opts.routes !== undefined ? { raw: opts.routes } : await settingsRaw();
  const linksForHoldback = opts.links !== undefined ? { raw: opts.links } : await linksRaw();
  const investorRows = routing.readSettings(savedForHoldback.raw, custom).settings;
  const linkMapForHoldback = investorLinks.readLinks(linksForHoldback.raw, custom).links;
  const extraFor = routing.extraResolver(investorRows, linkMapForHoldback, custom);

  const [lpRes, nxRes] = await Promise.allSettled([
    (async () => {
      const r = await lp.price(sc, opts.lenderprice || {});
      if (!r || r.ok === false) {
        const err = new Error(r && (r.message || r.error) ? `${r.error || 'lp_error'}: ${r.message || ''}`.trim() : 'lp_error');
        err.code = (r && r.error) || 'lp_error';
        throw err;
      }
      /**
       * ⛔ `withOptions` IS WHAT MAKES THE DETAILS PANEL WORK, and leaving it off is the defect it
       * was added for. `lp.parse` alone returns the LADDER — rate, price, points per rung — and
       * nothing else, so every Lender Price row on this board reached the screen with no itemized
       * LLPAs, no fees, no comp, no terms and no monthly payment, and the breakdown panel drew an
       * empty table on the vendor that publishes the whole build WITH the search. Worse, a program
       * carrying `rungs` and no `options` is routed down the LOANNEX branch by
       * `quote-shape.programsForBoard` — which tells the two apart by shape, not by name, since the
       * one-system rule has already stripped the source — so those rows were additionally rebuilt
       * as LoanNEX rows: `basePoints`/`adjustmentPoints` hard-coded null and the monthly payment
       * read from a key a Lender Price rung does not carry.
       *
       * The general engine has always fetched this (its `full:true` path), and the combined screen
       * has always ASKED for it — `pricerEngine.COMBINED_ENGINE.price` sends `full: true` — but
       * this route never read the flag. It is not read now either: the itemization is what this
       * board is FOR, and a flag is one more way for the panel to be empty again.
       */
      const parsed = lp.parse(r.raw, { withOptions: true });
      // Stamp canonical identity + white-label on the Lender Price side exactly
      // as the existing pricer does, so both halves reach the merge decorated the
      // same way. `decorate` takes the PROGRAMS ARRAY and answers
      // { programs, roster, unmapped }.
      const deco = lpPrograms.decorate(parsed.programs, custom) || {};
      const withPrograms = { ...parsed, programs: deco.programs || parsed.programs };
      /**
       * ⛔ AN INVESTOR'S OWN EXTRA REACHES LENDER PRICE; THE GLOBAL FIGURE STILL
       * DOES NOT. Those are two different decisions. The global holdback exists
       * to bring LoanNEX's raw feed onto the same footing as this one, which
       * ALREADY carries our standard margin — applying it here would take it
       * twice, and `resolveHoldback` refuses it for that reason. An extra is the
       * owner naming ONE investor they want more held back on, which the owner
       * asked for on "each and every program". With none set anywhere this
       * returns the same object it was handed.
       */
      const held = vendorMargin.applyToBoard(withPrograms, 'lenderprice', { extraFor });
      // THE WIRE REQUEST RIDES BACK for the narrowing below. `r.request` is the body the client
      // actually POSTed — built on the tenant's LIVE foundation — and is the only honest copy of
      // what Lender Price was asked; the static build under `chk.request` is its FALLBACK. It is
      // stripped off again before the board is answered (see `lpBoard`).
      return { ...held, searchKey: r.searchKey || null, provenance: r.provenance || null, request: r.request || null };
    })(),
    nex.price(sc, opts.loannex || {}),
  ]);

  /**
   * ⛔ ONE BOARD IS NARROWED AND THE OTHER IS NOT, AND THAT IS WHAT MAKES THEM AGREE.
   *
   * Fixed-or-ARM, interest-only and the loan term are SEARCH CRITERIA at Lender Price
   * (`criteria.loanType` + `loanTypeCriteria`, `criteria.interestOnly`, `termsCriteria`), so its
   * answer arrives already narrowed to the product asked for. LoanNEX accepts none of the three and
   * answers with everything it has, stating what each programme IS — which is why one board came
   * back with 27 programmes for a single investor and the officer's own interest-only and term
   * answers appeared to do nothing.
   *
   * `product-filter` narrows the LoanNEX board on the vendor's OWN published fields
   * (`amortizationType`, `isInterestOnly`, `termInMonths`) — never a word out of a product name,
   * which is the owner's own condition on this filter. It runs HERE, before the holdback, the merge,
   * the routing, the counts and the option shape, so every one of those describes the same board.
   */
  // ⛔ THE INTEREST-ONLY ANSWER COMES OFF THE REQUEST LENDER PRICE WAS ACTUALLY SENT when the
  // scenario is silent. The screen omits an OFF switch rather than sending `false` (see
  // `product-filter.wantFrom`), so without this the LoanNEX board was never narrowed on
  // interest-only while Lender Price's tenant default already had — one board answering an
  // amortising question and the other answering none (owner-reported 2026-09-02).
  //
  // WHICH REQUEST: the WIRE body `lp.price` hands back (`request`), never only the static build in
  // `chk.request`. The client builds the body it POSTs on the tenant's LIVE foundation, and
  // `mergeKnownRequestDefaults` copies same-typed scalars — `criteria.interestOnly` included —
  // from the live defaultSearch, so the two can disagree. The pre-merge audit (2026-09-02) found
  // the first cut mirroring the static one: a live default of `true` would have narrowed LoanNEX
  // to amortising while Lender Price was asked for interest-only. The static build is the
  // FALLBACK for a Lender Price failure, when there is no wire body to mirror.
  const wire = lpRes.status === 'fulfilled' && lpRes.value && lpRes.value.request && typeof lpRes.value.request === 'object'
    ? lpRes.value.request : null;
  const lpCriteria = (wire && wire.criteria && typeof wire.criteria === 'object') ? wire.criteria
    : (chk.request && chk.request.criteria);
  // ⛔ THE RATE LOCK COMES OFF THE BODY ROOT, not off `criteria` — `search-model` writes it to
  // `dayLocksCriteria` (and `brokerCriteria.dayLocks`) beside `criteria`, never inside it. Same
  // rule and same fallback as interest-only above: the WIRE body Lender Price actually received,
  // and the static build only when Lender Price failed and there is no wire body to mirror.
  const lpRequest = wire || (chk.request && typeof chk.request === 'object' ? chk.request : null);
  const want = productFilter.wantFrom(sc, lpModel._internals, { lpCriteria, lpRequest });
  const narrowed = nxRes.status === 'fulfilled'
    ? productFilter.narrowBoard(nxRes.value.board, want)
    : null;
  // The wire body was for the narrowing; it is not part of the answer.
  const lpBoard = lpRes.status === 'fulfilled' ? (({ request: _wire, ...rest }) => rest)(lpRes.value) : null;

  const boards = {
    lenderprice: lpBoard,
    // THE MARGIN HOLDBACK GOES ON HERE — before the merge, the comparison, the
    // quote shape or the compensation overlay sees a single number. Lender
    // Price's feed already carries it and LoanNEX's does not, so this is what
    // puts the two on the same footing; applying it any later would have the
    // comparison electing on one set of numbers and the board showing another.
    loannex: narrowed ? vendorMargin.applyToBoard(narrowed.board, 'loannex', { saved: heldSetting, extraFor }) : null,
  };
  const errors = {
    lenderprice: lpRes.status === 'rejected' ? reasonOf(lpRes.reason) : null,
    loannex: nxRes.status === 'rejected' ? reasonOf(nxRes.reason) : null,
  };
  // ONE SYSTEM unless an admin asks. Without `revealSource` the board carries no
  // hint of which vendor a row came from — the owner's own rule.
  // THE SAME SAVED COPY THE SETTINGS SCREEN SHOWS. An explicit `routes` in the
  // request still wins — that is how a caller prices a what-if without saving it
  // — but nothing else resolves its own: a board and a settings screen that read
  // different copies would eventually disagree about which investor comes from
  // where, and the board is the one somebody prices a loan on.
  const saved = opts.routes !== undefined ? { raw: opts.routes } : await settingsRaw();
  // The human's investor links, resolved the same way the routing is, so the
  // board and the settings screen can never disagree about who is who.
  const linked = opts.links !== undefined ? { raw: opts.links } : await linksRaw();
  /* ⛔ ONE READ OF THE SETTINGS, HANDED TO BOTH (audit F9). The merge and the routing each decide
     what a client may call an investor; giving them the same resolved map is what stops them
     answering differently. Read here rather than twice, so they cannot even read different rows. */
  const investorRowsForNames = routing.readSettings(saved.raw, custom).settings;
  const mergedRaw = merge(boards, { errors, links: linked.raw, custom, settings: investorRowsForNames });
  const merged = routing.applyRouting(mergedRaw, { routes: saved.raw, custom, revealSource: opts.revealSource === true });

  // The unified option list, on request. Built from the ROUTED board so a
  // suppressed or routed-away investor cannot reappear through a second door.
  let options;
  /**
   * THE SEARCH EVERY LOANNEX ROW WAS QUOTED FOR — declared ONCE, read by BOTH builders below.
   *
   * A LoanNEX rung carries no loan amount, FICO, LTV or purpose: those are the question we asked,
   * not part of the vendor's answer, so `quote-shape.loanNexTerms` restates them from here. It is
   * declared once because the two builders had already drifted on exactly this — the option
   * builder was handed them and the BOARD builder was not, so the Details panel showed
   * "Loan amount —" on every LoanNEX row while the same figure sat in the other builder's output.
   */
  const nxSearch = { loanAmount: sc.loan, fico: sc.fico, ltv: sc.ltv, loanPurpose: sc.purpose };

  if (opts.shape === 'options') {
    // The SAME resolved answer the programme narrowing used — never `sc.io` on its own, which is
    // absent when the switch is off and would leave this second pass un-narrowed too.
    const io = want.io;
    const rows = [];
    // The per-vendor split, for SHAPING ONLY. On a revealing call the routed
    // board already carries it; otherwise it is taken from a second routing pass
    // over the SAME merged board — `applyRouting` is a pure function of its
    // input, so this costs no vendor call and can never disagree with the board
    // above about which investors are on and where each is fetched from. It is
    // never returned: every row built below still has its `source` deleted
    // unless the caller asked for one.
    const shaping = new Map();
    if (opts.revealSource !== true) {
      for (const e of routing.applyRouting(mergedRaw, { routes: saved.raw, custom, revealSource: true }).investors) {
        shaping.set(e.key, e.bySource || EMPTY_SPLIT);
      }
    }
    for (const e of merged.investors) {
      // The investor's programs arrive as ONE list. Which vendor built each row
      // is still needed HERE — the two are shaped differently on the wire — so
      // the reveal-stripped copy is not what this reads. Either way the OUTPUT
      // carries no vendor unless the caller asked for one.
      //
      // ⛔ AND IT MUST NOT FALL BACK TO GROUPING THE STRIPPED LIST. That is what
      // it used to do, and `groupBySource` reads each row's own `source` — which
      // `stripSource` has already removed on the ordinary board — so every row
      // was dropped as unshapeable and `?shape=options` came back EMPTY unless
      // the caller also asked to see the source. The split comes from `shaping`
      // below instead, and `bySource` is still preferred when it is present so
      // a revealing caller does no extra work.
      const byS = e.bySource || (shaping.get(e.key) || EMPTY_SPLIT);
      for (const src of ['lenderprice', 'loannex']) {
        const progs = byS[src] || [];
        if (!progs.length) continue;
        // ⛔ `optionsFromLenderPrice` TAKES OPTIONS, NOT PROGRAMS — its parameter is literally
        // named `options` and it reads `o.priceBuild` / `o.adjustments` / `o.terms` off each one.
        // It was being handed the PROGRAM rows, which carry none of those, so `?shape=options`
        // answered with one hollow shell per Lender Price programme: every price build empty,
        // every adjustment list empty, and the count wrong (programmes, not quotes). Flattening
        // the programmes' own options is what it always wanted; they exist here because the parse
        // above now asks for them.
        const built = src === 'loannex'
          ? quoteShape.optionsFromLoanNex({ programs: progs }, nxSearch)
          : quoteShape.optionsFromLenderPrice(progs.flatMap((pg) => (pg && Array.isArray(pg.options)) ? pg.options : []));
        for (const o of built) {
          const row = { ...o, investorKey: e.key, whiteLabel: e.whiteLabel };
          if (opts.revealSource !== true) delete row.source;
          rows.push(row);
        }
      }
    }
    // Interest-only: an INPUT on Lender Price, a PRODUCT on LoanNEX. Narrowing
    // here is what makes the two boards answer the same question.
    const f = quoteShape.filterInterestOnly(rows, io);
    options = { count: f.options.length, filteredByInterestOnly: f.filtered, unclassifiedCount: f.unknown.length, rows: f.options };
  }

  // THE BOARD, IN THE GENERAL PRICING ENGINE'S OWN SHAPE. This is what makes the
  // Combined Pricing Engine's screen a COPY of the general one rather than a
  // second design: it reads `programs[].options[].priceBuild` exactly as that
  // screen already does, whichever vendor produced the row.
  const programs = quoteShape.programsForBoard(merged, {
    reveal: opts.revealSource === true,
    /**
     * THE SEARCH EVERY LOANNEX ROW CAME OUT OF, stamped onto each row's explain handle.
     *
     * LoanNEX scopes a quote to its search (see `quote-shape.explainHandle`), so without this
     * the browser has nothing to hand back and `/explain` mints a transaction the vendor has
     * never seen. Read off the SAME result the board was built from, so the id on a row and
     * the rows themselves can never describe two different searches.
     */
    transactionId: nxRes.status === 'fulfilled' ? (nxRes.value.transactionId || null) : null,
    portal: nxRes.status === 'fulfilled' ? (nxRes.value.portal || null) : null,
    ...nxSearch,
  });

  return {
    merged,
    /**
     * HOW TO ASK WHY EACH INVESTOR SAID NO — the handle, not the answer.
     *
     * ⛔ WITHOUT THIS THE "NOT ELIGIBLE" LIST ON THIS BOARD WAS DEAD, FOR BOTH RATE SHEETS.
     * `LtPricer.askDisqualified` reads `res.searchKey` and returns early when there is none, and
     * this response has never carried one at the top level (the search identities were returned
     * only inside `provenance`, which is reveal-gated and which no browser code reads). MEASURED
     * before the fix: `priceBoth(...).searchKey` is undefined with reveal on AND off, so the whole
     * section never loaded on the Combined Pricing Engine — it was not that LoanNEX was missing
     * from a working list, it was that nothing was ever asked.
     *
     * ⛔ AND IT DOES NOT NAME THE VENDOR (the same rule as `explainHandle`, audit F8 — a handle
     * that named its vendor sat on every ordinary-board row for no reader at all). The two slots
     * are named for the MECHANISM: one rate sheet computes its ineligible list asynchronously and
     * must be polled, the other answers a whole tree in one go. The PORTAL is deliberately absent:
     * the browser already sent it on the price request, so it hands its own copy back rather than
     * being told a hostname it did not need to learn.
     */
    ineligibility: {
      pollKey: lpRes.status === 'fulfilled' ? (lpRes.value.searchKey || null) : null,
      treeId: nxRes.status === 'fulfilled' ? (nxRes.value.transactionId || null) : null,
    },
    /**
     * WHAT THE BOARD WAS NARROWED TO, AND WHAT THAT COST — never a silent cap.
     *
     * `asked` is the product the search actually stood for; `dropped` is how many LoanNEX
     * programmes each dimension removed, and `unclassified` how many it could not judge and
     * therefore KEPT. A board that quietly went from 209 programmes to 41 with nothing on screen to
     * say why is the same silence as an empty price build.
     */
    productFilter: {
      asked: want,
      applied: !!(narrowed && narrowed.narrowed),
      dropped: narrowed ? narrowed.dropped : { amortization: 0, interestOnly: 0, term: 0, lock: 0 },
      // The lock removes RUNGS from programmes that stay, so it is reported as its own quantity
      // rather than folded into a programme count that would then not add up.
      droppedRungs: narrowed ? narrowed.droppedRungs : { lock: 0 },
      unclassified: narrowed ? narrowed.unclassified : 0,
      unclassifiedRungs: narrowed ? narrowed.unclassifiedRungs : 0,
    },
    // The general engine's own top-level keys, so the copied screen needs no
    // reshaping of its own. `investorRoster` / `investorsUnmapped` keep the
    // names those two carry there.
    programs,
    programCount: programs.length,
    investorRoster: merged.investors.map((e) => ({ key: e.key, investor: e.investor, whiteLabel: e.whiteLabel || null, programCount: e.programCount })),
    investorsUnmapped: merged.unmapped || [],
    // The side-by-side the owner asked for, computed from what the two boards
    // ACTUALLY returned rather than from the registry's idea of them: one row per
    // investor, what each program calls them, whether both quoted it (so "take it
    // from this one" is even a choice), and which joins are still a guess.
    investorPairing: investorLinks.pairing({
      lenderprice: namesOf(boards.lenderprice),
      loannex: namesOf(boards.loannex),
    }, linked.raw, custom),
    /**
     * THE HAND-ADDED INVESTORS THIS BOARD WAS PRICED AGAINST — said out loud.
     *
     * `problem` is the settings store refusing to answer at all, `problems` what
     * the tolerant read dropped. Either way the board is the registry's idea of
     * the roster, and a screen showing a shorter list has to be able to say so
     * rather than presenting it as the whole truth.
     */
    customInvestors: {
      count: custom.size,
      problems: customCtx.problems || [],
      problem: customCtx.problem || null,
    },
    // What is NOT on the board, and why — so a short board can always be
    // accounted for without asking anybody.
    hidden: merged.hidden || [],
    /**
     * ⛔ IS THIS THE WHOLE BOARD? Lifted to the top level beside `hidden` and `settings` because
     * that is where the screen reads it, and because a fact this important must not be one level
     * down inside `merged` where the only thing that ever looks is another module. Vendor-neutral
     * by construction — see `investor-routing.applyRouting`.
     */
    completeness: merged.completeness || null,
    settings: merged.settings || null,
    options,
    scenario: { requested: scenario || {}, priced: sc, countyEnrichment: chk.countyEnrichment || null },
    /**
     * "YOU ARE ALMOST AT A BETTER TIER" (owner-directed 2026-08-30).
     *
     * Computed on the BOARD from the scenario the vendors were actually asked
     * about, plus whatever grid cells the board itself already carries — a
     * Lender Price row publishes its itemization with the quote, so its own
     * bands are often here and the flag can name the investor's real tier
     * rather than the standing steps. A LoanNEX row explains on demand, so
     * `POST /explain` recomputes this with that sheet's own cell and the
     * screen's flag gets sharper the moment somebody opens the price build.
     *
     * Never throws and is never a gate: it is a nicety beside a board, and a
     * board must not be able to fail because a hint could not be worked out.
     */
    nearTier: nearTier.nearTier({
      value: sc.value, loan: sc.loan, ltvPct: sc.ltv != null ? (sc.ltv > 1 ? sc.ltv : sc.ltv * 100) : null,
      dscr: sc.dscr, lines: cellsOnBoard(mergedRaw),
    }),
    /**
     * How each half was ASKED — a merged number nobody can trace back to a
     * request is not a number anybody should price a loan on.
     *
     * ⛔ BUT ONLY FOR AN ADMIN WHO ASKED (audit F8, 2026-09-02). This block was returned
     * UNCONDITIONALLY, and it is keyed by vendor name with `loannex.portal` inside it — so the one
     * board whose rule is that it must not be tellable apart was handing over both the vendor's
     * name and its portal on every answer. `askedOf` already withholds the portal from the EXPLAIN
     * answer, and says why: *it names the investor's own portal*. The same fact cannot be a secret
     * two functions away and public here.
     *
     * Nothing is discarded — the flag decides what is SHOWN, exactly as it does for `source`, the
     * per-vendor split and the holdback trail. No browser code reads this block at all (checked:
     * no reference to `provenance` anywhere in `app-v2/src/longterm`), so withholding it costs no
     * screen anything today, and an admin who asks still gets the whole trail.
     */
    ...(opts.revealSource === true ? {
      provenance: {
        lenderprice: lpRes.status === 'fulfilled' ? { searchKey: lpRes.value.searchKey, provenance: lpRes.value.provenance } : null,
        loannex: nxRes.status === 'fulfilled'
          ? { portal: nxRes.value.portal, portalId: nxRes.value.portalId, transactionId: nxRes.value.transactionId, county: nxRes.value.county, registry: nxRes.value.registry }
          : null,
      },
    } : {}),
  };
}

/**
 * @param {{superAdminOnly?: boolean}} [opts]
 *   `superAdminOnly` defaults to TRUE — default-secure, so a mount added later
 *   is gated unless somebody deliberately opts out. The ONE caller that opts out
 *   is the diagnostics seam, which has no signed-in person at all and carries a
 *   shared secret instead (see routes/loannex-diag.js).
 */
function makeRouter(opts = {}) {
  const router = express.Router();
  const superAdminOnly = opts.superAdminOnly !== false;

  // THE KILL SWITCH, then THE ROLE. Both answer 404 rather than 403: an engine
  // the owner is auditing privately should not announce itself to the team.
  router.use((req, res, next) => (enabled() ? next() : res.status(404).json({ error: 'not_found', hint: 'the combined pricing engine is switched off (LT_COMBINED_PRICING=off)' })));
  router.use((req, res, next) => (!superAdminOnly || isSuperAdmin(req) ? next() : res.status(404).json({ error: 'not_found' })));

  /** Is each program configured? No login attempted. */
  router.get('/health', (req, res) => {
    const nx = nex.configured();
    res.json({
      ok: true, live: true, engine: 'combined', killSwitch: 'LT_COMBINED_PRICING=off',
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

  /**
   * THE COMBINED BOARD — Lender Price + LoanNEX, in the general engine's own
   * program shape, so the copied screen reads it unchanged.
   *
   * `?shape=options` additionally returns the flat one-option-per-quote list;
   * `?source=show` is the admin's "where did this row come from".
   */
  router.post('/price', (req, res) => {
    const b = req.body || {};
    priceBoth(scenarioOf(req), {
      loannex: { portal: b.portal },
      shape: b.shape || req.query.shape,
      routes: b.routes,   // an explicit map overrides the environment's
      /**
       * ⛔ THE WHAT-IF FIGURES TRAVEL TOO (audit F7). `priceBoth` resolves both of these with
       * "an explicit value in the request still wins so a caller can price a what-if without
       * saving it" — its own words — and this door forwarded neither, so that promise described
       * behaviour nothing could reach through HTTP.
       *
       * It was not a silent no-op, it was a DISAGREEMENT: the two sibling doors both honour
       * `marginHoldback` (`/loannex/price` reads it, and `/explain` reads it through
       * `holdbackOnRow`). So a what-if sent to all three resolved one number two ways — the BOARD
       * priced on the saved figure while the EXPLAIN itemised the what-if, which asks the vendor
       * about a price it never quoted and leaves the Details panel with an unexplained gap between
       * its running total and `adjustedPoints`. Those are exactly the two defects README item 10
       * records fixing.
       *
       * `undefined` is the "not asked" signal all the way down — `priceBoth` tests
       * `!== undefined` — so a body that omits them behaves exactly as it did.
       */
      marginHoldback: b.marginHoldback,
      links: b.links,
      // The admin's "show me where this came from". Off by default, so the board
      // reads as one system for everybody who does not ask.
      revealSource: b.revealSource === true || String(req.query.source || '') === 'show',
    })
      .then((r) => res.json({ ok: true, ...r }))
      .catch((e) => res.status(e.status || 400).json({ ok: false, error: e.code || 'lt_combined_price_error', field: e.field || null, message: reasonOf(e) }));
  });

  /**
   * LoanNEX alone.
   *
   * ⛔ ITS BOARD CARRIES OUR HOLDBACK, exactly as the combined board's does
   * (owner-directed 2026-08-30, shown that this door served the vendor's raw
   * prices under a note inviting a comparison with the other board:
   * *"Corrected prices with our holdback."*).
   *
   * THE REASON IS THE WHOLE REASON THE HOLDBACK EXISTS. Lender Price's feed
   * already carries our margin and LoanNEX's does not, so a LoanNEX board served
   * raw reads BETTER than a Lender Price board of the same loan for no reason
   * but which vendor it came from — the exact misleading comparison the holdback
   * is there to prevent, served from a door whose own comment used to invite it.
   * A price that leaves this process is a price somebody may quote, so there is
   * no door on which the two programs are not on the same footing.
   *
   * It is applied through the SAME `applyToBoard` and the SAME saved setting the
   * combined board reads — never a second copy of the number — so moving the
   * holdback in the settings moves it here in the same breath, and the board
   * stamps WHERE the figure came from so this can never be read as raw again.
   * `raw:true` still returns the vendor's own untouched response beside it: this
   * is a diagnostics seam, and seeing what LoanNEX actually said is the point of
   * it — what must not happen is our BOARD quietly being that.
   */
  router.post('/loannex/price', async (req, res) => {
    const b = req.body || {};
    try {
      // The same explicit-override rule the combined board follows, so a caller
      // can price a what-if at another holdback without saving one.
      const saved = b.marginHoldback !== undefined ? b.marginHoldback : await holdbackRaw();
      const r = await nex.price(scenarioOf(req), { portal: b.portal, raw: !!b.raw });
      res.json({ ok: true, ...r, board: vendorMargin.applyToBoard(r.board, 'loannex', { saved }) });
    } catch (e) {
      res.status(e.status || 400).json({ ok: false, error: e.code || 'loannex_price_error', field: e.field || null, message: reasonOf(e) });
    }
  });

  /**
   * WHY EVERY INVESTOR SAID NO — BOTH RATE SHEETS, ONE LIST. "It should sound like one system."
   *
   * ⛔ THE DEFECT THIS CLOSES, MEASURED: this board's "not eligible" section was DEAD, for both
   * rate sheets. `askDisqualified` needs a search identity and `priceBoth` returned none at the
   * top level, so it returned early every time and nothing was ever asked. Fixing only the LoanNEX
   * half would have added a vendor to a list that never loaded.
   *
   * ⛔ THE TWO ARE FETCHED DIFFERENTLY AND THAT DIFFERENCE IS REPORTED, NEVER HIDDEN. Lender Price
   * computes its ineligible list asynchronously and is POLLED (202 while it works); LoanNEX answers
   * a whole tree synchronously. So a caller can legitimately hold LoanNEX's refusals while Lender
   * Price is still thinking — `ready` is false only while NOTHING has arrived, and `pending` names
   * what is still coming so a half-filled list can never read as the whole answer.
   *
   * ⛔ AND ONE HALF FAILING NEVER TAKES THE OTHER DOWN. Each is settled independently and a refusal
   * is CARRIED (`failed[]`), because "the other rate sheet could not be reached" and "the other rate
   * sheet refused nobody" are different facts and a blank space is read as the second.
   */
  router.post('/combined/disqualify', async (req, res) => {
    const b = req.body || {};
    const reveal = b.revealSource === true;
    const pollKey = b.pollKey ? String(b.pollKey) : null;
    const treeId = b.treeId ? String(b.treeId) : null;
    if (!pollKey && !treeId) {
      return res.status(400).json({ ok: false, error: 'missing_handle',
        message: 'Send the ineligibility handle the price answer returned.' });
    }
    const pending = []; const failed = []; const lenders = [];
    // The half is named by its MECHANISM unless an admin asked to see the source — the same rule
    // the board and the explain handle already apply.
    const POLLED = reveal ? 'lenderprice' : 'polled';
    const TREE = reveal ? 'loannex' : 'tree';

    let polledReady = false;
    if (pollKey) {
      try {
        const pr = await lp.pollDisqualifiedByKey(pollKey);
        if (pr.unknown) {
          failed.push({ half: POLLED, reason: 'unknown_search_key',
            message: 'That search has expired — price the loan again to start a fresh ineligible list.' });
        } else if (!pr.ok) {
          failed.push({ half: POLLED, reason: pr.error || 'error', message: pr.message || null });
        } else if (!pr.ready) {
          pending.push(POLLED);
        } else {
          polledReady = true;
          const parsed = pr.parsed || lp.parseDisqualified(pr.raw);
          for (const l of lpPrograms.decorateDisqualifiedLenders((parsed && parsed.lenders) || [])) {
            lenders.push(reveal ? { ...l, source: 'lenderprice' } : l);
          }
        }
      } catch (e) {
        failed.push({ half: POLLED, reason: e.code || 'error', message: reasonOf(e) });
      }
    }

    let treeReady = false;
    if (treeId) {
      try {
        const r = await nex.fails(treeId, { portal: b.portal });
        treeReady = true;
        for (const l of lpPrograms.decorateDisqualifiedLenders(((r.disqualified || {}).lenders) || [])) {
          lenders.push(reveal ? { ...l, source: 'loannex' } : l);
        }
      } catch (e) {
        failed.push({ half: TREE, reason: e.code || 'error', message: reasonOf(e) });
      }
    }

    /**
     * ONE INVESTOR, ONE ENTRY. A refused investor can legitimately appear on BOTH sheets — the
     * board joins the two by `investorKey` and this list must join them the same way, or the screen
     * shows one company twice under one white label and reads as a bug. An investor the registry
     * cannot key is kept under its own name rather than dropped: an unkeyed refusal is still a
     * refusal, and dropping it would quietly shorten the list.
     */
    const byKey = new Map();
    for (const l of lenders) {
      const k = l.investorKey || ('name:' + String(l.lender || '').toLowerCase());
      const prev = byKey.get(k);
      if (!prev) byKey.set(k, { ...l, items: [...(l.items || [])] });
      else prev.items.push(...(l.items || []));
    }
    const mergedLenders = [...byKey.values()];

    res.json({
      ok: true,
      // Ready when ANYTHING arrived — a list that says "still computing" while holding real
      // refusals would hide the answer it already has.
      ready: polledReady || treeReady,
      pending,
      failed,
      disqualified: {
        lenders: mergedLenders,
        lenderCount: mergedLenders.length,
        itemCount: mergedLenders.reduce((n, l) => n + ((l.items || []).length), 0),
      },
      retryAfterMs: pending.length ? 2000 : null,
      message: pending.length
        ? 'One of the two rate sheets is still working out its ineligible list — ask again shortly.'
        : null,
    });
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
  /**
   * THE INVESTOR SETTINGS — every investor, one row.
   *
   * READ. The saved copy in force is resolved ONCE, here and in `priceBoth`,
   * through the same `settingsRaw()` — a screen and a board that resolved their
   * own would eventually disagree about which investor comes from where, and the
   * board is the one somebody prices a loan on.
   */
  /**
   * THE FOUR INVESTOR SETTINGS DOORS — margin holdback, the per-investor rows,
   * the links, and the investors added by hand.
   *
   * ⛔ THEY LIVE IN `investor-settings-routes.js` AND ARE MOUNTED, NOT COPIED.
   * The owner directed (2026-09-03) that the side-by-side list moves into the
   * GENERAL engine's settings, so both engines now offer these doors; two sets of
   * route bodies writing the same four settings is two chances for the validation
   * and the refusals to drift, and the copy that drifts is the one somebody
   * prices a loan on. See that file's header for the whole reasoning.
   */
  settingsRoutes.attach(router);


  /**
   * WHY IS THIS PRICE THIS PRICE — one door, one layout, either program.
   *
   * ⛔ THE DOOR ITSELF LIVES IN `routes/explain-door.js` AND THE GENERAL ENGINE MOUNTS THE
   * SAME ONE (owner-directed 2026-09-03: *"I told you to copy it from here and bring in how
   * it works"* — the itemised LLPA breakdown was built and tested here and existed nowhere
   * else). Two copies is how one engine comes to itemise a price differently from the other
   * on the same quote, and the copy that drifts is the one somebody quotes from.
   *
   * `reveal: 'ask'` is this engine's own authority: it is super-admin only, so an admin may
   * ASK to see which rate sheet a row came from. The general engine passes `false`.
   */
  explainDoor.attach(router, { reveal: 'ask' });

  /**
   * The OLD door, kept because something may already be pointed at it.
   *
   * It answers exactly what it always did — the vendor's parsed evidence — and
   * the new `/explain` above is the one the screen reads. Never remove a door
   * until nothing depends on it.
   */
  /**
   * WHAT WE ACTUALLY SEND THE RATE SHEET, AND WHAT IT SENDS BACK — for one row.
   *
   * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
   * Owner-reported: rows showing *"The rate sheet accepted the question and returned no
   * breakdown for this quote."* The recorded live capture holds that failure with the
   * request kept beside it, and the request is EMPTY — we had asked with no product, no
   * investor and no price hash, and the sheet answered about no quote. The screen then
   * blamed the sheet.
   *
   * A quote that cannot identify itself is refused before the call now, so the two cases
   * carry different words. This door is how the remaining case is settled WITHOUT a
   * credential leaving the environment it belongs in: it runs where the password already
   * lives, reports the identity of the question we would send, and — when asked to — makes
   * the real call and reports whether a breakdown came back.
   *
   * ⛔ IT NEVER RETURNS A CREDENTIAL, and it never returns the vendor's raw answer. It
   * reports the SHAPE of what was sent (which identity fields were present) and whether an
   * answer arrived, which is the whole of the question being asked and none of the secret.
   * Super-admin only, like every door on this router.
   */
  router.post('/loannex/diagnose', (req, res) => {
    const b = req.body || {};
    const quote = b.quote || {};
    const identity = nex._internals && nex._internals.missingIdentity
      ? nex._internals.missingIdentity(quote) : null;
    const present = (k) => quote[k] !== undefined && quote[k] !== null && quote[k] !== '';
    const shape = {
      priceHashKey: present('priceHashKey'),
      productId: present('productId'),
      lenderId: present('lenderId'),
      rate: present('rate'),
      lockDays: present('lockDays'),
      transactionId: present('transactionId'),
    };
    const answer = {
      ok: true,
      configured: nex.configured(),
      // The question we would ask, by shape only — never the values of anything secret.
      wouldSend: shape,
      missing: identity,
      wouldBeRefused: Array.isArray(identity) && identity.length > 0,
      verdict: Array.isArray(identity) && identity.length
        ? `This row could not identify itself: ${identity.join(', ')} missing. The rate sheet would not be asked — this one is ours.`
        : 'This row carries everything the rate sheet needs to find the quote.',
    };
    if (b.live !== true) return res.json(answer);

    // LIVE: make the real call and report only whether a breakdown came back.
    let sc;
    try { sc = explainScenario(req); }
    catch (e) { return scenarioRefused(res, e); }
    return nex.evidence(sc, quote, searchIdentity(quote, b))
      .then((r) => res.json({
        ...answer,
        live: {
          asked: true,
          gotBreakdown: !!r.evidence,
          adjustments: r.evidence && Array.isArray(r.evidence.adjustments) ? r.evidence.adjustments.length : 0,
          basePrice: r.evidence ? r.evidence.basePrice : null,
          absence: r.absence || null,
          transactionId: r.transactionId || null,
        },
      }))
      .catch((e) => res.status(isNotConfigured(e) ? 503 : 502)
        .json({ ...answer, live: { asked: false, error: e.code || 'loannex_evidence_error', message: reasonOf(e) } }));
  });

  router.post('/loannex/explain', (req, res) => {
    const b = req.body || {};
    const quote = quoteFromBody(b);
    if (!quote || !quote.priceHashKey) {
      return res.status(400).json({ ok: false, error: 'missing_quote', message: 'Send the quote to explain, including its priceHashKey (the `explain` block on any LoanNEX option row).' });
    }
    let sc;
    try { sc = explainScenario(req); }
    catch (e) { return scenarioRefused(res, e); }
    nex.evidence(sc, quote, searchIdentity(quote, b))
      .then((r) => res.json({ ok: true, ...r }))
      .catch((e) => res.status(isNotConfigured(e) ? 503 : 502)
        .json({ ok: false, error: e.code || 'loannex_evidence_error', message: reasonOf(e) }));
  });

  return router;
}

module.exports = { makeRouter, _internals: { enabled, isSuperAdmin, priceBoth, scenarioOf, explainScenario, scenarioRefused, askedOf, reasonOf, vendorQuote, quoteFromBody, searchIdentity, routing, quoteShape, breakdown, customRaw } };
