'use strict';
/**
 * WHY IS THIS PRICE THIS PRICE — ONE DOOR, MOUNTED BY BOTH ENGINES.
 *
 * ── WHY THIS FILE EXISTS (owner-directed 2026-09-03) ───────────────────────
 * *"All the hours and hours of testing that we put in to set up LoanNEX, we did on the
 * combined pricing engine over there. LoanNEX was perfect, including… pulling up the
 * itemization LLPA. I told you to copy it from here and bring in how it works."*
 *
 * The itemised LLPA breakdown was built, tested against the live rate sheet, and
 * mounted on ONE engine. The General Pricing Engine — the one the company actually
 * prices on — had no such door at all, so a LoanNEX row there could show a price and
 * never say what was in it.
 *
 * ⛔ THIS IS A MOVE, NOT A SECOND IMPLEMENTATION. Every line below came out of
 * `routes/combined-pricer.js` verbatim; that file now requires them back, so there is
 * exactly one definition of how a price is explained and both engines mount it — the
 * same arrangement `routes/investor-settings-routes.js` already has for the settings
 * doors. A second copy is how one engine comes to itemise a price differently from the
 * other, on the same quote, and the copy that drifts is the one somebody quotes from.
 *
 * ── THE ONE REAL ASYMMETRY, ANSWERED HERE RATHER THAN BY THE SCREEN ────────
 * Lender Price ships the itemization WITH the search, so a Lender Price row is already
 * explained and asking again would be a call that buys nothing. LoanNEX ships the ladder
 * and explains a row only when asked. So a row carrying a LoanNEX explain handle is
 * fetched and one that does not is told plainly that its breakdown already arrived with
 * the board — both through the SAME `breakdown` builder, so the reader is handed one
 * shape and never learns which programme answered.
 *
 * ── WHAT EACH ENGINE PASSES, AND WHY IT IS AN OPTION AT ALL ────────────────
 * `attach(router, { reveal })`. The combined engine is super-admin only and lets an
 * admin ASK where a row came from (`reveal: 'ask'` — the caller's own `revealSource`
 * decides). The general engine is ONE SYSTEM by the owner's own rule, so it passes
 * `reveal: false` and the vendor's trail can never be asked for there, whatever a
 * caller sends. Anything else is treated as false: a reveal must be granted, never
 * inherited from a value nobody recognised.
 *
 * PURE OF ENGINE: no board, no settings screen, no kill switch. It answers about ONE
 * quote the caller already holds.
 */

const nex = require('../loannex/client');
const routing = require('../pricing/investor-routing');
const investorConfig = require('../pricing/investor-config');
const quoteShape = require('../pricing/quote-shape');
const breakdown = require('../pricing/breakdown');
const nearTier = require('../pricing/near-tier');
const vendorMargin = require('../pricing/vendor-margin');
const roster = require('../pricing/investor-roster');
const sealedPrice = require('../pricing/sealed-price');
const { validateScenario } = require('../lenderprice/search-model');

/* The three settings reads the board itself makes, through the same module, so the
   panel and the board can never disagree about what was held back. */
const settingsRaw = () => investorConfig.investorsRaw();
const holdbackRaw = () => investorConfig.holdbackRaw();
const customRaw = () => investorConfig.customRaw();

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
 * THE QUOTE THE CALLER SENT, WITH THE VENDOR'S OWN PRICE UNSEALED — the ONE door on the way in.
 *
 * ⛔ WHY THERE IS A FUNCTION HERE AT ALL, rather than two `b.quote || b` reads. The browser holds
 * the row's `explain` handle and posts it straight back, and that handle carries the vendor's exact
 * price SEALED (`quote-shape.explainHandle` — in the clear the pair `priceExact − price` IS our
 * margin holdback, which the owner has directed must never be visible). Opening it is therefore a
 * step every explain door has to take, and a third door added later that forgets would not error —
 * it would quietly ask the sheet about a rounded price and get an empty breakdown back, which is
 * exactly the bug `priceExact` was added to fix, wearing a different face. One reader, no third way.
 *
 * ⛔ AN UNOPENABLE SEAL IS NOT AN ERROR. A restart mints a new key when `LT_PRICE_SEAL_KEY` is
 * unset, and a stale board in an open tab still posts yesterday's blob; a forged one fails its
 * authentication tag by construction. In every one of those the exact price is simply ABSENT, and
 * the door falls back to `vendorQuote`'s add-back — the path that was there before this field
 * existed and still answers correctly for every rung whose price needs no fourth decimal.
 *
 * ⛔ AND THE SEAL NEVER RIDES ON. It is deleted from the quote handed downstream, so nothing can
 * pass a blob to the vendor, print it, or log it.
 */
