'use strict';

/**
 * PAYOFF DEMAND REQUESTED — the workflow that locks the draw centre.
 *
 * Owner-directed 2026-08-21: *"we should add a workflow which would be 'Pay Off Demand Requested'.
 * This is whenever a borrower requests a payoff letter, then the draw center needs to be locked
 * up … 1. If the draws were never set up and never requested, when you tried to set up draws on
 * this one, it should come out big that there was a Pay Off Demand on this one, so you can't
 * request the set of draws on this file anymore. 2. … If the file is already set up for draws …
 * You need to stop our system from [releasing] draws, but you also need to block him from
 * requesting draws in sitewire. There's a button in the sitewire actions block draws, and that
 * button, whenever we click on Pay Off Demand was requested, should automatically be clicked."*
 *
 * WHY IT MATTERS, in the owner's own reasoning: *"if somebody is requesting a payoff, then he has
 * a payoff. If we request draws afterward, that can be a mess up."* A borrower who is paying the
 * loan off is not going to keep building; money released after the payoff figure was quoted is
 * money the payoff letter did not account for.
 *
 * THE BLOCK IS BOTH SIDES, DELIBERATELY. PILOT refuses on its own (so the block holds even with
 * the Sitewire connection switched off, and on a file that was never pushed), and the Sitewire
 * property is deactivated so the BORROWER cannot submit anything there either. Doing only the
 * first leaves the borrower's own door open; doing only the second leaves ours open.
 *
 * IT IS A STAMP, NOT A STATUS. `payoff_demand_requested_at` (db/611) records WHEN, WHO recorded it
 * and WHY, and the Critical dates section shows it. The loan's status does not move: a payoff
 * demand is a request, not a payoff — the loan is still funded, still serviced, and can still be
 * un-blocked if the borrower changes their mind (which is why `clear` exists and why lifting the
 * block never re-activates a project a coordinator deliberately finished).
 */

/** The sentence every refused draw action shows. ONE wording, so the borrower's door, the
 *  coordinator's Start-draw screen and the desk cannot describe the same block three ways. */
function blockMessage({ at = null, by = null, note = null } = {}) {
  const when = at ? ` on ${String(at).slice(0, 10)}` : '';
  const who = by ? ` by ${by}` : '';
  return `A PAYOFF DEMAND was requested on this file${when}${who}. `
    + 'The draw centre is locked: no new draws can be set up, requested or released while a payoff is outstanding — '
    + 'money released now would not be in the payoff figure that was quoted.'
    + (note ? ` Note: ${note}` : '');
}

/**
 * IS THIS FILE LOCKED? — the ONE predicate every draw door asks.
 *
 * FAILS CLOSED on an unreadable answer: with the database refusing to say, refusing a draw costs
 * a coordinator a retry, while allowing one can release money against a quoted payoff. Returns
 * `{ blocked, at, by, note, message }`.
 */
async function payoffDemandBlock(db, appId) {
  if (!appId) return { blocked: false };
  try {
    const r = (await db.query(
      `SELECT a.payoff_demand_requested_at AS at, a.payoff_demand_note AS note,
              su.full_name AS by_name
         FROM applications a
         LEFT JOIN staff_users su ON su.id = a.payoff_demand_requested_by
        WHERE a.id = $1`, [appId])).rows[0];
    if (!r || !r.at) return { blocked: false };
    return {
      blocked: true, at: r.at, by: r.by_name || null, note: r.note || null,
      message: blockMessage({ at: r.at, by: r.by_name, note: r.note }),
    };
  } catch (_) {
    return {
      blocked: true, unreadable: true,
      message: 'PILOT could not check whether a payoff demand is outstanding on this file, so the draw is held. Try again in a moment.',
    };
  }
}

/**
 * RECORD a payoff demand and lock the draw centre.
 *
 * FILL-ONLY on the stamp: a demand already recorded keeps its ORIGINAL date and whoever recorded
 * it. The date is what the payoff figure was quoted against, so a second click must never move
 * it — but the Sitewire block is re-driven anyway, because the first attempt may have run while
 * the connection was switched off.
 */
async function recordPayoffDemand(db, appId, { staffId = null, note = null } = {}) {
  if (!appId) return { error: 'no_file' };
  const clean = note ? String(note).slice(0, 1000) : null;
  const r = (await db.query(
    `UPDATE applications
        SET payoff_demand_requested_at = COALESCE(payoff_demand_requested_at, now()),
            payoff_demand_requested_by = COALESCE(payoff_demand_requested_by, $2::uuid),
            payoff_demand_note = COALESCE(payoff_demand_note, $3),
            updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING payoff_demand_requested_at AS at,
                (payoff_demand_requested_at IS NOT NULL) AS stamped`,
    [appId, staffId, clean])).rows[0];
  if (!r) return { error: 'no_file' };

  /* AND THE SITEWIRE BUTTON IS PRESSED. Best-effort by design: the PILOT-side block already
     stands, and a Sitewire outage must not stop a coordinator recording the demand — the result
     is REPORTED so the screen can say plainly whether the borrower's own door is shut yet. */
  let sitewire = null;
  try {
    sitewire = await require('../sitewire/orchestrator').setDrawsBlocked(appId, true, { source: 'payoff_demand' });
  } catch (e) { sitewire = { error: (e && e.message) ? String(e.message).slice(0, 120) : 'error' }; }

  /* THE DRAW DESK IS TOLD, because the person who records a payoff demand is usually not the
     person who was about to release a draw. Routed through the draws category so the coordinator
     and the loan officer are both reached by the standing draw loop-in. */
  try {
    await require('./notify').notifyAppStaff(appId, {
      type: 'draw',
      title: 'Payoff demand requested — the draw centre is locked',
      body: blockMessage({ at: r.at, note: clean }),
      applicationId: appId,
      link: `/internal/app/${appId}`,
      ctaLabel: 'Open the file',
    });
  } catch (_) { /* best-effort */ }

  return { ok: true, at: r.at, sitewire };
}

/**
 * LIFT a payoff demand — the borrower did not go through with it.
 *
 * Clears the stamp and asks Sitewire to re-open the property. It can never re-activate a project a
 * coordinator deliberately finished or paid off: `setDrawsBlocked` refuses that, because a
 * lifecycle state is a decision somebody made and lifting an unrelated block must not undo it.
 */
async function clearPayoffDemand(db, appId, { staffId = null } = {}) {
  if (!appId) return { error: 'no_file' };
  const r = (await db.query(
    `UPDATE applications
        SET payoff_demand_requested_at = NULL, payoff_demand_requested_by = NULL,
            payoff_demand_note = NULL, updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL AND payoff_demand_requested_at IS NOT NULL
      RETURNING id`, [appId])).rows[0];
  if (!r) return { skipped: 'not_blocked' };
  let sitewire = null;
  try {
    sitewire = await require('../sitewire/orchestrator').setDrawsBlocked(appId, false, { source: 'payoff_demand' });
  } catch (e) { sitewire = { error: (e && e.message) ? String(e.message).slice(0, 120) : 'error' }; }
  try {
    await require('./notify').notifyAppStaff(appId, {
      type: 'draw',
      title: 'Payoff demand lifted — draws are open again',
      body: 'The payoff demand on this file was withdrawn. The draw centre is unlocked and the borrower can request draws again.',
      applicationId: appId,
      link: `/internal/app/${appId}`,
    });
  } catch (_) { /* best-effort */ }
  return { ok: true, cleared: true, sitewire, staffId };
}

module.exports = { payoffDemandBlock, recordPayoffDemand, clearPayoffDemand, blockMessage };
