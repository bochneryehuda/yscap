'use strict';
/**
 * Draw-platform ROUTING chokepoint (physical-draw workflow phase 1, owner-directed
 * 2026-07-24 — blueprint docs/TRUSTPOINT-PHYSICAL-DRAW-WORKFLOW-BLUEPRINT.md).
 *
 * One file is only ever live on ONE draw pipeline. The note-buyer rule row says which:
 *   'sitewire'   — PILOT operates the draw in Sitewire (today's behavior, the default).
 *   'trustpoint' — the note buyer's administrator (TrustPoint) owns approvals; the file
 *                  still gets the FULL Sitewire setup (borrower intake + mirror), but a
 *                  submitted draw is hand-entered into TrustPoint by the draw coordinator
 *                  (workflow task, src/sitewire/trustpoint-intake.js) and TrustPoint's
 *                  decisions are mirrored back. Blue Lake physical files.
 *   'external'   — legacy handled_externally: PILOT does nothing (no Sitewire push).
 *
 * platformOf(rule) is the ONE reader — never test rule.handled_externally directly in new
 * code. It tolerates pre-migration rows (draw_platform absent) by falling back to the
 * handled_externally boolean, so behavior is identical until an admin picks a platform.
 * PURE — no I/O, no requires (safe for any module to import without cycles).
 */

const PLATFORMS = ['sitewire', 'trustpoint', 'external'];

/** @returns {'sitewire'|'trustpoint'|'external'} */
function platformOf(rule) {
  if (!rule) return 'sitewire';
  const p = rule.draw_platform;
  if (p && PLATFORMS.includes(p)) return p;
  return rule.handled_externally ? 'external' : 'sitewire';
}

/** The file is administered on TrustPoint (Sitewire is intake+mirror only). */
function isTrustpoint(rule) { return platformOf(rule) === 'trustpoint'; }
/** PILOT must not push this file to Sitewire at all (legacy handled-externally). */
function isExternal(rule) { return platformOf(rule) === 'external'; }

/**
 * Resolve the effective platform + inspection method for a FILE. Lazy-requires the
 * orchestrator (which imports nothing from here) so there is no module cycle. Returns
 * { platform, method, rule } — method is the resolved effective inspection method
 * ('mobile'|'traditional') or null when unknown. Best-effort: any resolution failure
 * returns the safe default ('sitewire', null) rather than throwing into a poll loop.
 */
async function resolveFilePlatform(appId) {
  try {
    const orchestrator = require('./orchestrator');
    const a = await orchestrator.loadFile(appId);
    if (!a) return { platform: 'sitewire', method: null, rule: null, resolved: true };
    const program = /gold/i.test(String(a.registered_program || '')) ? 'gold' : 'standard';
    const cp = await orchestrator.resolveCapitalPartnerId(a.lender);
    const rule = await orchestrator.resolveRule(a.lender, cp && cp.id, program);
    const link = await orchestrator.getLink(appId);
    const insp = orchestrator.resolveInspection(link, rule);
    return { platform: platformOf(rule), method: (insp && insp.method) || null, rule, resolved: true };
  } catch (_) {
    // resolved:false = "could not actually look" — callers making a MONEY decision must
    // treat this differently from a real 'sitewire' answer (never fail open on money).
    return { platform: 'sitewire', method: null, rule: null, resolved: false };
  }
}

module.exports = { PLATFORMS, platformOf, isTrustpoint, isExternal, resolveFilePlatform };