function quoteFromBody(b) {
  const raw = (b && b.quote) || b;
  if (!raw || typeof raw !== 'object') return raw;
  // Nothing to open and nothing to strip: the Lender Price rows and every internal caller.
  if (!('priceSeal' in raw)) return raw;
  // The key is present, so it goes — whatever it holds. A `priceSeal: undefined` is not a blob,
  // but leaving the key on the quote would make "the seal never rides on" a claim with an
  // exception in it, and an exception is what the next reader copies.
  const { priceSeal, ...rest } = raw;
  const exact = sealedPrice.isSealed(priceSeal) ? sealedPrice.open(priceSeal) : null;
  // ⛔ THE SEAL WINS. A caller may post a `priceExact` of its own beside it; the only price this
  // door believes is one it minted, so a forged figure is overwritten rather than trusted.
  if (exact != null) return { ...rest, priceExact: exact };
  // An unopenable seal leaves no exact price at all — never a forged one somebody sent with it.
  if ('priceExact' in rest) delete rest.priceExact;
  return rest;
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
 *
 * ⛔ THIS IS THE FALLBACK NOW, NOT THE MAIN ROUTE. A LoanNEX handle carries the sheet's own price
 * to the last decimal — sealed, opened by `quoteFromBody` above — and `loannex/client.evidence`
 * prefers it, because adding 0.25 back onto a figure already rounded to three decimals does NOT
 * reproduce a price with a fourth (104.1762 → 104.176 → 103.926 → 104.176), and the sheet matches
 * exactly.
 *
 * It still matters, and in three real cases rather than as decoration: a row shaped before that
 * field existed, a seal this process cannot open (a restart on an ephemeral key, a stale tab), and
 * every rung whose price needs no fourth decimal at all. `priceExact` rides through this function
 * untouched — it is the vendor's number and our margin is not on their sheet.
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
    // The investors added by hand, read the same way the board reads them — a
    // panel that did not know about them would answer "no setting" for one and
    // quietly shift its base by the board-wide figure instead.
    const custom = b.custom !== undefined ? roster.asCustom(b.custom) : (await customRaw()).custom;
    const row = routing.settingFor(key, routing.readSettings(saved.raw, custom).settings, custom);
    if (row && row.holdbackOrigin === 'setting') extra = row.holdback;
  }
  return vendorMargin.resolveHoldback('loannex', savedGlobal, extra);
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
    /* ⛔ THE FIELDS THAT DECIDE THE LLPA GRIDS, or this block cannot answer the one
       question it exists for.

       Owner-reported 2026-09-04: our board and the vendor's own screen disagreed by
       0.875 on a single "Purpose" line, and hours went into hunting an engine bug that
       was not there — our engine had been asked about a PURCHASE while the vendor's
       screen had been set to a CASH-OUT REFINANCE. The owner's verdict afterwards was
       *"That pricing was not an issue at all. It was perfect. The scenario was
       different."*

       This block already recorded the rate, the lock and the place — none of which
       moves an adjustment — so it could not have shown that even if it had been drawn.
       An adjustment grid is read on the PURPOSE, the credit score, the leverage, the
       occupancy, the property and the prepay term, so those are what a reader comparing
       two boards needs in front of them. Every one is a fact about the loan WE asked
       about; no vendor and no investor is named, and this surface is staff-only. */
    purpose: s.purpose || null,
    fico: s.fico == null ? null : Number(s.fico),
    ltv: s.ltv == null ? null : Number(s.ltv),
    occupancy: s.occupancy || null,
    propertyType: s.propertyType || null,
    prepayMonths: s.prepayMonths == null ? null : Number(s.prepayMonths),
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
 * MOUNT THE DOOR ON A ROUTER.
 *
 * `reveal: 'ask'` lets the CALLER decide (the combined engine's admin-only reveal);
 * anything else — including the general engine's explicit `false` — means the vendor's
 * own trail is never returned, whatever the request body says.
 */
function attach(router, opts = {}) {
  const askAllowed = opts.reveal === 'ask';
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
      const quote = quoteFromBody(b);
      // The engine decides whether a reveal may even be ASKED for — see `attach`.
      const reveal = askAllowed && b.revealSource === true;
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
  return router;
}

module.exports = {
  attach,
  // The helpers the combined router still uses at its OTHER doors. Required back from
  // here rather than kept as a second copy — see the header.
  stripExplainedTrail, searchIdentity, quoteFromBody, vendorQuote, holdbackOnRow,
  scenarioOf, explainScenario, scenarioRefused, askedOf, reasonOf, isNotConfigured,
  NOT_CONFIGURED,
};
