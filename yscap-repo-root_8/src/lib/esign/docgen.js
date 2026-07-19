/**
 * esign/docgen.js — the FREE, in-house document generator (no paid DocuSign
 * Document-Generation add-on).
 *
 * The two Word documents in ./templates/ (business-purpose disclosure + Heter
 * Iska) are Mail-Merge templates: each blank is a Word MERGEFIELD whose CACHED
 * result run reads «FieldName». DocuSign converts an uploaded .docx → PDF for
 * free WITHOUT running mail-merge, so it renders exactly the cached result text.
 * Therefore filling a blank is a safe, exact swap of just the «token» text —
 * nothing else in the document (crucially, none of the Hebrew nusach) moves.
 *
 * On top of filling the data blanks we inject INVISIBLE DocuSign anchors — white,
 * 1-point text a human never sees — at the signature/date lines, document-unique
 * per package + signer (/bpd_b1_sig/, /iska_b2_dt/, …) so the send engine's
 * anchor tabs land on the right line for the right recipient (mirrors the
 * term-sheet's white 4pt anchors in web/tools/termsheet.js).
 *
 * Everything is dependency-free: a .docx is a ZIP, and src/lib/zip.js gives us a
 * built-in-zlib reader/writer. We never shell out, never touch LibreOffice, and
 * never mutate the stored template (it's read once, filled in memory).
 */
const fs = require('fs');
const path = require('path');
const { zip, unzip } = require('../zip');

const TEMPLATE_DIR = path.join(__dirname, 'templates');
const AB = '«';   // «  (merge-field open guillemet)
const BB = '»';   // »  (merge-field close guillemet)

