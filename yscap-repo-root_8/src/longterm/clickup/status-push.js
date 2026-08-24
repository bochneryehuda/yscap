'use strict';
/**
 * LONG-TERM — WHETHER to write a ClickUp status, as opposed to WHICH one.
 *
 * `status-engine.desiredStatus` answers "which status does Encompass's ladder
 * imply". That question is not the same as "may PILOT write it", and conflating
 * the two is the defect this module exists to remove.
 *
 * THE DEFECT (owner-reported 2026-08-24). #39 shipped "Encompass always wins,
 * even after manual changes", and push.js implemented it literally: the status
 * was RE-ASSERTED on every full push. `pushPass` takes any linked loan whose
 * mirror moved (`encompass_synced_at > clickup_pushed_at`) or that has never
 * been pushed, and the sync re-reads loans on a rotation — so every card's
 * status was eventually dragged back to the ladder's answer, and switching the
 * writer on for the first time would force the entire never-pushed book in one
 * sweep. A team that had moved a card forward watched PILOT move it back.
 *
 * THE OWNER'S RULE, in their words: *"Only when Encompass is changing a
 * milestone should ClickUp be changing milestones, not go back to all the
 * ClickUp tasks and update everything according to how Encompass is."* And:
 * *"If I put CTC in ClickUp and Encompass is not yet CTC … Encompass doesn't
 * need to push back to ClickUp and say 'hey, update back, it's not CTC'."*
 *
 * So a status write needs a REASON, and the only reason that counts is a
 * milestone that actually fired since the last one we answered:
 *
 *   · A NEW `observed_entered` event  → push (the milestone moved — the event
 *     the owner describes as "Encompass changing a milestone").
 *   · No new event                    → NEVER write, whatever the card holds.
 *     A disagreement is surfaced for a person and left alone.
 *
 * `lt_milestone_events` already draws the distinction this needs:
 * 'observed_entered' is a real move; 'observed_baseline' is a FIRST SIGHTING —
 * where the loan already was — and must never push anything, or every newly
 * mirrored loan would write a status nobody asked for.
 *
 * DIRECTION (owner-directed 2026-08-24, answering this exact question): *"it
 * should not push statuses backwards in ClickUp, but this has exclusions.
 * Assigned to Processor, it should allow pushing it back because that's if we
 * want to reassign the processor. But everything else, you should not be able
 * to push back statuses backwards, only forward."*
 *
 * So a milestone implying a status BEHIND the card is raised for a person
 * rather than written — EXCEPT for the statuses in `BACKWARD_OK`, where moving
 * the card back is the POINT rather than a regression. Today that is exactly
 * one: "assigned to processor", which is how a file is handed to a different
 * processor. The exception is keyed on the status being WRITTEN, not on the one
 * the card holds — the owner's reason is about what that status MEANS.
 *
 * WITHOUT a readable status order the direction is UNKNOWABLE, so it is treated
 * as backwards — refusing to write costs a review row, writing blind costs the
 * team's status, and this whole module exists because that trade was made the
 * wrong way round once already. A `BACKWARD_OK` status is exempt from that too:
 * it may move either way, so there is no direction left to prove.
 *
 * PURE — no database, no client, no clock. The caller supplies `now`.
 */

/** Statuses compare case- and whitespace-blind; ClickUp's own spelling varies. */
const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();

/**
 * The statuses a fired milestone may write even when it moves the card
 * BACKWARDS (owner-directed 2026-08-24). Moving back to "assigned to processor"
 * is how a file is handed to a different processor, so it is the intent rather
 * than a regression. Adding a status here is a real widening of what PILOT may
 * undo on a team's card — it needs the owner's own words, exactly as this one did.
 */
const BACKWARD_OK = new Set(['assigned to processor']);

/** ms since epoch, or null for anything unreadable. NEVER NaN — a NaN compares
 *  false against everything, which would silently read as "no new event". */
