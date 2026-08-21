'use strict';
/**
 * src/sitewire/draw-accepted-notice.js — "the borrower approved this draw" told properly.
 *
 * WHY THIS EXISTS. Owner-reported 2026-08-21: *"when a borrower is approving the inspection results
 * online, he's clicking on the Approve button from his email or log in, and the draw coordinator is
 * not getting a notification. We need to set up a nice notification to the draw coordinator that
 * this draw number, whatever this amount was, was approved by the borrower through the online
 * system. Make sure, either way, when they approve it, either on the portal or on their email, the
 * draw coordinator and the loan officer should get a notification that the borrower approved it."*
 *
 * TWO THINGS WERE WRONG, and they are different failures:
 *
 *   1. WHO. `notify.notifyAppStaff` selects `application_assignees`, and PILOT has no
 *      draw-coordinator POINTER — a coordinator is identified by what they DID on the file. So the
 *      one person whose job it is to release the money was structurally not in the list. That half
 *      is fixed at the fan-out chokepoint itself (`notify.js`, keyed on the 'draws' category, using
 *      the same `draw-recipients` resolver the borrower emails already use), so it is true for every
 *      draw event, not only this one.
 *
 *   2. WHAT IT SAID. *"The borrower accepted the inspection results — the release is due by …"*
 *      names neither the draw nor the money, so the coordinator had to open the file to learn what
 *      they had been told about. This module is the answer to that half.
 *
 * ONE DEFINITION FOR THREE DOORS — the portal (authenticated), the emailed link (public token) and
 * the TPO broker surface all announce an acceptance, and they must say the same thing in the same
 * shape or the desk learns to read one and ignore the others. Only WHO acted and WHERE they acted
 * differ, and both are stated rather than implied.
 *
 * THE MONEY IS NEVER RECOMPUTED HERE. The figures come from `drawEmailBlocks` → `rollup` →
 * `approval.drawMoney`, the ONE source of per-draw money (the draw desk, the borrower's screen, the
 * branded PDF and the Excel packet all read it), so this notice can never quote a number that
 * disagrees with the report attached to it. Best-effort throughout: a notification must never fail
 * because its decoration could not be built, and an acceptance has already happened by the time
 * this runs.
 */

const drawLabel = require('../lib/draw-label');
const { drawEmailBlocks } = require('./draw-email-blocks');

/** WHO pressed the button, and WHERE — stated, never inferred from the absence of something. */
const VIA = Object.freeze({
  portal: { who: 'The borrower', where: 'in their portal' },
  email:  { who: 'The borrower', where: 'from the email we sent them' },
  // A broker acting on their firm's file. Deliberately NOT called "the borrower": the coordinator
  // is about to move money, and who authorised it is the first thing they should read.
  tpo:    { who: 'The broker',   where: 'in their broker portal' },
  // A coordinator recording an approval given verbally or by email, outside the online system.
  staff:  { who: 'The borrower', where: 'outside the online system, recorded by our team' },
});

function whenText(due) {
  if (!due) return null;
  const d = new Date(due);
  return Number.isFinite(d.getTime()) ? d.toLocaleString('en-US') : null;
}

/**
 * The notification payload for an accepted draw. PURE apart from the two lookups it is handed.
 *
 * @param blocks  what `drawEmailBlocks` returned (or null — the notice still goes out, saying less)
 * @param via     one of VIA's keys
 * @param opts    { drawTag, wireDueAt, address }
 */
function acceptedPayload(blocks, via, { drawTag = null, wireDueAt = null } = {}) {
  const v = VIA[via] || VIA.portal;
  const money = blocks && blocks.money;
  const amount = blocks && blocks.figures && blocks.figures.primary ? blocks.figures.primary.value : null;
  const which = drawTag || (money && money.number != null ? drawLabel.drawLabel(money.number) : null);
  const due = whenText(wireDueAt);

  // THE TITLE CARRIES THE TWO FACTS THE COORDINATOR NEEDS AT A GLANCE — which draw, and that it is
  // approved. The amount is deliberately NOT in the title: a subject line is read in a list and the
  // figures block below states every number properly, ranked. A draw with no resolvable number says
  // so rather than printing "Draw #undefined".
  const title = which ? `${which} approved by the borrower` : 'A draw was approved by the borrower';

  const body = [
    `${v.who} approved the inspection results ${v.where}${amount ? ` — ${amount}` : ''}.`,
    due ? `The release is due by ${due}.` : null,
    'Nothing else is waiting on them: this draw is ready for you to move forward.',
  ].filter(Boolean).join(' ');

  return {
    type: 'draw_accepted',
    title,
    badge: { text: 'Approved', tone: 'positive' },
    drawTag: which,
    // The ranked money block — what is being released leads, with approved / requested / held back
    // beneath it. Built by the shared composer, so this reads like every other draw message.
    figures: (blocks && blocks.figures) || null,
    facts: (blocks && blocks.facts) || null,
    body,
  };
}

/**
 * Build and send it. Returns whatever `notify.notifyAppStaff` returned (the recipients), or [] —
 * never throws.
 *
 * @param db      a pg pool/client
 * @param finding the `draw_findings` row that was just accepted
 * @param via     'portal' | 'email' | 'tpo' | 'staff'
 * @param extra   { wireDueAt, exceptStaffId }
 */
async function notifyDrawAccepted(db, finding, via, { wireDueAt = null, exceptStaffId = null } = {}) {
  try {
    if (!finding || !finding.application_id) return [];
    const appId = finding.application_id;
    const sitewireDrawId = finding.sitewire_draw_id != null ? finding.sitewire_draw_id : null;
    let blocks = null;
    let drawTag = null;
    try {
      blocks = await drawEmailBlocks(db, appId, { sitewireDrawId });
    } catch (_) { /* decoration only */ }
    try {
      drawTag = await drawLabel.drawTagForRef(db, appId, { sitewireDrawId });
    } catch (_) { /* the payload falls back to the rollup's own number */ }

    const payload = acceptedPayload(blocks, via, { drawTag, wireDueAt: wireDueAt || finding.wire_due_at });
    const notify = require('../lib/notify');
    return await notify.notifyAppStaff(appId, {
      ...payload,
      applicationId: appId,
      link: `/internal/app/${appId}`,
      ctaLabel: 'Open the loan file',
      ...(exceptStaffId ? { exceptStaffId } : {}),
    });
  } catch (e) {
    console.error('[draw-accepted] notice', (finding && finding.application_id) || null, (e && e.message) || e);
    return [];
  }
}

module.exports = { notifyDrawAccepted, acceptedPayload, VIA, _internals: { whenText } };
