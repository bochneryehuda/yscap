'use strict';
/**
 * src/encompass/client.js — Thin, read-only convenience wrappers over the
 * OAuth client at src/lib/integrations/encompass.js.
 *
 * Everything here is READ-ONLY per the freeze rule (CLAUDE.md + the header of
 * lib/integrations/encompass.js). No POST/PATCH/PUT/DELETE against loan or
 * milestone or eFolder resources. The only POSTs in the whole stack are the
 * two hard-coded allowlist entries (`/oauth2/v1/token` + `/encompass/v3/loanPipeline`)
 * enforced structurally in the lower client.
 *
 * The wrappers here don't add smarts on top of the client — they add convenience
 * (typed helpers, defaults, resilience to trivial shape variations). Every call
 * path lands on `encompass.apiGet(...)` or `encompass.pipelineSearch(...)` so the
 * READ-ONLY guard's coverage is total.
 */

const encompass = require('../lib/integrations/encompass');
const fieldMap = require('../lib/integrations/encompass-field-map');

// ── Loan reads ─────────────────────────────────────────────────────────────

// Passthrough to the low-level guarded pipeline-search POST. The bulk-pull
// job uses this directly to page through the whole tenant with a custom
// {filter, fields, limit}; the convenience wrapper `findLoanByLoanNumber`
// below is for the common by-loan-number lookup.
const pipelineSearch = encompass.pipelineSearch;

// Full raw loan by opaque Encompass GUID. The GUID is the join key we cache in
// applications.encompass_loan_guid so subsequent pulls skip the pipeline search.
// Read a loan's values BY FIELD NUMBER (read-only; owner sign-off 2026-07-26).
// Returns a flat { fieldId: value } map, normalized from whichever wire shape the
// tenant's fieldReader returns — an OBJECT map on v3 or an ARRAY of { fieldId, value }
// pairs on v1 / ICE's own SDK type (fieldReaderToMap handles both).
//
// RESILIENCE (ICE 24.2): Encompass v3 FAILS THE WHOLE call with HTTP 400 if ANY single
// field id is invalid/unpermitted for the tenant. One bad id among the ~40 we request
// would otherwise blank EVERY authoritative value and silently drop the panel back to
// guessed JSON paths (the exact class of bug that hid the LLC + origination fee). So on
// a batch failure we split the id list and retry the halves, merging what succeeds — a
// single bad id then costs only itself and the good fields still come through. Only the
// failure path fans out; recursion floors at one id. A TOTAL failure (network / auth /
// scope — both halves empty) is re-thrown so the caller degrades visibly.
async function readFields(guid, ids) {
  if (!guid) throw new Error('readFields: guid is required.');
  const list = (Array.isArray(ids) ? ids : []).map((x) => String(x)).filter(Boolean);
  if (!list.length) return {};
  try {
    return fieldMap.fieldReaderToMap(await encompass.fieldReader(guid, list));
  } catch (e) {
    // Split ONLY on an invalid-field 400 — the one error that is per-id (ICE 24.2 fails
    // the WHOLE batch if any single id is invalid/unpermitted). A network / auth /
    // timeout / 404 is NOT per-id, so re-issuing halves would just fan the same doomed
    // request out ~2N times and hammer the API during an outage — surface it at once.
    if (list.length <= 1 || !_isInvalidFieldError(e)) throw e;
    const mid = Math.floor(list.length / 2);
    const [a, b] = await Promise.all([
      readFields(guid, list.slice(0, mid)).catch(() => ({})),
      readFields(guid, list.slice(mid)).catch(() => ({})),
    ]);
    const merged = Object.assign({}, a, b);
    if (!Object.keys(merged).length) throw e;      // nothing isolated — surface the error
    return merged;
  }
}

