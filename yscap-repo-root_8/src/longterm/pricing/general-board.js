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

  const mergedRaw = merge.merge({ lenderprice: lpBoard, loannex: nxBoard }, { errors, links, custom });
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

  return {
    ok: true,
    parsed: Object.assign({}, lpParsed, { programs }),
    programs,
    missing,
    searchKey: lpAnswer.searchKey || null,
    request: lpAnswer.request || null,
    provenance: lpAnswer.provenance || null,
    nx: nxMeta,
    sources: {
      lenderprice: { ok: true },
      loannex: { ok: !!nxOk, reason: errors.loannex },
    },
    presentKeys: [...present],
  };
}

module.exports = { boardForScenario, _internals: { reasonOf, expectedFromLoanNex } };
