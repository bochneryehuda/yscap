'use strict';
/**
 * LT PPE — settings / configuration resolution core (Phase 0).
 *
 * RULE #1 made mechanical: nothing about our company is hardcoded in engine logic. Every knob we'd
 * otherwise bake in is a TYPED SETTING that exposes all the industry-standard options and is pre-filled
 * with OUR chosen default. Our configuration is nothing more than seed data on top of these product
 * defaults; another company overrides a setting without touching code.
 *
 * This module is PURE — no DB, no network, safe to unit-test offline. The DEFINITIONS below are the
 * shipped PRODUCT DEFAULTS (the single source of truth for each setting's type, option set, and
 * default). At Phase 1 they are loaded into `lt_ppe_setting_definition`; tenant/org overrides live in
 * `lt_ppe_setting_value`. Resolution order is strict: tenant value → org/parent default → product
 * default, first hit wins — and every resolved value is validated against its definition.
 *
 * LT-only. No RTL imports.
 */

// A setting definition. `type` drives validation + the generic UI control.
//   enum    → `options` is the closed list of allowed values (industry-standard options).
//   number  → optional `min`/`max`; integer-only when `integer:true`.
//   boolean → true/false only.
//   string  → free text (optionally `maxLength`).
//   json    → an array/object (optionally `itemType` for a homogeneous array).
// `default` is OUR pre-filled choice (seed, never privileged). `group`/`label`/`help` are UI metadata.
const DEFINITIONS = {
  // ---- Pricing knobs -------------------------------------------------------
  'pricing.correspondent_margin_milli': {
    type: 'number', integer: true, min: 0, max: 5000, default: 250,
    group: 'Pricing', label: 'Correspondent margin',
    help: 'Margin subtracted from the base price, in thousandths of a point (250 = 0.250). Verified default for our correspondent flow; applied to base price before LLPAs.',
  },
  'pricing.rounding_mode': {
    type: 'enum', options: ['none', 'nearest_eighth', 'nearest_increment', 'up', 'down', 'half_even'],
    default: 'nearest_eighth',
    group: 'Pricing', label: 'Price rounding mode',
    help: 'How the final price is rounded (once, last). Industry default is nearest eighth of a point.',
  },
  'pricing.rounding_increment_milli': {
    type: 'number', integer: true, min: 1, max: 1000, default: 125,
    group: 'Pricing', label: 'Rounding increment',
    help: 'Rounding increment in thousandths of a point (125 = 1/8 point). Used when rounding_mode = nearest_increment.',
  },
  'pricing.price_floor_milli': {
    type: 'number', integer: true, min: 0, max: 200000, default: 98000,
    group: 'Pricing', label: 'Minimum price (floor)',
    help: 'Price floor in thousandths of a point (98000 = 98.000). The final price is clamped up to this.',
  },
  'pricing.price_cap_on_exceed': {
    type: 'enum', options: ['cap_and_keep_eligible', 'cap_and_flag', 'make_ineligible'],
    default: 'cap_and_keep_eligible',
    group: 'Pricing', label: 'When the price cap is exceeded',
    help: 'What to do when the computed price exceeds the max-price ceiling for the loan-size tier.',
  },
  'pricing.cumulative_adjustment_cap_milli': {
    type: 'number', integer: true, min: 0, max: 1000000, default: null, nullable: true,
    group: 'Pricing', label: 'Cumulative adjustment cap',
    help: 'Optional cap on the total of all LLPAs (thousandths of a point). Blank = uncapped.',
  },
  // ---- Margin & holdback (per-investor; owner pre-fills 0.250) --------------
  // Owner rule (2026-08-16): "the margin holdback should be set up for each and every Investor
  // separately in the setting, pre-filled 0.25 but changeable, reaching every Investor, and it
  // should be able to have different kind of margin and holdback to different scenarios with
  // different rules." These are the DEFAULT margin + holdback; a per-investor override is stored
  // under scope `investor:<code>` (store.resolveMarginHoldbackForInvestor), and per-scenario rules
  // live in `pricing.margin_holdback_rules`. All values in milli-points (250 = 0.250 point).
  //
  // NOTE `pricing.correspondent_margin_milli` (above) is the LEGACY single margin knob the pricing
  // pipeline already consumes; `pricing.margin_milli` is the new per-investor-resolvable margin the
  // margin/holdback resolver reads. They share the same 250 default so nothing changes today.
  //
  // `perInvestor: true` on the three keys below is LOAD-BEARING, not documentation. It is the ONE
  // declaration of "this setting may be overridden under scope `investor:<code>`", and BOTH ends
  // read it: the write door refuses to store any other key at an investor scope, and
  // `store.resolveMarginHoldbackForInvestor` FILTERS the investor layer through the same list before
  // resolving. That is what makes the two ends agree by construction rather than by two hand-kept
  // lists that drift. Measured before it was added: `resolveMarginHoldbackForInvestor` is the ONLY
  // function anywhere in src/ that reads an `investor:` scope, and it reads exactly these three keys
  // — so a per-investor value written for any OTHER key would be stored, would look saved, and would
  // be read by nothing. That is the outcome this flag exists to make impossible.
  //
  // OPEN QUESTION, deliberately NOT answered here: whether any OTHER setting (the price floor, the
  // rounding, a parity tolerance) should also be settable per investor is a BUSINESS decision about
  // how the company prices, not something to infer from the code. Adding a flag here without that
  // decision would create a knob a human could set and nothing would honour.
  'pricing.margin_milli': {
    type: 'number', integer: true, min: 0, max: 5000, default: 250, perInvestor: true,
    group: 'Pricing', label: 'Margin (our markup)',
    help: 'Our margin/markup, in thousandths of a point (250 = 0.250). Pre-filled 0.250; set per-investor and per-scenario as needed.',
  },
  'pricing.holdback_milli': {
    type: 'number', integer: true, min: 0, max: 5000, default: 250, perInvestor: true,
    group: 'Pricing', label: 'Margin holdback',
    help: 'Buffer/retained spread held back per investor, in thousandths of a point (250 = 0.250). Pre-filled 0.250; changeable per investor and per scenario.',
  },
  // A per-scenario override list. Each row: { code?, when?: <predicate over scenario facts>,
  //   marginMilli?, holdbackMilli?, priority? }. Rows are evaluated in priority order; the FIRST
  //   matching row that names a field wins for that field (margin and holdback resolve independently),
  //   so a scenario can carry a different margin and/or holdback with its own rule. Predicate grammar
  //   is rules.evalPredicate (all/any/none/not + leaf ops). Blank = no per-scenario overrides (the
  //   investor/company default applies to every scenario).
  'pricing.margin_holdback_rules': {
    type: 'json', default: [], perInvestor: true,
    group: 'Pricing', label: 'Per-scenario margin/holdback rules',
    help: 'Optional list of per-scenario margin/holdback overrides ({ when, marginMilli?, holdbackMilli? }). Blank = the investor/company default applies to every scenario.',
  },

  // ---- Loan-officer compensation (D18 / E9; per-officer under scope `officer:<staffId>`) ----
  //
  // THE OWNER'S RULES THESE CARRY. 2026-08-17: the 0.25 company holdback is non-overridable; the
  // officer's own default margin is 2.00, earned either as a 2-point origination at par or as a
  // rebate in the back, and every officer sets his own split of the two; a minimum and a maximum in
  // DOLLARS per loan; the compensation split is on the origination. 2026-08-18, settling the two
  // questions that were holding the build: *"Company default: the minimum is not enforced. It's not a
  // hard rule. It's a movable default, and every loan officer can set this movable default
  // differently. The split does not apply for the margin. The entire margin hold back goes for the
  // company."*
  //
  // `perOfficer: true` is LOAD-BEARING in exactly the way `perInvestor` is: it is the ONE declaration
  // that a key may be overridden under an `officer:` scope, read by both ends — the write door and
  // `store.resolveCompPlanForOfficer` — so the two agree by construction. **The company holdback is
  // deliberately NOT on that list**, and that absence is the mechanism the owner's "non-overridable"
  // rests on: the resolver simply never passes an officer layer for a key that is not per-officer, so
  // an officer's override of it cannot take effect even if one were somehow stored.
  //
  // NOTHING HERE PRICES ANYTHING. Whether this 0.25 is the same quarter point the pipeline already
  // subtracts as `pricing.correspondent_margin_milli`, or a second one on top, is an open owner
  // question (COMPENSATION-MARGIN-MODEL.md, question 5) whose two answers differ by a quarter point on
  // every loan — so `comp-plan.js` computes who earns what and never touches a price.
  'comp.company_holdback_milli': {
    type: 'number', integer: true, min: 0, max: 5000, default: 250,
    group: 'Compensation', label: 'Company holdback (never the officer\'s)',
    help: 'The company margin holdback in thousandths of a point (250 = 0.250). A loan officer can never set or remove it, it is never split with them, and it is never counted toward their per-loan minimum or maximum.',
  },
  'comp.officer_margin_milli': {
    type: 'number', integer: true, min: 0, max: 20000, default: 2000, perOfficer: true,
    group: 'Compensation', label: 'Loan officer margin', 
    help: 'What the loan officer earns on a file, in thousandths of a point (2000 = 2.000). The company default; each officer may set their own.',
  },
  'comp.officer_front_milli': {
    type: 'number', integer: true, min: 0, max: 20000, default: 2000, perOfficer: true,
    group: 'Compensation', label: 'Taken as origination (front)',
    help: 'How much of the officer margin is charged to the borrower as origination. The front and the back must add up to the margin.',
  },
  'comp.officer_back_milli': {
    type: 'number', integer: true, min: 0, max: 20000, default: 0, perOfficer: true,
    group: 'Compensation', label: 'Taken as rebate (back)',
    help: 'How much of the officer margin is earned in the back instead of being charged to the borrower. The front and the back must add up to the margin.',
  },
  // DOLLARS, and DEFAULTS RATHER THAN LIMITS — the owner's own words. There is deliberately no
  // company floor an officer's own number must clear: writing one would be the hard rule they said
  // this is not. Blank means there is no minimum (or no maximum) at all, never zero.
  'comp.officer_min_cents': {
    type: 'number', integer: true, min: 0, max: 100000000, default: null, nullable: true, perOfficer: true,
    group: 'Compensation', label: 'Least the officer makes on a loan',
    help: 'A per-loan minimum in CENTS ($3,000 = 300000). A movable default, not a floor — an officer may set their own, higher or lower. Blank = no minimum.',
  },
  'comp.officer_max_cents': {
    type: 'number', integer: true, min: 0, max: 100000000, default: null, nullable: true, perOfficer: true,
    group: 'Compensation', label: 'Most the officer makes on a loan',
    help: 'A per-loan maximum in CENTS ($50,000 = 5000000). A movable default, not a ceiling nobody may cross. Blank = no maximum.',
  },
  // DELIBERATELY BLANK. The officer's share of the origination is a real money figure and nobody has
  // stated it, so the compensation record REFUSES to work out anybody's net until it is set rather
  // than printing a share off a number this file invented.
  'comp.officer_split_pct': {
    type: 'number', integer: true, min: 0, max: 100, default: null, nullable: true, perOfficer: true,
    group: 'Compensation', label: 'Officer share of the origination (%)',
    help: 'The officer keeps this percentage of the origination; the company keeps the rest. Blank until somebody sets it — no share is assumed.',
  },
  'comp.split_basis': {
    type: 'enum', options: ['front_only', 'front_and_back'], default: 'front_only',
    group: 'Compensation', label: 'What the split is taken from',
    help: 'The recorded reading of "the split does not apply for the margin — the entire margin holdback goes for the company": the company takes its share of the ORIGINATION only. The holdback is never part of it either way.',
  },
  'comp.default_mode': {
    type: 'enum', options: ['borrower_paid', 'lender_paid'], default: 'borrower_paid',
    group: 'Compensation', label: 'Who pays the officer by default',
    help: 'Borrower-paid means the officer is paid by an origination charge; lender-paid means they are paid out of the rebate. Lender Price is searched under the matching comp type.',
  },

  // ---- Eligibility ---------------------------------------------------------
  'eligibility.result_mode': {
    type: 'enum', options: ['hard_fail_only', 'show_with_reasons', 'soft_warn'],
    default: 'show_with_reasons',
    group: 'Eligibility', label: 'Eligibility result mode',
    help: 'How ineligibility is surfaced. Industry default shows ineligible programs WITH their decline reasons.',
  },

  // ---- Locks ---------------------------------------------------------------
  'lock.days_offered': {
    type: 'json', itemType: 'number', default: [15, 21, 30, 45, 60, 90],
    group: 'Locks', label: 'Lock periods offered (days)',
    help: 'The lock-day columns priced. Seed default matches the company rate-sheet capability list.',
  },
  'lock.relock_pricing_basis': {
    type: 'enum', options: ['worse_of', 'current_market', 'original', 'best_of'],
    default: 'worse_of',
    group: 'Locks', label: 'Relock pricing basis',
    help: 'Which price a relock/extension uses. Industry default is worst-case (the worse of original and current).',
  },

  // ---- Shadow-validation tolerances (§10) ----------------------------------
  'validation.price_tolerance_milli': {
    type: 'number', integer: true, min: 0, max: 100000, default: 0,
    group: 'Validation', label: 'Price parity tolerance',
    // Owner-directed 2026-08-17: EXACT match, to the penny — any difference at all is a disagreement
    // and goes to human review. Default 0; an admin may loosen it per-company in the settings UI.
    help: 'Max allowed price difference vs Lender Price before a scenario counts as a disagreement (thousandths of a point; 0 = must match exactly, owner-directed).',
  },
  'validation.rate_tolerance_milli': {
    type: 'number', integer: true, min: 0, max: 100000, default: 0,
    group: 'Validation', label: 'Rate parity tolerance',
    help: 'Max allowed note-rate difference vs Lender Price (thousandths of a percent; 0 = must match exactly).',
  },
  'validation.margin_tolerance_milli': {
    type: 'number', integer: true, min: 0, max: 100000, default: 0,
    group: 'Validation', label: 'Margin parity tolerance',
    help: 'Max allowed margin/holdback difference vs Lender Price (thousandths of a point; 0 = must match exactly).',
  },
  'validation.base_price_tolerance_milli': {
    type: 'number', integer: true, min: 0, max: 100000, default: 0,
    group: 'Validation', label: 'Base-price parity tolerance',
    // Owner-directed 2026-08-17: exact to the penny (see price_tolerance_milli). Default 0.
    help: 'Max allowed base-price difference vs Lender Price before a rung counts as a base-price disagreement (thousandths of a point; 0 = must match exactly, owner-directed).',
  },

  // ---- Per-investor cutover (§11) ------------------------------------------
  'cutover.clean_weeks_required': {
    type: 'number', integer: true, min: 1, max: 52, default: 8,
    group: 'Cutover', label: 'Clean weeks required to go live',
    help: 'Consecutive weeks of zero disagreements (with the canary matrix at 100%) before an investor may be promoted to live (leaving shadow mode). The go-live gate READS this number. 8 is OUR most cautious assumption, not a number the owner has confirmed (open question 3a) — say the word and it changes here, in one place.',
  },

  // ---- Investor / program defaults (owner pre-fills; per-investor overridable) ----
  'program.default_channel': {
    type: 'enum', options: ['correspondent', 'wholesale', 'retail'],
    default: 'correspondent',
    group: 'Programs', label: 'Default channel for a new program',
    help: 'The delivery channel a new program starts in. Correspondent = we fund/close in our own name then sell the loan. Set per-investor as needed.',
  },
  'ingestion.default_format': {
    type: 'enum', options: ['excel', 'pdf', 'website', 'api'],
    default: 'excel',
    group: 'Ingestion', label: 'Default rate-sheet format',
    help: 'How rate sheets are loaded by default. Excel is the most common today; PDF, investor-website, and API feeds are supported per-investor as they come online.',
  },
};

