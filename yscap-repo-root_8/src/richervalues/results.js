'use strict';
/**
 * Richer Values — READING THE FINISHED REPORT.
 *
 * PURE: no database, no network, no config. It takes their `retrieve-response`
 * payload and returns the two figures the whole product exists to produce — the
 * As-Is value and the After Repair Value — plus the supporting numbers a reviewer
 * wants to see beside them.
 *
 * WHY THIS IS ITS OWN MODULE. On every other appraisal vendor PILOT reads values
 * out of a MISMO XML through `lib/appraisal/extract.js`. This product HAS NO XML —
 * it is an evaluation, and its result is JSON. So this is the equivalent reader,
 * and it is held to the same standard as the As-Is reader (`lib/appraisal/as-is-reader.js`):
 *
 *   NEVER STORE A GUESS. Every figure goes through a validation rule and anything
 *   that fails it is left null with a stated reason, never rounded into a number
 *   that looks confident. A value we cannot read is reported as unreadable — that
 *   is an answer, and it sends a human to the PDF. A wrong one re-prices a loan.
 *
 * WHERE THE TWO NUMBERS LIVE, and why each is read the way it is:
 *
 *   AS-IS — `results.valuation_summary.estimated_as_is_value`, a display string
 *   like "$90,000". Their renovation-strategy grid ALSO carries an "As Is Value"
 *   row, and the two agree, so the grid is the fallback rather than the source:
 *   the summary is the report's own headline conclusion, and the grid row exists
 *   to sit under each strategy column.
 *
 *   ARV — the strategy grid's "ARV" row. THE GRID IS THE POINT OF THIS REPORT:
 *   it prices several renovation strategies side by side (minimum / partial /
 *   full) and names the one it recommends in a `best` column. So the ARV is taken
 *   from `best`, and `arvBasis` records that it came from there — an ARV with no
 *   provenance is a number nobody can defend to an investor. Each strategy is also
 *   returned in full, so the desk can show what the other exits would have been.
 *
 * THE ARV MUST BE ABOVE THE AS-IS. That is the same sanity the As-Is desk applies
 * before it writes either figure: at or below means the two are the wrong way
 * round or one is a misread, and a typo here re-prices the loan. Both figures are
 * still REPORTED when that happens — with `valuesUsable:false` and a reason — so a
 * human sees exactly what the vendor said and decides.
 */

// The same bounds the As-Is desk applies to a human-typed value. A residential
// value outside them is a misread (a per-square-foot figure, a doubled zero),
// not a property.
const MIN_VALUE = 1000;
const MAX_VALUE = 100000000;

/**
 * A money figure out of their JSON. They mix formats freely — "$164,700",
 * "164700.00", 99776 — so this accepts all three and REFUSES anything else
 * rather than letting `Number('')` become 0. A percentage or a duration ("16.30%",
 * "48") reaching here would be a caller error, which is why the strategy reader
 * below picks rows by TITLE rather than by position.
 */
function money(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (!s) return null;
  // A percentage or a multiplier is not money, however it is punctuated.
  if (/[%x]$/i.test(s)) return null;
  const cleaned = s.replace(/[$,\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** A value we are willing to put on a loan file. */
function plausibleValue(n) {
  return typeof n === 'number' && Number.isFinite(n) && n >= MIN_VALUE && n <= MAX_VALUE;
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[%,\s$]/g, ''));
  return Number.isFinite(n) ? n : null;
}

const text = (v) => {
  const s = v == null ? '' : String(v).trim();
  return s && s !== 'N/A' ? s : null;
};

/**
 * Find a row of their renovation-strategy grid by its title. Matched loosely on
 * purpose — "As Is Value", "As-Is Value" and "AS IS VALUE" are the same row, and
 * their grid is display data whose punctuation is not a contract — but ANCHORED,
 * so "Net Lift" can never be mistaken for the value row.
 */
function strategyRow(rows, title) {
  const want = String(title).toLowerCase().replace(/[^a-z]/g, '');
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r) continue;
    const t = String(r.title == null ? '' : r.title).toLowerCase().replace(/[^a-z]/g, '');
    if (t && t === want) return r;
  }
  return null;
}

/**
 * The strategy columns, in the order their report presents them. `best` is their
 * own recommendation and is deliberately FIRST in the preference order — this
 * report's whole job is to say which renovation strategy pays.
 */
const STRATEGY_COLUMNS = ['best', 'min', 'partial', 'full'];

