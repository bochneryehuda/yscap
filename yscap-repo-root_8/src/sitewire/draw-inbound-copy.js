'use strict';
/**
 * THE WORDING FOR THE INTERNAL "A NEW DRAW REQUEST CAME IN" EMAIL.
 *
 * Owner-directed 2026-08-03, on the staff draw notifications: *"it should say how much the draw
 * request is — the dollar amount — and if it's a VIRTUAL or a PHYSICAL inspection. And if it's an
 * internal email, it should say whether it's something that needs action or not: if it's a
 * TrustPoint file from Blue Lake the draw coordinator has to enter the draw (a task); a physical
 * inspection that goes into Trinity is also a task; a Sitewire virtual inspection has no task
 * because it runs automatically."*
 *
 * The DOLLAR AMOUNT and the budget breakdown come from the money block (`draw-email-blocks.js` →
 * `drawFigures`/`drawFacts`) — the ONE money source — so this module never touches a number. It
 * decides only the two words a person reads first: is this a PHYSICAL or a VIRTUAL inspection, and
 * does it NEED me to do something or does it run on its own.
 *
 * The routing is exactly the one the reconcile already resolved (`ctx.platform` / `ctx.method`):
 *   · platform 'trustpoint'      → the coordinator hand-enters it in TrustPoint  → ACTION NEEDED
 *   · method  'traditional'      → physical on-site inspection, entered in Trinity → ACTION NEEDED
 *   · otherwise (Sitewire)       → virtual inspection, runs automatically          → no action
 *
 * PURE: no DB, no network — unit-testable, and safe to call from a notification path that must
 * never throw.
 */

/**
 * @param platform  the file's draw platform ('trustpoint' | 'sitewire' | null)
 * @param method    the inspection method ('traditional' = physical | else virtual)
 * @param submitted whether the inbound draw is already in a SUBMITTED state (TrustPoint only —
 *                  decides "a task WAS opened" vs "a task WILL open once it is submitted")
 * @returns { methodLabel, actionNeeded, actionLabel, nextStep }
 */
function inboundDrawCopy({ platform = null, method = null, submitted = false } = {}) {
  const physical = method === 'traditional';
  const methodLabel = physical ? 'Physical (on-site) inspection' : 'Virtual inspection';

  if (platform === 'trustpoint') {
    return {
      methodLabel,
      actionNeeded: true,
      actionLabel: 'Action needed',
      nextStep: submitted
        ? 'This file\'s draws are administered on TrustPoint — a task was opened for the draw coordinator to enter it there.'
        : 'This file\'s draws are administered on TrustPoint — a task will open for the draw coordinator once it is submitted.',
    };
  }

  if (physical) {
    return {
      methodLabel,
      actionNeeded: true,
      actionLabel: 'Action needed',
      // Keeps the original instruction and adds where the draw is entered (owner: Trinity).
      nextStep: 'Review it and arrange the on-site inspection (entered in Trinity).',
    };
  }

  return {
    methodLabel,
    actionNeeded: false,
    actionLabel: 'No action needed — automatic',
    nextStep: 'Review it and start the inspection. The virtual inspection runs automatically through Sitewire — no task is opened.',
  };
}

module.exports = { inboundDrawCopy };
