'use strict';
/**
 * LONG-TERM (LT) — the DROPDOWN / ENUMERATION catalog.
 *
 * Every Encompass field that constrains its value to a fixed set, with BOTH:
 *   • the values Encompass DECLARES (from the tenant schema), and
 *   • the values actually USED on long-term files (from the 772-loan census),
 * so a mapping to a ClickUp dropdown can be built against what the field permits AND
 * what staff really put in it. 1,006 constrained fields carry data in this tenant.
 *
 * TWO THINGS TO KNOW BEFORE YOU MAP ANYTHING
 *
 * 1. CUSTOM DROPDOWNS DO NOT PUBLISH THEIR OPTIONS. The API returns the option list
 *    for STANDARD fields only. A custom field declared DROPDOWNLIST comes back with
 *    its format and nothing else — no options at all. For those 44 fields the option
 *    set here is INFERRED from observed data and every entry is marked
 *    `inferred: true`. It is a floor, not a ceiling: an option nobody has picked yet
 *    is invisible to us. The complete list has to come from Encompass Settings, or
 *    from the admin settings endpoints once the client scope is widened.
 *
 * 2. THE SAME FIELD ANSWERS DIFFERENTLY DEPENDING ON HOW YOU ASK. A Y/N field
 *    declares its options as 'Y' and 'N' — and the loan JSON returns `true` / `false`.
 *    That affects 614 fields here. It is not a defect, but a mapping that assumes one
 *    representation will silently drop the other. Normalize with `normalizeValue()`.
 *
 * READ-ONLY reference knowledge.
 */

const CATALOG = require('./dictionary/dropdown-catalog.json');
const FIELDS = CATALOG.fields;

/**
 * Why an observed value can sit outside the declared option set. Only the last of
 * these is a data-quality problem; the rest are facts about how Encompass works.
 */
const DRIFT_KINDS = {
  'boolean-representation': {
    fields: 614, severity: 'none',
    meaning: "The field declares 'Y'/'N' and the loan JSON returns true/false. Two "
      + 'representations of the same value. Normalize before mapping.' },
  'sentinel-only-enum': {
    fields: 2, severity: 'none',
    meaning: 'The declared options are only sentinels (8888 = not applicable, 9999 = '
      + 'not provided). Real values are free-form by design — HMDA age, for example.' },
  'declared-set-does-not-match-tenant': {
    fields: 10, severity: 'medium',
    meaning: "Encompass's stock option list is not what this tenant actually stores. "
      + 'Trust the observed values, not the declared ones.' },
  'free-text-typed-into-enum': {
    fields: 4, severity: 'high',
    meaning: 'Staff typed a value the field does not offer. These are genuine data-quality '
      + 'problems and they break anything that switches on the enum.' },
};

/**
 * The mismatches that actually matter, called out by hand because a mapping built
 * without knowing them will be quietly wrong.
 */
