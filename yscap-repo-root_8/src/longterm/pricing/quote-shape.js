'use strict';
/**
 * LONG-TERM — ONE quote shape for both pricing programs.
 *
 * ── THE OWNER'S ASK ────────────────────────────────────────────────────────
 * 2026-08-30: *"if you have a way to parse the LLPA's and the Points and
 * everything else and the disqualifying and all the details to lay it out on our
 * screen the same way that it's laid out from lender price. Everything should be
 * equal, laid out the same way… we shouldn't be a difference from where the data
 * is coming from."*
 *
 * So the screen must not be able to tell which vendor a row came from. Lender
 * Price's own `optionOf` is the shape the screen already reads; this module is
 * where LoanNEX is mapped INTO it, field for field, and where Lender Price's is
 * passed through. `source` is carried for provenance, never for layout.
 *
 * ── WHAT EACH VENDOR HANDS US, MEASURED ────────────────────────────────────
 *   Lender Price  one search → every option WITH its itemized LLPAs inline.
 *   LoanNEX       one search → every investor, every program, every rate, every
 *                 lock — but NO itemized LLPAs. Those come from a second call,
 *                 `/evidences`, one per quote.
 *
 * THE OWNER'S WORRY WAS THAT THE LADDER ALSO NEEDS A CALL PER PROGRAM. It does
 * not, and this was measured rather than reasoned: inside ONE recorded
 * transaction, the `/rate-stacks` answer for a program is the SAME ladder already
 * present in `quick-prices` — 102 of 102 (rate, lock) pairs identical to the
 * thousandth, delta 0.000 on every one. So the whole board, every rate and every
 * lock, is free from the single call we already make. What genuinely costs a
 * call is the LLPA ITEMIZATION, and only for a row somebody wants explained.
 *
 * ── SO A PRICE IS A THREE-LAYER THING, AND EACH LAYER SAYS WHERE IT CAME FROM ─
 *   1. board      — rate, price, points, lock, payment, DSCR. One call. Always.
 *   2. evidence   — basePrice + the named LLPA lines. One call per quote, on
 *                   demand, exactly as LoanNEX's own screen does it.
 *   3. never      — anything neither vendor states.
 * A row with no evidence yet carries `adjustments: null` — NULL, not `[]`. An
 * empty array reads as "this loan has no adjustments", which is a claim; null
 * reads as "nobody has asked yet", which is the truth.
 *
 * ── THE LLPA ARITHMETIC RECONCILES, EXACTLY ────────────────────────────────
 * Measured on a captured evidence: basePrice 100.948, adjustments −1.75 / 0.0 /
 * 0.375 / −0.5 / 0.25 / −0.5 summing to −0.75, final price 100.198 — and
 * 100.948 − 0.75 = 100.198 to the thousandth, matching the price the board
 * already showed for that rate and lock. `priceFloor` / `priceCeiling` bound the
 * result and DO bite: on one captured ladder the ceiling clipped every rate from
 * 7.25 up to a flat 103.75.
 *
 * ⚠️ NOT PROVEN, SO NOT ASSUMED: that an LLPA stack is the same at every rate on
 * one program. It is how rate sheets normally work, and every adjustment NAME in
 * the captures is a loan attribute rather than a rate. But no recording carries
 * two evidences for one program at two rates, so this module NEVER copies one
 * rate's itemization onto another rate. `evidenceCoversRate` states the rule in
 * one place so the day a capture proves it, one function changes.
 *
 * PURE: no network, no database, no RTL import.
 */

const round3 = (n) => (n == null || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 1000) / 1000);

/**
 * A loan term, in BOTH units, from whichever one the vendor stated.
 *
 * The only judgement here is refusing to guess: a term that is not a positive
 * finite number yields nulls rather than a 0 that would read as "no term". The
 * conversion itself is arithmetic, not a rule, so there is nothing to get wrong
 * — which is exactly why it belongs in one place rather than at each reader.
 */
function termPair(value, unit) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return { termMonths: null, termYears: null };
  if (unit === 'months') return { termMonths: Math.round(n), termYears: round3(n / 12) };
  return { termMonths: Math.round(n * 12), termYears: round3(n) };
}
const numOrNull = (n) => (n == null || n === '' || !Number.isFinite(Number(n)) ? null : Number(n));

