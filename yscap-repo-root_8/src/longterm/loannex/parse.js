'use strict';
/**
 * LONG-TERM — normalise a LoanNEX `quick-prices` answer into the Pricing
 * Engine's common program shape.
 *
 * WHAT LOANNEX RETURNS. One POST answers with FLAT arrays plus lookup tables:
 * `prices[]` (each row a rate for one investor/program/product, carrying its own
 * `lockTermPrices[]`), and `investors[]`, `programs[]`, `products[]`,
 * `mortgageProducts[]` to resolve the ids against. A recorded answer: 1,718
 * price rows across 9 investors and 14 programs, in 460 ms.
 *
 * WHAT THIS MODULE PRODUCES. The same `{ programCount, lenderCount, rungCount,
 * programs[{ lender, investor, program, product, rungs[] }] }` shape the Lender
 * Price parser produces, so the merge layer compares like with like and neither
 * vendor's field names leak into it. Every row is stamped `source: 'loannex'`.
 *
 * A LOCK PERIOD IS PART OF A PRICE, NOT A FOOTNOTE. LoanNEX quotes one rate at
 * several lock days (30/45/60) and the prices differ. Flattening them away would
 * make a 30-day quote look comparable to a 60-day one; so each lock day becomes
 * its OWN rung and carries `lockDays`, and the merge layer only ever compares
 * rungs at the same lock.
 *
 * POINTS ARE DERIVED AND SAID TO BE. LoanNEX quotes price; Lender Price quotes
 * points. `points = 100 - price` is the identity between them, computed here so
 * one board can show one column, and flagged `pointsDerived: true` so nobody
 * mistakes it for a vendor-supplied number.
 *
 * PURE: no network, no database, no RTL import.
 */

const round3 = (n) => (n == null ? null : Math.round(Number(n) * 1000) / 1000);
const pricePoints = require('../pricing/price-points');

function indexById(list, idKey = 'id') {
  const m = new Map();
  for (const x of list || []) { if (x && x[idKey] != null) m.set(Number(x[idKey]), x); }
  return m;
}

/**
 * @param raw the FULL quick-prices response (`{status, data, metadata}`) or its `data`.
 * @returns the common board shape.
 */
