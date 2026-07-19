/**
 * esign/dead-letter.js — make a failed e-signature send VISIBLE to a human.
 *
 * When a send exhausts its retries or fails permanently (a missing source
 * document, a recipient blocked by the pre-go-live allow-list, a validation
 * error), send.js dead-letters the envelope row (status='error', dead_lettered_at)
 * and calls this hook. Without it a dead-letter is only a console.warn — the loan
 * team would never know their borrower wasn't actually sent anything.
 *
 * We notify the file's assigned staff (loan officer / processor / assistants)
 * in-app AND by email, with a link to the file so they can re-send; if the file
 * has no one assigned we fall back to the admins. Best-effort — a notification
 * failure must never break the send engine.
 */
const cfg = require('../../config');

const PURPOSE_LABEL = { term_sheet_package: 'term-sheet package', heter_iska: 'Heter Iska' };

module.exports = async function onDeadLetter(row, err) {
  try {
    const notify = require('../notify');
    const label = PURPOSE_LABEL[row.purpose] || row.purpose || 'e-signature package';
    const reason = ((err && err.message) || 'unknown error').replace(/\s+/g, ' ').trim().slice(0, 300);
    const opts = {
      type: 'status_change',
      title: `E-signature couldn't be sent — ${label}`,
      body: `An e-signature ${label} for this file couldn't be sent and needs attention. `
          + `Reason: ${reason}. Open the file's e-signature section to review and re-send.`,
      applicationId: row.application_id,
      link: `${cfg.appUrl || ''}${cfg.portalPath}/#/internal/app/${row.application_id}`,
    };
    const sent = await notify.notifyAppStaff(row.application_id, opts);
    if (!sent || !sent.length) await notify.notifyAdmins(opts);   // unassigned file → admins
  } catch (e) {
    console.warn(`[esign] dead-letter notify failed for row ${row && row.id}: ${e.message}`);
  }
};
