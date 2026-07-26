'use strict';
/**
 * Document authenticity scoring — Sovereign (blueprint enhancement, owner-
 * directed 2026-07-22). Pure heuristics over raw PDF bytes: no external
 * forensics API, no native deps. Produces a score 0-1 + a level
 * (high|medium|low|unreadable) + a list of the signals that fired.
 *
 * The signals here catch the majority of amateur tampering (a bank statement
 * opened in Photoshop, an appraisal re-saved after edits, a document with
 * multiple revisions crammed together). Professional forensic tools (Regula,
 * Ondato) do a much stronger job — this module is designed to POPULATE THE
 * SAME COLUMNS, so wiring one of those APIs later is a one-file swap.
 *
 * Not a fraud oracle: a low score is a REVIEW signal, not proof of fraud.
 * A perfectly-clean PDF can also be a well-forged one. Treat as a first-
 * order screen that lifts the WORST cases out of the pile.
 */

// Marker strings that indicate a document has been through an image editor
// (photoshopped) rather than a native producer.
const IMAGE_EDITOR_MARKERS = [
  'Adobe Photoshop', 'Photoshop CC', 'Photoshop CS', 'Photoshop 20',
  'Preview.app', 'macOS Preview', 'Skitch', 'Snagit', 'ScreenFlow',
  'iLovePDF', 'Smallpdf', 'PDFsam', 'Sejda', 'PDFescape',
];
// Known-legit producers that shouldn't lower a score.
const LEGIT_PRODUCERS = [
  'Bank of America', 'Chase', 'Wells Fargo', 'Citibank', 'Capital One',
  'iText', 'Prince', 'Adobe PDF Library', 'Adobe Acrobat Distiller',
  'Microsoft: Print To PDF', 'Microsoft Word', 'Microsoft: Office',
  'macOS Version', 'Google Chrome', 'Skia/PDF',
  'wkhtmltopdf', 'ReportLab', 'jsPDF', 'Ghostscript',
  'AppraisalPro', 'Alamode', 'ACI', 'a la mode',
];

// Extract every `/<Key>(<value>)` or `/<Key><</...>>` occurrence for the keys we care about.
function extractPdfMeta(str) {
  const meta = {};
  const KEYS = ['Producer', 'Creator', 'Author', 'Title', 'Subject', 'Keywords', 'CreationDate', 'ModDate'];
  for (const k of KEYS) {
    const re = new RegExp(`/${k}\\s*\\(([^)]*)\\)`, 'g');
    const matches = [];
    let m;
    while ((m = re.exec(str)) !== null) matches.push(unescapePdfString(m[1]));
    if (matches.length) meta[k] = matches;
  }
  return meta;
}

function unescapePdfString(s) {
  // Very small unescape — PDF strings have \(, \), \\, \n, \r etc.
  return String(s || '')
    .replace(/\\\(/g, '(').replace(/\\\)/g, ')').replace(/\\\\/g, '\\')
    .replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
}

// PDF date format: D:YYYYMMDDHHmmSS[+/-|Z]HH'mm' → JS Date (returns null on parse fail).
function parsePdfDate(s) {
  if (!s) return null;
  const m = String(s).match(/^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/);
  if (!m) return null;
  const y = Number(m[1]);
  if (y < 1990 || y > 2099) return null;
  const mo = m[2] ? Number(m[2]) - 1 : 0;
  const d  = m[3] ? Number(m[3]) : 1;
  const h  = m[4] ? Number(m[4]) : 0;
  const mn = m[5] ? Number(m[5]) : 0;
  const se = m[6] ? Number(m[6]) : 0;
  const dt = new Date(Date.UTC(y, mo, d, h, mn, se));
  return isNaN(dt) ? null : dt;
}

// Count occurrences of a substring.
function countOccurrences(str, needle) {
  let n = 0, i = 0;
  while ((i = str.indexOf(needle, i)) !== -1) { n += 1; i += needle.length; }
  return n;
}

