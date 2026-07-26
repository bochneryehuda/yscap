'use strict';

/**
 * property-type.js — ONE semantic reading of the free-text property type
 * (owner-reported 2026-07-26: "Property type: FNM1025 → Multi 2–4; Term: 12 →
 * 12 Months" demanded a re-register on a file whose property type never
 * actually changed).
 *
 * TWO ROOT CAUSES, both of them the SAME class as the db/288 term bug:
 *
 *  1. `FNM1025` IS NOT A PROPERTY TYPE. It is the Fannie Mae APPRAISAL FORM code
 *     for the Small Residential Income (2–4 unit) report — the name of a form,
 *     not a category of building. It reached `applications.property_type`
 *     through the appraisal desk: the appraisal reconciler raises a
 *     property-type finding whose "appraisal value" is the form code, and that
 *     value used to be writable back onto the file ("use the appraisal's
 *     value"). The write-back door is closed today (`REPRICE_COLS` in
 *     src/routes/appraisal.js excludes property_type, and the findings no longer
 *     offer `replace` on it), but NO door ever REFUSED the value — every other
 *     write path (staff details, staff/borrower completeness, ClickUp inbound)
 *     still takes `property_type` as unvalidated free text, so any client,
 *     script or automation can put a form code back in. `sanitizePropertyType()`
 *     is that refusal, mirroring `fields.sanitizeLoanType` (#95).
 *
 *  2. `applications.property_type` is TEXT and is written by several doors in
 *     DIFFERENT spellings for the SAME type: the ClickUp dropdown stores
 *     "Multi 2-4" (hyphen), the portal forms store "Multi 2–4" (en dash), and
 *     the Condition Center writes the canonical KEY "multi_2_4". Every
 *     change-detector that compared the RAW text (the db/190–288 reopen trigger)
 *     therefore saw a re-spelling as a pricing change, flagged the registration
 *     stale, and demanded a pointless re-register — the exact loop db/288 fixed
 *     for `term`, left armed for `property_type`.
 *
 * The ROOT fix is one shared semantic key: two property-type texts are the SAME
 * type when they resolve to the same category. This module is the JS half;
 * db/322 defines the SQL twins `pilot_property_type_norm(text)` and
 * `pilot_is_appraisal_form_code(text)` used by the reopen trigger.
 * KEEP THE TWO IN SYNC.
 *
 * PURE — no requires, no DB — so it unit-tests anywhere
 * (scripts/test-property-type-pure.js).
 */

// The portal's canonical property-type categories. `key` matches the Condition
// Center enum (src/lib/conditions/field-registry.js), `label` matches what the
// portal forms + the ClickUp crosswalk actually store in applications.property_type
// (src/clickup/crosswalk.js `property_type.to`).
const PROPERTY_TYPES = Object.freeze([
  { key: 'sfr', label: 'SFR (1 unit)' },
  { key: 'multi_2_4', label: 'Multi 2–4' },
  { key: 'multi_5_plus', label: 'Multi 5+' },
  { key: 'condo', label: 'Condo' },
  { key: 'townhouse', label: 'Townhouse' },
  { key: 'pud', label: 'PUD' },
  { key: 'mixed_use', label: 'Mixed use' },
]);
const LABEL_OF = Object.freeze(Object.fromEntries(PROPERTY_TYPES.map((p) => [p.key, p.label])));

// Fannie/Freddie APPRAISAL FORM numbers. None of these is a property type — they
// name the REPORT. Kept tight on purpose: a real property type never squashes to
// a bare form number, and this list only decides what to REFUSE, so a value that
// isn't here is passed through untouched (a new ClickUp dropdown option must
// never be silently dropped).
const FORM_NUMBERS = Object.freeze(new Set([
  '1004', '1004c', '1004d', '1025', '1073', '1073a', '2055', '2090', '2095',
  '216', '1007', '70', '72', '465',
]));

/**
 * True when the text is an appraisal FORM code rather than a property type —
 * "FNM1025", "FNM 1025", "fnma-1004", "Form 1073", a bare "1025", "URAR".
 */
function isAppraisalFormCode(raw) {
  if (raw == null) return false;
  const s = String(raw).trim().toLowerCase().replace(/[\s._\-/]+/g, '');
  if (!s) return false;
  if (s === 'urar' || s === 'uad') return true;
  const m = /^(?:fnma|fnm|fannie|fhlmc|fre|freddie|form)?(\d{2,4}[a-d]?)$/.exec(s);
  return !!m && FORM_NUMBERS.has(m[1]);
}

/**
 * The canonical category key for a property-type text, or null when the text is
 * not a property type we recognize (an appraisal form code, a blank, or a
 * genuinely unknown option such as a brand-new ClickUp dropdown value).
 *   'Multi 2–4' / 'Multi 2-4' / 'multi_2_4' / 'Duplex'  → 'multi_2_4'
 *   'SFR (1 unit)' / 'Single Family' / 'Detached'       → 'sfr'
 *   'FNM1025' / '' / 'New Construction'                 → null
 * NEVER guesses a category out of a form code — that is the whole bug.
 */
function propertyTypeKey(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s || isAppraisalFormCode(s)) return null;
  const t = s.toLowerCase();
  // Order matters: the more specific categories win over the generic unit tests.
  if (/mixed/.test(t)) return 'mixed_use';
  if (/condo|co-?op\b|cooperative/.test(t)) return 'condo';
  if (/town\s*(house|home)|townh/.test(t)) return 'townhouse';
  if (/\bpud\b|planned\s*unit/.test(t)) return 'pud';
  if (/5\s*\+|5\s*(or\s*)?more|multi[\s_-]*5|multifamily[\s_-]*5/.test(t)) return 'multi_5_plus';
  if (/2\s*[-–—_ ]?\s*4|duplex|triplex|fourplex|four[\s-]?plex|quad|two[\s-]?to[\s-]?four/.test(t)) return 'multi_2_4';
  if (/sfr|single[\s_-]*family|1\s*unit|one\s*unit|detached/.test(t)) return 'sfr';
  return null;
}

