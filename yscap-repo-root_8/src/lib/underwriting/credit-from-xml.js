'use strict';
/**
 * credit-from-xml — convert a PARSED credit-report XML (the credit/parse.js output stored in
 * credit_reports.parsed) into the field shape computeCreditFindings expects.
 *
 * WHY (owner 2026-07-27: "we have an XML for the credit report — you need to learn how to understand
 * XML so you have all the detailed information"). The credit XML is parsed on IMPORT and stored in
 * credit_reports, but the underwriting findings desk only ever read the AI extraction of the PDF — so
 * it said "the credit report could not be read with confidence" and "recent mortgage lates" with no
 * breakdown, even though a fully parsed report was sitting on the file. This bridge lets the desk read
 * the XML: it is authoritative (structured data), so when a completed parse exists it is preferred
 * over the AI read of the same report.
 *
 * PURE. Never throws. Missing pieces degrade honestly — e.g. the XML carries late COUNTS and the
 * last-reported date but not the month-by-month grid, so `mostRecentLate` stays null and the finding
 * then names the grid to read by hand instead of passing off the last-reported date as the late month.
 */

const MORTGAGE_RE = /mortg|real\s*estate|realestate|heloc|home\s*equity/i;

function n(v) { const x = Number(v); return Number.isFinite(x) ? x : 0; }
function last4(s) { const d = String(s == null ? '' : s).replace(/[^0-9A-Za-z]/g, ''); return d ? d.slice(-4) : null; }

/**
 * @param {object} parsed — parseCreditXml() output (credit_reports.parsed)
 * @returns {object|null} the computeCreditFindings input `c`, or null when there is nothing readable
 *   in the XML (so the caller keeps the AI read / an honest "unreadable").
 */
function creditFieldsFromParsed(parsed) {
  if (!parsed || typeof parsed !== 'object' || parsed.parseError) return null;
  const liabilities = Array.isArray(parsed.liabilities) ? parsed.liabilities : [];
  const scores = Array.isArray(parsed.scores) ? parsed.scores : [];
  // Nothing structured to read → don't claim the XML is readable (let the caller's AI read stand).
  if (!liabilities.length && parsed.middleScore == null && !scores.length) return null;

  const b = parsed.borrower || {};
  const subjectName = ([b.firstName, b.lastName].filter(Boolean).join(' ').trim())
    || (b.name ? String(b.name).trim() : '') || null;

  // Per-bureau scores → the exact fields representativeFico reads; middleScore is the fallback.
  const scoreOf = (re) => {
    const s = scores.find((x) => x && re.test(String(x.bureau || x.repository || x.source || '')));
    const v = s ? Number(s.value != null ? s.value : s.score) : null;
    return Number.isFinite(v) && v > 0 ? v : null;
  };

  const mortgages = liabilities.filter((l) => l && MORTGAGE_RE.test(String(l.accountType || '')));
  const lateMortgages = mortgages.filter((l) => n(l.late30) + n(l.late60) + n(l.late90) > 0);
  const mortgageLateDetails = lateMortgages.map((l) => ({
    creditorName: l.creditor || null,
    accountLast4: last4(l.accountNumberMasked),
    count30: n(l.late30), count60: n(l.late60), count90: n(l.late90),
    worstLate: n(l.late90) > 0 ? '90' : (n(l.late60) > 0 ? '60' : '30'),
    // The XML has late COUNTS + the last-reported date, not the month-by-month grid — so the exact
    // most-recent-late MONTH is not in it. null → the finding names the payment grid to read by hand.
    mostRecentLate: null,
    page: null,
  }));

  const prTypes = (Array.isArray(parsed.publicRecords) ? parsed.publicRecords : [])
    .map((p) => String((p && p.type) || '')).join(' | ');
  const derog = liabilities.map((l) => String((l && (l.status || l.currentRating)) || '')).join(' | ');
  const hasBankruptcy = /bankrupt/i.test(prTypes) || /bankrupt/i.test(derog);
  const hasForeclosure = /foreclos|deed.?in.?lieu/i.test(prTypes) || /foreclos|deed.?in.?lieu/i.test(derog);
  const hasJudgmentOrLien = /judg|lien/i.test(prTypes);

  return {
    readable: true,
    subjectName,
    ficoScore: parsed.middleScore != null && Number.isFinite(Number(parsed.middleScore)) ? Number(parsed.middleScore) : null,
    ficoTransunion: scoreOf(/trans|(^|[^a-z])tu([^a-z]|$)/i),
    ficoExperian: scoreOf(/experian|(^|[^a-z])xpn?([^a-z]|$)/i),
    ficoEquifax: scoreOf(/equifax|(^|[^a-z])efx?([^a-z]|$)/i),
    mortgageLates: lateMortgages.length > 0,
    mortgageLateDetails,
    // `=== true` gates in the check → undefined leaves them false; only a real positive fires.
    hasBankruptcy: hasBankruptcy || undefined,
    hasForeclosure: hasForeclosure || undefined,
    hasJudgmentOrLien: hasJudgmentOrLien || undefined,
    _source: 'credit_xml',
  };
}

module.exports = { creditFieldsFromParsed, _internals: { MORTGAGE_RE } };
