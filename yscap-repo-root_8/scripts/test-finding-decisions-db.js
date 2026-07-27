#!/usr/bin/env node
'use strict';
/**
 * THE BUG, REPRODUCED AND FIXED — real-database test (owner-reported 2026-07-27).
 *
 * "I click Dismiss on a finding, or I escalate it and the super-admin says it's OK,
 *  and a minute afterwards the finding populates again. It never actually clears."
 *
 * Each case below is one of the doors that resurrected the decision. Every one of
 * them FAILS on the pre-fix code, which is the point — a test that passes both ways
 * proves nothing about a regression.
 *
 *   1. A dismissed document finding survives a RE-READ of the same document.
 *      (The re-read sweep, db/332, re-reads every un-funded file on a schedule —
 *      this is literally the "a minute afterwards" mechanism.)
 *   2. A dismissed AI SUGGESTION is not re-inserted by the next sync pass.
 *      (`record()` deduped only against status='open', so a dismissed row was
 *      invisible and a brand-new open row was inserted on every file view.)
 *   3. A decision taken on ONE surface is honoured on the OTHER (identity, not row).
 *   4. Resolving a document finding closes its AI-panel MIRROR in the same breath.
 *   5. A POSTED CONDITION still comes back — the safety line. Only settling verbs
 *      suppress; work that is waiting on a follow-up must stay visible.
 *   6. Re-opening a decision brings the finding back.
 *   7. A dismissal on file A does NOT silence the same finding on file B.
 *
 * Requires DATABASE_URL with migrations applied. Skips cleanly otherwise. Runs in a
 * transaction and ROLLS BACK — leaves no rows behind.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-finding-decisions-db (no DATABASE_URL)'); process.exit(0); }
const assert = require('assert');
const { Pool } = require('pg');
const store = require('../src/lib/underwriting/store');
const fdec = require('../src/lib/underwriting/finding-decisions');
const suggestions = require('../src/lib/underwriting/ai-suggestions');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

const FINDING = {
  source: 'bank_statement', code: 'bank_account_not_borrower', severity: 'fatal',
  field: 'account_holder', docValue: 'ACME HOLDINGS LLC', fileValue: 'John Smith',
  title: 'The account is not in the borrower’s name', howTo: 'Get an operating agreement.',
  blocksCtc: true,
};

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tag = Buffer.from(String(process.pid) + ':' + process.hrtime.bigint()).toString('hex').slice(0, 12);
    const b = (await client.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('John','Smith',$1) RETURNING id`,
      [`fd+${tag}@example.com`])).rows[0];
    const staff = (await client.query(
      `INSERT INTO staff_users (email, full_name, role, password_hash) VALUES ($1,'Test Reviewer','underwriter','x') RETURNING id`,
      [`fdstaff+${tag}@example.com`])).rows[0];
    const mkApp = async () => (await client.query(
      `INSERT INTO applications (borrower_id) VALUES ($1) RETURNING id`, [b.id])).rows[0];
    const app = await mkApp();
    const mkDoc = async (appId) => (await client.query(
      `INSERT INTO documents (application_id,borrower_id,filename,content_type,storage_provider)
       VALUES ($1,$2,'stmt.pdf','application/pdf','local') RETURNING id`, [appId, b.id])).rows[0];
    const doc = await mkDoc(app.id);

    const analyze = (appId, docId, findings) => store.saveAnalysis(client, {
      documentId: docId, applicationId: appId, borrowerId: b.id, docType: 'bank_statement',
      extraction: { fields: { holder: 'ACME HOLDINGS LLC' }, status: 'analyzed' },
      findings,
    });
    const openFindings = async (appId) => (await store.getFileFindings(client, appId)).findings;

    // ---- 1. A DISMISSED FINDING SURVIVES A RE-READ -------------------------------
    {
      const r1 = await analyze(app.id, doc.id, [FINDING]);
      assert.strictEqual((await openFindings(app.id)).length, 1, 'the finding is raised the first time');

      await store.resolveFinding(client, {
        findingId: r1.findingIds[0], action: 'dismiss',
        note: 'Verified — this is the borrower’s own entity.', by: staff.id,
      });
      assert.strictEqual((await openFindings(app.id)).length, 0, 'dismissing clears it');

      // THE RE-READ. Same document, same finding — exactly what the un-funded sweep
      // does on a schedule, and what used to bring the finding straight back.
      await analyze(app.id, doc.id, [FINDING]);
      const after = await openFindings(app.id);
      assert.strictEqual(after.length, 0,
        'REGRESSION: a re-read re-raised a finding the reviewer had already dismissed');

      // The row IS written (audit trail + the "already dealt with" view) — born closed.
      const rows = (await client.query(
        `SELECT status, resolution FROM document_findings WHERE application_id=$1 ORDER BY created_at`, [app.id])).rows;
      assert.strictEqual(rows.length, 2, 'both reads are on record');
      assert.strictEqual(rows[1].status, 'dismissed');
      assert.strictEqual(rows[1].resolution, 'carried_forward', 'the decision is carried forward, not re-litigated');
      ok('a dismissed finding stays dismissed through a re-read of the same document');
    }

    // ---- 2. A DISMISSED AI SUGGESTION IS NOT RE-INSERTED --------------------------
    {
      const app2 = await mkApp();
      const mk = () => suggestions.record(client, {
        applicationId: app2.id, source: 'bank_statement', kind: 'finding',
        title: 'The account is not in the borrower’s name', dedupeKey: 'bank:x:acct',
        evidence: { code: 'bank_account_not_borrower' }, severity: 'fatal', suppressNotify: true,
      });
      const first = await mk();
      assert.ok(first.id, 'the suggestion is raised');

      await suggestions.decide(client, first.id, { action: 'dismiss', staffId: staff.id, reason: 'not an issue' });

      // The next sync pass — which runs on EVERY file view.
      const again = await mk();
      assert.notStrictEqual(again.id && String(again.id), null);
      const live = (await client.query(
        `SELECT count(*)::int n FROM ai_suggestions WHERE application_id=$1 AND status='open'`, [app2.id])).rows[0].n;
      assert.strictEqual(live, 0,
        'REGRESSION: a dismissed AI suggestion was re-inserted as a fresh open row');
      const total = (await client.query(
        `SELECT count(*)::int n FROM ai_suggestions WHERE application_id=$1`, [app2.id])).rows[0].n;
      assert.strictEqual(total, 1, 'and no duplicate row was stacked behind it');
      ok('a dismissed AI suggestion is not re-raised by the next sync pass');
    }

    // ---- 3. ONE DECISION, EVERY SURFACE ------------------------------------------
    // A finding settled on the Document Review desk must also stop the AI panel
    // raising it — they are two rows for one issue, keyed on the same identity.
    {
      const app3 = await mkApp();
      const doc3 = await mkDoc(app3.id);
      const r = await analyze(app3.id, doc3.id, [FINDING]);
      await store.resolveFinding(client, {
        findingId: r.findingIds[0], action: 'grant_exception',
        note: 'Super-admin approved — compensating factors on file.', by: staff.id,
      });

      const s = await suggestions.record(client, {
        applicationId: app3.id, source: 'bank_statement', kind: 'finding',
        title: 'The account is not in the borrower’s name', dedupeKey: 'bank:other:acct',
        evidence: { code: 'bank_account_not_borrower', field: 'account_holder', docValue: 'ACME HOLDINGS LLC' },
        documentId: doc3.id, severity: 'fatal', suppressNotify: true,
      });
      assert.strictEqual(s.settled, true, 'the AI panel honours a decision taken on the document desk');
      const n = (await client.query(
        `SELECT count(*)::int n FROM ai_suggestions WHERE application_id=$1 AND status='open'`, [app3.id])).rows[0].n;
      assert.strictEqual(n, 0, 'REGRESSION: the same issue came back on the other surface');
      ok('a decision on one desk settles the finding on every desk (identity, not row)');
    }

    // ---- 4. RESOLVING A FINDING CLOSES ITS AI-PANEL MIRROR ------------------------
    {
      const app4 = await mkApp();
      const doc4 = await mkDoc(app4.id);
      const mirror = await suggestions.record(client, {
        applicationId: app4.id, source: 'bank_statement', kind: 'finding',
        title: 'Mirror of the bank finding', dedupeKey: 'bank:mirror:acct',
        evidence: { code: 'bank_account_not_borrower' }, documentId: doc4.id,
        severity: 'fatal', suppressNotify: true,
      });
      const r = await analyze(app4.id, doc4.id, [FINDING]);
      await store.resolveFinding(client, { findingId: r.findingIds[0], action: 'dismiss', note: 'fine', by: staff.id });

      const m = (await client.query(`SELECT status FROM ai_suggestions WHERE id=$1`, [mirror.id])).rows[0];
      assert.strictEqual(m.status, 'dismissed',
        'REGRESSION: the finding was cleared on one screen and left open on the other');
      ok('resolving a finding closes its AI-panel mirror in the same breath');
    }

    // ---- 5. THE SAFETY LINE: A POSTED CONDITION STILL COMES BACK ------------------
    // This is the direction that must NOT be broken. "Post a condition" / "request a
    // document" leave the finding open on purpose — suppressing them would hide real
    // work that is waiting on a follow-up.
    {
      const app5 = await mkApp();
      const doc5 = await mkDoc(app5.id);
      const r = await analyze(app5.id, doc5.id, [FINDING]);
      await store.resolveFinding(client, {
        findingId: r.findingIds[0], action: 'post_condition', note: 'Requested the operating agreement.', by: staff.id,
      });
      assert.strictEqual((await openFindings(app5.id)).length, 1, 'a posted condition keeps the finding open');
      await analyze(app5.id, doc5.id, [FINDING]);
      assert.strictEqual((await openFindings(app5.id)).length, 1,
        'and a re-read must still raise it — it is unfinished work, not a settled decision');
      const keys = await fdec.suppressedKeys(client, app5.id);
      assert.strictEqual(keys.size, 0, 'post_condition writes no suppression');
      ok('a POSTED CONDITION is never suppressed — unfinished work still comes back');
    }

    // ---- 6. RE-OPEN BRINGS IT BACK ------------------------------------------------
    {
      const app6 = await mkApp();
      const doc6 = await mkDoc(app6.id);
      const r = await analyze(app6.id, doc6.id, [FINDING]);
      await store.resolveFinding(client, { findingId: r.findingIds[0], action: 'dismiss', by: staff.id });
      await analyze(app6.id, doc6.id, [FINDING]);
      assert.strictEqual((await openFindings(app6.id)).length, 0);

      const shape = { code: FINDING.code, field: FINDING.field, document_id: doc6.id, docValue: FINDING.docValue };
      assert.strictEqual(await fdec.reopen(client, { applicationId: app6.id, finding: shape, by: staff.id }), true);
      await analyze(app6.id, doc6.id, [FINDING]);
      assert.strictEqual((await openFindings(app6.id)).length, 1,
        'a re-opened decision must let the finding be raised again — dismissal is reversible');
      ok('re-opening a decision brings the finding back (a dismissal is never a one-way door)');
    }

    // ---- 7. SCOPE: PER FILE, NEVER PORTFOLIO-WIDE --------------------------------
    // A dismissal on one loan must never silence the same finding on another — that
    // is `ai_silenced_codes` (db/253), a deliberate super-admin-only escape hatch.
    {
      const appA = await mkApp(); const docA = await mkDoc(appA.id);
      const appB = await mkApp(); const docB = await mkDoc(appB.id);
      const rA = await analyze(appA.id, docA.id, [FINDING]);
      await store.resolveFinding(client, { findingId: rA.findingIds[0], action: 'dismiss', by: staff.id });
      await analyze(appB.id, docB.id, [FINDING]);
      assert.strictEqual((await openFindings(appA.id)).length, 0, 'file A stays clear');
      assert.strictEqual((await openFindings(appB.id)).length, 1,
        'file B must still be told — a decision is about ONE loan, never the whole book');
      ok('a dismissal is scoped to its own file — the next loan is unaffected');
    }

    console.log(`\nfinding-decisions db — ${passed} checks passed`);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
})().catch((e) => { console.error(e); process.exit(1); });
