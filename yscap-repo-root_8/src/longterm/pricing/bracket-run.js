'use strict';
/**
 * LONG-TERM — RUNNING A DSCR-BRACKET-AWARE SEARCH (owner-directed 2026-09-01).
 *
 * The orchestration half of `./bracket-board`: it decides which brackets to ask
 * about, asks, and hands the answers back to the pure board builder. Every rule
 * about what a bracket IS, what a ratio IS and which quotes may be shown lives
 * in that module — this one only sequences the calls.
 *
 * ⛔ THE VENDOR IS INJECTED, NEVER REQUIRED. `runSearch(dscr)` is supplied by the
 * caller, so the whole loop — the widening, the round cap, the concurrency, the
 * partial-failure reporting — is provable with no network and no credentials.
 *
 * ⛔ ONE SESSION, CONCURRENT SEARCHES, NO SECOND LOGIN. The owner asked whether
 * we should *"duplicate your agents to log in several times separately, because
 * it's not a real API, so you can't do a few requests."* We should not, and the
 * reason is written into the client this calls: it holds ONE shared service
 * login behind a single-flight lock, and *"the pricing call is stateless (each
 * search independent), so concurrent searches don't collide."* Extra logins
 * would buy nothing, and several sessions on one service account is exactly the
 * shape a vendor rate-limits or bumps. What this does instead is run a small
 * number of searches at a time — enough to keep it quick, few enough to stay
 * polite to a board that answers in seconds.
 */

const board = require('./bracket-board');

/** How many vendor searches are in flight at once. Small on purpose. */
const CONCURRENCY = Number(process.env.LP_BRACKET_CONCURRENCY || 3) || 3;

/**
 * Flatten a parsed board into the rows this feature reasons about. Everything
 * needed to classify a rate rides along; everything else is carried untouched so
 * the screen keeps whatever it already renders.
 */
function quotesFrom(parsed) {
  const programs = (parsed && Array.isArray(parsed.programs)) ? parsed.programs : [];
  const out = [];
  for (const p of programs) {
    for (const r of (Array.isArray(p.rungs) ? p.rungs : [])) {
      if (r == null || typeof r !== 'object') continue;
      out.push({
        lender: p.lender, investor: p.investor, program: p.program, product: p.product,
        investorKey: p.investorKey != null ? p.investorKey : null,
        whiteLabel: p.whiteLabel || null, consumerLabel: p.consumerLabel || null,
        rateGridId: p.rateGridId || null, sheet: p.rateSheetName || null,
        rate: r.rate, price: r.price, points: r.points, apr: r.apr,
        // The vendor's OWN monthly P&I. `ratioAtRate` prefers it, so the ratio a
        // row states and the payment beside it are one number.
        monthlyPi: r.monthly != null ? r.monthly : null,
        term: r.term, lockDays: r.lockDays,
        expired: !!r.expired, rateSheetValidAsOf: r.rateSheetValidAsOf || null,
      });
    }
  }
  return out;
}

