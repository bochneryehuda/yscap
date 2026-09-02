'use strict';

/**
 * esign/term-sheet-signers.js — DOES THE TERM SHEET ON FILE CARRY A SIGNATURE
 * LINE FOR EVERY PERSON WHO IS ABOUT TO SIGN IT?
 *
 * THE DEFECT THIS CLOSES (owner-reported 2026-09-02, file YSCAP258134773):
 * "the term sheet doesn't populate signature for both borrowers … it says
 * Guarantor — only the first guarantor, and technically both of them are
 * guarantors." The package went out to BOTH borrowers (the roster is built from
 * the file, which had a co-borrower), but the Term Sheet PDF attached to it had
 * been drawn by the Term Sheet Studio with the co-borrower box EMPTY — so it
 * printed "Guarantor: <one name>" and drew ONE borrower signature block, and the
 * co-borrower's `/ts_b2_sig/` anchor was never on the page. DocuSign's anchor
 * tabs are `anchorIgnoreIfNotPresent`, so nothing errored: the co-borrower got
 * tabs on the application and the disclosure and NONE on the term sheet, and
 * the one legal document that names the guarantors named only one of them.
 *
 * WHY A SERVER-SIDE CHECK, NOT A STUDIO FIX ALONE. The sheet is the one
 * document our server does not draw (see docgen.js) — the studio draws it in the
 * browser from whatever party names it was handed, and a stale screen, an older
 * sheet already stamped FINAL, or a co-borrower added after the sheet was made
 * all produce the same silent outcome. The send is the last place that can look
 * at the bytes and the roster together, so it is the place that must refuse.
 * FAIL CLOSED: a sheet that cannot be read is treated as a sheet with no anchors.
 *
 * THE RULE — over the text layer of the PDF (the same text layer DocuSign reads
 * to place the tabs):
 *   · every roster member who signs the term sheet must have their `/ts_<role>_sig/`
 *     anchor on it (borrower b1, co-borrower b2, loan officer lo, lender admin);
 *   · a co-borrower line on the sheet with NO co-borrower on the roster is also a
 *     mismatch — the sheet names a guarantor the file does not have.
 * ANCHOR_SUFFIX_BY_ROLE is the ONE map orchestrate.tabsFor places tabs by, so the
 * check and the placement can never disagree about which anchor a role uses.
 *
 * The text extraction walks every page's content stream (inflating FlateDecode
 * with pdf-lib's own decoder), collects the string operands of Tj/TJ — both
 * `(literal)` and `<hex>` forms — and searches that. It has no font-decoding
 * step on purpose: every sheet is drawn with jsPDF's standard fonts (WinAnsi),
 * whose bytes ARE the characters, and the anchors are plain ASCII. Anything
 * fancier would be a text extractor we would then have to trust.
 */

const pdfLib = require('pdf-lib');

/** Which `/ts_<suffix>_sig/` anchor each roster role signs the term sheet on. */
const ANCHOR_SUFFIX_BY_ROLE = Object.freeze({
  borrower: 'b1',
  co_borrower: 'b2',
  loan_officer: 'lo',
  admin: 'admin',
});

const TS_ANCHOR_RE = /\/ts_[a-z0-9]+_(?:sig|dt)\//g;

/** The string operands of a content stream, in order, joined so a TJ array
 *  `[(/ts_) (b2_sig/)] TJ` still reads as one anchor. Pure. */
function contentStreamText(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '%') {                      // comment to end of line
      while (i < n && src[i] !== '\n' && src[i] !== '\r') i++;
    } else if (c === '(') {               // literal string, with escapes + nesting
      let depth = 1, s = '';
      i++;
      while (i < n && depth > 0) {
        const ch = src[i];
        if (ch === '\\') {
          const nx = src[i + 1];
          if (nx === 'n') s += '\n';
          else if (nx === 'r') s += '\r';
          else if (nx === 't') s += '\t';
          else if (nx === 'b') s += '\b';
          else if (nx === 'f') s += '\f';
          else if (nx >= '0' && nx <= '7') {
            const m = /^[0-7]{1,3}/.exec(src.slice(i + 1, i + 4))[0];
            s += String.fromCharCode(parseInt(m, 8));
            i += m.length - 1;
          } else if (nx === '\n' || nx === '\r') { /* line continuation */ }
          else s += nx;
          i += 2;
          continue;
        }
        if (ch === '(') depth++;
        else if (ch === ')') { depth--; if (depth === 0) { i++; break; } }
        s += ch;
        i++;
      }
      out.push(s);
    } else if (c === '<' && src[i + 1] !== '<') {   // hex string (not a dictionary)
      const end = src.indexOf('>', i + 1);
      const hex = (end < 0 ? src.slice(i + 1) : src.slice(i + 1, end)).replace(/[^0-9a-fA-F]/g, '');
      let s = '';
      for (let k = 0; k + 1 < hex.length; k += 2) s += String.fromCharCode(parseInt(hex.slice(k, k + 2), 16));
      if (hex.length % 2 === 1) s += String.fromCharCode(parseInt(hex[hex.length - 1] + '0', 16));
      out.push(s);
      i = end < 0 ? n : end + 1;
    } else if (c === 'T' && (src[i + 1] === 'j' || src[i + 1] === 'J' || src[i + 1] === '*')) {
      out.push('\n');                     // a show-text operator ends a run
      i += 2;
    } else if (c === "'" || c === '"') {
      out.push('\n');
      i++;
    } else {
      i++;
    }
  }
  return out.join('');
}

