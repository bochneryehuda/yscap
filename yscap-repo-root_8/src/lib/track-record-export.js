'use strict';
/**
 * Server-side "nicer" Track Record exports for the TPR / REO package (owner-directed
 * 2026-07-30). The TPR export used to drop a single bare undifferentiated grid —
 * `REO/Track Record.xlsx` — and nothing else; the owner wants the SAME professional,
 * sectioned tracker our Track Record tool shows PLUS "the PDF export we can export
 * from our track record section". Both are built here, dependency-free (the xlsx
 * reuses tpr-export's proven OOXML-in-a-zip writer; the PDF uses pdf-lib, already
 * installed), from the borrower's `track_records` rows — so EVERY file, previous and
 * future, gets them with no client step.
 *
 * Fix & Flip (exit = sale) and Fix & Hold / Rental (exit = lease-up / refinance) are
 * split into their own sections with the right columns + per-section totals, mirroring
 * web/tools/track-record.js. These are pure RENDERERS: the caller (tpr-export) builds
 * the section data with its own frozen helpers (the 3-year exit window etc.), so the
 * experience rules live in exactly one place.
 */

const money = (v) => (v == null || v === '' || !isFinite(Number(v))) ? '' : '$' + Math.round(Number(v)).toLocaleString('en-US');

// Build the array-of-arrays for the workbook. Money cells stay NUMERIC (so they
// sum + right-align in Excel), everything else is a string. Fed straight into
// tpr-export.buildXlsx — the same proven, style-free writer the package already
// uses, so there is zero chance of an "unreadable in Excel" corruption.
function trackRecordAoa(sections, meta = {}) {
  const aoa = [];
  aoa.push(['YS CAPITAL GROUP — BORROWER TRACK RECORD']);
  aoa.push([(meta.borrowerName ? 'Borrower: ' + meta.borrowerName + '   ·   ' : '')
    + 'Generated ' + (meta.generatedDate || '') + '   ·   NMLS ID 2609746']);
  aoa.push([]);
  let verifiedTotal = 0, projectTotal = 0;
  for (const sec of sections) {
    aoa.push([sec.title]);
    aoa.push(sec.columns.map((c) => c.header));
    if (!sec.rows.length) {
      aoa.push(['No deals entered in this section.']);
    } else {
      for (const row of sec.rows) {
        projectTotal += 1;
        if (row.__verified) verifiedTotal += 1;
        aoa.push(sec.columns.map((c) => {
          const v = row[c.key];
          if (c.money) return (v == null || v === '' || !isFinite(Number(v))) ? '' : Number(v);
          return v == null ? '' : String(v);
        }));
      }
      aoa.push(sec.columns.map((c, i) => {
        if (i === 0) return 'TOTALS (' + sec.rows.length + ')';
        if (c.sum) { let s = 0; for (const r of sec.rows) { const v = Number(r[c.key]); if (isFinite(v)) s += v; } return s; }
        return '';
      }));
    }
    aoa.push([]);
  }
  aoa.push(['Summary: ' + projectTotal + ' project(s) · ' + verifiedTotal + ' verified.']);
  return aoa;
}

// Compact, branded, landscape PDF report — the "PDF export from our track record
// section". pdf-lib only (already a dependency); modeled on src/trustpoint/report.js.
async function buildTrackRecordPdf(sections, meta = {}) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.078, 0.106, 0.133), gold = rgb(0.682, 0.529, 0.275), muted = rgb(0.294, 0.345, 0.361);
  const bannerBg = rgb(0.12, 0.16, 0.19), bannerFg = rgb(0.95, 0.94, 0.9), totalBg = rgb(0.917, 0.945, 0.945);
  const PW = 792, PH = 612, ML = 36, MR = 36, MT = 560, MB = 40, ROW = 12;
  const usableW = PW - ML - MR;

  let page = doc.addPage([PW, PH]);
  let y = MT;
  const newPage = () => { page = doc.addPage([PW, PH]); y = MT; };

  // ---- header (drawn once)
  page.drawText('YS CAPITAL GROUP', { x: ML, y, size: 16, font: bold, color: gold }); y -= 18;
  page.drawText('Borrower Track Record', { x: ML, y, size: 11, font: bold, color: ink }); y -= 14;
  page.drawText((meta.borrowerName ? 'Borrower: ' + meta.borrowerName + '   ·   ' : '')
    + 'Generated ' + (meta.generatedDate || '') + '   ·   NMLS ID 2609746',
  { x: ML, y, size: 8, font, color: muted }); y -= 18;

  for (const sec of sections) {
    const totalW = sec.columns.reduce((a, c) => a + (c.w || 1), 0) || 1;
    const colX = []; const colW = [];
    let cx = ML;
    for (const c of sec.columns) { colX.push(cx); const w = (c.w || 1) / totalW * usableW; colW.push(w); cx += w; }

    // A cell, clipped to its column box, left/right-aligned.
    const cell = (txt, i, { f = font, size = 7.5, color = ink, align } = {}) => {
      let s = String(txt == null ? '' : txt);
      const boxW = colW[i] - 4;
      while (s.length && f.widthOfTextAtSize(s, size) > boxW) s = s.slice(0, -1);
      const al = align || sec.columns[i].align || 'left';
      const x = al === 'right' ? colX[i] + colW[i] - 2 - f.widthOfTextAtSize(s, size) : colX[i] + 2;
      page.drawText(s, { x, y, size, font: f, color });
    };
    const drawHead = () => {
      page.drawRectangle({ x: ML, y: y - 3, width: usableW, height: 13, color: bannerBg });
      page.drawText(sec.title, { x: ML + 4, y, size: 8.5, font: bold, color: bannerFg });
      y -= ROW + 3;
      sec.columns.forEach((c, i) => cell(c.header, i, { f: bold, size: 7, color: ink }));
      y -= ROW;
    };

    if (y - ROW * 3 < MB) newPage();
    drawHead();

    if (!sec.rows.length) {
      cell('No deals entered in this section.', 0, { size: 8, color: muted });
      y -= ROW + 6;
      continue;
    }
    for (const row of sec.rows) {
      if (y - ROW < MB) { newPage(); drawHead(); }
      sec.columns.forEach((c, i) => cell(c.money ? money(row[c.key]) : row[c.key], i));
      y -= ROW;
    }
    // totals band
    if (y - ROW < MB) { newPage(); drawHead(); }
    page.drawRectangle({ x: ML, y: y - 2, width: usableW, height: ROW, color: totalBg });
    sec.columns.forEach((c, i) => {
      if (i === 0) return cell('TOTALS (' + sec.rows.length + ')', 0, { f: bold, size: 7.5 });
      if (c.sum) { let s = 0; for (const r of sec.rows) { const v = Number(r[c.key]); if (isFinite(v)) s += v; } return cell(money(s), i, { f: bold, size: 7.5 }); }
    });
    y -= ROW + 8;
  }

  page.drawText('YS Capital Group · NMLS ID 2609746 — experience counted only for a completed exit within the last 3 years.',
    { x: ML, y: Math.max(y, MB - 20), size: 7.5, font, color: muted });
  return Buffer.from(await doc.save());
}

module.exports = { trackRecordAoa, buildTrackRecordPdf };
