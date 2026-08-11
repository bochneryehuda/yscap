'use strict';
/**
 * Pure unit test for src/encompass/reader.js. No DB, no network.
 * Mocks:
 *   - '../src/db'                          — records queries, returns fixture rows
 *   - '../src/encompass/client'            — returns fixture Encompass responses
 * Asserts:
 *   1. refreshFieldCatalog upserts each kind's rows into encompass_field_catalog
 *      with the right (kind, key, label, data_type, options, raw) shape, and returns
 *      per-kind counts.
 *   2. refreshFieldCatalog records a per-kind error and CONTINUES on partial failure
 *      (a broken customFields endpoint doesn't block enums/milestones/etc.).
 *   3. pullLoanForApplication with a missing GUID pipeline-searches, adopts the GUID,
 *      GETs the loan, scrubs SSN, and UPDATEs the application row.
 *   4. pullLoanForApplication with a cached GUID goes straight to getLoan (no search).
 *   5. pullLoanForApplication with no ys_loan_number stamps encompass_last_error.
 *   6. pullLoanForApplication with a pipeline-search miss stamps encompass_last_error.
 *   7. _scrubForStorage removes SSN from borrower + coBorrower on every application.
 *  15. STALE-GUID SELF-HEAL — a cached GUID whose getLoan 404s/410s is cleared and
 *      re-searched ONCE so the pull self-heals; a transient error (401/5xx/timeout)
 *      never clears the GUID; _isLoanNotFound classifies only 404/410 as "gone".
 */

const assert = require('assert');
const path = require('path');

// ── Fixture / mock scaffolding ────────────────────────────────────────────

const queries = [];
const mockDb = {
  async query(sql, params) {
    queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    if (/SELECT id, ys_loan_number, encompass_loan_guid FROM applications/.test(sql)) {
      return { rows: mockDb._appRows.length ? [mockDb._appRows.shift()] : [] };
    }
    if (/SELECT kind, key, label, data_type, options, pulled_at\s+FROM encompass_field_catalog/.test(sql)) {
      return { rows: mockDb._catalogRows.slice() };
    }
    if (/SELECT kind, count\(\*\)::int/.test(sql)) {
      const byKind = {};
      for (const r of mockDb._catalogRows) byKind[r.kind] = (byKind[r.kind] || 0) + 1;
      return { rows: Object.entries(byKind).map(([kind, n]) => ({ kind, n, last_pulled: '2026-07-22T00:00:00Z' })) };
    }
    if (/INSERT INTO encompass_bulk_pull_runs/.test(sql)) {
      return { rows: [{ id: 'run-1' }] };
    }
    if (/UPDATE applications\s+SET encompass_loan_guid = COALESCE/.test(sql)) {
      // Simulate: params[2] is the loan number. Match against fixture app map.
      const ln = params[2];
      const app = mockDb._appsByLoanNumber[ln];
      return { rows: app ? [{ id: app.id }] : [] };
    }
    return { rows: [] };
  },
  _appRows: [],
  _catalogRows: [],
  _appsByLoanNumber: {},
};

let mockClient;

