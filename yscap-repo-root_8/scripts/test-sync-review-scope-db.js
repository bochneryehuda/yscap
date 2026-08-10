'use strict';
/**
 * SYNC-REVIEW SCOPE FOLLOWS BORROWER VISIBILITY (#37 — the #15 class, flagged by
 * the findings-bundle audit).
 *
 * An APPLICATION-LESS review row (a borrower-level DOB, a non-materialized task,
 * an Encompass row that never linked to a file) hangs on a BORROWER, not a file.
 * The old scope — the list, the count, and every resolve door — only matched a
 * borrower who had a VISIBLE FILE, so it hid the row from, and 403'd, the very
 * officer who can answer it: one who OWNS the borrower's profile but has no RTL
 * file for them (a DSCR-only client), or is only a CO-borrower on the file. All
 * four paths now use the #15 borrower gate (VISIBLE_BORROWER_SQL), so a row an
 * officer can SEE is one they can RESOLVE, and an unrelated officer still
 * sees/resolves neither.
 *
 * The discriminator is q.application_id, NOT source: a file-LINKED Encompass row
 * (encompass_loan_snapshot.application_id, carried through enrich.js) carries an
 * application_id and follows the FILE gate (VISIBLE_OFFICERS_SQL) on both the list
 * and the resolve door — so the profile owner, who is not on that file, neither
 * sees nor resolves it, while the file's own officer does both (section 5). This
 * is the deliberate narrowing vs the old Encompass-only carve-out, which showed
 * such a row to a borrower-visible officer who then 403'd on resolve.
 *
 * Each "owner can see/resolve the application-less row" assertion BITES on the
 * pre-fix code (it was a 403 / an empty list).
 */
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
if (!process.env.DATABASE_URL) { console.log('SKIP (no DATABASE_URL)'); process.exit(0); }

const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');
const C = require('../src/lib/crypto');
const tag = `syncscope_${process.pid}`;

let pass = 0; let fail = 0;
const ok = (cond, what) => { if (cond) { pass++; console.log(`  ok  ${what}`); } else { fail++; console.error(`  FAIL ${what}`); } };

