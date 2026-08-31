'use strict';
/**
 * LONG-TERM — AHL's OWN input domain, captured from the page that defines it.
 *
 * ── THE VENDOR SHIPS ITS OWN VOCABULARY, AND THAT IS WHY NOTHING IS GUESSED ──
 * The Quick Pricer is server-rendered, so a plain unauthenticated `GET` of it
 * returns the COMPLETE form: 23 `<select>`s with every option value spelled out,
 * the radio groups, and the cascading rules riding along as CSS classes on the
 * options (`loanTerm3040yr`, `loanTerm12mo`, `forNonQM`, `forDSCR`). That is a
 * field registry the vendor maintains for us, exactly like LoanNEX's
 * `/loans/apps/{userGuid}/settings` — it just arrives as markup.
 *
 * `capture/form-registry.json` is that form, extracted verbatim on 2026-08-30.
 * Every enum this adapter puts on the wire is checked against it BEFORE the
 * request is built, and an unrecognised value is REFUSED BY NAME rather than
 * defaulted — a defaulted enum prices a different loan and says nothing.
 *
 * ⛔ THE REGISTRY IS A SNAPSHOT OF SOMEBODY ELSE'S PAGE, so it goes stale on
 * their deploy, not ours. `refresh()` re-reads it from the live form and
 * `diff()` says what moved; the canary calls them. A stale registry fails in the
 * safe direction — it refuses a value AHL has since added, which is a visible
 * refusal rather than a silent mis-price.
 *
 * PURE: no network (the fetch lives in `client.js`), no database, no RTL import.
 */

const CAPTURED = require('./capture/form-registry.json');

/** Radio groups are not `<select>`s, so they are not in the extracted form. */
const RADIO_GROUPS = {
  // The page's own three: `''` is None and is what the vendor sends when the
  // prepay period is 0. It is a REAL value, not an omission.
  PrepayPenaltyType: ['', 'Fixed Percentage', 'Declining Structure'],
  InterestOnly: ['Yes', 'No'],
  LenderFeeBuyout: ['Yes', 'No'],
};

const YES_NO = ['Yes', 'No'];
/**
 * The yes/no inputs this adapter is allowed to set. Deliberately a SHORT list:
 * the page carries about thirty of them and most belong to agency, FHA and VA
 * products this adapter never prices. One it must not touch is listed to say so.
 */
const BOOLEAN_FIELDS = {
  InterestOnly: YES_NO,
  Renovation: YES_NO,
  GroundUpConstruction: YES_NO,
  SelfEmployed: YES_NO,
  WaiveEscrows: YES_NO,
  FirstTimeHomeBuyer: YES_NO,
  FirstTimeInvestor: YES_NO,
  RentFree: YES_NO,
  RuralArea: YES_NO,
  MortgageLates: YES_NO,
  Foreclosure: YES_NO,
  Bankruptcy: YES_NO,
  WarrantableCondo: YES_NO,
  DetachedCondo: YES_NO,
  Condotel: YES_NO,
  CoBorrower: YES_NO,
  NonOccupantCoBorrower: YES_NO,
};

class AhlRegistryError extends Error {
  constructor(code, field, message) { super(message); this.code = code; this.field = field; this.name = 'AhlRegistryError'; }
}

function optionsFor(field, registry = CAPTURED) {
  if (RADIO_GROUPS[field]) return [...RADIO_GROUPS[field]];
  if (BOOLEAN_FIELDS[field]) return [...BOOLEAN_FIELDS[field]];
  const list = registry && registry[field];
  if (!Array.isArray(list)) return null;
  return list.map((o) => (o && o.value != null ? String(o.value) : ''));
}

/** Is this field one the registry knows at all? */
function knows(field, registry = CAPTURED) { return optionsFor(field, registry) != null; }

/**
 * Refuse anything AHL's own form does not offer.
 *
 * A field the registry has never heard of is ALSO refused. That is deliberate:
 * a typo'd field name is silently ignored by a form post — the request succeeds
 * and prices a loan missing the input nobody noticed was dropped.
 */
function assertOption(field, value, registry = CAPTURED) {
  const opts = optionsFor(field, registry);
  if (!opts) {
    throw new AhlRegistryError('unknown_field', field,
      `${field} is not a field on AHL's Quick Pricer form. A misspelled field is silently DROPPED by a form post, so it is refused here instead.`);
  }
  const v = value == null ? '' : String(value);
  if (!opts.includes(v)) {
    throw new AhlRegistryError('unknown_option', field,
      `${JSON.stringify(v)} is not one of AHL's options for ${field} (${opts.filter(Boolean).map((x) => JSON.stringify(x)).join(', ')}). The request is refused rather than defaulted — a defaulted ${field} prices a different loan.`);
  }
  return v;
}

/**
 * Which loan terms AHL offers for a given income-verification type, read off the
 * option's OWN css class rather than a list kept here.
 *
 * The page groups terms with `loanTerm3040yr` (30/40), `loanTerm1218mo` (12/18
 * months) and `loanTerm12mo`. `Investor - DSCR` carries `loanTerm3040yr`, which
 * is how this adapter knows AHL's DSCR shelf is 30-year and 40-year and nothing
 * else — derived, never hand-listed, so a term AHL adds appears on its own.
 */
function termsForDocType(docType, registry = CAPTURED) {
  const docs = (registry && registry.DocType) || [];
  const hit = docs.find((o) => o && String(o.value) === String(docType));
  if (!hit) return null;
  const group = String(hit.class || '').split(/\s+/).find((c) => /^loanTerm/.test(c));
  if (!group) return null;
  const terms = (registry.LoanTerm || [])
    .filter((o) => o && o.value && String(o.class || '').split(/\s+/).includes(group))
    .map((o) => Number(o.value))
    .filter((n) => Number.isFinite(n));
  return { group, terms: [...new Set(terms)].sort((a, b) => a - b) };
}

/** Every lock term AHL offers, from the form. */
function lockTerms(registry = CAPTURED) {
  return ((registry && registry.LockTerm) || [])
    .map((o) => Number(o && o.value)).filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
}

/**
 * What moved between the captured registry and a freshly-read one.
 *
 * Reported per field as added/removed VALUES, because that is what breaks a
 * mapping: a renamed option is a removal plus an addition and both need a human.
 */
function diff(fresh, base = CAPTURED) {
  const fields = [...new Set([...Object.keys(base || {}), ...Object.keys(fresh || {})])].sort();
  const changes = [];
  for (const f of fields) {
    const a = new Set((base[f] || []).map((o) => String(o && o.value)));
    const b = new Set((fresh[f] || []).map((o) => String(o && o.value)));
    if (!base[f]) { changes.push({ field: f, change: 'field_added' }); continue; }
    if (!fresh[f]) { changes.push({ field: f, change: 'field_removed' }); continue; }
    const added = [...b].filter((x) => !a.has(x));
    const removed = [...a].filter((x) => !b.has(x));
    if (added.length || removed.length) changes.push({ field: f, change: 'options_changed', added, removed });
  }
  return { changed: changes.length > 0, fieldCount: fields.length, changes };
}

module.exports = {
  CAPTURED, RADIO_GROUPS, BOOLEAN_FIELDS, AhlRegistryError,
  optionsFor, knows, assertOption, termsForDocType, lockTerms, diff,
};
