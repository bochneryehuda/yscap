'use strict';
/**
 * LONG-TERM — Phase 2, half one: finding the loans.
 *
 * The plan's rule, and it is the whole reason this file is separate from the loan
 * read: **the pipeline is for DISCOVERY ONLY.**
 *
 *   It reads the Encompass Reporting Database, which LAGS a loan save, exposes only
 *   the fields an admin provisioned, and returns several computed `CX.*` fields as
 *   null that a full loan read populates. So it answers "which loans exist and which
 *   have changed", and nothing a decision depends on may be populated from it.
 *
 * PARSING RULES, all learned from the live probe on 2026-08-14 and each one a bug if
 * ignored:
 *
 *   · **Everything comes back as a STRING.** An amount is `"594211.0000"`; a date is
 *     US-locale `"8/14/2026 10:48:18 AM"`. Storing either verbatim into a numeric or
 *     a timestamp is a 22P02 at the far end of a long sync.
 *   · **A field the tenant does not populate is OMITTED from the map entirely**, not
 *     returned empty — so "absent" and "empty" must read the same, and neither may
 *     read as zero.
 *   · **v3's row key is `loanId`; v1's is `loanGuid`.** They are not the same
 *     contract. We use v3 because only v3 pages (`start` is silently ignored on v1,
 *     which returns page 0 forever — a sync built on v1 would re-read the first
 *     hundred loans until the end of time and report itself complete).
 *   · **A single-term filter must NOT carry `operator`** on v3; two or more MUST.
 *     The client already handles this, and this module does not second-guess it.
 *
 * READ-ONLY. Pipeline search is one of exactly two read-shaped POSTs the guarded
 * client allows; it mutates nothing.
 *
 * The parsing is PURE and exported, so the whole shape of a pipeline row can be
 * tested against the probe's own recorded payload with no network.
 */

const lazy = {
  get client() { return require('../encompass/client'); },
};

/**
 * The fields discovery asks for. Deliberately SMALL — enough to know a loan exists,
 * which folder it is in, whose it is, and whether it has changed since we last
 * looked. Everything a decision rests on comes from the per-loan read.
 */
const DISCOVERY_FIELDS = [
  'Loan.LoanNumber',
  'Loan.LoanFolder',
  'Loan.LoanAmount',
  'Loan.BorrowerName',
  'Loan.CurrentMilestoneName',
  'Fields.CoreMilestone',
  'Fields.LOID',
  'Loan.LastModified',
];

/**
 * TWO MORE FIELDS, ASKED FOR SEPARATELY, SO WE CAN TELL WHOSE LOAN THIS IS BEFORE
 * SPENDING A READ ON IT.
 *
 * Owner-directed 2026-08-23: *"make sure it's only gonna pull according to our rule:
 * only long-term files."* No folder separates the two products at the source, so the
 * only way to know is the PROGRAM (field 1401, `loanProgramName`, filled on 754 of
 * 772) or the TERM (field 4, `loanAmortizationTermMonths`, filled on 760) — which is
 * exactly what `product-term.classifyProduct` decides on.
 *
 * THEY ARE SEPARATE FROM THE LIST ABOVE BECAUSE THEY MUST BE ABLE TO FAIL. The list
 * above is proven against this tenant; these two are not, and the probe recorded that
 * an unknown field id "rejects the whole batch" (ENCOMPASS-LIVE-API-PROBE §2.3). A
 * rejected discovery is not a smaller sync — it is NO sync, the entire book gone from
 * every screen. So `discoverLoans` asks for them, and if the enriched request fails it
 * retries ONCE with the proven list and says so; the caller then knows it cannot tell
 * the products apart this pass and mirrors everything, exactly as it did before.
 */
const CLASSIFY_FIELDS = ['Fields.1401', 'Fields.4'];

/** The one place the discovery page size lives. */
const PAGE = 100;
// A runaway guard, not a limit: the long-term book is ~700 loans. Hitting it is
// REPORTED, never a silent short read.
const MAX_PAGES = 60;

/**
 * A US-locale pipeline date → an ISO instant.
 *
 * `"8/14/2026 10:48:18 AM"` is not something `new Date()` parses the same way
 * everywhere, so it is taken apart explicitly. Returns null on anything it cannot
 * read — a freshness stamp we cannot trust must be absent, never a guess, because
 * the sync pages on it and a wrong one silently skips loans.
 */
function parsePipelineDate(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i);
  if (!m) {
    // An ISO string is also plausible from a differently-configured tenant.
    const t = Date.parse(s);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  const [, mo, d, y, hh, mi, ss, ap] = m;
  let hour = hh == null ? 0 : Number(hh);
  if (ap) {
    const upper = ap.toUpperCase();
    if (upper === 'PM' && hour < 12) hour += 12;
    if (upper === 'AM' && hour === 12) hour = 0;
  }
  const dt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), hour, Number(mi || 0), Number(ss || 0)));
  return Number.isFinite(dt.getTime()) ? dt.toISOString() : null;
}

/**
 * A pipeline money string → a number.
 * Absent, empty and unreadable all answer null — NEVER 0, because a zero loan amount
 * is a fact and "we could not read it" is not.
 */
