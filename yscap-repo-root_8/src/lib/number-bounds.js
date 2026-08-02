'use strict';

/* =====================================================================
   number-bounds.js — the ONE definition of "can this number live in that
   column", and the plain-language reason when it cannot.

   THE ROOT CAUSE THIS EXISTS TO KILL (post-merge audit 2026-07-31). A number
   too big for its column reaches Postgres, raises 22003 (numeric field
   overflow) or 22P02, and the route's catch-all turns it into a 500 "server
   error". To the person at the screen that reads "PILOT is broken", not "that
   number is too big" — and none of the money inputs cap their digits, so a
   fat-fingered paste gets there from an ordinary browser.

   It was fixed FOUR separate times, one column at a time, and each fix left a
   different column wrong:
     · the first bound covered four keys and missed `requested_ir_amount`
       (money, but it matched the int helper's regex, so it was skipped);
     · `units` / `sqft_pre` / `sqft_post` are int4, so everything between
       2,147,483,647 and 10^12 still answered 500;
     · a 400 quoted a MONEY limit for a unit COUNT, so following the advice
       produced another 500;
     · `requested_ir_months` has a CHECK narrower than its type, so int4's
       ceiling was the wrong number to quote there too;
     · and the register + cash-to-close doors each carried their OWN inline
       copy of the money ceiling, so a correction to one never reached them.

   The lesson the copies keep re-teaching: the limit is a property of the
   COLUMN TYPE, not of the field's name or of the door it arrived at. So it is
   decided in one place, keyed on the type, and every door delegates.

   PURE — no DB, no network, never throws. Unit-tested by
   scripts/test-number-bounds-pure.js.
   ===================================================================== */

// numeric(14,2) — the money type used by every dollar column on `applications`
// and `product_registrations`. |value| must ROUND to strictly less than 10^12.
const MONEY_MAX = 1e12;

// int4 — every count column (units, sqft, experience tallies).
const INT_MAX = 2147483647;
const INT_MIN = -2147483648;

// numeric(7,5) — `product_registrations.note_rate`, stored as a FRACTION
// (0.11990 = 11.99%). Five decimals, so the whole part is two digits.
const RATE_MAX = 100;

/* numeric(6,3) — `applications.rate_pct` and `applications.ltv`, both stored as
   a PERCENT. Three decimals, so the whole part is three digits: |value| must
   round to < 1000.

   THIS IS THE TIGHTER OF THE TWO RATE CEILINGS AND IT IS THE ONE THAT BINDS
   (pre-merge audit 2026-07-31). The first cut guarded only `note_rate`'s
   numeric(7,5), which admits a rate up to 10,000% — but the register also
   writes that same rate back to the file as `rate_pct = note_rate × 100`, whose
   column overflows a factor of TEN earlier. So a 1,000% markup (a plausible
   typo; 900% was measured storing cleanly) passed the guard, opened the
   transaction, and raised 22003 anyway. A guard calibrated to the wrong column
   is not a guard. */
const PCT_MAX = 1000;

const MONEY_LIMIT_TEXT = '999,999,999,999.99';
const INT_LIMIT_TEXT = '2,147,483,647';

/** The biggest value numeric(precision, scale) holds, written the way a person
 *  reads a number — "9,999,999,999.99" rather than "10^12 minus a cent". */
function limitText(precision, scale) {
  const whole = '9'.repeat(precision - scale).replace(/\B(?=(\d{3})+$)/g, ',');
  return scale > 0 ? `${whole}.${'9'.repeat(scale)}` : whole;
}

/**
 * Would this value overflow numeric(14,2)?
 *
 * ROUND THE MAGNITUDE, NOT THE SIGNED VALUE. Postgres rounds to two decimals
 * BEFORE it checks for overflow, and it rounds HALF AWAY FROM ZERO — while
 * JavaScript's Math.round breaks ties toward +∞. So -999999999999.995 rounded
 * signed came back inside the ceiling and went on to overflow in Postgres: a
 * 500 that an earlier round believed it had closed for both signs.
 */
function moneyOverflows(n) {
  if (!Number.isFinite(n)) return false;          // "not a number" is a different refusal
  return Math.round(Math.abs(n) * 100) / 100 >= MONEY_MAX;
}

