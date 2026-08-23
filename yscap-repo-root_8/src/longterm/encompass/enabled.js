'use strict';
/**
 * LONG-TERM — the master Encompass switch, Long-Term's own copy of the rule.
 *
 * THE SAME ONE ENV VAR the RTL side reads (`ENCOMPASS_ENABLED`), read here
 * INDEPENDENTLY. Long-Term may not import RTL code — that is the hard product-
 * separation rule and the gate enforces it — so this is a MIRROR rather than a
 * second decision: `src/lib/integrations/encompass-enabled.js` is the RTL half,
 * this is the Long-Term half, and `scripts/test-encompass-kill-switch-pure.js`
 * runs BOTH over the same inputs and FAILS the moment they disagree. Two copies of
 * a rule drift, and the one that drifts is the one that leaks — so the test is what
 * makes the mirror safe. Change one, change the other.
 *
 * THE VALUE:
 *   unset / blank        → ON   (no deployment changes behaviour by upgrading)
 *   0 / false / no / off → OFF  (nothing in PILOT talks to Encompass)
 *   anything else        → ON
 *
 * WHY ONE VARIABLE AND NOT AN `LT_` ONE. The owner asked for a single thing to set
 * that "disables all the Encompass credentials" — and both products sign in to the
 * SAME Encompass tenant as the SAME user (Long-Term's `LT_ENCOMPASS_*` vars fall
 * back to the shared `ENCOMPASS_*` ones). A per-product switch would let somebody
 * turn Encompass "off" and still have half the system logging in.
 *
 * PURE — no requires, no config, no database. Read at CALL time, never captured at
 * boot.
 */

/** The one env var name, so nothing anywhere has to spell it. */
const ENV_NAME = 'ENCOMPASS_ENABLED';

/** OFF is stated explicitly; every other value (including blank) is ON. */
const OFF_RE = /^(0|false|no|off)$/i;

/** The rule itself, over a RAW value — the mirror test drives this directly. */
function switchIsOn(raw) {
  const v = String(raw == null ? '' : raw).trim();
  if (!v) return true;
  return !OFF_RE.test(v);
}

/** Is the Encompass connection switched on? Reads the environment every time. */
function encompassEnabled() {
  return switchIsOn(process.env[ENV_NAME]);
}

/**
 * What a screen or a refused request says when it is off. Plain language: whoever
 * reads this is being told a connection is down, and "not configured" would send
 * them hunting for a credential that is actually sitting right there.
 */
const OFF_REASON =
  'Encompass is switched off (ENCOMPASS_ENABLED is set to off). '
  + 'Remove that setting — or set it to 1 — to turn Encompass back on.';

module.exports = { ENV_NAME, encompassEnabled, switchIsOn, OFF_REASON };
