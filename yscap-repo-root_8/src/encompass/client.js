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

/**
 * EVERY ADDRESS BELOW WAS ASKED OF THE LIVE TENANT ON 2026-08-25 AND THE STATUS IT
 * ANSWERED WITH IS WRITTEN BESIDE IT.
 *
 * The nightly catalog refresh had been reporting five of these six refused with 403
 * for long enough that it read as a permissions problem — the API user simply not
 * being allowed to see the tenant's own field catalog. It was not. Five of the six
 * addresses had MOVED, and the 403 is what this instance answers for a path that is
 * not there. The owner said so plainly and was right: *"you actually independently
 * accessed all those fields in the past through this same integration, same
 * credentials."*
 *
 * These are not adopted on the strength of research. Each was asked through
 * `GET /api/lt/_diag/book/catalog-probe`, from the server that already holds the
 * login, with the address in use asked FIRST so the comparison is measured rather
 * than assumed:
 *
 *     kind            was                                    now                                    result
 *     customField     /v3/settings/loan/customFields          (unchanged)                            200, 857 rows
 *     standardField   /v3/settings/loan/standardFields  403   /v3/schemas/loan/standardFields        200, 10,000 rows
 *     milestone       /v3/settings/loan/milestones      403   /v3/settings/milestones                200
 *     enum            /v3/settings/loan/enums           403   /v1/loanPipeline/fieldDefinitions      200
 *     folder          /v3/settings/loan/folders         403   /v1/loanFolders                        200, 22 folders
 *     loanTemplate    /v3/settings/loan/loanTemplates   403   — still unknown —                      see below
 *
 * The key names each answer carries were measured too, because a 200 that the reader
 * cannot key is the same as a 403 with extra steps. `refreshFieldCatalog`'s existing
 * key functions all resolve against what came back — standardFields answer with `id`
 * (third in that chain), folders with `name` (second) — so none of them needed
 * changing, and none were changed on a guess.
 */
async function listCustomFields() { return encompass.apiGet('/encompass/v3/settings/loan/customFields'); }

/**
 * PAGED, AND THE PAGE SIZE IS MEASURED RATHER THAN GUESSED. The probe asked for
 * 10,000 in a single call and got 10,000 rows back, so the tenant's ~23,700-field
 * catalog is three calls rather than the fifty a 500-row default would cost. Asked at
 * 1,000 first, deliberately, so that a page coming back empty-handed could be told
 * apart from our own fifteen-second client timeout — both answered, so the size is
 * the vendor's answer and not our clock.
 */
async function listStandardFields() {
  const limit = Math.max(1, parseInt(process.env.ENCOMPASS_STANDARD_FIELD_PAGE || '10000', 10) || 10000);
  const max = Math.max(limit, parseInt(process.env.ENCOMPASS_STANDARD_FIELD_MAX || '40000', 10) || 40000);
  const out = [];
  for (let start = 0; start < max; start += limit) {
    const page = await encompass.apiGet(`/encompass/v3/schemas/loan/standardFields?start=${start}&limit=${limit}`);
    const rows = Array.isArray(page) ? page : (page && Array.isArray(page.items) ? page.items : []);
    out.push(...rows);
    // A short page is the last page. Stopping on it is what keeps this three calls
    // rather than four, and what stops it looping if `max` is ever raised.
    if (rows.length < limit) break;
  }
  return out;
}

/**
 * THE ENUM ENDPOINT DOES NOT EXIST, AND SAYING SO IS THE HONEST ANSWER.
 *
 * `/v3/settings/loan/enums` is 403 here, and there is no enum endpoint anywhere in
 * ICE's own 800-request Developer Connect collection under any name. What this tenant
 * DOES publish is the pipeline's field definitions, and that payload is where its
 * picklists live. Measured, and recorded in `docs/longterm/ENCOMPASS-LIVE-API-PROBE.md`
 * §10.1: 200, `{ pipelineLoanReportFieldDefs: [ … ] }`, 3,159 entries, ~4 MB, of which
 * **790 carry a dropdown option list**.
 *
 * THREE THINGS ABOUT THAT PAYLOAD WOULD EACH HAVE SILENTLY STORED NOTHING, and all
 * three are handled here rather than in `reader.js` — the reader's job is to store
 * rows, and the shape of one vendor's answer is this client's business:
 *
 *   1. IT IS AN OBJECT, not a list. `refreshFieldCatalog` understands an array or
 *      `{items:[…]}` and nothing else, so the rows are lifted out by name here.
 *   2. THE KEY IS `fieldID`, WITH A CAPITAL D. The reader's key function asks for
 *      `r.fieldId`, which is a different string — every row would have keyed to
 *      `undefined`, hit the reader's `if (!key) continue`, and been dropped. The
 *      catalog would have reported success and stored zero enums.
 *   3. THE OPTIONS ARE THREE LEVELS DOWN, at `fieldDefinition.fieldOptions.options`,
 *      while the reader looks for `raw.options`. Same silent outcome: rows stored
 *      with no options, which is an enum catalog with no enums in it.
 *
 * SO IT RETURNS ONLY THE FIELDS THAT ACTUALLY HAVE A PICKLIST, in the shape the
 * reader already reads. `requireValueFromList` is the vendor's own authoritative
 * "is this an enum" flag; an option list without it is still returned, because a
 * field offering choices is a picklist whatever the flag says, and dropping 700-odd
 * of them to honour a boolean would lose the very thing this call is for.
 */
async function listFieldEnums() {
  const body = await encompass.apiGet('/encompass/v1/loanPipeline/fieldDefinitions');
  const rows = Array.isArray(body)
    ? body
    : (body && Array.isArray(body.pipelineLoanReportFieldDefs) ? body.pipelineLoanReportFieldDefs
      : (body && Array.isArray(body.items) ? body.items : []));

  const out = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const def = r.fieldDefinition && typeof r.fieldDefinition === 'object' ? r.fieldDefinition : {};
    const opts = def.fieldOptions && Array.isArray(def.fieldOptions.options) ? def.fieldOptions.options : null;
    if (!opts || !opts.length) continue;
    // Normalised to what `reader.js` already reads — `fieldId`, `description`,
    // `options` — so the catalog needs no special case for this vendor's spelling.
    out.push({
      fieldId: String(r.fieldID || def.fieldID || r.fieldId || '').trim(),
      description: r.description || r.name || def.description || null,
      requireValueFromList: def.fieldOptions.requireValueFromList === true,
      options: opts,
    });
  }
  return out.filter((r) => r.fieldId);
}

async function listMilestoneCatalog() { return encompass.apiGet('/encompass/v3/settings/milestones'); }
async function listLoanFolders() { return encompass.apiGet('/encompass/v1/loanFolders'); }

/**
 * STILL UNRESOLVED, AND LEFT POINTING AT THE ADDRESS WE KNOW RATHER THAN A GUESS.
 *
 * `/v3/settings/loan/loanTemplates` is 403. The one candidate the research turned up,
 * `/v3/settings/templates/loanTemplateSet/folders`, answers 400 — but with an
 * instruction rather than a refusal: *"Folder path is empty. Default parent directory
 * should start with public or personal."* That is a lead, not an answer, and it is
 * being followed by probe rather than by guess. Until one of those probes returns
 * 200, this stays where it is: `refreshFieldCatalog` records the per-kind failure and
 * carries on to the next kind, which is the correct behaviour for a catalog we cannot
 * read, and far better than pointing it somewhere that might answer with the wrong
 * thing.
 */
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
