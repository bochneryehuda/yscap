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
const { validateScenario } = require('../lenderprice/search-model');
const nex = require('../loannex/client');
const ad = require('../admortgage/client');
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
const EMPTY_SPLIT = { lenderprice: [], loannex: [], admortgage: [] };

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

  const [lpRes, nxRes, adRes] = await Promise.allSettled([
    (async () => {
      const r = await lp.price(sc, opts.lenderprice || {});
      if (!r || r.ok === false) {
        const err = new Error(r && (r.message || r.error) ? `${r.error || 'lp_error'}: ${r.message || ''}`.trim() : 'lp_error');
        err.code = (r && r.error) || 'lp_error';
        throw err;
      }
      const parsed = lp.parse(r.raw);
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
      return { ...held, searchKey: r.searchKey || null, provenance: r.provenance || null };
    })(),
    nex.price(sc, opts.loannex || {}),
    /**
     * A&D (AIM), the third source. It prices A&D's OWN products only, so it
     * contributes exactly one investor — but it goes through the identical
     * merge, holdback and quote-shape path as the other two, because an
     * investor whose price came from a shortcut is an investor nobody can
     * compare.
     *
     * ⛔ IT MUST NOT TAKE THE BOARD DOWN. A&D refuses a scenario it cannot price
     * with a 400 that NAMES the field (its one genuine advantage over the other
     * two), and that is a normal answer, not a failure — so it resolves with an
     * empty board carrying the refusal rather than rejecting. Only a transport
     * or credential failure rejects.
     */
    ad.price(sc, opts.admortgage || {}),
  ]);

  const boards = {
    lenderprice: lpRes.status === 'fulfilled' ? lpRes.value : null,
    // THE MARGIN HOLDBACK GOES ON HERE — before the merge, the comparison, the
    // quote shape or the compensation overlay sees a single number. Lender
    // Price's feed already carries it and LoanNEX's does not, so this is what
    // puts the two on the same footing; applying it any later would have the
    // comparison electing on one set of numbers and the board showing another.
    loannex: nxRes.status === 'fulfilled' ? vendorMargin.applyToBoard(nxRes.value.board, 'loannex', { saved: heldSetting, extraFor }) : null,
    // SAME PLACE, SAME REASON as LoanNEX: AIM returns A&D's raw investor price
    // with none of our margin in it, so the 0.25 goes on HERE — before the
    // merge, the comparison or the quote shape sees a number.
    admortgage: adRes.status === 'fulfilled' ? vendorMargin.applyToBoard(adRes.value.board, 'admortgage', { saved: heldSetting, extraFor }) : null,
  };
  const errors = {
    lenderprice: lpRes.status === 'rejected' ? reasonOf(lpRes.reason) : null,
    loannex: nxRes.status === 'rejected' ? reasonOf(nxRes.reason) : null,
    admortgage: adRes.status === 'rejected' ? reasonOf(adRes.reason) : null,
  };
  // A&D's named refusal, carried through so the board can say WHICH FIELD to
  // change. Neither other vendor offers this, so it is surfaced rather than
  // flattened into "no programs".
  const admortgageRefusal = adRes.status === 'fulfilled' ? (adRes.value.refusal || null) : null;
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
    const io = sc.io;
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
      for (const src of mergeMod.SOURCES) {
        const progs = byS[src] || [];
        if (!progs.length) continue;
        const ctx = { loanAmount: sc.loan, fico: sc.fico, ltv: sc.ltv, cltv: sc.cltv, loanPurpose: sc.purpose };
        const built = src === 'loannex'
          ? quoteShape.optionsFromLoanNex({ programs: progs }, ctx)
          : src === 'admortgage'
            ? quoteShape.optionsFromAdMortgage({ programs: progs }, ctx)
            : quoteShape.optionsFromLenderPrice(progs);
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
  const programs = quoteShape.programsForBoard(merged, { reveal: opts.revealSource === true });

  return {
    merged,
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
      admortgage: namesOf(boards.admortgage),
    }, linked.raw),
    // A&D's own words for why a scenario did not price, when it gave them.
    admortgageRefusal,
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
    nex.evidence(scenarioOf(req), quote, { portal: b.portal, transactionId: b.transactionId })
      .then((r) => {
        // THE SAME LAYOUT, WHATEVER PRICED IT. The vendor's answer is folded onto
        // an option in the common shape and handed to the ONE breakdown builder,
        // so this door and a Lender Price row produce the same rows, in the same
        // order, with the same keys.
        const option = quoteShape.attachEvidence(
          quoteShape.optionForQuote(quote), r.evidence, { absence: r.absence },
        );
        const built = breakdown.breakdown(option, { reveal });
        res.json({
          ok: true,
          breakdown: built,
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
    nex.evidence(scenarioOf(req), quote, { portal: b.portal, transactionId: b.transactionId })
      .then((r) => res.json({ ok: true, ...r }))
      .catch((e) => res.status(isNotConfigured(e) ? 503 : 502)
        .json({ ok: false, error: e.code || 'loannex_evidence_error', message: reasonOf(e) }));
  });

  return router;
}

module.exports = { makeRouter, _internals: { enabled, isSuperAdmin, priceBoth, scenarioOf, reasonOf, routing, quoteShape, breakdown } };
