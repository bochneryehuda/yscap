'use strict';
/**
 * WHAT THE APPRAISAL SAYS THE PROPERTY *IS* — the CATEGORY (single family / 2–4 / condo / …),
 * read off the appraisal's own evidence rather than off the attachment STYLE.
 *
 * OWNER-REPORTED 2026-08-02, showing the data-comparison row verbatim:
 *
 *     Property type      Detached      Multi 2–4
 *
 * *"You're taking the property type from the wrong place … we're not interested in the detached or
 * if it's attached. We need you to find if on the appraisal, if it's a single family, or if it's a
 * 2–4, or if it's a condo, or any other property type … we have this issue with appraisal findings,
 * with document findings, and with data validation / data compare."*
 *
 * ROOT CAUSE. `extract.js` read the subject's property type from `PROPERTY/STRUCTURE/@AttachmentType`
 * — the MISMO **attachment style**, whose entire controlled value list is `Detached` / `Attached`.
 * That is a statement about whether the building touches its neighbour; it says NOTHING about how
 * many dwellings are in it or what kind of ownership it is. A detached building is just as easily a
 * duplex as a single-family house. That one value then flowed EVERYWHERE, because it is the only
 * thing the appraisal ever stored under the name "property type":
 *   · `appraisals.property_type`                  (the stored fact)
 *   · the Appraisal tab's "Property type" row     (a reviewer reads "Detached")
 *   · `underwriting/file-review.js`               → the tie-out matrix + the appraisal-tab
 *                                                   Data comparison → the owner's screenshot
 *   · `underwriting/facts.js` DOC_CLAIMS.appraisal → the document-review desk
 * The 2026-07-27 patch made a bare style UNCOMPARABLE (`facts.canonPropertyType` returns null), which
 * stopped the false mismatch but left the real problem standing: the appraisal column simply printed
 * a word that is not an answer to the question being asked.
 *
 * WHAT THE APPRAISAL ACTUALLY CARRIES. The category is genuinely in the file, in three places, and
 * the appraisal desk was already using two of them for a DIFFERENT check:
 *   1. **The FORM.** 1004 URAR → one-unit; 1025 Small Residential Income → 2–4 family; 1073 →
 *      individual condominium. An appraiser cannot report a duplex on a 1004 or a condo on a 1025 —
 *      the forms are written for a category and the agencies will not accept them otherwise. This is
 *      the HARD statement, and it is already encoded ONCE in `property-type.appraisalFormExpectation`
 *      (owner-directed 2026-07-26); this module reuses it rather than restating it, so "what does a
 *      1025 prove" can never have two answers in this codebase.
 *   2. **`STRUCTURE/@LivingUnitCount`** — the authoritative dwelling count (docs/appraisal-xml/
 *      1025-SmallIncome-field-map.md: *"Authoritative unit count (2/3/4). Do not count
 *      _UNIT_GROUP/UNIT_RENT_SCHEDULE elements."*).
 *   3. **The ownership / project signals** that separate the one-dwelling kinds from each other:
 *      `STRUCTURE/@PropertyCategoryType` (the appraiser's own words when present), the UAD
 *      `GSE_PUDIndicator`, the `PROJECT` block, and `STRUCTURE/@_DesignDescription`.
 *
 * NEVER GUESS — the discipline this module is built around:
 *   · The attachment style decides NOTHING. It is carried through as its own separate fact so the
 *     data is not lost, and it is never allowed to become a category.
 *   · With no unit count and no recognizable form there is no answer, so the answer is `null`
 *     (uncomparable) — never a bucket picked because it is the common one.
 *   · When the form and the unit count disagree (a 1025 reporting one unit), nothing is stated
 *     confidently: the form wins the band, `conflict` is set and the confidence drops to `likely`,
 *     which is exactly what `appraisal-underwriter.appraisal_form_units_mismatch` already raises for
 *     a human. PILOT must never sound certain off contradictory evidence.
 *   · A condo is claimed only from the condominium FORM or the appraiser's own category words —
 *     never from an HOA fee or a project name, because a PUD has both.
 *
 * PURE — no requires beyond the portal's own property-type vocabulary, no DB, no network — so the
 * XML importer, the boot repair for previously-imported appraisals, the tie-out and the findings
 * all read the SAME answer. `scripts/test-appraisal-property-category.js`.
 */

const { LABEL_OF, appraisalFormExpectation } = require('../property-type');

