'use strict';
/**
 * LONG-TERM — MERGE the two pricing programs into one board, and say which
 * program to take each investor from.
 *
 * THE OWNER'S ASK, 2026-08-30: *"Add this as an additional to merge both
 * programs, so the pilot should basically give you from both programs together.
 * For investors that are available on both programs, we're going to tell you
 * which program to choose and which investor to take from this program, which
 * investor to take from this program."*
 *
 * ── WHAT THIS MODULE DECIDES, AND WHAT IT REFUSES TO DECIDE ────────────────
 * It decides ONE thing: for each canonical investor, which vendor is showing the
 * better execution for THIS scenario, and by how much. It refuses to decide
 * anything it cannot measure. Three refusals, all deliberate:
 *
 *   1. AN UNRESOLVED INVESTOR IS NEVER MERGED. Identity comes from the one
 *      investor registry (`encompass/investors.js`, 151 spellings → ~40
 *      companies). A name that resolves to no canonical key is reported in
 *      `unmapped` and shown on its own. Guessing that "Button Finance, Inc."
 *      is some investor we already know would silently merge two different
 *      companies' pricing — the worst possible outcome of a merge.
 *   2. NOTHING IS COMPARED ACROSS PRODUCT CLASSES OR LOCK PERIODS. A price is
 *      only ever compared to another price at the SAME product class
 *      (`product-class.js`), the SAME lock days and the SAME note rate. An
 *      investor quoting 30-day locks on one program and 45-day on the other has
 *      NO comparable basis, and is reported as `no_comparable_basis` — shown from
 *      both, elected from neither.
 *   3. A TIE IS A TIE. Identical execution elects nobody; both are shown.
 *
 * ── THE RULE, IN ONE LINE ──────────────────────────────────────────────────
 * At the same product, the same lock and the same note rate, the HIGHER PRICE is
 * the better execution. That is the secondary-market meaning of "better", not a
 * preference: a higher price is more proceeds on the same loan. The winner is
 * the vendor that wins more of those matched comparisons; the margin reported
 * beside it is the mean price advantage, in points, over every matched pair.
 *
 * ── WHY THE BOARD STILL SHOWS EVERYTHING ───────────────────────────────────
 * Election is a RECOMMENDATION carried beside the data, never a filter. Both
 * vendors' programs stay on the merged board for every investor, exactly as the
 * standing rule for investor groups requires ("hide on the screen, never narrow
 * the search"). A staff member always sees what the loser quoted and can
 * disagree with the election.
 *
 * ── THE INVESTOR NAME NEVER REACHES A CLIENT ───────────────────────────────
 * Every merged investor carries the white-label name beside the real one, from
 * the one sheet (`lenderprice/investor-programs.js`). The engine is staff-only;
 * the white-label is what a consumer surface may print, and an investor with no
 * white-label name has NO consumer label — null, never a fallback to the real
 * name (rule 10).
 *
 * ── THE INVESTORS ADDED BY HAND (2026-09-02) ───────────────────────────────
 * `opts.custom` is the map of investors a super admin added on the settings
 * screen (`pricing/investor-roster.js`). It is threaded into the ONE resolver
 * here and into the suggestion list, so a vendor's row naming a hand-added
 * investor is merged onto the board like a registry one — instead of being
 * kept off it in `unmapped` with a deploy as the only way in. Absent, the
 * behaviour is byte-for-byte what it was.
 *
 * PURE: no network, no database, no RTL import.
 */

const effective = require('./investor-roster');
const investorLinks = require('./investor-links');
const whiteLabel = require('../lenderprice/investor-programs');
const { classify } = require('./product-class');

const SOURCES = ['lenderprice', 'loannex'];
const sources = require('./sources');
const round3 = (n) => (n == null ? null : Math.round(Number(n) * 1000) / 1000);

/**
 * Which canonical investor a program row belongs to. Both vendors' name fields
 * are asked, fullest first; unresolved is null and the caller must not guess.
 *
 * `links` is the map a PERSON recorded — "this spelling and that one are the
 * same investor" (owner-directed 2026-08-30). It is consulted first and it is
 * OPTIONAL, so every existing caller behaves exactly as it did.
 */
function resolveInvestor(row, links, custom) {
  const r = row || {};
  for (const raw of [r.investor, r.lender]) {
    if (raw == null || String(raw).trim() === '') continue;
    const hit = links ? investorLinks.resolveWithLinks(raw, links, custom) : effective.effectiveResolve(raw, custom);
    if (hit && hit.key) {
      return { key: hit.key, label: hit.label, match: hit.match, raw: String(raw), linked: !!hit.linked, custom: !!hit.custom };
    }
  }
  const raw = r.investor || r.lender || null;
  return { key: null, label: null, match: 'none', raw: raw == null ? null : String(raw), linked: false, custom: false };
}