/**
 * The empty option — every field the screen may read, so a template never has to
 * ask which vendor it is looking at.
 *
 * `null` throughout means NOT STATED. Nothing here defaults to zero: a zero
 * adjustment and an unknown adjustment are different facts and only one of them
 * is safe to show a borrower.
 */
function emptyOption() {
  return {
    source: null,
    lender: null, lenderId: null, investor: null, lenderShort: null, whiteLabel: null,
    program: null, programId: null, product: null, rateGridId: null, rateGridName: null,
    priceBuild: {
      parRate: null, baseRate: null, rateAdjustment: null, noteRate: null,
      basePoints: null, adjustmentPoints: null, adjustedPoints: null, borrowerPaidPoints: null,
      price: null, basePrice: null, priceFloor: null, priceCeiling: null,
      priceDerivedFromPoints: false, pointsDerivedFromPrice: false, apr: null, apor: null,
    },
    adjustments: null,       // null = not fetched. [] = fetched and there were none.
    rateAdjustments: null,
    // What the program CHECKED, and anything it said out loud about this quote.
    // null = this vendor did not tell us (which is a different fact from "it
    // checked nothing"), so the screen can say so rather than print an
    // encouraging blank.
    eligibility: null,
    notices: null,
    holdback: null,
    comp: null,
    fees: null,
    terms: {
      loanAmount: null, term: null, termInMonths: false,
      // ── THE SAME FIELD NAME MEANT TWO DIFFERENT THINGS ────────────────────
      // MEASURED by the combined audit, 2026-08-30: on one 30-year loan Lender
      // Price fills `term` with 30 and LoanNEX fills it with 360. Neither is
      // wrong — `termInMonths` says which, and both mappers set it correctly —
      // but a reader who takes `term` alone sees 30 against 360 for two
      // identical loans, and that is the exact "the meaning is not the same"
      // the owner asked to be rid of.
      //
      // So the UNITS ARE IN THE NAME. `termMonths` and `termYears` are derived
      // once, here, from whichever the vendor stated, and every consumer reads
      // one of them without having to know a flag exists. `term` and
      // `termInMonths` are untouched, so nothing that reads them today changes.
      termMonths: null, termYears: null,
      dayLock: null, cushionedLockDays: null,
      mortgageType: null, loanPurpose: null, interestOnly: null, interestOnlyTerm: null,
      amortizationType: null, dscr: null, fico: null, ltv: null, cltv: null, dti: null, hti: null,
    },
    monthlyPayment: null,
    flags: { disqualified: false, interpolated: false, expired: null, highBalance: false, isException: false, softStop: false },
    rateSheet: { expired: null, validAsOf: null, rateValidDate: null, name: null, id: null },
    // How to ask this vendor to explain THIS row.
    explain: null,
    evidence: { fetched: false, appliesToThisRate: false, reason: 'not_requested' },
  };
}

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) out[k] = deepMerge(base[k], v);
    else out[k] = v;
  }
  return out;
}

/**
 * LoanNEX board rows → the common option shape.
 *
 * One option per (investor, program, product, rate, LOCK). The lock is part of
 * the identity, not a footnote: LoanNEX quotes the same rate at 15/30/45/60 days
 * and the prices differ, so folding them together would let a 60-day quote be
 * read as a 30-day one.
 */
