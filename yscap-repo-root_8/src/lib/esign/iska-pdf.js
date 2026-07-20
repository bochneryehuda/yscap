/**
 * esign/iska-pdf.js — the Heter Iska as a real PDF, generated on our server.
 *
 * The owner (2026-07-20) asked us to send DocuSign a PDF we generate — with the
 * loan amount + borrower name filled in — instead of handing DocuSign the Word
 * template to convert. The Heter Iska is a SACRED Hebrew document; jsPDF's core
 * font is Latin-1 (no Hebrew) and Render has no LibreOffice/Chromium to convert
 * the filled .docx → PDF at send time, so re-typesetting the nusach on the server
 * would be both impossible and unsafe.
 *
 * Instead the nusach is pre-rendered ONCE (build-time, via Chromium — see
 * templates/iska/build-assets.js) to verified letter-page images, byte-exact from
 * the Word template. Here, at send time, we lay each page image into a jsPDF page
 * and draw ONLY the Latin variables (loan amount + names) and the INVISIBLE
 * DocuSign anchors on top — no Hebrew rendering on the server. What was visually
 * verified in the image is exactly what ships; only the small Latin bits are drawn
 * live, which jsPDF does natively and crisply.
 *
 * The Word template (docgen.buildIska) is KEPT — the office still fills it for its
 * own records; the fill VALUES come from the same orchestrate.loadDocGenData object,
 * so the sent PDF and the retained Word always agree.
 *
 * Anchors match orchestrate.tabsFor exactly (prefix 'iska'; borrower→b1, co→b2;
 * no admin counter-signer):  /iska_b1_sig/ /iska_b1_dt/  (+ b2 when a co-borrower).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { pdfSafe } = require('./application-pdf');

const ASSET_DIR = path.join(__dirname, 'templates', 'iska');

// A missing/partial engine bundle or page asset is an infrastructure/DEPLOY fault,
// not a data error — classify it RETRYABLE so the send re-drives (and self-heals on
// the next deploy) instead of permanently dead-lettering with an opaque, path-leaking
// message. If it truly never resolves, the send engine dead-letters it after its own
// retry/backoff window carrying this clear operator message.
function assetError(what) {
  const e = new Error(`The Heter Iska ${what} isn't available on the server — the send will retry. If this persists, redeploy so the templates/iska assets ship with the build.`);
  e.retryable = true;
  return e;
}

// jsPDF UMD bundle, loaded lazily (same pattern as application-pdf.js).
let _jsPDF = null;
function getJsPDF() {
  if (_jsPDF) return _jsPDF;
  const abs = path.join(__dirname, '..', '..', '..', 'web', 'tools', 'vendor', 'jspdf.umd.min.js');
  let mod;
  try { mod = require(abs); } catch (_) { throw assetError('PDF engine (jspdf) failed to load'); }
  _jsPDF = (mod && typeof mod.jsPDF === 'function') ? mod.jsPDF : (global.jspdf && global.jspdf.jsPDF);
  if (typeof _jsPDF !== 'function') throw assetError('PDF engine (jspdf) failed to load');
  return _jsPDF;
}

// Layout + page images, read once and cached (small; a few hundred KB).
let _layout = null;
const _imgCache = {};
function layout() {
  if (!_layout) {
    try { _layout = JSON.parse(fs.readFileSync(path.join(ASSET_DIR, 'iska-layout.json'), 'utf8')); }
    catch (_) { throw assetError('page layout (iska-layout.json)'); }
  }
  return _layout;
}
function imgDataUri(file) {
  if (!_imgCache[file]) {
    try { _imgCache[file] = 'data:image/jpeg;base64,' + fs.readFileSync(path.join(ASSET_DIR, file)).toString('base64'); }
    catch (_) { throw assetError(`page image (${file})`); }
  }
  return _imgCache[file];
}

// Money for the loan-amount slot. The template already prints the "$" before the
// slot, so we draw the NUMBER only. A missing/invalid amount is blocked upstream
// (orchestrate.validateGenerated), never rendered here as a bare $0.00.
function fmtAmount(n) {
  const v = Number(n);
  if (n == null || !isFinite(v)) return '';
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * The list of things drawn on top of the page images for `data`. Exported so the
 * asset-verification tool can prove each value lands in its measured slot.
 * Each entry: { page, xPt, baselinePt, wPt, align, text, visible }.
 */
