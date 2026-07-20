/**
 * Comp-grid split — a renovation appraisal supports TWO values off TWO separate comparable sets:
 *   • the ARV grid   (After-Repair Value / as-completed) — the value after the renovation
 *   • the As-Is grid (current condition) — the value before the renovation
 * Both sets live in ONE flat <COMPARABLE_SALE> list in the MISMO 2.6 XML with NO structured
 * attribute distinguishing them (verified across all 37 corpus files). Lumping them together
 * corrupts every value/bracketing check — an As-Is comp must never support the ARV and vice
 * versa. This module works out, per comp, which grid it belongs to, and it NEVER guesses.
 *
 * Precedence (strict, safety-first):
 *   1. NARRATIVE naming — the appraiser explicitly ties a comp list to a value role ("comps 4-6
 *      are used for the as-is value"). We require a real ROLE verb between the comp list and the
 *      value label, so an INCIDENTAL mention ("comparable 1 is the most similar") never binds.
 *      Named comps take their grid; the REMAINING comps are filled by price-proximity (below),
 *      never by a blind "the rest must be the other grid" flip.
 *   2. PRICE PROXIMITY — when both the As-Is and ARV anchor values are known and far enough
 *      apart, a comp whose RAW and ADJUSTED price BOTH cluster to the same side is assigned that
 *      side; if they disagree (e.g. carried-over adjustments) the comp is `unknown`.
 *   3. Otherwise the comp is `unknown` and a review flag is raised.
 * `unknown` always beats a wrong assignment.
 *
 * Pure + dependency-free. Returns { comps:[{...c, comp_set}], asIsValue, arvValue,
 *   confidence, needsReview, note }. confidence ∈ narrative | proximity | single_grid |
 *   undetermined.
 */

function num(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }

// ---- narrative naming ------------------------------------------------------
// A comp-number list anchored to a comp/comparable/sale keyword: "#4-6", "1, 2, and 3",
// "7, 8 & 9", "#4, #5, #6 and #7", "4 thru 6". Numbers are 1–2 digits (comp seqs are small).
// The connector between numbers allows a comma AND a word ("1, 2, and 3"), pure whitespace
// ("#1 #2 #3"), ampersand ("7 & 8"), or a dash/thru range ("4-6", "4 thru 6").
const ANCHOR = /(?:comp(?:arable)?s?\.?|sales?)\s*#?\s*(\d{1,2}(?:\s*[,&]?\s*(?:and|thru|through|to|[-–—])?\s*#?\d{1,2})*)/gi;
// The VALUE-ROLE label a comp list is tied to. Leading (?<![a-z]) so "as is" never matches inside
// "basis"/"gas is". A trailing optional "value" is common but not required (bracketed "[as-is]" /
// quoted "'As Repaired'" forms occur). Global — we scan for all labels in a text.
// The negative lookahead is critical: "as-is CONDITION" / "as-repaired QUALITY" describe a comp's
// physical state, NOT a value grid — binding a comp off a condition description is a false split.
const NOT_A_VALUE = '(?!\\s+(?:condition|quality|rating|appearance|nature|basis|standard|state|feature))';
const LABEL_ASIS = new RegExp('(?<![a-z])as[\\s\\-]*is\\b' + NOT_A_VALUE + '(?:\\s+(?:market\\s+)?value)?', 'gi');
const LABEL_ARV = new RegExp('(?<![a-z])(?:arv\\b|as[\\s\\-]*repair(?:ed)?|after[\\s\\-]*repair|as[\\s\\-]*complet(?:e|ed)?|subject[\\s\\-]*to|as[\\s\\-]*improv(?:ed)?|as[\\s\\-]*renovat(?:ed)?)' + NOT_A_VALUE + '(?:\\s+(?:market\\s+)?value)?', 'gi');
// A genuine grid-assignment reads "comps X ARE USED FOR / REFLECT / REPRESENT / SUPPORT the <value>"
// (or "<value> BASED ON comps X"). Requiring one of these role verbs between the comp list and the
// label is what separates a real grid naming from an incidental "comparable 1 is most similar".
const ROLE = /\b(?:used\s+(?:for|to\s+\w+)|developed\s+for|supportive\s+of|support(?:s|ing|ed|ive)?|reflect(?:s|ing|ed|ive)?|represent(?:s|ing|ed)?|indicat\w+|based\s+(?:up)?on|comparison\s+to|compared\s+to|utiliz\w+\s+(?:for|to)|are\s+for|is\s+for|are\s+the|assigned\s+to)\b/i;

