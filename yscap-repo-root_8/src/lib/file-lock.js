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
// null when it's still editable.
async function structuralLockReason(appId, client = db) {
  try {
    const r = await client.query('SELECT status FROM applications WHERE id=$1', [appId]);
    const status = r.rows[0] && r.rows[0].status;
    if (status && STRUCTURE_LOCKED.includes(status)) {
      return `This file is ${LABEL[status] || status} — its loan structure is locked. `
        + 'Move it back to an earlier status before changing this.';
    }
  } catch (_) { /* if we can't read status, don't hard-block */ }
  return null;
}

module.exports = { structuralLockReason, STRUCTURE_LOCKED };