/**
 * Every (productClass, lockDays, rate) → best price this source offers for this
 * investor. "Best" within a source is the highest price, because a source may
 * quote the same rate on several of its own programs and the investor would give
 * the borrower its best one.
 */
function offerIndex(programs) {
  const idx = new Map();
  for (const p of programs || []) {
    const cls = classify(p);
    if (!cls) continue; // unclassifiable → excluded from comparison (refusal 2)
    for (const rung of p.rungs || []) {
      if (rung == null || rung.price == null || rung.rate == null || rung.lockDays == null) continue;
      const key = `${cls.key}|${rung.lockDays}|${round3(rung.rate)}`;
      const prev = idx.get(key);
      if (!prev || rung.price > prev.price) {
        idx.set(key, {
          price: round3(rung.price), rate: round3(rung.rate), lockDays: rung.lockDays,
          productClass: cls.key, program: p.program, product: p.product, priceHashKey: rung.priceHashKey || null,
        });
      }
    }
  }
  return idx;
}

/** The single best quote a source shows for an investor, for the summary line. */
function bestOf(programs) {
  let best = null;
  for (const p of programs || []) {
    for (const rung of p.rungs || []) {
      if (rung == null || rung.rate == null) continue;
      // "Best" for a headline is the LOWEST rate; ties broken by the higher price.
      if (!best || rung.rate < best.rate || (rung.rate === best.rate && (rung.price || -Infinity) > (best.price || -Infinity))) {
        best = { rate: round3(rung.rate), price: round3(rung.price), points: round3(rung.points), lockDays: rung.lockDays, program: p.program, product: p.product };
      }
    }
  }
  return best;
}

/**
 * Compare one investor across the two sources on matched (class, lock, rate)
 * triples. Returns the measurement — never a verdict; `elect` reads it.
 */
function compare(lpPrograms, nxPrograms) {
  const a = offerIndex(lpPrograms);
  const b = offerIndex(nxPrograms);
  const pairs = [];
  for (const [key, lp] of a) {
    const nx = b.get(key);
    if (!nx) continue;
    pairs.push({
      productClass: lp.productClass, lockDays: lp.lockDays, rate: lp.rate,
      lenderpricePrice: lp.price, loannexPrice: nx.price,
      delta: round3(nx.price - lp.price), // positive = LoanNEX better
    });
  }
  pairs.sort((x, y) => x.productClass.localeCompare(y.productClass) || x.lockDays - y.lockDays || x.rate - y.rate);
  const n = pairs.length;
  const loannexWins = pairs.filter((p) => p.delta > 0).length;
  const lenderpriceWins = pairs.filter((p) => p.delta < 0).length;
  const ties = n - loannexWins - lenderpriceWins;
  const meanDelta = n ? round3(pairs.reduce((s, p) => s + p.delta, 0) / n) : null;
  const sorted = pairs.map((p) => p.delta).sort((x, y) => x - y);
  const medianDelta = n ? round3(n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2) : null;
  return {
    comparedPoints: n, loannexWins, lenderpriceWins, ties,
    meanDeltaPrice: meanDelta, medianDeltaPrice: medianDelta,
    maxDeltaPrice: n ? round3(Math.max(...pairs.map((p) => p.delta))) : null,
    minDeltaPrice: n ? round3(Math.min(...pairs.map((p) => p.delta))) : null,
    // Capped: a board carries this per investor and the full grid is thousands of rows.
    samples: pairs.slice(0, 40),
    sampleTruncated: n > 40,
  };
}

/** The verdict, and the sentence that explains it. */
function elect(presentIn, cmp) {
  if (presentIn.length === 1) {
    const only = presentIn[0];
    return { chosen: only, basis: 'sole_source', reason: `Only ${label(only)} quotes this investor for this scenario.` };
  }
  if (!cmp || !cmp.comparedPoints) {
    return {
      chosen: null, basis: 'no_comparable_basis',
      reason: 'Both programs quote this investor, but on no shared product/lock/rate — there is nothing to compare, so neither is elected. Both are shown.',
    };
  }
  if (cmp.loannexWins === cmp.lenderpriceWins) {
    return {
      chosen: null, basis: 'tie',
      reason: `Identical execution across all ${cmp.comparedPoints} matched quotes — neither program is better. Both are shown.`,
    };
  }
  const winner = cmp.loannexWins > cmp.lenderpriceWins ? 'loannex' : 'lenderprice';
  const wins = winner === 'loannex' ? cmp.loannexWins : cmp.lenderpriceWins;
  const margin = Math.abs(cmp.meanDeltaPrice);
  return {
    chosen: winner, basis: 'better_execution',
    reason: `${label(winner)} prices better on ${wins} of ${cmp.comparedPoints} matched quotes ` +
            `(same product, same lock, same rate), by ${margin.toFixed(3)} in price on average.`,
  };
}