// Expand a captured run ("4-6", "1, 2, and 3", "7 thru 9") into a Set of integers.
function expandNumberList(run) {
  const nums = new Set();
  let s = String(run || '')
    .replace(/#/g, ' ')
    .replace(/\b(?:thru|through|to)\b/gi, '-')
    .replace(/[–—]/g, '-');
  s = s.replace(/(\d{1,2})\s*-\s*(\d{1,2})/g, (m, a, b) => {
    a = +a; b = +b;
    if (b >= a && b - a <= 20) for (let i = a; i <= b; i++) nums.add(i);
    return ' ';
  });
  for (const m of s.matchAll(/\d{1,2}/g)) nums.add(+m[0]);
  return nums;
}

// Is `gap` (the text strictly between a comp list and a value label) a valid BINDING connector?
// It must be short, must not cross a sentence/clause boundary, must not contain another number,
// and must either contain a role verb OR be a near-adjacency ("are [", "= ", "is").
function bindable(gap) {
  if (gap.length > 55) return false;              // "are supportive of estimated market value in" ≈ 44
  if (/[.;:]/.test(gap)) return false;            // sentence/clause boundary — different statement
  if (/\d/.test(gap)) return false;               // another number between → not directly tied
  if (ROLE.test(gap)) return true;
  // tight adjacency: only a linking verb or nothing ("comps 4-6 ARE [as-is]", "value = comps").
  // Deliberately NOT a conjunction — " and " joins two clauses and must never bind a comp list
  // to the OTHER clause's label (that mislabels the whole grid).
  const core = gap.replace(/[\s\[\]()'"=,:-]/g, '').toLowerCase();
  return core === '' || core === 'are' || core === 'is' || core === 'were' || core === 'was';
}

// Collect every value-label match {start,end,side} in a text.
function labelSpans(t) {
  const out = [];
  for (const [re, side] of [[LABEL_ASIS, 'as_is'], [LABEL_ARV, 'arv']]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(t)) !== null) {
      out.push({ start: m.index, end: m.index + m[0].length, side });
      if (re.lastIndex === m.index) re.lastIndex++;
    }
  }
  return out;
}

// Parse every narrative text for comp-list → value-role bindings. Returns {asIs:Set, arv:Set}
// with any comp named on both sides dropped from both (contradiction).
function parseSplitNarrative(texts) {
  const asIs = new Set(), arv = new Set(), both = new Set();
  for (const t of texts || []) {
    const labels = labelSpans(t);
    if (!labels.length) continue;
    ANCHOR.lastIndex = 0;
    let m;
    while ((m = ANCHOR.exec(t)) !== null) {
      const cStart = m.index, cEnd = m.index + m[0].length;
      let bestSide = null, bestGap = Infinity;
      for (const L of labels) {
        let gap;
        if (L.end <= cStart) gap = t.slice(L.end, cStart);          // label ... comps
        else if (L.start >= cEnd) gap = t.slice(cEnd, L.start);     // comps ... label
        else continue;                                              // overlap
        if (gap.length < bestGap && bindable(gap)) { bestGap = gap.length; bestSide = L.side; }
      }
      if (bestSide) {
        for (const n of expandNumberList(m[1])) {
          if (bestSide === 'as_is') { if (arv.has(n)) both.add(n); asIs.add(n); }
          else { if (asIs.has(n)) both.add(n); arv.add(n); }
        }
      }
      if (ANCHOR.lastIndex === m.index) ANCHOR.lastIndex++;
    }
  }
  for (const n of both) { asIs.delete(n); arv.delete(n); }
  return { asIs, arv, contradicted: both };
}

// ---- price proximity -------------------------------------------------------
// Which anchor is a price nearer to? null in the dead-zone around the midpoint (never guessed).
function nearer(price, asIs, arv) {
  const p = num(price);
  if (p == null) return null;
  const mid = (asIs + arv) / 2;
  const deadband = Math.abs(arv - asIs) * 0.12;   // ~12% of the gap around the midpoint
  if (Math.abs(p - mid) <= deadband) return null;
  return p < mid ? 'as_is' : 'arv';
}
// Assign one comp by proximity: raw AND adjusted must BOTH resolve to the SAME side, else null.
function proximitySide(c, asIs, arv) {
  const aAdj = nearer(c.adjustedPrice, asIs, arv);
  const aRaw = nearer(c.salePrice, asIs, arv);
  return (aAdj && aRaw && aAdj === aRaw) ? aAdj : null;
}
// Does a side's comp cluster actually BRACKET its anchor value (anchor within the adjusted-price
// range, ±5%)? A real grid's comps straddle the value they support; a lonely comp that sits off to
// one side of the anchor is not a grid. Needs ≥2 comps to form a range.
function clusterBrackets(comps, anchor) {
  const adj = comps.map((c) => num(c.adjustedPrice)).filter((n) => n != null && n > 0);
  if (adj.length < 2 || !(anchor > 0)) return false;
  const lo = Math.min(...adj), hi = Math.max(...adj);
  return anchor >= lo * 0.95 && anchor <= hi * 1.05;
}
// Do the comps show a genuine two-cluster (some near As-Is, some near ARV) on raw OR adjusted price?
function bimodal(comps, asIs, arv) {
  const mid = (asIs + arv) / 2;
  let lo = 0, hi = 0;
  for (const c of comps) {
    for (const p of [num(c.adjustedPrice), num(c.salePrice)]) {
      if (p == null) continue;
      if (p < mid) lo++; else hi++;
    }
  }
  return lo > 0 && hi > 0;
}

/**
 * @param {{ basis:'ARV'|'ASIS', asIsValue:number|null, arvValue:number|null,
 *           texts:string[], comps:Array }} args
 */
function splitComps({ basis, asIsValue, arvValue, texts = [], comps = [] } = {}) {
  const out = comps.map((c) => Object.assign({}, c, { comp_set: null }));
  const result = { comps: out, asIsValue: num(asIsValue), arvValue: num(arvValue), confidence: null, needsReview: false, note: null };
  const seqSet = new Set(out.map((c) => parseInt(c.seq, 10)).filter(Number.isFinite));
  const isReno = basis === 'ARV';

  const asIsV = result.asIsValue, arvV = result.arvValue;
  const bothAnchors = asIsV != null && arvV != null && arvV > 0 && asIsV < arvV * 1.02;
  const gap = bothAnchors ? (arvV - asIsV) / arvV : null;
  const canProximity = bothAnchors && gap >= 0.08;

  const named = parseSplitNarrative(texts);
  const namedValid = ![...named.asIs, ...named.arv].some((n) => !seqSet.has(n)); // no stale seq
  const hasNaming = (named.asIs.size > 0 || named.arv.size > 0) && namedValid;

  // ---- Step 0: two-grid candidacy (only a reno/subject-to file can have two grids) ----
  const twoGridCandidate = isReno && (hasNaming || (canProximity && bimodal(out, asIsV, arvV)));

  if (!twoGridCandidate) {
    const set = isReno ? 'arv' : 'as_is';
    out.forEach((c) => { c.comp_set = set; });
    result.confidence = 'single_grid';
    result.note = isReno
      ? 'Single ARV grid — every comparable supports the after-repair value.'
      : 'Single As-Is grid — every comparable supports the as-is value.';
    return result;
  }

  // ---- Step 1: narrative naming (named comps authoritative) ----
  // Safe asymmetry (from the spec, derived across all 37 files): when the As-Is comps are
  // EXPLICITLY named, the remaining comps support the primary (ARV) value — assign them ARV. But
  // when ONLY the ARV comps are named, an unnamed comp is genuinely uncertain (it could be an
  // unlabeled As-Is comp) — resolve it by price if we can, else leave it `unknown`. We never
  // manufacture an As-Is comp from silence.
  if (hasNaming) {
    out.forEach((c) => {
      const n = parseInt(c.seq, 10);
      if (named.contradicted && named.contradicted.has(n)) c.comp_set = 'unknown';        // named on BOTH sides → never guess
      else if (named.asIs.has(n)) c.comp_set = 'as_is';
      else if (named.arv.has(n)) c.comp_set = 'arv';
      else if (named.asIs.size > 0) c.comp_set = 'arv';                                  // As-Is carved out → rest is ARV
      else c.comp_set = canProximity ? (proximitySide(c, asIsV, arvV) || 'unknown') : 'unknown';
    });
    const nAsIs = out.filter((c) => c.comp_set === 'as_is').length;
    const nArv = out.filter((c) => c.comp_set === 'arv').length;
    const nUnk = out.filter((c) => c.comp_set === 'unknown').length;
    // Accept the narrative split when it identified BOTH grids, OR when it confirmed one grid and
    // left the rest for review (a partial-but-honest result — never a wrong assignment). If it
    // collapsed to a single fully-known grid with no As-Is comp, that's just a single ARV grid.
    if ((nAsIs > 0 && nArv > 0) || nUnk > 0) {
      result.confidence = 'narrative';
      result.needsReview = nUnk > 0;
      result.note = 'Split from the appraiser’s narrative naming the As-Is vs After-Repair comparables.';
      return result;
    }
    // nAsIs === 0 && nUnk === 0 → every comp resolved to ARV → a single ARV grid.
    result.confidence = 'single_grid';
    result.note = 'Single ARV grid — every comparable supports the after-repair value.';
    return result;
  }

  // ---- Step 2: price proximity (needs both anchors + a real gap; raw & adjusted must agree) ----
  // A price spread is NOT proof of two grids — a single low ARV comp looks exactly like an As-Is
  // comp. So a proximity split is only ACCEPTED when it forms a real two-grid shape: EACH side has
  // ≥2 comps AND each cluster actually brackets its own anchor value. A lonely low comp (or a wide
  // single-grid spread) fails this and falls through to `undetermined` — never a phantom As-Is grid.
  if (canProximity) {
    let anyUnknown = false;
    out.forEach((c) => {
      const side = proximitySide(c, asIsV, arvV);
      c.comp_set = side || 'unknown';
      if (!side) anyUnknown = true;
    });
    const asIsComps = out.filter((c) => c.comp_set === 'as_is');
    const arvComps = out.filter((c) => c.comp_set === 'arv');
    const valid = asIsComps.length >= 2 && arvComps.length >= 2
      && clusterBrackets(asIsComps, asIsV) && clusterBrackets(arvComps, arvV);
    if (valid) {
      result.confidence = 'proximity';
      result.needsReview = anyUnknown;
      result.note = 'Split by clustering each comparable’s price to the As-Is vs ARV value (raw and adjusted must agree).';
      return result;
    }
    out.forEach((c) => { c.comp_set = null; });
  }

  // ---- Step 3: two-grid candidate but undetermined — never guess ----
  out.forEach((c) => { c.comp_set = 'unknown'; });
  result.confidence = 'undetermined';
  result.needsReview = true;
  result.note = 'Two-grid renovation appraisal but the As-Is/ARV comp split could not be determined from the data — verify the grids manually.';
  return result;
}

module.exports = { splitComps, _internals: { expandNumberList, parseSplitNarrative, labelSpans, bindable, nearer, proximitySide, bimodal } };