/** Would this value overflow numeric(7,5) (the note rate, as a fraction)? */
function rateOverflows(n) {
  if (!Number.isFinite(n)) return false;
  return Math.round(Math.abs(n) * 1e5) / 1e5 >= RATE_MAX;
}

/** Would this value overflow numeric(6,3) (a percent: rate_pct, ltv)? */
function pctOverflows(n) {
  if (!Number.isFinite(n)) return false;
  return Math.round(Math.abs(n) * 1e3) / 1e3 >= PCT_MAX;
}

/** Would this value overflow int4? */
function intOverflows(n) {
  if (!Number.isFinite(n)) return false;
  return n > INT_MAX || n < INT_MIN;
}

/**
 * Would this value overflow numeric(precision, scale) — ANY precision?
 *
 * `money` and `pct` are just the two shapes that happen to come up most, and
 * hard-coding only those left every OTHER numeric precision with no ceiling at
 * all (pre-merge audit, 2026-08-02): `columnKindOf` returned null for
 * `borrowers.housing_payment` (numeric(12,2)) and `borrowers.years_at_residence`
 * (numeric(4,1)), and `tableColumnProblem` reads null as "nothing wrong" — so
 * both borrower-profile doors still answered 500 on a value the column cannot
 * hold, which is the exact class the module exists to close. A table of column
 * TYPES has to be able to express any type it meets.
 *
 * Same magnitude-rounding rule as the two above, for the same reason.
 */
function numericOverflows(n, precision, scale) {
  if (!Number.isFinite(n)) return false;
  const f = Math.pow(10, scale);
  return Math.round(Math.abs(n) * f) / f >= Math.pow(10, precision - scale);
}

/**
 * The reason `n` cannot be stored in the column `key` names, or '' if it can.
 *
 * `kind` is the COLUMN TYPE:
 *   'money'  — numeric(14,2)
 *   'int'    — int4, whole numbers only
 *   'rate'   — numeric(7,5), a rate held as a fraction
 *   {min,max,what} — a column whose CHECK is narrower than its type; the
 *                    constraint is the ceiling, so quote THAT, not the type's.
 *
 * `label` is what the message calls the field (defaults to `key`), so a door
 * can speak the borrower's language without re-deriving the limit.
 */
function columnProblem(key, n, kind, label) {
  const name = label || key;
  if (n == null) return '';
  if (!Number.isFinite(n)) return `${name} must be a number`;

  if (kind && typeof kind === 'object') {
    // numeric(precision, scale) — any precision, not only the two named kinds.
    if (kind.precision != null) {
      return numericOverflows(n, kind.precision, kind.scale)
        ? `${name} is too large — the largest value this field can hold is ${limitText(kind.precision, kind.scale)}`
        : '';
    }
    if (!Number.isInteger(n)) return `${name} must be a whole number of ${kind.what}`;
    if (n < kind.min || n > kind.max) return `${name} must be between ${kind.min} and ${kind.max} ${kind.what}`;
    return '';
  }
  if (kind === 'money') {
    return moneyOverflows(n) ? `${name} is too large — the largest amount this field can hold is ${MONEY_LIMIT_TEXT}` : '';
  }
  if (kind === 'rate') {
    return rateOverflows(n) ? `${name} is out of range — a rate that large cannot be stored` : '';
  }
  if (kind === 'pct') {
    return pctOverflows(n) ? `${name} is out of range — the largest percentage this field can hold is 999.999` : '';
  }
  // int4
  if (!Number.isInteger(n)) return `${name} must be a whole number`;
  return intOverflows(n) ? `${name} is too large — the largest value this field can hold is ${INT_LIMIT_TEXT}` : '';
}

