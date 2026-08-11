/**
 * UAD 3.6 / MISMO 3.6 appraisal → THE SAME CANONICAL OBJECT the 2.6 reader produces.
 *
 * THE CONTRACT, AND WHY IT IS THE WHOLE DESIGN.
 *
 * `extract()` (UAD 2.6) returns one shape, and roughly a dozen modules are built on it:
 * the appraisal findings engine, the desk, the as-is desk and reader, the comp grid, the
 * scoring, the note-buyer checks, the property-category derivation, the research
 * warehouse ingest, `importAppraisal`'s column mapping, and the Appraisal screen the
 * officer actually reads. NONE of them is version-aware, and none of them should become
 * version-aware: the moment a finding rule has to ask "is this a 2.6 file or a 3.6
 * file?", every rule has two behaviours and the second one is the untested one.
 *
 * So this module's job is narrow and strict: read a UAD 3.6 report and return the
 * IDENTICAL shape — `{ ok, formType, subject, values, appraiser, enrich, borrower,
 * comparables, units, income, condo, photos, report, rentalComps, compSplit, warnings }`
 * — with the same key names, the same value types, the same vocabulary (C1–C6, Q1–Q6,
 * Beneficial/Neutral/Adverse, AsIs/SubjectToRepairs/SubjectToCompletion) and the same
 * refusal to guess. Everything downstream then works on a 3.6 report on the day it
 * arrives, with no change and no second code path.
 *
 * WHAT IT ADDS ON TOP, because 3.6 genuinely carries more than 2.6 did:
 *   • `format`   — { model:'3.6', uad36:true, ref, scope, damaged }, so a screen can say
 *                  which standard the report was written to.
 *   • `coverage` — every canonical field, whether it resolved, and WHICH candidate path
 *                  produced it. This is the instrument that finishes the reader against
 *                  the first real sample instead of guessing twice.
 *   • the 3.6-only facts (separate interior/exterior condition & quality, structured
 *     hypothetical conditions and extraordinary assumptions, the comparable's stated
 *     weighting, listing status, ANSI gross building area, scope of work) are carried on
 *     `subject.*` / comparable rows, which `buildFieldsJson` persists VERBATIM into the
 *     fields jsonb. They deliberately do NOT go on `enrich`: `importAppraisal` does
 *     `Object.assign(cols, A.enrich)` straight into an INSERT, so an `enrich` key that is
 *     not an existing column would fail the whole import. New columns are a migration and
 *     a separate, deliberate decision — not a side effect of a reader.
 *
 * WHAT IT WILL NOT DO. It will not invent a value. Where UAD 3.6 states something we
 * cannot yet locate, the field is null and `coverage` says which paths were tried. A
 * report that is not an appraisal, or that carries no comparable grid, is REFUSED with
 * the reason in words — the same posture the 2.6 reader takes.
 *
 * Pure and dependency-free. Input is the XML string; output is a plain object.
 */

'use strict';

const X = require('./xml36');
const M = require('./uad36-map');
const { splitComps } = require('./comp-grid');
const { derivePropertyCategory } = require('./property-category');

// NOTE: injected constant — see `extract.js`; date-only logic must not read the clock.
const CUR_YEAR = 2026;

// Local names that mean "everything below me describes a COMPARABLE, not the subject".
// Kept broad on purpose: the container spelling is one of the things a real sample will
// settle, and a subject field mistakenly read off a comparable is the worst failure this
// reader can have — it would put another house's size on our borrower's collateral.
const COMP_CONTAINERS = [
  'COMPARABLE_SALE', 'COMPARABLE_SALES', 'COMPARABLE_PROPERTY', 'COMPARABLE_PROPERTIES',
  'COMPARABLE', 'COMPARABLES', 'SALES_COMPARISON', 'SALES_COMPARISON_APPROACH',
  'ADDITIONAL_PROPERTY_ANALYZED', 'ADDITIONAL_PROPERTIES_ANALYZED', 'ADDITIONAL_SALE_ANALYZED',
];

// The repeatable element that IS one comparable. First match wins; each is tried in turn.
const COMP_ROW_TAGS = [
  'COMPARABLE_SALE', 'COMPARABLE_PROPERTY', 'COMPARABLE', 'SALES_COMPARISON_PROPERTY',
];

/** True when the node sits inside any comparable container. */
function inComparable(node) {
  let p = node && node.parent;
  while (p) {
    if (COMP_CONTAINERS.includes(p.local)) return true;
    p = p.parent;
  }
  return false;
}

/**
 * Detect a MISMO 3.x / UAD 3.6 appraisal without parsing the whole document.
 *
 * Cheap string tests only — this runs on every uploaded file, including the ones that
 * turn out to be a loan-application export or a photo. Returns the same shape
 * `extract.js#detectMismo` returns, plus `scope` when the file names one.
 */
