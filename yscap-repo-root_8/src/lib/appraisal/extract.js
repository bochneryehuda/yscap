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
  const out = { gla: null, saleDate: null, conditionUad: null, qualityUad: null, dom: null, pricePerGla: bounded(X.attr(c, 'SalesPricePerGrossLivingAreaAmount'), 1e8), adjustments: [] };
  for (const spa of X.findAll(c, 'SALE_PRICE_ADJUSTMENT')) {
    const t = clean(X.attr(spa, '_Type'));
    const d = clean(X.attr(spa, '_Description'));
    const amt = toNum(X.attr(spa, '_Amount'));
    if (t) out.adjustments.push({ type: t, description: d, amount: amt });
    if (t === 'GrossLivingArea' && d) { const g = toNum(d); if (g != null && g > 100 && g < 100000) out.gla = g; }
    else if (t === 'GrossBuildingArea' && d && out.gla == null) { const g = toNum(d); if (g != null && g > 100 && g < 100000) out.gla = g; }
    else if (t === 'DateOfSale' && d) out.saleDate = settledMonth(d);
    else if (t === 'Condition' && d && UAD_C.test(d)) out.conditionUad = d;
    else if (t === 'Quality' && d && UAD_Q.test(d)) out.qualityUad = d;
  }
  const cd = X.find(c, 'COMPARISON_DETAIL');
  if (cd) {
    if (!out.conditionUad) { const cc = clean(X.attr(cd, 'GSEOverallConditionType')); if (cc && UAD_C.test(cc)) out.conditionUad = cc; }
    if (!out.qualityUad) { const qq = clean(X.attr(cd, 'GSEQualityOfConstructionRatingType')); if (qq && UAD_Q.test(qq)) out.qualityUad = qq; }
    const dom = toNum(X.attr(cd, 'GSEDaysOnMarketDescription')); if (dom != null && dom >= 0 && dom < 3000) out.dom = dom;
  }
  return out;
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
    comps.push({
      seq,
      address: clean(X.attr(loc, 'PropertyStreetAddress')),
      city: clean(X.attr(loc, 'PropertyCity')),
      state: upState(X.attr(loc, 'PropertyState')),
      zip: zip(X.attr(loc, 'PropertyPostalCode')),
      proximity: clean(X.attr(loc, 'ProximityToSubjectDescription')),
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

  // 1025 per-unit rents
  const units = [];
  for (const u of X.findAll(root, 'UNIT_RENT_SCHEDULE')) {
    units.push({ seq: X.attr(u, 'UnitSequenceIdentifier'), actualRent: money(X.attr(u, 'UnitActualRentAmount')), marketRent: money(X.attr(u, 'UnitMarketRentAmount')) });
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

  return {
    ok: true, formType,
    subject, values: val, appraiser,
    borrower: { name: borrower, isLlc, hasPartyName: !!borrower },
    comparables: comps, units, income, condo, photos,
    compSplit: { confidence: gridSplit.confidence, needsReview: gridSplit.needsReview, note: gridSplit.note,
      asIsValue: gridSplit.asIsValue, arvValue: gridSplit.arvValue,
      counts: { as_is: comps.filter((c) => c.comp_set === 'as_is').length, arv: comps.filter((c) => c.comp_set === 'arv').length, unknown: comps.filter((c) => c.comp_set === 'unknown').length } },
    warnings,
  };
}

module.exports = { extract, _internals: { toNum, money, clean, normDate, upState, zip, year } };
