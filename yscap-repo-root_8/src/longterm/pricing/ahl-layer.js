'use strict';
/**
 * LONG-TERM — AMERICAN HERITAGE LENDING as an ADDITIONAL LAYER on the merged
 * board, for that one investor and no other.
 *
 * ── THE OWNER'S INSTRUCTION ────────────────────────────────────────────────
 * 2026-08-30: *"This particular integration is going to be for American Heritage
 * Lending auto link. It and the price should populate from here and pre-fill a
 * 0.25 margin hold back on top of it. You need to lay out the results and the
 * LLPAs and everything the same way it's laid out on the other programs that
 * we're reading pricing from. Add this as an additional layer only for this
 * investor."*
 *
 * ── WHY A LAYER AND NOT A THIRD SOURCE INSIDE `merge.js` ───────────────────
 * `merge.js` elects between TWO sources by comparing them at the same product,
 * lock and note rate. AHL cannot take part in that election, and not because it
 * would be awkward — because it prices exactly ONE counterparty, its own sheet.
 * There is never a second quote for American Heritage to elect against, so
 * running it through a pairwise comparison would produce an "election" with one
 * candidate: a verdict that reads like a judgement and is really a tautology.
 *
 * ⛔ AND WIDENING THE ELECTION TO THREE WOULD CHANGE EVERY OTHER INVESTOR'S
 * ANSWER — the very thing "only for this investor" forbids. So the two-source
 * merge is left EXACTLY as it is, and AHL is grafted on afterwards. Every other
 * investor's row is byte-for-byte what it was before this module ran, which is a
 * property `test-lt-ahl-layer-pure.js` asserts rather than assumes.
 *
 * ── WHERE IT SITS IN THE PIPELINE, AND WHY THAT ORDER ──────────────────────
 *   1. ahl/client.priceScenario   → AHL's raw board
 *   2. vendor-margin.applyToBoard(board, 'ahl')  → the 0.25 holdback, ONCE
 *   3. THIS MODULE                → graft onto the merged board
 *   4. investor-routing.applyRouting → the settings decide what is SHOWN
 *
 * The holdback is taken at step 2 and NEVER here, for the same reason it is not
 * taken in the LoanNEX client: it belongs to the one module that takes it for
 * every vendor and that refuses to run twice on one board. This module REFUSES a
 * board that has not been through it (`marginHoldback` unset), because a
 * raw AHL board grafted straight on would show 0.25 of better execution than the
 * board is entitled to, and would do it silently.
 *
 * PURE: no network, no database, no RTL import.
 */

const investors = require('../encompass/investors');
const whiteLabel = require('../lenderprice/investor-programs');

/** The one investor this layer may ever place. */
const AHL_INVESTOR_KEY = 'american_heritage';
const SOURCE = 'ahl';

class AhlLayerError extends Error {
  constructor(code, message) { super(message); this.code = code; this.name = 'AhlLayerError'; }
}

/**
 * ⛔ The canonical key is RESOLVED, never assumed to exist.
 *
 * If somebody renames or removes the registry row, this must fail loudly at the
 * seam rather than quietly place an investor under a key nothing else knows —
 * which would put American Heritage on the board with no white-label name and no
 * settings row, i.e. with the real investor name showing.
 */
function resolveKey() {
  const row = investors.byKey && investors.byKey(AHL_INVESTOR_KEY);
  if (!row) {
    throw new AhlLayerError('investor_not_in_registry',
      `The investor registry has no "${AHL_INVESTOR_KEY}" row, so an AHL board cannot be placed on the merged board under a key the settings and the white-label sheet would recognise.`);
  }
  return { key: AHL_INVESTOR_KEY, label: row.label || 'American Heritage Lending' };
}

/** The best headline on a set of programs — the same rule `merge.bestOf` uses. */
function bestOf(programs) {
  let best = null;
  for (const p of programs || []) {
    for (const r of p.rungs || []) {
      if (!r || r.rate == null) continue;
      if (!best || r.rate < best.rate || (r.rate === best.rate && (r.price == null ? -Infinity : r.price) > (best.price == null ? -Infinity : best.price))) {
        best = { rate: r.rate, price: r.price, points: r.points, lockDays: r.lockDays, program: p.program || null, programCode: p.programCode || null };
      }
    }
  }
  return best;
}

/**
 * Graft AHL's board onto a merged board.
 *
 * @param merged  the output of `merge.merge` — NOT MUTATED.
 * @param ahlBoard AHL's parsed board, already through `vendor-margin.applyToBoard`.
 * @param opts    `{ error }` a reason AHL did not answer, carried rather than hidden.
 */