// A fieldReader HTTP 400 means a requested field id is invalid/unpermitted for the
// tenant (ICE 24.2 fails the entire batch). That is the ONLY error worth isolating by
// splitting the id list; every other failure (network / 401 / 403 / 404 / timeout) is
// not per-id and must never trigger a retry fan-out.
function _isInvalidFieldError(e) {
  // Anchor on the message PREFIX (encompass.fieldReader throws
  // `Encompass fieldReader <status>: <body>`) so a non-400 response whose BODY merely
  // contains the text "fieldReader 400" can never be mistaken for an invalid-field 400.
  return /^Encompass fieldReader 400\b/.test(String((e && e.message) || ''));
}

async function getLoan(guid, { entities } = {}) {
  if (!guid) throw new Error('getLoan: guid is required.');
  const qs = entities && entities.length ? `?entities=${encodeURIComponent(entities.join(','))}` : '';
  return encompass.apiGet(`/encompass/v3/loans/${encodeURIComponent(guid)}${qs}`);
}

// Pipeline SEARCH by loan number. Encompass Developer Connect v3 returns each row
// as [{loanId:"<GUID>", fields:{"Loan.Guid":..., "Loan.LoanNumber":...}}, ...] —
// the GUID is `loanId` (NOT `loanGuid`) and field values are NESTED under `fields`.
// reader.js reads it via its shape-tolerant row accessors (`_rowGuid`/`_rowField`).
// The one and only way to find a loan without knowing its GUID up front.
async function findLoanByLoanNumber(loanNumber, { extraFields } = {}) {
  if (!loanNumber) throw new Error('findLoanByLoanNumber: loanNumber is required.');
  const rows = await encompass.pipelineSearch({
    // Single-term SIMPLE filter form ({canonicalName,value,matchType}) — NOT the
    // complex {operator,terms:[...]} form. Encompass REFUSES a complex filter that
    // carries an `operator` with only one term ("If only one filter term is supplied
    // in the list 'Terms', 'Operator' does not apply." — live 400, 2026-07-26), which
    // is why the by-loan-number lookup never matched even for files WITH a loan number.
    // matchType is PascalCase 'Exact' to match the tenant's proven casing convention
    // (cf. the live-diagnosed MATCH_ALL_FILTER 'GreaterThan' in reader.js).
    filter: { canonicalName: 'Loan.LoanNumber', value: String(loanNumber), matchType: 'Exact' },
    fields: ['Loan.Guid', 'Loan.LoanNumber', 'Loan.LoanFolder', 'Loan.LastModified', ...(extraFields || [])],
  }, { limit: 5 });
  return Array.isArray(rows) ? rows : [];
}

// Milestones on a loan (Started, Processing, Approval, Docs Signing, Funding, ...).
async function getMilestones(guid) {
  if (!guid) throw new Error('getMilestones: guid is required.');
  return encompass.apiGet(`/encompass/v3/loans/${encodeURIComponent(guid)}/milestones`);
}

// The tenant's Milestone LOG (LOG.MS.Date.* + status transitions).
async function getMilestoneLog(guid) {
  if (!guid) throw new Error('getMilestoneLog: guid is required.');
  return encompass.apiGet(`/encompass/v3/loans/${encodeURIComponent(guid)}/logs/milestoneLogs`);
}

// ── Settings / field metadata (tenant-specific catalog) ────────────────────
// These endpoints return the tenant's OWN field catalog — the custom-field names,
// the picklist labels, the milestone list, the folder list. Pulled nightly by
// the worker into `encompass_field_catalog` so we can verify the mapping doc.