function optionsFromLoanNex(board, opts = {}) {
  const out = [];
  for (const p of (board && board.programs) || []) {
    for (const r of p.rungs || []) {
      const price = round3(r.price);
      out.push(deepMerge(emptyOption(), {
        source: 'loannex',
        lender: p.lender, lenderId: p.lenderId, investor: p.investor, whiteLabel: p.whiteLabel || null,
        program: p.program, programId: p.programId, product: p.product,
        priceBuild: {
          noteRate: round3(r.rate),
          price,
          // LoanNEX quotes PRICE; Lender Price quotes POINTS. `100 − price` is
          // the identity between them, and the flag says it was derived so a
          // reader never mistakes it for a number the vendor sent.
          adjustedPoints: price == null ? null : round3(100 - price),
          pointsDerivedFromPrice: price != null,
        },
        terms: {
          loanAmount: numOrNull(opts.loanAmount),
          dayLock: r.lockDays, cushionedLockDays: r.cushionedLockDays,
          interestOnly: p.isInterestOnly === undefined ? null : !!p.isInterestOnly,
          interestOnlyTerm: p.interestOnlyTerm == null ? null : p.interestOnlyTerm,
          amortizationType: p.amortizationType || null,
          term: p.termInMonths == null ? null : p.termInMonths, termInMonths: p.termInMonths != null,
          ...termPair(p.termInMonths, 'months'),
          dscr: numOrNull(r.dscr), fico: numOrNull(opts.fico),
          ltv: numOrNull(opts.ltv), loanPurpose: opts.loanPurpose || null,
        },
        monthlyPayment: r.payment == null ? null : { total: numOrNull(r.payment) },
        flags: {
          isException: !!r.isException,
          softStop: !!r.hasSoftStopViolation,
          // LOANNEX STATES NO STALENESS. Lender Price's own audit found 37–61%
          // of its board priced from EXPIRED sheets, which is why that flag
          // exists at all. LoanNEX says nothing on the subject, so this stays
          // null — "we do not know" — and never false, which would be a
          // reassurance nobody gave us.
          expired: null,
        },
        // What to hand the vendor to explain this exact quote. See `explainHandle`.
        explain: explainHandle(r, p, price, opts),
      }));
    }
  }
  return out;
}

/** Lender Price options → the common shape (its own `optionOf`, widened). */
function optionsFromLenderPrice(options) {
  return ((options) || []).map((o) => deepMerge(emptyOption(), {
    source: 'lenderprice',
    lender: o.lender, lenderId: o.lenderId, investor: o.investor, lenderShort: o.lenderShort, whiteLabel: o.whiteLabel || null,
    program: o.program, product: o.product, rateGridId: o.rateGridId, rateGridName: o.rateGridName,
    priceBuild: { ...(o.priceBuild || {}) },
    // Lender Price ships the itemization WITH the search, so these are fetched
    // by definition — an empty list here really does mean "no adjustments".
    adjustments: o.adjustments || [],
    rateAdjustments: o.rateAdjustments || [],
    holdback: o.holdback || null, comp: o.comp || null, fees: o.fees || null,
    terms: {
      ...(o.terms || {}),
      // Lender Price states the term in YEARS and carries its own flag for the
      // rare leaf that does not; the flag is honoured rather than assumed.
      ...termPair((o.terms || {}).term, (o.terms || {}).termInMonths ? 'months' : 'years'),
    },
    monthlyPayment: o.monthlyPayment || null,
    flags: { ...(o.flags || {}), expired: o.rateSheet ? !!o.rateSheet.expired : null },
    rateSheet: { ...(o.rateSheet || {}) },
    evidence: { fetched: true, appliesToThisRate: true, reason: 'inline_with_search' },
  }));
}

/**
 * Whether a fetched evidence may be attached to an option.
 *
 * THE WHOLE RULE, in one place. An evidence describes one program at ONE rate
 * and ONE lock, and this module refuses to spread it any further, because
 * whether an LLPA stack is constant across a program's rates has not been
 * proven from any recording. When a capture ever proves it, this function is the
 * only thing that changes.
 */
function evidenceCoversRate(ev, option) {
  if (!ev || !option) return false;
  const pb = option.priceBuild || {};
  const sameRate = round3(ev.rate) != null && round3(ev.rate) === round3(pb.noteRate);
  const sameLock = ev.lockPeriod == null || Number(ev.lockPeriod) === Number(option.terms && option.terms.dayLock);
  return !!(sameRate && sameLock);
}

/**
 * Fold a LoanNEX `/evidences` answer onto its option, giving it the same LLPA
 * detail a Lender Price row has had all along.
 *
 * REFUSES rather than approximates: an evidence for a different rate or lock
 * leaves the option exactly as it was, saying why.
 */