/**
 * Read one response object (one property) into the shape PILOT stores.
 *
 * Returns:
 *   { orderToken, asIs, arv, arvBasis, valuesUsable, unusableReason,
 *     strategies, rehab, confidence, market, condition, commentary, address, specs }
 *
 * `asIs` / `arv` are numbers or null. `valuesUsable` is the ONE thing a caller
 * should gate an automatic write on: it is true only when both figures are
 * plausible AND the ARV is above the As-Is.
 */
function readResponse(resp) {
  const r = (resp && typeof resp === 'object') ? resp : {};
  const results = (r.results && typeof r.results === 'object') ? r.results : {};
  const summary = (results.valuation_summary && typeof results.valuation_summary === 'object') ? results.valuation_summary : {};
  const grid = Array.isArray(results.renovation_strategies) ? results.renovation_strategies : [];

  // ---- As-Is -------------------------------------------------------------
  let asIs = money(summary.estimated_as_is_value);
  let asIsFrom = asIs != null ? 'valuation_summary' : null;
  if (asIs == null) {
    const row = strategyRow(grid, 'As Is Value');
    for (const col of STRATEGY_COLUMNS) {
      const v = money(row && row[col]);
      if (v != null) { asIs = v; asIsFrom = `renovation_strategies.As Is Value.${col}`; break; }
    }
  }
  // The AVM/EPO product states its as-is value as a plain number instead. Read it
  // defensively so a response from that side of their API is never silently empty
  // — this desk does not order one, and one arriving is worth showing, not losing.
  if (asIs == null && money(results.as_is_value) != null) {
    asIs = money(results.as_is_value);
    asIsFrom = 'results.as_is_value';
  }

  // ---- ARV ---------------------------------------------------------------
  let arv = null;
  let arvBasis = null;
  const arvRow = strategyRow(grid, 'ARV');
  if (arvRow) {
    for (const col of STRATEGY_COLUMNS) {
      const v = money(arvRow[col]);
      if (v != null) { arv = v; arvBasis = col; break; }
    }
  }
  if (arv == null && results.ARV_results && typeof results.ARV_results === 'object') {
    // Again the AVM shape — {low, med, high}. `med` is its middle estimate.
    for (const col of ['med', 'high', 'low']) {
      const v = money(results.ARV_results[col]);
      if (v != null) { arv = v; arvBasis = `avm_${col}`; break; }
    }
  }

  // ---- can these be trusted onto a loan file? ----------------------------
  let valuesUsable = true;
  let unusableReason = null;
  if (asIs == null || arv == null) {
    valuesUsable = false;
    unusableReason = asIs == null && arv == null
      ? 'The report came back without an As-Is value or an ARV that PILOT could read.'
      : (asIs == null ? 'The report came back without an As-Is value PILOT could read.'
        : 'The report came back without an ARV PILOT could read.');
  } else if (!plausibleValue(asIs) || !plausibleValue(arv)) {
    valuesUsable = false;
    unusableReason = 'One of the values does not look like a property value, so PILOT has not put it on the file.';
  } else if (arv <= asIs) {
    // Never "fix" this by swapping them. Two figures the wrong way round mean one
    // of them was misread, and which one is not knowable from here.
    valuesUsable = false;
    unusableReason = 'The ARV is not above the As-Is value, which means one of the two was misread. Read the report and enter them by hand.';
  }

  // ---- everything else a reviewer wants beside the two numbers -----------
  const strategies = [];
  for (const row of grid) {
    if (!row || !text(row.title)) continue;
    strategies.push({
      title: text(row.title),
      min: row.min == null ? null : String(row.min),
      partial: row.partial == null ? null : String(row.partial),
      full: row.full == null ? null : String(row.full),
      best: row.best == null ? null : String(row.best),
    });
  }

  const rehabRow = strategyRow(grid, 'Rehab');
  const rehab = rehabRow ? {
    best: money(rehabRow.best), min: money(rehabRow.min),
    partial: money(rehabRow.partial), full: money(rehabRow.full),
  } : null;

  const cs = (r.confidence_score && typeof r.confidence_score === 'object') ? r.confidence_score : {};
  const mi = (r.market_information && typeof r.market_information === 'object') ? r.market_information : {};
  const sc = (r.subject_condition_rating && typeof r.subject_condition_rating === 'object') ? r.subject_condition_rating : {};
  const commentary = (results.commentary && typeof results.commentary === 'object') ? results.commentary : {};

  return {
    orderToken: text(r.order_token),
    asIs,
    asIsFrom,
    arv,
    // 'best' | 'min' | 'partial' | 'full' | 'avm_*' — which renovation strategy
    // the ARV describes. Stored so an ARV is never a number with no provenance.
    arvBasis,
    valuesUsable,
    unusableReason,
    currentCondition: text(summary.current_condition),
    strategies,
    rehab,
    confidence: {
      // Their own headline confidence, plus the two inputs their reference page
      // says it is built from. Percentages, kept as numbers.
      rvConfidence: num(cs.rv_confidence),
      fsdConfidence: num(cs.fsd_confidence_score),
      fsdScore: num(cs.fsd_score),
      dataQuality: num(cs.data_quality),
      applicabilityScore: num(cs.application_score),
      reliability: text(cs.reliabilityScore),
    },
    market: {
      areaType: text(mi.zip_code_category),
      demandScore: num(mi.demand_score),
      demandLevel: text(mi.demand_score_level),
      inventory: text(mi.inventory),
      medianDaysToSell: text(mi.medianTTS),
      remodeledShare: text(mi.remodeled),
    },
    condition: {
      overall: text(sc.overall_condition),
      kitchen: text(sc.kitchen),
      baths: text(sc.baths),
      interior: text(sc.interior),
      exterior: text(sc.exterior),
    },
    commentary: {
      market: text(commentary.market),
      subjectProperty: text(commentary.subject_property),
      budget: text(commentary.budget),
      valuation: text(commentary.valuation),
      recommendations: text(commentary.recommendations),
    },
    address: (r.property_address && typeof r.property_address === 'object') ? r.property_address : null,
    specs: (r.property_specs && typeof r.property_specs === 'object') ? r.property_specs : null,
    budgetLineItems: Array.isArray(results.budget_line_items) ? results.budget_line_items : [],
  };
}