// ONE definition — and an unknown source is NAMED, never called Lender Price.
const label = sources.sourceLabel;

/**
 * Merge two normalised boards.
 *
 * @param boards { lenderprice: parsedBoard|null, loannex: parsedBoard|null }
 *        Either may be null (that program did not answer) — the merge still
 *        produces a board from the other and says so in `sources`.
 * @param opts   { errors: { lenderprice?, loannex? } } — a failure reason to carry
 *        through so a caller can tell "quoted nothing" from "did not answer".
 */
function merge(boards, opts = {}) {
  const input = boards || {};
  const errors = opts.errors || {};
  // The human's "these two names are the same investor" map. Absent → the code
  // registry alone, which is exactly what this did before it existed.
  const links = opts.links || null;
  /* THE PER-INVESTOR SETTINGS, so the client-safe name here is the one the routing and the
     settings screen already agree on. Absent → the sheet alone, which is what this did before. */
  const settings = opts.settings || null;
  // The investors added by hand. Absent → the registry alone.
  const custom = opts.custom === undefined ? null : opts.custom;
  const byInvestor = new Map();
  const unmapped = [];
  const matchedByGuess = new Set();
  const matchedByLink = new Set();

  for (const src of SOURCES) {
    const board = input[src];
    if (!board || !Array.isArray(board.programs)) continue;
    for (const p of board.programs) {
      const id = resolveInvestor(p, links, custom);
      const row = { ...p, source: src };
      if (!id.key) {
        // NEVER SILENTLY: a row nobody can name cannot be white-labelled, and the
        // investor's REAL name may never reach a client — so it is kept OFF the
        // priced board and reported here instead. What is new is that the report
        // now carries what a person needs to ACT on it: which program said it and
        // which investors it might be. Before, the only fix was a code change;
        // now a super admin can link the spelling or add the investor by hand.
        unmapped.push({
          source: src, name: id.raw, program: p.program || null, product: p.product || null,
          suggestions: id.raw ? investorLinks.suggestFor(id.raw, { custom }) : [],
        });
        continue;
      }
      // How it joined travels with the row, so a screen can tell a person's
      // decision from the registry's last-resort guess.
      if (investorLinks.isGuess(id.match)) matchedByGuess.add(id.key);
      if (id.linked) matchedByLink.add(id.key);
      let e = byInvestor.get(id.key);
      /**
       * ⛔ THE ONE ANSWER TO "WHAT MAY A CLIENT CALL THIS INVESTOR" (audit F9).
       *
       * This asked `whiteLabelOf` — the owner's SHEET and nothing else — while `investor-routing`
       * asked `settingFor(...).whiteLabel`, which is the name somebody TYPED on the settings screen
       * OR the sheet's. Two answers to one question, and this was the copy that drifted: measured,
       * an investor with a typed name and no sheet entry answered `null` here and "Slate" there.
       *
       * Today that only reaches the sort order, which is why it went unnoticed. But the question is
       * the one rule 10 turns on, and a second answer to it is how a name a person never chose ends
       * up on something a client reads. `effectiveWhiteLabel` is the single definition — the typed
       * setting, else the hand-added roster, else the sheet — and both readers now ask it.
       */
      if (!e) { e = { key: id.key, label: id.label, whiteLabel: whiteLabel.effectiveWhiteLabel(id.key, custom, settings), programs: { lenderprice: [], loannex: [] } }; byInvestor.set(id.key, e); }
      e.programs[src].push(row);
    }
  }

  const list = [];
  for (const e of byInvestor.values()) {
    const presentIn = SOURCES.filter((s) => e.programs[s].length > 0);
    const cmp = presentIn.length === 2 ? compare(e.programs.lenderprice, e.programs.loannex) : null;
    const verdict = elect(presentIn, cmp);
    list.push({
      key: e.key, investor: e.label, whiteLabel: e.whiteLabel,
      // Stated rather than implied: `joinedByGuess` is the registry's prefix
      // heuristic, which is usually right and is still a guess. A screen that
      // shows every join as settled is over-claiming.
      joinedByGuess: matchedByGuess.has(e.key),
      joinedByLink: matchedByLink.has(e.key),
      presentIn,
      chosen: verdict.chosen, electionBasis: verdict.basis, reason: verdict.reason,
      comparison: cmp,
      best: { lenderprice: bestOf(e.programs.lenderprice), loannex: bestOf(e.programs.loannex) },
      programCounts: { lenderprice: e.programs.lenderprice.length, loannex: e.programs.loannex.length },
      programs: e.programs,
    });
  }

  // Investors quoted by both first (those are the ones the owner asked about),
  // then by white-label name so the board reads the same way every time.
  list.sort((a, b) => (b.presentIn.length - a.presentIn.length)
    || String(a.whiteLabel || a.investor || '').localeCompare(String(b.whiteLabel || b.investor || '')));

  const counts = (pred) => list.filter(pred).length;
  return {
    sources: {
      lenderprice: sourceStatus(input.lenderprice, errors.lenderprice),
      loannex: sourceStatus(input.loannex, errors.loannex),
    },
    summary: {
      investorCount: list.length,
      inBoth: counts((x) => x.presentIn.length === 2),
      lenderpriceOnly: counts((x) => x.presentIn.length === 1 && x.presentIn[0] === 'lenderprice'),
      loannexOnly: counts((x) => x.presentIn.length === 1 && x.presentIn[0] === 'loannex'),
      electedLoannex: counts((x) => x.chosen === 'loannex' && x.electionBasis === 'better_execution'),
      electedLenderprice: counts((x) => x.chosen === 'lenderprice' && x.electionBasis === 'better_execution'),
      noComparableBasis: counts((x) => x.electionBasis === 'no_comparable_basis'),
      ties: counts((x) => x.electionBasis === 'tie'),
      unmappedNames: new Set(unmapped.map((u) => u.name)).size,
    },
    investors: list,
    // Reported, never merged, never guessed at (refusal 1). The owner names these
    // and they join the sheet; until then they price on their own row.
    unmapped: dedupeUnmapped(unmapped),
  };
}

