'use strict';
/**
 * THE GENERAL PRICING ENGINE'S BOARD, BUILT FROM BOTH RATE SHEETS.
 *
 * ── THE OWNER'S ASK (2026-09-03) ───────────────────────────────────────────
 * *"Leave the general pricing way it is. Just bring in the LoanNEX integration and
 * bring in these five investors as an add-on… the search should run right away in
 * both places and return which investors we want to see from each place… we're
 * just adding a new source for these investors and turning off three investors
 * from Lender Price."*
 *
 * ── WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT ──────────────────────────
 * It is a ROUTER, not a comparison. For each investor the settings name ONE rate
 * sheet, and this takes that investor's programmes from that sheet and no other.
 *
 * ⛔ IT ELECTS NOTHING. The Combined Pricing Engine compares the two sheets and
 * picks a winner per investor; that machinery is what the owner rejected for this
 * screen (*"you have way too much things that are coming up massive before even
 * the results"*). `merge` still runs underneath — it is how two sheets' spellings
 * of one investor become one investor — and `applyRouting` then reads the SOURCE
 * SETTING, never the election. Nothing about which sheet "won" reaches this board.
 *
 * ⛔ NO ARM ON THIS SCREEN. Owner-directed: *"In the general engine, don't enable
 * the ARM feature. Leave it off for now, even if it's available in the combined."*
 * That is not a formality here — MEASURED on the recorded boards, 49 of LoanNEX's
 * 90 programmes are ARM, while the live Lender Price answer this screen has always
 * shown carries four product names and NONE of them is an ARM. Letting LoanNEX's
 * ARMs through would put ~49 programmes on a board that has never had one, which is
 * the opposite of "leave the general pricing the way it is".
 *
 * ⛔ NOTHING HERE CHANGES THE LENDER PRICE HALF. The parsed answer is passed
 * through untouched except for its `programs` list, so the brackets, the board, the
 * details panel and every count downstream read exactly what they read before.
 *
 * PURE OF ROUTES: no Express, no database. The vendors arrive as injected clients
 * so this can be run in a test with both stubbed.
 */

const merge = require('./merge');
const settingsOf = require('./investor-settings');
const routing = require('./investor-routing');
const quoteShape = require('./quote-shape');
const vendorMargin = require('./vendor-margin');
const productFilter = require('./product-filter');
const investorConfig = require('./investor-config');
const investorLinks = require('./investor-links');
/* ⛔ THE SEARCH MODEL IS REQUIRED, NEVER READ OFF THE INJECTED CLIENT. `wantFrom` mirrors the
   Lender Price request through `mapAmortization` and `resolveSearchTerms`, which live on the
   search MODEL. Reading them off `deps.lp` would silently answer `{}` for every caller that
   injects a stub — including every test — so the narrowing would quietly do nothing in exactly
   the place it is supposed to be proven. Same module, same functions, as the combined engine. */
const lpModel = require('../lenderprice/search-model');

/** The reason a vendor call did not produce a board, in one short phrase. */
function reasonOf(e) {
  if (!e) return 'the rate sheet did not answer';
  return String((e && e.message) || e).slice(0, 200);
}

/**
 * WHICH INVESTORS THIS SEARCH EXPECTED FROM LOANNEX. Read from the settings, not
 * from the answer — the whole point is to notice when one of them is missing.
 */
function expectedFromLoanNex(rows) {
  const out = [];
  for (const r of rows || []) {
    if (r && r.enabled && r.source === 'loannex') out.push(r.key);
  }
  return out;
}

/**
 * THE PRESENT-INVESTOR ROSTER AND THE STILL-UNNAMED LIST, FOR THE ROUTED BOARD.
 *
 * The initial board's screen carries an investor lens (which investors this
 * answer holds) and a staff-only warning (a lender quoting with no white-label
 * name yet). Both were built from `investorPrograms.decorate`, which resolves a
 * LENDER PRICE programme against the Lender Price registry — right for a board of
 * only Lender Price rows, wrong for this one, which has dropped the turned-off
 * investors and carries LoanNEX's. So it is derived from the ROUTED programmes
 * themselves — the exact rows on the board — with the real investor label read
 * from the merge (`mergedInvestors`, keyed by investor). Same output shape as
 * `decorate` so the screen reads it unchanged. Pure.
 */