function detect36(xml) {
  const s = String(xml || '');
  const ref = /MISMOReferenceModelIdentifier\s*=\s*"?(\d+\.\d+(?:\.\d+)?)/i.exec(s);
  const isV3 = (ref && /^3\./.test(ref[1]))
    || /<(?:[A-Za-z_][\w.-]*:)?MESSAGE[\s>]/.test(s)
    || /mismo\.org\/residential\/2009/i.test(s);
  const uad36 = /\bUAD\s*3\.?6\b/i.test(s)
    || (ref != null && /^3\.6/.test(ref[1]))
    || (isV3 && /uniform\s+residential\s+appraisal\s+report/i.test(s));
  // An iLAD loan-application export is a MISMO 3.x file with no appraisal in it. Naming
  // that specifically is the difference between "we need a reader" and "you attached the
  // wrong document" — see the same reasoning in extract.js#detectMismo.
  const isIlad = /\bILAD\b/i.test(s) || /datamodelextension\.org\/Schema\/ILAD/i.test(s);
  const hasGrid = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?(?:${COMP_CONTAINERS.join('|')})[\\s>/]`, 'i').test(s);
  return { model: isV3 ? '3.x' : '2.x', ref: ref ? ref[1] : null, uad36, isIlad, hasGrid };
}

/**
 * Locate the SUBJECT property node.
 *
 * In order: an explicit `SUBJECT_PROPERTY` container; a `PROPERTY` flagged as the subject
 * by its own indicator; the first `PROPERTY` that is not inside a comparable container.
 * Falls back to the document root so that a report whose containers we mis-predicted
 * still resolves fields through the name-pattern sweep rather than returning an empty
 * screen — the sweep is scoped to "not inside a comparable", so it cannot silently pick
 * up a comparable's numbers.
 */
function findSubject(root) {
  const explicit = X.firstDeep(root, 'SUBJECT_PROPERTY');
  if (explicit) return { node: explicit, via: 'SUBJECT_PROPERTY' };

  const properties = X.allDeep(root, 'PROPERTY').filter((p) => !inComparable(p));
  for (const p of properties) {
    const flag = M.bool(X.deepText(p, 'SubjectPropertyIndicator'))
      ?? M.bool(X.deepText(p, 'PropertyValuationSubjectIndicator'));
    if (flag === true) return { node: p, via: 'PROPERTY[SubjectPropertyIndicator]' };
  }
  if (properties.length) return { node: properties[0], via: 'PROPERTY (first non-comparable)' };

  const collateral = X.firstDeep(root, 'COLLATERAL');
  if (collateral) return { node: collateral, via: 'COLLATERAL' };
  return { node: root, via: 'document root (no PROPERTY container found)' };
}

/** Locate the comparable rows. Returns `{ rows, via }`. */
function findComparables(root) {
  for (const tag of COMP_ROW_TAGS) {
    const rows = X.allDeep(root, tag);
    // A container element of the same family (COMPARABLE_SALES holding COMPARABLE_SALEs)
    // must not be counted as a row itself; a row is a node with no same-named descendant.
    const leaves = rows.filter((r) => !r.children.some((c) => COMP_ROW_TAGS.includes(c.local)));
    if (leaves.length) return { rows: leaves, via: tag };
  }
  return { rows: [], via: null };
}

/**
 * THE VALUE, AND WHAT IT MEANS — the highest-risk read in the system, restated for 3.6.
 *
 * 2.6 gives one figure (`PropertyAppraisedValueAmount`) whose MEANING has to be decided
 * from a condition enum plus a narrative scan for hypothetical-condition language,
 * because a renovation report states the after-repair value in the same attribute an
 * as-is report uses. That ambiguity is the reason `as-is-reader.js` and the OCR ladder
 * exist at all.
 *
 * 3.6 IMPROVES THIS AND WE SHOULD TAKE THE IMPROVEMENT. The redesigned URAR carries
 * structured data points for hypothetical conditions and extraordinary assumptions
 * instead of leaving them in prose. So the decision here uses, in order:
 *   1. the stated condition-of-appraisal type (AsIs / SubjectToRepairs / SubjectToCompletion);
 *   2. the STRUCTURED hypothetical-condition data point — present and describing repairs
 *      or completion means the figure is the after-repair value even if (1) says AsIs,
 *      which is exactly the 2.6 trap that a narrative scan had to catch;
 *   3. only then, the narrative sweep, kept as a backstop for producers who still write
 *      the disclosure as prose.
 *
 * `basis` records which of those decided it, and the confidences use the same vocabulary
 * the 2.6 path uses (`definite` / `estimate`), because `import.js` writes them into
 * `as_is_confidence` / `arv_confidence` and the officer condition keys off them.
 */
// The STRICT arm — the appraiser is valuing a house that is not yet in this state. Only
// this overrules an explicit `AsIs`, for the reason the 2.6 reader learned the hard way:
// "the repairs have been completed" is what a POST-REHAB REFINANCE says, and reading that
// as an after-repair report throws the as-is value away on the commonest file this lender
// takes after a flip.
const HYPO_STRICT = /(hypothetical\s+condition|subject\s+to\s+(the\s+)?(completion|repairs?|renovation|alteration|improvements)|as[-\s]?if\s+complete|upon\s+completion)/i;
const HYPO_LOOSE = /(as[-\s]?repaired|after[-\s]?repair|when\s+complete[d]?|as[-\s]?completed)/i;
// Money mined from prose, labelled. Deliberately narrow: a figure only counts when the
// words next to it name which value it is.
const ASIS_RE = /\bas[-\s]?is\b[^$\n]{0,60}\$\s*([\d,]+(?:\.\d{2})?)/i;
const ARV_RE = /\b(?:as[-\s]?repaired|after[-\s]?repair(?:ed)?|as[-\s]?completed|upon\s+completion)\b[^$\n]{0,60}\$\s*([\d,]+(?:\.\d{2})?)/i;

/** Mine one labelled dollar figure out of the narratives; `ceil` rejects an absurd hit. */
function mineMoney(re, texts, ceil) {
  for (const t of texts) {
    const m = re.exec(t);
    if (!m) continue;
    const n = M.money(m[1].replace(/,/g, ''));
    if (n == null) continue;
    if (ceil != null && n > ceil * 1.5) continue; // a figure larger than the report's own value is not this value
    return n;
  }
  return null;
}

/**
 * Decide what the reported figure MEANS, in the 2.6 reader's exact output vocabulary.
 *
 * `basis` is `'ARV'` or `'ASIS'` — the same two tokens `splitComps` and every downstream
 * consumer read — with the reasoning kept beside it in `basisNote`, and the confidences
 * in the same `definite` / `missing` vocabulary `importAppraisal` writes into
 * `as_is_confidence` / `arv_confidence`.
 *
 * NEVER ESTIMATE-STORE. When the report is an after-repair report and states no as-is
 * figure, `asIs` stays null and the source says so — that is what opens the officer
 * condition instead of putting a guessed number on a loan file.
 */
function decideValues({ appraisedValue, condOfAppraisal, hypothetical, texts }) {
  const hypoText = M.clean(hypothetical);
  // A structured hypothetical-condition data point is 3.6's improvement over 2.6, where
  // the same disclosure only ever existed in prose. A bare `true` on the indicator counts
  // as strict: the report is asserting a hypothetical, which is the whole point of it.
  const structuredHypoStrict = !!(hypoText && (HYPO_STRICT.test(hypoText) || /^(true|y|yes|1)$/i.test(hypoText)));
  const structuredHypoLoose = !!(hypoText && HYPO_LOOSE.test(hypoText));
  const hasHypoStrict = structuredHypoStrict || texts.some((t) => HYPO_STRICT.test(t));
  const hasHypo = hasHypoStrict || structuredHypoLoose || texts.some((t) => HYPO_LOOSE.test(t));

  let basis, basisNote;
  if (condOfAppraisal === 'SubjectToRepairs' || condOfAppraisal === 'SubjectToCompletion' || condOfAppraisal === 'SubjectToInspection') {
    basis = 'ARV'; basisNote = `condition=${condOfAppraisal}`;
  } else if (condOfAppraisal === 'AsIs' && hasHypoStrict) {
    basis = 'ARV'; basisNote = 'condition=AsIs but the appraiser states a HYPOTHETICAL condition → ARV';
  } else if (condOfAppraisal === 'AsIs') {
    basis = 'ASIS'; basisNote = 'condition=AsIs';
  } else {
    basis = hasHypo ? 'ARV' : 'ASIS'; basisNote = 'inferred';
  }

  const out = {
    basis, basisNote,
    arv: null, arvConfidence: 'missing', arvSource: null,
    asIs: null, asIsConfidence: 'missing', asIsSource: null,
  };
  if (basis === 'ARV') {
    out.arv = appraisedValue; out.arvConfidence = appraisedValue ? 'definite' : 'missing';
    out.arvSource = `structured (${basisNote})`;
    const a = mineMoney(ASIS_RE, texts, appraisedValue);
    if (a) { out.asIs = a; out.asIsConfidence = 'definite'; out.asIsSource = 'narrative (as-is text)'; }
    else { out.asIsSource = 'not definite — open officer condition'; }
  } else {
    out.asIs = appraisedValue; out.asIsConfidence = appraisedValue ? 'definite' : 'missing';
    out.asIsSource = `structured (${basisNote})`;
    const a = mineMoney(ARV_RE, texts, null);
    if (a) { out.arv = a; out.arvConfidence = 'definite'; out.arvSource = 'narrative (as-repaired text)'; }
    else { out.arvSource = 'as-is-only appraisal — no ARV (expected for a straight as-is report)'; }
  }
  return out;
}

/** Every narrative-ish text in the document, joined — the backstop scan. */
function narrativeTexts(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const el = stack.pop();
    // A data point whose name ends in Description / CommentText / Text and whose value is
    // long enough to be prose rather than a code.
    if (/(Description|CommentText|Comment|Text|Narrative)$/.test(el.local)) {
      const t = X.text(el);
      if (t && t.length > 20) out.push(t);
    }
    for (let k = el.children.length - 1; k >= 0; k--) stack.push(el.children[k]);
  }
  return out;
}

/** One comparable row → the comp object shape the 2.6 reader produces. */
function readComparable(node, i, coverage) {
  const read = M.fieldReader(node, coverage, `comp[${i}]`);
  const C = M.COMPARABLE;

  const street = read('street', C.street, M.clean);
  const city = read('city', C.city, M.clean);
  const state = read('state', C.state, M.upState);
  const zipc = read('zip', C.zip, M.zip);
  const baths = M.bathsFrom(read('bathsFull', C.bathsFull, (v) => v), read('bathsHalf', C.bathsHalf, (v) => v));
  const yearBuilt = read('yearBuilt', C.yearBuilt, M.year);

  const salePrice = read('salePrice', C.salePrice, M.money);
  const gla = read('gla', C.gla, (v) => M.bounded(v, 1e6));
  const adjusted = read('adjustedPrice', C.adjustedPrice, M.money);

  const comp = {
    address: street,
    city, state, zip: zipc,
    // The joined one-line address, matching the 2.6 reader's `addressFull`.
    addressFull: [street, [city, state].filter(Boolean).join(', '), zipc].filter(Boolean).join(' ').trim() || null,
    proximity: read('proximity', C.proximity, (v) => M.capText(v, 120)),
    salePrice,
    adjustedSalePrice: adjusted,
    netAdjustment: read('netAdjustment', C.netAdjustment, (v) => M.signed(v, 1e9)),
    grossAdjustment: read('grossAdjustment', C.grossAdjustment, (v) => M.signed(v, 1e9)),
    saleDate: read('saleDate', C.saleDate, M.ymd),
    contractDate: read('contractDate', C.contractDate, M.ymd),
    gla,
    glaBasis: gla != null ? 'living' : null,
    pricePerSqft: (salePrice != null && gla != null && gla > 0) ? M.round2(salePrice / gla) : null,
    beds: read('beds', C.beds, (v) => M.count(v, 99)),
    bathsFull: baths.full, bathsHalf: baths.half, baths: baths.text,
    totalRooms: read('rooms', C.rooms, (v) => M.count(v, 99)),
    yearBuilt,
    ageYears: yearBuilt != null ? CUR_YEAR - Number(yearBuilt) : null,
    units: read('units', C.units, (v) => M.count(v, 999)),
    conditionUad: read('conditionUad', C.conditionUad, (v) => M.ratingCode(v, 'C')),
    qualityUad: read('qualityUad', C.qualityUad, (v) => M.ratingCode(v, 'Q')),
    conditionText: null, qualityText: null,
    viewRating: read('viewRating', C.viewRating, (v) => M.enumOf(v, M.RATING_3)),
    viewType: read('viewType', C.viewType, M.clean),
    locationRating: read('locationRating', C.locationRating, (v) => M.enumOf(v, M.RATING_3)),
    locationType: read('locationType', C.locationType, M.clean),
    dom: read('dom', C.dom, (v) => { const n = M.count(v, 3000); return n; }),
    saleType: read('saleType', C.saleType, M.clean),
    compDataSource: read('dataSource', C.dataSource, (v) => M.capText(v, 200)),
    belowGradeSqft: read('belowGradeSqft', C.belowGradeSqft, (v) => M.bounded(v, 1e6)),
    belowGradeFinishedSqft: read('belowGradeFinishedSqft', C.belowGradeFinishedSqft, (v) => M.bounded(v, 1e6)),
    concessionAmount: read('concessionAmount', C.concessionAmount, (v) => M.signed(v, 1e9)),
    monthlyRent: read('monthlyRent', C.monthlyRent, (v) => M.bounded(v, 1e8)),
    adjustments: readAdjustments(node),
    // ---- UAD 3.6 additions. Carried per comparable and persisted with the grid; no
    // 2.6 counterpart exists, so nothing downstream depends on them yet.
    weighting: read('weighting', C.weighting, (v) => M.capText(v, 200)),
    listingStatus: read('listingStatus', C.listingStatus, M.clean),
    listPrice: read('listPrice', C.listPrice, M.money),
  };
  // The rating word, when the report states something that is not a UAD code — the same
  // "keep the word beside the code, never instead of it" rule the 2.6 reader follows.
  const rawC = M.clean(M.resolve(node, C.conditionUad).value);
  const rawQ = M.clean(M.resolve(node, C.qualityUad).value);
  if (rawC && !comp.conditionUad) comp.conditionText = M.capText(rawC, 120);
  if (rawQ && !comp.qualityUad) comp.qualityText = M.capText(rawQ, 120);
  return comp;
}

/**
 * The comparable's adjustment lines.
 *
 * 3.6 states each adjustment as its own repeatable element with a type and an amount
 * rather than 2.6's per-feature attribute soup. Everything named `*_ADJUSTMENT` (or
 * `ADJUSTMENT`) below the comparable is collected, keeping the type and the amount, so
 * `net_adjustment` can be reconciled the way the 2.6 grid is.
 */
function readAdjustments(node) {
  const out = [];
  const stack = [node];
  while (stack.length) {
    const el = stack.pop();
    if (el !== node && /ADJUSTMENT$/.test(el.local)) {
      const amount = M.signed(
        X.deepText(el, 'AdjustmentAmount') || X.deepText(el, 'ComparableAdjustmentAmount') || X.text(el), 1e9);
      const type = M.clean(X.deepText(el, 'AdjustmentType') || X.deepText(el, 'ComparableAdjustmentType'))
        || el.local.replace(/_?ADJUSTMENT$/, '').replace(/_/g, ' ').trim() || null;
      const description = M.capText(
        X.deepText(el, 'AdjustmentDescription') || X.deepText(el, 'ComparableAdjustmentDescription'), 200);
      if (amount != null || description) out.push({ type, description, amount });
      if (out.length >= 200) break; // a grid is not unbounded; a corrupt file might be
    }
    for (let k = el.children.length - 1; k >= 0; k--) stack.push(el.children[k]);
  }
  return out;
}

/**
 * Read a UAD 3.6 appraisal.
 *
 * Returns `{ ok:false, format, error }` when the file is not a readable 3.6 appraisal —
 * the caller (`extract`) records that refusal exactly as it does for 2.6 — or the full
 * canonical object when it is.
 */
function extract36(xml) {
  const det = detect36(xml);
  const { root, damaged } = X.parse(xml);

  if (!det.hasGrid) {
    return {
      ok: false,
      format: { model: '3.6', uad36: det.uad36, ref: det.ref, notAnAppraisal: true, ilad: det.isIlad },
      error: det.isIlad
        ? 'This file is a loan-application data export (iLAD), not an appraisal report — it contains no comparable sales grid. Please upload the appraisal XML the appraiser delivered.'
        : 'This file contains no comparable sales grid, so it is not an appraisal report. Please upload the appraisal XML the appraiser delivered.',
    };
  }

  const coverage = {};
  const warnings = [];
  if (damaged) warnings.push({ code: 'xml_damaged', msg: 'the XML was not well-formed; the report was read as far as it parsed — verify against the PDF' });

  // ---- subject ---------------------------------------------------------------
  const subj = findSubject(root);
  const readS = M.fieldReader(subj.node, coverage, 'subject');
  const S = M.SUBJECT;

  const units = readS('units', S.units, (v) => M.count(v, 999));
  const baths = M.bathsFrom(readS('bathsFull', S.bathsFull, (v) => v), readS('bathsHalf', S.bathsHalf, (v) => v));
  const propertyCategoryType = readS('propertyCategoryType', S.propertyCategoryType, M.clean);
  const projectDesignType = readS('projectDesignType', S.projectDesignType, M.clean);
  const attachmentType = readS('attachmentType', S.attachmentType, M.clean);

  const subject = {
    address: readS('street', S.street, M.clean),
    city: readS('city', S.city, M.clean),
    county: readS('county', S.county, M.clean),
    state: readS('state', S.state, M.upState),
    zip: readS('zip', S.zip, M.zip),
    apn: readS('apn', S.apn, M.clean),
    legal: readS('legal', S.legal, (v) => M.capText(v, 2000)),
    censusTract: readS('censusTract', S.censusTract, M.clean),
    neighborhood: readS('neighborhood', S.neighborhood, M.clean),
    attachmentType,
    propertyCategoryType,
    pudIndicator: readS('pudIndicator', S.pudIndicator, (v) => { const b = M.bool(v); return b == null ? M.clean(v) : (b ? 'Y' : 'N'); }),
    projectDesignType,
    propertyType: null,           // the CATEGORY — filled below, once units are settled
    units,
    unitsBasis: units != null ? 'grid' : null,
    yearBuilt: readS('yearBuilt', S.yearBuilt, M.year),
    gla: readS('gla', S.gla, (v) => M.bounded(v, 1e8)),
    beds: readS('beds', S.beds, (v) => M.count(v, 99)),
    baths: baths.text, bathsFull: baths.full, bathsHalf: baths.half,
    rooms: readS('rooms', S.rooms, (v) => M.count(v, 99)),
    stories: readS('stories', S.stories, M.clean),
    design: readS('design', S.design, M.clean),
    lotArea: readS('lotDimensions', S.lotDimensions, M.clean)
      || readS('lotAreaSqft', S.lotAreaSqft, (v) => { const n = M.bounded(v, 1e9); return n == null ? null : `${n} sf`; }),
    zoningId: readS('zoningId', S.zoningId, M.clean),
    zoningDesc: readS('zoningDesc', S.zoningDesc, M.clean),
    zoningCompliance: readS('zoningCompliance', S.zoningCompliance, M.clean),
    floodZone: readS('floodZone', S.floodZone, M.clean),
    conditionUad: readS('conditionUad', S.conditionUad, (v) => M.ratingCode(v, 'C')),
    qualityUad: readS('qualityUad', S.qualityUad, (v) => M.ratingCode(v, 'Q')),
    conditionText: null, qualityText: null,
    priorSale: null,

    // ---- UAD 3.6 ONLY. Persisted verbatim through `buildFieldsJson` into the fields
    // jsonb (which stores every `subject.*` key), so the Appraisal screen can show what
    // the new standard added without a migration and without touching `enrich`.
    uadVersion: '3.6',
    conditionInterior: readS('conditionInterior', S.conditionInterior, (v) => M.ratingCode(v, 'C')),
    conditionExterior: readS('conditionExterior', S.conditionExterior, (v) => M.ratingCode(v, 'C')),
    qualityInterior: readS('qualityInterior', S.qualityInterior, (v) => M.ratingCode(v, 'Q')),
    qualityExterior: readS('qualityExterior', S.qualityExterior, (v) => M.ratingCode(v, 'Q')),
    grossBuildingArea: readS('grossBuildingArea', S.grossBuildingArea, (v) => M.bounded(v, 1e8)),
    effectiveYearBuilt: readS('effectiveYearBuilt', S.effectiveYearBuilt, M.year),
    projectName: readS('projectName', S.projectName, M.clean),
  };

  // The rating word beside the code — same rule as 2.6 (a 3.6 report can state a rating
  // the UAD scale does not cover, e.g. on a property type newly brought into ratings).
  const rawSubjC = M.clean(M.resolve(subj.node, S.conditionUad).value);
  const rawSubjQ = M.clean(M.resolve(subj.node, S.qualityUad).value);
  if (rawSubjC && !subject.conditionUad) subject.conditionText = M.capText(rawSubjC, 120);
  if (rawSubjQ && !subject.qualityUad) subject.qualityText = M.capText(rawSubjQ, 120);

  // ---- the derived form type -------------------------------------------------
  // 3.6 has NO form number. Everything downstream is keyed on one, so it is derived from
  // the facts that always drove it, and the basis is kept as a fact of its own.
  const derived = M.deriveFormType({ units, propertyCategoryType, projectDesignType, attachmentType });
  const formType = derived.formType;
  subject.formTypeBasis = derived.basis;
  if (!formType) warnings.push({ code: 'form_not_derivable', msg: 'the report states neither a dwelling count nor an ownership kind — the equivalent legacy form could not be derived' });

  // Units implied by the derived form, kept distinguishable from a counted one.
  if (subject.units == null && (formType === 'FNM1004' || formType === 'FNM1073')) {
    subject.units = 1; subject.unitsBasis = 'form';
  }

  const cat = derivePropertyCategory({
    formType,
    units: subject.units,
    attachmentType: subject.attachmentType,
    propertyCategoryType: subject.propertyCategoryType,
    pudIndicator: subject.pudIndicator,
    projectDesignType: subject.projectDesignType,
    designDescription: subject.design,
  });
  subject.propertyType = cat ? cat.label : null;
  subject.propertyCategory = cat ? cat.key : null;
  subject.propertyCategoryConfidence = cat ? cat.confidence : null;
  subject.propertyCategoryBasis = cat && cat.basis.length ? cat.basis.join('; ') : null;

  // ---- values ----------------------------------------------------------------
  const V = M.VALUATION;
  const readV = M.fieldReader(root, coverage, 'value');
  const appraisedValue = readV('appraisedValue', V.appraisedValue, M.money);
  const condOfAppraisal = readV('conditionOfAppraisal', V.conditionOfAppraisal, M.conditionOfAppraisal);
  const hypothetical = readV('hypotheticalCondition', V.hypotheticalCondition, (v) => M.capText(v, 2000));
  const texts = narrativeTexts(root);

  const decided = decideValues({ appraisedValue, condOfAppraisal, hypothetical, texts });
  const values = {
    appraisedValue,
    conditionOfAppraisal: condOfAppraisal,
    conditionOfAppraisalAll: null,
    effectiveDate: readV('effectiveDate', V.effectiveDate, M.ymd),
    asIs: decided.asIs, asIsConfidence: decided.asIsConfidence, asIsSource: decided.asIsSource,
    arv: decided.arv, arvConfidence: decided.arvConfidence, arvSource: decided.arvSource,
    basis: decided.basis, basisNote: decided.basisNote,
    // 3.6 states these as data points rather than leaving them in prose — kept so the
    // as-is/ARV decision can be audited against what the report actually disclosed.
    hypotheticalCondition: hypothetical,
    extraordinaryAssumption: readV('extraordinaryAssumption', V.extraordinaryAssumption, (v) => M.capText(v, 2000)),
    valueSalesApproach: readV('valueSalesApproach', V.valueSalesApproach, M.money),
    valueCostApproach: readV('valueCostApproach', V.valueCostApproach, M.money),
    valueIncomeApproach: readV('valueIncomeApproach', V.valueIncomeApproach, M.money),
    grm: readV('grm', V.grm, (v) => M.bounded(v, 1e6)),
    siteValue: readV('siteValue', V.siteValue, M.money),
    contractPrice: readV('contractPrice', V.contractPrice, M.money),
    contractDate: readV('contractDate', V.contractDate, M.ymd),
  };

  // ---- comparables -----------------------------------------------------------
  const found = findComparables(root);
  const comps = found.rows.map((row, i) => readComparable(row, i, coverage))
    // The same rule the 2.6 reader applies: a row that names no property, no price and no
    // size is a padded grid slot, not a comparable.
    .filter((c) => c.address || c.salePrice != null || c.gla != null);

  const gridSplit = splitComps({
    basis: values.basis, asIsValue: values.asIs, arvValue: values.arv, texts, comps,
  });
  gridSplit.comps.forEach((gc, i) => { if (comps[i]) comps[i].comp_set = gc.comp_set; });

  // ---- appraiser -------------------------------------------------------------
  const A = M.APPRAISER;
  // Scope the read to the appraiser's own party when the document names one — a
  // document-wide sweep would grab the AMC's or the lender's phone, the exact bug the
  // 2.6 reader was audited for.
  const appraiserNode = findAppraiserNode(root) || root;
  const readA = M.fieldReader(appraiserNode, coverage, 'appraiser');
  const appraiser = {
    name: readA('name', A.name, (v) => M.capText(v, 200)),
    company: readA('company', ['**/AppraiserCompanyName', { re: /CompanyName$/ }], (v) => M.capText(v, 200)),
    licenseId: readA('licenseId', A.licenseId, M.clean),
    licenseState: readA('licenseState', A.licenseState, M.upState),
    licenseType: readA('licenseType', A.licenseType, M.clean),
    licenseExp: readA('licenseExp', A.licenseExp, M.ymd),
    phone: readA('phone', A.phone, M.clean),
    email: readA('email', A.email, M.clean),
    supervisor: null,
    lender: M.capText(X.deepText(root, 'LenderName') || '', 200),
    amc: M.capText(X.deepText(root, 'AppraisalManagementCompanyName') || '', 200),
    reportSignedDate: readV('reportSignedDate', V.reportSignedDate, M.ymd),
    inspectionDate: readV('inspectionDate', V.inspectionDate, M.ymd),
  };

  // ---- borrower --------------------------------------------------------------
  const borrowerName = M.capText(
    X.deepText(root, 'BorrowerName') || findPartyName(root, 'Borrower') || '', 200);
  const isLlc = !!(borrowerName && /\b(LLC|L\.L\.C|INC|CORP|LP|LLP|TRUST|COMPANY|HOLDINGS|PROPERTIES|CAPITAL|GROUP|VENTURES|ENTERPRISE)\b/i.test(borrowerName));

  // ---- enrichment ------------------------------------------------------------
  // ONLY keys that are already columns on `appraisals` — `importAppraisal` assigns this
  // object straight into an INSERT. A new fact goes on `subject.*` (jsonb) instead.
  const enrich = buildEnrich({ root, subjNode: subj.node, coverage, values });

  // ---- report contents / photos ----------------------------------------------
  // A 3.6 delivery carries its images as FILES IN THE ZIP, not base64 inside the XML —
  // the ENV/embedded-PDF world is gone (see docs/appraisal-xml/uad-3.6-research.md).
  // What the XML holds is the MANIFEST: one entry per image with its type and caption.
  const imageNodes = X.allDeep(root, 'IMAGE').concat(X.allDeep(root, 'PHOTOGRAPH')).slice(0, 500);
  const reportImages = imageNodes.map((im) => ({
    id: M.clean(X.deepText(im, 'ImageIdentifier') || X.deepText(im, 'DocumentIdentifier') || X.attr(im, 'label')),
    caption: M.capText(X.deepText(im, 'ImageCaptionText') || X.deepText(im, 'ImageDescription'), 200),
    file: M.clean(X.deepText(im, 'ImageFileName') || X.deepText(im, 'FileName')),
    type: M.clean(X.deepText(im, 'ImageType') || X.deepText(im, 'PhotographType')),
  })).filter((im) => im.id || im.caption || im.file);

  const photos = { embeddedPdf: 0, imageMeta: reportImages.length };
  const report = {
    forms: [],
    images: reportImages.map(({ id, caption }) => ({ id, caption })).filter((im) => im.id || im.caption),
    rentalGrids: X.allDeep(root, 'RENTAL_COMPARABLE').length || X.allDeep(root, 'COMPARABLE_RENT').length,
    // 3.6-only: the image manifest with filenames, which is how the ZIP's `Images/`
    // folder is matched to the report.
    imageManifest: reportImages,
  };

  // ---- tripwires -------------------------------------------------------------
  if (values.appraisedValue == null) warnings.push({ code: 'no_appraised_value', msg: 'appraised value missing' });
  if (comps.length === 0) warnings.push({ code: 'no_comps', msg: 'no comparable sales found' });
  if (comps.length > 0 && comps.length < 3) warnings.push({ code: 'few_comps', msg: `only ${comps.length} comparable${comps.length === 1 ? '' : 's'} read — UAD 3.6 requires a minimum of three closed sales` });
  if (!subject.address || !subject.state || !subject.zip) warnings.push({ code: 'weak_identity', msg: 'subject address/state/zip incomplete' });
  if (!borrowerName) warnings.push({ code: 'no_party', msg: 'no borrower or entity name on the appraisal' });
  if (values.asIs != null && values.arv != null && values.asIs > values.arv) warnings.push({ code: 'asis_gt_arv', msg: 'As-Is exceeds ARV — sanity check' });
  if (subject.conditionUad === 'C6') warnings.push({ code: 'condition_c6', msg: 'condition C6 — substantial damage affecting safety/soundness (UCDP fatal)' });
  if (subject.qualityUad === 'Q6') warnings.push({ code: 'quality_q6', msg: 'quality Q6 — basic/substandard construction (UCDP fatal)' });
  if (gridSplit.needsReview) warnings.push({ code: 'comp_split_review', msg: 'As-Is vs ARV comp split needs review — some comps could not be assigned to a grid with certainty' });
  // The 3.6-specific one: interior and exterior condition disagreeing by two or more
  // steps is exactly the signal the split ratings were introduced to surface.
  const ci = ratingNumber(subject.conditionInterior), ce = ratingNumber(subject.conditionExterior);
  if (ci != null && ce != null && Math.abs(ci - ce) >= 2) {
    warnings.push({ code: 'cq_interior_exterior_gap', msg: `interior condition ${subject.conditionInterior} and exterior condition ${subject.conditionExterior} differ by ${Math.abs(ci - ce)} steps — inspect which one drives the value` });
  }
  if (appraiser.licenseExp && appraiser.reportSignedDate && appraiser.licenseExp < appraiser.reportSignedDate) {
    warnings.push({ code: 'license_expired_at_signing', msg: `Appraiser license expired ${appraiser.licenseExp} before the report was signed ${appraiser.reportSignedDate}` });
  }

  // ---- coverage summary ------------------------------------------------------
  const keys = Object.keys(coverage);
  const resolvedCount = keys.filter((k) => coverage[k].resolved).length;
  const unresolved = keys.filter((k) => !coverage[k].resolved);
  // Fields resolved only by the LAST-RESORT NAME SWEEP are the ones whose mapped path was
  // wrong. Naming them is how the map gets corrected against the first real sample
  // instead of quietly depending on a fallback forever.
  const viaSweep = keys.filter((k) => coverage[k].resolved && typeof coverage[k].via === 'string' && coverage[k].via.startsWith('~'));

  return {
    ok: true,
    formType,
    format: {
      model: '3.6', uad36: true, ref: det.ref, damaged,
      subjectVia: subj.via, comparablesVia: found.via,
      scope: readV('inspectionScope', V.inspectionScope, M.inspectionScope),
    },
    subject, values, appraiser, enrich,
    borrower: { name: borrowerName, isLlc, hasPartyName: !!borrowerName },
    comparables: comps,
    units: [], income: null, condo: buildCondo(root, formType),
    photos, report,
    rentalComps: [],
    compSplit: {
      confidence: gridSplit.confidence, needsReview: gridSplit.needsReview, note: gridSplit.note,
      asIsValue: gridSplit.asIsValue, arvValue: gridSplit.arvValue,
      counts: {
        as_is: comps.filter((c) => c.comp_set === 'as_is').length,
        arv: comps.filter((c) => c.comp_set === 'arv').length,
        unknown: comps.filter((c) => c.comp_set === 'unknown').length,
      },
    },
    warnings,
    coverage: {
      fields: coverage,
      resolved: resolvedCount,
      total: keys.length,
      unresolved,
      viaSweep,
    },
  };
}

/** C3 → 3, Q2 → 2, anything else → null. */
function ratingNumber(code) {
  const m = /^[CQ]([1-6])$/.exec(String(code || ''));
  return m ? Number(m[1]) : null;
}

/** The PARTY node playing the appraiser role, or null. */
function findAppraiserNode(root) {
  for (const party of X.allDeep(root, 'PARTY')) {
    const roles = X.allDeep(party, 'PartyRoleType').map((r) => X.text(r).toLowerCase());
    if (roles.some((r) => r.includes('appraiser'))) return party;
    if (X.firstDeep(party, 'APPRAISER')) return party;
  }
  return X.firstDeep(root, 'APPRAISER') || X.firstDeep(root, 'APPRAISER_LICENSE');
}

/** The unparsed/full name of the first PARTY playing `roleWord`, or ''. */
function findPartyName(root, roleWord) {
  const want = String(roleWord).toLowerCase();
  for (const party of X.allDeep(root, 'PARTY')) {
    const roles = X.allDeep(party, 'PartyRoleType').map((r) => X.text(r).toLowerCase());
    if (!roles.some((r) => r.includes(want))) continue;
    const full = X.deepText(party, 'FullName') || X.deepText(party, 'UnparsedName');
    if (full) return full;
    const first = X.deepText(party, 'FirstName'), last = X.deepText(party, 'LastName');
    if (first || last) return [first, last].filter(Boolean).join(' ');
  }
  return '';
}

/** The 1073-equivalent condo card, when the derived form says condominium. */
function buildCondo(root, formType) {
  if (formType !== 'FNM1073') return null;
  const project = X.firstDeep(root, 'PROJECT') || root;
  const feeAmt = (v) => { const n = M.toNum(v); return n != null && n >= 0 && M.round2(n) < 1e10 ? n : null; };
  return {
    projectName: M.clean(X.deepText(project, 'ProjectName')),
    projectType: M.clean(X.deepText(project, 'ProjectDesignType') || X.deepText(project, 'ProjectType')),
    elevatorCount: M.count(X.deepText(project, 'ElevatorCount'), 999),
    unitIdentifier: M.clean(X.deepText(root, 'AddressUnitIdentifier') || X.deepText(root, 'UnitIdentifier')),
    floor: M.clean(X.deepText(root, 'FloorIdentifier') || X.deepText(root, 'UnitLevelIdentifier')),
    hoaFeeAmount: feeAmt(X.deepText(project, 'AssociationFeeAmount') || X.deepText(root, 'HOAFeeAmount')),
    hoaFeePeriod: M.clean(X.deepText(project, 'AssociationFeePeriodType') || X.deepText(root, 'HOAFeePeriodType')),
  };
}

/**
 * The enrichment block — the fields that land in `appraisals` COLUMNS.
 *
 * EVERY KEY HERE IS AN EXISTING COLUMN. `importAppraisal` does
 * `Object.assign(cols, A.enrich)` and builds the INSERT from those keys, so an
 * unrecognised key does not degrade gracefully: it fails the whole import. Adding a 3.6
 * fact therefore means a migration and a deliberate decision — the reader's job is to
 * fill what already exists and put everything new on `subject.*`.
 */
function buildEnrich({ root, subjNode, coverage, values }) {
  const S = M.SUBJECT, MK = M.MARKET, V = M.VALUATION;
  const rS = M.fieldReader(subjNode, coverage, 'enrich');
  const rR = M.fieldReader(root, coverage, 'enrich');
  const marketNode = X.firstDeep(root, 'NEIGHBORHOOD') || X.firstDeep(root, 'MARKET_ANALYSIS') || root;
  const rM = M.fieldReader(marketNode, coverage, 'enrich');

  const o = {};
  // property / improvements
  o.basement_sqft = rS('basement_sqft', S.basementSqft, (v) => M.bounded(v, 1e6));
  o.basement_finished_pct = null;
  o.below_grade_sqft = o.basement_sqft;
  o.below_grade_finished_sqft = rS('below_grade_finished_sqft', S.basementFinishedSqft, (v) => M.bounded(v, 1e6));
  o.foundation_type = rS('foundation_type', S.foundationType, M.clean);
  o.roof_description = rS('roof_description', S.roofDescription, (v) => M.capText(v, 200));
  o.heating_type = rS('heating_type', S.heatingType, M.clean);
  o.heating_fuel = rS('heating_fuel', S.heatingFuel, M.clean);
  o.cooling = rS('cooling', S.cooling, M.clean);
  o.garage_spaces = rS('garage_spaces', S.garageSpaces, (v) => M.count(v, 99));
  o.garage_type = rS('garage_type', S.garageType, M.clean);
  o.attic = rS('attic', S.attic, (v) => M.capText(v, 200));
  o.has_adu = rS('has_adu', S.hasAdu, M.bool);
  o.effective_age = rS('effective_age', S.effectiveAge, (v) => M.count(v, 300));
  o.remaining_economic_life = rS('remaining_economic_life', S.remainingEconomicLife, (v) => M.count(v, 300));
  o.physical_deficiency = rS('physical_deficiency', S.physicalDeficiency, M.bool);
  o.physical_deficiency_note = rS('physical_deficiency_note', S.physicalDeficiencyNote, (v) => M.capText(v, 4000));
  o.building_status = rS('building_status', S.buildingStatus, M.clean);
  o.lot_dimensions = rS('lot_dimensions', S.lotDimensions, (v) => M.capText(v, 200));
  o.lot_shape = rS('lot_shape', S.lotShape, M.clean);
  o.property_rights = rS('property_rights', S.propertyRights, M.clean);
  o.occupancy_status = rS('occupancy_status', S.occupancyStatus, M.clean);
  o.owner_of_record = rS('owner_of_record', S.ownerOfRecord, (v) => M.capText(v, 200));
  o.property_tax_amount = rS('property_tax_amount', S.propertyTaxAmount, M.money);
  o.property_tax_year = rS('property_tax_year', S.propertyTaxYear, M.year);
  o.special_flood_hazard = rS('special_flood_hazard', S.specialFloodHazard, M.bool);
  o.fema_panel_id = rS('fema_panel_id', S.femaPanel, M.clean);
  o.fema_panel_date = rS('fema_panel_date', S.femaPanelDate, M.ymd);
  o.condition_comment = rS('condition_comment', S.conditionComment, (v) => M.capText(v, 8000));

  // scope of work / report kind
  o.inspection_type = rR('inspection_type', V.inspectionScope, M.inspectionScope);
  o.uspap_report_type = rR('uspap_report_type', V.uspapReportType, M.clean);
  o.appraisal_purpose = rR('appraisal_purpose', V.appraisalPurpose, M.clean);
  o.reconciliation_comment = rR('reconciliation_comment', V.reconciliationComment, (v) => M.capText(v, 8000));

  // market / neighborhood
  o.nbhd_value_trend = rM('nbhd_value_trend', MK.valueTrend, M.clean);
  o.nbhd_demand_supply = rM('nbhd_demand_supply', MK.demandSupply, M.clean);
  o.nbhd_marketing_time = rM('nbhd_marketing_time', MK.marketingTime, M.clean);
  o.nbhd_growth = rM('nbhd_growth', MK.growth, M.clean);
  o.nbhd_builtup = rM('nbhd_builtup', MK.builtUp, M.clean);
  o.nbhd_price_low = rM('nbhd_price_low', MK.priceLow, M.money);
  o.nbhd_price_high = rM('nbhd_price_high', MK.priceHigh, M.money);
  o.nbhd_price_predominant = rM('nbhd_price_predominant', MK.pricePredominant, M.money);
  o.nbhd_age_predominant = rM('nbhd_age_predominant', MK.agePredominant, (v) => M.count(v, 300));
  o.nbhd_boundaries = rM('nbhd_boundaries', MK.boundaries, (v) => M.capText(v, 2000));
  o.mc_months_supply = rM('mc_months_supply', MK.monthsSupply, (v) => { const n = M.toNum(v); return n != null && n >= 0 && n < 120 ? n : null; });
  o.mc_median_dom = rM('mc_median_dom', MK.medianDom, (v) => M.count(v, 3000));
  o.mc_sale_to_list_pct = rM('mc_sale_to_list_pct', MK.saleToListPct, M.percent);
  o.market_conditions_comment = rM('market_conditions_comment', MK.marketComment, (v) => M.capText(v, 8000));

  // contract
  o.sale_type = rR('sale_type', ['**/SalesContractType', '**/PropertyTransactionType', { re: /Sale.*Type$/ }], M.clean);
  o.concession_indicator = rR('concession_indicator', ['**/SalesConcessionIndicator', { re: /ConcessionIndicator$/ }], M.bool);
  o.concession_amount = rR('concession_amount', ['**/SalesConcessionAmount', { re: /ConcessionAmount$/ }], (v) => { const n = M.toNum(v); return n != null && n >= 0 && n < 1e9 ? n : null; });
  o.concession_description = rR('concession_description', ['**/SalesConcessionDescription', { re: /ConcessionDescription$/ }], (v) => M.capText(v, 2000));
  o.contract_reviewed = rR('contract_reviewed', ['**/SalesContractAnalyzedIndicator', { re: /ContractAnalyzed/ }], M.bool);
  o.contract_review_comment = rR('contract_review_comment', ['**/SalesContractAnalysisDescription', { re: /ContractAnalysis/ }], (v) => M.capText(v, 4000));

  // Drop the keys that resolved to nothing so an UPDATE never writes a null over a value
  // a human typed — the same blank-only posture `importAppraisal` keeps everywhere else.
  for (const k of Object.keys(o)) if (o[k] == null) delete o[k];
  return o;
}

module.exports = {
  extract36, detect36,
  // Exported so `extract.js#detectMismo` — which the research warehouse's catch reuses
  // as its one "is this an appraisal?" test — recognises exactly the containers this
  // reader reads from. One list, two consumers.
  COMP_CONTAINERS, COMP_ROW_TAGS,
  _internals: { findSubject, findComparables, decideValues, buildEnrich, inComparable, ratingNumber, narrativeTexts, readComparable },
};
