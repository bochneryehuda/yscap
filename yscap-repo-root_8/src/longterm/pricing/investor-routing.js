'use strict';
/**
 * LONG-TERM — apply the INVESTOR SETTINGS to a merged board, and make it read as
 * ONE SYSTEM.
 *
 * ── THE OWNER'S RULE ───────────────────────────────────────────────────────
 * 2026-08-30: *"At our system, it shouldn't be a difference from where it's
 * taking the information. It should be something where the admin can go in and
 * click to see the source of the info, and it's telling him the source. At our
 * system, it should sound like one system. It shouldn't sound like it's coming
 * from different places."*
 *
 * So the board this returns does NOT say where a row came from. Each investor
 * has ONE list of programs, and the vendor is stripped off every row. An admin
 * asks for it explicitly (`revealSource: true`) and then — and only then — the
 * answer carries `source` and the per-vendor breakdown.
 *
 * THAT IS A DISPLAY RULE, NOT A RECORD-KEEPING ONE. Nothing is thrown away: the
 * provenance is one flag away, and the merge underneath still holds both
 * vendors' answers. What changes is what an ordinary reader is shown, and the
 * point of it is that a quote should be a quote.
 *
 * ── WHERE THE DECISIONS LIVE ───────────────────────────────────────────────
 * Not here. Which investors are on, what they are called and which vendor each
 * is fetched from all come from `investor-settings.js`, which derives its roster
 * from the one investor registry. This module APPLIES that roster to a board —
 * it holds no list of its own, so there is nothing here to drift.
 *
 * ⛔ NO PRICE IS ADJUSTED IN THIS FILE. The margin holdback the owner authorized
 * lives in `vendor-margin.js` and is applied to the board before anything here
 * sees it.
 *
 * PURE: no network, no database, no RTL import.
 */

const settingsOf = require('./investor-settings');

/** A route is now simply the investor's SOURCE. Kept as its own word because a
 *  board talks about routing and a settings screen talks about a source. */
const ROUTES = settingsOf.SOURCES;
const DEFAULT_ROUTE = settingsOf.DEFAULT_SOURCE;

/** Which sources a setting lets through, given which actually answered. */
function sourcesUnder(source, presentIn) {
  const has = (x) => (presentIn || []).includes(x);
  if (source === 'lenderprice') return has('lenderprice') ? ['lenderprice'] : [];
  if (source === 'loannex') return has('loannex') ? ['loannex'] : [];
  return [...(presentIn || [])];
}

/**
 * Apply the investor settings to a merged board.
 *
 * WHAT IT NEVER DOES: change a number, or re-order by preference. It hides, it
 * narrows, and it SAYS SO — every removal comes back in `hidden[]` with its
 * reason, so a board showing six investors where the vendors priced nine can
 * always account for the other three.
 *
 * AN INVESTOR WHOSE SOURCE DID NOT ANSWER IS LEFT EMPTY, and that is the honest
 * outcome rather than a quiet fallback to the other vendor: somebody who set an
 * investor to LoanNEX must not be shown Lender Price's number believing it is
 * LoanNEX's. Two wordings, because "the vendor is down" and "the vendor is up
 * and did not quote them" are different problems for different people.
 *
 * ONE SYSTEM. Unless `revealSource` is set, an investor comes back with ONE flat
 * list of programs and no mention of a vendor anywhere on it — not on the row,
 * not on the investor, not in the summary. With it set, the same answer
 * additionally carries `source` and the per-vendor split. Nothing is discarded
 * either way; the flag decides what is SHOWN.
 */