const NOTABLE = [
  { fieldId: '2867', alsoAffects: ['MORNET.X67'], label: 'Loan Doc Type',
    severity: 'high', loans: 486,
    declared: ['Alternative', 'FullDocumentation', 'Reduced', 'StreamlineRefinance', 'NoDocumentation', 'NoRatio'],
    observed: ['NoDocumentation', 'DSCR'],
    why:
      "'DSCR' is not a valid loan-doc-type code — the Fannie Mae vocabulary has no such "
      + "member. It matters more than it looks: the tenant's BASE Milestone Completion "
      + "rule (rule #12, the one carrying the 117-field long-term set) is conditioned on "
      + "Doc Type = 'No Documentation'. A file whose doc type says 'DSCR' does not match "
      + 'that condition, so the long-term field requirements never switch on for it.',
    action: 'Worth an owner decision: standardise on NoDocumentation in Encompass, or accept '
      + 'both and treat them as equivalent everywhere on our side.' },

  { fieldId: '33', label: 'Subject Property Manner Held', severity: 'high', loans: 14,
    declared: ['Community property', 'Joint tenants', 'Single man', 'Single woman', 'Married man', 'Married woman', 'Tenants in common'],
    observed: ['BASS REALTY TRENTON LLC', 'KJ BH LLC', 'Prospect BH 123 Mazal LLC', 'Bricks & Stones LLC', '38 ASBURY LLC', 'Sole Ownership', 'Joint Tenancy with Right of Survivorship'],
    why: 'The field asks HOW title is held and staff are typing WHO holds it. That is a '
      + 'natural thing to do on a DSCR file, because title is almost always vested in an '
      + 'LLC — but it means this field is a vesting-entity name about half the time and a '
      + 'manner-held code the rest of the time.',
    action: 'Treat as free text. Read the vesting ENTITY from here only with a shape check, '
      + 'and prefer a dedicated vesting field if one is configured.' },

  { fieldId: '2356', alsoAffects: ['2358', 'TSUM.PropertyFormType'], label: 'Appraisal Type / Review Type / Valuation Form Type',
    severity: 'medium', loans: 77,
    declared: ['URAR', 'FHA URAR', '2055 Drive-by', '2075 Limited Desk Review', 'Condo Appraisal'],
    observed: ['FNMA-1004-v2005', 'FNMA-1025-v2005'],
    why: 'The tenant stores the MISMO/Fannie FORM CODE rather than the friendly label. '
      + 'FNMA-1004 is the standard single-family URAR; FNMA-1025 is the small residential '
      + 'INCOME property report (2–4 units) — which is exactly what a DSCR file on a '
      + 'multi-unit needs. The form code is more precise than the declared vocabulary, so '
      + 'map from it, not to it.',
    action: 'Map 1004 → single family, 1025 → 2–4 unit income property.' },

  { fieldId: 'MS.STATUS', label: 'Current Milestone Name', severity: 'medium', loans: 490,
    declared: ['Started', 'Sent to processing', 'Submitted', 'Approved', 'Doc signed', 'Funded', 'Completed'],
    // DERIVED FROM THE SWEEP ITSELF, never hand-typed — filled in below, after
    // the catalog is in scope. The hand-written list this replaces was wrong in
    // BOTH directions: it omitted eleven values the sweep actually recorded
    // (including 'Sent to processing', on 27 loans) and it INVENTED two that the
    // sweep never saw in this field at all ('Loan Setup', 'Submittal' — those are
    // stage names from `fillByStage`, a different fact). A decision was then made
    // from it: stages.js recorded that 'Sent to processing' had "never once been
    // observed on this tenant", which was false, and dropped a mapping partly on
    // that basis. A summary sitting beside the data it summarises will drift, and
    // the one that drifts is the one somebody reads.
    observed: [],
    why: "The declared list is Encompass's stock milestone set. This tenant configured its "
      + 'own 19 milestones — and MS.STATUS RETURNS A MIX OF BOTH VOCABULARIES: on 342 of the '
      + '490 long-term loans swept it returns a tenant milestone name, and on the other 148 '
      + "it returns one of the seven stock bucket names (Completed 79, Submitted 32, "
      + "'Sent to processing' 27, Started 6, Funded 4). The names are not even consistent "
      + "within a vocabulary — the field says 'File started' where the milestone settings "
      + "say 'Started'.",
    action: 'Drive milestone logic from GET /encompass/v3/settings/milestones (the real 19), '
      + "never from this field's declared options — and never assume a value here is one of "
      + 'the tenant\'s own names, because on nearly a third of the book it is not.' },

  { fieldId: '299', label: 'Refinance Purpose', severity: 'low', loans: 238,
    declared: ['CashOutDebtConsolidation', 'CashOutHomeImprovement', 'CashOutLimited', 'CashOutOther', 'CashOutOriginalLender', 'ChangeInRateTerm'],
    observed: ['CashOutDebtConsolidation', 'CashOutOther', 'ChangeInRateTerm', 'CashOutOriginalLender', 'CashOutHomeImprovement', 'NoCashOutOther'],
    why: "'NoCashOutOther' is stored but not declared — a real member of the newer URLA "
      + 'vocabulary that the schema copy here has not caught up with.',
    action: 'Accept it as a rate-and-term refinance.' },
];

/** Normalize a value so the Y/N and true/false worlds compare equal. */
function normalizeValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  const s = String(v).trim();
  const l = s.toLowerCase();
  if (l === 'y' || l === 'yes' || l === 'true') return 'true';
  if (l === 'n' || l === 'no' || l === 'false') return 'false';
  return s;
}

/** One field's option set and observed usage. */
function field(id) { return FIELDS[String(id)] || null; }

/* THE ONE DERIVED `observed` LIST. Generated rather than maintained, because the
   hand-written version of exactly this list is what produced a false statement in
   stages.js — see the note on the MS.STATUS entry above. Ordered by how many loans
   carry each value, most first, so the list reads as a census rather than a set. */
for (const n of NOTABLE) {
  if (n.fieldId !== 'MS.STATUS') continue;
  const f = field(n.fieldId);
  n.observed = ((f && f.observedOnDscr) || []).map((o) => o.value);
}

/** Every constrained field, optionally filtered. */
function list({ kind = null, minLoans = 0, inferredOnly = false, driftOnly = false } = {}) {
  return Object.values(FIELDS)
    .filter((f) => (!kind || f.kind === kind)
      && f.dscrLoansWithValue >= minLoans
      && (!inferredOnly || f.optionsNotExposedByApi)
      && (!driftOnly || !!f.declaredSetDrift))
    .sort((a, b) => b.dscrLoansWithValue - a.dscrLoansWithValue);
}

/**
 * The option set to offer for a field: the declared values when Encompass publishes
 * them, otherwise the observed ones (marked inferred). Always returns
 * { value, text, inferred?, loans? }.
 */
function options(id) {
  const f = field(id);
  if (!f) return [];
  const seen = new Map((f.observedOnDscr || []).map((o) => [normalizeValue(o.value), o.loans]));
  return (f.allowedValues || []).map((o) => ({
    value: o.value, text: o.text || o.value,
    inferred: !!o.inferred,
    loans: seen.get(normalizeValue(o.value)) || 0,
  }));
}

/** Is `value` something this field is known to accept? */
function isKnownValue(id, value) {
  const n = normalizeValue(value);
  return options(id).some((o) => normalizeValue(o.value) === n);
}

function summary() {
  const all = Object.values(FIELDS);
  return {
    ...CATALOG.meta,
    constrainedFields: all.length,
    standardWithDeclaredOptions: all.filter((f) => f.kind === 'standard').length,
    customWithInferredOptions: all.filter((f) => f.optionsNotExposedByApi).length,
    driftByKind: Object.fromEntries(Object.entries(DRIFT_KINDS).map(([k, v]) => [k, v.fields])),
    notable: NOTABLE.length,
  };
}

module.exports = {
  CATALOG, FIELDS, DRIFT_KINDS, NOTABLE,
  normalizeValue, field, list, options, isKnownValue, summary,
};