function getDefinition(key) {
  return Object.prototype.hasOwnProperty.call(DEFINITIONS, key) ? DEFINITIONS[key] : null;
}
function allDefinitions() {
  return Object.keys(DEFINITIONS).map((key) => ({ key, ...DEFINITIONS[key] }));
}

/**
 * Every key that may be overridden under scope `investor:<code>`, DERIVED from the
 * definitions rather than listed a second time — a hand-kept list of "which settings
 * are per-investor" would go stale the first time one is added and nothing would say so.
 * Sorted so callers can print it without re-sorting.
 */
function investorScopedKeys() {
  return Object.keys(DEFINITIONS).filter((k) => DEFINITIONS[k].perInvestor === true).sort();
}

/**
 * The keys an `officer:<staffId>` override may be stored for — DERIVED from the definitions, exactly
 * as the per-investor list is. The company holdback is absent by design: that absence IS the owner's
 * "a loan officer can never override it", enforced structurally rather than by a check.
 */
function officerScopedKeys() {
  return Object.keys(DEFINITIONS).filter((k) => DEFINITIONS[k].perOfficer === true).sort();
}

/** Is this a key a per-officer override may be stored for? Unknown key → false. */
function isOfficerScoped(key) {
  const def = getDefinition(key);
  return !!(def && def.perOfficer === true);
}