function attachEvidence(option, ev, opts = {}) {
  if (!option) return option;
  if (!ev) {
    // MEASURED LIVE 2026-08-30: one investor of four answers `Success` with no
    // body. `absence` carries WHICH silence this was, so the screen never says
    // "not requested" about a question we did ask.
    const ab = opts.absence || null;
    return deepMerge(option, {
      evidence: {
        fetched: !!ab, appliesToThisRate: false,
        reason: (ab && ab.reason) || 'not_requested',
        message: (ab && ab.message) || null,
      },
    });
  }
  if (!evidenceCoversRate(ev, option)) {
    return deepMerge(option, { evidence: { fetched: true, appliesToThisRate: false, reason: 'evidence_is_for_a_different_rate_or_lock' } });
  }

  /**
   * ONE SIGN CONVENTION, OR THE SAME "+0.25" MEANS OPPOSITE THINGS ON ONE SCREEN.
   *
   * Lender Price states an adjustment in POINTS (positive costs the borrower);
   * LoanNEX states it in PRICE (positive is a BETTER price, so it COSTS LESS).
   * The old mapping negated the TOTAL and left the LINES as the vendor gave
   * them, so a row read one way and the total underneath it read the other.
   *
   * `value` is now always points, the general engine's convention. The vendor's
   * own number is kept beside it as `valueAsGiven` + `givenIn`, so an auditor
   * can check this against the rate sheet without trusting the translation.
   */
  const toLine = (a, group, type) => ({
    group,
    reason: a.name || a.description || null,
    // The BUCKET the adjustment came out of — "FICO : 760 - 779, CLTV : 70.01% -
    // 75.00%". The name says which grid; only this says which CELL, and that is
    // the whole of "why is this price this price".
    detail: a.description || null,
    type: type || a.type || null,
    valueType: 'points',
    value: a.priceAdjustment == null ? null : round3(-Number(a.priceAdjustment)),
    valueAsGiven: numOrNull(a.priceAdjustment),
    givenIn: 'price',
  });

  const lines = (ev.adjustments || []).map((a) => toLine(a, a.type || 'LLPA', a.type || null));
  const addOns = (ev.addOns || []).map((a) => toLine(a, 'Add-on', 'AddOn'));
  const all = lines.concat(addOns);
  // Summed on the vendor's own numbers, then converted once — never by adding
  // up our own rounded translations, which would drift by a tenth of a point.
  const totalGiven = all.reduce((s, l) => s + (l.valueAsGiven || 0), 0);

  const el = ev.eligibility || null;
  return deepMerge(option, {
    priceBuild: {
      basePrice: numOrNull(ev.basePrice),
      baseRate: numOrNull(ev.baseRate),
      priceFloor: numOrNull(ev.priceFloor),
      priceCeiling: numOrNull(ev.priceCeiling),
      basePoints: ev.basePrice == null ? null : round3(100 - Number(ev.basePrice)),
      adjustmentPoints: all.length ? round3(-totalGiven) : null,
    },
    adjustments: all,
    rateSheet: { validAsOf: ev.rateSheetLastUpdated || null },
    eligibility: el ? {
      provided: true,
      screen: el.screen || null,
      screenedAt: el.screenedAt || null,
      status: el.status || null,
      isException: el.isException,
      criteria: el.criteria || [],
    } : null,
    notices: el && Array.isArray(el.notices) && el.notices.length ? el.notices.slice() : null,
    evidence: {
      fetched: true, appliesToThisRate: true, reason: 'evidences_call',
      // Stated so a reader can check the arithmetic rather than trust it.
      reconciles: ev.basePrice != null && ev.price != null
        ? Math.abs((Number(ev.basePrice) + totalGiven) - Number(ev.price)) < 0.0005 : null,
      adjustmentTotal: round3(totalGiven),
    },
  });
}