function applyRouting(merged, opts = {}) {
  const board = merged || {};
  // The investors added by hand (`pricing/investor-roster.js`) — a hand-added
  // investor gets a settings row and is routed exactly like a registry one.
  const custom = opts.custom;
  const cfg = settingsOf.readSettings(opts.routes !== undefined ? opts.routes : opts.settings, custom);
  const settings = cfg.settings;
  const reveal = opts.revealSource === true;
  const hidden = [];
  const list = [];

  for (const e of board.investors || []) {
    const row = settingsOf.settingFor(e.key, settings, custom);

    if (!row.enabled) {
      hidden.push({
        investor: e.investor, key: e.key, why: 'switched_off',
        reason: row.note || 'This investor is switched off in the investor settings.',
      });
      continue;
    }

    const shown = sourcesUnder(row.source, e.presentIn);
    if (!shown.length) {
      const src = board.sources && board.sources[row.source];
      const outage = src && src.answered === false;
      hidden.push({
        investor: e.investor, key: e.key, why: outage ? 'source_did_not_answer' : 'source_had_no_quote',
        reason: outage
          ? `Set to ${label(row.source)}, which did not answer at all${src.error ? ` (${src.error})` : ''}. The other program's price is deliberately NOT shown in its place — this investor is priced there, so ours would be second-hand.`
          : `Set to ${label(row.source)}, which answered but did not quote this investor for this scenario. The other program's price is deliberately NOT shown in its place.`,
      });
      continue;
    }

    // ONE FLAT LIST. The per-vendor split is what makes a board sound like two
    // systems, so it is assembled away here and only handed back on request.
    const flat = [];
    for (const sName of shown) for (const p of (e.programs && e.programs[sName]) || []) flat.push(p);

    const out = {
      key: e.key,
      investor: e.investor,
      whiteLabel: row.whiteLabel,
      whiteLabelMissing: row.whiteLabelMissing,
      programs: reveal ? flat : flat.map(stripSource),
      programCount: flat.length,
      best: bestOfMany(shown.map((sName) => e.best && e.best[sName]).filter(Boolean)),
    };
    if (reveal) {
      out.source = row.source;
      out.sourceOrigin = row.sourceOrigin;
      out.shownFrom = shown;
      out.bySource = { lenderprice: shown.includes('lenderprice') ? (e.programs && e.programs.lenderprice) || [] : [], loannex: shown.includes('loannex') ? (e.programs && e.programs.loannex) || [] : [] };
      out.comparison = e.comparison || null;
      out.electionBasis = e.electionBasis || null;
      out.reason = e.reason || null;
    }
    list.push(out);
  }

  // An investor the registry does not know cannot have a settings row, so they
  // cannot be switched off and cannot carry a client-safe name. They are
  // REPORTED rather than displayed — putting an unnamed company on a board is
  // how a real investor name reaches somebody who may not see one.
  const unmapped = [];
  for (const u of board.unmapped || []) unmapped.push(u);

  const counts = (pred) => list.filter(pred).length;
  const summary = {
    ...(board.summary || {}),
    investorCount: list.length,
    unmappedNames: new Set(unmapped.map((u) => u.name)).size,
    hiddenCount: hidden.length,
  };
  // The per-vendor counts describe where the board came FROM, which is exactly
  // what an ordinary reader is not shown. They ride with the reveal.
  if (reveal) {
    summary.fromLenderPrice = counts((x) => x.shownFrom && x.shownFrom.length === 1 && x.shownFrom[0] === 'lenderprice');
    summary.fromLoanNex = counts((x) => x.shownFrom && x.shownFrom.length === 1 && x.shownFrom[0] === 'loannex');
    summary.fromBoth = counts((x) => x.shownFrom && x.shownFrom.length === 2);
  } else {
    delete summary.inBoth; delete summary.lenderpriceOnly; delete summary.loannexOnly;
    delete summary.electedLoannex; delete summary.electedLenderprice;
    delete summary.noComparableBasis; delete summary.ties;
  }

  const out = {
    ...board,
    summary,
    investors: list,
    unmapped,
    hidden,
    settings: {
      applied: Object.keys(settings).length,
      problems: cfg.problems,
      defaultSource: DEFAULT_ROUTE,
      note: 'One investor, one source — so the board reads as one system. Ask for the source explicitly to see where each row came from.',
    },
  };
  // `sources` names the two vendors and their errors; that is provenance, and
  // provenance is what the reveal is for.
  if (!reveal) delete out.sources;
  return out;
}

/**
 * A program row with every trace of which vendor produced it removed.
 *
 * ⛔ THE VENDOR IS A FINGERPRINT, NOT ONLY A NAME. Dropping `source` and the two
 * vendor ids is not enough on its own: the 0.25 margin holdback stamps
 * `marginHoldback` and `vendorPrice` on every rung it touches, and it touches
 * LoanNEX's rungs and no others (`pricing/vendor-margin.js` — Lender Price's
 * feed already carries our holdback, so nothing is taken there). So a rung
 * CARRYING those fields is a LoanNEX rung and a rung without them is a Lender
 * Price one, which is exactly the tell this module exists to remove — a screen
 * could branch on it and the board would read as two systems again while every
 * field that NAMES a vendor was gone.
 *
 * NO PRICE MOVES. `price` and `points` already have the holdback in them and are
 * untouched; what goes is the AUDIT TRAIL beside them — the raw pre-holdback
 * price and the size of the deduction — which rides with the reveal like every
 * other piece of provenance.
 */
