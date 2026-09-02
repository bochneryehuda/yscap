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
const investorLinks = require('../pricing/investor-links');
// The canonical investor roster and the client-safe names, both read-only here —
// the pick-list a person chooses from is DERIVED from the one registry, never a
// second list this route keeps for itself.
const investors = require('../encompass/investors');
const { whiteLabelOf } = require('../lenderprice/investor-programs');
const quoteShape = require('../pricing/quote-shape');
const productFilter = require('../pricing/product-filter');
const breakdown = require('../pricing/breakdown');
const nearTier = require('../pricing/near-tier');
const vendorMargin = require('../pricing/vendor-margin');
const settingsStore = require('../settings/store');

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
async function settingsRaw() {
  try {
    const stored = await settingsStore.get('pricing.combinedInvestors', 'company');
    return routing.resolveRaw({ stored });
  } catch (e) {
    return { ...routing.resolveRaw({ stored: null }), problem: reasonOf(e) };
  }
}

/**
 * THE SAVED MARGIN HOLDBACK, or nothing if nobody has set one.
 *
 * NEVER THROWS, and — unlike every other reader here — a failure must not fall
 * toward doing nothing. `resolveHoldback` treats an absent value as "use the
 * owner's standing 0.25", so returning `undefined` on an unreadable store keeps
 * the holdback ON. A settings outage that quietly stopped holding it back would
 * hand every borrower 0.25 of better execution nobody decided to give them.
 */
async function holdbackRaw() {
  try {
    return await settingsStore.get('pricing.combinedMarginHoldback', 'company');
  } catch (_) {
    return undefined;
  }
}

/**
 * ONE EXPLAINED OPTION WITH OUR OWN MARGIN'S TRAIL REMOVED — never its price.
 *
 * The same rule `investor-routing.stripSource` applies to a board row, applied here because this
 * door builds an option the board never carried. `vendorBasePoints` is the pre-holdback base: left
 * on, a reader could subtract it from the base beside it and read our margin straight off the panel.
 */
function stripExplainedTrail(option) {
  if (!option || !option.priceBuild) return option;
  const { vendorPrice, vendorBasePoints, vendorAdjustedPoints, ...pb } = option.priceBuild;
  return { ...option, priceBuild: pb };
}

/**
 * WHICH SEARCH THIS QUOTE BELONGS TO — the ROW's own answer first, the request body second.
 *
 * The row is stamped by `priceBoth` from the very result its rungs were read out of, so it can
 * never name a different search than the one that priced it. The body remains a fallback ONLY for
 * a caller that predates the stamp; when neither says, the client mints one and the vendor is
 * being asked about a search it has never seen — which is exactly the silence this exists to end.
 *
 * Returns `{}` rather than `{ transactionId: undefined }` so the client's own
 * `opts.transactionId || newTransactionId()` fallback is reached the same way it always was.
 */
function searchIdentity(quote, body) {
  const q = quote || {};
  const b = body || {};
  const out = {};
  const txn = q.transactionId != null ? q.transactionId : b.transactionId;
  const portal = q.portal != null ? q.portal : b.portal;
  if (txn != null && txn !== '') out.transactionId = txn;
  if (portal != null && portal !== '') out.portal = portal;
  return out;
}

/**
 * THE QUOTE AS THE RATE SHEET ITSELF WROTE IT — our margin added back on, for the QUESTION only.
 *
 * A LoanNEX rung reaches the browser with the holdback already in its price (`applyToBoard` runs
 * before the merge), so the price on the explain handle is OURS rather than the vendor's. This puts
 * the vendor's own figure back for the one call that is addressed to them, and touches nothing else
 * on the quote — `priceHashKey`, rate, lock, product and investor ride through untouched, and the
 * option the panel draws is still built from the ORIGINAL held-back quote.
 *
 * A holdback of zero, an unreadable one, or a quote with no price returns the quote itself, so a
 * Lender Price row and an ordinary board are byte-identical to what they were.
 */
function vendorQuote(quote, points) {
  const pts = Number(points);
  if (!quote || !Number.isFinite(pts) || pts === 0) return quote;
  const price = Number(quote.price);
  if (!Number.isFinite(price)) return quote;
  return { ...quote, price: Math.round((price + pts) * 1000) / 1000 };
}

