'use strict';
/**
 * PDF forensics — advisory tampering signals read straight from the file's own bytes, no AI.
 * From the fraud research (doctored bank statements / altered dec pages / edited appraisals), the
 * highest-signal, lowest-false-positive document-level checks are structural: was the PDF edited
 * with image/PDF-editing software, was it saved over (incrementally updated) after it was first
 * created, and was it modified long after its creation date. None of these alone proves fraud — a
 * legitimate e-signature or a scanner adds incremental saves — so this NEVER blocks; it raises an
 * ADVISORY finding telling the underwriter to review the source document by hand, and only when
 * the signals actually combine (or an image-editor fingerprint is present, which is the strong one).
 *
 * Pure — operates on the raw Buffer. Best-effort: anything it can't parse yields no signal, never
 * a throw and never a false accusation.
 */

// Software fingerprints that indicate the PDF was EDITED (not merely generated/printed/scanned).
// An image editor (Photoshop/GIMP) on a financial document is the strong tampering signal; the
// PDF editors are weaker on their own (people legitimately fill forms), so they need corroboration.
const IMAGE_EDITORS = ['photoshop', 'gimp', 'pixelmator', 'affinity photo', 'paint.net'];
const PDF_EDITORS = ['pdfescape', 'foxit phantom', 'pdf-xchange', 'itext', 'ilovepdf', 'smallpdf', 'sejda', 'pdffiller', 'nitro', 'soda pdf', 'pdfelement', 'pdf architect'];

function field(text, name) {
  const m = new RegExp('/' + name + '\\s*\\(([^)]*)\\)').exec(text);
  return m ? m[1].trim() : null;
}
// A PDF date "D:YYYYMMDDHHmmSS…" reduced to a zero-padded 14-digit string for lexicographic
// comparison (no Date needed — avoids any calendar/timezone dependence).
function pdfDateNum(s) {
  if (!s) return null;
  const m = /(\d{8,14})/.exec(String(s));
  if (!m) return null;
  return m[1].slice(0, 14).padEnd(14, '0');
}

/**
 * @param {Buffer} buffer  the raw document bytes
 * @param {{docType?:string}} [opts]
 * @returns {{ isPdf:boolean, signals:Array<{key,detail}>, findings:Array<object> }}
 */
function analyzePdf(buffer, opts = {}) {
  const out = { isPdf: false, signals: [], findings: [] };
  if (!buffer || !buffer.length) return out;
  // Read as latin1 so the ASCII structure/metadata survives; content streams are ignored.
  let text;
  try { text = buffer.toString('latin1'); } catch (_) { return out; }
  if (text.slice(0, 1024).indexOf('%PDF-') === -1) return out; // not a PDF → no structural signals
  out.isPdf = true;

  const eofCount = (text.match(/%%EOF/g) || []).length;
  if (eofCount > 1) out.signals.push({ key: 'incremental_updates', detail: `the file was saved over ${eofCount - 1} time${eofCount - 1 === 1 ? '' : 's'} after it was first created` });

  const cd = pdfDateNum(field(text, 'CreationDate'));
  const md = pdfDateNum(field(text, 'ModDate'));
  if (cd && md && md > cd) out.signals.push({ key: 'modified_after_creation', detail: 'the file was modified after it was created' });

  const soft = `${field(text, 'Producer') || ''} ${field(text, 'Creator') || ''}`.toLowerCase();
  const imgHit = IMAGE_EDITORS.find((e) => soft.indexOf(e) !== -1);
  const pdfHit = PDF_EDITORS.find((e) => soft.indexOf(e) !== -1);
  if (imgHit) out.signals.push({ key: 'image_editor', detail: `made or edited with image-editing software ("${imgHit}")` });
  else if (pdfHit) out.signals.push({ key: 'pdf_editor', detail: `edited with PDF-editing software ("${pdfHit}")` });

  // Decide whether to RAISE an advisory. Conservative to avoid false accusations:
  //  - an image editor is the strong single signal (a bank statement "made in Photoshop");
  //  - otherwise require the file to have been BOTH saved-over AND modified-after-creation, or a
  //    PDF-editor fingerprint plus one of those.
  const has = (k) => out.signals.some((s) => s.key === k);
  const strong = imgHit;
  const combined = (has('incremental_updates') && has('modified_after_creation'))
    || (pdfHit && (has('incremental_updates') || has('modified_after_creation')));
  if (strong || combined) {
    out.findings.push({
      source: 'fraud_scan', code: 'pdf_tampering_signs',
      severity: strong ? 'warning' : 'info', status: 'open', blocksCtc: false,
      field: 'document_integrity',
      docValue: out.signals.map((s) => s.detail).join('; '), fileValue: null,
      title: 'This document shows signs it may have been altered',
      howTo: `The file itself shows: ${out.signals.map((s) => s.detail).join('; ')}. This does not prove anything on its own — but review the original document by hand, and if in doubt request a fresh copy directly from the source (the bank, the issuer).`,
      actions: ['request_document', 'post_condition', 'grant_exception', 'dismiss'],
      opensCondition: 'underwriting_review_cleared',
    });
  }
  return out;
}

module.exports = { analyzePdf, _internals: { field, pdfDateNum } };
