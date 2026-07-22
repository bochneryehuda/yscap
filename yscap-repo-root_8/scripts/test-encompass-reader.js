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
    pipelineSearch: async (filter, fields, opts) => {
      // Used by superDump + bulkPullAllLoans. Return the fixture pipeline set.
      const limit = (opts && opts.limit) || 10;
      return mockClient._pipelineHits.slice(0, limit);
    },
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

  console.log('OK — Encompass reader unit tests pass (includes super-dump + bulk-pull).');
}

main().catch((e) => { console.error(e); process.exit(1); });
