'use strict';
/**
 * LONG-TERM — WHAT A CONDITION RULE MAY ASK ABOUT A FILE.
 *
 * The registry is the whitelist: a rule may name a key that is here and nothing
 * else. It does two jobs and they are deliberately the same list, so they can
 * never disagree —
 *
 *   · the RULE BUILDER draws its field picker from it, so a screen can never
 *     offer a field the evaluator would then refuse; and
 *   · the ENGINE reads each key off the loan through the SAME definition, so
 *     "what does `borrower_rents` mean" has one answer.
 *
 * ── EVERY VALUE IS DERIVED, NOT STORED ──────────────────────────────────────
 *
 * `read(ctx)` computes each field from the loan PILOT already holds. There is no
 * second table of "rule values" to keep in step, and therefore no way for a rule
 * to fire on a figure the file screen disagrees with. `ctx` is the whole bundle
 * `engine.loadContext` assembles.
 *
 * ── A VALUE WE DO NOT HAVE IS `null`, NEVER A DEFAULT ───────────────────────
 *
 * This is the single most important rule in the file, and it runs the opposite
 * way to instinct. `in_flood_zone` is a boolean; an unread file has NOT been
 * determined to be outside a flood zone, it has not been determined at all.
 * Returning `false` would take the flood condition OFF every unread file
 * silently. So an unknown reads as `null`, the evaluator short-circuits it, and
 * the rule does not fire — while `null` on a NEGATIVE rule (`is_false`) also
 * does not fire, which is the honest answer in both directions.
 *
 * ── THE INVESTOR IS NOT HERE, AND THAT IS ON PURPOSE ────────────────────────
 *
 * A rule is authored in settings and its DESCRIPTION is rendered on screens.
 * `CLAUDE.md` rule 10 makes the investor's name internal on every surface, and a
 * rule keyed on it would put that name into a condition's own explanation, which
 * travels further than any one screen. Where a genuine investor-specific
 * requirement is needed it belongs on the condition's `config`, read by staff-
 * only code, never as a rule field.
 *
 * PURE. No database, no network. Every reader is total: a missing or malformed
 * part of the context yields `null` rather than a throw.
 */

/** The residency basis Encompass field FR0115 lands in (`lt_residences`). */
const BASIS_RENT = 'rent';
const BASIS_OWN = 'own';
const BASIS_FREE = 'no_primary_housing_expense';

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const text = (v) => {
  const s = v == null ? '' : String(v).trim();
  return s === '' ? null : s;
};
const bool = (v) => (v === true || v === false ? v : null);

/** The loan's primary borrower's CURRENT residence, or null. */
function currentResidence(ctx) {
  const list = (ctx && ctx.residences) || [];
  return list.find((r) => String(r.residency_type || '').toLowerCase() === 'current') || null;
}