/**
 * INTEREST-ONLY is a PRODUCT here, not a question.
 *
 * Owner-directed 2026-08-30: *"The interest only button has a different way to
 * do it. It's just different programs, the way it looks on it."* Measured and
 * exactly right: across all 19 recorded pricing bodies LoanNEX takes no
 * interest-only input at all, while its answer carries
 * `mortgageProducts[].isInterestOnly`. Lender Price takes it as a search input.
 *
 * So one scenario reaches two vendors two different ways, and the boards must
 * still agree. Lender Price narrows at the source; LoanNEX is narrowed here.
 *
 * A ROW WHOSE PRODUCT DOES NOT SAY is never dropped and never kept blindly — it
 * is returned in `unknown` so the count on the screen can say "and 12 we cannot
 * classify" instead of quietly answering a question with the wrong number.
 */
function splitInterestOnly(options) {
  const io = [], amortizing = [], unknown = [];
  for (const o of options || []) {
    const v = o && o.terms ? o.terms.interestOnly : null;
    if (v === true) io.push(o); else if (v === false) amortizing.push(o); else unknown.push(o);
  }
  return { io, amortizing, unknown };
}

/**
 * Apply the scenario's interest-only answer to a set of options.
 *
 * ⛔ A ROW WHOSE PRODUCT DOES NOT SAY IS KEPT AND COUNTED, never dropped — the same rule the
 * programme-level narrowing (`product-filter.narrowBoard`) holds, and the rule the header above
 * has always stated. An earlier cut returned only the matching half and left `unknown` for the
 * count alone, so the moment the answer was resolved for every search (2026-09-02) a row nobody
 * could classify vanished from the option list with nothing on screen to say so. The unknown rows
 * ride at the END so the matched ones are still read first, and `unknown` still reports them.
 */
function filterInterestOnly(options, want) {
  if (want === undefined || want === null) return { options: options || [], filtered: false, unknown: [] };
  const s = splitInterestOnly(options);
  return { options: (want ? s.io : s.amortizing).concat(s.unknown), filtered: true, unknown: s.unknown };
}


/**
 * ONE BOARD, IN THE GENERAL PRICING ENGINE'S OWN SHAPE.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Owner-directed 2026-08-30: *"copy everything from the General Pricing Engine
 * and add this as it is… That should be jumping and going between Lender Price
 * and LoanNEX."* The Combined Pricing Engine's screen is a COPY of the general
 * one, so it reads a program exactly the way that screen does:
 *
 *     { lender, investor, program, product, investorKey, whiteLabel,
 *       options: [ { priceBuild: { noteRate, price, adjustedPoints },
 *                    monthlyPayment: { monthlyPI }, rateSheet: {...} } ] }
 *
 * A Lender Price program ALREADY is that. A LoanNEX program is a ladder of
 * `rungs`. `programsFromLoanNex` is the adapter, and it is here rather than in a
 * module of its own because this file is already the one place that answers
 * "shape one vendor's answer like the other's" — a second shaper is a second
 * place the two can disagree about what a price is.
 *
 * ── THE ONE THING THAT MAY NOT BE FLATTENED ────────────────────────────────
 * ⛔ `rateSheet.expired` STAYS NULL on a LoanNEX row. The general screen reads
 * `!!(o.rateSheet && o.rateSheet.expired)`, so a missing rate sheet renders as
 * "not expired" — a reassurance LoanNEX never gave us. Lender Price's own audit
 * found 37–61% of its board priced from expired sheets, which is why that flag
 * exists at all. So the option carries `stalenessUnknown: true`, and the copied
 * screen shows an em dash for it rather than a clean bill of health. Never
 * "simplify" that to `expired: false`.
 *
 * ⛔ AND `monthlyPI` IS THE VENDOR'S OWN PAYMENT, never re-derived. LoanNEX
 * returns a payment per rung; recomputing one here would put two different
 * numbers for one loan on two screens.
 */
/**
 * WHAT TO HAND THE VENDOR TO EXPLAIN THIS EXACT QUOTE.
 *
 * ⛔ `transactionId` AND `portal` ARE PART OF THE QUOTE'S IDENTITY, NOT DECORATION.
 *
 * LoanNEX scopes a priced quote to the SEARCH that produced it: `POST /loans/apps/{u}/quick-prices`
 * mints a transaction, and BOTH follow-up reads hang off it — `/loans/evidences/{u}/{txn}/fails`
 * (why each investor said no) and `/loans/evidences/{u}/{txn}` (this itemization). Their own web
 * app proves the intent: in the recorded HAR every explain call carries the SAME
 * `scenarioTestId` as the search and as the rate-stack URL. A `priceHashKey` is a handle INTO a
 * transaction, so asking under a fresh one is asking about a search the vendor has never seen.
 *
 * The portal rides for the same reason: an investor portal is a DIFFERENT session that returns a
 * different set of investors, so a quote found on one is not addressable on another.
 *
 * They ride ON THE ROW rather than in browser state so a handle can never be paired with a later
 * board's transaction — the commonest way a per-row fetch silently explains the wrong quote.
 */