/**
 * Read a whole `retrieve-response` envelope, optionally narrowed to one order
 * token. A single-property order returns one response, but their envelope is a
 * LIST because the same endpoint serves a batch — so picking by order token is
 * how a batch response could never put another property's value on this file.
 * With no token it falls back to the only response present; with several and no
 * token it refuses rather than choosing.
 */
function readEnvelope(envelope, orderToken) {
  const data = (envelope && envelope.data) || {};
  const list = Array.isArray(data.responses) ? data.responses : [];
  if (!list.length) return null;
  if (orderToken) {
    const hit = list.find((r) => r && String(r.order_token || '') === String(orderToken));
    if (hit) return readResponse(hit);
    // SEVERAL responses and none of them ours: this set is about other
    // properties, and reading one onto this file would put a stranger's value on
    // a loan. Refuse — a missing value sends a human to the report; a wrong one
    // re-prices the deal.
    if (list.length > 1) return null;
    // Exactly ONE response and its token does not echo ours. The request was
    // already scoped by intake token AND order token, so the response IS this
    // order's — but the mismatch is flagged rather than swallowed, because it
    // means either their echo changed or our stored token is stale, and both are
    // worth a human knowing about.
    const only = readResponse(list[0]);
    return { ...only, tokenMismatch: true };
  }
  if (list.length > 1) return null;
  return readResponse(list[0]);
}

/**
 * A plain-English line for the order card and the audit note — what the report
 * says, in the words a loan officer uses. Never invents a number it was not given.
 */
function summaryLine(read) {
  if (!read) return 'Richer Values has not sent the finished figures yet.';
  const fmt = (n) => (n == null ? null : '$' + Math.round(n).toLocaleString('en-US'));
  const asIs = fmt(read.asIs);
  const arv = fmt(read.arv);
  if (!asIs && !arv) return 'The report is in, but PILOT could not read a value out of it — open the PDF.';
  const parts = [];
  if (asIs) parts.push(`As-Is ${asIs}`);
  if (arv) parts.push(`ARV ${arv}${read.arvBasis && read.arvBasis !== 'best' ? ` (${read.arvBasis} strategy)` : ''}`);
  const head = `Richer Values: ${parts.join(' · ')}`;
  if (!read.valuesUsable && read.unusableReason) return `${head}. ${read.unusableReason}`;
  return head + '.';
}

module.exports = {
  readResponse, readEnvelope, summaryLine,
  MIN_VALUE, MAX_VALUE,
  _internals: { money, plausibleValue, strategyRow, STRATEGY_COLUMNS, num, text },
};