(async () => {
  await ensureSchema();
  const app = require('../src/server');
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const mkStaff = async (name, role) => {
    const s = (await db.query(
      `INSERT INTO staff_users (email, full_name, role) VALUES ($1,$2,$3) RETURNING id, token_version`,
      [`${name}+${tag}@x.test`, name, role])).rows[0];
    return { id: s.id, tok: C.signJwt({ sub: s.id, kind: 'staff', role, tv: s.token_version || 0 }) };
  };
  const owner = await mkStaff('Owner LO', 'loan_officer');       // owns the borrower's profile, no file
  const cobo = await mkStaff('Cobo LO', 'loan_officer');         // only a co-borrower file
  const stranger = await mkStaff('Stranger LO', 'loan_officer'); // unrelated
  const admin = await mkStaff('Admin', 'super_admin');           // sees all

  const call = (tok, method, path, body) => fetch(`${base}/api/staff${path}`, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  // The borrower the OWNER owns via profile (primary_officer_id) — a DSCR-only
  // client with NO RTL application at all.
  const borrower = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email,primary_officer_id) VALUES ('Sync','Owned',$1,$2) RETURNING id`,
    [`syncowned+${tag}@x.test`, owner.id])).rows[0].id;

  // A co-borrower file: a DIFFERENT borrower's application where OUR borrower is
  // the CO-borrower, with `cobo` as the loan officer.
  const other = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Sync','Primary',$1) RETURNING id`,
    [`syncprimary+${tag}@x.test`])).rows[0].id;
  await db.query(
    `INSERT INTO applications (borrower_id, co_borrower_id, loan_officer_id, status) VALUES ($1,$2,$3,'file_intake')`,
    [other, borrower, cobo.id]);

  // An APPLICATION-LESS review row on our borrower. source defaults to 'clickup'
  // (NOT encompass) on purpose — it proves the GENERAL widening, not the old
  // Encompass-only carve-out. A unique task_id per row keeps the one-open-row
  // uniqueness index (task_id, field_key, direction, proposed_value) happy.
  let rowSeq = 0;
  const mkRow = async () => {
    rowSeq += 1;
    return (await db.query(
      `INSERT INTO sync_review_queue (application_id, borrower_id, task_id, direction, field_key, reason, status, clickup_value, portal_value)
       VALUES (NULL,$1,$2,'inbound','date_of_birth','dob_test','open','1990-01-01','1990-02-02') RETURNING id`,
      [borrower, `${tag}-row-${rowSeq}`])).rows[0].id;
  };

  const listHasRow = async (tok, id) => {
    const r = await (await call(tok, 'GET', '/sync-reviews')).json();
    return Array.isArray(r.reviews) && r.reviews.some((x) => String(x.id) === String(id));
  };

  console.log('\n1. A profile-owner officer SEES + RESOLVES an application-less row (the #15 gap)');
  {
    const id = await mkRow();
    ok(await listHasRow(owner.tok, id), 'the profile owner sees the row in their list');
    ok(!(await listHasRow(stranger.tok, id)), 'an unrelated officer does NOT see it (not over-widened)');
    const oc = await (await call(owner.tok, 'GET', '/sync-reviews/count')).json();
    ok((oc.open || 0) >= 1, `the owner's badge counts it (open=${oc.open})`);
    const sr = await call(stranger.tok, 'POST', `/sync-reviews/${id}/reject`);
    ok(sr.status === 403, `an unrelated officer is refused resolution (got ${sr.status})`);
    const orr = await call(owner.tok, 'POST', `/sync-reviews/${id}/reject`);
    ok(orr.status === 200, `the profile owner resolves it (got ${orr.status})`);
    const st = (await db.query(`SELECT status FROM sync_review_queue WHERE id=$1`, [id])).rows[0].status;
    ok(st === 'rejected', `the row is really resolved (status=${st})`);
  }

  console.log('\n2. A co-borrower-file officer SEES + RESOLVES it (single + bulk doors)');
  {
    const id = await mkRow();
    ok(await listHasRow(cobo.tok, id), 'the co-borrower-file officer sees the row');
    const br = await call(cobo.tok, 'POST', '/sync-reviews/bulk', { ids: [id], action: 'reject' });
    const bj = await br.json();
    ok(br.status === 200 && Array.isArray(bj.results) && bj.results.some((x) => String(x.id) === String(id) && x.ok),
      'the co-borrower officer bulk-resolves it');

    const id2 = await mkRow();
    const sbr = await call(stranger.tok, 'POST', '/sync-reviews/bulk', { ids: [id2], action: 'reject' });
    const sbj = await sbr.json();
    ok(Array.isArray(sbj.results) && sbj.results.some((x) => String(x.id) === String(id2) && !x.ok && /forbidden/i.test(x.error || '')),
      'the unrelated officer is refused the same row in bulk');
    ok((await db.query(`SELECT status FROM sync_review_queue WHERE id=$1`, [id2])).rows[0].status === 'open',
      "…and that row is untouched (still open)");
  }

  console.log('\n3. An admin (sees all) sees + resolves everything');
  {
    const id = await mkRow();
    ok(await listHasRow(admin.tok, id), 'an admin sees the row');
    const ar = await call(admin.tok, 'POST', `/sync-reviews/${id}/reject`);
    ok(ar.status === 200, `an admin resolves it (got ${ar.status})`);
  }

  console.log('\n4. An Encompass-source row is reached the SAME way (the old carve-out is subsumed)');
  {
    // REVIEW_BORROWER_SCOPE gates on application_id IS NULL, source-agnostic — so
    // an Encompass row (which the old ENCOMPASS_REVIEW_SCOPE special-cased) is now
    // covered by the one general branch. Prove it still reaches the profile owner.
    const id = (await db.query(
      `INSERT INTO sync_review_queue (application_id, borrower_id, task_id, source, direction, field_key, reason, status, clickup_value, portal_value)
       VALUES (NULL,$1,$2,'encompass','inbound','current_address','addr_test','open','A St','B Ave') RETURNING id`,
      [borrower, `encompass:${tag}-enc`])).rows[0].id;
    ok(await listHasRow(owner.tok, id), 'the profile owner sees the Encompass row too');
    ok(!(await listHasRow(stranger.tok, id)), 'an unrelated officer still does not');
    const r = await call(owner.tok, 'POST', `/sync-reviews/${id}/reject`);
    ok(r.status === 200, `the profile owner resolves the Encompass row (got ${r.status})`);
  }

  console.log('\n5. A FILE-LINKED Encompass row follows the FILE, not the borrower (the narrowing)');
  {
    // An Encompass row CAN carry a linked application_id (reader.js sets
    // encompass_loan_snapshot.application_id; enrich.js carries it into queueReview).
    // Such a row is application-TIED, so REVIEW_BORROWER_SCOPE (which gates on
    // application_id IS NULL) does NOT match it — it follows VISIBLE_OFFICERS_SQL
    // (the file) on the list AND canSeeReviewRow. So the FILE officer sees + resolves
    // it, and the profile owner — who owns the borrower but is not on THIS file —
    // neither sees nor resolves (visibility matches resolvability). This is the
    // deliberate narrowing vs the old Encompass-only carve-out, which showed the row
    // to the profile owner who then 403'd on resolve.
    const fileLo = await mkStaff('File LO', 'loan_officer');   // the officer on the linked file
    const linkedApp = (await db.query(
      `INSERT INTO applications (borrower_id, loan_officer_id, status) VALUES ($1,$2,'file_intake') RETURNING id`,
      [borrower, fileLo.id])).rows[0].id;
    const id = (await db.query(
      `INSERT INTO sync_review_queue (application_id, borrower_id, task_id, source, direction, field_key, reason, status, clickup_value, portal_value)
       VALUES ($1,$2,$3,'encompass','inbound','current_address','addr_test','open','A St','B Ave') RETURNING id`,
      [linkedApp, borrower, `encompass:${tag}-linked`])).rows[0].id;
    ok(await listHasRow(fileLo.tok, id), 'the file officer sees the file-linked Encompass row');
    ok(!(await listHasRow(owner.tok, id)), 'the profile owner (not on this file) does NOT see it — the narrowing');
    const fc = await (await call(fileLo.tok, 'GET', '/sync-reviews/count')).json();
    ok((fc.open || 0) >= 1, `the file officer's badge counts it (open=${fc.open})`);
    const orr = await call(owner.tok, 'POST', `/sync-reviews/${id}/reject`);
    ok(orr.status === 403, `the profile owner is refused resolution (got ${orr.status})`);
    const fr = await call(fileLo.tok, 'POST', `/sync-reviews/${id}/reject`);
    ok(fr.status === 200, `the file officer resolves it (got ${fr.status})`);
  }

  server.close();
  console.log(`\n${fail ? 'FAILED' : 'OK'}  sync-review scope follows borrower visibility — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE FAILED:', e); process.exit(1); });