/** Is this a key a per-investor override may be stored for? Unknown key → false. */
function isInvestorScoped(key) {
  const def = getDefinition(key);
  return !!(def && def.perInvestor === true);
}

// Validate a value against its definition. Returns { ok:true } or { ok:false, error }.
function validateValue(key, value) {
  const def = getDefinition(key);
  if (!def) return { ok: false, error: `unknown_setting:${key}` };
  if (value == null) {
    return def.nullable ? { ok: true } : { ok: false, error: `null_not_allowed:${key}` };
  }
  switch (def.type) {
    case 'enum':
      return def.options.includes(value) ? { ok: true }
        : { ok: false, error: `not_in_options:${key}:${JSON.stringify(value)}` };
    case 'number': {
      if (typeof value !== 'number' || !isFinite(value)) return { ok: false, error: `not_a_number:${key}` };
      if (def.integer && !Number.isInteger(value)) return { ok: false, error: `not_an_integer:${key}` };
      if (def.min != null && value < def.min) return { ok: false, error: `below_min:${key}:${value}<${def.min}` };
      if (def.max != null && value > def.max) return { ok: false, error: `above_max:${key}:${value}>${def.max}` };
      return { ok: true };
    }
    case 'boolean':
      return typeof value === 'boolean' ? { ok: true } : { ok: false, error: `not_a_boolean:${key}` };
    case 'string':
      if (typeof value !== 'string') return { ok: false, error: `not_a_string:${key}` };
      if (def.maxLength != null && value.length > def.maxLength) return { ok: false, error: `too_long:${key}` };
      return { ok: true };
    case 'json':
      if (typeof value !== 'object') return { ok: false, error: `not_json:${key}` };
      if (def.itemType && Array.isArray(value)) {
        for (const el of value) {
          // eslint-disable-next-line valid-typeof
          if (typeof el !== def.itemType) return { ok: false, error: `bad_item_type:${key}` };
        }
      }
      return { ok: true };
    default:
      return { ok: false, error: `unknown_type:${key}` };
  }
}

