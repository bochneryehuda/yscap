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

/* ---------------------------------------------------------------------------
 * ORDERING ONE BY HAND, ON A FILE THAT IS NOT TRINITY'S (owner-directed 2026-08-21, item 25)
 * ---------------------------------------------------------------------------
 * The owner: *"At any time, even though a process is not set up for autopilot on Trinity
 * (for example, something that belongs to Bluelake before it's sold or something that is
 * set up for virtual but, one time, he doesn't have access and he wants to order a
 * physical), we should have a full section set up … and it should be able to be manually
 * placed on any file."*
 *
 * THE RULE ABOVE DOES NOT MOVE. `isTrinityFile` still decides what happens BY ITSELF — the
 * autopilot, the Sitewire door, the portal composer — so a virtual file's automatic
 * inspections stay Sitewire's and a Blue Lake file's stay TrustPoint's, exactly as the
 * 2026-08-14 direction requires. What is added is a DELIBERATE HUMAN ACT beside it.
 *
 * FOUR THINGS MAKE THAT SAFE, and none of them may be dropped:
 *   1. IT IS NEVER AUTOMATIC. Only a coordinator pressing the button reaches this, and the
 *      three automatic doors do not pass `override` at all.
 *   2. A TYPED REASON IS REQUIRED. This costs money and sends a person to somebody's
 *      property against the file's own configured setup — the file must record WHY.
 *   3. THE SECOND-INSPECTOR HAZARD IS SAID OUT LOUD, not hidden. On a virtual file
 *      Sitewire is already inspecting; on a Blue Lake file TrustPoint is. Ordering here
 *      adds a physical inspector ON TOP — which is precisely what the owner is asking for
 *      ("one time he doesn't have access and he wants to order a physical"), so it is a
 *      WARNING to acknowledge, never a silent allowance.
 *   4. AN UNREADABLE FILE IS STILL REFUSED. `resolved:false` means we could not look up the
 *      file's own setup — a transient fault, not a business state. Everything else here is
 *      a human overruling a KNOWN state; overruling an UNKNOWN one is guessing, and this
 *      order dispatches a real person to a real address. Try again in a moment.
 */

/** A reason short enough to be meaningless is not a reason. */
const MIN_OVERRIDE_REASON = 8;

/** Can a human overrule the routing on this file at all? Every real business state, yes —
 *  a file we could not READ, no (rule 4 above). */
function mayOverrideRouting(ctx) {
  if (!ctx) return false;
  if (ctx.resolved === false) return false;
  return true;
}

/** What a coordinator is being asked to acknowledge, in the owner's own terms. Null when
 *  the file is Trinity's anyway and there is nothing to warn about. */
function overrideWarning(ctx) {
  if (!ctx || isTrinityFile(ctx)) return null;
  const p = String((ctx && ctx.platform) || '');
  if (p === 'trustpoint') {
    return 'This file’s draws are administered by the note buyer (Blue Lake / TrustPoint), who runs their '
      + 'own inspections. Ordering here sends a Trinity inspector as well — the two do not know about '
      + 'each other, and Trinity charges for it.';
  }
  if (p === 'external') {
    return 'This file’s draws are run entirely in the partner’s own system. Ordering here sends a Trinity '
      + 'inspector that their process does not know about, and Trinity charges for it.';
  }
  if (!PHYSICAL_METHODS.has(String((ctx && ctx.method) || ''))) {
    return 'This file is set up for VIRTUAL inspections, which Sitewire is already doing. Ordering here '
      + 'sends a physical inspector as well — Trinity charges for it, and the virtual inspection still runs.';
  }
  return 'This file is not set up for Trinity inspections. Ordering here places one anyway, and Trinity '
    + 'charges for it.';
}

/**
 * The whole decision for ONE hand-placed order — PURE, so every branch is testable with no
 * database and both doors (the route and `intake.orderManually`) read the same answer.
 *
 * @param ctx  the file's routing, as `routing.resolveFilePlatform` produces it
 * @param opts {{ override?:boolean, overrideReason?:string }}
 * @returns {{ ok, override, reason, blockedReason, needsReason, mayOverride, warning }}
 */
function planManualOrder(ctx, opts = {}) {
  const warning = overrideWarning(ctx);
  const mayOverride = mayOverrideRouting(ctx);
  if (isTrinityFile(ctx)) {
    return { ok: true, override: false, reason: null, blockedReason: null, needsReason: false, mayOverride, warning: null };
  }
  const blockedReason = reasonNotTrinity(ctx);
  const asked = opts && (opts.override === true || opts.override === 'true');
  if (!asked) return { ok: false, override: false, reason: null, blockedReason, needsReason: false, mayOverride, warning };
  if (!mayOverride) {
    return { ok: false, override: false, reason: null, needsReason: false, mayOverride: false, warning,
      blockedReason: 'the file’s setup could not be read just now — try again in a moment' };
  }
  const reason = String((opts && opts.overrideReason) || '').trim();
  if (reason.length < MIN_OVERRIDE_REASON) {
    return { ok: false, override: true, reason: null, blockedReason, needsReason: true, mayOverride, warning };
  }
  return { ok: true, override: true, reason: reason.slice(0, 500), blockedReason: null, needsReason: false, mayOverride, warning };
}

module.exports = {
  PHYSICAL_METHODS, isTrinityFile, reasonNotTrinity, portalPlatformFor,
  MIN_OVERRIDE_REASON, mayOverrideRouting, overrideWarning, planManualOrder,
};
