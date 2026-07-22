'use strict';
/**
 * P1 — Document-aware OCR/model ROUTING MATRIX (deterministic core, ADVISORY).
 *
 * Today's `ocr-router` is a flat FALLBACK chain: Azure → Google → Mistral,
 * identical for every document. That wastes money on easy documents and
 * under-reads hard, high-stakes ones. This module turns the router
 * DOCUMENT-AWARE: given a document's family + observable features it produces a
 * ROUTING PLAN — which reader to use FIRST, whether a second reader is
 * MANDATORY (high-risk numeric documents get read twice and reconciled), which
 * pages are too weak to trust and must be re-read, and any special handling
 * (use the appraisal's own MISMO XML instead of OCR; use the PDF's native text
 * layer when it's reliable; preserve tables; look for signatures/handwriting).
 *
 * It is PURE and ADVISORY: it returns a plan. It reads nothing, calls no HTTP,
 * changes no underwriting decision. The router consumes the plan; when no
 * document family is known the plan is byte-identical to today's behavior, so
 * wiring it in never changes an existing read.
 *
 * Signals the owner named, and where each enters `planRoute(features)`:
 *   • MIME / native-text / page-count / bytes  → features.mimeType, hasNativeText, pageCount, bytes
 *   • scan quality / rotation                  → features.scanQuality (from page-quality.assessPacket)
 *   • layout density / tables / signatures     → the family PROFILE (tables/signatures/handwriting)
 *   • materiality                              → the family PROFILE (materiality + numericCritical)
 *   • appraisal XML present                    → features.appraisalXmlPresent
 *   • prior-provider performance / availability→ features.availability + features.providerHealth
 *   • confidence / disagreement                → weakPages() + reconcileNumbers()
 */

// -------------------------------------------------------------------------
// FAMILY PROFILES — the per-document-family routing knobs. Keyed by the
// classifier's docType (src/lib/underwriting/classify.js). materiality drives
// how hard we try; numericCritical forces a mandatory second reader (the
// numbers are load-bearing and a single-engine misread is expensive); tables
// wants a layout-preserving reader (Azure prebuilt-layout is strongest);
// signatures/handwriting hint the reread + downstream checks.
// -------------------------------------------------------------------------
const DEFAULT_PROFILE = Object.freeze({
  materiality: 'medium', numericCritical: false, tables: false,
  signatures: false, handwriting: false, preferAppraisalXml: false,
});