// Resolve one setting: tenant value → org/parent value → product default (first hit wins). Each layer's
// value is validated against the definition; an invalid override is SKIPPED (falls through) rather than
// trusted, so a bad row can never poison pricing — but a valid override always wins. `layers` is
// { tenant?, org? } where each is a plain { key: value } map. Throws only on an unknown setting key.
function resolve(key, layers = {}) {
  const def = getDefinition(key);
  if (!def) throw new Error(`unknown_setting:${key}`);
  for (const layer of [layers.tenant, layers.org]) {
    if (layer && Object.prototype.hasOwnProperty.call(layer, key)) {
      const v = layer[key];
      if (validateValue(key, v).ok) return { value: v, source: layer === layers.tenant ? 'tenant' : 'org' };
    }
  }
  return { value: def.default, source: 'product_default' };
}

// Resolve EVERY setting at once (for the pricing engine / the settings UI). Returns a flat
// { key: value } map plus a parallel { key: source } map.
function resolveAll(layers = {}) {
  const values = {};
  const sources = {};
  for (const key of Object.keys(DEFINITIONS)) {
    const r = resolve(key, layers);
    values[key] = r.value;
    sources[key] = r.source;
  }
  return { values, sources };
}

module.exports = {
  DEFINITIONS, getDefinition, allDefinitions, validateValue, resolve, resolveAll,
  investorScopedKeys, isInvestorScoped,
  officerScopedKeys, isOfficerScoped,
};