function stripSource(p) {
  if (!p || typeof p !== 'object') return p;
  const {
    source, lenderId, investorOrganizationGuid,
    // ⛔ THE PROGRAM'S OWN HOLDBACK STAMPS GO TOO (owner-directed 2026-08-30:
    // *"The pricing that it should add on top of LoanNEX pricing as a company
    // margin holdback should be hidden for consumers, it should be baked into
    // the rate any time when customers and consumers are looking at it."*).
    //
    // Since the holdback became per-investor, the PROGRAM carries what was taken
    // from it as well as the rung — and a program-level field is not touched by
    // the rung mapping below, so without naming them here our own margin, and
    // which investors we take more on, would ride out on the ordinary board.
    // The PRICE is untouched: the deduction is already in it, which is exactly
    // what "baked into the rate" means.
    marginHoldback, marginHoldbackOrigin, marginHoldbackBase,
    marginHoldbackExtra, marginHoldbackProblem,
    ...rest
  } = p;
  if (Array.isArray(rest.rungs)) rest.rungs = rest.rungs.map(stripHoldbackTrail);
  // ⛔ AND THE ITEMIZED OPTIONS, WHICH ARE THE SAME TELL ONE LEVEL DOWN. A Lender Price program
  // carries `options` — the whole price build the breakdown panel reads — and the holdback stamps
  // its trail there too (`vendor-margin.shiftOptions`): the pre-holdback price, the pre-holdback
  // base, and the size of the deduction, sitting inside `priceBuild` where the rung strip above
  // cannot reach them. Left in place our own margin, and which investors we take more on, would
  // ride out on the ordinary board the moment somebody opened a price build — the exact leak this
  // module exists to close, one level deeper than it used to look.
  if (Array.isArray(rest.options)) rest.options = rest.options.map(stripOptionHoldbackTrail);
  return rest;
}

/** One rung with the holdback's own audit trail removed — never its price. */
function stripHoldbackTrail(r) {
  if (!r || typeof r !== 'object') return r;
  const { marginHoldback, vendorPrice, ...rest } = r;
  return rest;
}

/** One priced option with the same trail removed — never its price or its adjustments. */
function stripOptionHoldbackTrail(o) {
  if (!o || typeof o !== 'object') return o;
  const { marginHoldback, ...rest } = o;
  if (rest.priceBuild && typeof rest.priceBuild === 'object') {
    const { vendorPrice, vendorBasePoints, vendorAdjustedPoints, ...pb } = rest.priceBuild;
    rest.priceBuild = pb;
  }
  return rest;
}

/** The best headline across however many sources are being shown. */
function bestOfMany(list) {
  let best = null;
  for (const b of list) {
    if (!b || b.rate == null) continue;
    if (!best || b.rate < best.rate || (b.rate === best.rate && (b.price || -Infinity) > (best.price || -Infinity))) best = b;
  }
  return best;
}

function label(src) { return src === 'loannex' ? 'LoanNEX' : src === 'lenderprice' ? 'Lender Price' : src; }

/**
 * "WHAT DOES THIS ROW'S OWN INVESTOR ADD TO THE HOLDBACK?" — as a function of a
 * priced row, ready to hand to `vendor-margin.applyToBoard`.
 *
 * ⛔ IT LIVES HERE RATHER THAN IN THE ROUTE because it is the join between three
 * things that must agree: which investor a row belongs to (`merge.resolveInvestor`,
 * the ONE resolver), what that investor's saved settings say, and which investors
 * exist at all. A copy of this closure — in a second route, or re-typed inside a
 * test — is a copy that can keep passing after the real one stops threading the
 * hand-added investors, which is exactly the shape of bug it exists to prevent.
 *
 * A row whose investor nobody can name, or who carries no setting of their own,
 * answers null: the board-wide figure then applies, untouched.
 */
function extraResolver(settings = {}, links = null, custom = undefined) {
  const merge = require('./merge');
  return (row) => {
    const hit = merge.resolveInvestor(row, links, custom);
    if (!hit || !hit.key) return null;
    const saved = settingsOf.settingFor(hit.key, settings, custom);
    return saved && saved.holdbackOrigin === 'setting' ? saved.holdback : null;
  };
}

module.exports = {
  ROUTES, DEFAULT_ROUTE, sourcesUnder, applyRouting, extraResolver,
  // Re-exported so a caller has ONE door to the investor decisions rather than
  // needing to know which of the two modules holds which half.
  readSettings: settingsOf.readSettings, settingFor: settingsOf.settingFor,
  resolveRaw: settingsOf.resolveRaw,
  roster: settingsOf.roster, describeSettings: settingsOf.describe,
  _internals: { label, stripSource, stripHoldbackTrail, bestOfMany },
};