const { EXPLAIN_LENDER_ID } = require('./investor-routing');

function explainHandle(r, p, price, opts = {}) {
  if (!r || !r.priceHashKey) return null;
  const h = {
    vendor: 'loannex',
    priceHashKey: r.priceHashKey,
    rate: round3(r.rate),
    price,
    lockDays: r.lockDays,
    productId: p.productId,
    // BOTH ids, on the ordinary board too. The vendor addresses a quote by product AND investor
    // (`loannex/client.evidence` → `{ productId, investorId }`), and `investor-routing.stripSource`
    // renames the investor id rather than dropping it precisely so this handle can still carry it
    // — see the note there. Without the fallback the default board asked for an itemisation of a
    // quote it never identified, which is why the panel came back empty (measured 2026-09-02).
    lenderId: p.lenderId != null ? p.lenderId : (p[EXPLAIN_LENDER_ID] != null ? p[EXPLAIN_LENDER_ID] : undefined),
  };
  if (h.lenderId === undefined) delete h.lenderId;
  // Omitted rather than sent as null: a null would read as "asked and there was none",
  // and the route falls back to the request body only when the key is genuinely absent.
  if (opts.transactionId != null) h.transactionId = opts.transactionId;
  if (opts.portal != null) h.portal = opts.portal;
  return h;
}

function programsFromLoanNex(board, opts = {}) {
  const out = [];
  for (const p of (board && board.programs) || []) {
    const options = [];
    for (const r of p.rungs || []) {
      const price = round3(r.price);
      options.push({
        priceBuild: {
          noteRate: round3(r.rate),
          price,
          // LoanNEX quotes PRICE, Lender Price quotes POINTS; `100 − price` is
          // the identity, flagged as derived so a reader never mistakes it for
          // something the vendor sent.
          adjustedPoints: price == null ? null : round3(100 - price),
          pointsDerivedFromPrice: price != null,
          basePoints: null, adjustmentPoints: null,
        },
        monthlyPayment: r.payment == null ? null : { monthlyPI: numOrNull(r.payment) },
        // NOT `{ expired: false }` — see the header.
        rateSheet: { expired: null, name: p.rateSheetName || null, validAsOf: null },
        stalenessUnknown: true,
        dayLock: r.lockDays == null ? null : r.lockDays,
        cushionedLockDays: r.cushionedLockDays == null ? null : r.cushionedLockDays,
        dscr: numOrNull(r.dscr),
        interestOnly: p.isInterestOnly === undefined ? null : !!p.isInterestOnly,
        /**
         * THE TERMS, UNDER THE KEY THE SCREEN READS. The Details panel draws `o.terms.term`,
         * `o.terms.interestOnly` and `o.terms.dayLock` (that is where every Lender Price option
         * carries them), and `splitInterestOnly` judges an option on `o.terms.interestOnly` — so a
         * LoanNEX board row, which stated all three only at the top level, drew an em dash for its
         * term, its amortization and its lock on the one panel whose job is to state them, and
         * could not be classified by the option-level interest-only filter at all. The vendor's own
         * published facts, restated where they are read; the top-level copies stay for anything
         * that reads them there.
         */
        terms: {
          dayLock: r.lockDays == null ? null : r.lockDays,
          cushionedLockDays: r.cushionedLockDays == null ? null : r.cushionedLockDays,
          interestOnly: p.isInterestOnly === undefined ? null : !!p.isInterestOnly,
          interestOnlyTerm: p.interestOnlyTerm == null ? null : p.interestOnlyTerm,
          amortizationType: p.amortizationType || null,
          term: p.termInMonths == null ? null : p.termInMonths, termInMonths: p.termInMonths != null,
          ...termPair(p.termInMonths, 'months'),
          dscr: numOrNull(r.dscr),
        },
        isException: !!r.isException,
        softStop: !!r.hasSoftStopViolation,
        explain: explainHandle(r, p, price, opts),
      });
    }
    const row = {
      lender: p.lender || null, investor: p.investor || null,
      program: p.program || null, product: p.product || null,
      investorKey: opts.investorKey != null ? opts.investorKey : null,
      whiteLabel: opts.whiteLabel || null,
      consumerLabel: opts.whiteLabel || null,
      rateGridId: p.programId == null ? null : String(p.programId),
      termInMonths: p.termInMonths == null ? null : p.termInMonths,
      amortizationType: p.amortizationType || null,
      isInterestOnly: p.isInterestOnly === undefined ? null : !!p.isInterestOnly,
      options,
    };
    if (opts.reveal) row.source = 'loannex';
    out.push(row);
  }
  return out;
}

