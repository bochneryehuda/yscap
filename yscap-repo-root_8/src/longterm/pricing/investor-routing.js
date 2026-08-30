'use strict';
/**
 * LONG-TERM — WHICH investors appear on the merged board, and WHOSE price we
 * show for each.
 *
 * ── THE OWNER'S TWO INSTRUCTIONS ───────────────────────────────────────────
 * 2026-08-30, on Button Finance: *"Don't display this investor. Ignore this
 * investor. Don't display their options."*
 *
 * 2026-08-30, on the shape of the whole thing: *"We just can add investors from
 * LoanX, then we can decide each and every investor from where we want to pull
 * the pricing and turn off that investor on Lender Price and turn it on for
 * LoanX."* (Lightly reworded: the product-separation gate reads the literal
 * phrase "from <word>" in a comment as a SQL FROM clause. The meaning is the
 * owner's; the preposition is not.)
 *
 * That second sentence changes the model, and it is worth being precise about
 * how. The merge layer MEASURES which program executes better for an investor;
 * this layer is where a HUMAN's decision about that investor is applied. Measure
 * and decide stay separate on purpose: an automatic election is a recommendation
 * a person can disagree with, and the routing is the record of what they chose.
 *
 * ── NOTHING SWITCHES ON ITS OWN ────────────────────────────────────────────
 * The default for every investor is `both` — the board reads exactly as it does
 * today until somebody sets a route. A silent change of which vendor a price
 * came from is the worst thing this file could do, so an unset investor is never
 * quietly routed by the election, however lopsided the measurement.
 *
 * ── SUPPRESSION IS BY NAME, BEFORE IDENTITY ────────────────────────────────
 * Button Finance resolves to NO canonical investor key (it is not in the
 * registry), so it reaches the board through the `unmapped` list rather than the
 * investor list. A suppression keyed on the canonical key would therefore have
 * missed it entirely. It is matched on the NORMALIZED NAME instead, and applied
 * to BOTH lists, so "don't display this investor" is true whichever road they
 * arrive by — today and if they are ever added to the registry.
 *
 * ⚠️ NO PRICE IS ADJUSTED HERE, AND THAT IS DELIBERATE. The owner's sentence
 * about Button Finance continues: *"The reason why it's 0.25 off is because they
 * have raw pricing, and our system needs to manually add a lender holdback of
 * 0.25 to every scenario to even it out."* Read one way that explains why they
 * are hidden; read another it is a separate instruction to apply a 0.25 holdback
 * more widely. A holdback moves what a borrower is quoted, so under the standing
 * rule it is not something to infer from a sentence that can be read two ways —
 * it is asked and waited for. Nothing here adds, subtracts or shades any price.
 *
 * PURE: no network, no database, no RTL import.
 */

const investors = require('../encompass/investors');

