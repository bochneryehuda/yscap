'use strict';
/**
 * PDF forensics — an advisory tampering signal read from the file's own metadata, no AI.
 *
 * DESIGN (after an adversarial audit of an earlier, noisier version): the overriding priority is
 * to NEVER mis-accuse an honest borrower's legitimate document. The signals that seemed useful —
 * "incremental saves" and "modified after creation" — turn out to fire on entirely normal files:
 *   - a digital SIGNATURE (DocuSign) is an incremental save + a bumped ModDate;
 *   - a LINEARIZED ("Fast Web View") statement has two %%EOF markers by construction;
 *   - most PDF generators stamp ModDate after CreationDate.
 * A bank that renders statements with a library like iText would then get flagged on EVERY
 * statement. So this checks ONE thing, the genuinely high-signal / low-false-positive one: was the
 * file's metadata written by IMAGE-EDITING software (Photoshop/GIMP/…)? A bank statement, dec page,
 * or ID that comes "straight from the source" is not made in an image editor — that's the classic
 * doctored-document fingerprint. Even then it only raises a NON-blocking advisory telling the
 * underwriter to review the original and, if in doubt, get a fresh copy from the issuer.
 *
 * Deliberately NARROW to stay trustworthy. Deeper forensics (layered text over a scanned image,
 * font-substitution analysis) need a real PDF parser and are left as future work.
 *
 * Pure — operates on the raw Buffer, best-effort: non-PDF / unparseable → no signal, never a throw.
 */

// Image-editing software that has no legitimate reason to have produced a lending document's PDF.
const IMAGE_EDITORS = [
  'photoshop', 'gimp', 'pixelmator', 'affinity photo', 'paint.net', 'coreldraw', 'photopea',
];

// Every value of a metadata key (e.g. all /Producer(...) occurrences), so a doctored file can't
// hide the editor behind an earlier benign Info dictionary — we check them all.
function allFields(text, name) {
  const out = [];
  const re = new RegExp('/' + name + '\\s*\\(([^)]*)\\)', 'g');
  let m;
  while ((m = re.exec(text)) !== null) { out.push(m[1]); if (out.length > 50) break; }
  return out;
}

/**
 * @param {Buffer} buffer  the raw document bytes
 * @param {{docType?:string}} [opts]
 * @returns {{ isPdf:boolean, signals:Array<{key,detail}>, findings:Array<object> }}
 */
function analyzePdf(buffer, opts = {}) {
  const out = { isPdf: false, signals: [], findings: [] };
  if (!buffer || !buffer.length) return out;
  let text;
  try { text = buffer.toString('latin1'); } catch (_) { return out; }
  if (text.slice(0, 1024).indexOf('%PDF-') === -1) return out; // not a PDF → no metadata to read
  out.isPdf = true;

  const soft = allFields(text, 'Producer').concat(allFields(text, 'Creator')).join(' ').toLowerCase();
  const imgHit = IMAGE_EDITORS.find((e) => soft.indexOf(e) !== -1);
  if (imgHit) {
    out.signals.push({ key: 'image_editor', detail: `the file's metadata says it was created or edited with image-editing software ("${imgHit}")` });
    out.findings.push({
      source: 'fraud_scan', code: 'pdf_tampering_signs',
      severity: 'warning', status: 'open', blocksCtc: false,
      field: 'document_integrity',
      docValue: `image-editing software: ${imgHit}`, fileValue: null,
      title: 'This document may have been edited in image-editing software',
      howTo: `The file's own metadata shows it was created or edited with image-editing software ("${imgHit}"). Financial documents — bank statements, insurance dec pages, IDs — normally come straight from the source, not an image editor, so this is worth a careful look. Review the original by hand and, if anything seems off, request a fresh copy directly from the issuer (the bank, the carrier, the agency).`,
      actions: ['request_document', 'post_condition', 'grant_exception', 'dismiss'],
      opensCondition: 'underwriting_review_cleared',
    });
  }
  return out;
}

module.exports = { analyzePdf, _internals: { allFields, IMAGE_EDITORS } };