/**
 * Every term-sheet anchor (`/ts_*_sig/`, `/ts_*_dt/`) present in the PDF's text
 * layer. Throws on a PDF that cannot be parsed — the caller decides that a sheet
 * it cannot read is a sheet it must not send.
 * @param {Buffer|Uint8Array} bytes
 * @returns {Promise<Set<string>>}
 */
async function termSheetAnchorsIn(bytes) {
  const { PDFDocument, PDFArray, PDFRawStream, decodePDFRawStream } = pdfLib;
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
  const found = new Set();
  for (const page of doc.getPages()) {
    const contents = page.node.Contents();
    if (!contents) continue;
    const streams = contents instanceof PDFArray
      ? contents.asArray().map((ref) => doc.context.lookup(ref))
      : [contents];
    for (const stream of streams) {
      if (!stream) continue;
      let raw;
      if (stream instanceof PDFRawStream) raw = decodePDFRawStream(stream).decode();
      else if (typeof stream.getContents === 'function') raw = stream.getContents();
      else continue;
      const text = contentStreamText(Buffer.from(raw).toString('latin1'));
      let m;
      TS_ANCHOR_RE.lastIndex = 0;
      while ((m = TS_ANCHOR_RE.exec(text)) !== null) found.add(m[0]);
    }
  }
  return found;
}

/** The anchor a roster role must find on the term sheet, or null for a role that
 *  does not sign it. */
function signAnchorForRole(role) {
  const sfx = ANCHOR_SUFFIX_BY_ROLE[role];
  return sfx ? `/ts_${sfx}_sig/` : null;
}

/**
 * PURE — the rule. `roster` is the term-sheet package's recipient list
 * ({role, name}); `anchors` is what termSheetAnchorsIn found.
 * @returns {{ok:boolean, missing:Array<{role:string,name:string,anchor:string}>, extra:Array<{role:string,anchor:string}>, message:string|null}}
 */
function termSheetSignerCheck({ roster = [], anchors = new Set() } = {}) {
  const has = (a) => anchors.has(a);
  const missing = [];
  for (const r of roster) {
    const anchor = signAnchorForRole(r.role);
    if (anchor && !has(anchor)) missing.push({ role: r.role, name: r.name || '', anchor });
  }
  const extra = [];
  const rolesOnRoster = new Set(roster.map((r) => r.role));
  if (has(signAnchorForRole('co_borrower')) && !rolesOnRoster.has('co_borrower')) {
    extra.push({ role: 'co_borrower', anchor: signAnchorForRole('co_borrower') });
  }
  const ok = missing.length === 0 && extra.length === 0;
  return { ok, missing, extra, message: ok ? null : signerMismatchMessage({ missing, extra }) };
}

const ROLE_LABEL = {
  borrower: 'the borrower',
  co_borrower: 'the co-borrower',
  loan_officer: 'the loan officer',
  admin: 'the lender countersignature',
};

/** Plain-language refusal that names WHO is missing and the one button that fixes it. */
function signerMismatchMessage({ missing = [], extra = [] } = {}) {
  const parts = [];
  const co = missing.find((m) => m.role === 'co_borrower');
  if (co) {
    parts.push(`The Term Sheet on file was generated without the co-borrower${co.name ? ` (${co.name})` : ''}: `
      + 'it has no signature line for them and names only one guarantor, but this file has two borrowers and both are guarantors.');
  }
  const others = missing.filter((m) => m.role !== 'co_borrower');
  if (others.length) {
    parts.push(`The Term Sheet on file has no signature line for ${others.map((m) => ROLE_LABEL[m.role] || m.role).join(', ')}.`);
  }
  if (extra.length) {
    parts.push('The Term Sheet on file carries a co-borrower signature line, but this file has no co-borrower — it names a guarantor who is not on the file.');
  }
  parts.push('Press "Finalize & send" — it regenerates the same term sheet from the file\'s current borrowers (every borrower on the file is a guarantor) and sends it.');
  return parts.join(' ');
}

/**
 * Read the sheet and apply the rule. A PDF that cannot be parsed is reported as
 * a mismatch with every roster anchor missing (fail closed), never as a pass.
 */
async function checkTermSheetSigners(bytes, roster) {
  let anchors;
  try { anchors = await termSheetAnchorsIn(bytes); }
  catch (e) {
    // pdf-lib answers a non-PDF with a parse error and a mangled one with a
    // TypeError from deep inside its object model — neither wording belongs on a
    // screen. Say what a person can act on: it is not a readable PDF.
    const why = e && /Failed to parse|No PDF header|Expected/i.test(String(e.message || '')) ? 'it is not a valid PDF' : 'the file could not be read';
    const r = termSheetSignerCheck({ roster, anchors: new Set() });
    return { ...r, ok: false, unreadable: true,
      message: `The Term Sheet on file could not be read (${why}), so its signature lines cannot be verified and it cannot go out for signature. `
        + 'Press "Finalize & send" — it regenerates the term sheet from the file\'s current borrowers and sends it.' };
  }
  return { ...termSheetSignerCheck({ roster, anchors }), unreadable: false, anchors };
}

module.exports = {
  ANCHOR_SUFFIX_BY_ROLE,
  signAnchorForRole,
  termSheetAnchorsIn,
  termSheetSignerCheck,
  checkTermSheetSigners,
  signerMismatchMessage,
  // exported for tests
  contentStreamText,
};
