/**
 * Appraisal XML → structured, validated data.
 *
 * Ports the field map + value engine proven against 37 real files (see
 * docs/appraisal-xml/*). Design contract: **never store a guess.** Every value goes through a
 * validation rule (docs/appraisal-xml/field-validation-rules.md); anything that fails is left
 * null and recorded in `warnings`, never coerced. The As-Is/ARV logic is the highest-risk part
 * and is deliberately conservative — As-Is is only "definite" when read cleanly, otherwise the
 * caller opens the officer condition.
 *
 * Pure + dependency-free. Input is the raw XML string. Output is a plain object.
 */
const X = require('./xml');
const { splitComps } = require('./comp-grid');

const CUR_YEAR = 2026; // NOTE: injected constant — the codebase forbids new Date() in date-only paths.

// ---- primitives -------------------------------------------------------------
function toNum(v) {
  if (v == null) return null;
  const s = String(v).replace(/[,$]/g, '').trim();
  if (s === '' || s === '--' || s === '.' || /^n\/?a$/i.test(s)) return null;
  const f = Number(s);
  return Number.isFinite(f) ? f : null;
}
// money must be a positive amount after comma-strip; reject meaningless 0 / decoys and an
// absurd magnitude (defensive: keeps a corrupt value from overflowing numeric(14,2) on insert).
function money(v) { const n = toNum(v); return n != null && n > 0 && n < 1e12 ? n : null; }
// Magnitude-bounded number for a narrower fixed-precision column — gla/pricePerGla are
// numeric(12,2) (max ~1e10) and grm is numeric(10,2) (max ~1e8). money()'s 1e12 ceiling would
// overflow those and sink the whole import on one corrupt field; bound to a sane ceiling instead.
function bounded(v, max) { const n = toNum(v); return n != null && n > 0 && n < max ? n : null; }
function clean(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === '' || s === '--' || /^(n\/?a|unknown|none|see addendum)$/i.test(s)) return null;
  return s;
}
function validYmd(y, mo, d) {
  const M = +mo, D = +d, Y = +y;
  return Y >= 1900 && Y <= CUR_YEAR + 1 && M >= 1 && M <= 12 && D >= 1 && D <= 31;
}
function normDate(v) {
  const s = clean(v);
  if (!s) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);            // ISO
  if (m) return validYmd(m[1], m[2], m[3]) ? `${m[1]}-${m[2]}-${m[3]}` : null;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);          // MM/DD/YYYY
  if (m) return validYmd(m[3], m[1], m[2]) ? `${m[3]}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}` : null;
  return null;
}
const UAD_C = /^C[1-6]$/, UAD_Q = /^Q[1-6]$/;
// UAD bathrooms are `full.half` (2.1 = 2 full + 1 half), NOT a decimal 2.5. Parse both forms.
function parseBaths(raw) {
  const s = clean(raw);
  if (!s) return { text: null, full: null, half: null };
  const m = /^(\d+)\.(\d)/.exec(s);
  if (m) return { text: s, full: +m[1], half: +m[2] };   // UAD full.half or decimal .0
  const n = /^(\d+)$/.exec(s);
  if (n) return { text: s, full: +n[1], half: 0 };
  return { text: s, full: null, half: null };
}

