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

// THE REVIEW STATUS OF ONE TRACK-RECORD LINE (owner-directed 2026-08-05). The
// export used to say only "Verified / Unverified" and, worse, the tool's headline
// implied everything was verified. The owner wants the export to say clearly, per
// deal: which is verified already · which has documentation attached · which is not
// yet verified · which has documentation but is NOT yet verified · which is still
// pending review. Every input is already on the row:
//   is_verified      — a processor confirmed the deal (a 'verified' or 'limited' sign-off)
//   entered_by_kind  — 'borrower' means self-reported, waiting on the loan team
//   hasDocs          — a supporting document is attached to the line
// The four mutually-exclusive statuses + the separate "documentation attached"
// flag together cover all five buckets the owner listed.
const REVIEW_STATUS = {
  verified:     { label: 'Verified',            rgb: [0.180, 0.478, 0.369] }, // green
  docs_review:  { label: 'Docs in — review',    rgb: [0.184, 0.498, 0.525] }, // teal — has docs, not yet verified
  pending:      { label: 'Pending review',      rgb: [0.682, 0.529, 0.275] }, // gold — self-reported, waiting on us
  not_verified: { label: 'Not verified',        rgb: [0.420, 0.470, 0.500] }, // grey — nothing in, not reviewed
};
function trackRecordReviewStatus(row = {}) {
  if (row.is_verified) return 'verified';
  if (row.hasDocs) return 'docs_review';                    // documentation attached, not yet verified
  if (row.entered_by_kind === 'borrower') return 'pending'; // self-reported, still pending review
  return 'not_verified';                                    // not yet verified, no documentation
}
// Tally a set of section rows by status (rows carry __status + __hasDocs, set by
// the caller from trackRecordReviewStatus). Returns the counts the summary shows.
function tallyReviewStatus(sections) {
  const c = { total: 0, verified: 0, docs_review: 0, pending: 0, not_verified: 0, withDocs: 0 };
  for (const sec of sections) for (const row of (sec.rows || [])) {
    c.total += 1;
    const k = row.__status || trackRecordReviewStatus(row);
    if (c[k] != null) c[k] += 1;
    if (row.__hasDocs) c.withDocs += 1;
  }
  return c;
}

// The records-stamp headline ("VERIFIED TO ELEMENTIX — N of M …"), or null when
// no row is records-backed. Rows carry __recordsStamp (set by the caller from
// the derived records_stamp column); the wording is the ONE definition in
// track-record/records-stamp.js — never restated here.
function recordsStampLine(sections) {
  const rows = [];
  for (const sec of sections) for (const row of (sec.rows || [])) rows.push({ records_stamp: row.__recordsStamp || null });
  return require('./track-record/records-stamp').summaryLine(rows);
}

// How many project rows a built book actually carries — the denominator for "N of M held
// back" when a caller did not state the record's own total. One definition, both writers.
function countRows(sections) {
  let n = 0;
  for (const sec of (sections || [])) n += ((sec && sec.rows) || []).length;
  return n;
}