function parse(raw) {
  const data = raw && raw.data ? raw.data : raw;
  if (!data || !Array.isArray(data.prices)) {
    return { source: 'loannex', programCount: 0, lenderCount: 0, rungCount: 0, programs: [], notes: ['no_prices_in_answer'] };
  }
  const investors = indexById(data.investors);
  const programs = indexById(data.programs);
  const products = indexById(data.products);
  const mortgage = indexById(data.mortgageProducts);

  const byKey = new Map();
  for (const row of data.prices) {
    if (!row) continue;
    const inv = investors.get(Number(row.investorId));
    const prog = programs.get(Number(row.programId));
    const prod = products.get(Number(row.productId));
    const mp = prod ? mortgage.get(Number(prod.mortgageProductId)) : null;

    const investorName = (inv && inv.name) || null;
    const programName = (prog && prog.name) || null;
    const productName = (mp && mp.description) || null;
    const key = `${row.investorId}|${row.programId}|${row.productId}`;

    let p = byKey.get(key);
    if (!p) {
      p = {
        source: 'loannex',
        // LoanNEX carries ONE name per counterparty. Both fields are filled with
        // it so a consumer of the common shape need not know which vendor it came
        // from; the merge layer resolves identity from the canonical registry, not
        // from either of these strings.
        lender: investorName, investor: investorName, lenderId: inv ? Number(inv.id) : null,
        investorOrganizationGuid: (inv && inv.organizationGuid) || null,
        program: programName, programId: prog ? Number(prog.id) : null,
        programCode: (prog && prog.programCode) || null,
        product: productName, productId: prod ? Number(prod.id) : null,
        // LoanNEX has no separate "rate sheet" name — the program IS the sheet.
        // Left null rather than filled with the program name, so a reader can
        // never mistake a restated program for a second, corroborating fact.
        rateSheetName: null,
        amortizationType: (mp && mp.amortizationType) || null,
        termInMonths: mp && mp.termInMonths != null ? Number(mp.termInMonths) : null,
        isInterestOnly: !!(mp && mp.isInterestOnly),
        interestOnlyTerm: mp && mp.interestOnlyTerm != null ? Number(mp.interestOnlyTerm) : null,
        hasQuestions: !!(prog && prog.hasQuestions),
        questionsAnswered: !!(prog && prog.questionsAnswered),
        rungs: [],
      };
      byKey.set(key, p);
    }
    const rate = row.rate == null ? null : Number(row.rate);
    const locks = Array.isArray(row.lockTermPrices) ? row.lockTermPrices : [];
    for (const lt of locks) {
      if (!lt || lt.price == null) continue;
      const price = Number(lt.price);
      p.rungs.push({
        rate,
        price: round3(price),
        /**
         * ⛔ THE VENDOR'S OWN NUMBER, TO THE LAST DECIMAL — AND WHY IT CANNOT BE THE ROUNDED ONE.
         *
         * Measured live on 2026-09-03: LoanNEX finds a quote to itemise by matching the price we
         * send back against its own sheet EXACTLY. 269 of 4,396 rungs on one board carry a fourth
         * decimal (104.1762, 100.7605, 103.8855). Rounded to three for display and sent back that
         * way, the sheet found nothing and answered `{"status":"Success"}` with no body — and the
         * Details panel then said "the rate sheet accepted the question and returned no breakdown",
         * blaming the vendor for a price of our own making. Proven both ways on the same quote:
         * 104.1762 answered, 104.176 came back empty, everything else identical.
         *
         * So the rung carries BOTH. `price` is what a screen shows and what every comparison and
         * every holdback works on; `priceExact` is what goes back to the vendor when we ask it to
         * explain itself, and nothing else ever reads it.
         */
        priceExact: price,
        points: pricePoints.pointsFromPrice(price),
        pointsDerived: true,
        lockDays: lt.lockDays == null ? null : Number(lt.lockDays),
        cushionedLockDays: lt.cushionedLockDays == null ? null : Number(lt.cushionedLockDays),
        payment: row.payment == null ? null : Number(row.payment),
        dscr: row.dscr == null ? null : Number(row.dscr),
        priceHashKey: row.priceHashKey || null,
        isException: !!row.isException,
        hasSoftStopViolation: !!row.hasSoftStopViolation,
      });
    }
  }

  const out = [...byKey.values()];
  for (const p of out) {
    p.rungs.sort((a, b) => (a.rate - b.rate) || (a.lockDays - b.lockDays));
    p.rungCount = p.rungs.length;
    p.minRate = p.rungs.length ? p.rungs[0].rate : null;
    p.minPoints = p.rungs.reduce((m, r) => (r.points != null && (m == null || r.points < m) ? r.points : m), null);
    p.maxPrice = p.rungs.reduce((m, r) => (r.price != null && (m == null || r.price > m) ? r.price : m), null);
    p.lockDaysOffered = [...new Set(p.rungs.map((r) => r.lockDays).filter((d) => d != null))].sort((a, b) => a - b);
  }
  out.sort((a, b) => String(a.lender || '').localeCompare(String(b.lender || '')) || String(a.program || '').localeCompare(String(b.program || '')));

  return {
    source: 'loannex',
    programCount: out.length,
    lenderCount: new Set(out.map((p) => p.lender)).size,
    rungCount: out.reduce((n, p) => n + p.rungCount, 0),
    hasIneligiblePrograms: !!data.hasIneligiblePrograms,
    transactionId: data.transactionId || null,
    executionTimeMs: raw && raw.metadata && raw.metadata.executionTimeMs != null ? Number(raw.metadata.executionTimeMs) : null,
    programs: out,
  };
}

