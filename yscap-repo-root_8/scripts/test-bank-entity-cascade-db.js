'use strict';
/**
 * DB test for the BANK-ENTITY HOLDER CASCADE (store.resolveFinding) + the display collapse
 * (bank-entity-dedup). Against a REAL Postgres: three bank statements under the SAME entity each
 * persist their own bank_business_entity_unverified finding; the desk collapses them to ONE card;
 * dismissing that card must settle ALL THREE and RECORD each in the durable ledger, so a re-read
 * (which re-inserts every finding) brings back NONE of them — the "I dismiss it and it stays gone"
 * requirement. A DIFFERENT holder is never touched. Runs in a transaction and ROLLS BACK.
 * Skips without DATABASE_URL.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-bank-entity-cascade-db (no DATABASE_URL)'); process.exit(0); }
const assert = require('assert');
const { Pool } = require('pg');
const store = require('../src/lib/underwriting/store');
const { collapseBankEntityDuplicates } = require('../src/lib/underwriting/bank-entity-dedup');
const fdec = require('../src/lib/underwriting/finding-decisions');

const HOLDER = 'Coretex Solutions LLC';
const OTHER = 'Blue Harbor Capital LLC';

// One bank statement document + its bank_business_entity_unverified finding under `holder`.
async function seedStatement(client, app, b, holder, filename) {
  const doc = (await client.query(
    `INSERT INTO documents (application_id,borrower_id,filename,content_type,storage_provider)
     VALUES ($1,$2,$3,'application/pdf','local') RETURNING id`, [app.id, b.id, filename])).rows[0];
  const r = await store.saveAnalysis(client, {
    documentId: doc.id, applicationId: app.id, borrowerId: b.id, docType: 'bank_statement',
    extraction: { fields: { accountHolderName: holder }, status: 'analyzed', confidence: 'analyzed' },
    findings: [{ source: 'bank_statement', code: 'bank_business_entity_unverified', severity: 'warning',
      field: 'account_holder', docValue: holder, fileValue: 'John Smith', title: 'Business account — entity not verified',
      howTo: 'Finish the LLC section', blocksCtc: false }],
  });
  return { docId: doc.id, findingId: r.findingIds[0] };
}
const openBank = async (client, appId) =>
  (await client.query(
    `SELECT id, document_id, code, doc_value, status FROM document_findings
       WHERE application_id=$1 AND code IN ('bank_business_entity_unverified','bank_account_other_entity')
       ORDER BY document_id`, [appId])).rows;

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const uniq = 'bankcasc+' + Buffer.from(String(process.pid)).toString('hex') + '@example.com';
    const b = (await client.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('John','Smith',$1) RETURNING id`, [uniq])).rows[0];
    const app = (await client.query(`INSERT INTO applications (borrower_id) VALUES ($1) RETURNING id`, [b.id])).rows[0];
    // The resolver is a STAFF user (finding_decisions.decided_by FKs to staff_users) — as in production.
    const staff = (await client.query(
      `INSERT INTO staff_users (email, full_name, role) VALUES ($1,'Test Underwriter','underwriter') RETURNING id`,
      ['staff+' + uniq])).rows[0];

    // THREE statements under the SAME entity + ONE under a different entity.
    const s1 = await seedStatement(client, app, b, HOLDER, 'stmt1.pdf');
    const s2 = await seedStatement(client, app, b, HOLDER, 'stmt2.pdf');
    const s3 = await seedStatement(client, app, b, HOLDER, 'stmt3.pdf');
    const sOther = await seedStatement(client, app, b, OTHER, 'other.pdf');

    // 1. Four open findings on file; the display collapse folds the two same-holder duplicates.
    let rows = await openBank(client, app.id);
    assert.strictEqual(rows.filter((r) => r.status === 'open').length, 4, 'four open bank-entity findings to start');
    const { resolvedIds } = collapseBankEntityDuplicates(rows);
    assert.strictEqual(resolvedIds.length, 2, 'the three same-holder findings collapse to one survivor (2 folded)');
    // The survivor + the OTHER holder are what remain shown; the other-holder finding never folds.
    assert.ok(!resolvedIds.includes(String(sOther.findingId)), 'the different-holder finding is never folded');

    // The survivor is the smallest document_id among the three same-holder rows.
    const sameHolderIds = [s1, s2, s3].map((s) => String(s.findingId));
    const survivorId = sameHolderIds.find((id) => !resolvedIds.map(String).includes(id));
    assert.ok(survivorId, 'exactly one same-holder survivor remains');

    // 2. Dismiss the surviving card → the HOLDER CASCADE settles ALL THREE same-holder findings.
    const dismissed = await store.resolveFinding(client, { findingId: survivorId, action: 'dismiss', note: 'not a real concern', by: staff.id });
    assert.strictEqual(dismissed.status, 'dismissed');
    rows = await openBank(client, app.id);
    const sameHolderRows = rows.filter((r) => r.doc_value === HOLDER);
    assert.ok(sameHolderRows.every((r) => r.status === 'dismissed'), 'ALL three same-holder findings are dismissed by the cascade');
    // The DIFFERENT holder is untouched — still open.
    const otherRow = rows.find((r) => r.doc_value === OTHER);
    assert.strictEqual(otherRow.status, 'open', 'the different-entity finding stays open (cascade never crossed holders)');

    // 3. The decision is RECORDED in the durable ledger for every same-holder document.
    const suppressed = await fdec.suppressedKeys(client, app.id);
    for (const s of [s1, s2, s3]) {
      const shape = { code: 'bank_business_entity_unverified', field: 'account_holder', document_id: s.docId, docValue: HOLDER };
      assert.ok(fdec.isSuppressed(suppressed, shape), `the ledger suppresses the finding on document ${s.docId}`);
    }
    const otherShape = { code: 'bank_business_entity_unverified', field: 'account_holder', document_id: sOther.docId, docValue: OTHER };
    assert.ok(!fdec.isSuppressed(suppressed, otherShape), 'the different-entity finding is NOT suppressed');

    // 4. A RE-READ re-inserts every finding — they must come back DISMISSED (carried forward), not open.
    //    This is the whole point: the un-funded re-read sweep cannot rotate a fresh survivor onto the desk.
    for (const [s, holder] of [[s1, HOLDER], [s2, HOLDER], [s3, HOLDER]]) {
      await store.saveAnalysis(client, {
        documentId: s.docId, applicationId: app.id, borrowerId: b.id, docType: 'bank_statement',
        extraction: { fields: { accountHolderName: holder }, status: 'analyzed', confidence: 'analyzed' },
        findings: [{ source: 'bank_statement', code: 'bank_business_entity_unverified', severity: 'warning',
          field: 'account_holder', docValue: holder, fileValue: 'John Smith', title: 'Business account — entity not verified',
          howTo: 'Finish the LLC section', blocksCtc: false }],
      });
    }
    const openAfterReread = (await store.getFileFindings(client, app.id)).findings
      .filter((f) => f.doc_value === HOLDER && f.code === 'bank_business_entity_unverified');
    assert.strictEqual(openAfterReread.length, 0, 'after a re-read NONE of the dismissed same-holder findings reopen');

    // 5. The other-holder finding, re-read, is STILL open (it was never dismissed) — nothing over-suppressed.
    await store.saveAnalysis(client, {
      documentId: sOther.docId, applicationId: app.id, borrowerId: b.id, docType: 'bank_statement',
      extraction: { fields: { accountHolderName: OTHER }, status: 'analyzed', confidence: 'analyzed' },
      findings: [{ source: 'bank_statement', code: 'bank_business_entity_unverified', severity: 'warning',
        field: 'account_holder', docValue: OTHER, fileValue: 'John Smith', title: 'Business account — entity not verified',
        howTo: 'Finish the LLC section', blocksCtc: false }],
    });
    const otherOpen = (await store.getFileFindings(client, app.id)).findings
      .filter((f) => f.doc_value === OTHER);
    assert.strictEqual(otherOpen.length, 1, 'the un-dismissed different-entity finding is still shown after a re-read');

    await client.query('ROLLBACK');
    console.log('✓ test-bank-entity-cascade-db: display collapse + holder cascade + durable across re-read + holder isolation pass');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(e);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
})();
