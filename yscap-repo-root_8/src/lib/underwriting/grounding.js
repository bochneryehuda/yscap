'use strict';
/**
 * Grounding — the "real reasoning, not guessing" guarantee. After the AI extracts fields, we
 * VERIFY each extracted value against what the OCR reader physically read off the page. If the AI
 * returned a value whose text does not appear in the document's OCR at all, that value is very
 * likely a hallucination — and we must never underwrite against a value the document doesn't
 * actually contain (the owner's absolute rule). So grounding checks every meaningful extracted
 * value against the OCR text and reports which values are CONFIRMED, which are UNCONFIRMED, and
 * which weren't checkable — the engine then flags the unconfirmed ones for a human and never lets
 * them silently drive a finding.
 *
 * This runs on the OCR text we already have (no extra AI call), so it's fast, deterministic, and
 * testable. It is intentionally tolerant of formatting (OCR spacing/punctuation, $ and commas on
 * money, date separators) so it flags genuine fabrication, not cosmetic differences.
 *
 * Pure + dependency-light (compare.js only).
 */
const { norm, digitsOnly, num, toISODate } = require('./compare');
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

// A date is "grounded" if any common written form of it appears in the (normalized, punctuation-
// stripped) OCR text — so an extracted ISO date "1980-05-15" still matches an OCR that printed
// "05/15/1980" or "May 15, 1980". Order-tolerant across US / ISO / international / month-name forms.
function dateGrounded(iso, hay) {
  // Strip ALL separators from the OCR text so a date matches regardless of how it was punctuated
  // ("2026-08-15", "08/15/2026", "May 15, 2026" all compare equal after compaction).
  const compact = String(hay || '').replace(/[^a-z0-9]+/g, '');
  const [y, m, d] = iso.split('-');
  const m1 = String(+m), d1 = String(+d), mon = MONTHS[+m - 1];
  const forms = [
    `${y}${m}${d}`, `${m}${d}${y}`, `${m1}${d1}${y}`, `${d}${m}${y}`,
    `${mon}${d1}${y}`, `${mon}${d}${y}`, `${d1}${mon}${y}`,
  ];
  return forms.some((f) => compact.indexOf(f) !== -1);
}

// Keys we never grade (structural / model-authored, not copied off the page).
const SKIP_KEYS = new Set(['readable', 'notes', 'holderisbusiness', 'isassignment', 'insfha', 'policypresent', 'buildersrisk', 'mortgageeclausepresent', 'assignorsigned', 'assigneesigned', 'signed', 'authorizesborrowing', 'ismanager', 'mortgagelates', 'hasbankruptcy', 'hasforeclosure', 'hasjudgmentorlien', 'pephit', 'hascriminalrecord']);
// DERIVED / CLASSIFICATION keys the model ASSIGNS or INFERS rather than transcribes off the page —
// a member's `type` enum, an INFERRED single-member `ownershipPct` (100%), a `propertyType` /
// `accountType` / `entityType` classification. Their value is rarely a literal substring of the
// document, so grounding them by text-match produces a FALSE "could not be confirmed in the document
// text" finding even when the document was read perfectly (owner-reported 2026-07-21: an operating
// agreement's members[0].ownershipPct / members[0].type flagged though the OA read fine). We never
// GRADE or ESCALATE these — grounding is for values the AI TRANSCRIBED (names, addresses, amounts,
// EIN, DOB, dates), where absence from the text is a real fabrication signal.
const DERIVED_KEY = /(type$|^kind$|^role$|pct$|percent$|percentage$)/;
// Critical field name fragments — an UNCONFIRMED value here is worth a finding (identity / money /
// entity / property / authority). member|manager catches a fabricated managing member.
const CRITICAL = /(name|holder|owner|seller|buyer|member|manager|address|price|amount|fee|balance|ein|dob|dateofbirth|score|value|arv|loan)/i;