/**
 * Flatten the `/fails` tree into the same `{ lenders: [{ lender, items: [{ program, reasons }] }] }`
 * shape the Lender Price disqualify parser produces.
 *
 * LoanNEX states a failure as ATTRIBUTES WITH THRESHOLDS ("Ltv Fail, max 0.75"),
 * which is strictly more useful than a sentence, so the threshold is kept
 * alongside a rendered reason rather than replaced by it.
 */
function parseFails(raw) {
  const data = raw && raw.data ? raw.data : raw;
  const fails = (data && Array.isArray(data.fails)) ? data.fails : [];
  const lenders = fails.map((inv) => ({
    lender: (inv && inv.name) || null,
    lenderId: inv && inv.id != null ? Number(inv.id) : null,
    organizationGuid: (inv && inv.organizationGuid) || null,
    items: ((inv && inv.programs) || []).flatMap((prog) => ((prog && prog.screens) || []).map((screen) => {
      const failing = ((screen && screen.attributes) || []).filter((a) => a && a.status === 'Fail');
      return {
        program: (prog && prog.name) || null,
        screen: (screen && screen.name) || null,
        status: (screen && screen.status) || null,
        reasons: failing.map((a) => renderReason(a)),
        failingAttributes: failing.map((a) => ({
          type: a.type, status: a.status,
          min: a.min == null ? null : Number(a.min),
          max: a.max == null ? null : Number(a.max),
        })),
      };
    })),
  }));
  return {
    source: 'loannex',
    lenderCount: lenders.length,
    itemCount: lenders.reduce((n, l) => n + l.items.length, 0),
    transactionId: (data && data.scenarioTestId) || null,
    lenders,
  };
}

/** "LTV above this program's maximum of 75%" — the threshold, in words, never invented. */
function renderReason(a) {
  const t = String((a && a.type) || 'Criterion');
  const pct = /ltv|cltv|hcltv/i.test(t);
  const fmt = (n) => (n == null ? null : (pct && Math.abs(n) <= 1 ? `${round3(n * 100)}%` : String(round3(n))));
  const lo = fmt(a && a.min), hi = fmt(a && a.max);
  if (lo != null && hi != null) return `${t} outside this program's range ${lo}–${hi}`;
  if (hi != null) return `${t} above this program's maximum of ${hi}`;
  if (lo != null) return `${t} below this program's minimum of ${lo}`;
  return `${t} did not meet this program's requirement`;
}

/**
 * The LLPA breakdown behind one quote (`/evidences`), normalised.
 *
 * MEASURED LIVE 2026-08-30 against the real API, four investors, one scenario.
 * Three answered with a full breakdown that reconciles to the thousandth; the
 * fourth answered `{"status":"Success"}` with no `data` at all. See
 * `explainAbsence` — "the vendor answered and said nothing" is a different fact
 * from "we never asked", and the screen must not print the same words for both.
 *
 * TWO THINGS THIS USED TO THROW AWAY, both present in every live answer:
 *
 *   1. `description` — the BUCKET the adjustment was drawn from
 *      ("FICO : 760 - 779, CLTV : 70.01% - 75.00%"). The `name` alone
 *      ("FICO/CLTV") says which grid; only the description says which CELL.
 *      That is the whole of "why is this price this price".
 *   2. `eligibilityEvidence` — every criterion the program screened, with the
 *      requirement in the vendor's own words and a pass/fail on each.
 */
