/**
 * test-esign-iska-pdf.js — unit tests for the Heter Iska PDF generator
 * (src/lib/esign/iska-pdf.js). The owner (2026-07-20) asked us to send DocuSign a
 * PDF we generate — with the loan amount + borrower name filled — instead of handing
 * DocuSign the Word template. The sacred Hebrew nusach is a verified pre-render
 * (templates/iska/*.jpg, built byte-exact from the Word template); this module lays
 * those page images into a jsPDF page and draws ONLY the Latin loan amount + names +
 * the invisible DocuSign anchors on top. No database, no DocuSign, no Chromium — a
 * pure renderer over the flat data object orchestrate.loadDocGenData returns.
 *
 * jsPDF stores its text uncompressed, so the drawn values + anchor strings are
 * greppable in the raw PDF bytes. The anchors MUST match orchestrate.tabsFor exactly.
 *
 * Run: node scripts/test-esign-iska-pdf.js
 */
const assert = require('assert');
const path = require('path');
const R = path.resolve(__dirname, '..');
const iska = require(R + '/src/lib/esign/iska-pdf');
const docgen = require(R + '/src/lib/esign/docgen');
const orch = require(R + '/src/lib/esign/orchestrate');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); n++; };

const CO = { loanAmount: 1287500.5, bFirst: 'Yaakov M', bLast: "O'Brien", hasCoBorrower: true, cbFirst: 'Rivka', cbLast: "O'Brien" };
const SOLO = { loanAmount: 487500, bFirst: 'Jonathan', bLast: 'Goldberg', hasCoBorrower: false };
const raw = (buf) => buf.toString('latin1');
// jsPDF PDFs are single-object /Count on the Pages node → count "/Type /Page" (not /Pages).
function pageCount(buf) { return (raw(buf).match(/\/Type\s*\/Page[^s]/g) || []).length; }

// ---- 1. it is a real PDF, two pages, via the docgen contract ------------------
{
  const buf = docgen.generate('heter_iska', CO);
  ok(Buffer.isBuffer(buf), "generate('heter_iska') returns a Buffer");
  eq(raw(buf).slice(0, 5), '%PDF-', 'Heter Iska is a real PDF (not a .docx)');
  eq(pageCount(buf), 2, 'Heter Iska renders as two pages');
  ok(buf.length > 50_000 && buf.length < 4_000_000, `PDF is a sane size for DocuSign (${buf.length} bytes)`);
}

// ---- 2. WITH a co-borrower: amount, both names, all four anchors --------------
{
  const buf = iska.buildIskaPdf(CO);
  const s = raw(buf);
  ok(s.includes('1,287,500.50'), 'co: loan amount drawn (2 decimals, thousands)');
  ok(s.includes('Yaakov M') && s.includes('O\'Brien'), 'co: borrower name drawn');
  ok(s.includes('Rivka'), 'co: co-borrower name drawn');
  for (const a of ['/iska_b1_sig/', '/iska_b1_dt/', '/iska_b2_sig/', '/iska_b2_dt/'])
    ok(s.includes(a), `co: carries anchor ${a}`);
}

// ---- 3. WITHOUT a co-borrower: borrower only, no co anchors/name --------------
{
  const buf = iska.buildIskaPdf(SOLO);
  const s = raw(buf);
  ok(s.includes('487,500.00'), 'solo: loan amount drawn');
  ok(s.includes('Jonathan') && s.includes('Goldberg'), 'solo: borrower name drawn');
  ok(s.includes('/iska_b1_sig/') && s.includes('/iska_b1_dt/'), 'solo: borrower anchors present');
  ok(!s.includes('/iska_b2_sig/') && !s.includes('/iska_b2_dt/'), 'solo: NO co-borrower anchors');
  eq(pageCount(buf), 2, 'solo also renders two pages');
}

// ---- 4. anchors EXACTLY match orchestrate.tabsFor (prefix iska; b1/b2) --------
{
  // Simulate the tab plan the send engine builds for the Iska package (documentId 1).
  const spec = orch.packageSpec('heter_iska');
  const tabsB1 = orch.tabsFor('borrower', spec, { heter_iska: 1 })[1];
  const tabsB2 = orch.tabsFor('co_borrower', spec, { heter_iska: 1 })[1];
  const plan = iska.overlayPlan(CO).filter((o) => !o.visible).map((o) => o.text);
  for (const a of [...tabsB1.sign, ...tabsB1.date, ...tabsB2.sign, ...tabsB2.date])
    ok(plan.includes(a), `overlay anchor ${a} matches tabsFor`);
  // admin never signs the Iska
  eq(spec.countersignRequired, false, 'Heter Iska has no admin counter-signer');
}

// ---- 5. overlayPlan: correct slots / pages / values --------------------------
{
  const co = iska.overlayPlan(CO);
  const amt = co.find((o) => o.visible && o.text.includes('1,287,500'));
  ok(amt && amt.page === 0, 'amount slot is on page 1 (the nusach opening)');
  ok(amt.align === 'center' && amt.wPt > 0 && amt.baselinePt > 0, 'amount slot has center align + a measured box + baseline');
  const bname = co.find((o) => o.visible && o.text.includes('Yaakov'));
  ok(bname && bname.align === 'left' && bname.page === 1, 'borrower name slot is left-aligned on the signature page');
  eq(iska.overlayPlan(SOLO).filter((o) => o.text.includes('Rivka')).length, 0, 'solo plan draws no co-borrower name');
}

// ---- 6. fmtAmount: money formatting + safe on bad input ----------------------
{
  eq(iska.fmtAmount(487500), '487,500.00', 'whole dollars → 2dp thousands');
  eq(iska.fmtAmount(1287500.5), '1,287,500.50', 'cents preserved');
  eq(iska.fmtAmount(0), '0.00', 'zero renders (blocked upstream, but formats safely)');
  eq(iska.fmtAmount(null), '', 'null → blank (never a fake $0)');
  eq(iska.fmtAmount('nope'), '', 'non-numeric → blank');
}

// ---- 7. robustness: long amount, non-Latin name, missing pieces --------------
{
  // 8-figure amount must still render (font auto-fits, no throw)
  ok(raw(iska.buildIskaPdf({ ...SOLO, loanAmount: 12345678.9 })).includes('12,345,678.90'), 'long amount fits + draws');
  // a fully non-Latin legal name strips to empty (pdfSafe) — must not throw
  const heb = iska.buildIskaPdf({ ...SOLO, bFirst: 'משה', bLast: 'כהן' });
  ok(Buffer.isBuffer(heb) && raw(heb).slice(0, 5) === '%PDF-', 'non-Latin name → still a valid PDF (name strips, no crash)');
  // missing amount does not crash the renderer (send is blocked upstream by validateGenerated)
  ok(Buffer.isBuffer(iska.buildIskaPdf({ ...SOLO, loanAmount: null })), 'missing amount → still renders (upstream gate blocks the send)');
}

console.log(`✓ esign iska-pdf: ${n} assertions passed`);
