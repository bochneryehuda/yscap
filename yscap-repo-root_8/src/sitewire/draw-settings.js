'use strict';
/**
 * DRAW SETTINGS — the resolvers, in ONE place.
 *
 * A draw setting can be answered at more than one level (the company default in
 * `sitewire_settings`, the capital provider's rule row, this project's link row), and the answer
 * is read by the desk, the money routes, the reminders and the automatic ledger writer. Every one
 * of those used to carry its own copy of the fall-through, which is exactly how two surfaces end
 * up disagreeing about the same file.
 *
 * The two resolvers here were MOVED verbatim out of `src/routes/sitewire.js` (which now delegates
 * to them) so the automatic release path cannot drift from the manual one — the two write into the
 * same ledger, and a retainage % or a lien-waiver switch that differed between them would put two
 * different answers about one draw's money in front of the same person.
 *
 * Both FAIL CLOSED the way money code must: an unreadable setting reads as "no retainage" (holding
 * too little on one release is recoverable; double-withholding takes the borrower's money) and as
 * "waivers off" only when nothing anywhere says otherwise.
 */

const db = require('../db');

const clampPct = (n) => Math.min(100, Math.max(0, Number(n) || 0));

/**
 * The retainage % held back from each approved draw on this file.
 *
 * ZERO on a TrustPoint-administered file, and zero when the platform cannot be resolved: there the
 * ADMINISTRATOR owns retainage, and PILOT holding its own % on top would double-withhold from the
 * borrower. Killing it at this one chokepoint covers every caller (the manual release, the
 * automatic one, and the desk's overview).
 */
async function retainagePctFor(appId) {
  try {
    const rp = await require('./routing').resolveFilePlatform(appId);
    if (rp && (rp.platform === 'trustpoint' || rp.resolved === false)) return 0;
    const link = (await db.query(`SELECT retainage_pct FROM sitewire_property_links WHERE application_id=$1`, [appId])).rows[0];
    if (link && link.retainage_pct != null) return clampPct(link.retainage_pct);
    const s = (await db.query(`SELECT value FROM sitewire_settings WHERE key='retainage_pct'`)).rows[0];
    return clampPct(s && s.value);
  } catch (_) { return 0; }
}

/**
 * Are lien waivers gating releases on this file? OFF by default. A specific PROJECT can turn them
 * on (the per-file override on the link), otherwise the company-wide `require_lien_waivers`
 * setting applies — most projects do not use them.
 *
 * The setting is compared to `true` / the STRING 'true' deliberately: `sitewire_settings.value` is
 * jsonb and has been written both ways, and a bare truthiness test would read the string "false"
 * as ON — turning a gate nobody asked for onto every release.
 */
async function lienGateEnabled(appId) {
  try {
    if (appId) {
      const link = (await db.query(`SELECT require_lien_waivers FROM sitewire_property_links WHERE application_id=$1`, [appId])).rows[0];
      if (link && link.require_lien_waivers != null) return !!link.require_lien_waivers;
    }
    const s = (await db.query(`SELECT value FROM sitewire_settings WHERE key='require_lien_waivers'`)).rows[0];
    return !!(s && (s.value === true || s.value === 'true'));
  } catch (_) { return false; }
}

module.exports = { retainagePctFor, lienGateEnabled, _internals: { clampPct } };
