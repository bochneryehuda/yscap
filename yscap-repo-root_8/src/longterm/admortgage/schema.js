'use strict';
/**
 * LONG-TERM — A&D MORTGAGE (AIM Quick Pricer): the SCHEMA, and how a value goes
 * on the wire.
 *
 * ── WHY THIS FILE IS NOT A MAPPING TABLE ───────────────────────────────────
 * The other two vendors need one: Lender Price's tokens and LoanNEX's registry
 * keys are invisible from outside and had to be reverse-engineered. AIM is
 * different — it PUBLISHES its own form. `GET /program-groups/{id}` returns
 * every field with its id, type, default, bounds and every option as
 * `{id, label}`. So the vendor's schema IS the mapping table, and this module
 * only has to resolve OUR canonical vocabulary against it.
 *
 * THEREFORE NOTHING HERE HARDCODES AN AIM ID. Fields and options are resolved by
 * LABEL against the schema the client fetched. AIM's ids matched across two
 * captures four days apart, but they are AIM's to re-issue, and a hardcoded id
 * that silently starts meaning something else is the failure this avoids. The
 * captured schema in `capture/schemas.json` is a FALLBACK for when the live
 * fetch fails — never a source of truth to price from without saying so.
 *
 * ── THE ONE RULE THAT IS NOT OBVIOUS FROM THE SCHEMA ───────────────────────
 * An `interval` field (FICO, DTI, CLTV, Loan Amount) carries `min`/`max` AND may
 * carry a `values[]` array. On screen that array is a DROPDOWN ENTRY — DTI shows
 * "Not required", FICO shows "No FICO" — and it has an id, so it looks exactly
 * like a `list` option. IT IS NOT SENT AS THAT ID. The sentinel goes on the wire
 * as the number `0`. Measured every way, live:
 *
 *     12=0    -> 200, prices
 *     12=256  -> 422 {"DTI":["Can not find interval value '256' in program group."]}
 *     12=""   -> 422 {"DTI":["Invalid value format '' in interval property."]}
 *     12=1    -> 400 "change: DSCR >= 1.25 or DTI 00.00% - 43.00%"
 *
 * The browser agrees: in a recorded session the moment a DSCR income type was
 * chosen the parameter flipped `12=1` -> `12=0` and the 400 became a 200. This
 * is not cosmetic — EVERY DSCR scenario fails without it, which is the whole
 * product we are pricing.
 *
 * OMITTING IS NOT A SUBSTITUTE. DTI tolerates omission; FICO does not
 * (`422 "Required property is missing"`). We always send `0`.
 *
 * ── FAIL CLOSED ────────────────────────────────────────────────────────────
 * A canonical value with no AIM option is REFUSED BY NAME, never approximated.
 * The engine that quietly prices something adjacent to what was asked is the one
 * that produces a term sheet nobody can explain.
 *
 * PURE: no network, no database, no RTL import.
 */

const CAPTURED = require('./capture/schemas.json');

/** AIM's five program groups. `productTreeId` is AIM's, carried for provenance. */
const GROUPS = {
  33001: 'Non-QM',
  33015: 'Non-QM Second Lien',
  33087: 'Jumbo',
  33154: 'Conventional',
  33192: 'Government',
};
/** DSCR is a Non-QM product at AIM; that is the only group this adapter prices today. */
const DSCR_GROUP = 33001;

const key = (v) => String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Index a group schema by field label and, within a field, by option label.
 *
 * Both indexes are keyed on the SQUASHED label ("1 Unit SFR" -> "1unitsfr") so a
 * spacing or punctuation change at AIM does not drop a field. The raw field is
 * kept so callers can read `min`/`max`/`type` without a second lookup.
 */
function indexSchema(fields) {
  const byField = new Map();
  for (const f of fields || []) {
    const options = new Map();
    for (const v of f.values || []) options.set(key(v.label), v);
    byField.set(key(f.label), { field: f, options });
  }
  return byField;
}

/** The live schema when we have one, else the captured fallback — and it SAYS which. */
function schemaFor(groupId, live) {
  const gid = String(groupId);
  if (live && Array.isArray(live.fields) && live.fields.length) {
    return { fields: live.fields, provenance: 'live', capturedAt: live.capturedAt || null };
  }
  const cap = CAPTURED.groups && CAPTURED.groups[gid];
  if (cap && Array.isArray(cap.fields)) {
    return { fields: cap.fields, provenance: 'captured', capturedAt: CAPTURED.capturedAt || null };
  }
  return { fields: [], provenance: 'none', capturedAt: null };
}

/**
 * Resolve one option id from a canonical value.
 *
 * `aliases` maps our word to AIM's label. A canonical value absent from the alias
 * table, or an AIM label absent from the live schema, both come back as a NAMED
 * refusal — the two are different problems (we do not know the word / AIM no
 * longer offers it) and the message says which.
 */
function optionId(idx, fieldLabel, wanted, aliases) {
  const entry = idx.get(key(fieldLabel));
  if (!entry) return { error: 'field_not_in_schema', field: fieldLabel };
  const label = aliases ? aliases[key(wanted)] : wanted;
  if (label == null) return { error: 'value_not_mapped', field: fieldLabel, value: String(wanted) };
  const opt = entry.options.get(key(label));
  if (!opt) {
    return {
      error: 'value_not_offered', field: fieldLabel, value: String(wanted), wanted: String(label),
      offered: [...entry.options.values()].map((o) => o.label),
    };
  }
  return { id: opt.id, label: opt.label, paramId: entry.field.id };
}

/**
 * Clamp-or-refuse an interval value.
 *
 * REFUSES, never clamps. A FICO of 500 on a sheet whose floor is 620 is not a
 * 620 loan — quietly raising it would price a borrower who does not exist. AIM
 * would 422 it anyway; catching it here means the message names our field.
 */
function intervalValue(idx, fieldLabel, raw) {
  const entry = idx.get(key(fieldLabel));
  if (!entry) return { error: 'field_not_in_schema', field: fieldLabel };
  const f = entry.field;
  const n = Number(raw);
  if (raw == null || raw === '' || !Number.isFinite(n)) {
    return { error: 'not_a_number', field: fieldLabel, value: String(raw) };
  }
  const v = Math.round(n);
  if (v < f.min || v > f.max) {
    return { error: 'out_of_range', field: fieldLabel, value: v, min: f.min, max: f.max };
  }
  return { value: v, paramId: f.id };
}

/**
 * The sentinel for an interval field — the number that means its dropdown entry.
 *
 * ALWAYS `0`, and only where the field actually offers such an entry. Asking for
 * the sentinel on a field that has none (CLTV, Loan Amount) is a refusal rather
 * than a 0 that AIM would read as a real figure.
 */
function sentinelValue(idx, fieldLabel) {
  const entry = idx.get(key(fieldLabel));
  if (!entry) return { error: 'field_not_in_schema', field: fieldLabel };
  const extras = entry.field.values || [];
  if (!extras.length) return { error: 'field_has_no_sentinel', field: fieldLabel };
  return { value: 0, paramId: entry.field.id, means: extras.map((e) => e.label).join(' / ') };
}

/** Every field's schema default, as the wire form. The baseline every call starts from. */
function defaults(fields) {
  const out = {};
  for (const f of fields || []) {
    if (f.value === '' || f.value == null) continue;   // County has no default; it is optional
    out[f.id] = String(f.value);
  }
  return out;
}

module.exports = {
  GROUPS, DSCR_GROUP, CAPTURED,
  indexSchema, schemaFor, optionId, intervalValue, sentinelValue, defaults,
  _internals: { key },
};