const FAMILY_PROFILES = Object.freeze({
  // High-materiality, numbers are load-bearing → mandatory challenger.
  appraisal:         { materiality: 'high',   numericCritical: true,  tables: true,  signatures: true,  handwriting: false, preferAppraisalXml: true },
  bank_statement:    { materiality: 'high',   numericCritical: true,  tables: true,  signatures: false, handwriting: false },
  settlement:        { materiality: 'high',   numericCritical: true,  tables: true,  signatures: true,  handwriting: false },
  payoff_statement:  { materiality: 'high',   numericCritical: true,  tables: true,  signatures: false, handwriting: false },
  title:             { materiality: 'high',   numericCritical: true,  tables: false, signatures: false, handwriting: false },
  insurance:         { materiality: 'high',   numericCritical: true,  tables: false, signatures: false, handwriting: false },
  insurance_invoice: { materiality: 'medium', numericCritical: true,  tables: false, signatures: false, handwriting: false },
  credit_report:     { materiality: 'high',   numericCritical: true,  tables: true,  signatures: false, handwriting: false },
  scope_of_work:     { materiality: 'high',   numericCritical: true,  tables: true,  signatures: false, handwriting: true  },
  flood:             { materiality: 'high',   numericCritical: false, tables: false, signatures: false, handwriting: false },
  // Signed / identity / entity documents — the SIGNATURE + party identity matter.
  purchase_contract: { materiality: 'high',   numericCritical: true,  tables: false, signatures: true,  handwriting: true  },
  contract_amendment:{ materiality: 'high',   numericCritical: true,  tables: false, signatures: true,  handwriting: true  },
  assignment:        { materiality: 'high',   numericCritical: true,  tables: false, signatures: true,  handwriting: true  },
  operating_agreement:{ materiality: 'high',  numericCritical: false, tables: false, signatures: true,  handwriting: false },
  llc_formation:     { materiality: 'medium', numericCritical: false, tables: false, signatures: true,  handwriting: false },
  good_standing:     { materiality: 'medium', numericCritical: false, tables: false, signatures: true,  handwriting: false },
  ein_letter:        { materiality: 'medium', numericCritical: false, tables: false, signatures: false, handwriting: false },
  government_id:     { materiality: 'high',   numericCritical: false, tables: false, signatures: true,  handwriting: true  },
  voided_check:      { materiality: 'medium', numericCritical: true,  tables: false, signatures: false, handwriting: true  },
  background_report: { materiality: 'high',   numericCritical: false, tables: true,  signatures: false, handwriting: false },
  signed_application:{ materiality: 'high',   numericCritical: false, tables: false, signatures: true,  handwriting: true  },
  signed_term_sheet: { materiality: 'high',   numericCritical: true,  tables: false, signatures: true,  handwriting: true  },
  investor_structure:{ materiality: 'medium', numericCritical: true,  tables: true,  signatures: false, handwriting: false },
  plans_permits:     { materiality: 'medium', numericCritical: false, tables: false, signatures: true,  handwriting: true  },
  // Expanded RTL taxonomy (owner-directed 2026-07-22).
  cpl:               { materiality: 'high',   numericCritical: false, tables: false, signatures: true,  handwriting: false },
  appraisal_revision:{ materiality: 'high',   numericCritical: true,  tables: true,  signatures: true,  handwriting: false, preferAppraisalXml: true },
  lease:             { materiality: 'high',   numericCritical: true,  tables: false, signatures: true,  handwriting: true  },
  mortgage_statement:{ materiality: 'high',   numericCritical: true,  tables: true,  signatures: false, handwriting: false },
  entity_resolution: { materiality: 'high',   numericCritical: false, tables: false, signatures: true,  handwriting: true  },
  draw_request:      { materiality: 'high',   numericCritical: true,  tables: true,  signatures: true,  handwriting: true  },
  experience_docs:   { materiality: 'medium', numericCritical: false, tables: true,  signatures: false, handwriting: false },
});

// The three OCR engines the router can reach, ranked by our default trust for a
// generic document. Table-heavy documents override this (Azure prebuilt-layout
// is the strongest table reader), and availability/health can knock an engine out.
const ENGINE_ORDER = Object.freeze(['azure', 'google', 'mistral']);
// Azure layout is the table specialist; Google Document AI is the strongest
// general OCR rescue; Mistral is the independent third perspective.
const TABLE_PRIMARY = 'azure';

// A page is "weak" (and worth a targeted re-read) below this word-confidence
// floor. High-materiality documents use a STRICTER floor — we tolerate less
// uncertainty where the numbers matter.
const CONFIDENCE_FLOOR = Object.freeze({ high: 0.80, medium: 0.65, low: 0.55 });
// A digital-born PDF whose native text layer averages at least this many
// characters per page is trustworthy enough to read directly (skip OCR) — a
// scanned PDF has a near-empty text layer and falls back to OCR.
const NATIVE_TEXT_MIN_CHARS_PER_PAGE = 200;

function profileFor(docType) {
  return Object.assign({}, DEFAULT_PROFILE, FAMILY_PROFILES[docType] || {});
}

// Which engines are usable right now (configured AND healthy). availability is
// {azure,google,mistral} booleans (configured); providerHealth is an optional
// {azure,google,mistral} of recent success (a provider that's been failing is
// deprioritized but not removed — it may still be the only option).
function usableEngines(features) {
  const avail = (features && features.availability) || { azure: true, google: true, mistral: true };
  const health = (features && features.providerHealth) || {};
  const configured = ENGINE_ORDER.filter((e) => avail[e] !== false);
  // Stable sort: healthy engines first, preserving ENGINE_ORDER within each tier.
  return configured
    .map((e, i) => ({ e, i, healthy: health[e] !== false }))
    .sort((a, b) => (a.healthy === b.healthy ? a.i - b.i : (a.healthy ? -1 : 1)))
    .map((x) => x.e);
}

