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

// ── Loan reads ─────────────────────────────────────────────────────────────

// Passthrough to the low-level guarded pipeline-search POST. The bulk-pull
// job uses this directly to page through the whole tenant with a custom
// {filter, fields, limit}; the convenience wrapper `findLoanByLoanNumber`
// below is for the common by-loan-number lookup.
const pipelineSearch = encompass.pipelineSearch;

// Full raw loan by opaque Encompass GUID. The GUID is the join key we cache in
// applications.encompass_loan_guid so subsequent pulls skip the pipeline search.
async function getLoan(guid, { entities } = {}) {
  if (!guid) throw new Error('getLoan: guid is required.');
  const qs = entities && entities.length ? `?entities=${encodeURIComponent(entities.join(','))}` : '';
  return encompass.apiGet(`/encompass/v3/loans/${encodeURIComponent(guid)}${qs}`);
}

// Pipeline SEARCH by loan number. Returns [{loanGuid, fields:{...}}, ...].
// The one and only way to find a loan without knowing its GUID up front.
async function findLoanByLoanNumber(loanNumber, { extraFields } = {}) {
  if (!loanNumber) throw new Error('findLoanByLoanNumber: loanNumber is required.');
  const filter = {
    terms: [
      { canonicalName: 'Loan.LoanNumber', value: String(loanNumber), matchType: 'exact' },
    ],
  };
  const fields = ['Loan.Guid', 'Loan.LoanNumber', 'Loan.LoanFolder', 'Loan.LastModified', ...(extraFields || [])];
  const rows = await encompass.pipelineSearch(filter, fields, { limit: 5 });
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