/**
 * Canonical comparison key for a property-type text. A change-detector must
 * treat two texts as EQUAL when their keys are equal.
 *   recognized category  → its canonical key ('multi_2_4')
 *   appraisal form code  → null (it was never a property type)
 *   blank                → null
 *   unrecognized option  → its own squashed text, so it still compares to itself
 *                          ('New Construction' ≡ 'new construction')
 */
function propertyTypeCompareKey(raw) {
  const key = propertyTypeKey(raw);
  if (key) return key;
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s || isAppraisalFormCode(s)) return null;
  const squashed = s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return squashed || null;
}

/** True when two property-type texts mean the same type (equal keys; both-blank counts). */
function propertyTypesEquivalent(a, b) {
  return propertyTypeCompareKey(a) === propertyTypeCompareKey(b);
}

/** The portal's canonical label for a property-type text, or null when unrecognized. */
function canonicalPropertyTypeLabel(raw) {
  const key = propertyTypeKey(raw);
  return key ? LABEL_OF[key] : null;
}

/**
 * The refusal gate every write door runs, mirroring `fields.sanitizeLoanType`.
 * Returns the value unchanged for anything that could be a property type, and
 * NULL for an appraisal form code — which is not a property type and must never
 * be stored. A null return means "do not write this", not "write NULL": the
 * callers skip the field so the file keeps whatever it already had.
 */
function sanitizePropertyType(v) {
  if (v == null || v === '') return null;
  return isAppraisalFormCode(v) ? null : v;
}

/**
 * A human-readable reason a property-type value was refused, or null when it is
 * acceptable. Used by the staff / borrower doors to answer with a 400 that says
 * WHY, instead of silently dropping the field.
 */
function propertyTypeProblem(v) {
  if (v == null || v === '') return null;
  if (!isAppraisalFormCode(v)) return null;
  const label = canonicalPropertyTypeLabel(guessFromFormCode(v));
  return `“${String(v).trim()}” is an appraisal form number, not a property type`
    + (label ? ` — a property on that form is usually “${label}”. Pick the property type on the application.` : '. Pick the property type on the application.');
}

/**
 * The property category a Fannie/Freddie appraisal FORM is written for. Used
 * ONLY to repair files that already carry a form code in property_type (db/322)
 * and to word the refusal message above — never to accept a form code as input.
 * These three mappings are the forms' own definitions (mirrored in
 * src/lib/appraisal/extract.js and docs/appraisal-xml/field-validation-rules.md):
 *   1004 URAR                        → single family, 1 unit
 *   1025 Small Residential Income    → 2–4 unit
 *   1073 Individual Condominium      → condo
 * Any other form number is NOT mapped (a 2055/216/1007 says nothing definite
 * about the category), so it stays unrepaired rather than guessed.
 */
function guessFromFormCode(raw) {
  if (!isAppraisalFormCode(raw)) return null;
  const s = String(raw).trim().toLowerCase().replace(/[\s._\-/]+/g, '');
  if (/1004[cd]?$/.test(s)) return 'sfr';
  if (/1025$|(^|[a-z])72$/.test(s)) return 'multi_2_4';
  if (/1073a?$|(^|[a-z])465$/.test(s)) return 'condo';
  return null;
}

/**
 * WHAT THE APPRAISAL FORM ITSELF PROVES (owner-directed 2026-07-26: "if it's a 1025 appraisal it
 * must match with property type 2–4; if it's a 1073 then it must match with condo; if it's a 1004
 * then it must match with single family").
 *
 * The form number is the single most reliable property-type fact on an appraisal, and it is the one
 * we were not using. An appraiser cannot report a duplex on a 1004 or a condo on a 1025 — the forms
 * are written for a category and Fannie/Freddie will not accept them otherwise. That makes the form
 * a HARD statement about the property, unlike the free-text style word ("Detached"), which is
 * decorative and is deliberately compared against nothing.
 *
 * Each entry gives both what the form says about the CATEGORY and what it says about the UNIT
 * COUNT, because those are two separate claims:
 *   1004 URAR                     → single family, exactly 1 unit
 *   1073 Individual Condominium   → condo,         exactly 1 unit
 *   1025 Small Residential Income → 2–4 family,    2 to 4 units
 * Anything else (2055 exterior-only, 1007 rent schedule, 216 operating income) says nothing
 * definite about the category, so it is absent from the map and every caller stays silent rather
 * than guessing.
 */
const FORM_EXPECTATION = Object.freeze({
  sfr:       { minUnits: 1, maxUnits: 1 },
  condo:     { minUnits: 1, maxUnits: 1 },
  multi_2_4: { minUnits: 2, maxUnits: 4 },
});
function appraisalFormExpectation(raw) {
  const key = guessFromFormCode(raw);
  if (!key) return null;
  const u = FORM_EXPECTATION[key];
  return u ? { propertyKey: key, label: LABEL_OF[key] || key, minUnits: u.minUnits, maxUnits: u.maxUnits } : null;
}

module.exports = {
  PROPERTY_TYPES,
  LABEL_OF,
  isAppraisalFormCode,
  appraisalFormExpectation,
  propertyTypeKey,
  propertyTypeCompareKey,
  propertyTypesEquivalent,
  canonicalPropertyTypeLabel,
  sanitizePropertyType,
  propertyTypeProblem,
  guessFromFormCode,
};
