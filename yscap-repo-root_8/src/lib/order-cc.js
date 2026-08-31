'use strict';

/**
 * WHO ELSE IS ON AN ORDER'S THREAD — one definition, both products.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 *
 * The rule was written INLINE in `src/routes/staff.js` (`ccBorrowerFor` /
 * `ccHelperFor`), where no second caller could reach it — the same shape the
 * entity edit rules were in before they moved to `lib/llc-edit.js`. So the
 * long-term order desk passed only what the person placing the order ticked,
 * and the OFFICER'S OWN DEFAULT was never read: an officer who had turned
 * "copy my borrowers on title orders" on got it on their short-term orders and
 * silently not on their long-term ones.
 *
 * Found by the two-product parity engine (`scripts/test-rtl-lt-parity-pure.js`),
 * which is what it is for.
 *
 * ── THE CHAIN, AND WHY ITS ORDER IS THE WHOLE RULE ──────────────────────────
 *
 *   1. what the person placing THIS order ticked            (explicit)
 *   2. what was recorded when the order was first placed    (storedMeta)
 *   3. the officer's own default for this KIND of order     (their setting)
 *   4. the company default                                   (off)
 *
 * Every door that writes to a vendor resolves it the SAME way or the borrower
 * silently joins or leaves the conversation halfway through it — which is the
 * exact reason the short-term side stopped hand-copying it between `place`,
 * `followup` and the Email Center reply.
 *
 * ── WHAT IS NOT HERE, DELIBERATELY ──────────────────────────────────────────
 *
 * WHICH OFFICER. That is a fact about a loan, and the two products keep loans in
 * their own tables — a shared module reading `applications` would be the
 * short-term product's own code wearing a shared module's clothes, and the
 * separation rule forbids the reverse outright. Each product resolves its own
 * officer and passes the id. The SETTING itself is per-STAFFER (db/391), and the
 * staff roster is the shared identity zone, so both products may read it.
 *
 * NEVER THROWS: an unreadable setting falls through to the company default, so
 * a database hiccup can never stop an order going out — and it can never
 * silently ADD somebody to the thread either, because the fallback is off.
 */

const orderEmail = require('./order-email');

/** The default reader; injectable so the whole chain is testable with no database. */
function defaultGetSetting(staffId, key) {
  return require('./lo-settings').getSetting(staffId, key);
}

/**
 * THE DECISION, PURE — no database, no await, no way to fail.
 *
 * `settings` is the officer's settings bag (may be `{}` or absent). It is a BAG
 * rather than one value because the two callers reach it differently and neither
 * may end up with its own copy of the rule: the ORDER DESK fetches one setting
 * when it is about to send, and the ORDERS PANEL already holds the whole bag
 * because it is painting every checkbox on the screen at once. Same decision,
 * two ways of supplying the input — the shape `llc-edit`'s document lock uses,
 * and for the same reason.
 */
function decide(kind, opts, spec) {
  const o = opts || {};
  if (o.explicit != null) return !!o.explicit;
  const meta = o.storedMeta;
  if (meta && typeof meta === 'object' && meta[spec.field] != null) return !!meta[spec.field];
  const key = spec.keyFor(kind);            // TITLE and INSURANCE each have their own default
  const bag = o.settings && typeof o.settings === 'object' ? o.settings : {};
  return spec.defaultFor(kind, key ? bag[key] === true : false);
}

/** Fetch the one setting this decision needs, then decide. Never throws. */
async function resolve(kind, opts, spec) {
  const o = opts || {};
  if (o.explicit != null || (o.storedMeta && o.storedMeta[spec.field] != null)) {
    return decide(kind, o, spec);           // nothing to fetch — the answer is already settled
  }
  let settings = o.settings || {};
  if (!o.settings) {
    try {
      const key = spec.keyFor(kind);
      if (key && o.officerId) {
        const get = o.getSetting || defaultGetSetting;
        settings = { [key]: (await get(o.officerId, key)) === true };
      }
    } catch (_) { /* the company default stands */ }
  }
  return decide(kind, { ...o, settings }, spec);
}

const BORROWER = {
  keyFor: orderEmail.ccBorrowerSettingKey,
  defaultFor: orderEmail.ccBorrowerDefault,
  field: 'ccBorrower',
};
/**
 * The helper's footing is its OWN question, never a rider on the borrower's — an
 * officer may want the helper chasing the title company while the borrower stays
 * off the chain. A file with no helper on it has nothing to copy either way,
 * which is why a product with no helper login can ask this and get nobody.
 */
const HELPER = {
  keyFor: orderEmail.ccHelperSettingKey,
  defaultFor: orderEmail.ccHelperDefault,
  field: 'ccHelper',
};

/** Is the BORROWER copied on this order's email? (fetches the officer's setting) */
const ccBorrowerFor = (kind, opts) => resolve(kind, opts, BORROWER);
/** Is the borrower's HELPER copied on it? (fetches the officer's setting) */
const ccHelperFor = (kind, opts) => resolve(kind, opts, HELPER);

/** The same two decisions for a caller that already holds the settings bag. */
const ccBorrowerWith = (kind, opts) => decide(kind, opts, BORROWER);
const ccHelperWith = (kind, opts) => decide(kind, opts, HELPER);

module.exports = {
  ccBorrowerFor, ccHelperFor, ccBorrowerWith, ccHelperWith,
  _internals: { decide, resolve, defaultGetSetting, BORROWER, HELPER },
};
