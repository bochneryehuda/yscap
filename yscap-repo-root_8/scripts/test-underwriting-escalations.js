'use strict';
/**
 * DB test for the per-finding escalation workload (src/lib/underwriting/escalations.js,
 * db/222). A staffer escalates an underwriting finding they can't decide to a super-admin /
 * processor / underwriter; it lands in that reviewer's workload with a snapshot of the finding
 * and its framed options, and is resolved/dismissed by the person it was routed to.
 *
 * Requires DATABASE_URL with migrations applied. Runs in a transaction and ROLLS BACK.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-underwriting-escalations (no DATABASE_URL)'); process.exit(0); }
const assert = require('assert');
const { Pool } = require('pg');
const esc = require('../src/lib/underwriting/escalations');

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Fixtures — a borrower, a file, a stored finding, and two staffers.
    const uniq = 'esctest+' + Buffer.from(String(process.pid)).toString('hex');
    const b = (await client.query(
      `INSERT INTO borrowers (first_name,last_name,email,date_of_birth) VALUES ('Simcha','Lev',$1,'1980-05-15') RETURNING id`, [uniq + '@example.com'])).rows[0];
    const app = (await client.query(
      `INSERT INTO applications (borrower_id, ys_loan_number) VALUES ($1,$2) RETURNING id`, [b.id, 'YS-ESC-' + process.pid])).rows[0];
    const doc = (await client.query(
      `INSERT INTO documents (application_id,borrower_id,filename,content_type,storage_provider) VALUES ($1,$2,'ins.pdf','application/pdf','local') RETURNING id`,
      [app.id, b.id])).rows[0];
    const ext = (await client.query(
      `INSERT INTO document_extractions (document_id,application_id,borrower_id,doc_type,fields,status) VALUES ($1,$2,$3,'insurance','{}','analyzed') RETURNING id`,
      [doc.id, app.id, b.id])).rows[0];
    const fnd = (await client.query(
      `INSERT INTO document_findings (application_id,borrower_id,document_id,extraction_id,source,code,severity,field,title,how_to,blocks_ctc,suggested_actions,status)
       VALUES ($1,$2,$3,$4,'insurance','insurance_no_mortgagee','fatal','mortgagee_clause','The insurance does not name the lender as mortgagee','Have the agent add the correct mortgagee clause',true,$5,'open') RETURNING id`,
      [app.id, b.id, doc.id, ext.id, JSON.stringify(['post_condition', 'request_document', 'grant_exception'])])).rows[0];
    const proc = (await client.query(
      `INSERT INTO staff_users (email,full_name,role,password_hash) VALUES ($1,'Proc One','processor','x') RETURNING id`, [uniq + '-proc@x.com'])).rows[0];
    const under = (await client.query(
      `INSERT INTO staff_users (email,full_name,role,password_hash) VALUES ($1,'Under One','underwriter','x') RETURNING id`, [uniq + '-under@x.com'])).rows[0];
    // proc is ON the file (an assignee); proc2 is a processor NOT on the file — used to prove that
    // a role-routed escalation is scoped to processors who can actually access the file.
    await client.query(`INSERT INTO application_assignees (application_id, staff_id, role, is_primary) VALUES ($1,$2,'processor',false)`, [app.id, proc.id]);
    const proc2 = (await client.query(
      `INSERT INTO staff_users (email,full_name,role,password_hash) VALUES ($1,'Proc Two','processor','x') RETURNING id`, [uniq + '-proc2@x.com'])).rows[0];

    // 1. Open an escalation from a stored finding → snapshot carries the title/how_to/values/options.
    const e1 = await esc.openEscalation(client, {
      appId: app.id, findingId: fnd.id,
      finding: { code: 'insurance_no_mortgagee', severity: 'fatal', field: 'mortgagee_clause',
        title: 'The insurance does not name the lender as mortgagee', how_to: 'add the clause',
        docValue: 'none', fileValue: 'ISAOA/ATIMA', document_id: doc.id,
        suggested_actions: ['post_condition', 'request_document'] },
      targetRole: 'super_admin', question: 'Is this really a block if the invoice is paid?',
      borrowerId: b.id, requestedBy: proc.id,
    });
    assert.ok(e1.id, 'escalation created');
    assert.strictEqual(e1.status, 'open');
    assert.strictEqual(e1.target_role, 'super_admin');
    assert.strictEqual(e1.title, 'The insurance does not name the lender as mortgagee', 'finding title snapshotted');
    assert.ok(Array.isArray(e1.suggested_actions) && e1.suggested_actions.length === 2, 'framed options snapshotted');
    assert.strictEqual(e1.question, 'Is this really a block if the invoice is paid?');

    // 2. normTargetRole falls back to super_admin for garbage.
    assert.strictEqual(esc.normTargetRole('nonsense'), 'super_admin');
    assert.strictEqual(esc.normTargetRole('processor'), 'processor');

    // 3. Re-escalating the SAME stored finding supersedes the prior open row (one-open-per-finding).
    const e2 = await esc.openEscalation(client, {
      appId: app.id, findingId: fnd.id, finding: { code: 'insurance_no_mortgagee', title: 'x' },
      targetRole: 'underwriter', assignedTo: under.id, requestedBy: proc.id,
    });
    const openForFinding = (await client.query(
      `SELECT count(*)::int n FROM finding_escalations WHERE finding_id=$1 AND status='open'`, [fnd.id])).rows[0].n;
    assert.strictEqual(openForFinding, 1, 'only one open escalation per finding after re-escalation');
    const oldRow = (await client.query(`SELECT status FROM finding_escalations WHERE id=$1`, [e1.id])).rows[0];
    assert.strictEqual(oldRow.status, 'dismissed', 'prior escalation superseded (dismissed)');

    // 4. forFile shows the open escalation keyed by finding.
    const onFile = await esc.forFile(app.id, client);
    assert.strictEqual(onFile.length, 1, 'one open escalation on the file');
    assert.strictEqual(onFile[0].finding_id, fnd.id);
    assert.strictEqual(onFile[0].target_role, 'underwriter');

    // 5. Scoping: the underwriter it was routed/assigned to sees it; an unrelated processor role match
    //    also sees it (target_role); a super-admin sees all.
    const underView = await esc.listEscalations({ status: 'open', viewer: { id: under.id, role: 'underwriter' }, seeAll: false }, client);
    assert.ok(underView.some((r) => r.id === e2.id), 'underwriter sees the escalation routed to them');
    const superView = await esc.listEscalations({ status: 'open', viewer: { id: 'x', role: 'super_admin' }, seeAll: true }, client);
    assert.ok(superView.some((r) => r.id === e2.id), 'super-admin (seeAll) sees it');
    // The raiser (processor) sees it too (requested_by), even though it's routed to the underwriter.
    const raiserView = await esc.listEscalations({ status: 'open', viewer: { id: proc.id, role: 'processor' }, seeAll: false }, client);
    assert.ok(raiserView.some((r) => r.id === e2.id), 'the raiser sees their own escalation');

    // 6. pendingCount — scoped vs seeAll.
    const cUnder = await esc.pendingCount({ viewer: { id: under.id, role: 'underwriter' }, seeAll: false }, client);
    assert.strictEqual(cUnder, 1, 'underwriter has one open item');
    const cSuper = await esc.pendingCount({ seeAll: true }, client);
    assert.ok(cSuper >= 1, 'seeAll count includes it');

    // 7. Decide → resolved; a second decide is a no-op (already handled).
    const decided = await esc.decideEscalation(client, { id: e2.id, decision: 'resolved', staffId: under.id, note: 'confirmed — post a condition' });
    assert.strictEqual(decided.status, 'resolved');
    assert.strictEqual(decided.decision, 'resolved');
    assert.strictEqual(decided.decision_note, 'confirmed — post a condition');
    const again = await esc.decideEscalation(client, { id: e2.id, decision: 'dismissed', staffId: under.id });
    assert.strictEqual(again, null, 'deciding an already-handled escalation is a no-op');
    assert.strictEqual(await esc.pendingCount({ viewer: { id: under.id, role: 'underwriter' }, seeAll: false }, client), 0, 'no open items after resolution');

    // 8. A DERIVED finding (no finding_id) can still be escalated from its snapshot.
    const eDerived = await esc.openEscalation(client, {
      appId: app.id, findingId: null,
      finding: { code: 'metrics_over_ltp', severity: 'warning', title: 'Loan exceeds loan-to-purchase cap', availableActions: [{ key: 'post_condition' }] },
      targetRole: 'processor', requestedBy: proc.id,
    });
    assert.ok(eDerived.id && eDerived.finding_id === null, 'derived finding escalated with null finding_id');
    assert.ok(Array.isArray(eDerived.suggested_actions), 'derived escalation kept its framed options');

    // 9. FILE-SCOPING of a role-routed escalation (audit hardening): an escalation routed to the
    //    'processor' role with NO specific assignee must only be visible to processors who can
    //    access the file — never leak a file's borrower/identity to an unrelated scoped processor.
    const e3 = await esc.openEscalation(client, {
      appId: app.id, findingId: null,
      finding: { code: 'entity_name_mismatch', severity: 'fatal', title: 'Vesting entity disagrees' },
      targetRole: 'processor', requestedBy: under.id, // raised by the underwriter, routed to the processor role
    });
    // proc IS an assignee on the file → sees it via role-match + file access.
    const procView = await esc.listEscalations({ status: 'open', viewer: { id: proc.id, role: 'processor' }, seeAll: false }, client);
    assert.ok(procView.some((r) => r.id === e3.id), 'a processor ON the file sees a role-routed escalation');
    // proc2 is a processor NOT on the file → must NOT see it (file-scoping), and it isn't in their count.
    const proc2View = await esc.listEscalations({ status: 'open', viewer: { id: proc2.id, role: 'processor' }, seeAll: false }, client);
    assert.ok(!proc2View.some((r) => r.id === e3.id), 'a processor NOT on the file does NOT see the role-routed escalation');
    const cProc2 = await esc.pendingCount({ viewer: { id: proc2.id, role: 'processor' }, seeAll: false }, client);
    assert.strictEqual(cProc2, 0, 'off-file processor count excludes the file-scoped escalation');
    // A super-admin still sees it.
    const superView2 = await esc.listEscalations({ status: 'open', viewer: { id: 'x', role: 'super_admin' }, seeAll: true }, client);
    assert.ok(superView2.some((r) => r.id === e3.id), 'super-admin sees the role-routed escalation');

    await client.query('ROLLBACK');
    console.log('PASS test-underwriting-escalations');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('FAIL test-underwriting-escalations:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