// Prime the module cache with our mocks BEFORE loading the reader. Use the
// SAME resolved filename Node would resolve to (with extension) so the cache
// key matches when the reader does `require('../db')` / `require('./client')`.
const dbPath = require.resolve('../src/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

const clientPath = require.resolve('../src/encompass/client');
require.cache[clientPath] = {
  id: clientPath, filename: clientPath, loaded: true,
  exports: (mockClient = {
    configured: () => true,
    listCustomFields: async () => [{ fieldName: 'CX.ARV', description: 'After Repair Value', format: 'currency' }, { fieldName: 'CX.REHAB_BUDGET', description: 'Rehab Budget', format: 'currency' }],
    listStandardFields: async () => [{ canonicalName: 'Loan.LoanAmount', description: 'Loan Amount', format: 'currency' }],
    listFieldEnums: async () => [{ fieldId: 'Loan.LoanPurpose', description: 'Loan Purpose', options: [{ value: 'Purchase' }, { value: 'Refinance' }] }],
    listMilestoneCatalog: async () => [{ name: 'Approval', description: 'Cond. Approval' }, { name: 'Funded', description: 'Funded' }],
    listLoanFolders: async () => [{ folderName: 'Active Loans' }],
    listLoanTemplates: async () => [],
    findLoanByLoanNumber: async () => [{ loanGuid: 'guid-abc-123', 'Loan.LoanNumber': 'YS-999' }],
    pipelineSearch: async (request, opts) => {
      // Record every call so tests can assert the request shape (sortOrder MUST
      // be top-level; body MUST NOT be `filter.sortOrder`, which Encompass 400s).
      mockClient._pipelineCalls.push({ request, opts });
      const limit = (opts && opts.limit) || 10;
      const start = (opts && opts.start) || 0;
      return mockClient._pipelineHits.slice(start, start + limit);
    },
    _pipelineCalls: [],
    _pipelineHits: [
      { loanGuid: 'guid-abc-123', 'Loan.LoanNumber': 'YS-999', 'Loan.LoanFolder': 'Active', 'Loan.LoanAmount': 500000, 'Loan.BorrowerLastName': 'Doe', 'Loan.LastModified': '2026-07-20T10:00:00Z' },
      { loanGuid: 'guid-xyz-456', 'Loan.LoanNumber': 'YS-888', 'Loan.LoanFolder': 'Active', 'Loan.LoanAmount': 300000, 'Loan.BorrowerLastName': 'Roe', 'Loan.LastModified': '2026-07-19T10:00:00Z' },
    ],
    getLoan: async (guid) => ({
      guid,
      loanNumber: guid === 'guid-abc-123' ? 'YS-999' : 'YS-888',
      applications: [{
        borrower: { firstName: 'Jane', lastName: 'Doe', taxIdentificationIdentifier: '111-22-3333' },
        coBorrower: { firstName: 'John', lastName: 'Doe', taxIdentificationIdentifier: '444-55-6666' },
      }],
      customFields: [{ fieldName: 'CX.ARV', numericValue: 750000 }],
    }),
    // fieldReader mock — returns field 364 (loan number) so the SAME-LOAN guard is exercised.
    readFields: async (guid) => {
      const l = await mockClient.getLoan(guid);
      return { '364': l && l.loanNumber, '1859': 'MW TRADING LLC', '388': '1.000' };
    },
    getMilestones: async () => [{ name: 'Approval', date: '2026-06-01' }],
    getMilestoneLog: async () => [],
  }),
};

const reader = require('../src/encompass/reader');

// ── Tests ─────────────────────────────────────────────────────────────────

async function main() {
  // (1) refreshFieldCatalog upserts the right shape and returns counts.
  queries.length = 0;
  const summary = await reader.refreshFieldCatalog();
  assert.strictEqual(summary.customField, 2, 'two custom fields upserted');
  assert.strictEqual(summary.standardField, 1);
  assert.strictEqual(summary.enum, 1);
  assert.strictEqual(summary.milestone, 2);
  assert.strictEqual(summary.folder, 1);
  assert.strictEqual(summary.loanTemplate, 0);
  const cfInserts = queries.filter((q) => q.params && q.params[0] === 'customField');
  assert.strictEqual(cfInserts.length, 2);
  assert.strictEqual(cfInserts[0].params[1], 'CX.ARV', 'first row key is CX.ARV');
  assert.strictEqual(cfInserts[0].params[2], 'After Repair Value', 'label is copied');
  assert.strictEqual(cfInserts[0].params[3], 'currency', 'data_type is copied');
  assert.ok(/INSERT INTO encompass_field_catalog/.test(cfInserts[0].sql), 'inserts into encompass_field_catalog');
  assert.ok(/ON CONFLICT \(kind, key\) DO UPDATE/.test(cfInserts[0].sql), 'is an upsert');

  // (2) refreshFieldCatalog CONTINUES on a per-kind failure.
  mockClient.listCustomFields = async () => { throw new Error('BOOM 500'); };
  queries.length = 0;
  const partial = await reader.refreshFieldCatalog();
  assert.strictEqual(partial.customField, 0);
  assert.ok(partial.errors.customField && partial.errors.customField.includes('BOOM 500'));
  assert.strictEqual(partial.milestone, 2, 'milestones STILL upserted even after customField failed');

  // Restore for the loan tests.
  mockClient.listCustomFields = async () => [{ fieldName: 'CX.ARV', description: 'ARV', format: 'currency' }];

  // (3) pullLoanForApplication with no cached GUID: pipeline-search → adopt → getLoan → update.
  mockDb._appRows = [{ id: 'app-1', ys_loan_number: 'YS-999', encompass_loan_guid: null }];
  let searchedCount = 0;
  const origFind = mockClient.findLoanByLoanNumber;
  mockClient.findLoanByLoanNumber = async (...args) => { searchedCount++; return origFind(...args); };
  queries.length = 0;
  const r1 = await reader.pullLoanForApplication('app-1');
  assert.strictEqual(r1.ok, true, 'pull returned ok');
  assert.strictEqual(r1.guid, 'guid-abc-123');
  assert.ok(r1.size > 0, 'size is set');
  assert.strictEqual(searchedCount, 1, 'pipeline search was called exactly once');
  const adoptGuidUpdate = queries.find((q) => /UPDATE applications SET encompass_loan_guid=\$1/.test(q.sql));
  assert.ok(adoptGuidUpdate, 'adopts GUID with an UPDATE');
  assert.strictEqual(adoptGuidUpdate.params[0], 'guid-abc-123');
  const extraUpdate = queries.find((q) => /encompass_extra=\$1::jsonb/.test(q.sql));
  assert.ok(extraUpdate, 'stashes encompass_extra with UPDATE');
  const stored = JSON.parse(extraUpdate.params[0]);
  assert.strictEqual(stored.applications[0].borrower.taxIdentificationIdentifier, undefined, 'borrower SSN scrubbed');
  assert.strictEqual(stored.applications[0].coBorrower.taxIdentificationIdentifier, undefined, 'coBorrower SSN scrubbed');
  assert.strictEqual(stored.applications[0].borrower.firstName, 'Jane', 'non-PII borrower data kept');
  // Values read BY FIELD NUMBER are stashed for the extract (authoritative over paths).
  assert.strictEqual(stored._fieldValues['1859'], 'MW TRADING LLC', 'field 1859 read by number');
  assert.strictEqual(stored._fieldValues['388'], '1.000', 'field 388 read by number');
  // The plaintext SSN is replaced by a PII-safe keyed HMAC + last-4 so the
  // per-file screen can COMPARE the SSN without ever storing the raw number.
  {
    const idn = require('../src/clickup/identity');
    const cfg2 = require('../src/config');
    assert.strictEqual(stored.applications[0].borrower._ssnHash, idn.ssnHash('111-22-3333', cfg2.ssnMatchKey), 'borrower SSN stored as the keyed HMAC hash');
    assert.strictEqual(stored.applications[0].borrower._ssnLast4, '3333', 'borrower SSN last-4 stored for masked display');
    assert.strictEqual(stored.applications[0].coBorrower._ssnHash, idn.ssnHash('444-55-6666', cfg2.ssnMatchKey), 'coBorrower SSN stored as the keyed HMAC hash');
    assert.strictEqual(stored.applications[0].coBorrower._ssnLast4, '6666', 'coBorrower SSN last-4 stored');
    const storedStr = JSON.stringify(stored);
    assert.ok(!storedStr.includes('111-22-3333') && !storedStr.includes('111223333'), 'the raw borrower SSN is never stored (any format)');
    assert.ok(!storedStr.includes('444-55-6666') && !storedStr.includes('444556666'), 'the raw coBorrower SSN is never stored (any format)');
  }

  // (4) pullLoanForApplication with a cached GUID skips the search.
  mockDb._appRows = [{ id: 'app-2', ys_loan_number: 'YS-888', encompass_loan_guid: 'guid-xyz-456' }];
  searchedCount = 0;
  let getLoanArg = null;
  const origGet = mockClient.getLoan;
  mockClient.getLoan = async (guid) => { getLoanArg = guid; return origGet(guid); };
  queries.length = 0;
  const r2 = await reader.pullLoanForApplication('app-2');
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.guid, 'guid-xyz-456', 'used the cached GUID');
  assert.strictEqual(getLoanArg, 'guid-xyz-456');
  assert.strictEqual(searchedCount, 0, 'no pipeline search when GUID is cached');
  const noAdoptUpdate = queries.some((q) => /UPDATE applications SET encompass_loan_guid=\$1/.test(q.sql));
  assert.strictEqual(noAdoptUpdate, false, 'no GUID-adopt UPDATE when GUID already cached');

  // (5) No ys_loan_number → stamps error.
  mockDb._appRows = [{ id: 'app-3', ys_loan_number: null, encompass_loan_guid: null }];
  queries.length = 0;
  const r3 = await reader.pullLoanForApplication('app-3');
  assert.strictEqual(r3.ok, false);
  assert.ok(/ys_loan_number/.test(r3.reason), 'reason names the missing field');
  const errStamp = queries.find((q) => /encompass_last_error=\$1/.test(q.sql));
  assert.ok(errStamp, 'stamps encompass_last_error');
  assert.ok(/ys_loan_number/.test(errStamp.params[0]));

  // (6) pipeline-search miss → stamps error, no getLoan.
  mockDb._appRows = [{ id: 'app-4', ys_loan_number: 'YS-000', encompass_loan_guid: null }];
  mockClient.findLoanByLoanNumber = async () => [];
  let loanFetches = 0;
  mockClient.getLoan = async (...a) => { loanFetches++; return origGet(...a); };
  queries.length = 0;
  const r4 = await reader.pullLoanForApplication('app-4');
  assert.strictEqual(r4.ok, false);
  assert.ok(/no Encompass loan/.test(r4.reason));
  assert.strictEqual(loanFetches, 0, 'getLoan is NOT called on a search miss');

  // (7) _scrubForStorage sanity check on an isolated payload.
  const before = {
    applications: [
      { borrower: { firstName: 'A', taxIdentificationIdentifier: '1' }, coBorrower: { firstName: 'B', taxIdentificationIdentifier: '2' } },
      { borrower: { firstName: 'C', taxIdentificationIdentifier: '3' } },
    ],
    customFields: [{ fieldName: 'CX.ARV', numericValue: 100 }],
  };
  const after = reader._scrubForStorage(before);
  assert.strictEqual(after.applications[0].borrower.taxIdentificationIdentifier, undefined);
  assert.strictEqual(after.applications[0].coBorrower.taxIdentificationIdentifier, undefined);
  assert.strictEqual(after.applications[1].borrower.taxIdentificationIdentifier, undefined);
  assert.strictEqual(after.customFields[0].numericValue, 100, 'non-PII data preserved');
  // Original untouched (JSON copy semantics).
  assert.strictEqual(before.applications[0].borrower.taxIdentificationIdentifier, '1', 'source object not mutated');

  // (8) superDump returns { catalog, sample } in one shot; sample is capped at
  // sampleN; PII is scrubbed inside each loan.
  mockDb._catalogRows = [
    { kind: 'customField', key: 'CX.ARV', label: 'ARV', data_type: 'currency', options: null, pulled_at: '2026-07-22T00:00:00Z' },
    { kind: 'enum', key: 'Loan.LoanPurpose', label: 'Loan Purpose', data_type: 'enum', options: [{ value: 'Purchase' }, { value: 'Refinance' }], pulled_at: '2026-07-22T00:00:00Z' },
    { kind: 'milestone', key: 'Approval', label: 'Cond. Approval', data_type: 'milestone', options: null, pulled_at: '2026-07-22T00:00:00Z' },
  ];
  const dump = await reader.superDump({ sampleN: 5 });
  assert.strictEqual(dump.catalog.rows.length, 3, 'catalog rows returned');
  assert.deepStrictEqual(dump.catalog.counts.map((c) => c.kind).sort(), ['customField', 'enum', 'milestone']);
  assert.ok(dump.sample.loans.length > 0, 'sample loans returned');
  assert.ok(dump.sample.loans.every((l) => !l.loan || l.loan.applications[0].borrower.taxIdentificationIdentifier === undefined), 'SSN scrubbed in every sample loan');
  assert.strictEqual(dump.sample.requested, 5);
  assert.ok(dump.generatedAt, 'generatedAt stamp present');

  // Bounds check on sampleN — max 100.
  const capped = await reader.superDump({ sampleN: 500 });
  assert.ok(capped.sample.requested <= 100, 'sampleN clamped to 100');

  // (9) bulkPullAllLoans upserts every pipeline hit into encompass_loan_snapshot
  // and matches to PILOT applications by loan number when possible.
  mockClient._pipelineHits = [
    { loanGuid: 'guid-A', 'Loan.LoanNumber': 'YS-A', 'Loan.LoanFolder': 'Active', 'Loan.LoanAmount': 100, 'Loan.BorrowerLastName': 'A', 'Loan.LastModified': '2026-07-20T10:00:00Z' },
    { loanGuid: 'guid-B', 'Loan.LoanNumber': 'YS-B', 'Loan.LoanFolder': 'Active', 'Loan.LoanAmount': 200, 'Loan.BorrowerLastName': 'B', 'Loan.LastModified': '2026-07-19T10:00:00Z' },
  ];
  mockDb._appsByLoanNumber = { 'YS-A': { id: 'app-A' } };  // only YS-A has a PILOT match
  queries.length = 0;
  // pageSize > fixture size so the loop exits after one page (page.length < pageSize).
  const bulkResult = await reader.bulkPullAllLoans({ perRequestDelayMs: 0, pageSize: 100 });
  assert.strictEqual(bulkResult.pulled, 2, 'both loans pulled');
  assert.strictEqual(bulkResult.matched, 1, 'YS-A matched to app-A');
  assert.strictEqual(bulkResult.unmatched, 1, 'YS-B recorded as unmatched');
  assert.strictEqual(bulkResult.failed, 0);
  const snapshotUpserts = queries.filter((q) => /INSERT INTO encompass_loan_snapshot\s+\(encompass_loan_guid/.test(q.sql));
  assert.strictEqual(snapshotUpserts.length, 2, 'both loans upserted into snapshot');
  const stashedRaw = JSON.parse(snapshotUpserts[0].params[6]);
  assert.strictEqual(stashedRaw.applications[0].borrower.taxIdentificationIdentifier, undefined, 'snapshot rows scrubbed too');
  const appUpdates = queries.filter((q) => /UPDATE applications\s+SET encompass_loan_guid = COALESCE/.test(q.sql));
  assert.strictEqual(appUpdates.length, 2, 'application UPDATE fired for both attempts');
  const runCreate = queries.find((q) => /INSERT INTO encompass_bulk_pull_runs/.test(q.sql));
  assert.ok(runCreate, 'bulk pull run row created');
  const runFinal = queries.reverse().find((q) => /UPDATE encompass_bulk_pull_runs\s+SET pulled=\$1, matched=\$2/.test(q.sql));
  assert.ok(runFinal, 'bulk pull run row finalized');
  assert.strictEqual(runFinal.params[6], 'completed', 'run finalized to completed');

  // (9b) Regression: pipelineSearch requests MUST have `sortOrder` at the TOP
  // LEVEL of the request object (Encompass 400s "queryContract.filter.sortOrder
  // Invalid field name or value" if it sits inside `filter`). Verified by
  // inspecting the recorded pipeline calls from tests 8 + 9 above.
  const badCall = mockClient._pipelineCalls.find((c) => c.request && c.request.filter && Array.isArray(c.request.filter.sortOrder));
  assert.strictEqual(badCall, undefined, 'no pipelineSearch call may nest sortOrder inside filter');
  assert.ok(
    mockClient._pipelineCalls.some((c) => c.request && Array.isArray(c.request.sortOrder)),
    'at least one pipelineSearch call passes sortOrder at the top level',
  );

  // (9c) Regression: every pipelineSearch call MUST supply one of loanIds /
  // loanFolders / filter / fieldFilters — Encompass refuses a body with none
  // of them ("Either 'LoanIds' or filter properties like 'LoanFolders'..."
  // 2026-07-22 live diag). Since our reader uses loanFolders, assert every
  // recorded call carries a non-empty loanFolders array.
  const badScopeCall = mockClient._pipelineCalls.find((c) => {
    const r = c.request || {};
    const hasLoanIds = Array.isArray(r.loanIds) && r.loanIds.length > 0;
    const hasFolders = Array.isArray(r.loanFolders) && r.loanFolders.length > 0;
    const hasFilter = r.filter && ((Array.isArray(r.filter.terms) && r.filter.terms.length > 0) || r.filter.canonicalName);
    return !(hasLoanIds || hasFolders || hasFilter);
  });
  assert.strictEqual(badScopeCall, undefined,
    'no pipelineSearch call may omit loanIds / loanFolders / filter — Encompass 400s otherwise');

  // (9d) Regression: sortOrder.order MUST be PascalCase "Descending"/"Ascending"
  // — Encompass 400s "Invalid field name or value" on lowercase "desc"/"asc"
  // (2026-07-22 live diag, confirmed against ICE's Postman collection).
  for (const c of mockClient._pipelineCalls) {
    for (const s of (c.request && c.request.sortOrder) || []) {
      if (s && s.order != null) {
        assert.ok(s.order === 'Ascending' || s.order === 'Descending',
          `sortOrder.order must be "Ascending" or "Descending" (PascalCase); got ${JSON.stringify(s.order)}`);
      }
    }
  }

  // (10) Contract check — the REAL client at src/encompass/client.js must
  // export EVERY method the reader calls. This catches the "mock has it but
  // real client doesn't" bug class (root cause of the 2026-07-22 bulk-pull
  // crash "client.pipelineSearch is not a function"). No network — just
  // module inspection with the OAuth env unset so nothing runs.
  {
    const savedEnv = { ...process.env };
    delete process.env.ENCOMPASS_CLIENT_ID;
    delete process.env.ENCOMPASS_CLIENT_SECRET;
    delete process.env.ENCOMPASS_INSTANCE_ID;
    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/lib/integrations/encompass')];
    // Bypass the cache we planted at the top of the file so we load the REAL client here.
    const realClientPath = require.resolve('../src/encompass/client');
    const cachedMock = require.cache[realClientPath];
    delete require.cache[realClientPath];
    const realClient = require('../src/encompass/client');
    const readerSrc = require('fs').readFileSync(require.resolve('../src/encompass/reader'), 'utf8');
    // Every `client.<method>(` call in reader.js must resolve on the real client.
    const usedMethods = [...new Set([...readerSrc.matchAll(/\bclient\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g)].map((m) => m[1]))];
    assert.ok(usedMethods.length > 0, 'reader.js references at least one client method');
    for (const name of usedMethods) {
      assert.strictEqual(typeof realClient[name], 'function',
        `reader.js calls client.${name}(...) but the REAL src/encompass/client.js does not export a function of that name`);
    }
    // Restore the mock so subsequent test runs are unaffected.
    if (cachedMock) require.cache[realClientPath] = cachedMock;
    Object.assign(process.env, savedEnv);
  }

  // (11) Regression (2026-07-26 live): the REAL Encompass v3 pipeline row is
  // { loanId, fields:{ "Loan.Guid":..., "Loan.LoanNumber":... } } — NOT { loanGuid }
  // with the field values flattened onto the row. Such a row must still yield its
  // GUID on the per-file pull (the live symptom was "pipeline search returned a row
  // without a GUID" even though a matching loan came back).
  mockDb._appRows = [{ id: 'app-real', ys_loan_number: 'YS-777', encompass_loan_guid: null }];
  mockClient.findLoanByLoanNumber = async () => [{ loanId: 'guid-real-1', fields: { 'Loan.Guid': 'guid-real-1', 'Loan.LoanNumber': 'YS-777' } }];
  mockClient.getLoan = async (guid) => ({ guid, loanNumber: 'YS-777', applications: [{ borrower: { firstName: 'Re', lastName: 'Al' } }] });
  queries.length = 0;
  const rReal = await reader.pullLoanForApplication('app-real');
  assert.strictEqual(rReal.ok, true, 'real Encompass row shape {loanId,fields} yields ok (no "row without a GUID")');
  assert.strictEqual(rReal.guid, 'guid-real-1', 'GUID pulled from loanId / fields[Loan.Guid]');
  const adoptReal = queries.find((q) => /UPDATE applications SET encompass_loan_guid=\$1/.test(q.sql));
  assert.ok(adoptReal && adoptReal.params[0] === 'guid-real-1', 'adopts the GUID from the nested-shape row');

  // (12) Regression: the bulk pull reads the SAME nested shape — GUID from loanId,
  // field values from `fields` (a flattened-only read would store null loan numbers
  // and break loan-number → application matching / enrichment).
  mockClient._pipelineHits = [
    { loanId: 'guid-N', fields: { 'Loan.Guid': 'guid-N', 'Loan.LoanNumber': 'YS-N', 'Loan.LoanFolder': 'Active', 'Loan.LoanAmount': 321, 'Loan.BorrowerLastName': 'Nest', 'Loan.LastModified': '2026-07-21T00:00:00Z' } },
  ];
  mockDb._appsByLoanNumber = {};
  mockClient.getLoan = async (guid) => ({ guid, applications: [{ borrower: { firstName: 'N' } }] });
  queries.length = 0;
  const bulkN = await reader.bulkPullAllLoans({ perRequestDelayMs: 0, pageSize: 100 });
  assert.strictEqual(bulkN.pulled, 1, 'nested-shape row pulled');
  const snapN = queries.find((q) => /INSERT INTO encompass_loan_snapshot\s+\(encompass_loan_guid/.test(q.sql));
  assert.ok(snapN, 'nested-shape row upserted to snapshot');
  assert.strictEqual(snapN.params[0], 'guid-N', 'snapshot GUID from loanId');
  assert.strictEqual(snapN.params[1], 'YS-N', 'snapshot loan_number from fields[Loan.LoanNumber]');

  // (13) SAME-LOAN GUARD — a cached GUID that points at a DIFFERENT loan must be
  // REFUSED: nothing stored, the stale link cleared, a plain-language error stamped.
  mockDb._appRows = [{ id: 'app-wrong', ys_loan_number: 'YS-111', encompass_loan_guid: 'guid-someone-else' }];
  mockClient.getLoan = async (guid) => ({ guid, loanNumber: 'YS-222', applications: [{ borrower: { firstName: 'Other', lastName: 'Person' } }] });
  queries.length = 0;
  const rWrong = await reader.pullLoanForApplication('app-wrong');
  assert.strictEqual(rWrong.ok, false, 'a loan whose number does not match this file is REFUSED');
  const wrongMsg = rWrong.reason || rWrong.error || '';
  assert.ok(/YS-222/.test(wrongMsg) && /YS-111/.test(wrongMsg), 'the error names both loan numbers');
  assert.ok(!queries.some((q) => /encompass_extra=\$1::jsonb/.test(q.sql)), 'NOTHING from the wrong loan is stored');
  assert.ok(queries.some((q) => /SET encompass_loan_guid=NULL/.test(q.sql)), 'the stale GUID is cleared so the next pull re-searches');

  // (14) IDENTITY BY NUMBER (owner-directed 2026-08-02, file YSCAP258134762). The pull
  // now ALSO reads borrower/co-borrower identity (name/DOB/email/phone/SSN) BY NUMBER, so
  // a co-borrower the stored applications[] subtree left out is still recoverable — and
  // the raw SSN (fields 65/97) is HASHED + stripped before storage, the SAME PII
  // guarantee the loan subtree already has (never a plaintext SSN in encompass_extra).
  {
    const fm = require('../src/lib/integrations/encompass-field-map');
    let capturedIds = null;
    mockDb._appRows = [{ id: 'app-id', ys_loan_number: 'YS-ID', encompass_loan_guid: 'guid-id' }];
    mockClient.getLoan = async (guid) => ({ guid, loanNumber: 'YS-ID', applications: [{ borrower: { firstName: 'Chris', lastName: 'Rodriguez' } }] }); // NO co-borrower in the subtree
    mockClient.readFields = async (guid, ids) => {
      capturedIds = ids.slice();
      return {
        '364': 'YS-ID',
        '4000': 'Chris', '4002': 'Rodriguez',                        // borrower name by number
        '4004': 'Patrick', '4006': 'Kamara',                         // CO-BORROWER only exists by number
        '1403': '1999-08-30', '1268': 'pkamara555@gmail.com', '98': '7322095023',
        '65': '111-22-3333', '97': '444-55-8028',                    // raw SSNs — MUST be scrubbed
        '1859': 'MW TRADING LLC',
      };
    };
    queries.length = 0;
    const rId = await reader.pullLoanForApplication('app-id');
    assert.strictEqual(rId.ok, true, 'identity-by-number pull ok');
    // The fetch asked for the identity field ids (not just economics).
    for (const id of fm.identityFieldIds()) assert.ok(capturedIds.includes(id), `readFields was asked for identity id ${id}`);
    const extra = queries.find((q) => /encompass_extra=\$1::jsonb/.test(q.sql));
    const stored = JSON.parse(extra.params[0]);
    // Identity read by number is stored so the co-borrower is recoverable downstream.
    assert.strictEqual(stored._fieldValues['4004'], 'Patrick', 'co-borrower first name stored by number');
    assert.strictEqual(stored._fieldValues['4006'], 'Kamara', 'co-borrower last name stored by number');
    // The identity-read sentinel is stamped so the panel self-heal treats this as
    // already-identity-read and never re-fires a live read on every view.
    assert.strictEqual(stored._fieldValues['_idRead'], 1, 'the _idRead sentinel is stamped on a non-empty read');
    // Raw SSN is NEVER stored — replaced by the PII-safe keyed HMAC + last-4.
    assert.strictEqual(stored._fieldValues['65'], undefined, 'raw borrower SSN (65) stripped from _fieldValues');
    assert.strictEqual(stored._fieldValues['97'], undefined, 'raw co-borrower SSN (97) stripped from _fieldValues');
    const idn = require('../src/clickup/identity'); const cfg2 = require('../src/config');
    assert.strictEqual(stored._fieldValues['_ssn_b_hash'], idn.ssnHash('111-22-3333', cfg2.ssnMatchKey), 'borrower SSN → keyed HMAC in _fieldValues');
    assert.strictEqual(stored._fieldValues['_ssn_cb_hash'], idn.ssnHash('444-55-8028', cfg2.ssnMatchKey), 'co-borrower SSN → keyed HMAC in _fieldValues');
    assert.strictEqual(stored._fieldValues['_ssn_cb_last4'], '8028', 'co-borrower SSN last-4 kept for masked compare');
    const s = JSON.stringify(stored);
    assert.ok(!s.includes('111-22-3333') && !s.includes('111223333'), 'raw borrower SSN never stored (any format)');
    assert.ok(!s.includes('444-55-8028') && !s.includes('444558028'), 'raw co-borrower SSN never stored (any format)');
  }

  // (15) STALE-GUID SELF-HEAL (owner-reported 2026-08: a file "read from Encompass 9d ago"
  // that keeps failing to refresh even after pressing Refresh). A cached GUID can go DEAD —
  // a loan deleted / merged / renumbered in Encompass — and getLoan then 404s on every pull,
  // so the timestamp freezes and the file never matches, forever, with no way out. On a
  // DEFINITIVE not-found (404/410) with a CACHED guid, clear the bad link and re-search by
  // loan number ONCE so the very next pull self-heals. A TRANSIENT error (401/403/5xx/timeout)
  // must NEVER clear the guid (that would throw away a good link on every Encompass hiccup).

  // (15a) The classifier: only HTTP 404/410 count as "the loan is gone".
  assert.strictEqual(reader._isLoanNotFound(new Error('Encompass 404: Not Found')), true, '404 is not-found');
  assert.strictEqual(reader._isLoanNotFound(new Error('Encompass 410: Gone')), true, '410 is not-found');
  assert.strictEqual(reader._isLoanNotFound(new Error('Encompass 401: Unauthorized')), false, '401 is transient');
  assert.strictEqual(reader._isLoanNotFound(new Error('Encompass 403: Forbidden')), false, '403 is transient');
  assert.strictEqual(reader._isLoanNotFound(new Error('Encompass 400: Bad Request')), false, '400 is not not-found');
  assert.strictEqual(reader._isLoanNotFound(new Error('Encompass 500: Server Error')), false, '500 is transient');
  assert.strictEqual(reader._isLoanNotFound(new Error('network timeout')), false, 'a timeout is transient');
  assert.strictEqual(reader._isLoanNotFound(null), false, 'null is not not-found');
  assert.strictEqual(reader._isLoanNotFound({}), false, 'an object with no message is not not-found');

  // (15b) A cached GUID whose getLoan 404s: clear it, re-search once, and the pull SUCCEEDS.
  mockDb._appRows = [{ id: 'app-stale', ys_loan_number: 'YS-HEAL', encompass_loan_guid: 'guid-dead' }];
  let healFinds = 0;
  mockClient.findLoanByLoanNumber = async () => { healFinds++; return [{ loanId: 'guid-fresh', fields: { 'Loan.Guid': 'guid-fresh', 'Loan.LoanNumber': 'YS-HEAL' } }]; };
  mockClient.getLoan = async (guid) => {
    if (guid === 'guid-dead') throw new Error('Encompass 404: {"summary":"Loan not found"}');
    return { guid, loanNumber: 'YS-HEAL', applications: [{ borrower: { firstName: 'Heal', lastName: 'Ed' } }] };
  };
  mockClient.readFields = async () => ({ '364': 'YS-HEAL' });
  queries.length = 0;
  const rHeal = await reader.pullLoanForApplication('app-stale');
  assert.strictEqual(rHeal.ok, true, 'a stale GUID self-heals: the pull succeeds after re-search');
  assert.strictEqual(rHeal.guid, 'guid-fresh', 'the fresh GUID is used');
  assert.strictEqual(healFinds, 1, 're-searched exactly once');
  assert.ok(queries.some((q) => /SET encompass_loan_guid=NULL/.test(q.sql)), 'the dead GUID is cleared');
  assert.ok(queries.some((q) => /UPDATE applications SET encompass_loan_guid=\$1/.test(q.sql) && q.params[0] === 'guid-fresh'), 'the fresh GUID is adopted');
  assert.ok(queries.some((q) => /encompass_extra=\$1::jsonb/.test(q.sql)), 'the healed loan is stored (pulledAt advances)');

  // (15c) A cached GUID whose getLoan hits a TRANSIENT error (401): fail, but NEVER clear or re-search.
  mockDb._appRows = [{ id: 'app-transient', ys_loan_number: 'YS-TX', encompass_loan_guid: 'guid-live' }];
  let txFinds = 0;
  mockClient.findLoanByLoanNumber = async () => { txFinds++; return []; };
  mockClient.getLoan = async () => { throw new Error('Encompass 401: token expired'); };
  queries.length = 0;
  const rTx = await reader.pullLoanForApplication('app-transient');
  assert.strictEqual(rTx.ok, false, 'a transient getLoan error fails without self-heal');
  assert.ok(/getLoan: Encompass 401/.test(rTx.reason), 'the transient error is surfaced (no re-search)');
  assert.strictEqual(txFinds, 0, 'a transient error NEVER re-searches');
  assert.ok(!queries.some((q) => /SET encompass_loan_guid=NULL/.test(q.sql)), 'a transient error NEVER clears the cached GUID');

  // (15d) A cached GUID that 410s AND re-search finds nothing: still clear the dead link
  // (so a later pull can try again once the loan reappears), and explain both halves.
  mockDb._appRows = [{ id: 'app-gone', ys_loan_number: 'YS-GONE', encompass_loan_guid: 'guid-dead-2' }];
  mockClient.findLoanByLoanNumber = async () => [];
  mockClient.getLoan = async () => { throw new Error('Encompass 410: Gone'); };
  queries.length = 0;
  const rGone = await reader.pullLoanForApplication('app-gone');
  assert.strictEqual(rGone.ok, false, 'a stale GUID whose re-search finds nothing → fails');
  assert.ok(queries.some((q) => /SET encompass_loan_guid=NULL/.test(q.sql)), 'the dead GUID is still cleared so a later pull can retry');
  assert.ok(/out of date/.test(rGone.reason) && /no Encompass loan/.test(rGone.reason), 'the reason explains the stale link and the empty re-search');

  // (15e) A guid we JUST searched for this call is NOT stale — a 404 on a
  // freshly-searched guid must NOT trigger the self-heal (no clear, no double-search),
  // because hadCachedGuid is false. It surfaces the plain getLoan error instead.
  mockDb._appRows = [{ id: 'app-fresh404', ys_loan_number: 'YS-FRESH', encompass_loan_guid: null }];
  let freshFinds = 0;
  mockClient.findLoanByLoanNumber = async () => { freshFinds++; return [{ loanId: 'guid-just-found', fields: { 'Loan.Guid': 'guid-just-found', 'Loan.LoanNumber': 'YS-FRESH' } }]; };
  mockClient.getLoan = async () => { throw new Error('Encompass 404: Not Found'); };
  queries.length = 0;
  const rFresh = await reader.pullLoanForApplication('app-fresh404');
  assert.strictEqual(rFresh.ok, false, 'a 404 on a just-searched guid fails without self-heal');
  assert.ok(/getLoan: Encompass 404/.test(rFresh.reason), 'the plain getLoan error is surfaced (no self-heal wording)');
  assert.strictEqual(freshFinds, 1, 'searched exactly once — no double-search on a fresh guid');
  assert.ok(!queries.some((q) => /SET encompass_loan_guid=NULL/.test(q.sql)), 'a fresh-guid 404 NEVER clears the guid');

  // (15f) Double-404: a stale guid 404s, the re-search finds a guid, but the RETRY
  // getLoan ALSO 404s → the catch(e2) path stamps the "re-read after fixing" error.
  mockDb._appRows = [{ id: 'app-dbl', ys_loan_number: 'YS-DBL', encompass_loan_guid: 'guid-dead-3' }];
  mockClient.findLoanByLoanNumber = async () => [{ loanId: 'guid-also-dead', fields: { 'Loan.Guid': 'guid-also-dead', 'Loan.LoanNumber': 'YS-DBL' } }];
  mockClient.getLoan = async () => { throw new Error('Encompass 404: Not Found'); };
  queries.length = 0;
  const rDbl = await reader.pullLoanForApplication('app-dbl');
  assert.strictEqual(rDbl.ok, false, 'a double-404 (re-searched guid also gone) fails');
  assert.ok(/re-read after fixing the out-of-date Encompass link/.test(rDbl.reason), 'the retry-failure error is stamped');
  assert.ok(queries.some((q) => /SET encompass_loan_guid=NULL/.test(q.sql)), 'the original dead guid was still cleared');

  console.log('OK — Encompass reader unit tests pass (includes super-dump + bulk-pull + client-contract check + identity-by-number + SSN scrub + stale-GUID self-heal).');
}

main().catch((e) => { console.error(e); process.exit(1); });
