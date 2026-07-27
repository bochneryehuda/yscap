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

async function listCustomFields() { return encompass.apiGet('/encompass/v3/settings/loan/customFields'); }
async function listStandardFields() { return encompass.apiGet('/encompass/v3/settings/loan/standardFields'); }
async function listFieldEnums() { return encompass.apiGet('/encompass/v3/settings/loan/enums'); }
async function listMilestoneCatalog() { return encompass.apiGet('/encompass/v3/settings/loan/milestones'); }
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
