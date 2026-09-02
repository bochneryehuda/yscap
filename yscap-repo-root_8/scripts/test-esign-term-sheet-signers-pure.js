'use strict';
/**
 * test-esign-term-sheet-signers-pure.js — the term sheet that goes out must carry
 * a signature line for everyone on the package (owner-reported 2026-09-02,
 * YSCAP258134773: "doesn't populate signature for both borrowers … only the
 * first guarantor").
 *
 * Proves, with no database and no network:
 *   A. the text-layer reader finds the studio's white 4pt anchors in a jsPDF-shaped
 *      PDF (uncompressed, literal strings) AND in a pdf-lib-shaped one (Flate-
 *      compressed, hex strings) — the two ways a sheet can reach the sender;
 *   B. the rule: a co-borrower on the roster with no `/ts_b2_sig/` on the sheet is
 *      refused and the refusal NAMES the co-borrower and the button; a sheet with a
 *      co-borrower line on a one-borrower file is refused; a matching sheet passes;
 *      a missing loan-officer / lender line is refused too;
 *   C. an unreadable PDF fails CLOSED (never passes);
 *   D. orchestrate.tabsFor places tabs by the SAME role→anchor map the check reads
 *      — one definition, so the two can never drift apart.
 *
 * Every assertion was made to fail on purpose before it was trusted (the rule was
 * inverted, the anchor map was renamed) — none is decoration.
 */
const assert = require('assert');
const path = require('path');
const { PDFDocument, StandardFonts } = require('pdf-lib');

const R = path.resolve(__dirname, '..');
const S = require(R + '/src/lib/esign/term-sheet-signers');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); n++; };