// Lowercase, punctuation folded to single spaces. Keeps digits (unit counts) and folds the en dash
// so "Multi 2–4" and "multi 2-4" read alike.
function norm(v) {
  return String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * The MISMO attachment STYLE — the controlled list is Detached / Attached (plus the semi-detached
 * and end/interior-unit spellings some vendors emit). A value that is ONLY this is not a property
 * type and must never be stored or compared as one. A phrase that carries a real category word
 * ("single family detached") is NOT a bare style — the category word is the answer there.
 */
const STYLE_ONLY_RE = /^(detached|attached|semi detached|semidetached|end unit|interior unit|middle unit|det|att)$/;
function isAttachmentStyle(v) {
  const s = norm(v);
  return !!s && STYLE_ONLY_RE.test(s);
}

function intOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n < 10000 ? Math.round(n) : null;
}
// A UAD yes/no indicator: 'Y'/'Yes'/true → true, 'N'/'No'/false → false, anything else → null
// (absent is NOT "no" — the 1025s in the corpus carry no PUD indicator at all).
function ynOrNull(v) {
  if (v === true || v === false) return v;
  const s = norm(v);
  if (!s) return null;
  if (/^(y|yes|true|1)$/.test(s)) return true;
  if (/^(n|no|false|0)$/.test(s)) return false;
  return null;
}

// Every text signal that could name a category, joined once so each test below reads it all.
function categoryWords(sig) {
  return [sig.propertyCategoryType, sig.designDescription, sig.propertyTypeText]
    .map(norm).filter(Boolean).join(' ');
}

const CONDO_RE = /\bcondo|condominium/;
const TOWNHOUSE_RE = /town\s?house|town\s?home|row\s?house|row\s?home/;
const PUD_RE = /\bpud\b|planned unit/;
const MIXED_RE = /mixed use/;

/**
 * The appraisal's property CATEGORY, in the portal's own vocabulary.
 *
 * @param {object} sig
 *   formType            'FNM1004' | 'FNM1025' | 'FNM1073' | '2055' | … (any spelling the
 *                       `property-type.appraisalFormExpectation` matcher accepts)
 *   units               the authoritative dwelling count (STRUCTURE/@LivingUnitCount)
 *   attachmentType      'Detached' / 'Attached' — carried, NEVER used to decide
 *   propertyCategoryType STRUCTURE/@PropertyCategoryType, when the appraiser stated one
 *   pudIndicator        the UAD GSE_PUDIndicator ('Y' / 'N')
 *   projectDesignType   PROJECT/@_DesignType ('MidriseProject', 'RowhouseProject', …)
 *   designDescription   STRUCTURE/@_DesignDescription ('Colonial', 'Townhouse', …)
 *   propertyTypeText    any other free-text the appraisal calls the property
 *
 * @returns {{key,label,confidence,conflict,basis:string[],attachmentType}|null}
 *   `null` whenever the appraisal does not say — never a guessed bucket.
 */
function derivePropertyCategory(sig) {
  const s = sig || {};
  const basis = [];
  const units = intOrNull(s.units);
  const formExp = appraisalFormExpectation(s.formType);   // {propertyKey,label,minUnits,maxUnits}|null
  const words = categoryWords(s);
  const style = isAttachmentStyle(s.attachmentType) ? String(s.attachmentType).trim() : null;

  const out = (key, confidence, conflict) => (LABEL_OF[key] ? {
    key, label: LABEL_OF[key], confidence, conflict: !!conflict, basis, attachmentType: style,
  } : null);

  // ── 1. THE UNIT BAND — how many dwellings ────────────────────────────────────────────────────
  // The unit count is the direct physical reading; the form is the hard statement about the
  // category it was written for. They almost always agree. When they do not, the form wins (the
  // owner's own rule) but nothing is stated confidently.
  let band = null;                       // 'one' | 'two_to_four' | 'five_plus'
  let conflict = false;
  const bandOf = (n) => (n >= 5 ? 'five_plus' : (n >= 2 ? 'two_to_four' : 'one'));
  const formBand = formExp ? (formExp.maxUnits >= 5 ? 'five_plus' : (formExp.minUnits >= 2 ? 'two_to_four' : 'one')) : null;

  if (units != null) {
    band = bandOf(units);
    basis.push(`the appraisal reports ${units} unit${units === 1 ? '' : 's'}`);
  }
  if (formBand) {
    basis.push(`the appraisal is written on the ${formExp.label} form`);
    if (band && band !== formBand) {
      // The report contradicts itself. `appraisal-underwriter.appraisal_form_units_mismatch`
      // already puts that in front of a human; here it only costs us our certainty.
      conflict = true;
      band = formBand;
      basis.push('the form and the unit count disagree — the form is the stronger statement, but this needs a human');
    } else if (!band) {
      band = formBand;
    }
  }
  // Nothing readable said how many dwellings there are → the appraisal does not answer the
  // question. Uncomparable, never guessed.
  if (!band) return null;

  if (band === 'five_plus') return out('multi_5_plus', conflict ? 'likely' : 'definite', conflict);
  if (band === 'two_to_four') return out('multi_2_4', conflict ? 'likely' : 'definite', conflict);

  // ── 2. ONE DWELLING — which KIND ─────────────────────────────────────────────────────────────
  // A 1004 covers a detached house, a townhouse AND a PUD unit, so "one unit" is not yet an answer.
  // Ordered most-specific first; each arm needs REAL evidence, and the fall-through is a plain
  // single-family residence, which is what a one-unit dwelling with nothing else said about it is.
  if (MIXED_RE.test(words)) {
    basis.push('the appraisal describes the property as mixed use');
    return out('mixed_use', 'likely', conflict);
  }
  // A condo is claimed ONLY from the condominium form or the appraiser's own category words. An
  // HOA fee and a project name are NOT proof — a PUD carries both.
  if (formExp && formExp.propertyKey === 'condo') {
    basis.push('the 1073 is the individual-condominium form');
    return out('condo', conflict ? 'likely' : 'definite', conflict);
  }
  if (CONDO_RE.test(words)) {
    basis.push('the appraiser recorded the property as a condominium');
    return out('condo', 'definite', conflict);
  }
  if (TOWNHOUSE_RE.test(words)) {
    basis.push('the appraiser describes the dwelling as a townhouse / rowhouse');
    return out('townhouse', 'definite', conflict);
  }
  const pud = ynOrNull(s.pudIndicator);
  if (pud === true || PUD_RE.test(words)) {
    basis.push(pud === true ? 'the appraisal’s PUD indicator is set' : 'the appraiser describes the property as a planned unit development');
    return out('pud', 'definite', conflict);
  }
  if (pud === false) basis.push('the appraisal’s PUD indicator is "no"');
  basis.push('one dwelling unit, with no condominium, townhouse or PUD signal on the report');
  // A one-unit dwelling backed by a hard one-unit form (1004/1073) is a confident single family;
  // one derived only from a unit count on some other form is a reading, not a statement.
  return out('sfr', (formBand === 'one' && !conflict) ? 'definite' : 'likely', conflict);
}

