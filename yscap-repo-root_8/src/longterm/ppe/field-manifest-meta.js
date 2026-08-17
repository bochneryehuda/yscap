'use strict';
/**
 * LT PPE — PER-FIELD METADATA FOR THE PUBLISHED DSCR FIELD MANIFEST.
 *
 * The manifest (`GET /api/lt/dscr/fields`) published `core` and `advanced` as BARE KEY STRINGS: no
 * label, no type, no enum, no unit. Only the 33 overlay fields carried metadata. So the scenario-entry
 * screen had to draw 61 fields under their raw technical key with a "no type published" badge, and a
 * percentage held in THOUSANDTHS (`ltv` 80% → 80000, `dscr` 1.25 → 1250) rendered as a naked number
 * box with nothing saying so — the exact shape of a silent mis-entry.
 *
 * EVERYTHING HERE IS DERIVED, NOTHING IS HAND-MAINTAINED. That is the point: a hand-written label
 * table is a list somebody has to remember to update, and the day it goes stale it lies about a field
 * that decides a price. So:
 *   • TYPE + ENUM come from the validator's OWN definitions — `BOOLEAN_FIELDS`, `ATTACHMENT_TYPES`,
 *     `ALLOWED_LOCKS`/`ALLOWED_TERMS` and the field-registry's `PROPERTY_TYPES` / `INCOME_DOC_TYPES` /
 *     `PREPAY_STRUCTURES`. If a validator gains a value, the manifest gains it in the same breath.
 *   • UNIT is stated ONLY where the engine genuinely uses one (the milli fields). Nowhere else.
 *   • LABEL is COMPUTED from the key (`selfEmployed` → "Self employed"), never authored. A computed
 *     label cannot go stale and it claims nothing the key does not already say — and every one is
 *     stamped `labelDerived: true` so no reader mistakes it for a vendor-authored name.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: invent a human name for a field whose meaning is not in the key,
 * guess a unit, or describe the nested-object fields (`bankruptcy`, `mortgageLates`) beyond saying
 * they are objects — their shape is enforced inside `applyRegistry` and is not published. Anything
 * unknown is simply ABSENT, and the screen already says so, rather than being filled with a plausible
 * guess. PURE: no IO, no network, no DB.
 */
const { _internals: model } = require('../lenderprice/search-model');
const registry = require('../lenderprice/field-registry');

// ---- the milli conventions, which are real engine facts and the most dangerous thing to leave unsaid
// (a user typing 80 into a field the engine reads as 0.08% is a silent mispricing, not an error).
const MILLI_PERCENT = ['ltv', 'cltv'];
const MILLI_RATIO = ['dscr'];

// ---- keys whose meaning is genuinely not recoverable from the key alone are simply not described.
const NESTED_OBJECT = ['bankruptcy', 'mortgageLates'];

const setOf = (v) => {
  if (!v) return null;
  if (Array.isArray(v)) return v.slice();
  if (v instanceof Set) return [...v];
  if (v instanceof Map) return [...v.keys()];
  if (typeof v === 'object') return Object.keys(v);
  return null;
};

// Enum sources, each pointed at the validator's OWN list so the two can never disagree.
function enumFor(key) {
  switch (key) {
    case 'propertyType': return setOf(registry.PROPERTY_TYPES);
    case 'incomeDocType': return setOf(registry.INCOME_DOC_TYPES);
    case 'prepayStructure': return setOf(registry.PREPAY_STRUCTURES);
    case 'borrowerType': return setOf(registry.BORROWER_TYPES);
    case 'attachment':
    case 'attachmentType': return setOf(model.ATTACHMENT_TYPES);
    case 'lockDays': return setOf(model.LIVE_LOCKS) || setOf(model.ALLOWED_LOCKS);
    case 'term':
    case 'termYears': return setOf(model.LIVE_TERMS) || setOf(model.ALLOWED_TERMS);
    case 'occupancy': return setOf(model.OCCUPANCY_STATES);
    default: return null;
  }
}

/**
 * A readable label COMPUTED from the key — split camelCase, split on _ / -, first letter up, and keep
 * a known initialism upper-cased. Never authored, so it can never go stale.
 */
const INITIALISMS = new Set(['ltv', 'cltv', 'dscr', 'dti', 'fico', 'io', 'zip', 'apr', 'fthb', 'ppp']);
function labelFor(key) {
  const words = String(key)
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim().split(/\s+/).filter(Boolean);
  if (!words.length) return String(key);
  return words
    .map((w, i) => {
      const low = w.toLowerCase();
      if (INITIALISMS.has(low)) return low.toUpperCase();
      return i === 0 ? low.charAt(0).toUpperCase() + low.slice(1) : low;
    })
    .join(' ');
}

/**
 * Describe ONE field. Returns { key, label, labelDerived, type?, enumValues?, unit?, unitNote? } —
 * every optional key OMITTED when it is not genuinely known.
 */
function describeField(key) {
  const out = { key, label: labelFor(key), labelDerived: true };

  const booleans = setOf(model.BOOLEAN_FIELDS) || [];
  if (booleans.includes(key)) { out.type = 'boolean'; return out; }

  if (NESTED_OBJECT.includes(key)) {
    out.type = 'object';
    out.unitNote = 'Nested object — its shape is validated server-side and is not published.';
    return out;
  }

  const values = enumFor(key);
  if (values && values.length) { out.type = 'enum'; out.enumValues = values; return out; }

  if (MILLI_PERCENT.includes(key)) {
    out.type = 'number'; out.unit = 'milli_percent';
    out.unitNote = 'Thousandths of a percent — 80% is entered as 80000.';
    return out;
  }
  if (MILLI_RATIO.includes(key)) {
    out.type = 'number'; out.unit = 'milli';
    out.unitNote = 'Thousandths — a 1.25 ratio is entered as 1250.';
    return out;
  }

  // Nothing further is KNOWN about this key. Say nothing rather than guess a type.
  return out;
}

/** Describe a list of bare keys. Order preserved. */
function describeFields(keys) { return (keys || []).map(describeField); }

module.exports = { describeField, describeFields, labelFor, _internals: { enumFor, MILLI_PERCENT, MILLI_RATIO, NESTED_OBJECT, INITIALISMS } };