/**
 * Analyze a PDF buffer. Returns { score, level, signals, meta } — never throws.
 * @param {Buffer} buffer
 * @param {object} [opts]
 * @param {string} [opts.docType] — used to tune expected producers (bank_statement expects
 *   a bank producer; a document from Photoshop is suspicious for a bank statement but
 *   normal for a photo ID).
 */
function analyzePdf(buffer, opts = {}) {
  const signals = [];
  const push = (name, present, weight, note) => signals.push({ name, present: !!present, weight, note });
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 100) {
    return { score: 0, level: 'unreadable', signals: [{ name: 'empty_or_tiny_file', present: true, weight: 1.0, note: 'buffer is empty or too small to analyze' }], meta: {} };
  }
  // Header check.
  const header = buffer.slice(0, 8).toString('latin1');
  const isPdf = /^%PDF-\d\.\d/.test(header);
  if (!isPdf) {
    return { score: 0, level: 'unreadable', signals: [{ name: 'not_a_pdf', present: true, weight: 1.0, note: `header is "${header}"` }], meta: {} };
  }

  // Slurp the whole file as latin1 (byte-preserving for metadata scanning).
  const str = buffer.toString('latin1');
  const meta = extractPdfMeta(str);
  const producers = meta.Producer || [];
  const creators = meta.Creator || [];
  const authors = meta.Author || [];
  const creationDates = (meta.CreationDate || []).map(parsePdfDate).filter(Boolean);
  const modDates = (meta.ModDate || []).map(parsePdfDate).filter(Boolean);

  const producerStr = producers.join(' | ').toLowerCase();
  const creatorStr = creators.join(' | ').toLowerCase();
  const anyEditor = IMAGE_EDITOR_MARKERS.some((m) => producerStr.includes(m.toLowerCase()) || creatorStr.includes(m.toLowerCase()));
  const anyLegit = LEGIT_PRODUCERS.some((m) => producerStr.includes(m.toLowerCase()) || creatorStr.includes(m.toLowerCase()));

  push('image_editor_marker', anyEditor, 0.35,
    anyEditor ? `producer/creator lists an image-editor tool (${producers.concat(creators).slice(0, 3).join('; ')})` : 'no image-editor markers in metadata');
  push('legitimate_producer', !anyEditor && anyLegit, -0.15,
    anyLegit ? `producer/creator matches a known-legitimate tool (${producers.concat(creators).slice(0, 2).join('; ')})` : 'producer not recognized as a known-legitimate tool');

  // Multiple revisions — a document that was edited-then-saved. `startxref` appears
  // once per revision; more than 1 = the file has an incremental update.
  const nStartXref = countOccurrences(str, 'startxref');
  const multipleRevisions = nStartXref > 1;
  push('multiple_revisions', multipleRevisions, 0.20,
    multipleRevisions ? `${nStartXref} PDF revisions embedded (an unmodified file has 1)` : 'single revision');

  // ModDate later than CreationDate by more than 10 minutes — a re-save.
  let modAfterCreation = false;
  if (creationDates.length && modDates.length) {
    const c = Math.min(...creationDates.map((d) => d.getTime()));
    const m = Math.max(...modDates.map((d) => d.getTime()));
    modAfterCreation = (m - c) > 10 * 60 * 1000;
  }
  push('mod_after_creation_10min', modAfterCreation, 0.10,
    modAfterCreation ? 'ModDate is more than 10 minutes after CreationDate' : 'ModDate is contemporaneous with CreationDate');

  // Future dates — a common tell of a fake statement.
  const now = Date.now();
  const futureDates = [...creationDates, ...modDates].filter((d) => d.getTime() > now + 24 * 3600 * 1000);
  push('future_dates', futureDates.length > 0, 0.20,
    futureDates.length ? `${futureDates.length} metadata date(s) in the future` : 'no future metadata dates');

  // Very-old CreationDate on a document meant to be recent — unusual for a fresh statement.
  const oldestCreation = creationDates.length ? Math.min(...creationDates.map((d) => d.getTime())) : null;
  const veryOld = oldestCreation && (now - oldestCreation) > 10 * 365 * 24 * 3600 * 1000;
  push('very_old_creation_date', veryOld, 0.05,
    veryOld ? `CreationDate is more than 10 years old (${new Date(oldestCreation).toISOString().slice(0, 10)})` : 'CreationDate within the last decade');

  // Suspicious payloads — JavaScript / Launch actions / embedded files (rare in mortgage docs).
  const hasJs = /\/JavaScript|\/JS(?![a-zA-Z])/.test(str);
  push('embedded_javascript', hasJs, 0.15,
    hasJs ? 'PDF carries embedded JavaScript (uncommon for mortgage docs)' : 'no embedded JavaScript');

  const hasLaunch = /\/Launch/.test(str);
  push('launch_action', hasLaunch, 0.20,
    hasLaunch ? 'PDF contains a Launch action (dangerous, uncommon)' : 'no Launch actions');

  // Font-subsetting/replacement — a re-authored text region often shows a font not
  // matching the surrounding text. Very rough: multiple `/Type/Font /Subtype/TrueType`
  // with DIFFERENT `/BaseFont` names in the same page stream can be a signal.
  // Simple heuristic: count DISTINCT /BaseFont values — many distinct fonts on a
  // supposed-plain document is suspicious.
  const baseFonts = new Set();
  const fontRe = /\/BaseFont\s*\/([A-Za-z0-9+_\-.]+)/g;
  let fm;
  while ((fm = fontRe.exec(str)) !== null) baseFonts.add(fm[1]);
  const manyFonts = baseFonts.size > 12;
  push('many_distinct_fonts', manyFonts, 0.10,
    manyFonts ? `${baseFonts.size} distinct fonts (a re-authored document often carries more fonts than the original)` : `${baseFonts.size} distinct fonts (typical)`);

  // Size vs page count — a scanned bank statement typically renders 200-800 KB/page.
  // An extremely small file with lots of pages is suspicious (heavily compressed text
  // that came from OCR + re-authoring).
  const pageCount = countOccurrences(str, '/Type/Page') + countOccurrences(str, '/Type /Page');
  const bytesPerPage = pageCount > 0 ? buffer.length / pageCount : null;
  const tinyPerPage = bytesPerPage != null && bytesPerPage < 15 * 1024 && pageCount >= 3;
  push('tiny_bytes_per_page', tinyPerPage, 0.10,
    tinyPerPage ? `${Math.round(bytesPerPage)} bytes/page across ${pageCount} pages (unusually small — often re-authored text)` : (pageCount ? `${Math.round(bytesPerPage || 0)} bytes/page across ${pageCount} pages` : 'page count not readable'));

  // Score = start at 1.0, subtract every suspicious signal's weight, add back legit_producer.
  let raw = 1.0;
  for (const s of signals) {
    if (s.present) raw += (s.weight < 0 ? s.weight : -s.weight);   // negative weight = boost (LEGIT); positive weight = penalty
  }
  const score = Math.max(0, Math.min(1, raw));
  const level = score >= 0.75 ? 'high' : (score >= 0.45 ? 'medium' : 'low');
  return { score, level, signals, meta: {
    producer: producers[0] || null, creator: creators[0] || null, author: authors[0] || null,
    creationDate: creationDates[0] ? creationDates[0].toISOString() : null,
    modDate: modDates[modDates.length - 1] ? modDates[modDates.length - 1].toISOString() : null,
    pageCount, revisions: nStartXref, distinctFonts: baseFonts.size,
  }, docType: opts.docType || null };
}

module.exports = { analyzePdf, _internals: { extractPdfMeta, parsePdfDate, countOccurrences } };