function overlayPlan(data = {}) {
  const co = !!data.hasCoBorrower;
  const v = layout().variants[co ? 'co' : 'solo'];
  const s = v.slots;
  const bName = `${data.bFirst || ''} ${data.bLast || ''}`.trim();
  const cbName = `${data.cbFirst || ''} ${data.cbLast || ''}`.trim();
  const plan = [];
  // visible Latin values
  plan.push({ ...s['slot-amt'], text: fmtAmount(data.loanAmount), align: 'center', visible: true });
  plan.push({ ...s['slot-bname'], text: pdfSafe(bName), align: 'left', visible: true });
  if (co) plan.push({ ...s['slot-cbname'], text: pdfSafe(cbName), align: 'left', visible: true });
  // invisible DocuSign anchors (must match orchestrate.tabsFor prefix 'iska')
  plan.push({ ...s['anchor-b1-sig'], text: '/iska_b1_sig/', align: 'left', visible: false });
  plan.push({ ...s['anchor-b1-dt'], text: '/iska_b1_dt/', align: 'left', visible: false });
  if (co) {
    plan.push({ ...s['anchor-b2-sig'], text: '/iska_b2_sig/', align: 'left', visible: false });
    plan.push({ ...s['anchor-b2-dt'], text: '/iska_b2_dt/', align: 'left', visible: false });
  }
  return plan;
}

// Pick the largest font size (<= base) whose text fits the slot width, so a long
// 7-figure amount or a long legal name can't overflow its slot / the "$".
function fitSize(doc, text, maxWpt, base) {
  for (let sz = base; sz >= 6; sz -= 0.5) {
    doc.setFontSize(sz);
    if (doc.getTextWidth(text) <= maxWpt - 4) return sz;
  }
  return 6;
}

/**
 * Build the Heter Iska PDF for `data` (orchestrate.loadDocGenData output). Returns
 * a PDF Buffer. Shape used: { loanAmount, bFirst, bLast, hasCoBorrower, cbFirst, cbLast }.
 */
function buildIskaPdf(data = {}) {
  const jsPDF = getJsPDF();
  const L = layout();
  const co = !!data.hasCoBorrower;
  const v = L.variants[co ? 'co' : 'solo'];

  const doc = new jsPDF({ unit: 'pt', format: 'letter', orientation: 'portrait' });
  const W = L.pageWidthPt, H = L.pageHeightPt;

  // Lay each pre-rendered nusach page as a full-bleed image.
  v.pages.forEach((pg, i) => {
    if (i > 0) doc.addPage();
    doc.addImage(imgDataUri(pg.file), 'JPEG', 0, 0, W, H);
  });

  doc.setFont('helvetica', 'normal');
  for (const o of overlayPlan(data)) {
    if (!o.text) continue;
    doc.setPage(o.page + 1);
    if (o.visible) {
      const sz = fitSize(doc, o.text, o.wPt, 11);
      doc.setFontSize(sz);
      doc.setTextColor(17, 17, 17);
      const x = o.align === 'center' ? o.xPt + o.wPt / 2 : o.xPt + 2;
      doc.text(o.text, x, o.baselinePt, { align: o.align, baseline: 'alphabetic' });
    } else {
      // Invisible anchor: white, tiny, but a REAL text object DocuSign will find.
      doc.setFontSize(1);
      doc.setTextColor(255, 255, 255);
      doc.text(o.text, o.xPt, o.baselinePt, { baseline: 'alphabetic' });
    }
  }
  doc.setTextColor(0, 0, 0);
  return Buffer.from(doc.output('arraybuffer'));
}

module.exports = { buildIskaPdf, overlayPlan, fmtAmount };
