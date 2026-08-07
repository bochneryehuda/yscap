'use strict';

/* WHAT A FILE CARRIES OF ITS OWN ACCORD — one definition, for every door.
 * ---------------------------------------------------------------------------
 * Owner-directed 2026-08-07, after a live divergence:
 *
 *   "Whatever you see on the screen, according to the eligibility, that should be
 *    exactly what's getting registered, and that should be exactly what's going on
 *    on the final term sheet. This can cause us to not be able to sell files."
 *
 * THE CLASS. A price is produced at EIGHT places (staff panel quote, staff what-if,
 * staff register, borrower panel quote, borrower what-if, borrower register, the
 * accept-counter replay, and the public auto-register). Each one assembles the
 * engine's overrides itself. The moment ONE of them layers on something the others
 * do not, the screen, the registration and the printed term sheet stop agreeing —
 * and nothing errors, because every one of them is individually "working".
 *
 * That is exactly what happened: a staff-set loan ceiling was re-applied on the
 * borrower REGISTER route only, so the borrower's studio quoted the file $652,200 at
 * 9.250% while registering produced $489,150 at 8.500%. The money direction was safe
 * (the ceiling held), but the paper disagreed with the file — which is the one thing
 * a term sheet may never do.
 *
 * THE FIX IS A CHOKEPOINT, NOT A THIRD PATCH. Anything a FILE carries on its own —
 * independent of who is asking or which screen they are on — belongs here, and every
 * pricing surface layers it UNDER the caller's own request. A door that forgets to
 * call this is caught by `scripts/test-quote-register-parity-db.js`, which prices
 * every door against the same file and refuses any disagreement.
 *
 * WHY NOT `buildInputs`: it is synchronous and pure over a row it is handed, and it
 * already carries the values that live ON `applications` (the sticky markups, the
 * liquidity-buffer waiver). This reads a DIFFERENT table — the file's current
 * registration — so it needs IO, which `buildInputs` deliberately does not do.
 *
 * PRECEDENCE. Sticky is the BASE; an explicit request wins. That is what lets staff
 * — who can see the box — change or clear the amount, while a borrower, who cannot
 * see it and whose allowlist refuses it, always inherits it.
 */

/** Columns/keys a file carries forward. Add here, and every door inherits it. */
const STICKY_KEYS = Object.freeze(['targetLoan', 'targetLTC', 'targetARLTV']);

/**
 * The overrides this FILE carries of its own accord, from its current registration.
 * Never throws — an unreadable registration must never break a quote or a register;
 * it degrades to "carries nothing", which is the pre-2026-08-07 behaviour.
 *
 * @param {string} appId
 * @param {{query:Function}} client  a pool or an in-transaction client
 * @returns {Promise<object>} e.g. `{ targetLoan: 489150 }` or `{}`
 */
async function fileStickyOverrides(appId, client) {
  const out = {};
  if (!appId || !client || typeof client.query !== 'function') return out;
  try {
    // `is_current` is this table's own current-row flag (unique partial index);
    // there is no superseded_at column. Same predicate experience.js uses.
    const r = await client.query(
      `SELECT inputs FROM product_registrations
        WHERE application_id = $1 AND is_current LIMIT 1`, [appId]);
    const inputs = (r.rows[0] && r.rows[0].inputs) || null;
    if (!inputs || typeof inputs !== 'object') return out;
    for (const k of STICKY_KEYS) {
      const v = Number(inputs[k]);
      // Only a real, positive figure carries. A 0 / null / absent value means the
      // file carries nothing — never a zero ceiling, which would size no loan.
      if (isFinite(v) && v > 0) out[k] = v;
    }
  } catch (_) { /* a file that cannot be read simply carries nothing */ }
  return out;
}

/**
 * Layer the file's sticky values UNDER a caller's own overrides.
 * The caller's explicit value always wins, so a door that can SEE the field can
 * still change or clear it; a door that cannot inherits what the file was
 * structured at.
 */
function withSticky(sticky, requested) {
  return Object.assign({}, sticky || {}, requested || {});
}

/** Convenience: read + layer in one call. */
async function effectiveOverrides(appId, requested, client) {
  return withSticky(await fileStickyOverrides(appId, client), requested);
}

module.exports = { fileStickyOverrides, withSticky, effectiveOverrides, STICKY_KEYS };