/** Run `jobs` with a small bounded parallelism, keeping the input order. */
async function mapLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.max(1, Math.min(limit, items.length))).fill(null).map(async () => {
    for (;;) {
      const i = next; next += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * PRICE ONE DEAL ACROSS EVERY DSCR BRACKET IT CAN REACH.
 *
 * `runSearch(dscr)` must resolve `{ ok, parsed, ... }` and must never throw.
 *
 * ⛔ IT DISCOVERS RATHER THAN GUESSES A RANGE. The first search shows one board;
 * the brackets those rates reach are priced; whatever THOSE boards return is
 * classified in turn, and any bracket newly shown to be reachable is priced too.
 * It stops when a round adds nothing. This is what answers the owner's *"don't
 * go only by the rates that are coming up"*: an investor who prices only at a low
 * ratio cannot appear on a board asked at a high one, and would be invisible to
 * any single-search reading of the deal.
 *
 * ⛔ IT CONVERGES BY CONSTRUCTION. There are eleven brackets and a bracket leaves
 * the frontier the moment it is priced, so the loop can run at most eleven
 * searches whatever the board says. The round cap is a second belt.
 *
 * ⛔ A FAILED BRACKET IS NAMED, NEVER SWALLOWED. One bracket's search failing
 * must not throw away the ones that worked, and it must not be reported as a
 * bracket with no rates — "the vendor did not answer" and "this loan reaches no
 * rate here" are different facts and only one of them is about the loan.
 */
async function priceByBracket(figures, runSearch, opts = {}) {
  const f = board.readFigures(figures);
  if (!f) {
    return {
      ok: false, error: 'lt_bracket_figures_incomplete',
      message: 'A bracket board needs the rent, the property tax, the insurance, the loan amount '
        + 'and (unless it is interest-only) the term. Without them there is no ratio to bracket by.',
    };
  }
  const maxRounds = Number.isInteger(opts.rounds) && opts.rounds > 0 ? opts.rounds : board.MAX_ROUNDS;
  const concurrency = Number.isInteger(opts.concurrency) && opts.concurrency > 0 ? opts.concurrency : CONCURRENCY;

  const runs = [];
  const failures = [];
  const priced = new Set();

  /* ⛔ NO PROBE SEARCH. The officer has ALREADY pressed Search, so pricing the deal
     again just to find out which bands to ask about would spend a whole vendor call
     re-asking a question that was answered a moment ago — and on a screen the owner
     asked to feel as fast as it does now, that call is the one they would feel.

     The seed is the band the officer's OWN scenario sits in, which we already know
     from the ratio they typed or the calculator worked out. Everything else is found
     by walking outward from it: the frontier fills the bands between what has been
     seen and reaches one beyond each end, and it keeps reaching while the edges keep
     returning rates this loan can use. So the first round asks about the officer's
     own band and its two neighbours, and the board grows from there.

     A caller with a board already in hand may hand its rates over (`seenQuotes`),
     which sharpens the first round's search ratios; without them the first bands are
     searched at their own floors, which is the same figure by construction. */
  const seedTier = board.dscrTier(opts.seedDscr);
  let seenQuotes = Array.isArray(opts.seenQuotes) ? opts.seenQuotes : [];
  if (seedTier == null && !seenQuotes.length) {
    return {
      ok: false, error: 'lt_bracket_no_seed',
      message: 'A bracket board starts from the band this deal is in, so it needs either the '
        + 'ratio the search was run at or a board to read the rates off.',
    };
  }

  for (let round = 0; round < maxRounds; round += 1) {
    const frontier = board.bracketFrontier(f, seenQuotes, [...priced], { reach: 1, seedTier });
    if (!frontier.length) break;
    const plans = frontier
      .map((tier) => ({ tier, sentRatio: board.sendRatioFor(tier, f, seenQuotes) }))
      .filter((p) => p.sentRatio != null);
    // A bracket whose search ratio could not be placed is still marked priced, or
    // the frontier would offer it again every round and the loop would not drain.
    for (const tier of frontier) priced.add(tier);
    if (!plans.length) break;

    const results = await mapLimited(plans, concurrency, async (p) => {
      const r = await runSearch(p.sentRatio);
      return { plan: p, r };
    });
    let gained = 0;
    for (const { plan, r } of results) {
      if (!r || r.ok !== true) {
        failures.push({ tier: plan.tier, sentRatio: plan.sentRatio, error: (r && r.error) || 'lt_bracket_search_failed', message: (r && r.message) || null });
        continue;
      }
      const quotes = quotesFrom(r.parsed);
      runs.push({ tier: plan.tier, sentRatio: plan.sentRatio, quotes, meta: r.meta || null });
      // ⛔ ONLY A QUOTE THIS BAND CAN ACTUALLY USE COUNTS AS PROGRESS. A board
      // that answers every search with the same mid-range rates would otherwise
      // read as "still finding things" and widen to all eleven bands on every
      // deal. What earns another round is a rate that belongs where we asked.
      for (const q of quotes) if (board.selfConsistent(f, q, plan.tier)) { gained += 1; break; }
      seenQuotes = seenQuotes.concat(quotes);
    }
    if (!gained) break;
  }

  const built = board.buildBoard(f, runs);
  return {
    ok: true,
    figures: f,
    ...built,
    // Named so a reader can tell "we asked and this loan reaches nothing here"
    // from "we could not ask" — never one silence covering both.
    failedBrackets: failures,
    searchCount: runs.length,
    seedTier,
  };
}

module.exports = { priceByBracket, quotesFrom, mapLimited, CONCURRENCY };