function parseEvidence(raw) {
  const data = raw && raw.data ? raw.data : raw;
  const ev = data && data.primary && data.primary.pending && data.primary.pending.evidence;
  if (!ev) return null;
  const pe = ev.pricingEvidence || {};
  const el = ev.eligibilityEvidence || {};
  const screen = el.screen || {};
  return {
    source: 'loannex',
    program: ev.programName || null,
    product: ev.mortgageProductDescription || null,
    rate: pe.rate == null ? null : Number(pe.rate),
    price: pe.price == null ? null : Number(pe.price),
    basePrice: pe.basePrice == null ? null : Number(pe.basePrice),
    baseRate: pe.baseRate == null ? null : Number(pe.baseRate),
    priceFloor: pe.priceFloor == null ? null : Number(pe.priceFloor),
    priceCeiling: pe.priceCeiling == null ? null : Number(pe.priceCeiling),
    isPriceRounded: pe.isPriceRounded == null ? null : !!pe.isPriceRounded,
    lockPeriod: ev.lockPeriod == null ? null : Number(ev.lockPeriod),
    // THE FRESHNESS SIGNAL the merge layer elects on — when this investor's sheet
    // was last published, straight from the vendor.
    rateSheetLastUpdated: ev.rateSheetLastUpdated || null,
    adjustments: (pe.adjustments || []).map((a) => ({
      type: a.type || null, name: a.name || null,
      // Kept, never merged into `name`: a reader needs the grid AND the cell.
      description: a.description || null,
      priceAdjustment: a.priceAdjustment == null ? null : Number(a.priceAdjustment),
    })),
    addOns: (pe.addOns || []).map((a) => ({ name: a.name || null, priceAdjustment: a.priceAdjustment == null ? null : Number(a.priceAdjustment) })),
    /**
     * WHAT THE PROGRAM CHECKED, and what it wanted. `criteriaDisplayText` is the
     * vendor's own wording of the requirement ("<= 80.00%", "$75,000 -
     * $1,000,000") and is passed through verbatim — never re-rendered, so a
     * threshold on the screen is always the threshold the vendor stated.
     */
    eligibility: {
      screen: screen.name || null,
      screenedAt: screen.lastScreened || null,
      status: screen.matchStatus || null,
      isException: screen.isException == null ? null : !!screen.isException,
      actual: el.actual || null,
      qualifying: el.qualifying || null,
      criteria: (screen.attributes || []).map((a) => ({
        name: (a && a.name) || null,
        requirement: (a && a.criteriaDisplayText) || null,
        status: (a && a.matchStatus) || null,
      })),
      // "Max Price for this loan is 100.00" — a cap the officer must see, and
      // the one thing on this answer that can contradict the quoted price.
      notices: Array.isArray(screen.softStopMessages) ? screen.softStopMessages.filter(Boolean) : [],
    },
    ltv: ev.loanToValue == null ? null : Number(ev.loanToValue),
    cltv: ev.combinedLoanToValue == null ? null : Number(ev.combinedLoanToValue),
    dscr: ev.dscr == null ? null : Number(ev.dscr),
    monthsReserves: ev.monthsReserves == null ? null : Number(ev.monthsReserves),
  };
}

/**
 * WHY there is no breakdown — never "we didn't ask" when we did ask.
 *
 * Measured live: one investor of four returns `{"status":"Success"}` and no
 * `data`. Answering that with `not_requested` would be a lie about our own
 * system, and answering it with an error would be a lie about the vendor's.
 */
function explainAbsence(raw) {
  if (raw == null) return { reason: 'no_answer', message: 'The rate sheet was asked and nothing came back.' };
  const data = raw && raw.data ? raw.data : null;
  if (!data || (typeof data === 'object' && !Object.keys(data).length)) {
    return {
      reason: 'vendor_returned_no_evidence',
      message: 'The rate sheet accepted the question and returned no breakdown for this quote.',
    };
  }
  if (!(data.primary && data.primary.pending && data.primary.pending.evidence)) {
    return {
      reason: 'unrecognised_answer_shape',
      message: 'The rate sheet answered in a shape this system does not recognise, so nothing is shown rather than a guess.',
    };
  }
  return { reason: 'unknown', message: 'No breakdown could be read from the answer.' };
}

module.exports = { parse, parseFails, parseEvidence, explainAbsence, _internals: { indexById, renderReason, round3 } };