function sourceStatus(board, error) {
  if (error) return { answered: false, error: String(error), programCount: 0, lenderCount: 0 };
  if (!board) return { answered: false, error: null, programCount: 0, lenderCount: 0 };
  return {
    answered: true, error: null,
    programCount: board.programCount || 0,
    lenderCount: board.lenderCount || 0,
    rungCount: board.rungCount || 0,
    executionTimeMs: board.executionTimeMs == null ? null : board.executionTimeMs,
    // ⛔ THE HOLDBACK'S OWN RECORD TRAVELS WITH THE SOURCE IT WAS TAKEN FROM.
    // `vendor-margin` stamps the vendor board with how much was held back, where
    // that number came from and any refusal — and the merge builds a NEW board,
    // so without carrying it here the whole record is dropped before anybody
    // sees it. That was survivable while 0.25 was a constant nobody could move;
    // it is not now that it is settable, because a price that moved must be able
    // to say WHO moved it and whether a saved value was refused.
    //
    // It belongs HERE, in the per-source provenance block, rather than at the
    // top of the board: it names a vendor, so it must ride with the reveal like
    // every other piece of provenance (`applyRouting` deletes `sources` on the
    // ordinary board, which is exactly right — see the one-system rule).
    marginHoldback: board.marginHoldback == null ? null : board.marginHoldback,
    marginHoldbackOrigin: board.marginHoldbackOrigin || null,
    marginHoldbackNote: board.marginHoldbackNote || null,
    marginHoldbackProblem: board.marginHoldbackProblem || null,
  };
}

function dedupeUnmapped(rows) {
  const m = new Map();
  for (const r of rows) {
    const k = `${r.source}|${r.name}`;
    // The SUGGESTIONS ride through the de-duplication. They are what turns "this
    // investor was dropped" into something a person can act on, and computing them
    // per PROGRAM row and then throwing them away here is how the actionable half
    // of the report goes missing.
    //
    // SET ONCE, AT THE HEAD, AND THAT IS COMPLETE — not a shortcut. The key is
    // `source|name` and BOTH the name and the suggestions are derived from the
    // same `id.raw`, so every row sharing a key carries an identical suggestion
    // list. An earlier cut also re-checked on each later row ("fill them in if the
    // first row had none"), which cannot fire: it can only ever restore what the
    // head already had. Its one effect was to hide this line from the mutation
    // that was meant to prove it — the two covered for each other and the suite
    // stayed green with either one gone.
    if (!m.has(k)) m.set(k, { source: r.source, name: r.name, programs: [], suggestions: r.suggestions || [] });
    const e = m.get(k);
    if (r.program && !e.programs.includes(r.program)) e.programs.push(r.program);
  }
  return [...m.values()];
}

module.exports = { merge, compare, elect, resolveInvestor, offerIndex, bestOf, SOURCES, _internals: { label, dedupeUnmapped, sourceStatus, round3 } };