/**
 * HOW MUCH WE HELD BACK ON ONE ROW — resolved from the SAVED SETTINGS, never from the caller.
 *
 * ⛔ WHY THE EXPLAIN DOOR NEEDS THIS AT ALL. LoanNEX explains a price with ITS OWN base and ITS OWN
 * adjustments, and the row on the board is quoting a price we have already taken our margin out of.
 * Handed to the panel untouched, the running total it draws would land exactly the holdback away
 * from the final price printed under it — an unexplained gap on the one screen whose job is to
 * explain the price, about a figure the owner has directed must stay invisible.
 *
 * ⛔ AND WHY THE INVESTOR KEY IS ONLY A POINTER. The caller names WHICH investor's saved setting to
 * read; it can never state an amount. The number itself comes from `settingsRaw()` and
 * `holdbackRaw()` — the same two reads `priceBoth` makes, through the same `resolveHoldback` — so
 * the panel and the board can never disagree about what was taken. A key nobody has saved a setting
 * for resolves to the board-wide answer, and an unresolvable one to nothing at all, which leaves the
 * panel exactly as it is today rather than shifting a base by a number nobody chose.
 */
async function holdbackOnRow(investorKey, b = {}) {
  const savedGlobal = b.marginHoldback !== undefined ? b.marginHoldback : await holdbackRaw();
  let extra = null;
  const key = investorKey == null ? '' : String(investorKey).trim();
  if (key) {
    const saved = b.routes !== undefined ? { raw: b.routes } : await settingsRaw();
    const row = routing.settingFor(key, routing.readSettings(saved.raw).settings);
    if (row && row.holdbackOrigin === 'setting') extra = row.holdback;
  }
  return vendorMargin.resolveHoldback('loannex', savedGlobal, extra);
}

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
async function linksRaw() {
  try {
    const stored = await settingsStore.get(investorLinks.SETTING_KEY, 'company');
    return { raw: stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}, problem: null };
  } catch (e) {
    return { raw: {}, problem: reasonOf(e) };
  }
}

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

function scenarioOf(req) {
  const b = req.body || {};
  return b && typeof b === 'object' && b.scenario && typeof b.scenario === 'object' ? b.scenario : b;
}

/**
 * THE SCENARIO AN EXPLAIN CALL IS MADE ABOUT — the SAME enriched loan the board was priced on.
 *
 * ⛔ THE DEFECT THIS CLOSES (owner-reported 2026-09-02, *"Very important: I still don't see the
 * detailed LLPA and adjustments populate"*). `priceBoth` runs every scenario through
 * `validateScenario` BEFORE either vendor is asked: the browser sends a ZIP and nothing else about
 * the location, and that step turns it into state + county (+ FIPS), canonicalises the buttons and
 * clamps a ratio above the vendor's ceiling. The explain doors handed the RAW browser scenario
 * straight to the LoanNEX body builder, so the vendor was asked to itemise a quote for a loan with
 * NO STATE — `nexApp.state: null` against the board's `"NJ"`, measured field by field — and the
 * eligibility screen it re-runs behind `/evidences` had nothing to screen. The live recording of
 * 30 Aug supplied the state by hand and three of four investors itemised; the board never does.
 *
 * `validateScenario` is pure, offline and deterministic, so running it here on the same input the
 * price call ran it on yields the same enriched scenario — the explain call now describes the
 * loan the quote was priced on, to the field. A scenario it refuses is refused HERE with the same
 * 422 the price door gives, never sent to the vendor as a different loan.
 */
function explainScenario(req) {
  const chk = validateScenario(scenarioOf(req) || {});
  if (!chk.ok) {
    const err = new Error(chk.message || 'invalid scenario');
    err.code = chk.error; err.field = chk.field; err.status = chk.status || 422;
    throw err;
  }
  return chk.scenario;
}

/**
 * A REFUSED scenario is a 422 naming the field, exactly as the price door answers it. An error
 * with no status is not a refusal — `validateScenario` itself threw — and answering 422 for it
 * would tell the caller their scenario is wrong when the server is. That is a 500 that says so.
 */
function scenarioRefused(res, e) {
  if (e && e.status) {
    return res.status(e.status).json({ ok: false, error: e.code || 'invalid_scenario', field: e.field || null, message: reasonOf(e) });
  }
  return res.status(500).json({ ok: false, error: 'scenario_check_failed', message: reasonOf(e) });
}