// Is the PDF's native (digital-born) text layer reliable enough to read
// directly? Only for real PDFs with a dense text layer and no scan-quality flag.
function nativeTextReliable(features) {
  if (!features || features.hasNativeText !== true) return false;
  // Only a PDF has a native text layer. Require the MIME to explicitly say PDF —
  // an empty/missing or non-PDF MIME is never trusted to skip OCR (a mistyped
  // image asserting hasNativeText must still be OCR'd).
  const mime = String(features.mimeType || '').toLowerCase();
  if (mime.indexOf('pdf') === -1) return false;
  const pages = Number(features.pageCount) || 1;
  const chars = Number(features.nativeTextChars) || 0;
  if (chars / pages < NATIVE_TEXT_MIN_CHARS_PER_PAGE) return false;
  // A scan flagged as low-quality/rotated is NOT a clean digital text layer.
  const sq = features.scanQuality || {};
  if (sq.scanned === true || (sq.lowQualityPages || 0) > 0) return false;
  return true;
}

/**
 * planRoute(features) → the routing plan for ONE document.
 *
 * @param {{
 *   docType?: string,            // classifier family (drives the profile)
 *   mimeType?: string,
 *   pageCount?: number,
 *   bytes?: number,
 *   hasNativeText?: boolean,     // the PDF carries a native text layer
 *   nativeTextChars?: number,    // total chars in that native layer
 *   appraisalXmlPresent?: boolean, // a MISMO/appraisal XML sidecar exists
 *   scanQuality?: { scanned?, lowQualityPages?, rotatedPages?, avgDpi? }, // from page-quality
 *   availability?: { azure?, google?, mistral? }, // which engines are configured
 *   providerHealth?: { azure?, google?, mistral? }, // recent success per engine
 * }} features
 * @returns {{
 *   primary: string, challenger: (string|null), fallbacks: string[],
 *   reread: { enabled: boolean, confidenceFloor: number },
 *   specialHandling: string[], materiality: string, numericCritical: boolean,
 *   reasons: string[]
 * }}
 */
function planRoute(features = {}) {
  const f = features || {};
  const prof = profileFor(f.docType);
  const reasons = [];
  const specialHandling = [];
  const engines = usableEngines(f);

  // ---- 1. Deterministic sources beat OCR when present. ----
  // Appraisal MISMO XML → parse the XML, never OCR (exact, free, no misread).
  if (prof.preferAppraisalXml && f.appraisalXmlPresent === true) {
    specialHandling.push('prefer_appraisal_xml');
    reasons.push('an appraisal XML sidecar is present — parse the XML instead of OCR (exact, no misread)');
    return {
      primary: 'appraisal_xml',
      challenger: engines[0] || null, // still OCR the PDF as a cross-check on the numbers
      fallbacks: engines,
      reread: { enabled: false, confidenceFloor: CONFIDENCE_FLOOR[prof.materiality] || 0.65 },
      specialHandling,
      materiality: prof.materiality,
      numericCritical: prof.numericCritical,
      reasons,
    };
  }
  // A reliable native PDF text layer → read it directly (cheaper + exact).
  if (nativeTextReliable(f)) {
    specialHandling.push('prefer_native_text');
    reasons.push('the PDF has a dense, clean native text layer — read it directly, skip OCR');
    // A numeric-critical document still gets ONE OCR pass as a challenger to
    // catch a native layer that lies (a re-saved / doctored PDF).
    const challenger = prof.numericCritical ? (engines[0] || null) : null;
    if (challenger) reasons.push('numeric-critical — one OCR pass challenges the native text layer');
    return {
      primary: 'native_pdf',
      challenger,
      fallbacks: engines,
      reread: { enabled: false, confidenceFloor: CONFIDENCE_FLOOR[prof.materiality] || 0.65 },
      specialHandling,
      materiality: prof.materiality,
      numericCritical: prof.numericCritical,
      reasons,
    };
  }

  // ---- 2. OCR path — pick the primary by layout, then a mandatory/optional challenger. ----
  let primary = engines[0] || 'azure';
  if (prof.tables && engines.includes(TABLE_PRIMARY)) {
    primary = TABLE_PRIMARY;
    specialHandling.push('preserve_tables');
    reasons.push('table-dense document — Azure prebuilt-layout preserves table structure best');
  } else {
    reasons.push(`primary reader ${primary} (first healthy, configured engine)`);
  }

  // The challenger is a DIFFERENT engine. Mandatory for numeric-critical docs
  // (read twice, reconcile the numbers); optional otherwise (only used if the
  // primary read is weak — the router decides that at read time).
  const others = engines.filter((e) => e !== primary);
  const challenger = others[0] || null;
  if (prof.numericCritical && challenger) {
    specialHandling.push('mandatory_challenger');
    reasons.push(`numeric-critical ${f.docType || 'document'} — a second reader (${challenger}) is mandatory; reconcile the numbers and flag disagreement for a human`);
  } else if (challenger) {
    reasons.push(`challenger ${challenger} available if the primary read is weak`);
  }

  if (prof.signatures) { specialHandling.push('detect_signatures'); }
  if (prof.handwriting) { specialHandling.push('handwriting_hint'); }

  // Re-read weak pages: always enabled for real OCR. The floor is stricter for
  // high-materiality documents.
  const confidenceFloor = CONFIDENCE_FLOOR[prof.materiality] || 0.65;

  return {
    primary,
    challenger,
    fallbacks: others,
    reread: { enabled: true, confidenceFloor },
    specialHandling,
    materiality: prof.materiality,
    numericCritical: prof.numericCritical,
    reasons,
  };
}