function rosterFromRouted(programs, mergedInvestors) {
  const list = Array.isArray(programs) ? programs : [];
  const labelByKey = new Map();
  for (const inv of mergedInvestors || []) {
    if (inv && inv.key != null) labelByKey.set(inv.key, inv.investor || inv.whiteLabel || inv.key);
  }
  // One roster entry per NAMED investor on the board, with its distinct programme
  // names — exactly the investors a lens may offer to narrow to.
  const byKey = new Map(); // key -> { whiteLabel, names: Map<program, consumerLabel> }
  for (const p of list) {
    if (!p || !p.investorKey || !p.whiteLabel) continue;
    let g = byKey.get(p.investorKey);
    if (!g) { g = { whiteLabel: p.whiteLabel, names: new Map() }; byKey.set(p.investorKey, g); }
    const name = String(p.program || '');
    if (!g.names.has(name)) g.names.set(name, p.consumerLabel || p.whiteLabel);
  }
  const roster = [...byKey.entries()].map(([key, g]) => {
    const sorted = [...g.names.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    return {
      key,
      whiteLabel: g.whiteLabel,
      investorLabel: labelByKey.get(key) || g.whiteLabel,
      programCount: sorted.length,
      programs: sorted.map(([program, consumerLabel]) => ({ consumerLabel, program })),
    };
  }).sort((a, b) => String(a.whiteLabel).localeCompare(String(b.whiteLabel)));
  // A row with no white-label name yet — distinct by WHO it is, so the warning
  // names each once. `key` present = the registry placed it (off the sheet);
  // `key` null = it could not be placed at all.
  const unseen = new Map();
  for (const p of list) {
    if (!p || p.whiteLabel) continue;
    const k = `${p.lender || ''} ${p.investor || ''}`;
    if (!unseen.has(k)) unseen.set(k, { lender: p.lender || null, investor: p.investor || null, key: p.investorKey || null });
  }
  return { roster, unmapped: [...unseen.values()] };
}

/**
 * THE CONFIGURATION ONE SEARCH RUNS UNDER, READ ONCE.
 *
 * The bracket loop asks the sheets once PER DSCR BAND. Reading the settings inside that
 * loop would spend a settings round trip per band and — worse — could price two bands
 * under two different configurations if somebody saved between them. Read here, passed
 * down, so every band of one search runs under one answer.
 *
 * `wantLoanNex` is the cheap question that keeps this free when it is not needed: with
 * nobody routed to LoanNEX there is nothing to ask it for, and the board is built from
 * Lender Price exactly as it always was, with no second vendor call at all.
 */
async function loadConfig(opts = {}) {
  const customCtx = await investorConfig.customRaw();
  const custom = customCtx.custom;
  const saved = opts.routes !== undefined ? { raw: opts.routes } : await investorConfig.investorsRaw();
  const links = opts.links !== undefined ? { raw: opts.links } : await investorConfig.linksRaw();
  const heldSetting = opts.marginHoldback !== undefined ? opts.marginHoldback : await investorConfig.holdbackRaw();
  const investorRows = routing.readSettings(saved.raw, custom).settings;
  const linkMap = investorLinks.readLinks(links.raw, custom).links;
  const roster = settingsOf.roster(investorRows, custom);
  return {
    routes: saved.raw,
    custom,
    links: links.raw,
    settings: investorRows,
    heldSetting,
    extraFor: routing.extraResolver(investorRows, linkMap, custom),
    wantLoanNex: expectedFromLoanNex(roster).length > 0,
    problem: saved.problem || customCtx.problem || null,
  };
}

/**
 * ONE BOARD, FROM TWO SHEETS, FOR ONE SCENARIO.
 *
 * Both sheets are asked AT ONCE (`allSettled`, never `all`): one refusing must not
 * cost the other's answer, which is the whole reason the officer still gets a board
 * when LoanNEX is having a bad minute.
 *
 * @returns {{ok:boolean, programs:Array, missing:Array, sources:object, nx:object|null, error?:string}}
 */
async function boardForScenario(sc, deps, opts = {}) {
  const { lp, nex, investorPrograms } = deps;
  const routes = opts.routes;
  const custom = opts.custom;
  const links = opts.links || null;

  const [lpRes, nxRes] = await Promise.allSettled([
    lp.price(sc),
    // A settings map with nobody on LoanNEX means there is nothing to ask it for,
    // and asking anyway would spend a vendor call to be thrown away.
    opts.wantLoanNex === false ? Promise.resolve(null) : nex.price(sc),
  ]);

  // ── The Lender Price half, exactly as this screen has always built it ──────
  if (lpRes.status !== 'fulfilled' || !lpRes.value || lpRes.value.ok === false) {
    const v = lpRes.status === 'fulfilled' ? lpRes.value : null;
    // A Lender Price answer that failed carries its OWN diagnostics — firstHttp /
    // retryHttp / upstream / provenance / fault — that priceErrorBody surfaces. Pass
    // them straight through so the FULL initial-board door reports a Lender Price
    // failure exactly as the summary door does (which errors on the raw `lp.price`
    // result). Only a REJECTED promise (the vendor threw, no result object) has to be
    // composed by hand.
    if (v) return Object.assign({}, v, { ok: false, error: v.error || 'lp_price_failed' });
    return {
      ok: false,
      error: 'lp_price_failed',
      message: lpRes.status === 'rejected' ? reasonOf(lpRes.reason) : null,
      http: null,
    };
  }
  const lpAnswer = lpRes.value;
  const lpParsed = lp.parseFull(lpAnswer.raw, { raw: !!opts.raw });
  const deco = investorPrograms.decorate(lpParsed.programs);
  /* ⛔ AN INVESTOR'S OWN HOLDBACK APPLIES ON THIS SHEET TOO (owner-reported 2026-09-03).
     The LoanNEX half went through `vendorMargin.applyToBoard` and the Lender Price half went
     through nothing at all — so a per-investor holdback set in the settings was silently
     ignored on every Lender Price row of this board, while the COMBINED engine had been
     applying it to both sheets all along (`combined-pricer.js`, its lenderprice and loannex
     calls). One setting doing two different things on two screens is the split this engine
     keeps being caught by.

     ⛔ AND IT CANNOT TAKE OUR MARGIN TWICE. Lender Price's own base is ZERO BY DESIGN —
     "Lender Price's feed ALREADY carries our holdback, so a second GLOBAL one here would take
     it twice", which is a fact about the feed and is why no global holdback is offered for it.
     `resolveHoldback` therefore adds nothing here unless an investor carries an EXTRA of its
     own, which is a different decision and does apply. `applyToBoard` also refuses a board it
     has already stamped, so passing one through twice cannot double it either. */
  const lpBoard = vendorMargin.applyToBoard(
    { source: 'lenderprice', programs: deco.programs },
    'lenderprice',
    { extraFor: opts.extraFor },
  );

  /* ── The LoanNEX half, shaped by the SAME code the combined engine uses ─────
     ⛔ ALL FOUR DIMENSIONS, NOT ONLY THE ARM ONE (owner-reported 2026-09-03: *"LoanNEX was
     perfect, including filtering out the wrong programs by term and by interest-only and by
     ARM… I told you to copy it from here"*). This board narrowed on the amortization ALONE,
     so an officer's own interest-only answer, their term and their rate lock did nothing to
     the LoanNEX half while Lender Price had already been asked for exactly those — the two
     sheets answering two different questions on one screen. MEASURED on the recorded board:
     38 programmes reached this board against the combined engine's 13, 19 of them
     interest-only on a search that asked for none, 15 at 40 years on a 30-year search, and
     about 69% of the rungs at a lock nobody asked for (mean spread 0.206 points, max 0.500 —
     twice the whole margin holdback).

     `productFilter.wantFrom` is the ONE definition of what a search is asking for, and it
     MIRRORS the request rather than re-deciding it: interest-only and the rate lock are read
     off the body Lender Price was ACTUALLY sent, the term set comes from `resolveSearchTerms`
     (the one place that owns "an interest-only search also covers 40 years"). Re-deriving any
     of it here would mean a change to that rule narrowed one vendor's board and not the
     other's, on the same search, silently.

     ⛔ WHICH REQUEST, and the fallback is not decoration: the client builds the body it POSTs
     on the tenant's LIVE foundation, so the wire body and the static build can genuinely
     disagree about `criteria.interestOnly`. The wire body wins; the static build is the
     fallback for a caller with none to hand.

     ⛔ AND THE AMORTIZATION IS STILL FORCED TO FIXED, AFTER. Owner-directed: *"In the general
     engine, don't enable the ARM feature."* `amortization` is not a supported field on this
     door — a caller sending one is 422'd — so `wantFrom` already falls back to fixed; forcing
     it is belt-and-braces against the day that field is accepted, and it is applied AFTER so
     it can only ever narrow, never widen. */
  let nxBoard = null;
  let nxMeta = null;
  const nxOk = nxRes.status === 'fulfilled' && nxRes.value && nxRes.value.board;
  if (nxOk) {
    const wire = lpAnswer.request && typeof lpAnswer.request === 'object' ? lpAnswer.request : null;
    const staticReq = opts.staticRequest && typeof opts.staticRequest === 'object' ? opts.staticRequest : null;
    const lpRequest = wire || staticReq;
    const lpCriteria = (wire && wire.criteria && typeof wire.criteria === 'object')
      ? wire.criteria
      : (staticReq && staticReq.criteria && typeof staticReq.criteria === 'object' ? staticReq.criteria : null);
    const want = Object.assign(
      productFilter.wantFrom(sc, lpModel._internals, { lpCriteria, lpRequest }),
      { amortization: 'fixed' },
    );
    const narrowed = productFilter.narrowBoard(nxRes.value.board, want);
    nxBoard = vendorMargin.applyToBoard(narrowed.board, 'loannex', {
      saved: opts.heldSetting, extraFor: opts.extraFor,
    });
    nxMeta = {
      transactionId: nxRes.value.transactionId || null,
      portal: nxRes.value.portal || null,
      /* WHAT THE NARROWING ACTUALLY DROPPED, PER DIMENSION — reported rather than
         silent, because "209 programmes became 41" with no reason is the same
         silence this filter replaces. `want` rides along so a screen can say what
         the search was read as asking for, not only what fell out of it. */
      want,
      droppedArm: (narrowed.dropped && narrowed.dropped.amortization) || 0,
      droppedIo: (narrowed.dropped && narrowed.dropped.interestOnly) || 0,
      droppedTerm: (narrowed.dropped && narrowed.dropped.term) || 0,
      droppedLock: (narrowed.dropped && narrowed.dropped.lock) || 0,
      droppedLockRungs: (narrowed.droppedRungs && narrowed.droppedRungs.lock) || 0,
      unclassified: narrowed.unclassified || 0,
      kept: narrowed.kept || 0,
      // What the sheet published twice, and what it published twice that no longer
      // prices alike — carried out so the board can account for every programme.
      duplicates: narrowed.duplicates || [],
      diverged: narrowed.diverged || [],
    };
  }

  const errors = {
    lenderprice: null,
    loannex: nxRes.status === 'rejected' ? reasonOf(nxRes.reason)
      : (!nxOk && opts.wantLoanNex !== false ? 'the rate sheet returned no board' : null),
  };

  const mergedRaw = merge.merge({ lenderprice: lpBoard, loannex: nxBoard },
    { errors, links, custom, settings: opts.settings || null });
  const routed = routing.applyRouting(mergedRaw, { routes, custom, revealSource: false });

  /* THE SEARCH EVERY LOANNEX ROW WAS QUOTED FOR. A rung states no loan amount,
     FICO, LTV or purpose — those are the question, not the answer — so the board
     builder restates them from here, exactly as the combined engine does. */
  const nxSearch = { loanAmount: sc.loan, fico: sc.fico, ltv: sc.ltv, loanPurpose: sc.purpose };
  const programs = quoteShape.programsForBoard(routed, {
    reveal: false,
    transactionId: nxMeta ? nxMeta.transactionId : null,
    portal: nxMeta ? nxMeta.portal : null,
    ...nxSearch,
  });

  /**
   * ⛔ A LENDER PRICE PROGRAM NOBODY CAN NAME STILL REACHES THIS BOARD — a REGRESSION this file
   * introduced, reported by the owner as *"the entire Lender Price is disconnected from the general
   * pricing engine"* (2026-09-03).
   *
   * Until this board became two-source, every Lender Price program went straight from
   * `investorPrograms.decorate` onto the screen, named or not: an unresolved one simply carried
   * `investorKey: null, whiteLabel: null` and showed under the vendor's own lender name, with the
   * screen's standing "No white-label program name yet for: …" warning naming it. Routing the whole
   * Lender Price half through `merge.merge` changed that silently — the merge keeps a row it cannot
   * name OFF the priced board (correctly, for ITS purpose), so a lender the registry does not carry
   * DISAPPEARED from a board it had always been on, and `investorsUnmapped` came back EMPTY because
   * this function reports the routed lens's list rather than the merge's.
   *
   * ⛔ ONLY THE LENDER PRICE HALF, and that is the whole point rather than an omission. Restoring
   * these is a RESTORATION: they were on this board yesterday. A LoanNEX row nobody can name was
   * never on it, and the owner's standing rule for a LoanNEX investor that does not arrive is to
   * leave it off silently and tell a super admin — so bringing one on under a vendor spelling would
   * be a new decision, not a repair.
   *
   * ⛔ IT CANNOT PUT A REAL INVESTOR NAME IN FRONT OF A CLIENT. This board is staff-only, an
   * unnamed row carries `whiteLabel: null` so `rosterFromRouted` reports it in `unmapped` (which is
   * exactly what makes it visible rather than silent), and the term-sheet door refuses a programme
   * that has no client-safe name outright (`termsheet/snapshot.buildMember` → `program_not_named`).
   * The name rule is enforced where a document is built, not by deleting rows from a staff screen.
   */
  const lpUnnamed = [];
  for (const p of (lpBoard.programs || [])) {
    // The SAME resolver the merge just used, so "could not be named" means the same thing in both
    // places and a row can never be dropped by one and restored by the other on a different rule.
    const id = merge.resolveInvestor(p, links, custom);
    if (!id || !id.key) lpUnnamed.push({ ...p, investorKey: null, whiteLabel: null, consumerLabel: null });
  }
  if (lpUnnamed.length) programs.push(...lpUnnamed);

  /* ── WHO WAS EXPECTED FROM LOANNEX AND DID NOT COME ────────────────────────
     Owner-directed: an investor the settings point at LoanNEX which LoanNEX did
     not price is left off the board SILENTLY and reported to the super admin
     instead. Silently, because once NQM locks on LoanNEX the Lender Price copy of
     its pricing is second-hand — showing it would be quoting a sheet we have
     stopped trusting for that investor. */
  const present = new Set();
  for (const p of programs) if (p && p.investorKey) present.add(p.investorKey);
  const cfg = settingsOf.readSettings(routes, custom);
  const expected = expectedFromLoanNex(settingsOf.roster(cfg.settings, custom));
  /* An investor is MISSING only when LoanNEX was asked, answered, and simply did not
     carry it. A LoanNEX that refused outright is a different fact — every one of them
     is absent for one reason, and reporting that as forty separate missing investors
     would bury the one thing worth knowing. `sources.loannex` carries that case. */
  const missing = nxOk ? expected.filter((k) => !present.has(k)) : [];

  /* ── WHICH SHEET ACTUALLY PRODUCED WHOM ────────────────────────────────────
     Owner-directed 2026-09-03: the side-by-side list shows *"which systems that
     investor is available on"*, and *"If you see a new investor populating in any
     of the systems, just add that to the list."*

     Read off the MERGE, before the routing, because that is the only place both
     halves still exist side by side — `presentIn` is the merge's own answer to
     "which sheets carried this investor", resolved through the same registry, the
     same links and the same hand-added roster the board is built with. Counting it
     again here would be a second answer to a question already settled.

     ⛔ REPORTED, NOT WRITTEN. This module touches no database (see the header), so
     it hands the observation out and the route records it. And it says whether each
     sheet ANSWERED at all: a sheet that refused is no evidence about any investor,
     and treating an outage as "these investors are not on LoanNEX" would lock out
     the five the owner switched over. */
  const sightedOn = (src) => (mergedRaw.investors || [])
    .filter((x) => x && Array.isArray(x.presentIn) && x.presentIn.includes(src))
    .map((x) => x.key);
  const sightings = {
    lenderprice: { answered: true, keys: sightedOn('lenderprice') },
    loannex: { answered: !!nxOk, keys: nxOk ? sightedOn('loannex') : [] },
  };

  /* THE LENS ROSTER AND THE UNNAMED WARNING, for the board actually shown — the
     initial-board door reads these; the bracket door ignores them and reads the
     bands. Derived from the routed programmes so it can never describe a different
     board than the one on screen. */
  const lens = rosterFromRouted(programs, mergedRaw.investors);

  /* THE COUNTS DESCRIBE THE BOARD THAT IS SHOWN, not the raw Lender Price answer.
     `lpParsed` counts the pre-routing Lender Price programmes and lenders, so once a
     shop switches an investor to LoanNEX or turns one off, its `programCount` /
     `lenderCount` name a board nobody is looking at (LoanNEX rows uncounted, turned-off
     LP rows still counted). Recompute both from the ROUTED programmes — each carries
     `lender` (a LoanNEX row's is its investor name), so the lender count is a real
     distinct-lender count over the mixed board. The bracket door reads only
     `parsed.programs`, so overriding these counts never reaches the bands. */
  const routedLenderCount = new Set(programs.map((p) => p && p.lender).filter(Boolean)).size;

  /* ⛔ WHAT THE TWO SHEETS ACTUALLY CALLED EACH INVESTOR — the input the linking screen
     works from (owner-reported 2026-09-03: *"linking doesn't work"*).

     It did not, and this is why: the COMBINED board has always returned `investorPairing`,
     and its pricer hands it to `LtInvestorLinks`, which caches it so the settings screen can
     read it back. The GENERAL board returned NOTHING of the kind — so on the general settings
     screen the linking panel had no board to work from, and the only way it ever showed
     anything was if the same person had visited the COMBINED pricer (super-admin only) in the
     same browser session. The panel was mounted and wired to real doors the whole time; what
     was missing was the DATA.

     Built by the SAME `investorLinks.pairing` from the SAME `namesFromBoard`, off the boards
     as the sheets returned them (never the registry's idea of them), so a link offered on one
     engine's screen is the link the other engine's screen offers too. */
  const investorPairing = investorLinks.pairing({
    lenderprice: investorLinks.namesFromBoard(lpBoard),
    loannex: investorLinks.namesFromBoard(nxBoard),
  }, links, custom);   // in THIS scope `links` is already the raw value (see line ~169), not a { raw } wrapper

  return {
    ok: true,
    sightings,
    investorPairing,
    parsed: Object.assign({}, lpParsed, { programs, programCount: programs.length, lenderCount: routedLenderCount }),
    programs,
    missing,
    roster: lens.roster,
    unmapped: lens.unmapped,
    searchKey: lpAnswer.searchKey || null,
    request: lpAnswer.request || null,
    provenance: lpAnswer.provenance || null,
    recovered: !!lpAnswer.recovered,
    // Dev diagnostics, only when asked — parity with the summary door (never sent
    // on an ordinary search, so the board is not bloated with raw vendor payloads).
    rawSummary: opts.debug ? lp.summarizeRaw(lpAnswer.raw) : undefined,
    nx: nxMeta,
    sources: {
      lenderprice: { ok: true },
      loannex: { ok: !!nxOk, reason: errors.loannex },
    },
    presentKeys: [...present],
  };
}

/* THE PRE-SEARCH INVESTOR PICKER — the investors that CAN appear on the routed board,
   so the tick-boxes offered BEFORE a search match what a search actually shows
   (owner-directed 2026-09-03). Derived from the SAME settings `loadConfig`/`boardForScenario`
   route on, so the picker and the board can never drift: every investor that is ON
   (`enabled`) and carries a client-facing white label — a LoanNEX-switched investor
   INCLUDED (it now reaches this engine's board), a turned-off one EXCLUDED, and an unnamed
   one EXCLUDED (it lands in `unmapped` on the board and cannot be ticked there either).
   Shape matches `investorPrograms.fullRoster` so the picker component is unchanged. */
function pickerRoster(cfg) {
  return settingsOf.roster(cfg.settings, cfg.custom)
    .filter((r) => r && r.enabled && r.whiteLabel)
    .map((r) => ({ key: r.key, whiteLabel: r.whiteLabel, investorLabel: r.label }))
    .sort((a, b) => String(a.whiteLabel).localeCompare(String(b.whiteLabel)));
}

module.exports = { boardForScenario, loadConfig, pickerRoster, _internals: { reasonOf, expectedFromLoanNex, rosterFromRouted } };