// ---- small XML helpers ------------------------------------------------------
function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** An invisible (white, 1pt) run carrying a DocuSign anchor string. */
function invisibleRun(text) {
  return `<w:r><w:rPr><w:color w:val="FFFFFF"/><w:sz w:val="2"/><w:szCs w:val="2"/></w:rPr>`
       + `<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

/** A normal visible Calibri run (used for the signature rule + labels we add). */
function visibleRun(text, sz = 22) {
  return `<w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>`
       + `<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr>`
       + `<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

// ---- paragraph-level surgery (all keyed on the stable «token» markers) -------
/** The byte range [start,end) of the <w:p>…</w:p> that CONTAINS `marker`. */
function paragraphRange(xml, marker) {
  const at = xml.indexOf(marker);
  if (at === -1) return null;
  // A paragraph starts at "<w:p>" or "<w:p " — take the closest one before marker.
  let start = -1;
  for (const open of ['<w:p>', '<w:p ']) {
    const i = xml.lastIndexOf(open, at);
    if (i > start) start = i;
  }
  const close = xml.indexOf('</w:p>', at);
  if (start === -1 || close === -1) return null;
  return { start, end: close + '</w:p>'.length };
}

/** Insert `paraXml` immediately BEFORE the paragraph containing `marker`. */
function insertParaBefore(xml, marker, paraXml) {
  const r = paragraphRange(xml, marker);
  if (!r) return xml;
  return xml.slice(0, r.start) + paraXml + xml.slice(r.start);
}

/** Insert `paraXml` immediately AFTER the paragraph containing `marker`. */
function insertParaAfter(xml, marker, paraXml) {
  const r = paragraphRange(xml, marker);
  if (!r) return xml;
  return xml.slice(0, r.end) + paraXml + xml.slice(r.end);
}

/** Remove the entire paragraph containing `marker` (used when there's no co-borrower). */
function removeParaContaining(xml, marker) {
  const r = paragraphRange(xml, marker);
  if (!r) return xml;
  return xml.slice(0, r.start) + xml.slice(r.end);
}

/**
 * Remove the paragraph containing `marker` AND the paragraph immediately before it
 * when that predecessor is a "נאום" declarant label or an empty spacer — used to
 * drop the Iska co-borrower block ("נאום … Co-Borrower: …") cleanly, leaving no
 * dangling label. Never removes a predecessor that carries real nusach text.
 */
function removeParaAndPrecedingLabel(xml, marker) {
  const r = paragraphRange(xml, marker);
  if (!r) return xml;
  let prevStart = -1;
  for (const open of ['<w:p>', '<w:p ']) { const i = xml.lastIndexOf(open, r.start - 1); if (i > prevStart) prevStart = i; }
  let removeStart = r.start;
  if (prevStart !== -1) {
    const prevText = [...xml.slice(prevStart, r.start).matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('').trim();
    if (prevText === '' || prevText === 'נאום') removeStart = prevStart;   // '' or נאום
  }
  return xml.slice(0, removeStart) + xml.slice(r.end);
}

/** Replace the whole <w:r>…marker…</w:r> RUN that contains `marker` with `replacementXml`. */
function replaceRunContaining(xml, marker, replacementXml) {
  const at = xml.indexOf(marker);
  if (at === -1) return xml;
  let rs = -1;
  for (const open of ['<w:r>', '<w:r ']) { const i = xml.lastIndexOf(open, at); if (i > rs) rs = i; }
  const re = xml.indexOf('</w:r>', at);
  if (rs === -1 || re === -1) return xml;
  return xml.slice(0, rs) + replacementXml + xml.slice(re + '</w:r>'.length);
}

/**
 * Replace the cached-result RUN of the Nth (1-based) «token» with `replacementXml`.
 * The cached result is always a single contiguous run: <w:r …><w:t…>«token»</w:t></w:r>.
 * We swap the whole run so we can change its formatting (e.g. to an invisible anchor).
 */
function replaceNthTokenRun(xml, token, n, replacementXml) {
  const needle = `${AB}${token}${BB}`;
  let from = 0, seen = 0;
  while (true) {
    const at = xml.indexOf(needle, from);
    if (at === -1) return xml;
    seen += 1;
    if (seen === n) {
      const runStart = xml.lastIndexOf('<w:r>', at) === -1
        ? xml.lastIndexOf('<w:r ', at)
        : Math.max(xml.lastIndexOf('<w:r>', at), xml.lastIndexOf('<w:r ', at));
      const runEnd = xml.indexOf('</w:r>', at) + '</w:r>'.length;
      if (runStart === -1 || runEnd === -1) return xml;
      return xml.slice(0, runStart) + replacementXml + xml.slice(runEnd);
    }
    from = at + needle.length;
  }
}

/** Fill a data blank: replace the «token» TEXT in-place (formatting preserved). */
function fillField(xml, token, value) {
  return xml.split(`${AB}${token}${BB}`).join(escapeXml(value));
}

// ---- value formatting -------------------------------------------------------
function fmtMoney(n) {
  const v = Number(n);
  if (!isFinite(v)) return '';
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(d) {
  if (!d) return '';
  // A date-only 'YYYY-MM-DD' string must NEVER go through new Date() — that reads
  // it as UTC midnight and shifts the day back one in any west-of-UTC timezone
  // (the repo's hard date-only rule / the DOB-date incident). Format its parts
  // directly, and format everything else in UTC so the rendered day is
  // deterministic regardless of the server's timezone.
  if (typeof d === 'string') {
    const m = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[2]}/${m[3]}/${m[1]}`;
  }
  const dt = (d instanceof Date) ? d : new Date(d);
  if (isNaN(dt.getTime())) return String(d);
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${mm}/${dd}/${dt.getUTCFullYear()}`;
}

// ---- signature rule runs (replace the leftover yellow "Sign Here" tag image) --
// Both templates carry static DocuSign "Sign Here" tag PICTURES (descr=
// "BorrowerSignature"/"CoborrowerSignature"), each on its own line right above
// the printed-name line — leftovers from a prior DocuSign web-console setup that
// would otherwise bake an ugly yellow arrow into the PDF and duplicate our real
// tab. We swap that image RUN for an invisible functional anchor + a clean rule,
// landing the signature exactly where the document designer intended.
//
// `withDate` appends an inline DateSigned anchor (used on the Iska, which has no
// «date» merge field of its own; the disclosure stamps its date inline instead).
function sigRuleRuns(prefix, suffix, withDate) {
  let runs = invisibleRun(`/${prefix}_${suffix}_sig/`)
           + visibleRun('__________________________________________');
  if (withDate) runs += visibleRun('     Date: ') + invisibleRun(`/${prefix}_${suffix}_dt/`);
  return runs;
}

// ---- template loading -------------------------------------------------------
const _cache = {};
function loadTemplateXml(file) {
  if (!_cache[file]) {
    const buf = fs.readFileSync(path.join(TEMPLATE_DIR, file));
    _cache[file] = unzip(buf);
  }
  // Return a fresh shallow clone of the entry list each call (we replace one entry).
  return _cache[file].map((e) => ({ name: e.name, data: e.data }));
}

function rezip(entries, xml) {
  const out = entries.map((e) =>
    e.name === 'word/document.xml' ? { name: e.name, data: Buffer.from(xml, 'utf8') } : e);
  return zip(out);
}

// ---- the two public builders ------------------------------------------------
/**
 * Fill the Business-Purpose Disclosure and return a .docx Buffer.
 * `data`: { loanNumber, applicationDate, executionDate, loanAmount,
 *           propStreet, propCity, propState, propZip,
 *           bFirst, bLast, hasCoBorrower, cbFirst, cbLast }
 */
function buildDisclosure(data = {}) {
  const entries = loadTemplateXml('business_purpose_disclosure.docx');
  let xml = entries.find((e) => e.name === 'word/document.xml').data.toString('utf8');
  const co = !!data.hasCoBorrower;

  // 1. Structural surgery FIRST (keyed on stable markers, before blanks are filled).
  // Swap the borrower "Sign Here" tag image for our anchored signature rule.
  xml = replaceRunContaining(xml, 'descr="BorrowerSignature"', sigRuleRuns('bpd', 'b1'));
  if (co) {
    xml = replaceRunContaining(xml, 'descr="CoborrowerSignature"', sigRuleRuns('bpd', 'b2'));
  } else {
    // No co-borrower: drop the co "Sign Here" line AND the "Co-Borrower: …" line.
    xml = removeParaContaining(xml, 'descr="CoborrowerSignature"');
    xml = removeParaContaining(xml, `${AB}Co_Borrower_Last_Name_4006${BB}`);
  }

  // Inline DateSigned anchors in place of the «M_1872» date blanks (borrower first,
  // then co-borrower; after co-removal only the borrower's blank remains).
  xml = replaceNthTokenRun(xml, 'M_1872', 1, invisibleRun('/bpd_b1_dt/'));
  if (co) xml = replaceNthTokenRun(xml, 'M_1872', 1, invisibleRun('/bpd_b2_dt/'));

  // 2. Fill the visible data blanks.
  xml = fillField(xml, 'Loan_Number_364', data.loanNumber || '');
  xml = fillField(xml, 'M_745', fmtDate(data.applicationDate));
  xml = fillField(xml, 'Loan_Amount_1109', fmtMoney(data.loanAmount));
  xml = fillField(xml, 'Subject_Property_Address_11', data.propStreet || '');
  xml = fillField(xml, 'Subject_Property_City_12', data.propCity || '');
  xml = fillField(xml, 'Subject_Property_State_14', data.propState || '');
  xml = fillField(xml, 'Subject_Property_Zip_15', data.propZip || '');
  xml = fillField(xml, 'M_1859', fmtDate(data.executionDate));
  xml = fillField(xml, 'Borrower_First_And_Middle_Name_36', data.bFirst || '');
  xml = fillField(xml, 'Borrower_Last_Name_4002', data.bLast || '');
  xml = fillField(xml, 'Co_Borrower_First_Name_4004', data.cbFirst || '');
  xml = fillField(xml, 'Co_Borrower_Last_Name_4006', data.cbLast || '');

  return rezip(entries, xml);
}

/**
 * Fill the Heter Iska and return a .docx Buffer. Only the loan amount + the two
 * declarant names are variable; the nusach is byte-preserved. Signature + date
 * lines are inserted directly below each declarant's name line.
 * `data`: { loanAmount, bFirst, bLast, hasCoBorrower, cbFirst, cbLast }
 */
function buildIska(data = {}) {
  const entries = loadTemplateXml('heter_iska.docx');
  let xml = entries.find((e) => e.name === 'word/document.xml').data.toString('utf8');
  const co = !!data.hasCoBorrower;

  // Swap each leftover "Sign Here" tag image (it sits just above the "נאום …
  // Borrower:" block) for our anchored signature + date rule. The Iska has no
  // date merge field, so the date anchor rides the rule (withDate = true).
  xml = replaceRunContaining(xml, 'descr="BorrowerSignature"', sigRuleRuns('iska', 'b1', true));
  if (co) {
    xml = replaceRunContaining(xml, 'descr="CoborrowerSignature"', sigRuleRuns('iska', 'b2', true));
  } else {
    // No co-borrower: drop the co "Sign Here" line, its "נאום" label, and the name line.
    xml = removeParaContaining(xml, 'descr="CoborrowerSignature"');
    xml = removeParaAndPrecedingLabel(xml, `${AB}Co_Borrower_Last_Name_4006${BB}`);
  }

  xml = fillField(xml, 'Loan_Amount_1109', fmtMoney(data.loanAmount));
  xml = fillField(xml, 'Borrower_First_And_Middle_Name_36', data.bFirst || '');
  xml = fillField(xml, 'Borrower_Last_Name_4002', data.bLast || '');
  xml = fillField(xml, 'Co_Borrower_First_Name_4004', data.cbFirst || '');
  xml = fillField(xml, 'Co_Borrower_Last_Name_4006', data.cbLast || '');

  return rezip(entries, xml);
}

const BUILDERS = { bp_disclosure: buildDisclosure, heter_iska: buildIska };

/** Build a generated document by doc_kind. Returns a .docx Buffer. */
function generate(docKind, data) {
  const fn = BUILDERS[docKind];
  if (!fn) { const e = new Error(`No generator for doc_kind "${docKind}"`); e.retryable = false; throw e; }
  return fn(data);
}

module.exports = {
  generate, buildDisclosure, buildIska,
  // exported for tests
  fillField, replaceNthTokenRun, replaceRunContaining, insertParaBefore, insertParaAfter,
  removeParaContaining, removeParaAndPrecedingLabel, fmtMoney, fmtDate, escapeXml,
};