// ── THE PATHS THAT MOVED, AND HOW WE KNOW ─────────────────────────────────
//
// MEASURED IN PRODUCTION 2026-08-25: the nightly refresh reported
//   {"customField":857,"standardField":0,"enum":0,"milestone":0,"folder":0,
//    "loanTemplate":0,"errors":{... all five "Encompass 403: "}}
// — five of the six catalog reads were being REFUSED, and had been for as long
// as anyone had looked. Only the custom fields were arriving.
//
// TWO OF THE FIVE HAVE A CORRECTION THAT WAS VERIFIED AGAINST THIS TENANT, and
// they are the two changed here. The Long-Term audit (2026-08-14) probed both
// live and recorded the result in `src/longterm/encompass/requests.js`:
//
//   · standard fields — `/v3/settings/loan/standardFields` 403 →
//                       `/v3/schemas/loan/standardFields` 200 (23,704 fields)
//   · milestones      — `/v3/settings/loan/milestones`     403 →
//                       `/v3/settings/milestones`          200 (the 19-row catalog)
//
// THE OTHER THREE ARE LEFT EXACTLY AS THEY ARE, and that is deliberate. That same
// audit says of the enums, folders and templates: *"RTL reads these; the audit did
// not re-verify their current paths. Confirm against Developer Connect before
// use."* A path nobody has probed is a guess, and guessing at Encompass is the one
// thing this integration may never do — a wrong path that happens to answer is far
// worse than a 403 that says so. They keep failing, loudly, in the summary, until
// somebody probes them.
//
// Everything here is still a GET over the read-only client.

async function listCustomFields() { return encompass.apiGet('/encompass/v3/settings/loan/customFields'); }

/**
 * The tenant's standard-field catalog — PAGED, because there are ~23,700 of them
 * and one call returns one page.
 *
 * NO SILENT CAPS. The page walk stops at `ENCOMPASS_STANDARD_FIELD_MAX` (default
 * 5,000) so the first night after this fix cannot spend hours of the shared rate
 * limit, and it SAYS SO on the way out rather than quietly reporting a round
 * number as though it were the whole catalog. Raise the ceiling to take more.
 */
async function listStandardFields() {
  const PAGE = 100;
  const max = Math.max(PAGE, Number(process.env.ENCOMPASS_STANDARD_FIELD_MAX || 5000) || 5000);
  const out = [];
  let start = 0;
  for (;;) {
    const qs = new URLSearchParams({ start: String(start), limit: String(PAGE) });
    const body = await encompass.apiGet(`/encompass/v3/schemas/loan/standardFields?${qs.toString()}`);
    const batch = Array.isArray(body) ? body : (body && Array.isArray(body.items) ? body.items : []);
    out.push(...batch);
    // A short page is the end of the catalog; a full one only means there may be more.
    if (batch.length < PAGE) break;
    start += PAGE;
    if (out.length >= max) {
      console.warn(`[encompass] standard-field catalog capped at ${out.length} of a larger catalog `
        + '— raise ENCOMPASS_STANDARD_FIELD_MAX to take more');
      break;
    }
  }
  return out;
}

async function listFieldEnums() { return encompass.apiGet('/encompass/v3/settings/loan/enums'); }
async function listMilestoneCatalog() {
  const qs = new URLSearchParams({ includeArchived: 'false', view: 'Detail', start: '0', limit: '100' });
  return encompass.apiGet(`/encompass/v3/settings/milestones?${qs.toString()}`);
}
async function listLoanFolders() { return encompass.apiGet('/encompass/v3/settings/loan/folders'); }
async function listLoanTemplates() { return encompass.apiGet('/encompass/v3/settings/loan/loanTemplates'); }

// Ping + config passthroughs so consumers don't need two imports.
const configured = encompass.configured;
const ping = encompass.ping;
const READ_ONLY = encompass.READ_ONLY;


module.exports = {
  READ_ONLY,
  configured,
  ping,
  // Loan reads
  pipelineSearch,        // the raw guarded pipeline-search POST (used by the bulk-pull job)
  getLoan,
  readFields,
  findLoanByLoanNumber,  // convenience: pipeline-search by loan number
  getMilestones,
  getMilestoneLog,
  // Settings / field catalog reads
  listCustomFields,
  listStandardFields,
  listFieldEnums,
  listMilestoneCatalog,
  listLoanFolders,
  listLoanTemplates,
};