// Build the array-of-arrays for the workbook. Money cells stay NUMERIC (so they
// sum + right-align in Excel), everything else is a string. Fed straight into
// tpr-export.buildXlsx — the same proven, style-free writer the package already
// uses, so there is zero chance of an "unreadable in Excel" corruption.
function trackRecordAoa(sections, meta = {}) {
  const SCOPE = require('./track-record/export-scope');
  const scope = SCOPE.scopeMeta(meta.scope);
  const aoa = [];
  aoa.push(['YS CAPITAL GROUP — BORROWER TRACK RECORD']);
  aoa.push([(meta.borrowerName ? 'Borrower: ' + meta.borrowerName + '   ·   ' : '')
    + 'Generated ' + (meta.generatedDate || '') + '   ·   NMLS ID 2609746']);
  // WHAT THIS REPORT CONTAINS, on its face (owner-directed 2026-08-21). "Why is this list
  // shorter than the one I saw yesterday" has to be answerable from the document itself, so
  // the scope is stated — and when the report carries anything unverified, the banner says so
  // before the reader reaches the first row. The wording is export-scope's, never retyped.
  aoa.push([scope.title]);
  aoa.push([scope.note]);
  if (scope.banner) aoa.push(['⚠ ' + scope.banner]);
  // WHAT THE FILTER REMOVED, BEFORE THE FIRST ROW. A reader comparing this workbook to the
  // screen must not have to count rows by hand to discover a project is missing — the top of
  // the page answers "why is this shorter than the record" and the block under the summary
  // names each one. Absent when nothing was held back, so a complete export is unchanged.
  const heldBack = Array.isArray(meta.heldBack) ? meta.heldBack : [];
  const onRecord = Number(meta.recordTotal) || (heldBack.length + countRows(sections));
  if (heldBack.length) aoa.push(['⚠ ' + SCOPE.heldBackHeadline(heldBack.length, onRecord)]);
  aoa.push([]);
  const stamped = SCOPE.hasUnverified(sections);
  for (const sec of sections) {
    aoa.push([sec.title]);
    // THE STAMP RIDES EVERY UNVERIFIED ROW, not only the summary (owner-directed 2026-08-21:
    // "everything that is unverified should have a stamp that it's not verified yet"). A
    // summary at the top is long gone by the time a reader is on page three. The column
    // appears only when this export really carries an unverified line, so a verified-only
    // report is byte-identical to what shipped before.
    aoa.push(sec.columns.map((c) => c.header).concat(stamped ? ['Verification'] : []));
    if (!sec.rows.length) {
      aoa.push(['No deals entered in this section.']);
    } else {
      for (const row of sec.rows) {
        const cells = sec.columns.map((c) => {
          const v = row[c.key];
          if (c.money) return (v == null || v === '' || !isFinite(Number(v))) ? '' : Number(v);
          return v == null ? '' : String(v);
        });
        if (stamped) { const st = SCOPE.rowStamp(row); cells.push(st ? st.text : ''); }
        aoa.push(cells);
      }
      aoa.push(sec.columns.map((c, i) => {
        if (i === 0) return 'TOTALS (' + sec.rows.length + ')';
        if (c.sum) { let s = 0; for (const r of sec.rows) { const v = Number(r[c.key]); if (isFinite(v)) s += v; } return s; }
        return '';
      }).concat(stamped ? [''] : []));
    }
    aoa.push([]);
  }
  // A clear, per-status breakdown — never a bare "N verified" (owner-directed
  // 2026-08-05). Covers all five buckets the owner listed.
  const t = tallyReviewStatus(sections);
  aoa.push(['VERIFICATION SUMMARY — ' + t.total + ' project(s):']);
  aoa.push(['  Verified: ' + t.verified]);
  aoa.push(['  Documentation attached, pending review: ' + t.docs_review]);
  aoa.push(['  Pending review (self-reported): ' + t.pending]);
  aoa.push(['  Not yet verified: ' + t.not_verified]);
  aoa.push(['  Total with documentation attached: ' + t.withDocs]);
  // The records stamp — the owner's own words ("Verified to Elementix"),
  // printed only when a row actually carries it; an unstamped export is unchanged.
  const stampLine = recordsStampLine(sections);
  if (stampLine) aoa.push(['  ' + stampLine]);
  // …AND THE PROJECTS THIS REPORT DOES NOT CARRY, BY NAME. The count alone would say a line is
  // missing without saying WHICH, which is the same phone call.
  if (heldBack.length) {
    aoa.push([]);
    aoa.push([SCOPE.heldBackHeadline(heldBack.length, onRecord)]);
    for (const h of heldBack) aoa.push(['  ' + SCOPE.heldBackLine(h)]);
  }
  aoa.push([]);
  aoa.push(['Status key:  Verified = confirmed by the loan team.  Docs in — review = a document is attached and is being reviewed (not yet verified).  Pending review = the borrower entered this and it is waiting on the loan team.  Not verified = nothing attached and not yet reviewed.']);
  return aoa;
}

