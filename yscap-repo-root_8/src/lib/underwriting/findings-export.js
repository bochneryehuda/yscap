'use strict';
/**
 * R6.16 (findings-export half) — Whole-loan findings EXPORT serializer
 * (deterministic core, ADVISORY / presentational).
 *
 * decision.decide() (R6.14) produces the final status, the term-sheet / CTC /
 * funding gates, and a consolidated finding registry (R6.9). The file-view
 * "export findings" action needs that turned into a portable artifact — a CSV an
 * underwriter or examiner can open in a spreadsheet, plus a structured row list a
 * caller can render or attach. This is that serializer: it flattens the findings
 * into stable columns, escapes them safely for CSV (a comma / quote / newline in
 * a finding title can't break the file), and prepends a one-line decision summary.
 *
 * A `borrowerSafe` option scrubs every note-buyer / capital-partner name out of
 * the free-form title/explanation (CLAUDE.md hard rule) for a borrower-shareable
 * copy; the default staff export keeps the full detail.
 *
 * PURE: no DB, no AI, no I/O. It SERIALIZES an already-computed decision; it
 * decides nothing, changes no status, exports nothing itself (the caller writes
 * the file / streams the download). Advisory / presentational. NEVER THROWS —
 * hostile input degrades to an empty-but-valid export.
 */

// Stable export columns, in order. Header labels are human-friendly.
const COLUMNS = Object.freeze([
  { key: 'code', label: 'Code' },
  { key: 'severity', label: 'Severity' },
  { key: 'category', label: 'Category' },
  { key: 'title', label: 'Finding' },
  { key: 'explanation', label: 'Detail' },
  { key: 'sources', label: 'Sources' },
  { key: 'blocks_term_sheet', label: 'Blocks term sheet' },
  { key: 'blocks_ctc', label: 'Blocks CTC' },
  { key: 'blocks_funding', label: 'Blocks funding' },
  { key: 'evidence_count', label: 'Evidence items' },
]);

let _scrubText = null;
try { _scrubText = require('../borrower-safe').scrubText; } catch (_e) { _scrubText = null; }
function scrub(s, on) { try { return on && _scrubText && typeof s === 'string' ? _scrubText(s) : s; } catch (_e) { return s; } }

function str(v) {
  try {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) return v.map((x) => (x == null ? '' : String(x))).join('; ');
    return '';
  } catch (_e) { return ''; }
}
function arr(v) { try { return Array.isArray(v) ? v : []; } catch (_e) { return []; } }
function boolCell(v) { try { return v === true ? 'yes' : 'no'; } catch (_e) { return 'no'; } }

// CSV-escape one field: wrap in quotes and double internal quotes when the value
// contains a comma, quote, CR or LF (so a finding title can never break a row).
function csvEscape(v) {
  try {
    let s = str(v);
    // strip a leading =/+/-/@ so a spreadsheet doesn't interpret the cell as a
    // formula (CSV-injection safety), keeping the visible text intact.
    if (/^[=+\-@]/.test(s)) s = "'" + s;
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  } catch (_e) { return ''; }
}

/**
 * findingRows(decision, opts?) → [{ code, severity, category, title, explanation,
 *   sources, blocks_term_sheet, blocks_ctc, blocks_funding, evidence_count }]
 *   decision: a decision.decide() result (uses .registry, else .blockingFindings, else .findings)
 *   opts: { borrowerSafe?, onlyBlocking? }
 * NEVER THROWS.
 */
function findingRows(decision, opts = {}) {
  try {
    const d = decision && typeof decision === 'object' ? decision : {};
    const borrowerSafe = !!(opts && opts.borrowerSafe);
    const onlyBlocking = !!(opts && opts.onlyBlocking);
    let list = arr(d.registry);
    if (!list.length) list = arr(d.blockingFindings);
    if (!list.length) list = arr(d.findings);
    const rows = list.map((f) => rowOf(f, borrowerSafe)).filter(Boolean);
    if (onlyBlocking) return rows.filter((r) => r.blocks_term_sheet === true || r.blocks_ctc === true || r.blocks_funding === true || sevRank(r.severity) === 0);
    return rows;
  } catch (_e) { return []; }
}
const FATAL = new Set(['fatal', 'hard_stop', 'blocking']);
function sevRank(s) { return FATAL.has(String(s == null ? '' : s).toLowerCase()) ? 0 : 1; }