const FIELDS = [
  // ── The deal ──────────────────────────────────────────────────────────────
  {
    key: 'loan_purpose', label: 'Loan purpose', type: 'enum', group: 'The deal',
    options: ['purchase', 'refinance', 'cash_out_refinance'],
    read: (c) => text(c.loan && c.loan.loan_purpose),
  },
  {
    key: 'is_purchase', label: 'Is a purchase', type: 'boolean', group: 'The deal',
    read: (c) => {
      const p = text(c.loan && c.loan.loan_purpose);
      return p === null ? null : /purchase/i.test(p) && !/refi/i.test(p);
    },
  },
  {
    key: 'is_refinance', label: 'Is a refinance', type: 'boolean', group: 'The deal',
    read: (c) => {
      const p = text(c.loan && c.loan.loan_purpose);
      return p === null ? null : /refi/i.test(p);
    },
  },
  {
    key: 'is_cash_out', label: 'Is a cash-out refinance', type: 'boolean', group: 'The deal',
    read: (c) => {
      const p = text(c.loan && c.loan.loan_purpose);
      return p === null ? null : /cash[_\s-]*out/i.test(p);
    },
  },
  {
    key: 'product_kind', label: 'Product', type: 'enum', group: 'The deal',
    options: ['dscr', 'full_doc', 'bank_statement', 'other'],
    read: (c) => text(c.loan && c.loan.product_kind),
  },
  { key: 'program', label: 'Program', type: 'text', group: 'The deal', read: (c) => text(c.loan && c.loan.program_name) },
  { key: 'loan_amount', label: 'Loan amount', type: 'money', group: 'The deal', read: (c) => num(c.loan && c.loan.loan_amount) },
  { key: 'term_months', label: 'Term (months)', type: 'number', group: 'The deal', read: (c) => num(c.loan && c.loan.term_months) },
  { key: 'ltv_pct', label: 'LTV', type: 'pct', group: 'The deal', read: (c) => num(c.property && c.property.ltv_pct) },
  { key: 'dscr_ratio', label: 'DSCR', type: 'number', group: 'The deal', read: (c) => num(c.loan && c.loan.dscr_ratio) },
  {
    key: 'stage', label: 'Stage', type: 'text', group: 'The deal',
    read: (c) => text(c.loan && c.loan.stage_key),
  },
  {
    key: 'milestone', label: 'Milestone', type: 'text', group: 'The deal',
    read: (c) => text(c.loan && c.loan.milestone_name),
  },

  // ── The property ──────────────────────────────────────────────────────────
  {
    key: 'property_type', label: 'Property type', type: 'text', group: 'The property',
    read: (c) => text(c.property && c.property.gse_property_type),
  },
  {
    // A CONDO IS ITS OWN QUESTION because the owner asked for it by name — the
    // HOA contact and the condo questionnaire hang off it. Derived from the
    // property type rather than stored, so it can never disagree with the type
    // shown on the file, and `null` when the type has not been read: a file we
    // know nothing about is not a file we know is not a condo.
    key: 'is_condo', label: 'Is a condo', type: 'boolean', group: 'The property',
    read: (c) => {
      const t = text(c.property && c.property.gse_property_type);
      return t === null ? null : /condo/i.test(t);
    },
  },
  {
    key: 'unit_count', label: 'Units', type: 'number', group: 'The property',
    read: (c) => num(c.property && c.property.unit_count),
  },
  { key: 'property_state', label: 'State', type: 'text', group: 'The property', read: (c) => text(c.property && c.property.state) },
  {
    // NEW YORK IS ITS OWN FIELD because so much hangs off it — the settlement
    // agent, the shorter title package, no CPL. Derived from the state so the
    // two can never drift.
    key: 'is_new_york', label: 'Property is in New York', type: 'boolean', group: 'The property',
    read: (c) => {
      const s = text(c.property && c.property.state);
      return s === null ? null : /^(ny|new\s*york)$/i.test(s);
    },
  },
  { key: 'appraised_value', label: 'Appraised value', type: 'money', group: 'The property', read: (c) => num(c.property && c.property.appraised_value) },
  { key: 'purchase_price', label: 'Purchase price', type: 'money', group: 'The property', read: (c) => num(c.property && c.property.purchase_price) },
  {
    key: 'in_flood_zone', label: 'In a flood zone', type: 'boolean', group: 'The property',
    // NEVER defaulted. An unread file has not been determined to be OUTSIDE a
    // flood zone; it has not been determined at all.
    read: (c) => bool(c.property && c.property.in_flood_zone),
  },
  { key: 'occupancy_type', label: 'Occupancy', type: 'text', group: 'The property', read: (c) => text(c.property && c.property.occupancy_type) },
  { key: 'gross_monthly_rent', label: 'Gross monthly rent', type: 'money', group: 'The property', read: (c) => num(c.property && c.property.gross_monthly_rent) },

  // ── The borrower ──────────────────────────────────────────────────────────
  {
    // THE OWNER NAMED THIS FIELD THEMSELVES: *"The field that is telling you if
    // he rents or rents for your own is FR0115."* It lands in
    // `lt_residences.residency_basis` through the application mapper, so this
    // reads OUR stored copy rather than re-reading Encompass — one source, and
    // it works with Encompass unreachable.
    key: 'borrower_rents', label: 'Borrower rents where they live', type: 'boolean', group: 'The borrower',
    read: (c) => {
      const r = currentResidence(c);
      if (!r) return null;
      const b = text(r.residency_basis);
      return b === null ? null : b === BASIS_RENT;
    },
  },
  {
    key: 'borrower_owns_home', label: 'Borrower owns where they live', type: 'boolean', group: 'The borrower',
    read: (c) => {
      const r = currentResidence(c);
      if (!r) return null;
      const b = text(r.residency_basis);
      return b === null ? null : b === BASIS_OWN;
    },
  },
  {
    key: 'borrower_lives_rent_free', label: 'Borrower lives rent free', type: 'boolean', group: 'The borrower',
    read: (c) => {
      const r = currentResidence(c);
      if (!r) return null;
      const b = text(r.residency_basis);
      return b === null ? null : b === BASIS_FREE;
    },
  },
  {
    key: 'vests_in_entity', label: 'Title is taken in an entity', type: 'boolean', group: 'The borrower',
    read: (c) => {
      const parties = (c && c.parties) || [];
      if (!parties.length) return null;
      return parties.some((p) => String(p.party_type || '').toLowerCase() === 'entity'
        || !!text(p.entity_legal_name));
    },
  },
  {
    key: 'borrower_count', label: 'How many borrowers', type: 'number', group: 'The borrower',
    read: (c) => {
      const parties = (c && c.parties) || [];
      if (!parties.length) return null;
      return parties.filter((p) => String(p.party_type || '').toLowerCase() !== 'entity').length;
    },
  },
  {
    // "Does this borrower have any OTHER mortgage?" — the question behind the
    // REO / credit-liability condition. Counted off the mirrored liabilities so
    // it cannot disagree with the schedule the file screen shows.
    key: 'other_mortgage_count', label: 'Other mortgages on the credit report', type: 'number', group: 'The borrower',
    read: (c) => {
      const list = (c && c.liabilities) || [];
      if (!list.length) return null;
      return list.filter((l) => /mortgage|heloc|home\s*equity/i.test(String(l.liability_type || ''))).length;
    },
  },
  {
    key: 'reo_count', label: 'Properties on the REO schedule', type: 'number', group: 'The borrower',
    read: (c) => {
      const list = (c && c.reo) || [];
      return list.length ? list.length : (c && c.reoRead ? 0 : null);
    },
  },
];

/** `{key: definition}`, for the evaluator and the picker. */
function fieldMap() {
  const out = Object.create(null);
  for (const f of FIELDS) out[f.key] = f;
  return out;
}

/**
 * Every field, for a picker — WITHOUT the reader.
 *
 * The `read` function is deliberately stripped: it is a closure over our own
 * tables and has no meaning to a browser, and shipping it would invite somebody
 * to reimplement it there and drift from this one.
 */
function catalog() {
  return FIELDS.map((f) => ({ key: f.key, label: f.label, type: f.type, group: f.group, options: f.options || null }));
}

/**
 * Read every field off one file's context.
 *
 * Each reader is wrapped: a malformed piece of context yields `null` for THAT
 * field rather than taking down the whole evaluation. A rule about the property
 * must still be answerable when the borrower's residences are unreadable.
 */
function read(ctx) {
  const values = Object.create(null);
  for (const f of FIELDS) {
    try { values[f.key] = f.read(ctx || {}); }
    catch (_) { values[f.key] = null; }
  }
  return values;
}

module.exports = {
  FIELDS,
  BASIS_RENT,
  BASIS_OWN,
  BASIS_FREE,
  fieldMap,
  catalog,
  read,
  _internals: { currentResidence, num, text, bool },
};
