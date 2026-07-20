'use strict';

// #84 — freeze the loan STRUCTURE at Clear-to-Close.
//
// Once a file reaches Clear-to-Close (or funds), its structural basis — the
// registered product / pricing, the rehab budget (Scope of Work), and the
// vesting entity link — must not be overwritten. The only way to change any of
// it is to move the file BACK to an earlier status first (a real, deliberate
// structural change to the loan). Terminal states (declined/withdrawn) are
// frozen the same way. Status changes themselves are NOT gated here, so staff
// can always push a file back.

const db = require('../db');

const STRUCTURE_LOCKED = ['clear_to_close', 'funded', 'declined', 'withdrawn'];
const LABEL = { clear_to_close: 'Clear to Close', funded: 'Funded', declined: 'Declined', withdrawn: 'Withdrawn' };

// Returns a human-readable reason string when the file's structure is locked, or
// null when it's still editable. The freeze applies to EVERYONE on every write path
// that CALLS this — but a super_admin who has deliberately UNLOCKED this file
// (opts.actor is a super_admin and the file carries an active
// structural_unlocked_at) may edit it to correct a mistake; every other actor, and
// every caller that passes no actor (e.g. borrower edit paths), stays frozen. Pass
// { actor: req.actor } to honor an active unlock. NOTE: the ClickUp inbound sync
// writes economics directly and does NOT yet consult this — a funded file's numbers
// changed on the ClickUp side are a separate, tracked follow-up (the sync layer,
// which has its own review/park machinery), not covered by this freeze.
async function structuralLockReason(appId, client = db, opts = {}) {
  try {
    const r = await client.query('SELECT status, structural_unlocked_at FROM applications WHERE id=$1', [appId]);
    const row = r.rows[0];
    const status = row && row.status;
    if (status && STRUCTURE_LOCKED.includes(status)) {
      const actor = opts.actor || null;
      const isSuper = !!(actor && actor.kind === 'staff' && actor.role === 'super_admin');
      if (row.structural_unlocked_at && isSuper) return null;   // super_admin editing an unlocked file
      return `This file is ${LABEL[status] || status} — its loan structure is locked. `
        + (isSuper
            ? 'A super-admin can unlock it to make a correction, then re-lock.'
            : 'Move it back to an earlier status, or ask a super-admin to unlock it, before changing this.');
    }
  } catch (_) { /* if we can't read status, don't hard-block */ }
  return null;
}

module.exports = { structuralLockReason, STRUCTURE_LOCKED };