function applyAhlLayer(merged, ahlBoard, opts = {}) {
  const board = merged || {};
  const id = resolveKey();
  const error = opts.error || null;

  // A board that did not come back is REPORTED, not omitted. An investor set to
  // AHL whose source is down must be able to say so — `investor-routing` already
  // words that outcome, and it can only do it if the source is present here.
  const answered = !!(ahlBoard && Array.isArray(ahlBoard.programs));
  if (answered && ahlBoard.marginHoldback == null) {
    throw new AhlLayerError('holdback_not_applied',
      'This AHL board has not been through vendor-margin.applyToBoard, so the 0.25 margin holdback has not been taken. Grafting it on now would show 0.25 of better execution than the board is entitled to, silently. Apply the holdback first.');
  }

  // ⛔ ONLY AMERICAN HERITAGE. AHL's Quick Pricer prices AHL's own sheet, so
  // every row on it is theirs — but a row whose name does not resolve to this
  // one key is DROPPED to `unmapped` rather than placed, because the alternative
  // is this layer quietly writing some other investor's row.
  const mine = [];
  const foreign = [];
  for (const p of (answered ? ahlBoard.programs : [])) {
    const resolved = investors.resolve ? investors.resolve(p.investor || p.lender) : null;
    if (resolved && resolved.key && resolved.key !== id.key) { foreign.push({ source: SOURCE, name: p.investor || p.lender || null, program: p.program || null, product: p.product || null, suggestions: [] }); continue; }
    mine.push({ ...p, source: SOURCE });
  }
  // A program AHL returned but did not price is not a quote. It stays on the
  // board — its refusal reasons are the most useful thing on it — but it is not
  // counted as an offer, so `presentIn` cannot claim AHL quoted this investor on
  // the strength of four declines.
  const priced = mine.filter((p) => (p.rungCount || (p.rungs || []).length) > 0);

  const investorsOut = [];
  let placed = false;
  for (const e of board.investors || []) {
    if (e.key !== id.key) { investorsOut.push(e); continue; }
    investorsOut.push(withAhl(e, mine, priced, answered));
    placed = true;
  }
  if (!placed && (priced.length || answered)) {
    investorsOut.push(withAhl({
      key: id.key, investor: id.label, whiteLabel: whiteLabel.whiteLabelOf(id.key),
      joinedByGuess: false, joinedByLink: false,
      presentIn: [], chosen: null, electionBasis: null, reason: null, comparison: null,
      best: { lenderprice: null, loannex: null },
      programCounts: { lenderprice: 0, loannex: 0 },
      programs: { lenderprice: [], loannex: [] },
    }, mine, priced, answered));
  }

  // Same ordering rule the merge uses, so adding this layer never reshuffles the
  // board for reasons a reader cannot see.
  investorsOut.sort((a, b) => (b.presentIn.length - a.presentIn.length)
    || String(a.whiteLabel || a.investor || '').localeCompare(String(b.whiteLabel || b.investor || '')));

  const out = {
    ...board,
    sources: {
      ...(board.sources || {}),
      ahl: {
        answered,
        error: error ? String(error) : (answered ? null : 'no board'),
        programCount: priced.length,
        lenderCount: priced.length ? 1 : 0,
        // Provenance a reader genuinely needs: WHICH channel this was priced on,
        // and how much was held back. Both change the numbers.
        channel: answered ? (ahlBoard.channel || null) : null,
        marginHoldback: answered ? ahlBoard.marginHoldback : null,
        marginHoldbackOrigin: answered ? ahlBoard.marginHoldbackOrigin || null : null,
        marginHoldbackProblem: answered ? ahlBoard.marginHoldbackProblem || null : null,
        legsRequested: answered ? ahlBoard.legsRequested || null : null,
        legErrors: answered ? ahlBoard.legErrors || [] : [],
      },
    },
    investors: investorsOut,
    unmapped: [...(board.unmapped || []), ...foreign],
    summary: {
      ...(board.summary || {}),
      investorCount: investorsOut.length,
      ahlPrograms: priced.length,
    },
  };
  return out;
}

/** One investor entry, with AHL's programs added and nothing else touched. */
function withAhl(entry, mine, priced, answered) {
  const programs = { ...(entry.programs || {}), [SOURCE]: mine };
  const presentIn = [...(entry.presentIn || [])];
  if (priced.length && !presentIn.includes(SOURCE)) presentIn.push(SOURCE);
  return {
    ...entry,
    presentIn,
    programs,
    best: { ...(entry.best || {}), [SOURCE]: bestOf(priced) },
    programCounts: { ...(entry.programCounts || {}), [SOURCE]: priced.length },
    // ⛔ `chosen`, `electionBasis`, `comparison` and `reason` are UNTOUCHED. AHL
    // prices one counterparty and has nothing to be elected against; writing an
    // election here would state a judgement nobody made.
    ahl: answered ? { programCount: mine.length, pricedProgramCount: priced.length } : null,
  };
}

module.exports = { AHL_INVESTOR_KEY, SOURCE, AhlLayerError, applyAhlLayer, resolveKey, bestOf };
