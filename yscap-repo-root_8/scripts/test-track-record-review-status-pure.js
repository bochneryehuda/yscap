/**
 * Track-record export shows a REAL per-deal review status — not "everything is
 * verified" (owner-directed 2026-08-05). The export must clearly say which deals
 * are verified · which have documentation attached · which are not yet verified ·
 * which have documentation but are not yet verified · which are still pending
 * review, with a nice status stamp on the PDF and a clear column + summary on the
 * Excel.
 *
 * PURE — no DB (the renderers are pure; the PDF uses pdf-lib, already installed).
 * In `npm test`.
 */
'use strict';
const assert = require('assert');
const tr = require('../src/lib/track-record-export');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// 1) The per-deal status covers all five owner buckets from data already on the row.
ok(tr.trackRecordReviewStatus({ is_verified: true }) === 'verified', 'verified deal → verified');
ok(tr.trackRecordReviewStatus({ is_verified: true, hasDocs: true }) === 'verified', 'verified wins even with docs');
ok(tr.trackRecordReviewStatus({ is_verified: false, hasDocs: true }) === 'docs_review', 'docs attached, not verified → docs_review');
ok(tr.trackRecordReviewStatus({ is_verified: false, hasDocs: true, entered_by_kind: 'borrower' }) === 'docs_review', 'docs beat "pending" (there is something to review)');
ok(tr.trackRecordReviewStatus({ is_verified: false, hasDocs: false, entered_by_kind: 'borrower' }) === 'pending', 'self-reported, no docs → pending review');
ok(tr.trackRecordReviewStatus({ is_verified: false, hasDocs: false, entered_by_kind: 'staff' }) === 'not_verified', 'no docs, not reviewed → not verified');
ok(tr.trackRecordReviewStatus({}) === 'not_verified', 'empty row → not verified (never a false "verified")');

// 2) Every status has a human label + a colour for the stamp.
for (const k of ['verified', 'docs_review', 'pending', 'not_verified']) {
  const s = tr.REVIEW_STATUS[k];
  ok(s && typeof s.label === 'string' && s.label.length > 0, `${k} has a label`);
  ok(s && Array.isArray(s.rgb) && s.rgb.length === 3, `${k} has an rgb colour`);
}

// 3) A representative set of deals — one of each — tallies correctly.
const sections = [{
  title: 'FIX & FLIP EXPERIENCE',
  columns: [
    { header: 'Property', key: 'property', w: 3, align: 'left' },
    { header: 'Sale price', key: 'sale', w: 1.3, money: true, align: 'right', sum: true },
    { header: 'Review status', key: 'status', w: 1.5, align: 'center' },
    { header: 'Docs', key: 'docs', w: 0.7, align: 'center' },
    { header: 'Recent (3yr)', key: 'counts', w: 0.9, align: 'center' },
  ],
  rows: [
    { property: '1 A St', sale: 300000, status: 'Verified', docs: 'Attached', counts: 'Yes', __status: 'verified', __hasDocs: true },
    { property: '2 B St', sale: 250000, status: 'Docs in — review', docs: 'Attached', counts: 'Yes', __status: 'docs_review', __hasDocs: true },
    { property: '3 C St', sale: 200000, status: 'Pending review', docs: '—', counts: 'No', __status: 'pending', __hasDocs: false },
    { property: '4 D St', sale: 150000, status: 'Not verified', docs: '—', counts: 'No', __status: 'not_verified', __hasDocs: false },
  ],
}];
const tally = tr.tallyReviewStatus(sections);
ok(tally.total === 4, 'tally: 4 total');
ok(tally.verified === 1 && tally.docs_review === 1 && tally.pending === 1 && tally.not_verified === 1, 'tally: one of each status');
ok(tally.withDocs === 2, 'tally: two deals have documentation attached');

// 4) The Excel array carries the status column value + the full breakdown summary,
//    never a bare "N verified".
const aoa = tr.trackRecordAoa(sections, { borrowerName: 'Test Borrower', generatedDate: '2026-08-05' });
const flat = aoa.map((row) => row.join(' | '));
ok(flat.some((l) => /VERIFICATION SUMMARY — 4/.test(l)), 'Excel summary states the total');
ok(flat.some((l) => /Documentation attached, pending review: 1/.test(l)), 'Excel summary lists the docs-in-review bucket');
ok(flat.some((l) => /Pending review \(self-reported\): 1/.test(l)), 'Excel summary lists the pending-review bucket');
ok(flat.some((l) => /Not yet verified: 1/.test(l)), 'Excel summary lists the not-verified bucket');
ok(flat.some((l) => /Total with documentation attached: 2/.test(l)), 'Excel summary lists the documentation total');
ok(flat.some((l) => /Status key:/.test(l)), 'Excel carries a plain-language status key');
ok(flat.some((l) => /Docs in — review/.test(l)), 'a per-deal status value is present in the sheet');

(async () => {
  // 5) The PDF renders (a real %PDF buffer) with the status data — the stamp path
  //    must never throw on a normal set of deals.
  const pdf = await tr.buildTrackRecordPdf(sections, { borrowerName: 'Test Borrower', generatedDate: '2026-08-05' });
  ok(Buffer.isBuffer(pdf) && pdf.length > 500, 'PDF renders to a non-trivial buffer');
  ok(pdf.slice(0, 5).toString('latin1') === '%PDF-', 'PDF starts with the %PDF- magic');
  // An empty file still renders (no deals → the stamp shows all zeros, no throw).
  const emptyPdf = await tr.buildTrackRecordPdf([{ title: 'FIX & FLIP', columns: sections[0].columns, rows: [] }], {});
  ok(Buffer.isBuffer(emptyPdf) && emptyPdf.slice(0, 5).toString('latin1') === '%PDF-', 'PDF renders even with no deals');

  if (failures) { console.error(`\n${failures} FAILED`); process.exit(1); }
  console.log('\nAll track-record review-status export checks passed.');
})().catch((e) => { console.error('ERROR', e && e.message); process.exit(1); });
