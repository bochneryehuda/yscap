'use strict';
/**
 * R6.5 — Stale-registration detector (deterministic core).
 *
 * A registration is STALE when the loan's CURRENT pricing inputs no longer match
 * the inputs the registered quote was priced on — the structure was priced on
 * numbers that have since changed, so its terms can't be issued until it is
 * re-registered. The db/071/072 triggers already flag this at write time; this
 * is the belt-and-suspenders IN-CODE check the whole-loan run applies at
 * decision time (so a run can NEVER approve a structure priced on stale inputs,
 * even if a trigger was bypassed).
 *
 * The pricing inputs that matter (a change to any = re-price required) mirror
 * the db/072 reopen trigger's input set.
 *
 * Pure: no DB, no AI.
 */

// The inputs a registration is priced on. A change to any → stale.
const PRICING_INPUT_KEYS = Object.freeze([
  'loan_amount', 'purchase_price', 'as_is_value', 'arv', 'rehab_budget',
  'program', 'loan_type', 'property_type', 'units', 'requested_ir_months',
  'requested_ir_amount', 'is_assignment', 'underlying_contract_price',
  'assignment_fee', 'requested_exp_flips', 'requested_exp_holds',
  'requested_exp_ground', 'fico',
]);

// Two values are "the same" for staleness if they're equal after light
// normalization (numbers within a cent; strings case/space-insensitive; null and
// undefined both mean "absent").
function same(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  const na = Number(a), nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return Math.abs(na - nb) < 0.005;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

/**
 * detectStale(current, registered, keys?) → { stale, changed:[{key,from,to}] }
 *   current:    the file's CURRENT pricing inputs
 *   registered: the inputs the registration was priced on (its stored snapshot)
 * Only compares keys PRESENT in the registered snapshot (a key the registration
 * never priced on can't make it stale). A key missing from `current` but present
 * (non-null) in `registered` IS a change (a value was cleared).
 */
function detectStale(current, registered, keys) {
  const cur = current || {};
  const reg = registered || {};
  const compareKeys = (keys && keys.length) ? keys : PRICING_INPUT_KEYS;
  const changed = [];
  for (const k of compareKeys) {
    if (!(k in reg)) continue;            // registration didn't price on this key
    if (reg[k] == null) continue;         // no registered value → nothing to drift from
    if (!same(cur[k], reg[k])) {
      changed.push({ key: k, from: reg[k], to: (k in cur ? cur[k] : null) });
    }
  }
  return { stale: changed.length > 0, changed };
}

module.exports = { detectStale, PRICING_INPUT_KEYS, _internals: { same } };