/** Loose name key — punctuation, case and corporate suffixes fall away. */
function nameKey(v) {
  return String(v == null ? '' : v)
    .toLowerCase()
    .replace(/\b(inc|llc|l\.l\.c|corp|corporation|co|ltd|lp|llp)\b/g, ' ')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Investors that never appear on the board, and why.
 *
 * A short, owner-directed list — NOT a general filter. Each entry records the
 * instruction that put it there, because "why can I not see this lender?" must
 * be answerable without archaeology.
 */
const SUPPRESSED = [
  {
    match: ['buttonfinance'],
    label: 'Button Finance',
    reason: 'Owner-directed 2026-08-30: do not display this investor or their options.',
  },
];

function suppressionFor(name) {
  const k = nameKey(name);
  if (!k) return null;
  return SUPPRESSED.find((s) => s.match.includes(k)) || null;
}

/** True when a board row belongs to a suppressed investor, whatever it is called. */
function isSuppressed(row) {
  const r = row || {};
  for (const n of [r.investor, r.lender, r.name, r.label]) { if (suppressionFor(n)) return true; }
  return false;
}

// ── The per-investor route ──────────────────────────────────────────────────
const ROUTES = ['both', 'lenderprice', 'loannex', 'off'];
const DEFAULT_ROUTE = 'both';

/**
 * THE THREE INVESTORS THE OWNER NAMED — owner-directed 2026-08-30:
 *
 *   *"There are three investors that are actually using LoanX for their locking,
 *   and it's much more accurate: NQM, ACRA and eResi. I'm just trying to take off
 *   these three investors so that our system should not display the results that
 *   they're seeing on Lender Price. It shouldn't populate these three investors
 *   out of Lender Price, and these three investors should be populated out of
 *   LoanX instead."* (Prepositions lightly reworded — the separation gate reads
 *   a literal "from <word>" in a comment as a SQL FROM clause. Nothing else in
 *   the instruction is changed.)
 *
 * The reason is the point: these three LOCK on LoanX, so LoanX is where their
 * real execution lives and Lender Price's copy of it is second-hand. This is not
 * a preference the comparison discovered — it is a fact about how those three
 * investors do business, which is exactly the kind of thing a measurement cannot
 * tell you and a person has to.
 *
 * NOTHING ELSE MOVES. Every other investor stays on `both`, and the Lender Price
 * pricer at `/api/lt/dscr/*` is untouched — the owner's *"not touch our own
 * pricing engine that we currently have"*.
 *
 * The environment still overrides any of these: a route set in
 * `LT_PRICING_ROUTES` wins, so a bad day at LoanX is one setting away from
 * putting an investor back on `both` without a deploy.
 */
const OWNER_ROUTES = {
  nqm: 'loannex',
  acra: 'loannex',
  eresi: 'loannex',
};

/**
 * Read the configured routes.
 *
 * TODAY: a JSON object in `LT_PRICING_ROUTES`, e.g.
 *   {"acra":"loannex","a_and_d":"lenderprice","pennymac":"off"}
 * keyed by the CANONICAL investor key (`encompass/investors.js`).
 *
 * WHY NOT A TABLE YET: the merged board is switched off and has never priced a
 * live loan, so committing a schema to it would be building the filing cabinet
 * before the first letter. The shape above is deliberately the shape a
 * `lt_pricing_investor_routes` row would have — one investor, one route, one
 * decided-by — so moving it into a table later is a reader change and not a
 * redesign. A malformed value is IGNORED WITH A NAMED COMPLAINT rather than
 * silently treated as a route, because a typo'd route that reads as `off` would
 * hide an investor nobody meant to hide.
 */
function readRoutes(raw) {
  const src = raw !== undefined ? raw : process.env.LT_PRICING_ROUTES;
  const out = { routes: {}, problems: [] };
  if (src == null || src === '') return out;
  let obj = src;
  if (typeof src === 'string') {
    try { obj = JSON.parse(src); }
    catch (e) { out.problems.push({ error: 'unparsable', message: 'LT_PRICING_ROUTES is not valid JSON, so no route was applied.' }); return out; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    out.problems.push({ error: 'not_an_object', message: 'LT_PRICING_ROUTES must be an object of investorKey -> route.' });
    return out;
  }
  for (const [key, value] of Object.entries(obj)) {
    const v = String(value == null ? '' : value).trim().toLowerCase();
    if (!ROUTES.includes(v)) { out.problems.push({ investor: key, error: 'unknown_route', value: String(value), message: `Route must be one of ${ROUTES.join(', ')}.` }); continue; }
    if (!investors.byKey || !investors.byKey(key)) out.problems.push({ investor: key, error: 'unknown_investor', message: 'No investor by that key — the route is kept, but nothing will match it.' });
    out.routes[key] = v;
  }
  return out;
}

/**
 * The route in force for one investor: an explicit setting first, then the
 * owner's three, then `both`.
 */
function routeFor(key, routes) {
  const r = routes && routes[key];
  if (ROUTES.includes(r)) return r;
  const owner = OWNER_ROUTES[key];
  return ROUTES.includes(owner) ? owner : DEFAULT_ROUTE;
}

/** Which sources a route lets through, given which answered. */
function sourcesUnder(route, presentIn) {
  const has = (s) => (presentIn || []).includes(s);
  if (route === 'off') return [];
  if (route === 'lenderprice') return has('lenderprice') ? ['lenderprice'] : [];
  if (route === 'loannex') return has('loannex') ? ['loannex'] : [];
  return [...(presentIn || [])];
}

/**
 * Apply suppression and routing to a merged board.
 *
 * WHAT IT NEVER DOES: change a number, re-order by preference, or drop a source
 * an investor is NOT routed away from. It hides, it narrows, and it SAYS SO —
 * every removal is reported in `hidden[]` with its reason, so a board that shows
 * six investors where the vendor priced nine can always explain the other three.
 *
 * A ROUTE THAT ASKS FOR A SOURCE THAT DID NOT ANSWER LEAVES THE INVESTOR EMPTY,
 * and that is the honest outcome rather than a silent fallback to the other
 * program: an officer who routed an investor to LoanX must not be shown Lender
 * Price's number under the belief it is LoanX's. It is reported as
 * `routed_source_absent` so the reason is on the screen.
 */
function applyRouting(merged, opts = {}) {
  const board = merged || {};
  const cfg = readRoutes(opts.routes);
  const routes = cfg.routes;
  const hidden = [];
  const list = [];

  for (const e of board.investors || []) {
    const sup = suppressionFor(e.investor) || suppressionFor(e.label) || suppressionFor(e.key);
    if (sup) { hidden.push({ investor: e.investor || sup.label, key: e.key || null, why: 'suppressed', reason: sup.reason }); continue; }
    const route = routeFor(e.key, routes);
    const shown = sourcesUnder(route, e.presentIn);
    if (route === 'off') { hidden.push({ investor: e.investor, key: e.key, why: 'route_off', reason: 'This investor is switched off for pricing.' }); continue; }
    if (!shown.length) {
      // "The program is down" and "the program is up and did not quote them" are
      // different problems for different people, and the wording says which.
      const src = board.sources && board.sources[route];
      const outage = src && src.answered === false;
      hidden.push({
        investor: e.investor, key: e.key, why: outage ? 'routed_source_did_not_answer' : 'routed_source_absent',
        reason: outage
          ? `Routed to ${label(route)}, which did not answer at all${src.error ? ` (${src.error})` : ''}. The other program's price is deliberately NOT shown in its place — this investor is priced there, so ours would be second-hand.`
          : `Routed to ${label(route)}, which answered but did not quote this investor for this scenario. The other program's price is deliberately NOT shown in its place.`,
      });
      continue;
    }
    const programs = {};
    for (const s of ['lenderprice', 'loannex']) programs[s] = shown.includes(s) ? (e.programs && e.programs[s]) || [] : [];
    list.push({
      ...e,
      route,
      // Three states, not two: a route somebody typed into the settings, the
      // owner's own standing instruction for these three investors, and nothing
      // at all. A screen that collapses the middle one into "default" cannot
      // explain why Lender Price's NQM row is missing.
      routeSource: Object.prototype.hasOwnProperty.call(routes, e.key) ? 'setting'
        : (OWNER_ROUTES[e.key] ? 'owner_directed' : 'default'),
      routeIsDefault: !Object.prototype.hasOwnProperty.call(routes, e.key) && !OWNER_ROUTES[e.key],
      shownFrom: shown,
      programs,
      best: { lenderprice: shown.includes('lenderprice') ? e.best && e.best.lenderprice : null, loannex: shown.includes('loannex') ? e.best && e.best.loannex : null },
    });
  }

  const unmapped = [];
  for (const u of board.unmapped || []) {
    const sup = suppressionFor(u.name);
    if (sup) { hidden.push({ investor: u.name, key: null, why: 'suppressed', reason: sup.reason, source: u.source }); continue; }
    unmapped.push(u);
  }

  // The summary must describe the board that is actually RETURNED. Carrying the
  // pre-routing counts through would print "9 investors" over a list of six and
  // leave nobody able to reconcile the two.
  const counts = (pred) => list.filter(pred).length;
  const summary = {
    ...(board.summary || {}),
    investorCount: list.length,
    inBoth: counts((x) => x.shownFrom.length === 2),
    lenderpriceOnly: counts((x) => x.shownFrom.length === 1 && x.shownFrom[0] === 'lenderprice'),
    loannexOnly: counts((x) => x.shownFrom.length === 1 && x.shownFrom[0] === 'loannex'),
    unmappedNames: new Set(unmapped.map((u) => u.name)).size,
    hiddenCount: hidden.length,
  };

  return {
    ...board,
    summary,
    investors: list,
    unmapped,
    hidden,
    routing: {
      applied: Object.keys(routes).length,
      routes,
      problems: cfg.problems,
      // Stated rather than implied: nothing was decided for the investors below.
      defaultRoute: DEFAULT_ROUTE,
      ownerDirected: { ...OWNER_ROUTES },
      note: 'NQM, Acra and eResi lock on LoanX, so they are priced there and NOT shown on Lender Price (owner-directed). Every other investor with no route set is shown from BOTH programs. Nothing is routed automatically by the comparison — the comparison is the recommendation, the route is the decision.',
    },
  };
}

function label(src) { return src === 'loannex' ? 'LoanX' : src === 'lenderprice' ? 'Lender Price' : src; }

module.exports = {
  SUPPRESSED, ROUTES, DEFAULT_ROUTE, OWNER_ROUTES,
  nameKey, suppressionFor, isSuppressed, readRoutes, routeFor, sourcesUnder, applyRouting,
  _internals: { label },
};