/**
 * weakPages(pages, floor) → the 1-based page numbers whose OCR word-confidence
 * is below `floor` and are therefore worth a targeted re-read by the challenger.
 * `pages` is an array of { pageNumber?, confidence?, words?:[{confidence}] };
 * a page's confidence is its own `confidence` or the mean of its word
 * confidences. Pages with no confidence signal are treated as NOT weak (absence
 * of a signal is not evidence of a bad read).
 */
function weakPages(pages, floor) {
  const lo = Number.isFinite(floor) ? floor : 0.65;
  const out = [];
  (pages || []).forEach((p, i) => {
    const c = pageConfidence(p);
    if (c != null && c < lo) out.push(p && p.pageNumber != null ? Number(p.pageNumber) : i + 1);
  });
  return out;
}

function pageConfidence(p) {
  if (!p) return null;
  if (Number.isFinite(p.confidence)) return p.confidence;
  const words = Array.isArray(p.words) ? p.words.filter((w) => w && Number.isFinite(w.confidence)) : [];
  if (!words.length) return null;
  return words.reduce((a, w) => a + w.confidence, 0) / words.length;
}

// Extract comparable MONEY tokens from a block of text — used to reconcile two
// independent reads of a numeric-critical document. Deliberately narrow: it
// matches only money-SHAPED numbers (a $ prefix, comma-grouped thousands, or a
// two-decimal cents amount) so it does NOT reconcile — and raise false
// disagreements on — bare integers like a header year (2026), an account/loan
// number, or a ZIP. A leading minus is captured so a -500 debit does not
// falsely agree with a +500 credit.
function numericTokens(text) {
  const s = String(text || '');
  const set = new Set();
  // Alternatives (comma-grouped forms first so a "$42,318.55" is matched whole,
  // never split): $-comma / comma / $-plain / cents.
  const re = /(-)?\s*(\$\s*\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\$\s*\d+(?:\.\d{1,2})?|\d+\.\d{2})/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const sign = m[1] === '-' ? -1 : 1;
    const norm = m[2].replace(/[$\s,]/g, '');
    const val = Number(norm) * sign;
    if (Number.isFinite(val) && Math.abs(val) >= 100) set.add(Math.round(val * 100) / 100);
  }
  return set;
}

/**
 * reconcileNumbers(primaryText, challengerText) → { agree, onlyInPrimary, onlyInChallenger, disagreement }.
 * Compares the material numbers two independent readers extracted. A number the
 * primary read but the challenger did not (or vice-versa) is a DISAGREEMENT worth
 * a human's eyes on a numeric-critical document — advisory, never auto-acted.
 */
function reconcileNumbers(primaryText, challengerText) {
  const a = numericTokens(primaryText);
  const b = numericTokens(challengerText);
  const onlyInPrimary = [...a].filter((x) => !b.has(x));
  const onlyInChallenger = [...b].filter((x) => !a.has(x));
  const agree = [...a].filter((x) => b.has(x));
  return {
    agree,
    onlyInPrimary,
    onlyInChallenger,
    // Any material number that appears in exactly one read is a disagreement.
    disagreement: onlyInPrimary.length > 0 || onlyInChallenger.length > 0,
  };
}

module.exports = {
  planRoute,
  weakPages,
  reconcileNumbers,
  profileFor,
  FAMILY_PROFILES,
  CONFIDENCE_FLOOR,
  _internals: { usableEngines, nativeTextReliable, pageConfidence, numericTokens },
};