/* =====================================================================
   WHICH COLUMN IS WHICH TYPE — so that no door has to know (post-merge audit,
   second pass, 2026-08-02).

   The first pass wired the guards above into the doors it ENUMERATED. That
   list turned out not to be the same list as "every door that binds a typed
   column", and every door it missed failed exactly the way the enumerated
   ones used to:

     · both completeness panels (staff + borrower) bind purchase_price /
       as_is_value / arv / rehab_budget / estimated_rental_income straight
       from a free-text box, so a fat-fingered paste answered 500 "server
       error" — while the SAME value on `PATCH /details` answered a plain 400
       naming the field and quoting its ceiling;
     · the appraisal finding's "custom" reprice bound arv / as-is / price with
       only a `> 0` test, and parsed a unit COUNT by deleting every non-digit
       — so "1e10" silently became 110 units and "2-4" (the property-type
       spelling) became 24, on a PRICING input;
     · the info-condition engine let a borrower's own answer reach Postgres
       and handed back the driver's words ("numeric field overflow"), naming
       no field and quoting no limit, on a borrower-facing screen;
     · the public intake door bounded each assignment PART but not the
       purchase price it DERIVES from them, so $900bn + $900bn overflowed and
       LOST THE LEAD to a 500 — the one thing that door must never do;
     · and the MISMO import had no ceiling at all, and bound `ltv`/`rate_pct`
       — numeric(6,3) — through a numeric(14,2) helper: the same
       three-orders-of-magnitude-too-loose mistake intake was already fixed for.

   Enumerating DOORS is what keeps failing, because a door is added by whoever
   needs one and no list stays complete. A type is a property of the COLUMN, so
   the answer is a table of COLUMNS — read straight out of information_schema
   and complete for `applications` — that any door can ask.

   `money` means numeric(14,2) SPECIFICALLY, `pct` numeric(6,3), `int` int4.
   A column of some OTHER precision gets `{precision, scale}` — never one of the
   named kinds, whose ceiling is a different number. The first cut had no way to
   say that at all, so `borrowers.housing_payment` (numeric(12,2)) and
   `years_at_residence` (numeric(4,1)) fell through as "no ceiling" and both
   borrower-profile doors still answered 500 on them.

   Columns declared bare `numeric`, with no precision at all, have no ceiling to
   enforce and are deliberately absent (file_markup_*_pct, financed_rehab_budget).

   Add a numeric column to either table and add it here in the same commit —
   `scripts/test-column-bounds-doors-db.js` reads `information_schema` and FAILS
   on a column that is missing or carries the wrong kind, so this cannot drift.
   ===================================================================== */
const IR_MONTHS = Object.freeze({ min: 0, max: 24, what: 'months' });
const COLUMN_KIND = Object.freeze({
  applications: Object.freeze({
    // numeric(14,2)
    actual_appraised_value: 'money', appraised_rental_value: 'money',
    approx_appraised_rental_value: 'money', approx_appraised_value: 'money',
    arv: 'money', as_is_value: 'money', assignment_fee: 'money',
    cda_value: 'money', costs_already_paid: 'money', estimated_cash_out: 'money',
    estimated_rental_income: 'money', existing_debt: 'money', first_lien: 'money',
    loan_amount: 'money', original_purchase_price: 'money', payoff_amount: 'money',
    property_hoa: 'money', property_insurance: 'money', property_taxes: 'money',
    purchase_price: 'money', rehab_budget: 'money', rental_income: 'money',
    requested_ir_amount: 'money', second_lien: 'money',
    underlying_contract_price: 'money', verified_cash_out: 'money',
    verified_hard_costs: 'money',
    // numeric(6,3) — a PERCENT (or a ratio), NOT money. Ten times tighter.
    deferred_orig_pct: 'pct', dscr_ratio: 'pct', ltv: 'pct', rate_pct: 'pct',
    // int4
    requested_exp_flips: 'int', requested_exp_ground: 'int',
    requested_exp_holds: 'int', requested_exp_reo: 'int',
    sqft_post: 'int', sqft_pre: 'int', units: 'int',
    /* int4 with a CHECK narrower than the type (db/030), so the CONSTRAINT is
       the ceiling and int4's number would be the wrong one to quote. */
    requested_ir_months: IR_MONTHS,
  }),
  borrowers: Object.freeze({
    /* int4. The 300–850 rule is business policy (fields.sanitizeFico), not a
       storage limit, so it is deliberately NOT stated here — this table answers
       "what can the column hold", and the doors keep their own kinder wording. */
    fico: 'int',
    dependents_count: 'int', months_at_residence: 'int', tier: 'int',
    // …and the two that are neither money nor a percent, which is exactly why
    // the {precision, scale} kind had to exist.
    housing_payment: { precision: 12, scale: 2 },
    years_at_residence: { precision: 4, scale: 1 },
  }),
});