function rowOf(f, borrowerSafe) {
  try {
    const ff = f || {};
    // A finding title / explanation is FREE-FORM, partner-authorable text; a
    // note-buyer name in it can be ANY string, and scrubText only knows a fixed
    // list. So on a borrower-shareable export we NEVER emit the raw text — the
    // title becomes a generic placeholder and the explanation is blanked (the
    // borrower still sees the neutral severity/category). Staff export keeps the
    // full detail. (Same rule as decision-explainer.js.)
    const title = borrowerSafe ? 'An item needs attention' : (str(ff.title) || str(ff.message) || '');
    const explanation = borrowerSafe ? '' : (str(ff.explanation) || str(ff.detail) || '');
    return {
      code: borrowerSafe ? null : (str(ff.code) || str(ff.id) || null),
      severity: (str(ff.severity) || 'unknown').toLowerCase(),
      category: str(ff.category) || null,
      title,
      explanation,
      // internal source labels are staff-only too
      sources: borrowerSafe ? '' : arr(ff.sources).map(String).join('; '),
      blocks_term_sheet: ff.blocks_term_sheet === true,
      blocks_ctc: ff.blocks_ctc === true,
      blocks_funding: ff.blocks_funding === true,
      evidence_count: arr(ff.evidence).length,
    };
  } catch (_e) { return null; }
}

/**
 * toCSV(decision, opts?) → a CSV string: a "# summary" comment line (status +
 * gate eligibility), then a header row, then one row per finding. Safe to write
 * directly to a .csv. NEVER THROWS (returns at least the header).
 */
function toCSV(decision, opts = {}) {
  try {
    const rows = findingRows(decision, opts);
    const d = decision && typeof decision === 'object' ? decision : {};
    const header = COLUMNS.map((c) => csvEscape(c.label)).join(',');
    const summary = summaryLine(d);
    const body = rows.map((r) => COLUMNS.map((c) => {
      const v = r[c.key];
      return csvEscape(typeof v === 'boolean' ? boolCell(v) : v);
    }).join(','));
    return [summary, header, ...body].join('\r\n');
  } catch (_e) {
    return '# export failed\r\n' + COLUMNS.map((c) => csvEscape(c.label)).join(',');
  }
}
function summaryLine(d) {
  try {
    const status = str(d.status) || 'unknown';
    const g = (k1, k2) => (d[k1] === true || d[k2] === true) ? 'yes' : 'no';
    // a leading "#" comment line most CSV readers ignore or show as a note.
    return `# status=${status}; term_sheet=${g('termSheetEligible', 'term_sheet_eligible')}; ctc=${g('ctcEligible', 'ctc_eligible')}; funding=${g('fundingEligible', 'funding_eligible')}`;
  } catch (_e) { return '# status=unknown'; }
}

/**
 * toExport(decision, opts?) → {
 *   status, gates:{ term_sheet, ctc, funding },
 *   columns:[{key,label}], rows:[...], csv, counts:{ total, blocking, fatal }
 * }
 * The one call a route uses to build the download + a JSON preview. NEVER THROWS.
 */
function toExport(decision, opts = {}) {
  try {
    const d = decision && typeof decision === 'object' ? decision : {};
    const rows = findingRows(decision, opts);
    const fatal = rows.filter((r) => sevRank(r.severity) === 0).length;
    const blocking = rows.filter((r) => r.blocks_term_sheet || r.blocks_ctc || r.blocks_funding).length;
    return {
      status: str(d.status) || null,
      gates: {
        term_sheet: d.termSheetEligible === true || d.term_sheet_eligible === true,
        ctc: d.ctcEligible === true || d.ctc_eligible === true,
        funding: d.fundingEligible === true || d.funding_eligible === true,
      },
      columns: COLUMNS.map((c) => ({ key: c.key, label: c.label })),
      rows,
      csv: toCSV(decision, opts),
      counts: { total: rows.length, blocking, fatal },
    };
  } catch (_e) {
    return { status: null, gates: { term_sheet: false, ctc: false, funding: false }, columns: COLUMNS.map((c) => ({ key: c.key, label: c.label })), rows: [], csv: toCSV(null), counts: { total: 0, blocking: 0, fatal: 0 } };
  }
}

module.exports = {
  findingRows,
  toCSV,
  toExport,
  COLUMNS,
  _internals: { csvEscape, rowOf, summaryLine, sevRank },
};