// Coverage of an extracted value in the OCR text: the match cascade the research recommends —
// (1) numbers → the digit run must appear in the OCR's digits (robust to $ / commas / spacing);
// (2) strings → whole-value normalized substring (exact/normalized tier) → else fraction of the
// value's significant words present (fuzzy-ish tier). Returns { checkable, coverage:0..1 }.
function coverageOf(value, hay, hayDigits) {
  if (value == null || value === '') return { checkable: false, coverage: 0 };
  // Dates first: an ISO date must be matched by ANY written form (US / month-name / intl), never by
  // literal ISO substring — real documents rarely print ISO. Marked isDate so it's never escalated
  // as "fabricated" (date formats are too variable to be sure), only scored.
  const iso = typeof value === 'string' ? toISODate(value) : null;
  if (iso) return { checkable: true, coverage: dateGrounded(iso, hay) ? 1 : 0, isDate: true };
  const n = num(value);
  if (typeof value === 'number' || (n != null && /^[\s$,.\d-]+$/.test(String(value)))) {
    const d = digitsOnly(value);
    if (d.length < 2) return { checkable: false, coverage: 0 };
    return { checkable: true, coverage: hayDigits.indexOf(d) !== -1 ? 1 : 0 };
  }
  const whole = norm(String(value));
  if (whole && hay.indexOf(whole) !== -1) return { checkable: true, coverage: 1 };
  const tokens = whole.split(/\s+/).filter((t) => t.length >= 2);
  if (!tokens.length) return { checkable: false, coverage: 0 };
  const found = tokens.filter((t) => hay.indexOf(t) !== -1).length;
  return { checkable: true, coverage: found / tokens.length };
}

function walk(obj, prefix, hay, hayDigits, out) {
  if (obj == null) return;
  if (Array.isArray(obj)) { obj.forEach((v, i) => walk(v, `${prefix}[${i}]`, hay, hayDigits, out)); return; }
  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      const kl = k.toLowerCase();
      // Skip structural/model-authored keys AND derived/classification keys (type enums, inferred
      // percentages) — neither is transcribed off the page, so neither can be grounded by text match.
      if (SKIP_KEYS.has(kl) || DERIVED_KEY.test(kl)) continue;
      walk(v, prefix ? `${prefix}.${k}` : k, hay, hayDigits, out);
    }
    return;
  }
  if (typeof obj === 'boolean') return;
  const c = coverageOf(obj, hay, hayDigits);
  if (!c.checkable) return;
  // A date is scored but never ESCALATED as fabricated (formats vary too much to be certain).
  out.push({ field: prefix, value: obj, coverage: c.coverage, critical: CRITICAL.test(prefix) && !c.isDate });
}

/**
 * @param {object} fields   the AI-extracted fields
 * @param {string} ocrText  the OCR reader's text for the same document
 * @returns {{ checked, confirmed, score, unconfirmed:Array, criticalAbsent:Array<{field,value}> }}
 *   confirmed      — coverage ≥ 0.5 (the value's text is in the document)
 *   unconfirmed    — coverage < 0.5 (reported, for the confidence score)
 *   criticalAbsent — a CRITICAL field whose value has ZERO words in the document (the fabrication
 *                    signal we escalate; a partial match is treated as OCR noise, not fabrication —
 *                    same false-positive discipline as the fraud scan)
 */
function groundFields(fields, ocrText) {
  const hay = norm(ocrText || '');
  const hayDigits = digitsOnly(ocrText || '');
  // Abstain when there's too little OCR text to verify against — a near-empty read is "illegible",
  // not proof of fabrication (the research's not_found-vs-illegible distinction). Never flag then.
  if (hay.replace(/\s/g, '').length < 24) return { checked: 0, confirmed: 0, score: null, unconfirmed: [], criticalAbsent: [] };
  const results = [];
  walk(fields || {}, '', hay, hayDigits, results);
  const confirmed = results.filter((r) => r.coverage >= 0.5);
  const unconfirmed = results.filter((r) => r.coverage < 0.5).map((r) => ({ field: r.field, value: r.value, critical: r.critical, coverage: r.coverage }));
  const criticalAbsent = results.filter((r) => r.critical && r.coverage === 0).map((r) => ({ field: r.field, value: r.value }));
  return {
    checked: results.length,
    confirmed: confirmed.length,
    score: results.length ? Math.round((confirmed.length / results.length) * 100) : null,
    unconfirmed,
    criticalAbsent,
  };
}

// Build the advisory finding when critical extracted values are ABSENT from the document text.
function groundingFinding(docType, grounding) {
  if (!grounding || !grounding.criticalAbsent || !grounding.criticalAbsent.length) return null;
  const names = grounding.criticalAbsent.map((u) => u.field).join(', ');
  return {
    source: docType, code: 'values_unconfirmed_in_document', severity: 'warning', status: 'open',
    field: 'grounding', blocksCtc: false,
    docValue: names, fileValue: null,
    title: 'Some read values could not be confirmed in the document text',
    howTo: `PILOT extracted these values but could not find them in the document's own text: ${names}. This can mean the copy is poor OR a value was mis-read — confirm them by hand before relying on them, and re-scan a clearer copy if needed.`,
    actions: ['post_condition', 'request_document', 'dismiss'],
    opensCondition: 'underwriting_review_cleared',
  };
}

module.exports = { groundFields, groundingFinding, _internals: { coverageOf } };