/** A minimal, UNCOMPRESSED PDF in the shape jsPDF writes: literal strings, Tj. */
function jsPdfShaped(lines) {
  const content = lines.map((t, i) => `BT /F1 4 Tf 40 ${700 - i * 20} Td (${t}) Tj ET`).join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  let out = '%PDF-1.3\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** The same anchors drawn by pdf-lib: Flate-compressed content stream, hex strings. */
async function pdfLibShaped(lines) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  lines.forEach((t, i) => page.drawText(t, { x: 40, y: 700 - i * 20, size: 4, font }));
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

const ONE_BORROWER = ['Guarantor: Pat Borrower', '/ts_b1_sig/', '/ts_b1_dt/', '/ts_lo_sig/', '/ts_lo_dt/', '/ts_admin_sig/', '/ts_admin_dt/'];
const TWO_BORROWERS = ['Guarantors: Pat Borrower & Chris Co', ...ONE_BORROWER.slice(1), '/ts_b2_sig/', '/ts_b2_dt/'];

const FULL_ROSTER = [
  { role: 'borrower', name: 'Pat Borrower' }, { role: 'co_borrower', name: 'Chris Co' },
  { role: 'loan_officer', name: 'Lee Officer' }, { role: 'admin', name: 'YS Capital Group — Lender' },
];
const SOLO_ROSTER = FULL_ROSTER.filter((r) => r.role !== 'co_borrower');

(async () => {
  // ---- A. the reader, both PDF shapes -------------------------------------
  const jsOne = jsPdfShaped(ONE_BORROWER);
  const a1 = await S.termSheetAnchorsIn(jsOne);
  eq([...a1].sort().join(' '), '/ts_admin_dt/ /ts_admin_sig/ /ts_b1_dt/ /ts_b1_sig/ /ts_lo_dt/ /ts_lo_sig/', 'A1 jsPDF-shaped: every drawn anchor is read back, nothing invented');
  ok(!a1.has('/ts_b2_sig/'), 'A1 jsPDF-shaped: the co-borrower anchor is NOT reported when it was not drawn');

  const plTwo = await pdfLibShaped(TWO_BORROWERS);
  const a2 = await S.termSheetAnchorsIn(plTwo);
  ok(a2.has('/ts_b2_sig/') && a2.has('/ts_b1_sig/') && a2.has('/ts_admin_sig/') && a2.has('/ts_lo_sig/'),
    'A2 pdf-lib-shaped (Flate + hex strings): every anchor is read through the compressed stream');
  eq(a2.size, 8, 'A2 pdf-lib-shaped: exactly the eight drawn anchors');

  // The stream reader on its own: a TJ array split mid-anchor still reads as one anchor,
  // and an escaped literal is unescaped.
  eq(S.contentStreamText('[(/ts_) -20 (b2_sig/)] TJ (a\\)b) Tj').replace(/\n/g, '|'), '/ts_b2_sig/|a)b|', 'A3 TJ arrays join across kerning; literal escapes are honored');
  eq(S.contentStreamText('<2f74735f62315f7369672f> Tj').trim(), '/ts_b1_sig/', 'A4 a hex string decodes to the anchor');

  // ---- B. the rule ----------------------------------------------------------
  const missCo = S.termSheetSignerCheck({ roster: FULL_ROSTER, anchors: a1 });
  eq(missCo.ok, false, 'B1 co-borrower on the roster, no b2 line on the sheet → refused');
  eq(missCo.missing.length, 1, 'B1 exactly one signer is missing');
  eq(missCo.missing[0].role, 'co_borrower', 'B1 …and it is the co-borrower');
  ok(/Chris Co/.test(missCo.message), 'B1 the refusal NAMES the co-borrower');
  ok(/only one guarantor/.test(missCo.message) && /both are guarantors/.test(missCo.message), 'B1 the refusal says why: one guarantor named where the file has two');
  ok(/Finalize & send/.test(missCo.message), 'B1 the refusal names the button that fixes it');

  const extraCo = S.termSheetSignerCheck({ roster: SOLO_ROSTER, anchors: a2 });
  eq(extraCo.ok, false, 'B2 a co-borrower line on a one-borrower file → refused (names a guarantor not on the file)');
  eq(extraCo.extra.length, 1, 'B2 reported as an extra signer');
  eq(extraCo.missing.length, 0, 'B2 nothing missing');
  ok(/no co-borrower/.test(extraCo.message), 'B2 the refusal says the file has no co-borrower');

  eq(S.termSheetSignerCheck({ roster: FULL_ROSTER, anchors: a2 }).ok, true, 'B3 two borrowers, two lines → passes');
  eq(S.termSheetSignerCheck({ roster: SOLO_ROSTER, anchors: a1 }).ok, true, 'B4 one borrower, one line → passes');

  const noLo = S.termSheetSignerCheck({ roster: FULL_ROSTER, anchors: new Set([...a2].filter((x) => !/_lo_/.test(x))) });
  eq(noLo.ok, false, 'B5 the loan officer signs the sheet — a sheet with no LO line is refused');
  eq(noLo.missing[0].role, 'loan_officer', 'B5 …naming the loan officer');
  const noAdmin = S.termSheetSignerCheck({ roster: FULL_ROSTER, anchors: new Set([...a2].filter((x) => !/_admin_/.test(x))) });
  eq(noAdmin.ok, false, 'B6 no lender countersignature line → refused');
  eq(noAdmin.missing[0].role, 'admin', 'B6 …naming the lender countersignature');

  // Other packages' anchors on the sheet (a mis-stored document) count for nothing.
  eq(S.termSheetSignerCheck({ roster: SOLO_ROSTER, anchors: new Set(['/app_b1_sig/', '/iska_b1_sig/']) }).ok, false, 'B7 only /ts_*/ anchors count');

  // The end-to-end reader + rule on real bytes.
  const e2e = await S.checkTermSheetSigners(jsOne, FULL_ROSTER);
  eq(e2e.ok, false, 'B8 bytes → anchors → rule: the one-borrower sheet is refused for the two-borrower roster');
  eq(e2e.unreadable, false, 'B8 …and it was readable');
  eq((await S.checkTermSheetSigners(plTwo, FULL_ROSTER)).ok, true, 'B9 bytes → anchors → rule: the two-borrower sheet passes');

  // ---- C. fail closed -------------------------------------------------------
  const bad = await S.checkTermSheetSigners(Buffer.from('this is not a pdf'), SOLO_ROSTER);
  eq(bad.ok, false, 'C1 an unreadable sheet never passes');
  eq(bad.unreadable, true, 'C1 …and says it could not be read');
  ok(/could not be read/.test(bad.message) && /Finalize & send/.test(bad.message), 'C1 the message says so in words and names the button');
  eq(bad.missing.length, SOLO_ROSTER.length, 'C1 every roster signer is reported missing (nothing was verified)');

  // ---- D. one definition: the check reads the map the placement writes with ---
  const orchestrate = require(R + '/src/lib/esign/orchestrate');
  const spec = orchestrate.packageSpec('term_sheet_package');
  const tsDocId = { term_sheet: 1 };
  for (const role of ['borrower', 'co_borrower', 'loan_officer', 'admin']) {
    const tabs = orchestrate.tabsFor(role, spec, tsDocId);
    eq(tabs[1].sign[0], S.signAnchorForRole(role), `D1 tabsFor(${role}) places its tab on the anchor the signer check requires`);
  }
  const src = require('fs').readFileSync(R + '/src/lib/esign/orchestrate.js', 'utf8');
  ok(/ANCHOR_SUFFIX_BY_ROLE\[role\]/.test(src), 'D2 orchestrate.tabsFor reads ANCHOR_SUFFIX_BY_ROLE — no second hand-kept suffix map');
  ok(/TERM_SHEET_SIGNERS_MISMATCH/.test(src) && /checkTermSheetSigners\(/.test(src), 'D3 buildDefinition runs the check and refuses with TERM_SHEET_SIGNERS_MISMATCH');
  ok(/err\.retryable = false; err\.code = 'TERM_SHEET_SIGNERS_MISMATCH'/.test(src), 'D4 the refusal is PERMANENT (the same bytes can never pass on retry)');

  // ---- E. the OFFICER line is drawn by the send's own rule, from a fresh read ----
  // (owner-directed 2026-09-02, the officer half of the stale-parties gap)
  const fs = require('fs');
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const orch = strip(src);
  ok(/function loanOfficerSigner\(/.test(orch) && /loanOfficerSigner,/.test(orch), 'E1 orchestrate exports loanOfficerSigner — the one definition of who signs as officer');
  ok(/const loSigner = [^;]*loanOfficerSigner\(app\)/.test(orch) && !/app\.loan_officer_id && app\.officer_email\) \{\s*roster\.push/.test(orch),
    'E2 the roster seats the officer THROUGH the helper, not an inline re-statement of the rule');
  eq(orchestrate.loanOfficerSigner({ loan_officer_id: 'x', officer_email: 'lo@ys.com', officer_name: 'Lee', officer_nmls: '123' }).nmls, '123', 'E3 the helper carries the NMLS the sheet prints');
  eq(orchestrate.loanOfficerSigner({ loan_officer_id: null, loan_officer_name: 'Typed Only', officer_email: null }), null, 'E4 a typed name with no staff record signs nothing');
  eq(orchestrate.loanOfficerSigner({ loan_officer_id: 'x', officer_email: '   ' }), null, 'E5 a blank email is no officer');
  const staffSrc = strip(fs.readFileSync(R + '/src/routes/staff.js', 'utf8'));
  ok(/loanOfficer: require\('\.\.\/lib\/esign\/orchestrate'\)\.loanOfficerSigner\(pr\)/.test(staffSrc), 'E6 the pricing read names the officer through the SAME helper');
  ok(/lo\.nmls AS officer_nmls[\s\S]{0,600}LEFT JOIN staff_users lo ON lo\.id = a\.loan_officer_id/.test(staffSrc), 'E7 …joined to the staff record the send joins to');
  const panel = strip(fs.readFileSync(R + '/app-v2/src/components/ProductStudioPanel.jsx', 'utf8'));
  ok(/data\.parties\.loanOfficer/.test(panel) && /officer=\{studioOfficer\}/.test(panel), 'E8 the studio draws the officer from the server\'s parties read');
  ok(!/app\.loan_officer_email \|\| ''/.test(panel.replace(/\(\(app && app\.loan_officer_email\) \|\| ''\)/g, '')) , 'E9 the screen\'s officer fields are a FALLBACK only, never the primary source');
  const studio = strip(fs.readFileSync(R + '/app-v2/src/components/TermSheetStudio.jsx', 'utf8'));
  ok(/\}, \[officerName, officerEmail, officerNmls\]/.test(studio) && /w\.YSBRAND = Object\.assign\(\{\}, officer/.test(studio), 'E10 the studio re-publishes a changed officer to the tool without a remount');
  const pkg = JSON.parse(fs.readFileSync(R + '/package.json', 'utf8'));
  ok(/test-esign-term-sheet-parties-db\.js/.test(pkg.scripts.test), 'E11 the real-HTTP parties suite is in the npm test chain');

  console.log(`esign-term-sheet-signers-pure: ${n} assertions passed`);
})().catch((e) => { console.error(e); process.exit(1); });