function parseAmount(v) {
  if (v == null) return null;
  const s = String(v).trim().replace(/[$,]/g, '');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Absent and empty read the same, and neither reads as a value. */
function str(v) {
  const s = String(v == null ? '' : v).trim().replace(/\s+/g, ' ');
  return s === '' ? null : s;
}

/**
 * One pipeline row → what discovery knows. `loanId` (v3) with `loanGuid` (v1) as a
 * fallback, so a tenant answering the older shape is not silently skipped.
 */
function rowToLoan(row) {
  const f = (row && row.fields) || {};
  const guid = String((row && (row.loanId || row.loanGuid)) || '').trim();
  if (!guid) return null;
  return {
    encompassLoanGuid: guid,
    loanNumber: str(f['Loan.LoanNumber']),
    loanFolder: str(f['Loan.LoanFolder']),
    loanAmount: parseAmount(f['Loan.LoanAmount']),
    borrowerName: str(f['Loan.BorrowerName']),
    milestoneName: str(f['Loan.CurrentMilestoneName']) || str(f['Fields.CoreMilestone']),
    loanOfficerLoginId: str(f['Fields.LOID']),
    lastModified: parsePipelineDate(f['Loan.LastModified']),
    // What `product-term` needs to say whose loan this is. Both are `null` when the
    // enrichment was refused, which reads as "we cannot tell" — never as "short-term".
    programName: str(f['Fields.1401']),
    termMonths: parseAmount(f['Fields.4']),
  };
}

/**
 * The filter. A loan amount over zero is the broadest thing the tenant will accept
 * (v3 requires SOME filter) and is a single term, so it deliberately carries no
 * `operator`. A folder narrows it when a caller asks — and then there are two terms,
 * which is exactly when `operator` becomes required; the client adds it.
 */
function buildFilter({ loanFolder } = {}) {
  const terms = [{ canonicalName: 'Loan.LoanAmount', matchType: 'greaterThan', value: 0 }];
  if (loanFolder) terms.push({ canonicalName: 'Loan.LoanFolder', matchType: 'exact', value: String(loanFolder) });
  return { terms };
}

/**
 * Page the whole book. READ-ONLY.
 *
 * Returns `{loans, pages, truncated}`. `truncated` says the cap was reached, so a
 * caller reports a partial sweep as partial instead of as a shrinking pipeline.
 */
async function discoverLoans({ loanFolder = null, limit = PAGE, maxPages = MAX_PAGES } = {}) {
  // THE FIRST PAGE DECIDES WHETHER THE ENRICHED READ IS SAFE, and it is asked for
  // separately from the loop so a refusal costs ONE call rather than a whole sweep.
  // If Encompass will not answer with the two classifying fields, we fall back to the
  // proven list and REPORT it — the caller then knows it cannot tell the two products
  // apart this pass, and mirrors everything rather than guessing.
  let fields = [...DISCOVERY_FIELDS, ...CLASSIFY_FIELDS];
  let classifyFields = 'asked';
  const request = {
    fields,
    filter: buildFilter({ loanFolder }),
    sortOrder: [{ canonicalName: 'Loan.LastModified', order: 'Descending' }],
  };

  const loans = [];
  const seen = new Set();
  let start = 0;
  let pages = 0;
  let truncated = false;

  for (;;) {
    if (pages >= maxPages) { truncated = true; break; }
    let body;
    try {
      body = await lazy.client.pipelineSearch(request, { limit, start });
      if (classifyFields === 'asked') classifyFields = 'answered';
    } catch (e) {
      // Only ever retried ONCE, and only for the enrichment. A failure after the
      // fallback is a real failure and is thrown to the caller as before — a sync
      // that silently reported an empty book would be far worse than one that stops.
      if (classifyFields !== 'asked') throw e;
      classifyFields = 'refused';
      fields = [...DISCOVERY_FIELDS];
      request.fields = fields;
      body = await lazy.client.pipelineSearch(request, { limit, start });
    }
    const batch = Array.isArray(body) ? body : (body && Array.isArray(body.loans) ? body.loans : []);
    pages += 1;
    for (const r of batch) {
      const loan = rowToLoan(r);
      // The sort is by LastModified, which MOVES WHILE WE PAGE — a loan saved
      // mid-sweep can reappear on a later page. De-duplicating by guid is what
      // stops one loan being written twice in a pass.
      if (loan && !seen.has(loan.encompassLoanGuid)) {
        seen.add(loan.encompassLoanGuid);
        loans.push(loan);
      }
    }
    if (batch.length < limit) break;
    start += batch.length;
  }

  // `classifyFields` is what the caller reads to decide whether it may act on the
  // product rule at all. 'refused' means every loan comes back unclassifiable, which
  // must read as "mirror it" and never as "it is short-term".
  return { loans, pages, truncated, classifyFields };
}

module.exports = {
  DISCOVERY_FIELDS,
  CLASSIFY_FIELDS,
  PAGE,
  MAX_PAGES,
  parsePipelineDate,
  parseAmount,
  rowToLoan,
  buildFilter,
  discoverLoans,
  _internals: { str },
};
