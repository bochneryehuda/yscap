'use strict';
/**
 * LONG-TERM — ONE ITEMIZED BREAKDOWN, WHATEVER PRICED IT.
 *
 * Owner-directed 2026-08-30: *"Our pilot should lay out all the details the same
 * layout no matter if it comes from with software."*
 *
 * So the screen is handed ONE shape and never learns which rate sheet answered.
 * Everything a reader needs to see behind a price — the base, the itemized
 * adjustments, what the program checked, and whether it all adds up — is
 * assembled here, from an option in the common `quote-shape` form, and NOTHING
 * downstream re-derives any of it.
 *
 * THREE RULES THIS MODULE EXISTS TO HOLD:
 *
 *  1. ONE SIGN CONVENTION. Lender Price states an adjustment in POINTS (positive
 *     costs the borrower); LoanNEX states it in PRICE (positive is a BETTER
 *     price). Both arrive here already converted to points by their own mapper,
 *     and each line still carries the vendor's own number (`valueAsGiven` +
 *     `givenIn`) so an auditor can check the translation against the rate sheet
 *     rather than trust it. A "+0.25" must never mean opposite things on one
 *     screen.
 *
 *  2. THE SAME ROWS, IN THE SAME ORDER, WITH THE SAME KEYS. `LINE_KEYS` is the
 *     whole of a row. A vendor that does not state a field leaves it `null` —
 *     never an empty string, never a zero — because "no adjustment" and "we were
 *     not told" are different facts and only one of them is safe to show.
 *
 *  3. A MISSING BLOCK SAYS SO. A vendor that gives us no eligibility rows gets
 *     `provided: false` and a sentence, in the SAME position on the page where
 *     the other vendor's rows appear. A silently absent section reads as a clean
 *     bill of health nobody gave.
 *
 * PURE — no database, no network, no config. Everything is a function of the
 * option handed in, so every rule here is unit-testable.
 *
 * SEPARATION: LT-only. Imported by `src/longterm/**` and nothing else.
 */

const round3 = (n) => (n == null || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 1000) / 1000);
const numOrNull = (n) => (n == null || n === '' || !Number.isFinite(Number(n)) ? null : Number(n));
const strOrNull = (s) => {
  const t = s == null ? '' : String(s).trim();
  return t ? t : null;
};

/** Every key a breakdown row has, in the order the screen reads them. */
const LINE_KEYS = ['group', 'label', 'detail', 'kind', 'valueType', 'value', 'valueAsGiven', 'givenIn'];

/**
 * WHY THERE IS NO BREAKDOWN — one wording per reason, so two screens can never
 * describe the same silence two ways.
 *
 * `not_requested` is the ONLY one that means we never asked. Everything else is
 * something that happened after we did.
 */
const NO_BREAKDOWN = {
  not_requested: 'Nobody has asked this rate sheet to explain this price yet.',
  vendor_returned_no_evidence: 'The rate sheet accepted the question and returned no breakdown for this quote.',
  unrecognised_answer_shape: 'The rate sheet answered in a shape this system does not recognise, so nothing is shown rather than a guess.',
  no_answer: 'The rate sheet was asked and nothing came back.',
  evidence_is_for_a_different_rate_or_lock: 'The breakdown that came back is for a different rate or lock, so it is not shown against this one.',
  unknown: 'No breakdown could be read for this price.',
};

const ELIGIBILITY_ABSENT = 'This rate sheet does not publish the checks behind its answer, so there is nothing to list here.';

/** Points, as a signed string a reader can scan down a column. */
function pointsText(v) {
  if (v == null) return null;
  const n = round3(v);
  if (n === 0) return '0.000';
  return (n > 0 ? '+' : '') + n.toFixed(3);
}

/**
 * One row, with every key present.
 *
 * `kind` is the machine label (`Llpa`, `AddOn`, `CapAdjustment`) and `group` is
 * what a person reads. They are kept apart because a vendor that has only one of
 * them must not have it printed twice.
 */