/**
 * The whole board, in the general engine's shape — both vendors, one list.
 *
 * ⛔ ONE SYSTEM. Without `reveal` no row says which vendor produced it: the
 * Lender Price rows are copied with `source`, `lenderId` and the investor GUID
 * stripped, and the LoanNEX rows never gain one. That is the owner's rule —
 * *"it should sound like one system"* — and it is why this returns a NEW array
 * of NEW rows rather than the merged board's own objects.
 */
function programsForBoard(merged, opts = {}) {
  const reveal = opts.reveal === true;
  const rows = [];
  for (const e of (merged && merged.investors) || []) {
    for (const p of e.programs || []) {
      const base = { ...p, investorKey: e.key, whiteLabel: e.whiteLabel || null, consumerLabel: e.whiteLabel || null };
      if (!reveal) { delete base.source; delete base.lenderId; delete base.investorOrganizationGuid; }
      // A LoanNEX program carries `rungs`; a Lender Price one carries `options`.
      // Which it is decides how it is shaped, and NOT the row's `source`, which
      // the one-system view has already stripped by the time this runs.
      if (Array.isArray(p.rungs) && !Array.isArray(p.options)) {
        rows.push(...programsFromLoanNex({ programs: [p] }, {
          investorKey: e.key, whiteLabel: e.whiteLabel || null, reveal,
          // The SEARCH this row came out of — see `explainHandle`. Forwarded rather than
          // re-derived, so every row on one board names the one transaction that produced it.
          transactionId: opts.transactionId != null ? opts.transactionId : null,
          portal: opts.portal != null ? opts.portal : null,
        }));
      } else {
        rows.push(base);
      }
    }
  }
  return rows;
}

/**
 * The minimum option an EXPLAIN can be laid onto.
 *
 * A caller asking "why is this price this price?" holds one board rung (the
 * `explain` block on the row), not a whole option — but `attachEvidence` and the
 * breakdown both read the COMMON shape, so the rung is widened into one here
 * rather than at each call site. Only the fields the rate/lock guard and the
 * layout actually read are filled; everything else stays `null`, which is what
 * `emptyOption` already means by it.
 */
function handlePatch(quote = {}) {
  const q = quote || {};
  return {
    source: q.vendor || null,
    priceBuild: {
      noteRate: numOrNull(q.rate),
      price: numOrNull(q.price),
      adjustedPoints: q.price == null ? null : round3(100 - Number(q.price)),
    },
    terms: { dayLock: q.lockDays == null ? null : Number(q.lockDays) },
    explain: q.priceHashKey ? { ...q } : null,
  };
}

function optionForQuote(quote = {}) {
  return deepMerge(emptyOption(), handlePatch(quote));
}

