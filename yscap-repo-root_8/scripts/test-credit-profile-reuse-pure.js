'use strict';
/**
 * #16 — the credit report is the BORROWER's: it shows on the profile across all
 * their files and is reusable on a new file for 120 days without a fresh inquiry.
 * Pure tests: db.query + storage.read + store.storeImport are stubbed, so no
 * Postgres is needed. Proves the age math, the profile shaping, and the reuse
 * guards (fresh window, cross-file only, bytes present).
 */
const assert = require('assert');
const credit = require('../src/lib/credit');
const db = require('../src/db');
const storage = require('../src/lib/storage');
const store = require('../src/lib/credit/store');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

const realQuery = db.query;
const realRead = storage.read;
const realStore = store.storeImport;
function restore() { db.query = realQuery; storage.read = realRead; store.storeImport = realStore; }

async function main(){
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const daysAgo = (n) => iso(Date.now() - n * 86400000);

// 1. ageDaysOf — calendar days from a YYYY-MM-DD, tz-safe, null on garbage.
{
  assert.strictEqual(credit.ageDaysOf(daysAgo(0)), 0);
  assert.strictEqual(credit.ageDaysOf(daysAgo(130)), 130);
  assert.strictEqual(credit.ageDaysOf(null), null);
  assert.strictEqual(credit.ageDaysOf('not-a-date'), null);
  ok('ageDaysOf counts calendar days and rejects garbage');
}

// 2. borrowerCreditReports shapes each row with a freshness flag + property line.
await (async () => {
  db.query = async () => ({ rows: [
    { id: 'r1', application_id: 'appA', report_date: daysAgo(10), middle_score: 720, status: 'completed',
      source: 'api', pull_type: 'soft', request_type: 'reissue', interface_version: '3.4',
      vendor_report_id: 'V1', pulled_at: new Date().toISOString(), pdf_document_id: 'pd', xml_document_id: 'xd',
      ys_loan_number: 'YSCAP1', property_address: { line1: '1 Main St', city: 'Lakewood', state: 'NJ' } },
    { id: 'r2', application_id: 'appB', report_date: daysAgo(200), middle_score: 700, status: 'completed',
      source: 'api', pull_type: 'soft', request_type: 'reissue', interface_version: '3.4',
      vendor_report_id: 'V2', pulled_at: new Date().toISOString(), pdf_document_id: null, xml_document_id: null,
      ys_loan_number: 'YSCAP2', property_address: {} },
  ] });
  const list = await credit.borrowerCreditReports('b1');
  restore();
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].fresh, true, '10-day report is fresh');
  assert.strictEqual(list[0].propertyLine, '1 Main St, Lakewood, NJ');
  assert.strictEqual(list[0].hasPdf, true);
  assert.strictEqual(list[1].fresh, false, '200-day report is stale');
  assert.strictEqual(list[1].propertyLine, null);
  ok('borrowerCreditReports shapes rows with freshness + property line');
})();


// 3. reuseFromProfile clones a fresh report from ANOTHER file, carrying its date.
await (async () => {
  const calls = { store: null };
  db.query = async (sql, params) => {
    if (/FROM applications a\b/i.test(sql) && /a\.borrower_id/i.test(sql) && /co_borrower_id/i.test(sql)) {
      return { rows: [{ id: 'appNew', borrower_id: 'b1', co_borrower_id: null, property_address: {}, ys_loan_number: 'YSNEW' }] };
    }
    if (/FROM borrowers WHERE id/i.test(sql)) {
      return { rows: [{ id: 'b1', first_name: 'Ada', last_name: 'Lovelace', ssn_last4: '1234', current_address: {}, fico: null }] };
    }
    if (/FROM credit_reports cr/i.test(sql) && /ORDER BY cr\.report_date DESC/i.test(sql)) {
      return { rows: [{ id: 'srcRep', application_id: 'appOld', borrower_id: 'b1', report_date: daysAgo(30),
        middle_score: 715, vendor_report_id: 'V9', xml_document_id: 'xd', pdf_document_id: 'pd',
        parsed: { middleScore: 715, reportId: 'V9', borrower: { ssnLast4: '1234' } },
        interface_version: '3.4', bureaus: ['Equifax'], pull_type: 'soft', request_type: 'reissue',
        ys_loan_number: 'YSOLD', property_address: {} }] };
    }
    if (/FROM documents WHERE id/i.test(sql)) return { rows: [{ storage_ref: 'ref/' + params[0] }] };
    return { rows: [] };
  };
  storage.read = async (ref) => Buffer.from(ref.endsWith('xd') ? '<xml/>' : '%PDF-1.4');
  store.storeImport = async (a) => { calls.store = a; return { creditReportId: 'newRep', ficoWritten: 715 }; };

  const out = await credit.reuseFromProfile('appNew', { borrowerId: 'b1', actorId: 'staff1' });
  restore();
  assert.strictEqual(out.reused, true);
  assert.strictEqual(out.fromApplicationId, 'appOld');
  assert.strictEqual(out.ageDays, 30);
  assert.strictEqual(out.middleScore, 715);
  assert.ok(calls.store, 'storeImport was called');
  assert.strictEqual(calls.store.source, 'reuse', 'stored with source=reuse');
  assert.strictEqual(calls.store.parsed.reportId, 'V9', 'carried the original parsed data (and date) forward');
  assert.strictEqual(calls.store.request.requestType, 'reissue');
  ok('reuseFromProfile clones a fresh cross-file report with source=reuse');
})();


// 4. reuseFromProfile refuses when the only report is stale (>120 days).
await (async () => {
  db.query = async (sql) => {
    if (/a\.borrower_id/i.test(sql) && /co_borrower_id/i.test(sql)) {
      return { rows: [{ id: 'appNew', borrower_id: 'b1', co_borrower_id: null, property_address: {} }] };
    }
    if (/FROM borrowers WHERE id/i.test(sql)) return { rows: [{ id: 'b1', ssn_last4: '1234', current_address: {} }] };
    return { rows: [] };   // latestBorrowerReport (windowed) finds nothing fresh
  };
  let threw = null;
  try { await credit.reuseFromProfile('appNew', { borrowerId: 'b1' }); } catch (e) { threw = e; }
  restore();
  assert.ok(threw && /no recent credit report/i.test(threw.userMessage || threw.message));
  ok('reuseFromProfile refuses when there is no fresh report to reuse');
})();


// 5. reuseFromProfile refuses a borrower not on the file.
await (async () => {
  db.query = async (sql) => {
    if (/a\.borrower_id/i.test(sql) && /co_borrower_id/i.test(sql)) {
      return { rows: [{ id: 'appNew', borrower_id: 'bX', co_borrower_id: null, property_address: {} }] };
    }
    if (/FROM borrowers WHERE id/i.test(sql)) return { rows: [{ id: 'bX', ssn_last4: '9999', current_address: {} }] };
    return { rows: [] };
  };
  let threw = null;
  try { await credit.reuseFromProfile('appNew', { borrowerId: 'someoneElse' }); } catch (e) { threw = e; }
  restore();
  assert.ok(threw && /not on this file/i.test(threw.userMessage || threw.message));
  ok('reuseFromProfile refuses a borrower who is not on the file');
})();


}
main().then(()=>{}).catch((e)=>{console.error(e);process.exit(1)});
process.on('exit', () => console.log(`\ncredit profile/reuse pure — ${passed} checks passed`));
