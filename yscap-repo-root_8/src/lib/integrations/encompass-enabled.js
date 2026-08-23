'use strict';
/**
 * THE MASTER ENCOMPASS SWITCH — one env var that turns the whole Encompass
 * connection off (owner-directed 2026-08-23: *"I want you to set in the
 * credential something and give me what I can set, like Encompass enabled, and I
 * can click zero or one, whatever, to make sure that the system disables all the
 * Encompass credentials."*).
 *
 * WHY IT EXISTS. Every Encompass credential in this system is the same tenant
 * login, and PILOT signs in as a REAL Encompass USER (the resource-owner password
 * grant). So when something goes wrong at the Encompass end — a locked account, a
 * corrupted instance, a vendor incident — the owner needs ONE thing to set that
 * stops PILOT reaching Encompass at all, without a code change and without hunting
 * through six per-feature switches. This is that thing.
 *
 * THE VALUE, and why blank means ON.
 *   unset / blank        → ON   (every existing deployment is unaffected)
 *   0 / false / no / off → OFF  (nothing in PILOT talks to Encompass)
 *   anything else (1, yes, on, true) → ON
 * Blank-is-ON is the same convention `LT_SYNC_ENABLED` already uses, and it is the
 * safe default here: a deployment that has never heard of this variable must not
 * silently lose its Encompass connection on the next deploy.
 *
 * IT IS READ AT CALL TIME, never captured at boot, so nothing has to remember to
 * re-read it and no cached copy can go stale.
 *
 * PURE — no requires, no config, no database. That matters for two reasons: it can
 * be loaded by a module that runs before config is built, and it is the RTL half of
 * a MIRROR. Long-Term may not import RTL code (product separation), so
 * `src/longterm/encompass/enabled.js` carries the identical rule for that side, and
 * `scripts/test-encompass-kill-switch-pure.js` runs BOTH over the same inputs and
 * fails the moment they disagree. Change one, change the other.
 *
 * WHAT IT DOES NOT DO. It never deletes, rotates or rewrites a credential — the
 * values stay exactly where they are in the environment. It makes every Encompass
 * client answer "not connected" and refuses every outbound request BEFORE it is
 * built, so the connection is dead while the switch is off and alive again the
 * moment it is removed.
 */

/** The one env var name, so nothing anywhere has to spell it. */
const ENV_NAME = 'ENCOMPASS_ENABLED';

/** OFF is stated explicitly; every other value (including blank) is ON. */
const OFF_RE = /^(0|false|no|off)$/i;

/**
 * The rule itself, over a RAW value — exported so the mirror test can drive both
 * sides with the same inputs without touching process.env.
 */
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
 * What a screen, a log line or a refused request says when it is off. Plain
 * language on purpose: whoever reads this is being told a connection is down, and
 * "not configured" would send them hunting for a missing credential that is
 * actually sitting right there.
 */
const OFF_REASON =
  'Encompass is switched off (ENCOMPASS_ENABLED is set to off). '
  + 'Remove that setting — or set it to 1 — to turn Encompass back on.';

module.exports = { ENV_NAME, encompassEnabled, switchIsOn, OFF_REASON };