function normaliseLine(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const givenIn = r.givenIn === 'price' ? 'price' : 'points';
  const value = round3(r.value);
  return {
    group: strOrNull(r.group),
    // Lender Price calls it `reason`, LoanNEX calls it `name`. One key here.
    label: strOrNull(r.label != null ? r.label : r.reason),
    detail: strOrNull(r.detail),
    kind: strOrNull(r.kind != null ? r.kind : (r.adjType || r.type)),
    valueType: 'points',
    value,
    // The vendor's own number, untranslated. Defaults to the same figure when
    // the vendor already spoke in points, so this column is never blank on one
    // source and filled on the other.
    valueAsGiven: r.valueAsGiven != null ? numOrNull(r.valueAsGiven) : value,
    givenIn,
  };
}

/** The itemized rows, ordered biggest cost first so the reason leads the list. */
function linesOf(option) {
  const raw = option && Array.isArray(option.adjustments) ? option.adjustments : null;
  if (!raw) return null;
  const out = raw.map(normaliseLine);
  out.sort((a, b) => {
    const av = a.value == null ? -Infinity : a.value;
    const bv = b.value == null ? -Infinity : b.value;
    if (bv !== av) return bv - av;
    return String(a.label || '').localeCompare(String(b.label || ''));
  });
  return out;
}

/**
 * WHAT THE PROGRAM CHECKED.
 *
 * The requirement is passed through in the vendor's OWN words and is never
 * re-rendered — a threshold on the screen is always the threshold the vendor
 * stated.
 */
function eligibilityOf(option) {
  const el = option && option.eligibility;
  if (!el || el.provided === false) {
    return { provided: false, message: ELIGIBILITY_ABSENT, screen: null, screenedAt: null, status: null, rows: [] };
  }
  const rows = (Array.isArray(el.criteria) ? el.criteria : []).map((c) => ({
    name: strOrNull(c && c.name),
    requirement: strOrNull(c && c.requirement),
    status: strOrNull(c && c.status),
  }));
  return {
    provided: true,
    message: null,
    screen: strOrNull(el.screen),
    screenedAt: strOrNull(el.screenedAt),
    status: strOrNull(el.status),
    rows,
  };
}

/**
 * The bottom-up price build, in the keys every vendor's mapper already fills.
 *
 * ONE DERIVATION, AND IT IS THE ENGINE'S OWN IDENTITY: price is 100 minus
 * points. Lender Price states the base in POINTS and LoanNEX states it in
 * PRICE, so without this one column is blank on one vendor and filled on the
 * other — the same row reading as missing data rather than the same fact said
 * two ways. It is only ever computed when the vendor did not state it, and
 * `baseDerived` says which way round it was worked out, so nothing here can be
 * mistaken for something a rate sheet published.
 */
function priceOf(option) {
  const pb = (option && option.priceBuild) || {};
  const statedPrice = numOrNull(pb.basePrice);
  const statedPoints = numOrNull(pb.basePoints);
  const basePrice = statedPrice != null ? statedPrice : (statedPoints == null ? null : round3(100 - statedPoints));
  const basePoints = statedPoints != null ? statedPoints : (statedPrice == null ? null : round3(100 - statedPrice));
  return {
    baseRate: numOrNull(pb.baseRate),
    noteRate: numOrNull(pb.noteRate),
    basePrice,
    basePoints,
    baseDerived: statedPrice == null && statedPoints != null ? 'price_from_points'
      : (statedPoints == null && statedPrice != null ? 'points_from_price' : null),
    adjustmentPoints: numOrNull(pb.adjustmentPoints),
    adjustedPoints: numOrNull(pb.adjustedPoints),
    price: numOrNull(pb.price),
    floor: numOrNull(pb.priceFloor),
    ceiling: numOrNull(pb.priceCeiling),
  };
}