/**
 * THE ROW THE SCREEN ALREADY HOLDS, MADE SAFE TO LAY AN EXPLANATION ONTO.
 *
 * â WHY THE BROWSER SENDS ITS ROW UP INSTEAD OF MERGING THE ANSWER DOWN. The explain door used
 * to answer with `optionForQuote(quote)` alone â an option built from the rung's HANDLE, which
 * carries a rate, a price and a lock and nothing else. The panel then drew that INSTEAD of the row
 * it already had, so the moment an explanation landed the loan amount, the term, the monthly
 * payment, the rate sheet and the DSCR all went blank; on a rate sheet that returned no itemization
 * the whole panel emptied out and said nothing. Merging in the browser would have fixed the symptom
 * and put a SECOND copy of `attachEvidence`'s merge rule in a second language â and the copy that
 * drifts is the one drawing the price somebody quotes. So the row comes here and there is still
 * exactly ONE merge.
 *
 * â WHAT A BROWSER MAY NOT CONTRIBUTE, and every removal has its own reason:
 *   â¢ `evidence` / `adjustments` / `eligibility` / `notices` and the whole base half of
 *     `priceBuild` are what this call is about to ESTABLISH. Left in, a stale copy from an earlier
 *     answer would survive a vendor that has since said nothing â the panel would print last
 *     week's itemization under today's silence, which is the one lie this door exists to prevent.
 *   â¢ `holdback` / `marginHoldback` / the `vendor*` anchors are OUR OWN margin's trail. It is
 *     stripped on the way out (`stripSource`, `stripExplainedTrail`); accepting it back from a
 *     browser would be a way to put it on the panel by asking for it.
 *   â¢ `source` / `lenderId` / `investorOrganizationGuid` name a vendor. The one-system rule is the
 *     RESPONSE's to apply, from the caller's own reveal, never the caller's to assert.
 *
 * Everything else â the names, the terms, the payment, the rate sheet, the flags â is the row's
 * own fact, already drawn on the board a moment ago, and rides through untouched.
 *
 * TOTAL: anything that is not a plain object, or is implausibly large for one option, returns null
 * and the caller falls back to the handle-built option, which is exactly today's behaviour.
 */
const ROW_MAX_BYTES = 64 * 1024;
function optionFromRow(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  let text;
  try { text = JSON.stringify(raw); } catch (_) { return null; }
  if (!text || text.length > ROW_MAX_BYTES) return null;
  const {
    evidence, adjustments, eligibility, notices,
    holdback, marginHoldback, source, lenderId, investorOrganizationGuid,
    priceBuild, rateSheet, ...rest
  } = raw;
  const out = { ...rest };
  if (priceBuild && typeof priceBuild === 'object' && !Array.isArray(priceBuild)) {
    const {
      basePrice, baseRate, priceFloor, priceCeiling, basePoints, adjustmentPoints,
      vendorPrice, vendorBasePoints, vendorAdjustedPoints, ...pb
    } = priceBuild;
    out.priceBuild = pb;
  }
  if (rateSheet && typeof rateSheet === 'object' && !Array.isArray(rateSheet)) {
    const { validAsOf, ...rs } = rateSheet;
    out.rateSheet = rs;
  }
  return out;
}

/**
 * The option an explain is laid onto: the caller's own row where it sent one, under the values the
 * HANDLE establishes.
 *
 * â THE SERVER'S OWN FIGURES ARE ON TOP, AND THAT ORDER IS THE GUARD. `evidenceCoversRate` judges
 * the vendor's answer against this option's rate and lock, so a browser able to move either could
 * make an evidence for one rate attach to another. `optionForQuote` is derived here, from the rung
 * handle, and wins every field it fills â the row contributes only what the handle does not carry.
 */
function optionForExplain(quote = {}, row) {
  const base = optionFromRow(row);
  if (!base) return optionForQuote(quote);
  // The empty shape FIRST, so every key the layout reads exists whatever the row was missing; then
  // the row's own facts; then the handle's four values, which is the only patch — never the whole
  // empty option, whose nulls would wipe the row it was just laid on.
  return deepMerge(deepMerge(emptyOption(), base), handlePatch(quote));
}

module.exports = {
  emptyOption, optionForQuote, optionFromRow, optionForExplain, optionsFromLoanNex, optionsFromLenderPrice,
  programsFromLoanNex, programsForBoard,
  attachEvidence, evidenceCoversRate, splitInterestOnly, filterInterestOnly,
  _internals: { round3, numOrNull, deepMerge },
};