// Compact, branded, landscape PDF report — the "PDF export from our track record
// section". pdf-lib only (already a dependency); modeled on src/trustpoint/report.js.
async function buildTrackRecordPdf(sections, meta = {}) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const RSTAMP = require('./track-record/records-stamp');
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
  { x: ML, y, size: 8, font, color: muted }); y -= 14;

  // WHAT THIS REPORT CONTAINS (owner-directed 2026-08-21). The scope on its face, and — when
  // the report carries anything unverified — a red banner BEFORE the first row. The wording is
  // export-scope's ONE definition, never restated here; a test reads this file and fails the
  // moment it is.
  const SCOPE = require('./track-record/export-scope');
  const scope = SCOPE.scopeMeta(meta.scope);
  const warn = rgb(0.706, 0.271, 0.235);
  const stamped = SCOPE.hasUnverified(sections);
  page.drawText(scope.title, { x: ML, y, size: 8, font: bold, color: ink }); y -= 11;
  page.drawText(scope.note, { x: ML, y, size: 7.5, font, color: muted }); y -= 13;
  // WHAT THE FILTER REMOVED, BEFORE THE FIRST ROW — the same rule, the same wording and the same
  // placement as the Excel writer, so the two documents can never describe one gap differently.
  const heldBack = Array.isArray(meta.heldBack) ? meta.heldBack : [];
  const onRecord = Number(meta.recordTotal) || (heldBack.length + countRows(sections));
  if (heldBack.length) {
    // NO WARNING GLYPH HERE. This font is WinAnsi and a ⚠ throws when the PDF is drawn — the
    // same reason the records stamp's ✓/○ are absent from this writer. The Excel keeps it.
    page.drawText(SCOPE.heldBackHeadline(heldBack.length, onRecord),
      { x: ML, y, size: 8, font: bold, color: warn }); y -= 12;
  }
  if (scope.banner) {
    // A flat block, never angled — the stamp design spec this repo already follows.
    page.drawRectangle({ x: ML, y: y - 3, width: usableW, height: 13, color: warn });
    page.drawText(scope.banner, { x: ML + 5, y, size: 8, font: bold, color: rgb(1, 1, 1) });
    y -= 18;
  } else { y -= 4; }

  // ---- THE VERIFICATION STAMP (owner-directed 2026-08-05): a clear, colored
  // breakdown at the top so a reader sees at a glance what is verified vs not —
  // never "everything is verified".
  const tally = tallyReviewStatus(sections);
  page.drawText('VERIFICATION SUMMARY', { x: ML, y, size: 8, font: bold, color: ink }); y -= 13;
  {
    let x = ML;
    const chip = (statusKey, count) => {
      const st = REVIEW_STATUS[statusKey];
      page.drawRectangle({ x, y: y - 1, width: 8, height: 8, color: rgb(st.rgb[0], st.rgb[1], st.rgb[2]) });
      const label = `${st.label}: ${count}`;
      page.drawText(label, { x: x + 11, y, size: 7.5, font: bold, color: ink });
      x += 11 + bold.widthOfTextAtSize(label, 7.5) + 16;
    };
    chip('verified', tally.verified);
    chip('docs_review', tally.docs_review);
    chip('pending', tally.pending);
    chip('not_verified', tally.not_verified);
    page.drawText(`· Documentation attached: ${tally.withDocs} of ${tally.total}`, { x, y, size: 7.5, font, color: muted });
  }
  y -= 13;
  // THE RECORDS STAMP — a flat teal line under the summary (never angled; the
  // stamp design spec), drawn only when a row is records-backed. The words are
  // records-stamp.summaryLine's — "VERIFIED TO ELEMENTIX", the owner's own.
  {
    const stampLine = recordsStampLine(sections);
    if (stampLine) {
      const teal = rgb(0.184, 0.498, 0.525);
      page.drawRectangle({ x: ML, y: y - 3, width: 3, height: 11, color: teal });
      page.drawText(stampLine, { x: ML + 7, y, size: 7.5, font: bold, color: teal });
      y -= 13;
    }
  }
  // …AND THE PROJECTS BY NAME. A count without the names is the same phone call.
  if (heldBack.length) {
    page.drawText(SCOPE.heldBackHeadline(heldBack.length, onRecord),
      { x: ML, y, size: 8, font: bold, color: warn }); y -= 11;
    for (const h of heldBack) {
      page.drawText('· ' + SCOPE.heldBackLine(h), { x: ML + 6, y, size: 7.5, font, color: ink });
      y -= 10;
    }
    y -= 3;
  }
  y -= 5;

  for (const sec of sections) {
    // THE PER-ROW VERIFICATION STAMP is a real COLUMN, added here rather than by the caller —
    // the same rule the Excel writer applies, so the two documents can never carry it on
    // different terms. It exists only when this export really carries an unverified line, so a
    // verified-only report keeps exactly the columns it always had. The SHORT form is used
    // because the column is narrow; the sentence in full is on the banner above.
    const cols = stamped
      ? sec.columns.concat([{ header: 'Verification', key: '__stamp', w: 1.3, align: 'center' }])
      : sec.columns;
    const totalW = cols.reduce((a, c) => a + (c.w || 1), 0) || 1;
    const colX = []; const colW = [];
    let cx = ML;
    for (const c of cols) { colX.push(cx); const w = (c.w || 1) / totalW * usableW; colW.push(w); cx += w; }

    // A cell, clipped to its column box, left/right-aligned.
    const cell = (txt, i, { f = font, size = 7.5, color = ink, align } = {}) => {
      let s = String(txt == null ? '' : txt);
      const boxW = colW[i] - 4;
      while (s.length && f.widthOfTextAtSize(s, size) > boxW) s = s.slice(0, -1);
      const al = align || cols[i].align || 'left';
      const x = al === 'right' ? colX[i] + colW[i] - 2 - f.widthOfTextAtSize(s, size) : colX[i] + 2;
      page.drawText(s, { x, y, size, font: f, color });
    };
    const drawHead = () => {
      page.drawRectangle({ x: ML, y: y - 3, width: usableW, height: 13, color: bannerBg });
      page.drawText(sec.title, { x: ML + 4, y, size: 8.5, font: bold, color: bannerFg });
      y -= ROW + 3;
      cols.forEach((c, i) => cell(c.header, i, { f: bold, size: 7, color: ink }));
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
      cols.forEach((c, i) => {
        // The stamp cell — red and bold, so an unverified line cannot be skimmed past.
        // ASCII only: the PDF font is WinAnsi and `drawText` THROWS on a glyph it cannot
        // encode, and this whole builder sits inside a caller's try/catch — one un-encodable
        // character once made the investor package's PDF disappear from the ZIP in silence.
        if (c.key === '__stamp') {
          const st = SCOPE.rowStamp(row);
          return cell(st ? st.short : '', i, { f: bold, size: 7, color: warn });
        }
        // The Review-status cell is a per-deal STAMP — coloured by its status.
        if (c.key === 'status') {
          const st = REVIEW_STATUS[row.__status] || REVIEW_STATUS.not_verified;
          return cell(row.status || st.label, i, { f: bold, size: 7, color: rgb(st.rgb[0], st.rgb[1], st.rgb[2]) });
        }
        /* THE PDF FONT IS WinAnsi AND `drawText` THROWS on a glyph it cannot
           encode — and this whole builder sits inside a try/catch in
           tpr-export that only console.warns, so one stamped line made the
           investor package's Track Record.pdf disappear from the ZIP with
           nothing said anywhere. The ASCII form of the stamp carries the same
           words without the tick or the ring. */
        if (c.key === 'records') return cell(RSTAMP.exportCellText(row.__recordsStamp, row.__recordsStampAt, { ascii: true }), i);
        cell(c.money ? money(row[c.key]) : row[c.key], i);
      });
      y -= ROW;
    }
    // totals band
    if (y - ROW < MB) { newPage(); drawHead(); }
    page.drawRectangle({ x: ML, y: y - 2, width: usableW, height: ROW, color: totalBg });
    cols.forEach((c, i) => {
      if (i === 0) return cell('TOTALS (' + sec.rows.length + ')', 0, { f: bold, size: 7.5 });
      if (c.sum) { let s = 0; for (const r of sec.rows) { const v = Number(r[c.key]); if (isFinite(v)) s += v; } return cell(money(s), i, { f: bold, size: 7.5 }); }
    });
    y -= ROW + 8;
  }

  const legendY = Math.max(y, MB - 8);
  page.drawText('Status key: Verified = confirmed by the loan team · Docs in — review = a document is attached, not yet verified · Pending review = borrower-entered, waiting on the loan team · Not verified = nothing attached, not reviewed.',
    { x: ML, y: legendY, size: 6.5, font, color: muted });
  page.drawText('YS Capital Group · NMLS ID 2609746 — experience counted only for a completed exit within the last 3 years.',
    { x: ML, y: legendY - 10, size: 7.5, font, color: muted });
  return Buffer.from(await doc.save());
}

module.exports = { trackRecordAoa, buildTrackRecordPdf, trackRecordReviewStatus, REVIEW_STATUS, tallyReviewStatus, recordsStampLine };