/**
 * DOES IT ADD UP?
 *
 * Stated rather than asserted: the rows are summed here and compared to the
 * total the vendor gave, so a reader can see the arithmetic instead of trusting
 * it. A line with no value makes the sum UNKNOWN — quietly treating it as zero
 * would report a clean reconciliation over a hole.
 */
function totalsOf(lines, price) {
  if (!lines) return { count: null, linesPoints: null, statedPoints: null, reconciles: null, checked: false };
  let sum = 0;
  let complete = true;
  for (const l of lines) {
    if (l.value == null) { complete = false; continue; }
    sum += l.value;
  }
  const linesPoints = complete ? round3(sum) : null;
  const stated = price.adjustmentPoints;
  return {
    count: lines.length,
    linesPoints,
    statedPoints: stated,
    reconciles: linesPoints != null && stated != null ? Math.abs(linesPoints - stated) < 0.0005 : null,
    checked: linesPoints != null && stated != null,
  };
}

/**
 * THE FRESHNESS SIGNAL, HONESTLY.
 *
 * `expired: null` + `stalenessUnknown: true` is a real state and must never be
 * flattened to `false` — one vendor gives a verdict on its own sheet and the
 * other gives only a date, and reporting "not expired" for the second would be
 * a clean bill of health it never gave.
 */
function sheetOf(option) {
  const rs = (option && option.rateSheet) || {};
  const expired = rs.expired === true ? true : (rs.expired === false ? false : null);
  return {
    validAsOf: strOrNull(rs.validAsOf) || strOrNull(rs.rateValidDate),
    expired,
    stalenessUnknown: expired == null,
    name: strOrNull(rs.name),
  };
}

/**
 * The canonical breakdown for ONE option.
 *
 * `opts.reveal` is the admin's "where did this come from?" click, and it is the
 * ONLY thing that puts a vendor name in the answer — owner-directed: *"It should
 * sound like one system … the admin can go in and click to see the source of the
 * info."*
 */
function breakdown(option, opts = {}) {
  const reveal = opts.reveal === true;
  const o = option && typeof option === 'object' ? option : {};
  const ev = o.evidence || {};
  const lines = linesOf(o);
  const price = priceOf(o);

  let state = 'itemized';
  let message = null;
  if (!lines || !lines.length) {
    const reason = String(ev.reason || 'not_requested');
    // `inline_with_search` means the vendor shipped the itemization WITH the
    // quote, so an empty list there really does mean "no adjustments" — not a
    // question nobody asked.
    if (lines && reason === 'inline_with_search') {
      state = 'itemized';
    } else {
      state = NO_BREAKDOWN[reason] ? reason : 'unknown';
      message = strOrNull(ev.message) || NO_BREAKDOWN[state];
    }
  }

  return {
    // Never a vendor name unless an admin asked for one.
    source: reveal ? (strOrNull(o.source) || null) : null,
    available: state === 'itemized',
    state,
    message,
    price,
    lines: lines || [],
    totals: totalsOf(lines, price),
    sheet: sheetOf(o),
    eligibility: eligibilityOf(o),
    // Anything the program said out loud about this quote — a price cap, a soft
    // stop. Never invented: an absent list is an empty one.
    notices: Array.isArray(o.notices) ? o.notices.filter(Boolean).map(String) : [],
    // Stated for the screen so it never re-derives the arithmetic to render it.
    display: {
      lines: (lines || []).map((l) => ({ ...l, valueText: pointsText(l.value) })),
      adjustmentPointsText: pointsText(price.adjustmentPoints),
    },
  };
}

/** Every option on a board, laid out identically. */
function breakdowns(options, opts = {}) {
  return (Array.isArray(options) ? options : []).map((o) => breakdown(o, opts));
}

module.exports = {
  breakdown, breakdowns, LINE_KEYS, NO_BREAKDOWN, ELIGIBILITY_ABSENT,
  _internals: { normaliseLine, linesOf, eligibilityOf, priceOf, totalsOf, sheetOf, pointsText },
};
