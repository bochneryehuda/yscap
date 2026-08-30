'use strict';
/**
 * LONG-TERM — WHICH APPRAISAL FORM THIS PROPERTY TAKES.
 *
 * Owner-directed: appraisal ordering is *"NAN only, grayed out"*, and the forms
 * follow the property — one for a single family, another for two-to-four units,
 * another for five and above, another for a condo — with the standing rule over the
 * whole build: *"everything should be setup with not setting it on a hard level …
 * everything should be able to be configured differently in settings. The system is
 * only prefilled with the rules of the system."*
 *
 * So the numbers below are the PREFILL. What actually decides is
 * `lt_condition_templates.config` on `lt_order_appraisal`, edited on the settings
 * screen — this module only says how a property is READ into one of the owner's
 * four cases and how the stored map is applied to it.
 *
 * ── WHY THE PROPERTY KIND IS DECIDED ON THE UNIT COUNT FIRST ────────────────
 *
 * A condominium can be a single unit in a hundred-unit building, so "condo" and
 * "how many units are we lending on" are different questions. The unit count on the
 * file is the count for THIS loan, so it is asked first — and only a property with
 * no more than one unit can be read as a condo at all. A property we cannot read
 * falls to `default` rather than to a guessed form: ordering the wrong appraisal
 * costs a re-order, a fee, and a week.
 *
 * PURE: no database, no config, no requires. Every rule here is unit-testable.
 */

/** What the system is prefilled with. Edited in settings, never here. */
const DEFAULT_FORMS = Object.freeze({
  sfr: '1004',
  multi_2_4: '1025',
  multi_5_plus: 'narrative',
  condo: '1073',
  default: '1004',
});

/** The rent schedule that rides beside the appraisal on a rental-exit loan. */
const DEFAULT_RENT_SCHEDULE = Object.freeze({
  sfr: '1007',
  multi_2_4: '216',
});

/** The four cases, in the order the settings screen shows them, with the words a
    person reads rather than the keys a machine does. */
const PROPERTY_KINDS = Object.freeze([
  { key: 'sfr', label: 'Single family (one unit)' },
  { key: 'multi_2_4', label: 'Two to four units' },
  { key: 'multi_5_plus', label: 'Five units or more' },
  { key: 'condo', label: 'Condominium' },
  { key: 'default', label: 'Anything else' },
]);

const CONDO_RE = /\bcondo(minium)?\b/i;
const COOP_RE = /\bco-?op(erative)?\b/i;

/**
 * Read a property into one of the owner's four cases.
 *
 * @param {{unitCount?:number|null, propertyType?:string|null}} property
 * @returns {'sfr'|'multi_2_4'|'multi_5_plus'|'condo'|'default'}
 */
function propertyKind(property) {
  const p = property || {};
  const units = Number(p.unitCount);
  const type = String(p.propertyType || '');

  if (Number.isFinite(units) && units >= 5) return 'multi_5_plus';
  if (Number.isFinite(units) && units >= 2) return 'multi_2_4';

  /* A CO-OP IS NOT A CONDO. It is a share in a corporation rather than real
     property, it is appraised differently, and reading one as a condo would order a
     1073 on something a 1073 does not describe. There is no case for it in the
     owner's four, so it falls to `default` — a person picks the form.
     HONEST NOTE, MEASURED: a bare "Co-op" or "Cooperative" already falls to
     `default` because the condo pattern does not match it, so on THOSE spellings
     this line changes nothing. Where it genuinely bites is the COMBINED categories
     the trade actually writes — "Condo/Co-op", "Condominium / Cooperative" — which
     the condo pattern DOES match and which would otherwise be ordered a 1073. */
  if (COOP_RE.test(type)) return 'default';
  if (CONDO_RE.test(type)) return 'condo';
  if (Number.isFinite(units) && units === 1) return 'sfr';
  if (/\b(sfr|single[ -]?family|detached)\b/i.test(type)) return 'sfr';
  return 'default';
}

/**
 * The form (and the rent schedule, where one applies) for a property.
 *
 * @param {object} property
 * @param {object} config   the template's stored `config` — `{forms, rentSchedule}`
 * @param {{rentalExit?:boolean}} opts
 */
function formFor(property, config = {}, opts = {}) {
  const kind = propertyKind(property);
  const forms = (config && typeof config.forms === 'object' && config.forms) || DEFAULT_FORMS;
  const sched = (config && typeof config.rentSchedule === 'object' && config.rentSchedule) || DEFAULT_RENT_SCHEDULE;

  // A stored map missing this kind falls to its own `default`, then to the
  // system's — never to nothing, because "no form" is not an order anybody can place.
  const form = clean(forms[kind]) || clean(forms.default) || DEFAULT_FORMS.default;

  /* THE RENT SCHEDULE ONLY ON A RENTAL EXIT, and only where one is configured for
     that property kind. A five-plus takes a narrative appraisal that already carries
     the rent roll, so it has no separate schedule and asking for one is a question
     the appraiser answers with a shrug. `rentalExit` unknown reads as NO: ordering a
     schedule nobody needs costs money and time, and it is the easy half to add. */
  const rent = opts.rentalExit === true ? (clean(sched[kind]) || null) : null;

  return { kind, form, rentSchedule: rent };
}

function clean(v) {
  const s = String(v == null ? '' : v).trim();
  return s ? s.slice(0, 40) : null;
}

/**
 * Take what a settings screen posted and turn it into a storable config.
 *
 * A kind nothing recognises is DROPPED rather than stored — a settings screen that
 * silently accepts a typo'd key would show it saved and then never apply it. A
 * blank value REMOVES that kind's override so it falls back to the prefill, which
 * is how a person undoes a change without having to remember the original number.
 */
function cleanConfig(raw, existing = {}) {
  const out = { ...(existing || {}) };
  const forms = {};
  const sched = {};
  const known = new Set(PROPERTY_KINDS.map((k) => k.key));

  for (const [k, v] of Object.entries((raw && raw.forms) || {})) {
    if (!known.has(k)) continue;
    const c = clean(v);
    if (c) forms[k] = c;
  }
  for (const [k, v] of Object.entries((raw && raw.rentSchedule) || {})) {
    if (!known.has(k)) continue;
    const c = clean(v);
    if (c) sched[k] = c;
  }
  // `default` must always resolve to something, or an unreadable property has no
  // order to place at all.
  if (!forms.default) forms.default = DEFAULT_FORMS.default;

  out.forms = forms;
  out.rentSchedule = sched;
  return out;
}

module.exports = {
  DEFAULT_FORMS, DEFAULT_RENT_SCHEDULE, PROPERTY_KINDS,
  propertyKind, formFor, cleanConfig,
};
