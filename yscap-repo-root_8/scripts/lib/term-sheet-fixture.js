'use strict';
/**
 * scripts/lib/term-sheet-fixture.js — a term sheet the way the studio makes one, as
 * far as the SENDER can tell: a real PDF whose text layer carries the white 4pt
 * DocuSign anchors for the people who sign it.
 *
 * ONE definition for every suite that stores a term sheet and then sends it
 * (test-esign-orchestrate, test-esign-cc-viewers, test-term-sheet-final-stamp-db):
 * since 2026-09-02 the send REFUSES a sheet with no signature line for a package
 * signer (src/lib/esign/term-sheet-signers.js), so a fake byte string is refused
 * for the right reason and proves nothing about the send. Drawn with pdf-lib —
 * Flate-compressed content, hex strings — the harder of the two shapes the signer
 * check must read; the jsPDF shape is covered by the pure suite.
 */
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { ANCHOR_SUFFIX_BY_ROLE } = require('../../src/lib/esign/term-sheet-signers');

/** A PDF carrying exactly these anchor strings (plus a headline), as bytes. */
async function studioLikeTermSheet(anchors, { headline = 'FINAL TERM SHEET' } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.drawText(headline, { x: 40, y: 740, size: 12, font });
  anchors.forEach((a, i) => page.drawText(a, { x: 40, y: 700 - i * 16, size: 4, font }));
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

/** The anchors the studio draws for these roster roles — sign + date per role. */
function anchorsForRoles(roles) {
  const out = [];
  for (const role of roles) {
    const sfx = ANCHOR_SUFFIX_BY_ROLE[role];
    if (!sfx) continue;
    out.push(`/ts_${sfx}_sig/`, `/ts_${sfx}_dt/`);
  }
  return out;
}

/** A term sheet signable by exactly these roles (e.g. ['borrower','co_borrower','admin']). */
async function termSheetForRoles(roles, opts) {
  return studioLikeTermSheet(anchorsForRoles(roles), opts);
}

module.exports = { studioLikeTermSheet, anchorsForRoles, termSheetForRoles };
