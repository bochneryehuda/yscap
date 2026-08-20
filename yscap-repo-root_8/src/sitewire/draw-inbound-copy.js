'use strict';
/**
 * THE WORDING FOR THE TWO INTERNAL DRAW NOTIFICATIONS — a draft that was STARTED
 * (`draftStartedCopy`) and a draw that was SUBMITTED FOR REVIEW
 * (`inboundDrawCopy`). They are two different events; until 2026-08-20 they
 * shared one sentence, and the desk read every Start button as a request.
 *
 * ── inboundDrawCopy — "a draw was submitted" ────────────────────────────────
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

/* ── draftStartedCopy — "a borrower started a draft" ────────────────────────── */

/**
 * THE BORROWER PRESSED START — nothing has been submitted (owner-reported
 * 2026-08-20: "he just clicks Start, and he's starting to take pictures.
 * Sometimes it could take a few days … it sounds for our team that this is an
 * actual draw request that he submitted already. The truth is that he just
 * started a draft").
 *
 * EVERY WORD HERE IS CHOSEN TO SAY "NOT YET":
 *   · the phase is named FIRST ("started a draft"), before anything else, because
 *     the desk reads the title and the first clause and stops;
 *   · it states plainly that nothing is needed from us yet — the old copy's
 *     "Action needed" badge on a draft is exactly what made the desk act early;
 *   · it PROMISES the next email, so silence afterwards is not read as the draw
 *     having been forgotten;
 *   · it never quotes an amount as though it were a request. A draft's figures
 *     move while the borrower works, and the caller drops the money band when
 *     there is nothing real in it.
 *
 * The routing sentence is deliberately FUTURE tense on both action platforms
 * ("a task WILL open once it is submitted"), matching `inboundDrawCopy`'s own
 * not-yet-submitted branch, so the two can never tell the desk different things
 * about the same file.
 *
 * @param platform 'trustpoint' | 'sitewire' | 'trinity' | null
 * @param method   'traditional' = physical | else virtual
 * @param phaseKnown false when Sitewire gave a status we do not recognise
 * @returns { methodLabel, actionNeeded:false, actionLabel, nextStep, whenItLands }
 */
function draftStartedCopy({ platform = null, method = null, phaseKnown = true } = {}) {
  const physical = method === 'traditional';
  const methodLabel = physical ? 'Physical (on-site) inspection' : 'Virtual inspection';

  const whenItLands = platform === 'trustpoint'
    ? 'Once they submit it, a task will open for the draw coordinator to enter it into TrustPoint.'
    : physical
      ? 'Once they submit it, we will arrange the on-site inspection.'
      : 'Once they submit it, the virtual inspection runs automatically through Sitewire.';

  return {
    methodLabel,
    actionNeeded: false,
    // Deliberately NOT the phrase "action needed": the desk scans for it, and a
    // negated form of the words they are scanning for is read as the words.
    actionLabel: 'nothing to do yet — this is a draft',
    nextStep: 'Nothing is needed from the draw desk yet. We will email again the moment it is submitted for review.'
      + (phaseKnown ? '' : ' (Sitewire reported a status we do not recognise, so treat the phase as unconfirmed.)'),
    whenItLands,
  };
}

module.exports = { inboundDrawCopy, draftStartedCopy };