// ---- enrichment readers (never-guess; db/158) -------------------------------
// A MISMO Y/N indicator → strict boolean. Blank/other → null (NEVER default false — a missing
// flag is "unknown", not "no", and truthiness on a stray comment must never read as yes).
function yn(v) { const s = clean(v); if (!s) return null; if (/^y/i.test(s)) return true; if (/^n/i.test(s)) return false; return null; }
// Store a value ONLY if it exactly matches a known enum set — otherwise null (mirrors the UAD
// C1-6/Q1-6 discipline). Case-sensitive as MISMO emits, with a case-insensitive fallback match.
function enumOf(v, set) { const s = clean(v); if (!s) return null; if (set.includes(s)) return s; const hit = set.find((x) => x.toLowerCase() === s.toLowerCase()); return hit || null; }
// A neighborhood _HOUSING price is in $THOUSANDS (575 = $575,000). Convert to dollars with a
// magnitude guard so it can NEVER be confused with a full-dollar amount (a share of the corpus
// carries these; feeding one into money() would store $575 and mis-scale an ARV check 1000×).
function thousands(v) { const n = toNum(v); return n != null && n >= 1 && n <= 100000 ? Math.round(n * 1000) : null; }
// A percent/ratio cell that may carry a trailing '%' or an N/A placeholder. toNum('99%') is NaN,
// silently dropping a valid ratio — strip the '%' first.
function percent(v) { if (v == null) return null; const s = String(v).replace(/%/g, '').trim(); return toNum(s); }
// A small integer count (rooms, spaces, phases, units) — 0 is a VALID value here (unlike money()).
function count(v, max) { const n = toNum(v); return n != null && Number.isInteger(n) && n >= 0 && n <= max ? n : null; }
// A 1004MC market-grid cell. The cells are FULL DOLLARS ("452500" or "$829,500"), day/month
// counts ("98", "5.26"), or ratios ("103.00", "99%"); many are placeholders ("N/A", "-", "",
// "Unavailable"). Strip currency/percent formatting, reject the placeholders, keep a real 0.
function mcNum(v) {
  if (v == null) return null;
  const s = String(v).replace(/[$,%\s]/g, '').trim();
  if (!s || /^(n\/?a|na|-+|—+|unavailable|none|tbd)$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
// 1004MC metric → the attribute that carries its value, and the period tag → a short jsonb key.
const MC_METRICS = {
  TotalSales: '_Count', TotalListings: '_Count', MedianSalesDOM: '_Count', MedianListDOM: '_Count',
  Supply: '_Count', AbsorptionRate: '_Rate', MedianSalesToListRatio: '_Rate',
  MedianSalesPrice: '_Amount', MedianListPrice: '_Amount',
};
const MC_PERIODS = { Prior7To12Months: 'prior712', Prior4To6Months: 'prior46', Last3Months: 'last3' };
// A whole-years figure (age / economic life). 0 is valid ("effectively new"); reject the 999
// placeholder and anything out of a sane range.
function years(v, max) { const n = toNum(v); return n != null && n >= 0 && n <= max ? Math.round(n) : null; }
// Length-cap a narrative before it goes to a text column / the report (one verbose appraiser can
// carry 7KB in a single _AdditionalDescription — clamp so it can't bloat the row or the UI).
function capText(v, max) { const s = clean(v); if (!s) return null; return s.length > max ? s.slice(0, max).trim() + '…' : s; }
// A cleaner that ALSO rejects the placeholder phrases plain clean() misses in free-text site
// fields ("subject to survey", "see attached map/addendum") — never store those as real data.
function cleanField(v) { const s = clean(v); if (!s) return null; return /^(subject to survey|see attached(\s+(map|addendum))?)$/i.test(s) ? null : s; }
// A prior-sale amount that is a NOMINAL / non-arm's-length transfer ($1 quitclaim, intra-family).
// Returns true so callers can record the value but never let it drive a flip/appreciation calc.
function isNominal(amt) { const n = toNum(amt); return n != null && n <= 1000; }
// A geocoordinate bounded to ±lim; 0 rejected (a real US comp is never at 0,0).
function geo(v, lim) { const n = toNum(v); return n != null && n !== 0 && n >= -lim && n <= lim ? n : null; }

// ---- narrative sweep (for As-Is / hypothetical language) --------------------
const NARR_ATTR = /(comment|description|text|addendum|summary|reconcil|analysis)/i;
function narrativeTexts(root) {
  const out = [];
  (function walk(n) {
    for (const el of n.children) {
      for (const k in el.attrs) {
        if (k === 'SiteOtherImprovementsAsIsAmount') continue;    // cost-approach decoy — never As-Is
        const v = el.attrs[k];
        if (v && v.length >= 8 && (NARR_ATTR.test(k) || /\bas\b/i.test(v) || /repair/i.test(v))) out.push(v);
      }
      if (el.children.length) walk(el);
    }
  })(root);
  return out;
}
// Bound the comma-less run so a longer digit string is rejected, not truncated (audit #4).
const MONEY_RE = '\\$?\\s*(\\d{1,3}(?:,\\d{3})+|\\d{4,8}(?!\\d))(?:\\.\\d{2})?';
// Leading (?<![a-z]) so the token is a real word start — otherwise "as is" false-matches inside
// "basis"/"gas is" and "as complete" inside "gas complete", which could mine a FABRICATED value
// and store it as `definite` (a never-guess violation — audit MAJOR).
const ASIS_RE = new RegExp('(?<![a-z])as[\\s\\-]*is\\b(?:\\s*(?:value|market\\s*value|opinion|amount))?[^$\\d]{0,30}' + MONEY_RE, 'i');
const ARV_RE = new RegExp('(?<![a-z])(?:as[\\s\\-]*repaired|after[\\s\\-]*repair|as[\\s\\-]*complete[d]?|subject[\\s\\-]*to[\\s\\-]*completion)\\b(?:\\s*value)?[^$\\d]{0,30}' + MONEY_RE, 'i');
const HYPO_RE = /hypothetical condition.{0,80}(?:repair|budget|complet|renovat)|(?:repair|budget|renovat).{0,40}(?:have been |been )?complet/i;

function mineMoney(re, texts, ceil) {
  const hits = [];
  for (const t of texts) {
    const m = re.exec(t);
    if (m) { const val = toNum(m[1]); if (val != null && val >= 5000 && val <= 50000000) hits.push(val); }
  }
  if (!hits.length) return null;
  if (ceil) { const below = hits.filter((h) => h < ceil * 1.02); if (below.length) return below[0]; }
  return hits[0];
}

// ---- the value engine (ARV / As-Is) ----------------------------------------
function valuation(root) {
  const V = X.find(root, 'VALUATION');
  const structured = money(X.attr(V, 'PropertyAppraisedValueAmount'));
  const effDate = normDate(X.attr(V, 'AppraisalEffectiveDate'));
  const coa = X.find(root, '_CONDITION_OF_APPRAISAL');
  const cond = clean(X.attr(coa, '_Type'));
  const texts = narrativeTexts(root);
  const hasHypo = texts.some((t) => HYPO_RE.test(t));

  let basis, basisNote;
  // All three GSE "subject-to" conditions make the appraised value a conditional/as-completed
  // figure (not plain as-is). SubjectToInspection is a real spec enum — include it (audit/spec fix).
  if (cond === 'SubjectToRepairs' || cond === 'SubjectToCompletion' || cond === 'SubjectToInspection') { basis = 'ARV'; basisNote = `condition=${cond}`; }
  else if (cond === 'AsIs' && hasHypo) { basis = 'ARV'; basisNote = 'condition=AsIs but hypothetical-completion language → ARV'; }
  else if (cond === 'AsIs') { basis = 'ASIS'; basisNote = 'condition=AsIs'; }
  else { basis = hasHypo ? 'ARV' : 'ASIS'; basisNote = 'inferred'; }

  const out = { appraisedValue: structured, effectiveDate: effDate, conditionOfAppraisal: cond,
    basis, // 'ARV' | 'ASIS' — which value the structured PropertyAppraisedValueAmount represents
    arv: null, arvConfidence: 'missing', arvSource: null,
    asIs: null, asIsConfidence: 'missing', asIsSource: null };

  if (basis === 'ARV') {
    out.arv = structured; out.arvConfidence = structured ? 'definite' : 'missing'; out.arvSource = `structured (${basisNote})`;
    const a = mineMoney(ASIS_RE, texts, structured);
    if (a) { out.asIs = a; out.asIsConfidence = 'definite'; out.asIsSource = 'narrative (as-is text)'; }
    else { out.asIsSource = 'not definite — open officer condition'; }   // NEVER estimate-store
  } else {
    out.asIs = structured; out.asIsConfidence = structured ? 'definite' : 'missing'; out.asIsSource = `structured (${basisNote})`;
    const a = mineMoney(ARV_RE, texts, null);
    if (a) { out.arv = a; out.arvConfidence = 'definite'; out.arvSource = 'narrative (as-repaired text)'; }
    else { out.arvSource = 'as-is-only appraisal — no ARV (expected for a straight as-is report)'; }
  }
  // corroboration
  const sca = X.find(root, 'SALES_COMPARISON');
  out.valueSalesApproach = money(X.attr(sca, 'ValueIndicatedBySalesComparisonApproachAmount'));
  const cost = X.find(root, 'COST_ANALYSIS');
  out.valueCostApproach = money(X.attr(cost, 'ValueIndicatedByCostApproachAmount'));
  out.siteValue = money(X.attr(cost, 'SiteEstimatedValueAmount'));
  const inc = X.find(root, 'INCOME_ANALYSIS');
  out.valueIncomeApproach = money(X.attr(inc, 'ValueIndicatedByIncomeApproachAmount'));
  out.grm = bounded(X.attr(inc, 'GrossRentMultiplierFactor'), 1e6);
  const sc = X.find(root, 'SALES_CONTRACT');
  out.contractPrice = money(X.attr(sc, '_Amount'));
  out.contractDate = normDate(X.attr(sc, '_Date'));
  return out;
}

// ---- comps (exclude the seq-0 subject; count distinct seq≥1) ----------------
// Normalize a date to YYYY-MM-DD ('08/14/2009' or '2009-08-14'). Historical (no upper bound);
// never new Date(). Returns null if not a plausible calendar date.
function isoDate(v) {
  const s = clean(v); if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m && +m[1] >= 1 && +m[1] <= 12 && +m[2] >= 1 && +m[2] <= 31) return `${m[3]}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
  return null;
}
// A comp's DateOfSale → the SETTLED month as YYYY-MM-01. Two real forms:
//   * UAD abbreviated "s03/25;c07/25"  (s=settled MM/YY, c=contract MM/YY)
//   * a full calendar date "06/20/2025" (MM/DD/YYYY) — the settled date.
// The full-date form MUST be parsed FIRST: the loose MM/YY regex would otherwise read a
// MM/DD/YYYY date's DAY as the year (06/20/2025 → month 06, year 20 → 2020) — corrupting the
// sale year and firing false staleness findings (audit BLOCKER).
function settledMonth(desc) {
  const s = String(desc || '');
  let mo, yr;
  const full = /(\d{1,2})\/\d{1,2}\/(\d{4})(?!\d)/.exec(s);   // MM/DD/YYYY (settled)
  if (full) { mo = parseInt(full[1], 10); yr = parseInt(full[2], 10); }
  else {
    // Prefer the settled 's MM/YY'; else any MM/YY (contract-only) as a fallback.
    const m = /s\s*(\d{1,2})\/(\d{2,4})/i.exec(s) || /(\d{1,2})\/(\d{2,4})/.exec(s);
    if (!m) return null;
    mo = parseInt(m[1], 10); yr = parseInt(m[2], 10);
    if (yr < 100) yr = 2000 + yr;
  }
  if (mo < 1 || mo > 12 || yr < 2000 || yr > CUR_YEAR + 1) return null;
  return `${yr}-${String(mo).padStart(2, '0')}-01`;
}
// Comp-level grid data mined from a comp's SALE_PRICE_ADJUSTMENT rows + its COMPARISON_DETAIL.
function compGrid(c) {
  const out = { gla: null, saleDate: null, conditionUad: null, qualityUad: null, dom: null,
    beds: null, bathsFull: null, bathsHalf: null, baths: null, totalRooms: null,
    pricePerGla: bounded(X.attr(c, 'SalesPricePerGrossLivingAreaAmount'), 1e8), adjustments: [] };
  for (const spa of X.findAll(c, 'SALE_PRICE_ADJUSTMENT')) {
    const t = clean(X.attr(spa, '_Type'));
    // The "Other" adjustment's human label lives in _TypeOtherDescription, NOT _Description
    // (which is empty) — fall back so the breakdown never shows a bare "Other" with a dollar figure.
    let d = clean(X.attr(spa, '_Description'));
    if (t === 'Other' && !d) d = clean(X.attr(spa, '_TypeOtherDescription'));
    const amt = toNum(X.attr(spa, '_Amount'));
    if (t) out.adjustments.push({ type: t, description: d, amount: amt });
    if (t === 'GrossLivingArea' && d) { const g = toNum(d); if (g != null && g > 100 && g < 100000) out.gla = g; }
    else if (t === 'GrossBuildingArea' && d && out.gla == null) { const g = toNum(d); if (g != null && g > 100 && g < 100000) out.gla = g; }
    else if (t === 'DateOfSale' && d) out.saleDate = settledMonth(d);
    else if (t === 'Condition' && d && UAD_C.test(d)) out.conditionUad = d;
    else if (t === 'Quality' && d && UAD_Q.test(d)) out.qualityUad = d;
  }
  // ROOM_ADJUSTMENT carries the comp's room-count line (beds/baths/rooms) — the single most-missed
  // grid fact. On a multi-unit file it may repeat per unit; take the first (subject-comparison) row.
  const ra = X.find(c, 'ROOM_ADJUSTMENT');
  if (ra) {
    out.totalRooms = count(X.attr(ra, 'TotalRoomCount'), 99);
    out.beds = count(X.attr(ra, 'TotalBedroomCount'), 99);
    const b = parseBaths(X.attr(ra, 'TotalBathroomCount'));
    out.baths = b.text; out.bathsFull = b.full; out.bathsHalf = b.half;
    const raAmt = toNum(X.attr(ra, 'RoomAdjustmentAmount'));
    if (raAmt != null) out.adjustments.push({ type: 'RoomCount', description: null, amount: raAmt });
  }
  // OTHER_FEATURE_ADJUSTMENT — garage/fireplace/pool/attic/porch extras; a traditional grid shows
  // every adjustment line, and net_adjustment won't reconcile without these.
  for (const of of X.findAll(c, 'OTHER_FEATURE_ADJUSTMENT')) {
    const d = clean(X.attr(of, 'PropertyFeatureDescription'));
    const amt = toNum(X.attr(of, 'PropertyFeatureAdjustmentAmount'));
    if (d || amt != null) out.adjustments.push({ type: 'OtherFeature', description: d, amount: amt });
  }
  const cd = X.find(c, 'COMPARISON_DETAIL');
  if (cd) {
    if (!out.conditionUad) { const cc = clean(X.attr(cd, 'GSEOverallConditionType')); if (cc && UAD_C.test(cc)) out.conditionUad = cc; }
    if (!out.qualityUad) { const qq = clean(X.attr(cd, 'GSEQualityOfConstructionRatingType')); if (qq && UAD_Q.test(qq)) out.qualityUad = qq; }
    const dom = toNum(X.attr(cd, 'GSEDaysOnMarketDescription')); if (dom != null && dom >= 0 && dom < 3000) out.dom = dom;
  }
  return out;
}
// Parse "New Haven, CT 06519" (a comp's PropertyStreetAddress2) → {city,state,zip}. Fallback for
// the ~1/3 of files that omit the separate PropertyCity/State/PostalCode attrs. Never guessed —
// only a clean "City, ST ZIP" match yields values.
function splitCityLine(v) {
  const s = clean(v); if (!s) return {};
  const m = /^(.+?),\s*([A-Za-z]{2})\s+(\d{5})(?:-\d{4})?\s*$/.exec(s);
  return m ? { city: clean(m[1]), state: upState(m[2]), zip: zip(m[3]) } : {};
}

// A comp's sale status from its data-source text. Returns 'active' / 'pending' when the source
// EXPLICITLY marks a listing (MLS ACTIVE, pending, under contract, expired, for sale) — else
// 'closed' (a settled sale, the default the appraiser lists). Never guessed: only an explicit
// listing marker demotes a comp out of the closed pool.
function saleStatus(c) {
  const t = ((clean(X.attr(c, 'DataSourceDescription')) || '') + ' ' + (clean(X.attr(c, 'DataSourceVerificationDescription')) || '')).toLowerCase();
  if (/\b(active|for\s*sale|listing|expired|withdrawn|cancell?ed)\b/.test(t)) return 'active';
  if (/\b(pending|under\s*contract|u\/c|contingent)\b/.test(t)) return 'pending';
  return 'closed';
}

function comparables(root) {
  const all = X.findAll(root, 'COMPARABLE_SALE');
  const subject0 = all.find((c) => X.attr(c, 'PropertySequenceIdentifier') === '0') || null;
  const comps = [];
  const seen = new Set();
  for (const c of all) {
    const seq = X.attr(c, 'PropertySequenceIdentifier');
    if (seq === '0' || seq == null || seen.has(seq)) continue;
    seen.add(seq);
    const loc = X.find(c, 'LOCATION');
    const g = compGrid(c);
    const cd = X.find(c, 'COMPARISON_DETAIL');
    // city/state/zip: prefer the separate attrs; fall back to the "City, ST ZIP" line (36/37).
    const fallback = (!clean(X.attr(loc, 'PropertyCity'))) ? splitCityLine(X.attr(loc, 'PropertyStreetAddress2')) : {};
    // GSEListingStatusType is the AUTHORITATIVE status where present; the data-source regex is the
    // fallback for files without COMPARISON_DETAIL.
    const structStatus = { SettledSale: 'closed', Active: 'active', Contract: 'pending' }[clean(X.attr(cd, 'GSEListingStatusType'))];
    // comp prior sale (flip signal) — record only when BOTH amount and date validate; a nominal
    // (≤$1000) transfer is kept but flagged so it never drives a flip calc.
    const ps = X.find(c, 'PRIOR_SALES');
    const psAmt = ps ? money(X.attr(ps, 'PropertySalesAmount')) : null;
    const psDate = ps ? isoDate(X.attr(ps, 'PropertySalesDate')) : null;
    comps.push({
      seq,
      address: clean(X.attr(loc, 'PropertyStreetAddress')),
      city: clean(X.attr(loc, 'PropertyCity')) || fallback.city || null,
      state: upState(X.attr(loc, 'PropertyState')) || fallback.state || null,
      zip: zip(X.attr(loc, 'PropertyPostalCode')) || fallback.zip || null,
      proximity: clean(X.attr(loc, 'ProximityToSubjectDescription')),
      latitude: geo(X.attr(loc, 'LatitudeNumber'), 90),
      longitude: geo(X.attr(loc, 'LongitudeNumber'), 180),
      saleType: enumOf(X.attr(cd, 'GSESaleType'), ['ArmsLengthSale', 'REOSale', 'EstateSale', 'ShortSale', 'Listing', 'CourtOrderedSale']),
      financingType: clean(X.attr(cd, 'GSEFinancingType')),
      compConcession: (() => { const n = toNum(X.attr(cd, 'GSEConcessionAmount')); return n != null && n >= 0 && n < 1e9 ? n : null; })(),
      priorSaleAmount: psAmt, priorSaleDate: psDate, priorSaleNominal: isNominal(psAmt),
      beds: g.beds, bathsText: g.baths, bathsFull: g.bathsFull, bathsHalf: g.bathsHalf, totalRooms: g.totalRooms,
      // A comp's PropertySalesAmount holds the LIST/asking price on an active or pending listing —
      // NOT a closed sale. The review checks + scoring must not count a listing as a settled comp
      // (it inflates the "closed comps" pool and pollutes the implied-value median with an asking
      // price). saleStatus is 'active'/'pending' ONLY when the data source explicitly says so;
      // everything else is a closed sale (the appraiser marks listings — never guessed). The
      // structured GSEListingStatusType (via COMPARISON_DETAIL) is authoritative where present.
      saleStatus: structStatus || saleStatus(c),
      salePrice: money(X.attr(c, 'PropertySalesAmount')),
      adjustedPrice: money(X.attr(c, 'AdjustedSalesPriceAmount')),
      netAdjustment: toNum(X.attr(c, 'SalePriceTotalAdjustmentAmount')),
      netAdjPct: toNum(X.attr(c, 'SalePriceTotalAdjustmentNetPercent')),
      grossAdjPct: toNum(X.attr(c, 'SalesPriceTotalAdjustmentGrossPercent')),
      gla: g.gla, saleDate: g.saleDate, conditionUad: g.conditionUad, qualityUad: g.qualityUad,
      dom: g.dom, pricePerGla: g.pricePerGla, adjustments: g.adjustments.length ? g.adjustments : null,
    });
  }
  return { comps, subject0 };
}

// Subject prior sale (for flip / recent-sale detection) — the structured PRIOR_SALES under the
// seq-0 subject comp, plus the has-prior-sale flag from SALES_COMPARISON/RESEARCH/SUBJECT.
function subjectPriorSale(root, subject0) {
  const out = { hasPrior: null, priorDate: null, priorAmount: null };
  const ps = subject0 ? X.find(subject0, 'PRIOR_SALES') : null;
  if (ps) {
    out.priorAmount = money(X.attr(ps, 'PropertySalesAmount'));
    out.priorDate = isoDate(X.attr(ps, 'PropertySalesDate'));
  }
  const rs = X.find(root, 'RESEARCH');
  const subj = rs ? X.find(rs, 'SUBJECT') : null;
  const flag = subj ? clean(X.attr(subj, '_HasPriorSalesIndicator')) : null;
  if (flag) out.hasPrior = /^y/i.test(flag);
  else if (out.priorAmount != null || out.priorDate != null) out.hasPrior = true;
  return out;
}

// ---- subject condition/quality from the seq-0 comp (UAD codes only) ---------
function subjectCQ(subject0) {
  const out = { conditionUad: null, qualityUad: null, cqNonUad: false };
  if (!subject0) return out;
  const cd = X.find(subject0, 'COMPARISON_DETAIL');
  let cRaw = cd ? X.attr(cd, 'GSEOverallConditionType') : null;
  let qRaw = cd ? X.attr(cd, 'GSEQualityOfConstructionRatingType') : null;
  if (!cRaw || !qRaw) {
    for (const spa of X.findAll(subject0, 'SALE_PRICE_ADJUSTMENT')) {
      const t = X.attr(spa, '_Type'), d = X.attr(spa, '_Description');
      if (t === 'Condition' && !cRaw) cRaw = d;
      if (t === 'Quality' && !qRaw) qRaw = d;
    }
  }
  if (cRaw && UAD_C.test(cRaw)) out.conditionUad = cRaw; else if (cRaw) out.cqNonUad = true;
  if (qRaw && UAD_Q.test(qRaw)) out.qualityUad = qRaw; else if (qRaw) out.cqNonUad = true;
  return out;
}

// A node is subject-scoped when no COMPARABLE_SALE sits above it (the same tag repeats under each
// comp; the subject copy must never pull a comp's site/flood/analysis data).
function notComp(n) { let p = n && n.parent; while (p) { if (p.tag === 'COMPARABLE_SALE') return false; p = p.parent; } return true; }
function subjFind(root, tag) { return X.findAll(root, tag).find(notComp) || null; }
function subjAll(root, tag) { return X.findAll(root, tag).filter(notComp); }
// Join a US mailing address from address parts (street[, city, ST zip]).
function joinAddr(street, city, state, zipc) {
  const s = clean(street), c = clean(city), st = upState(state), z = zip(zipc);
  if (!s && !c) return null;
  const tail = [c, [st, z].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [s, tail].filter(Boolean).join(', ') || null;
}

// ---- ENRICHMENT: consistently-present XML the report was dropping (db/158) ----
// Returns a flat object whose keys EXACTLY match db/158 column names (so import.js can map it
// directly) + a couple of structured sub-objects. Every read is never-guess (enum whitelist,
// unit-aware reader, Y/N→bool, placeholder rejection). All subject-scoped.
function enrichment(root, prop, st, site, subject0, rep, formType) {
  const o = {};
  const A = (n, k) => (n ? X.attr(n, k) : null);

  // -- neighborhood & market --
  const nb = subjFind(root, 'NEIGHBORHOOD');
  o.nbhd_value_trend = enumOf(A(nb, '_PropertyValueTrendType'), ['Increasing', 'Stable', 'Declining']);
  o.nbhd_demand_supply = enumOf(A(nb, '_DemandSupplyType'), ['Shortage', 'InBalance', 'OverSupply']);
  o.nbhd_marketing_time = enumOf(A(nb, '_TypicalMarketingTimeDurationType'), ['UnderThreeMonths', 'ThreeToSixMonths', 'OverSixMonths']);
  o.nbhd_location_type = enumOf(A(nb, 'PropertyNeighborhoodLocationType'), ['Urban', 'Suburban', 'Rural']);
  o.nbhd_builtup = enumOf(A(nb, '_BuiltupRangeType'), ['Over75Percent', '25To75Percent', 'Under25Percent', 'UnderTwentyFivePercent']);
  o.nbhd_growth = enumOf(A(nb, '_GrowthPaceType'), ['Rapid', 'Stable', 'Slow']);
  const housingType = { FNM1004: 'SingleFamily', FNM1025: 'TwoToFourFamily', FNM1073: 'Condominium' }[formType];
  const houses = subjAll(root, '_HOUSING');
  const house = houses.find((h) => X.attr(h, '_Type') === housingType) || houses[0] || null;
  o.nbhd_price_low = thousands(A(house, '_LowPriceAmount'));
  o.nbhd_price_high = thousands(A(house, '_HighPriceAmount'));
  o.nbhd_price_predominant = thousands(A(house, '_PredominantPriceAmount'));
  o.nbhd_age_predominant = years(A(house, '_PredominantAgeYearsCount'), 500);
  const mk = subjFind(root, 'MARKET');
  o.nbhd_adverse_financing = yn(A(mk, 'MarketTrendsAdverseFinancingIndicator'));
  o.nbhd_foreclosure_activity = yn(A(mk, 'MarketTrendsForeclosureActivityIndicator'));

  // -- 1004MC market-conditions grid (MARKET > MARKET_INVENTORY). Each row is one metric for one
  // period (Prior7To12Months|Prior4To6Months|Last3Months) OR a trend row (_TrendType, no period).
  // Amounts are FULL DOLLARS — read with mcNum(), never thousands(). Scoped to the subject MARKET
  // (subjFind already anchors to the subject, so a comp's block can't bleed in).
  const mcRows = mk ? X.findAll(mk, 'MARKET_INVENTORY') : [];
  if (mcRows.length) {
    const grid = {};
    for (const row of mcRows) {
      const type = clean(X.attr(row, '_Type'));
      const valAttr = MC_METRICS[type];
      if (!type || !valAttr) continue;
      const g = grid[type] || (grid[type] = {});
      const period = MC_PERIODS[clean(X.attr(row, '_MonthRangeType'))];
      const trend = enumOf(X.attr(row, '_TrendType'), ['Increasing', 'Stable', 'Declining']);
      if (!period) { if (trend) g.trend = trend; continue; }  // a trend row carries no period
      const num = mcNum(X.attr(row, valAttr));
      if (num != null) g[period] = num;
    }
    // Keep only metrics that actually carried a value (an all-placeholder metric drops out).
    for (const k of Object.keys(grid)) { const g = grid[k]; if (g.prior712 == null && g.prior46 == null && g.last3 == null && g.trend == null) delete grid[k]; }
    o.market_trends = Object.keys(grid).length ? grid : null;
    // Flatten the CURRENT market (Last-3-Months) point metrics + the price-trend conclusion.
    // Strict last-3-months only — never substitute an older period into a "current" flag.
    o.mc_months_supply = grid.Supply && grid.Supply.last3 != null ? grid.Supply.last3 : null;
    o.mc_median_dom = grid.MedianSalesDOM && grid.MedianSalesDOM.last3 != null ? Math.round(grid.MedianSalesDOM.last3) : null;
    o.mc_sale_to_list_pct = grid.MedianSalesToListRatio && grid.MedianSalesToListRatio.last3 != null ? grid.MedianSalesToListRatio.last3 : null;
    o.mc_price_trend = (grid.MedianSalesPrice && grid.MedianSalesPrice.trend) || null;
  }

  // -- site / occupancy --
  o.occupancy_status = enumOf(A(prop, '_CurrentOccupancyType'), ['Vacant', 'TenantOccupied', 'OwnerOccupied']);
  o.property_rights = clean(A(prop, '_RightsType'));
  o.owner_of_record = clean(A(subjFind(root, '_OWNER'), '_Name'));
  for (const pa of subjAll(root, 'PROPERTY_ANALYSIS')) {
    const t = X.attr(pa, '_Type');
    if (t === 'PhysicalDeficiency') { o.physical_deficiency = yn(X.attr(pa, '_ExistsIndicator')); o.physical_deficiency_note = capText(X.attr(pa, '_Comment'), 500); }
    else if (t === 'AdverseSiteConditions') o.adverse_site_conditions = yn(X.attr(pa, '_ExistsIndicator'));
  }
  for (const sf of subjAll(root, 'SITE_FEATURE')) {
    const t = X.attr(sf, '_Type');
    if (t === 'View') o.view_rating = clean(X.attr(sf, '_Comment'));
    else if (t === 'Shape') o.lot_shape = clean(X.attr(sf, '_Comment'));
  }
  o.lot_dimensions = cleanField(A(site, '_DimensionsDescription'));
  o.zoning_compliance_note = capText(A(site, '_ZoningComplianceDescription'), 500);
  const fz = subjFind(root, 'FLOOD_ZONE');
  o.fema_panel_id = clean(A(fz, 'NFIPMapIdentifier'));
  o.fema_panel_date = normDate(A(fz, 'NFIPMapPanelDate'));
  o.special_flood_hazard = yn(A(fz, 'SpecialFloodHazardAreaIndicator'));
  const utils = [];
  for (const u of (site ? X.findAll(site, 'SITE_UTILITY') : [])) {
    const t = clean(X.attr(u, '_Type')); if (!t) continue;
    const pub = yn(X.attr(u, '_PublicIndicator'));
    utils.push({ type: t, public: pub, note: clean(X.attr(u, '_NonPublicDescription')) });
  }
  o.utilities = utils.length ? utils : null;

  // -- structure / systems --
  o.effective_age = years(A(subjFind(root, 'STRUCTURE_ANALYSIS'), 'EffectiveAgeYearsCount'), 200);
  o.updated_last_15yr = yn(A(subjFind(root, 'OVERALL_CONDITION_RATING'), 'GSEUpdateLastFifteenYearIndicator'));
  const heat = st ? X.find(st, 'HEATING') : null;
  o.heating_type = clean(A(heat, '_Type')) === 'Other' ? clean(A(heat, '_TypeOtherDescription')) : clean(A(heat, '_Type'));
  o.heating_fuel = canonFuel(A(heat, '_FuelDescription'));
  const cool = st ? X.find(st, 'COOLING') : null;
  o.cooling = yn(A(cool, '_CentralizedIndicator')) === true ? 'Central' : clean(A(cool, '_UnitDescription'));
  o.foundation_type = clean(A(st ? X.find(st, 'FOUNDATION') : null, '_Type'));
  const bsmt = st ? X.find(st, 'BASEMENT') : null;
  o.basement_sqft = bounded(A(bsmt, 'SquareFeetCount'), 1e6);
  o.basement_finished_pct = o.basement_sqft != null ? count(A(bsmt, '_FinishedPercent'), 100) : null;
  o.attic = yn(A(st ? X.find(st, 'ATTIC') : null, '_ExistsIndicator'));
  o.has_adu = yn(A(st, '_AccessoryUnitExistsIndicator'));
  for (const ef of (st ? X.findAll(st, 'EXTERIOR_FEATURE') : [])) { if (X.attr(ef, '_Type') === 'RoofSurface') o.roof_description = clean(X.attr(ef, '_Description')); }
  const carAtt = st ? X.find(st, 'CAR_STORAGE') : null;
  o.garage_type = clean(A(carAtt, '_AttachmentType'));
  for (const cl of (st ? X.findAll(st, 'CAR_STORAGE_LOCATION') : [])) { if (X.attr(cl, '_Type') === 'Garage' && yn(X.attr(cl, '_ExistsIndicator')) !== false) { const n = count(X.attr(cl, 'ParkingSpacesCount'), 20); if (n != null) o.garage_spaces = n; } }
  if (subject0) { const cd = X.find(subject0, 'COMPARISON_DETAIL'); o.below_grade_sqft = bounded(A(cd, 'GSEBelowGradeTotalSquareFeetNumber'), 1e6); o.below_grade_finished_sqft = bounded(A(cd, 'GSEBelowGradeFinishSquareFeetNumber'), 1e6); }
  const updates = [];
  for (const cdet of subjAll(root, 'CONDITION_DETAIL')) {
    const area = enumOf(X.attr(cdet, 'GSEImprovementAreaType'), ['Kitchen', 'Bathrooms']);
    const level = enumOf(X.attr(cdet, 'GSEImprovementDescriptionType'), ['Remodeled', 'Updated', 'NotUpdated', 'NotRemodeled']);
    const when = enumOf(X.attr(cdet, 'GSEEstimateYearOfImprovementType'), ['LessThanOneYearAgo', 'OneToFiveYearsAgo', 'SixToTenYearsAgo', 'ElevenToFifteenYearsAgo']);
    if (area && level) updates.push({ area, level, timeframe: when });
  }
  o.updates = updates.length ? updates : null;
  const amen = [];
  for (const a of (st ? X.findAll(st, 'AMENITY') : [])) {
    const t = clean(X.attr(a, '_Type')); if (!t) continue;
    const exists = yn(X.attr(a, '_ExistsIndicator'));
    const cnt = count(X.attr(a, '_Count'), 100);
    const desc = clean(X.attr(a, '_DetailedDescription'));
    if (exists === true || (cnt != null && cnt > 0) || (desc && !/^0$/.test(desc))) amen.push({ type: t, count: cnt, description: /^(none|0)$/i.test(desc || '') ? null : desc });
  }
  o.amenities = amen.length ? amen : null;

  // -- sales contract / concessions / listing --
  const sc = subjFind(root, 'SALES_CONTRACT');
  // Scope strictly to the subject contract — never fall back to a doc-wide find (a comp's
  // SALES_TRANSACTION must not become the subject's sale type).
  o.sale_type = enumOf(A(sc ? X.find(sc, 'SALES_TRANSACTION') : null, 'GSESaleType'), ['ArmsLengthSale', 'Listing', 'REOSale', 'ShortSale', 'EstateSale', 'CourtOrderedSale']);
  o.concession_indicator = yn(A(sc, 'SalesConcessionIndicator'));
  o.concession_amount = (() => { const n = toNum(A(sc, 'SalesConcessionAmount')); return n != null && n >= 0 && n < 1e9 ? n : null; })();
  o.concession_description = capText(A(sc, 'SalesConcessionDescription'), 400);
  o.contract_reviewed = yn(A(sc, '_ReviewedIndicator'));
  o.contract_review_comment = capText(A(sc, '_ReviewComment'), 500);
  o.seller_is_owner = yn(A(sc, 'SellerIsOwnerIndicator'));
  o.contract_data_source = clean(A(sc, 'DataSourceDescription'));
  const lh = subjFind(root, 'LISTING_HISTORY');
  o.listed_within_year = yn(A(lh, 'ListedWithinPreviousYearIndicator'));
  o.listing_history = capText(A(lh, 'ListedWithinPreviousYearDescription'), 500);

  // -- cost approach detail --
  const ca = subjFind(root, 'COST_ANALYSIS');
  o.remaining_economic_life = years(A(ca, 'EstimatedRemainingEconomicLifeYearsCount'), 200);
  o.cost_new_total = money(A(ca, 'NewImprovementTotalCostAmount'));
  o.depreciated_cost_improvements = money(A(ca, 'NewImprovementDepreciatedCostAmount'));
  o.site_improvements_value = money(A(ca, 'SiteOtherImprovementsAsIsAmount'));
  o.cost_data_source = clean(A(ca, 'DataSourceDescription'));
  o.cost_quality_rating = clean(A(ca, 'CostServiceQualityRatingDescription'));
  const dep = ca ? X.find(ca, 'DEPRECIATION') : null;
  o.depreciation_physical = money(A(dep, '_PhysicalAmount'));
  o.depreciation_functional = money(A(dep, '_FunctionalAmount'));
  o.depreciation_external = money(A(dep, '_ExteriorAmount'));
  o.depreciation_total = money(A(dep, '_TotalAmount'));
  for (const ni of (ca ? X.findAll(ca, 'NEW_IMPROVEMENT') : [])) {
    const t = X.attr(ni, '_Type');
    if (t === 'Dwelling' || t === 'SectionOne') { o.dwelling_cost_new = money(X.attr(ni, '_CostAmount')); o.dwelling_sqft = bounded(X.attr(ni, 'SquareFeetCount'), 1e6); o.dwelling_price_per_sqft = bounded(X.attr(ni, 'PricePerSquareFootAmount'), 1e6); }
  }

  // -- income / rent --
  const inc = subjFind(root, 'INCOME_ANALYSIS');
  o.est_market_monthly_rent = bounded(A(inc, 'EstimatedMarketMonthlyRentAmount'), 1e8);  // numeric(12,2) — bounded, not money()'s 1e12
  const rentUtils = [];
  for (const ru of subjAll(root, 'RENT_INCLUDES_UTILITY')) { if (yn(X.attr(ru, '_Indicator')) === true) { const t = clean(X.attr(ru, '_Type')); if (t) rentUtils.push(t === 'Other' ? (clean(X.attr(ru, '_TypeOtherDescription')) || 'Other') : t); } }
  o.rent_included_utilities = rentUtils.length ? rentUtils : null;

  // -- reconciliation / conditions / scope --
  const rec = subjFind(root, '_RECONCILIATION');
  o.reconciliation_comment = capText(A(rec, '_SummaryComment'), 1500);
  o.conditions_comment = capText(A(rec, '_ConditionsComment'), 700);
  o.appraisal_purpose = enumOf(A(rep, 'AppraisalPurposeType'), ['Purchase', 'Refinance', 'Other', 'ConstructionPermanent']);
  o.appraisal_purpose_other = o.appraisal_purpose === 'Other' ? clean(A(rep, 'AppraisalPurposeTypeOtherDescription')) : null;
  o.addendum_text = capText(A(subjFind(root, 'VALUATION_METHODS'), '_AdditionalDescription'), 4000);
  o.uspap_report_type = enumOf(A(rep, 'USPAPReportDescription'), ['Summary Report', 'Self-Contained Report', 'Restricted Appraisal Report', 'Self Contained Report', 'Restricted Report']);

  // -- appraiser / parties / inspection --
  const ap = subjFind(root, 'APPRAISER');
  o.appraiser_company_address = joinAddr(A(ap, '_StreetAddress'), A(ap, '_City'), A(ap, '_State'), A(ap, '_PostalCode'));
  const insp = subjAll(root, 'INSPECTION').find((n) => X.attr(n, 'AppraisalInspectionPropertyType') === 'Subject') || subjFind(root, 'INSPECTION');
  o.inspection_type = clean(A(insp, 'AppraisalInspectionType'));
  const sup = subjFind(root, 'SUPERVISOR');
  if (sup && clean(X.attr(sup, '_Name'))) {   // only a REAL supervisor (23/24 are empty placeholders)
    const supLic = X.find(sup, 'APPRAISER_LICENSE');
    o.supervisor_license_id = clean(A(supLic, '_Identifier'));
    o.supervisor_license_state = upState(A(supLic, '_State'));
    o.supervisor_license_exp = normDate(A(supLic, '_ExpirationDate'));
  }
  const lender = subjFind(root, 'LENDER');
  o.lender_address = joinAddr(A(lender, '_StreetAddress'), A(lender, '_City'), A(lender, '_State'), A(lender, '_PostalCode')) || clean(A(lender, 'AppraisalFormsUnparsedAddress'));

  // -- condo / PUD project (1073) --
  if (formType === 'FNM1073') {
    const pr = subjFind(root, 'PROJECT');
    const stages = subjAll(root, 'DEVELOPMENT_STAGE');
    const stage = stages.find((s) => X.attr(s, '_Type') === 'SubjectPhase') || stages[0] || null;
    o.condo_units_planned = count(A(stage, 'PlannedUnitsCount'), 100000);
    o.condo_units_completed = count(A(stage, 'CompletedUnitsCount'), 100000);
    o.condo_units_sold = count(A(stage, 'UnitsSoldCount'), 100000);
    o.condo_units_rented = count(A(stage, 'UnitsRentedCount'), 100000);
    o.condo_units_for_sale = count(A(stage, 'UnitsForSaleCount'), 100000);
    o.condo_owner_occupied = count(A(stage, 'OwnerOccupiedUnitCount'), 100000);
    o.condo_total_phases = count(A(stages.find((s) => X.attr(s, '_TotalPhasesCount')) || stage, '_TotalPhasesCount'), 10000);
    o.condo_common_elements = capText(A(pr, '_CommonElementsDescription'), 500);
    o.condo_commercial_space = yn(A(pr, '_CommercialSpaceIndicator'));
    o.condo_management_type = clean(A(pr, '_ManagementType'));
    o.condo_developer_control = yn(A(pr, '_DeveloperControlsProjectManagementIndicator'));
    o.condo_concentrated_ownership = yn(A(pr, '_ConcentratedOwnershipIndicator'));
    const pcs = subjFind(root, 'PROJECT_CAR_STORAGE');
    o.condo_parking_spaces = count(A(pcs, 'ParkingSpacesCount'), 100000);
  }

  // -- prior-sales research flag --
  const rs = subjFind(root, 'RESEARCH');
  const rsComp = rs ? X.find(rs, 'COMPARABLE') : null;
  o.comps_have_prior_sales = yn(A(rsComp, '_HasPriorSalesIndicator'));

  return o;
}
// Canonicalize a heating-fuel token (GAS/gas/NG → Gas; Elec./elec → Electric) — never drop unknowns.
function canonFuel(v) {
  const s = clean(v); if (!s) return null;
  const t = s.toLowerCase();
  if (/^(gas|ng|natural gas)\b/.test(t)) return 'Gas';
  if (/^elec/.test(t)) return 'Electric';
  if (/^oil/.test(t)) return 'Oil';
  if (/^propane|^lp\b/.test(t)) return 'Propane';
  return s;
}
// A unit's lease/occupancy status from its (free-text) lease-date fields — classified into a
// controlled value, NEVER date-parsed. 'Vacant'/'MTM'/'monthly'/'OWNER'/'FAMILY'/'Not Provided'
// are status tokens; two real dates = a term lease.
function leaseStatus(startRaw, endRaw) {
  const a = clean(startRaw), b = clean(endRaw);
  const joined = `${a || ''} ${b || ''}`.toLowerCase();
  if (/vacant/.test(joined)) return 'vacant';
  if (/mtm|mo\/mo|month/.test(joined)) return 'month_to_month';
  if (/owner/.test(joined)) return 'owner_occupied';
  if (/family/.test(joined)) return 'family_occupied';
  if (isoDate(a) || isoDate(b) || normDate(a) || normDate(b)) return 'leased';
  return null;   // 'Not Provided' / blank → unknown, never 'vacant'
}

// ---- small validated readers ------------------------------------------------
function upState(v) { const s = clean(v); return s && /^[A-Za-z]{2}$/.test(s) ? s.toUpperCase() : (s && /^[A-Za-z]{2}\b/.test(s) ? s.slice(0, 2).toUpperCase() : null); }
function zip(v) { const s = clean(v); return s && /^\d{5}(-\d{4})?$/.test(s) ? s : (s && /^\d{5}/.test(s) ? s.slice(0, 5) : null); }
function year(v) { const n = toNum(v); return n != null && n >= 1700 && n <= CUR_YEAR ? String(n) : null; }

// ---- top-level extract ------------------------------------------------------
// Detect the appraisal dataset format from the raw XML. PILOT's parser reads UAD 2.6 (MISMO 2.6,
// the attribute-heavy VALUATION_RESPONSE). The GSE redesign — UAD 3.6 / MISMO 3.x (URAR) — uses a
// MESSAGE root + the 2009+ schema and a totally different shape; we must recognise it and fail
// LOUDLY with a clear reason, never extract nulls from a file we don't actually understand.
function detectMismo(xml) {
  const s = String(xml || '');
  const ref = /MISMOReferenceModelIdentifier\s*=\s*"?(\d+\.\d+)/i.exec(s);
  const isV3 = (ref && /^3\./.test(ref[1]))
    || /<(?:[A-Za-z_][\w.-]*:)?MESSAGE[\s>]/.test(s)
    || /mismo\.org\/residential\/2009/i.test(s);
  const uad36 = /\bUAD\s*3\.?6\b/i.test(s) || (isV3 && /uniform\s+residential\s+appraisal\s+report/i.test(s));
  return { model: isV3 ? '3.x' : '2.x', ref: ref ? ref[1] : null, uad36 };
}

function extract(xml) {
  const root = X.parse(xml);
  const rep = X.find(root, 'REPORT');
  if (!rep) {
    // Give the officer the real reason. A UAD 3.6 / MISMO 3.x file is a KNOWN, named format we
    // don't yet read — say so, rather than a generic "not a REPORT".
    const d = detectMismo(xml);
    if (d.model === '3.x' || d.uad36) {
      return { ok: false, format: { model: '3.x', uad36: true, ref: d.ref },
        error: `This appraisal is in the UAD 3.6 / MISMO 3.x format${d.ref ? ` (reference model ${d.ref})` : ''}. PILOT currently reads UAD 2.6 (MISMO 2.6) appraisals — a 3.6 reader is required, so this file was not imported. Please provide the UAD 2.6 export, or import the PDF.` };
    }
    return { ok: false, error: 'not a MISMO VALUATION_RESPONSE / REPORT' };
  }
  const formType = clean(X.attr(rep, 'AppraisalFormType'));
  const warnings = [];

  // subject identity — anchored to the subject <PROPERTY> element (not a doc-wide first match)
  const prop = X.find(root, 'PROPERTY');
  const ident = X.find(root, '_IDENTIFICATION');
  const pidExt = X.find(root, 'PARCEL_IDENTIFIER');
  const st = X.find(root, 'STRUCTURE');
  const site = X.find(root, 'SITE');
  const val = valuation(root);
  const { comps, subject0 } = comparables(root);
  // Split the comps into the As-Is grid vs the ARV grid (a renovation appraisal supports two
  // values off two separate comp sets). NEVER guessed: prefers the appraiser's narrative naming,
  // falls back to price-clustering only when both anchors are known and raw+adjusted agree, else
  // marks the comp `unknown` and flags for review. Each comp gets a `comp_set`.
  const gridSplit = splitComps({ basis: val.basis, asIsValue: val.asIs, arvValue: val.arv, texts: narrativeTexts(root), comps });
  gridSplit.comps.forEach((gc, i) => { if (comps[i]) comps[i].comp_set = gc.comp_set; });
  const cq = subjectCQ(subject0);
  const bathsParsed = parseBaths(X.attr(st, 'TotalBathroomCount'));
  // Enrichment: the large set of consistently-present XML fields the report was dropping (db/158).
  const enrich = enrichment(root, prop, st, site, subject0, rep, formType);

  const subject = {
    address: clean(X.attr(prop, '_StreetAddress')),
    city: clean(X.attr(prop, '_City')),
    county: clean(X.attr(prop, '_County')),
    state: upState(X.attr(prop, '_State')),
    zip: zip(X.attr(prop, '_PostalCode')),
    apn: clean(X.attr(ident, 'AssessorsParcelIdentifier')) || clean(X.attr(pidExt, 'GSEAssessorsParcelIdentifier')),
    legal: clean(X.attr(X.find(root, '_LEGAL_DESCRIPTION'), '_TextDescription')),
    censusTract: clean(X.attr(ident, 'CensusTractIdentifier')),
    neighborhood: clean(X.attr(X.find(root, 'NEIGHBORHOOD'), '_Name')),
    propertyType: clean(X.attr(st, 'AttachmentType')),
    units: toNum(X.attr(st, 'LivingUnitCount')),
    yearBuilt: year(X.attr(st, 'PropertyStructureBuiltYear')),
    gla: bounded(X.attr(st, 'GrossLivingAreaSquareFeetCount'), 1e8),
    beds: toNum(X.attr(st, 'TotalBedroomCount')),
    baths: bathsParsed.text, bathsFull: bathsParsed.full, bathsHalf: bathsParsed.half,
    rooms: toNum(X.attr(st, 'TotalRoomCount')),
    stories: clean(X.attr(st, 'StoriesCount')),
    design: clean(X.attr(st, '_DesignDescription')),
    lotArea: clean(X.attr(site, '_AreaDescription')),
    zoningId: clean(X.attr(site, '_ZoningClassificationIdentifier')),
    zoningDesc: clean(X.attr(site, '_ZoningClassificationDescription')),
    zoningCompliance: clean(X.attr(site, '_ZoningComplianceType')),
    floodZone: clean(X.attr(X.find(root, 'FLOOD_ZONE'), 'NFIPFloodZoneIdentifier')),
    conditionUad: cq.conditionUad,
    qualityUad: cq.qualityUad,
    priorSale: subjectPriorSale(root, subject0),
  };
  // imply units by form when blank (1004/1073 → 1)
  if (subject.units == null && (formType === 'FNM1004' || formType === 'FNM1073')) subject.units = 1;

  // parties
  const ap = X.find(root, 'APPRAISER');
  const lic = ap ? X.find(ap, 'APPRAISER_LICENSE') : X.find(root, 'APPRAISER_LICENSE');
  // Scope contact points to the appraiser node — a doc-wide search would grab the
  // AMC / lender / supervisor's phone or email (audit #2). Take the first of each type.
  let phone = null, email = null;
  for (const cp of (ap ? X.findAll(ap, 'CONTACT_POINT') : [])) {
    const t = X.attr(cp, '_Type'), v = X.attr(cp, '_Value');
    if (t === 'Phone' && v && !phone) phone = v;
    if (t === 'Email' && v && !email) email = v;
  }
  const bn = X.find(root, 'BORROWER_NAME');
  let borrower = clean(X.attr(bn, 'GSEBorrowerName')) || clean(X.attr(X.find(root, 'BORROWER'), '_UnparsedName'));
  const isLlc = !!(borrower && /\b(LLC|L\.L\.C|INC|CORP|LP|LLP|TRUST|COMPANY|HOLDINGS|PROPERTIES|CAPITAL|GROUP|VENTURES|ENTERPRISE)\b/i.test(borrower));
  const appraiser = {
    name: clean(X.attr(ap, '_Name')), company: clean(X.attr(ap, '_CompanyName')),
    licenseId: clean(X.attr(lic, '_Identifier')), licenseState: upState(X.attr(lic, '_State')),
    licenseType: clean(X.attr(lic, '_Type')), licenseExp: normDate(X.attr(lic, '_ExpirationDate')),
    phone: clean(phone), email: clean(email),
    supervisor: clean(X.attr(X.find(root, 'SUPERVISOR'), '_Name')),
    lender: clean(X.attr(X.find(root, 'LENDER'), '_UnparsedName')),
    amc: clean(X.attr(X.find(root, 'MANAGEMENT_COMPANY'), 'GSEManagementCompanyName')),
    reportSignedDate: normDate(X.attr(rep, 'AppraiserReportSignedDate')),
    inspectionDate: normDate(X.attr(X.find(root, 'INSPECTION'), 'InspectionDate')),
  };

  // 1025 per-unit rents + the per-unit mix (_UNIT_GROUP) + lease status. The lease dates carry a
  // free-text occupancy status (Vacant / MTM / monthly / a real date), classified — never date-parsed.
  const unitGroups = {};
  for (const ug of X.findAll(st || root, '_UNIT_GROUP')) {
    const key = { UnitOne: '1', UnitTwo: '2', UnitThree: '3', UnitFour: '4' }[clean(X.attr(ug, 'UnitType'))] || clean(X.attr(ug, 'UnitType'));
    if (key) unitGroups[key] = { rooms: count(X.attr(ug, 'TotalRoomCount'), 99), beds: count(X.attr(ug, 'TotalBedroomCount'), 99), baths: parseBaths(X.attr(ug, 'TotalBathroomCount')).text, sqft: bounded(X.attr(ug, 'GrossLivingAreaSquareFeetCount'), 1e6) };
  }
  const units = [];
  for (const u of X.findAll(root, 'UNIT_RENT_SCHEDULE')) {
    const seq = X.attr(u, 'UnitSequenceIdentifier');
    const mix = unitGroups[seq] || {};
    const actualRent = money(X.attr(u, 'UnitActualRentAmount'));
    const marketRent = money(X.attr(u, 'UnitMarketRentAmount'));
    // Skip a fully-empty padded row (1025 schedules pad to 4 units even for a 2-unit property).
    if (actualRent == null && marketRent == null && mix.beds == null && mix.rooms == null) continue;
    units.push({ seq, actualRent, marketRent, rooms: mix.rooms || null, beds: mix.beds || null, baths: mix.baths || null, sqft: mix.sqft || null,
      leaseStatus: leaseStatus(X.attr(u, 'LeaseStartDate'), X.attr(u, 'LeaseExpirationDate')) });
  }
  const mrs = X.find(root, 'MULTIFAMILY_RENT_SCHEDULE');
  const income = mrs ? { actualGrossRent: money(X.attr(mrs, 'RentalActualGrossMonthlyRentAmount')), marketGrossRent: money(X.attr(mrs, 'RentalEstimatedGrossMonthlyRentAmount')) } : null;

  // 1073 condo card
  let condo = null;
  if (formType === 'FNM1073') {
    const pr = X.find(root, 'PROJECT'); const unit = X.find(root, '_UNIT');
    // HOA: use toNum (0 is a valid "no fee" — never drop it as money() would), but prefer a
    // populated fee row if the first _PER_UNIT_FEE is a 0 placeholder (spec fix).
    const fees = X.findAll(root, '_PER_UNIT_FEE').map((f) => ({ amt: toNum(X.attr(f, '_Amount')), per: clean(X.attr(f, '_PeriodType')) }));
    const feePick = fees.find((f) => f.amt != null && f.amt > 0) || fees.find((f) => f.amt != null) || {};
    condo = {
      projectName: clean(X.attr(pr, '_Name')), projectType: clean(X.attr(pr, '_DesignType')),
      elevatorCount: toNum(X.attr(pr, 'ElevatorCount')),
      unitIdentifier: clean(X.attr(unit, 'UnitIdentifier')), floor: clean(X.attr(unit, 'FloorIdentifier')),
      hoaFeeAmount: feePick.amt != null ? feePick.amt : null, hoaFeePeriod: feePick.per || null,
    };
  }

  // photos manifest (pixels live in the PDF; count metadata + form content types)
  const pdfCount = X.findAll(root, 'EMBEDDED_FILE').filter((e) => X.attr(e, '_Type') === 'PDF').length;
  const photos = { embeddedPdf: pdfCount, imageMeta: X.findAll(root, 'IMAGE').length };

  // ---- tripwires (catch a bad file / parser regression, never silently pass) ----
  if (!['FNM1004', 'FNM1025', 'FNM1073'].includes(formType)) warnings.push({ code: 'unknown_form', msg: `unexpected form type ${formType}` });
  if (val.appraisedValue == null) warnings.push({ code: 'no_appraised_value', msg: 'appraised value missing' });
  if (comps.length === 0) warnings.push({ code: 'no_comps', msg: 'no comparable sales found' });
  if (!subject.address || !subject.state || !subject.zip) warnings.push({ code: 'weak_identity', msg: 'subject address/state/zip incomplete' });
  if (!borrower) warnings.push({ code: 'no_party', msg: 'no borrower or entity name on the appraisal' });
  if (cq.cqNonUad) warnings.push({ code: 'nonuad_cq', msg: 'condition/quality present but not a UAD code — flagged for verify' });
  if (val.asIs != null && val.arv != null && val.asIs > val.arv) warnings.push({ code: 'asis_gt_arv', msg: 'As-Is exceeds ARV — sanity check' });
  if (formType === 'FNM1025' && subject.units != null && ![2, 3, 4].includes(subject.units)) warnings.push({ code: 'unit_count', msg: `1025 with ${subject.units} units` });
  // C6 (substantial damage) / Q6 (substandard) are UCDP-fatal — surface, don't just store the code.
  if (subject.conditionUad === 'C6') warnings.push({ code: 'condition_c6', msg: 'condition C6 — substantial damage affecting safety/soundness (UCDP fatal)' });
  if (subject.qualityUad === 'Q6') warnings.push({ code: 'quality_q6', msg: 'quality Q6 — basic/substandard construction (UCDP fatal)' });
  // Version guard: these paths are MISMO 2.6 / UAD 2.6. A UAD 3.6 / MISMO 3.x file must fail loudly, not extract nulls.
  const ver = X.attr(X.find(root, 'VALUATION_RESPONSE'), 'MISMOVersionID');
  if (ver && !/^2\./.test(String(ver))) warnings.push({ code: 'mismo_version', msg: `unexpected MISMO version ${ver} — parser targets 2.6; verify before trusting` });

  // Surface the two-grid split summary so the underwriter (and the report) know which value each
  // comp set supports, and whether the split needs a human eye. `compSplit.needsReview` on a
  // reno file drives a review finding rather than a corrupt one-grid value check.
  if (gridSplit.needsReview) warnings.push({ code: 'comp_split_review', msg: 'As-Is vs ARV comp split needs review — some comps could not be assigned to a grid with certainty' });

  // ---- enrichment tripwires (advisory underwriting flags from the new fields) ----
  if (enrich.nbhd_value_trend === 'Declining') warnings.push({ code: 'nbhd_declining', msg: 'Neighborhood values are declining — exit-value risk' });
  if (enrich.nbhd_demand_supply === 'OverSupply') warnings.push({ code: 'nbhd_oversupply', msg: 'Neighborhood is over-supplied — slower exit' });
  if (enrich.sale_type && enrich.sale_type !== 'ArmsLengthSale') warnings.push({ code: 'sale_type_risk', msg: `Subject sale type is ${enrich.sale_type} — not an arm's-length purchase` });
  if (enrich.seller_is_owner === false) warnings.push({ code: 'seller_not_owner', msg: 'Seller is not the owner of record — possible wholesale/assignment' });
  if (enrich.contract_reviewed === false) warnings.push({ code: 'contract_not_analyzed', msg: 'Appraiser did not analyze the sale contract' });
  if (enrich.concession_indicator === true || (enrich.concession_amount != null && enrich.concession_amount > 0)) warnings.push({ code: 'seller_concessions', msg: 'Seller concessions on the contract — effective price is lower' });
  if (enrich.inspection_type === 'None') warnings.push({ code: 'no_inspection', msg: 'Desktop / no-inspection appraisal — no property inspection recorded' });
  if (enrich.occupancy_status === 'TenantOccupied') warnings.push({ code: 'tenant_occupied', msg: 'Subject is tenant-occupied — possession/eviction risk on a flip' });
  // expired appraiser license at signing (string YYYY-MM-DD compare; never new Date()). Read the
  // BUILT appraiser object (ap is the raw XML node and has no licenseExp; using it both crashed on
  // an APPRAISER-less file and made this warning permanently silent — audit MAJOR).
  if (appraiser.licenseExp && appraiser.reportSignedDate && appraiser.licenseExp < appraiser.reportSignedDate) warnings.push({ code: 'license_expired_at_signing', msg: `Appraiser license expired ${appraiser.licenseExp} before the report was signed ${appraiser.reportSignedDate}` });
  // condo owner-occupancy warrantability
  if (enrich.condo_units_sold != null && enrich.condo_units_sold > 0 && enrich.condo_owner_occupied != null) {
    const ooPct = enrich.condo_owner_occupied / enrich.condo_units_sold;
    if (enrich.condo_owner_occupied > enrich.condo_units_sold) warnings.push({ code: 'condo_occupancy_conflict', msg: 'Condo owner-occupied count exceeds units sold — data conflict' });
    else if (ooPct < 0.5) warnings.push({ code: 'condo_low_owner_occ', msg: `Condo project is ${Math.round(ooPct * 100)}% owner-occupied (<50%) — warrantability concern` });
  }
  if (enrich.condo_concentrated_ownership === true) warnings.push({ code: 'condo_concentrated_ownership', msg: 'Condo project has concentrated single-entity ownership — eligibility risk' });
  // 1004MC market-conditions tripwires (the appraiser's own current-market read)
  if (enrich.mc_price_trend === 'Declining') warnings.push({ code: 'mc_price_declining', msg: '1004MC median sale price is declining — the appraiser flagged a softening market' });
  if (enrich.mc_months_supply != null && enrich.mc_months_supply > 6) warnings.push({ code: 'mc_oversupply', msg: `1004MC shows ${enrich.mc_months_supply} months of housing supply (>6) — a buyer's market, slower exit` });
  if (enrich.mc_sale_to_list_pct != null && enrich.mc_sale_to_list_pct < 95) warnings.push({ code: 'mc_weak_pricing', msg: `1004MC median sale-to-list is ${enrich.mc_sale_to_list_pct}% (<95%) — sellers are conceding on price` });

  return {
    ok: true, formType,
    subject, values: val, appraiser, enrich,
    borrower: { name: borrower, isLlc, hasPartyName: !!borrower },
    comparables: comps, units, income, condo, photos,
    compSplit: { confidence: gridSplit.confidence, needsReview: gridSplit.needsReview, note: gridSplit.note,
      asIsValue: gridSplit.asIsValue, arvValue: gridSplit.arvValue,
      counts: { as_is: comps.filter((c) => c.comp_set === 'as_is').length, arv: comps.filter((c) => c.comp_set === 'arv').length, unknown: comps.filter((c) => c.comp_set === 'unknown').length } },
    warnings,
  };
}

module.exports = { extract, _internals: { toNum, money, clean, normDate, upState, zip, year } };