/**
 * The same derivation, fed from a STORED `appraisals` row — used by the boot repair for appraisals
 * imported before this existed and by every read surface, so a row the repair has not reached yet
 * still shows the right thing. Reads the extra signals out of the row's `fields` jsonb (where
 * `buildFieldsJson` puts every `subject.*` key) and falls back to a legacy `property_type` that is
 * holding the attachment style.
 */
function fromAppraisalRow(row) {
  if (!row) return null;
  const f = row.fields && typeof row.fields === 'object' ? row.fields : {};
  const fv = (k) => (f[k] && typeof f[k] === 'object' ? f[k].value : undefined);
  const legacy = row.property_type;
  return derivePropertyCategory({
    formType: row.form_type,
    units: row.units,
    // A legacy row stored the STYLE in property_type; a repaired one has it in attachment_type.
    attachmentType: row.attachment_type != null ? row.attachment_type : (isAttachmentStyle(legacy) ? legacy : null),
    propertyCategoryType: row.property_category_type != null ? row.property_category_type : fv('subject.propertyCategoryType'),
    pudIndicator: row.pud_indicator != null ? row.pud_indicator : fv('subject.pudIndicator'),
    projectDesignType: row.condo_project_type != null ? row.condo_project_type : fv('subject.projectDesignType'),
    designDescription: row.design_style,
    // A legacy property_type that is NOT a bare style is real text the appraiser wrote — keep
    // reading it (it may be the category itself, e.g. "Condominium").
    propertyTypeText: isAttachmentStyle(legacy) ? null : legacy,
  });
}

/** The portal-vocabulary label for a stored appraisal row, or null when the appraisal doesn't say. */
function categoryLabelFor(row) {
  if (row && row.property_category && LABEL_OF[row.property_category]) return LABEL_OF[row.property_category];
  const d = fromAppraisalRow(row);
  return d ? d.label : null;
}

/**
 * Present a stored appraisal row's property-type fields correctly, WHATEVER state the boot repair
 * has reached — so a screen is right on the first deploy rather than after the sweep drains, and a
 * legacy row never shows "Detached" under a heading that asks what the property is.
 *
 *   property_type    → the CATEGORY, or null when the appraisal does not say
 *   attachment_type  → the Detached / Attached style (moved out of property_type if that is where
 *                      it is still sitting)
 *
 * Mutates and returns the row (a fresh query result), or null/undefined unchanged. Never throws.
 */
function applyPropertyType(row) {
  if (!row) return row;
  try {
    const legacyStyle = isAttachmentStyle(row.property_type) ? String(row.property_type).trim() : null;
    if (row.attachment_type == null && legacyStyle) row.attachment_type = legacyStyle;
    const label = categoryLabelFor(row);
    // Only ever replace a value we can improve on: a real category, or a style that has just been
    // moved to its own field. Real appraiser text we have nothing better than is left alone.
    if (label) row.property_type = label;
    else if (legacyStyle) row.property_type = null;
  } catch (_) { /* presentation only — never break a read */ }
  return row;
}

module.exports = {
  derivePropertyCategory,
  fromAppraisalRow,
  categoryLabelFor,
  applyPropertyType,
  isAttachmentStyle,
  _internals: { norm, ynOrNull, intOrNull, categoryWords },
};
