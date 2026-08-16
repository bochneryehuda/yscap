'use strict';
/**
 * "Does THIS file's physical inspection belong to Trinity?" — the ONE definition, and
 * the reason this file exists at all.
 *
 * PURE. No database, no network, no requires — so the rule can be reasoned about and
 * unit-tested on its own, and so any module may import it without a cycle.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS FIXES
 * ---------------------------------------------------------------------------
 * The general physical program has always had TWO doors (docs/TRINITY-INSPECTION-API-
 * RESEARCH.md §8): the PORTAL composer, and a draw submitted in SITEWIRE on a physical
 * non-Blue-Lake file. Each door decided for itself what a "Trinity file" was:
 *
 *   · the portal composer asked `method === 'traditional'` and `platform !== 'external'`,
 *     then labelled anything that was not TrustPoint as 'trinity' — correct;
 *   · the Sitewire door asked `platform === 'trinity'` — which `routing.platformOf` can
 *     NEVER return. Its only answers are 'sitewire', 'trustpoint' and 'external'
 *     (`routing.PLATFORMS`), so that branch was unreachable and a physical draw
 *     submitted through Sitewire never ordered an inspection at all.
 *
 * Two definitions of one rule is how that happened, so there is now one definition and
 * both doors call it.
 *
 * ---------------------------------------------------------------------------
 * THE RULE
 * ---------------------------------------------------------------------------
 * Trinity gets the inspection when ALL of these hold:
 *
 *   1. the inspection method is PHYSICAL (`traditional`) — a VIRTUAL file is Sitewire's
 *      and its autopilot is untouched (owner-directed 2026-08-14: *"Don't mess up
 *      sitewire integration for any virtuals. Don't touch that."*);
 *   2. the draw platform is `sitewire` — i.e. PILOT administers the draw. `trustpoint`
 *      is Blue Lake and is inspected and approved on their side (*"Don't touch the
 *      trust point integration that we already have for Bluelake"*), and `external` is
 *      run entirely in a partner's own system;
 *   3. we ACTUALLY RESOLVED the file's routing.
 *
 * Point 3 is not a formality. `routing.resolveFilePlatform` returns the SAFE DEFAULT
 * `{platform:'sitewire', method:null}` when it could not look — and it says so with
 * `resolved:false`. Ordering an inspection spends real money and sends a real person to
 * a real address, so an unresolved file must answer NO. `method` is already null in that
 * case and would fail rule 1 on its own; `resolved` is checked explicitly anyway,
 * because relying on that coincidence is exactly the kind of accident this module was
 * written to end.
 *
 * Everything here fails CLOSED: anything not positively known to be a Trinity file
 * answers false, and `reasonNotTrinity` says which rule refused so a human never has to
 * guess why an order did not appear.
 */

/** The inspection methods that mean "a person physically visits the property". */
const PHYSICAL_METHODS = new Set(['traditional']);

/**
 * @param ctx {{platform?:string, method?:string, resolved?:boolean}} — as produced by
 *   `routing.resolveFilePlatform`. `resolved` may be omitted by callers that already
 *   know the routing is good (the portal composer awaits it directly); it is only ever
 *   treated as a refusal when it is EXPLICITLY false.
 * @returns {boolean}
 */
function isTrinityFile(ctx) {
  if (!ctx) return false;
  if (ctx.resolved === false) return false;              // could not look → never order
  if (!PHYSICAL_METHODS.has(String(ctx.method || ''))) return false;   // virtual is Sitewire's
  return String(ctx.platform || '') === 'sitewire';      // trustpoint = Blue Lake, external = theirs
}

/**
 * The same rule, said out loud. Returns null when the file IS Trinity's, else a short
 * plain-language reason — for logs and for the desk, never for a borrower.
 */
function reasonNotTrinity(ctx) {
  if (!ctx) return 'the file routing was not supplied';
  if (ctx.resolved === false) return 'the file routing could not be resolved';
  if (!ctx.method) return 'the inspection method is not known yet';
  if (!PHYSICAL_METHODS.has(String(ctx.method))) return 'this file is on virtual inspections (Sitewire)';
  const p = String(ctx.platform || '');
  if (p === 'trustpoint') return 'this file is administered by the note buyer (Blue Lake / TrustPoint)';
  if (p === 'external') return 'this file is handled entirely in the partner’s own system';
  if (p !== 'sitewire') return `unknown draw platform "${p}"`;
  return null;
}

/**
 * Which portal-draw platform a resolved file belongs to — the value stored on
 * `portal_draw_requests.platform`. Blue Lake files are 'trustpoint'; every other
 * physical file is 'trinity'.
 *
 * Deliberately NOT the same question as `isTrinityFile`: the composer labels a request
 * before it checks eligibility (an 'external' file has no composer at all, but must
 * still not be mislabelled), so this keeps the historical labelling exactly as it was.
 */
function portalPlatformFor(ctx) {
  return String((ctx && ctx.platform) || '') === 'trustpoint' ? 'trustpoint' : 'trinity';
}

module.exports = { PHYSICAL_METHODS, isTrinityFile, reasonNotTrinity, portalPlatformFor };