/**
 * WHAT WAS ASKED, stated on the answer so an empty panel can say what it asked about.
 *
 * Carries the figures a person can check against the board — never a vendor name. TWO figures
 * ride only when the caller asked to see where rows come from: the PORTAL (it names the
 * investor's own portal) and the PRICE. The vendor is asked about ITS price, which is the
 * held-back price plus the holdback, and stating it beside a row that shows the held-back price
 * would let a reader subtract the two — the same reason `stripExplainedTrail` withholds
 * `priceBuild.vendor*` (pre-merge audit 2026-09-02). The rate, the lock, the place and the search
 * identify the question on their own.
 */
function askedOf(sc, vendorQ, ident, opts = {}) {
  const s = sc || {}; const q = vendorQ || {}; const id = ident || {};
  const out = {
    rate: q.rate == null ? null : Number(q.rate),
    lockDays: q.lockDays == null ? null : Number(q.lockDays),
    transactionId: id.transactionId || null,
    state: s.state || null,
    county: s.countyName || s.county || null,
    zip: s.zip || null,
    dscr: s.dscr == null ? null : Number(s.dscr),
    loan: s.loan == null ? null : Number(s.loan),
    value: s.value == null ? null : Number(s.value),
  };
  if (opts.reveal) {
    out.price = q.price == null ? null : Number(q.price);
    out.portal = id.portal || null;
  }
  return out;
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
  const savedForHoldback = opts.routes !== undefined ? { raw: opts.routes } : await settingsRaw();
  const linksForHoldback = opts.links !== undefined ? { raw: opts.links } : await linksRaw();
  const investorRows = routing.readSettings(savedForHoldback.raw).settings;
  const linkMapForHoldback = investorLinks.readLinks(linksForHoldback.raw).links;
  const extraFor = (prog) => {
    const hit = mergeMod.resolveInvestor(prog, linkMapForHoldback);
    if (!hit || !hit.key) return null;
    const row = routing.settingFor(hit.key, investorRows);
    return row && row.holdbackOrigin === 'setting' ? row.holdback : null;
  };

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
      const deco = lpPrograms.decorate(parsed.programs) || {};
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
  const mergedRaw = merge(boards, { errors, links: linked.raw });
  const merged = routing.applyRouting(mergedRaw, { routes: saved.raw, revealSource: opts.revealSource === true });

  // The unified option list, on request. Built from the ROUTED board so a
  // suppressed or routed-away investor cannot reappear through a second door.
  let options;
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
      for (const e of routing.applyRouting(mergedRaw, { routes: saved.raw, revealSource: true }).investors) {
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
          ? quoteShape.optionsFromLoanNex({ programs: progs }, { loanAmount: sc.loan, fico: sc.fico, ltv: sc.ltv, loanPurpose: sc.purpose })
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
  });

  return {
    merged,
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
    }, linked.raw),
    // What is NOT on the board, and why — so a short board can always be
    // accounted for without asking anybody.
    hidden: merged.hidden || [],
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
   * THE MARGIN HOLDBACK — read it, and change it.
   *
   * Owner-directed 2026-08-30: *"there should always be in the settings the
   * possibility to move up the margin hold back, remove the margin hold back, or
   * move it down."*
   *
   * The answer always says WHERE the number came from and what the pre-fill is,
   * so a screen can offer the way back to 0.25 rather than leaving somebody to
   * remember it — the same rule the investor rows follow.
   */
  router.get('/margin-holdback', async (req, res) => {
    const saved = await holdbackRaw();
    const r = vendorMargin.resolveHoldback('loannex', saved);
    res.json({
      ok: true,
      points: r.points,
      origin: r.origin,
      problem: r.problem,
      prefill: vendorMargin.holdbackFor('loannex'),
      max: vendorMargin.MAX_HOLDBACK_POINTS,
      // Stated rather than left to be inferred: the OTHER program is not
      // configurable here, and the reason is a fact about its feed.
      note: 'Held back on every LoanNEX quote before the two programs are compared. Lender Price is not '
        + 'listed because its feed already carries our holdback — taking it again there would double it.',
    });
  });

  /**
   * WRITE. `points: null` returns it to the standing 0.25; `points: 0` removes
   * it deliberately.
   *
   * ⛔ A REFUSED VALUE IS REFUSED, NOT STORED. `resolveHoldback` is deliberately
   * forgiving at READ time (a bad stored value keeps the 0.25 rather than taking
   * the engine down), and that forgiveness must not become a way to save
   * nonsense: if the door accepted it, the board would go on quoting 0.25 while
   * the screen showed whatever was typed, and the two would disagree forever.
   * So the door runs the SAME resolver and refuses anything it reports a problem
   * with, naming the problem.
   */
  router.put('/margin-holdback', async (req, res) => {
    const b = req.body || {};
    const raw = b.points === undefined ? b : b.points;
    if (raw === null || raw === '') {
      try {
        await settingsStore.save({ 'pricing.combinedMarginHoldback': null }, { scope: 'company', staffId: (req.actor && req.actor.id) || null });
      } catch (e) {
        return res.status(500).json({ ok: false, error: 'save_failed', message: reasonOf(e) });
      }
      const r = vendorMargin.resolveHoldback('loannex', undefined);
      return res.json({ ok: true, points: r.points, origin: r.origin, problem: null, prefill: vendorMargin.holdbackFor('loannex'), max: vendorMargin.MAX_HOLDBACK_POINTS });
    }
    const check = vendorMargin.resolveHoldback('loannex', raw);
    if (check.problem) {
      return res.status(422).json({ ok: false, error: check.problem.error, message: check.problem.message });
    }
    try {
      await settingsStore.save({ 'pricing.combinedMarginHoldback': check.points }, { scope: 'company', staffId: (req.actor && req.actor.id) || null });
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'save_failed', message: reasonOf(e) });
    }
    res.json({ ok: true, points: check.points, origin: check.origin, problem: null, prefill: vendorMargin.holdbackFor('loannex'), max: vendorMargin.MAX_HOLDBACK_POINTS });
  });

  router.get('/investors', async (req, res) => {
    const src = await settingsRaw();
    const d = routing.describeSettings(src.raw, { origin: src.origin });
    res.json({
      ok: true, ...d,
      // The ones with no client-safe name yet, named out loud so somebody can
      // go and name them — an investor with no white label may never be put in
      // front of a borrower or a broker.
      needsWhiteLabel: d.investors.filter((r) => r.whiteLabelMissing).map((r) => ({ key: r.key, investor: r.label })),
      storedProblem: src.problem || null,
    });
  });

  /**
   * WRITE. Super-admin only — which the whole router already is, so there is no
   * second gate here and no chance of the two drifting apart.
   *
   * ⛔ THE WHOLE MAP IS REPLACED, deliberately, and the screen always sends every
   * row it is showing. A per-key patch would make "this investor has no setting"
   * and "this investor's setting was not in the request" indistinguishable, so
   * there would be no way to take a setting back OFF and return an investor to
   * its pre-fill — which is the one thing somebody auditing this will want to do
   * most often.
   *
   * Every row is validated by the SAME `readSettings` the board reads with, and
   * a rejected row is reported BY NAME rather than dropped: a typo that silently
   * hides a lender is exactly what that validation exists to prevent. A save that
   * carries any problem is REFUSED WHOLE — a half-applied settings form leaves
   * somebody unable to tell what took effect.
   */
  router.put('/investors', async (req, res) => {
    const body = (req.body && typeof req.body === 'object' && req.body.investors) || req.body || {};
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ ok: false, error: 'not_an_object', message: 'Send an object of investorKey -> {source, enabled, whiteLabel, holdback}.' });
    }
    const check = routing.readSettings(body);
    if (check.problems.length) {
      return res.status(422).json({ ok: false, error: 'invalid_settings', problems: check.problems });
    }
    try {
      await settingsStore.save({ 'pricing.combinedInvestors': check.settings }, {
        scope: 'company', staffId: (req.actor && req.actor.id) || null,
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'save_failed', message: reasonOf(e) });
    }
    const src = await settingsRaw();
    const d = routing.describeSettings(src.raw, { origin: src.origin });
    res.json({ ok: true, saved: Object.keys(check.settings).length, ...d,
      needsWhiteLabel: d.investors.filter((r) => r.whiteLabelMissing).map((r) => ({ key: r.key, investor: r.label })) });
  });

  /**
   * THE INVESTOR LINKS — "this one and this one are the same investor".
   *
   * Owner-directed 2026-08-30. GET returns the map a person has recorded plus
   * every investor the registry knows, so the screen can offer a list to pick
   * from rather than asking somebody to type a key.
   *
   * It deliberately does NOT price anything. The side-by-side of what each
   * program actually called an investor comes back on the PRICE answer
   * (`investorPairing`), because that is the only place the real names exist —
   * asking this door for them would mean pricing two vendors to draw a settings
   * screen.
   */
  router.get('/investor-links', async (req, res) => {
    const cur = await linksRaw();
    res.json({
      ok: true,
      links: cur.raw,
      linkCount: Object.keys(cur.raw || {}).length,
      problem: cur.problem || null,
      // The pick-list. Sorted by how often the registry has actually seen each
      // investor, so the common ones are at the top of a list of 42.
      investors: investors.list().map((i) => ({
        key: i.key, label: i.label, whiteLabel: whiteLabelOf(i.key) || null,
      })),
    });
  });

  /**
   * RECORD THE LINKS. The WHOLE map is sent, exactly like the investor settings
   * beside it — a partial write cannot express a REMOVED link, and a link
   * somebody meant to delete quietly surviving is the worst outcome here.
   *
   * REFUSES RATHER THAN REPAIRS (422 with every problem named): a link that
   * points at an investor this system does not know cannot be honoured, and
   * storing it anyway would look to the person like it had worked.
   */
  router.put('/investor-links', async (req, res) => {
    const check = investorLinks.validateLinks((req.body || {}).links);
    if (!check.ok) return res.status(422).json({ ok: false, error: 'bad_links', problems: check.problems });
    try {
      await settingsStore.save({ [investorLinks.SETTING_KEY]: check.links }, {
        scope: 'company', staffId: (req.actor && req.actor.id) || null,
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'save_failed', message: reasonOf(e) });
    }
    const cur = await linksRaw();
    res.json({ ok: true, saved: Object.keys(check.links).length, links: cur.raw });
  });

  /**
   * WHAT MIGHT THIS NAME BE? A proposal, never applied.
   *
   * The screen asks this for a spelling nobody has linked, and a person clicks
   * one. Nothing here writes: an automatic join would put one investor's pricing
   * under another investor's name, and that name is the one thing a client may
   * see.
   */
  router.get('/investor-links/suggest', (req, res) => {
    const name = String((req.query && req.query.name) || '').trim();
    if (!name) return res.status(400).json({ ok: false, error: 'missing_name', message: 'Send the spelling you want suggestions for.' });
    res.json({ ok: true, name, suggestions: investorLinks.suggestFor(name) });
  });

  /**
   * WHY IS THIS PRICE THIS PRICE — one door, one layout, either program.
   *
   * THE ONE REAL ASYMMETRY BETWEEN THE TWO PROGRAMS, and it is answered here
   * rather than by the screen: Lender Price ships the itemization WITH the
   * search, so a Lender Price row is already explained and asking again would be
   * a call that buys nothing. LoanNEX ships the ladder and explains a row only
   * when asked — one call per quote, which is how its own screen works too.
   *
   * So a row carrying a LoanNEX explain handle is fetched, and one that does not
   * is told plainly that its breakdown already arrived with the board. Both
   * answers come back through the SAME `breakdown` builder, so the reader is
   * handed one shape and never learns which program answered.
   */
  router.post('/explain', (req, res) => {
    const b = req.body || {};
    const quote = b.quote || b;
    const reveal = b.revealSource === true;
    if (!quote || typeof quote !== 'object') {
      return res.status(400).json({ ok: false, error: 'missing_quote', message: 'Send the quote to explain — the `explain` block from the option row.' });
    }
    // A row with no explain handle is not an error and must not read as one: its
    // rate sheet published the itemization up front, so the breakdown the screen
    // already holds IS the answer. Refusing here would send somebody hunting for
    // a call that was never needed.
    if (!quote.priceHashKey) {
      return res.json({
        ok: true,
        breakdown: null,
        alreadyExplained: true,
        message: 'This rate sheet publishes its itemized adjustments with the quote, so there is nothing further to fetch — the breakdown on this row is complete.',
      });
    }
    /**
     * \u26d4 THE VENDOR IS ASKED ABOUT ITS OWN PRICE, NOT OURS \u2014 which is why the holdback is
     * resolved BEFORE the question rather than beside it.
     *
     * `vendor-margin.applyToBoard` runs on the LoanNEX board before the merge, so by the time
     * `programsFromLoanNex` writes a rung's explain handle the `price` on it is ALREADY the
     * held-back one. Sending that straight through asked the rate sheet to itemise a price it has
     * never quoted \u2014 a question about a number that does not exist on its sheet \u2014 and the row's
     * `priceHashKey` is what actually identifies the quote, so the price rides as an assertion
     * beside it. `holdbackOnRow` is the SAME resolver the board used, so what is added back here is
     * exactly what was taken there.
     *
     * \u26d4 ONLY THE QUESTION IS RESTATED. The option the panel draws keeps the held-back price,
     * because that is the price on the board and the price somebody quotes; `holdBackExplainedBase`
     * then moves the vendor's own base by the same amount so the running total still lands on it.
     */
    // The SAME enriched loan the board was priced on — see `explainScenario`. A refused scenario
    // is a 422 naming the field, exactly as the price door answers it.
    let sc;
    try { sc = explainScenario(req); }
    catch (e) { return scenarioRefused(res, e); }
    const ident = searchIdentity(quote, b);
    holdbackOnRow(b.investorKey, b)
      // Never lets the answer fail: an unreadable settings store costs the base shift, not the
      // breakdown the caller asked for.
      .catch(() => ({ points: 0 }))
      .then((hb) => {
        const vq = vendorQuote(quote, (hb && hb.points) || 0);
        return nex.evidence(sc, vq, ident).then((r) => [r, hb, vq]);
      })
      .then(([r, hb, vq]) => {
        // THE SAME LAYOUT, WHATEVER PRICED IT. The vendor's answer is folded onto
        // an option in the common shape and handed to the ONE breakdown builder,
        // so this door and a Lender Price row produce the same rows, in the same
        // order, with the same keys.
        const explained = vendorMargin.holdBackExplainedBase(quoteShape.attachEvidence(
          quoteShape.optionForExplain(quote, b.option), r.evidence, { absence: r.absence },
        ), (hb && hb.points) || 0);
        /**
         * WHAT WAS ASKED RIDES ON THE OPTION'S OWN EVIDENCE BLOCK, so the panel that prints "the
         * rate sheet returned no breakdown" can print, beside it, exactly which loan and which
         * quote it asked about — the one line that turns an empty panel into a diagnosis.
         */
        const asked = askedOf(sc, vq, ident, { reveal });
        const option = { ...explained, evidence: { ...(explained.evidence || {}), asked } };
        const built = breakdown.breakdown(option, { reveal });
        res.json({
          ok: true,
          breakdown: built,
          asked,
          vendor: { answered: !!r.evidence, reason: r.absence ? r.absence.reason : null, message: r.absence ? r.absence.message : null },
          /**
           * ⛔ THE OPTION ITSELF, so the screen never re-keys a breakdown into an option shape.
           *
           * The panel reads an OPTION (`o.adjustments[].reason`, `o.priceBuild`, `o.terms`); the
           * breakdown is a different, flatter shape (`lines[].label`). A browser-side translation
           * between them would be a second copy of a mapping this route already holds in its hand
           * — and the copy that drifts is the one drawing the price somebody quotes. The reveal is
           * respected: the vendor's own trail is stripped unless an admin asked where the row came
           * from.
           */
          option: reveal ? option : stripExplainedTrail(option),
          // THE SHARPER FLAG. This sheet has now stated its own bands, so the
          // hint can name the investor's real tier instead of the standing
          // steps — same module, same wording, better evidence.
          nearTier: nearTier.nearTier({
            value: b.value != null ? b.value : (b.scenario || {}).value,
            loan: b.loan != null ? b.loan : (b.scenario || {}).loan,
            dscr: b.dscr != null ? b.dscr : (b.scenario || {}).dscr,
            lines: (built && built.lines) || [],
          }),
          transactionId: r.transactionId || null,
        });
      })
      .catch((e) => res.status(isNotConfigured(e) ? 503 : 502)
        .json({ ok: false, error: e.code || 'loannex_evidence_error', message: reasonOf(e) }));
  });

  /**
   * The OLD door, kept because something may already be pointed at it.
   *
   * It answers exactly what it always did — the vendor's parsed evidence — and
   * the new `/explain` above is the one the screen reads. Never remove a door
   * until nothing depends on it.
   */
  router.post('/loannex/explain', (req, res) => {
    const b = req.body || {};
    const quote = b.quote || b;
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

module.exports = { makeRouter, _internals: { enabled, isSuperAdmin, priceBoth, scenarioOf, explainScenario, scenarioRefused, askedOf, reasonOf, vendorQuote, searchIdentity, routing, quoteShape, breakdown } };
