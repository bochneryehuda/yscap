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
    return {
      ok: false,
      error: (v && v.error) || 'lp_price_failed',
      message: (v && v.message) || (lpRes.status === 'rejected' ? reasonOf(lpRes.reason) : null),
      http: (v && v.http) || null,
    };
  }
  const lpAnswer = lpRes.value;
  const lpParsed = lp.parseFull(lpAnswer.raw);
  const deco = investorPrograms.decorate(lpParsed.programs);
  const lpBoard = { source: 'lenderprice', programs: deco.programs };

  // ── The LoanNEX half, shaped by the SAME code the combined engine uses ─────
  // Fixed only (see the header). `wantFrom` is deliberately not consulted for the
  // amortization: this screen has no ARM chooser, so there is no officer answer to
  // read and "fixed" is the standing rule rather than a preference.
  let nxBoard = null;
  let nxMeta = null;
  const nxOk = nxRes.status === 'fulfilled' && nxRes.value && nxRes.value.board;
  if (nxOk) {
    const narrowed = productFilter.narrowBoard(nxRes.value.board, { amortization: 'fixed' });
    nxBoard = vendorMargin.applyToBoard(narrowed.board, 'loannex', {
      saved: opts.heldSetting, extraFor: opts.extraFor,
    });
    nxMeta = {
      transactionId: nxRes.value.transactionId || null,
      portal: nxRes.value.portal || null,
      droppedArm: (narrowed.dropped && narrowed.dropped.amortization) || 0,
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

  return {
    ok: true,
    sightings,
    parsed: Object.assign({}, lpParsed, { programs }),
    programs,
    missing,
    roster: lens.roster,
    unmapped: lens.unmapped,
    searchKey: lpAnswer.searchKey || null,
    request: lpAnswer.request || null,
    provenance: lpAnswer.provenance || null,
    recovered: !!lpAnswer.recovered,
    nx: nxMeta,
    sources: {
      lenderprice: { ok: true },
      loannex: { ok: !!nxOk, reason: errors.loannex },
    },
    presentKeys: [...present],
  };
}

module.exports = { boardForScenario, loadConfig, _internals: { reasonOf, expectedFromLoanNex, rosterFromRouted } };