function ms(v) {
  if (v == null) return null;
  const t = (v instanceof Date) ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

/**
 * Where a status sits in the destination list's own order.
 * Returns null when the order is unknown or does not carry the status — the
 * caller reads null as "cannot judge direction".
 */
function rankOf(order, status) {
  if (!Array.isArray(order) || !order.length) return null;
  const want = norm(status);
  if (!want) return null;
  const i = order.findIndex((s) => norm(s) === want);
  return i < 0 ? null : i;
}

/**
 * @param {object}   a
 * @param {object}   a.desired       statusEngine.desiredStatus's answer
 * @param {string}   a.current       the status the card holds right now
 * @param {*}        a.watermark     lt_loans.clickup_status_event_at
 * @param {*}        a.latestEntered newest observed_entered observed_at, or null
 * @param {string[]} a.statusOrder   the destination list's statuses, in order
 * @param {Set}      a.backwardOk    statuses exempt from the forward-only rule
 *                                   (defaults to BACKWARD_OK — tests override it)
 * @param {*}        a.now           the clock, supplied so this stays pure
 *
 * @returns {{act:'none'|'baseline'|'agree'|'push'|'review', ...}}
 *   none     — do not touch the status, and nothing to show a person
 *   baseline — first sighting: take the watermark, write nothing
 *   agree    — the card already holds it
 *   push     — write `to`
 *   review   — show a person `current` vs `proposed`; write nothing
 *   Every answer carries `stamp` (advance the watermark?) and `reason` (words
 *   for the journal and the review row — this is what a human reads).
 */
function decideStatusPush({
  desired, current, watermark, latestEntered, statusOrder, backwardOk, now,
} = {}) {
  const want = desired && desired.status ? String(desired.status).trim() : null;
  const have = String(current == null ? '' : current).trim();

  // The engine claiming nothing is not a licence to write nothing-shaped: an
  // unread funding channel, a loan with no ladder yet. Never a push, and never
  // a review row either — we have no opinion to put in front of anybody.
  if (!want) {
    return { act: 'none', stamp: false, reason: (desired && desired.reason) || 'the status engine claimed no status' };
  }

  const markMs = ms(watermark);
  const eventMs = ms(latestEntered);

  // FIRST SIGHTING. A loan whose watermark has never been set carries its whole
  // history as "new", so answering it would push a status for a milestone that
  // fired before PILOT was ever going to write one — the sweep this module
  // removes, wearing a different hat. Take the watermark, write nothing.
  if (markMs == null) {
    return {
      act: 'baseline',
      stamp: true,
      stampTo: now || new Date(),
      reason: 'first status pass for this loan — the watermark is taken and no status is written',
    };
  }

  const isNewEvent = eventMs != null && eventMs > markMs;

  // NO NEW MILESTONE. The owner's central rule: PILOT does not reconcile. If the
  // card disagrees, that is for a person to settle — ClickUp being AHEAD is a
  // legitimate state, not drift to repair.
  if (!isNewEvent) {
    if (norm(have) === norm(want)) return { act: 'agree', stamp: false, reason: 'the card already holds this status' };
    return {
      act: 'review',
      stamp: false,
      current: have,
      proposed: want,
      reason: `ClickUp says "${have || '(none)'}" and Encompass's milestones say "${want}" — no milestone has fired, so PILOT left the card alone`,
    };
  }

  // A MILESTONE FIRED. The event is answered either way below, so it is consumed
  // exactly once and cannot re-fire on the next pass.
  if (norm(have) === norm(want)) {
    return { act: 'agree', stamp: true, stampTo: latestEntered, reason: 'a milestone fired and the card already holds the status it implies' };
  }

  // The owner's exclusion: a status whose whole purpose is to hand the file
  // back may move the card backwards. It is exempt from the direction test
  // entirely — there is nothing left to prove about a move that is allowed
  // either way — which also means an unreadable status order cannot block it.
  const exempt = (backwardOk instanceof Set ? backwardOk : BACKWARD_OK).has(norm(want));

  const haveRank = rankOf(statusOrder, have);
  const wantRank = rankOf(statusOrder, want);
  const forward = (haveRank != null && wantRank != null) ? wantRank > haveRank : null;

  // "The list does not carry this status" is a CONFIGURATION problem — somebody
  // adds it to the ClickUp list — and it is reported separately from a
  // direction refusal, which is a workflow situation. Collapsing the two sends
  // the reader hunting the wrong thing.
  const knownOrder = Array.isArray(statusOrder) && statusOrder.length > 0;
  const notOnList = knownOrder && wantRank == null;

  if (!exempt && forward !== true) {
    const why = notOnList
      ? `a milestone fired wanting "${want}", but that status is not on the card's ClickUp list — PILOT never invents one`
      : forward === false
        ? `a milestone fired, but "${want}" sits BEHIND the card's "${have}" — PILOT does not move a card backwards`
        : `a milestone fired wanting "${want}", but PILOT could not read where that sits against the card's "${have || '(none)'}" — it will not write a status it cannot prove moves forward`;
    return { act: 'review', stamp: true, stampTo: latestEntered, current: have, proposed: want, notOnList, reason: why };
  }

  const why = exempt && forward === false
    ? `"${want}" is handed back on purpose (reassigning the processor), so it is written even though it moves the card back`
    : `${(desired && desired.reason) || 'a milestone fired'} — pushed because a milestone moved, not to reconcile the card`;

  return { act: 'push', stamp: true, stampTo: latestEntered, to: want, from: have, reason: why };
}

module.exports = { decideStatusPush, BACKWARD_OK, _internals: { norm, ms, rankOf } };
