'use strict';
/**
 * Draw-send RECIPIENTS for a file — the borrower and (when present) the co-borrower, each with a
 * display name + email. Used by the draw desk so staff can CHOOSE who a directed draw send goes to
 * (owner-directed 2026-07-21): the Sitewire access invitation and the DocuSign wire form each let the
 * coordinator pick the borrower or the co-borrower before sending. Ongoing draw NOTIFICATIONS always go
 * to BOTH (that fan-out is `notify.notifyAppBorrowers`, which already includes both) — this is only for
 * the two one-to-one sends where a single recipient is required.
 */
const db = require('../db');

async function drawRecipients(appId) {
  const r = (await db.query(
    `SELECT b.id  AS b_id,  NULLIF(btrim(concat_ws(' ', b.first_name,  b.last_name)),  '') AS b_name,  b.email  AS b_email,
            cb.id AS c_id,  NULLIF(btrim(concat_ws(' ', cb.first_name, cb.last_name)), '') AS c_name, cb.email AS c_email
       FROM applications a
       JOIN borrowers b  ON b.id  = a.borrower_id
       LEFT JOIN borrowers cb ON cb.id = a.co_borrower_id
      WHERE a.id = $1`, [appId])).rows[0];
  if (!r) return { borrower: null, coBorrower: null };
  return {
    borrower: r.b_id ? { id: r.b_id, name: r.b_name || 'Borrower', email: r.b_email || null } : null,
    coBorrower: r.c_id ? { id: r.c_id, name: r.c_name || 'Co-borrower', email: r.c_email || null } : null,
  };
}

module.exports = { drawRecipients };