/* What a message should CALL a column. Only the ones a person actually sees are
   worth spelling out; anything else is humanized from the column name, which
   still reads far better than raw snake_case. */
const COLUMN_LABEL = Object.freeze({
  purchase_price: 'Purchase price', as_is_value: 'As-is value',
  arv: 'After-repair value', rehab_budget: 'Rehab budget',
  loan_amount: 'Loan amount', payoff_amount: 'Payoff amount',
  original_purchase_price: 'Original purchase price',
  underlying_contract_price: 'Original contract price',
  assignment_fee: 'Assignment fee',
  requested_ir_amount: 'Interest reserve amount',
  requested_ir_months: 'Interest reserve (months)',
  estimated_rental_income: 'Estimated rental income',
  units: 'Number of units', sqft_pre: 'Square footage before',
  sqft_post: 'Square footage after', ltv: 'LTV', rate_pct: 'Rate',
  fico: 'Credit score',
});
function humanizeColumn(column) {
  const s = String(column || '').replace(/_/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : 'That value';
}

/** The column's type, or null when this table/column has no ceiling to enforce. */
function columnKindOf(table, column) {
  const t = COLUMN_KIND[table];
  return (t && Object.prototype.hasOwnProperty.call(t, column)) ? t[column] : null;
}

/**
 * The reason `n` cannot be stored in `table.column`, or '' if it can.
 *
 * A column this table does not know is NOT an error — it is a column with no
 * ceiling worth enforcing (text, a date, a bare `numeric`), so the answer is
 * "nothing wrong". A door must never be blocked by a gap in a lookup table.
 */
function tableColumnProblem(table, column, n, label) {
  const kind = columnKindOf(table, column);
  if (!kind) return '';
  return columnProblem(column, n, kind, label || COLUMN_LABEL[column] || humanizeColumn(column));
}

/** Convenience for the many doors that only ever write `applications`. */
function applicationColumnProblem(column, n, label) {
  return tableColumnProblem('applications', column, n, label);
}

/**
 * DROP-MODE: null out every value in `bag` that its column cannot hold, and
 * return the keys dropped. MUTATES `bag`. Never throws.
 *
 * For the doors with NO HUMAN TO ANSWER — an import, an inbound sync, a
 * post-commit follow-up — where refusing means losing an entire import or
 * breaking one task's sync forever, and where the value we already hold is a
 * better answer than a failure. A door with somebody at it should call
 * `tableColumnProblem` and say what is wrong instead.
 *
 * `''` is "not provided", not zero: `Number('')` is 0, which would sail through
 * every check and then be bound as an empty string. A value that is not a number
 * at all is dropped too — 22P02 breaks a sync exactly as 22003 does.
 */
function dropUnstorable(table, bag, onDrop) {
  const dropped = [];
  if (!bag || typeof bag !== 'object') return dropped;
  for (const k of Object.keys(bag)) {
    if (!columnKindOf(table, k) || bag[k] == null) continue;
    const raw = bag[k];
    const txt = typeof raw === 'number' ? null : String(raw).trim();
    const n = txt === null ? raw : (txt === '' ? NaN : Number(txt));
    if (Number.isFinite(n) && !tableColumnProblem(table, k, n)) continue;
    bag[k] = null;
    dropped.push(k);
  }
  if (dropped.length && typeof onDrop === 'function') { try { onDrop(dropped); } catch (_) {} }
  return dropped;
}

module.exports = {
  MONEY_MAX, INT_MAX, INT_MIN, RATE_MAX, PCT_MAX,
  MONEY_LIMIT_TEXT, INT_LIMIT_TEXT,
  moneyOverflows, rateOverflows, pctOverflows, intOverflows, numericOverflows,
  limitText, columnProblem,
  COLUMN_KIND, COLUMN_LABEL, columnKindOf, tableColumnProblem, applicationColumnProblem,
  dropUnstorable,
};
