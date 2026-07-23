'use strict';
/**
 * Co-borrower guaranty waiver — the exception module + wording (owner-directed 2026-07-22).
 *
 * PURE part (always runs): term-options.guarantySummary produces the correct
 * default (both guarantee, joint & several) vs. waived (co-borrower is a
 * non-guarantor member) wording, and a waiver is a no-op without a co-borrower.
 *
 * DB part (runs only with DATABASE_URL): the loan_exceptions lifecycle —
 * request → supersede-on-re-request → approve (guarded) → withdraw, plus
 * openForApp / pendingCount / getById joins.
 *
 *   node scripts/test-loan-exceptions.js
 *   DATABASE_URL=postgres://… node scripts/test-loan-exceptions.js
 */
const R = require('path').resolve(__dirname, '..');
const TO = require(R + '/src/lib/term-options');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

// ---------- PURE: guaranty wording ----------
(function pure() {
  const def = TO.guarantySummary({ borrowerName: 'A One', coBorrowerName: 'B Two', pgWaived: false });
  ok(def.waived === false, 'default: not waived');
  ok(def.guarantors.length === 2, 'default: both are guarantors');
  ok(/jointly and severally/i.test(def.recourseLine), 'default: joint & several wording');
  ok(/A One & B Two/.test(def.recourseLine), 'default: both names in the recourse line');
  ok(def.coSignerRole === 'Co-borrower / guarantor', 'default: co-borrower signs as guarantor');

  const w = TO.guarantySummary({ borrowerName: 'A One', coBorrowerName: 'B Two', pgWaived: true });
  ok(w.waived === true, 'waived: flagged');
  ok(w.guarantors.length === 1 && w.guarantors[0] === 'A One', 'waived: only the primary guarantees');
  ok(w.nonGuarantors.length === 1 && w.nonGuarantors[0] === 'B Two', 'waived: co-borrower is a non-guarantor');
  ok(/not a personal guarantor/i.test(w.recourseLine), 'waived: recourse line states the waiver');
  ok(/member of the borrowing entity/i.test(w.disclosureDetail), 'waived: disclosure keeps them a member');
  ok(w.coSignerRole === 'Co-borrower / member (non-guarantor)', 'waived: co-borrower signs as non-guarantor member');
  ok(/full recourse/i.test(w.recourseLine), 'waived: still full recourse (to the primary)');

  // A waiver with NO co-borrower is a no-op (nothing to waive).
  const s = TO.guarantySummary({ borrowerName: 'A One', coBorrowerName: '', pgWaived: true });
  ok(s.waived === false, 'single borrower: waiver is a no-op');
  ok(s.guarantors.length === 1, 'single borrower: one guarantor');
})();

(async function db() {
  if (!process.env.DATABASE_URL) { console.log('  ~~ SKIP loan_exceptions DB lifecycle (no DATABASE_URL)'); return; }
  const db = require(R + '/src/db');
  const LE = require(R + '/src/lib/loan-exceptions');
  const rnd = () => 'exc' + Math.random() + '@e.com';
  const b = await db.query("INSERT INTO borrowers(first_name,last_name,email) VALUES('A','One',$1) RETURNING id", [rnd()]);
  const cb = await db.query("INSERT INTO borrowers(first_name,last_name,email) VALUES('B','Two',$1) RETURNING id", [rnd()]);
  const app = await db.query('INSERT INTO applications(borrower_id,co_borrower_id) VALUES($1,$2) RETURNING id', [b.rows[0].id, cb.rows[0].id]);
  const appId = app.rows[0].id;

  // request
  let c = await db.getClient(); await c.query('BEGIN');
  const r1 = await LE.requestGuarantyWaiver(c, { appId, subjectBorrowerId: cb.rows[0].id, reasonCode: 'passive_member', reasonNote: 'minority', requestedBy: null });
  await c.query('COMMIT'); c.release();
  ok(r1.status === 'requested' && r1.reason_code === 'passive_member', 'request: created as requested with reason');
  ok(!!(await LE.openForApp(appId)), 'openForApp finds the open request');
  ok((await LE.pendingCount()) >= 1, 'pendingCount counts it');

  // an unknown reason code falls back to 'other'
  let c0 = await db.getClient(); await c0.query('BEGIN');
  const rBad = await LE.requestGuarantyWaiver(c0, { appId, subjectBorrowerId: cb.rows[0].id, reasonCode: 'not_a_code', reasonNote: 'x', requestedBy: null });
  await c0.query('COMMIT'); c0.release();
  ok(rBad.reason_code === 'other', 'unknown reason code falls back to other');
  // and it superseded r1 (one-open-per-file)
  const openRows = (await db.query("SELECT status FROM loan_exceptions WHERE application_id=$1 ORDER BY created_at", [appId])).rows.map((x) => x.status);
  ok(openRows.filter((s) => s === 'requested').length === 1, 're-request supersedes the prior open one (one open per file)');
  ok(openRows[0] === 'withdrawn', 'the superseded request is withdrawn');

  // approve (guarded)
  const dec = await LE.decideException(rBad.id, 'approved', null, 'ok');
  ok(dec && dec.status === 'approved', 'approve: flips to approved');
  ok((await LE.decideException(rBad.id, 'denied', null, 'x')) === null, 'approve: a decided row cannot be re-decided');
  ok((await LE.withdrawException(rBad.id, null)) === null, 'withdraw: a decided row cannot be withdrawn');

  // getById joins the file + subject + reason
  const g = await LE.getById(rBad.id);
  ok(g && g.subject_first === 'B' && g.type === 'guaranty_waiver', 'getById joins subject + type');

  // a fresh request can then be withdrawn while open
  let c2 = await db.getClient(); await c2.query('BEGIN');
  const r3 = await LE.requestGuarantyWaiver(c2, { appId, subjectBorrowerId: cb.rows[0].id, reasonCode: 'primary_strong', reasonNote: 'strong', requestedBy: null });
  await c2.query('COMMIT'); c2.release();
  const wd = await LE.withdrawException(r3.id, null);
  ok(wd && wd.status === 'withdrawn', 'withdraw: an open request withdraws');

  // list filters
  const openList = await LE.listExceptions({ status: 'open' });
  ok(Array.isArray(openList), 'listExceptions returns an array');

  // db/269 trigger: a co-borrower CHANGE resets the waiver flag + withdraws any
  // open request (the waiver named the OLD co-borrower and can't transfer).
  const cb2 = await db.query("INSERT INTO borrowers(first_name,last_name,email) VALUES('C','Two',$1) RETURNING id", [rnd()]);
  await db.query('UPDATE applications SET co_borrower_pg_waived=true WHERE id=$1', [appId]);
  let c9 = await db.getClient(); await c9.query('BEGIN');
  await LE.requestGuarantyWaiver(c9, { appId, subjectBorrowerId: cb.rows[0].id, reasonCode: 'other', reasonNote: 'x', requestedBy: null });
  await c9.query('COMMIT'); c9.release();
  await db.query('UPDATE applications SET co_borrower_id=$2 WHERE id=$1', [appId, cb2.rows[0].id]);   // swap co-borrower
  const swap = (await db.query('SELECT co_borrower_pg_waived FROM applications WHERE id=$1', [appId])).rows[0];
  ok(swap.co_borrower_pg_waived === false, 'co-borrower swap resets the waiver flag to false');
  ok((await LE.openForApp(appId)) === null, 'co-borrower swap withdraws the open guaranty-waiver request');
  // an unrelated applications update must NOT reset the flag
  await db.query('UPDATE applications SET co_borrower_pg_waived=true WHERE id=$1', [appId]);
  await db.query('UPDATE applications SET updated_at=now() WHERE id=$1', [appId]);
  ok((await db.query('SELECT co_borrower_pg_waived FROM applications WHERE id=$1', [appId])).rows[0].co_borrower_pg_waived === true,
     'an update that does not change the co-borrower keeps the flag');

  // db/270 clear + the requester queue (owner-directed 2026-07-22).
  const lo = await db.query("INSERT INTO staff_users(email,full_name,role,is_active) VALUES($1,'LO','loan_officer',true) RETURNING id", [rnd()]);
  const loId = lo.rows[0].id;
  const cb3 = await db.query("INSERT INTO borrowers(first_name,last_name,email) VALUES('E','Three',$1) RETURNING id", [rnd()]);
  const app2 = await db.query('INSERT INTO applications(borrower_id,co_borrower_id) VALUES($1,$2) RETURNING id', [b.rows[0].id, cb3.rows[0].id]);
  const app2Id = app2.rows[0].id;
  let cx = await db.getClient(); await cx.query('BEGIN');
  const rq = await LE.requestGuarantyWaiver(cx, { appId: app2Id, subjectBorrowerId: cb3.rows[0].id, reasonCode: 'passive_member', reasonNote: 'q', requestedBy: loId });
  await cx.query('COMMIT'); cx.release();
  ok((await LE.requesterOpenCount(loId)) === 1, 'requesterOpenCount counts the LO’s open request');
  const mine = await LE.listForRequester(loId, { status: 'open' });
  ok(mine.length === 1 && mine[0].id === rq.id && 'ys_loan_number' in mine[0], 'listForRequester returns the LO’s open request with file join');
  // approve then clear — the flag stays, clear is housekeeping only
  await LE.decideException(rq.id, 'approved', null, 'ok');
  await db.query('UPDATE applications SET co_borrower_pg_waived=true WHERE id=$1', [app2Id]);
  const cleared = await LE.clearException(rq.id, loId, 'handled');
  ok(cleared && cleared.status === 'cleared', 'clearException moves the row to cleared');
  ok((await db.query('SELECT co_borrower_pg_waived FROM applications WHERE id=$1', [app2Id])).rows[0].co_borrower_pg_waived === true,
     'clear does NOT un-waive an approved waiver');
  ok((await LE.clearException(rq.id, loId, 'x')) === null, 'a cleared row cannot be re-cleared');
  ok((await LE.requesterOpenCount(loId)) === 0, 'a cleared request drops out of the open count');
  // clearing a still-OPEN request frees the file for a new one (one-open index preserved)
  let cy = await db.getClient(); await cy.query('BEGIN');
  const rq2 = await LE.requestGuarantyWaiver(cy, { appId: app2Id, subjectBorrowerId: cb3.rows[0].id, reasonCode: 'other', reasonNote: 'y', requestedBy: loId });
  await cy.query('COMMIT'); cy.release();
  await LE.clearException(rq2.id, loId, 'nvm');
  let cz = await db.getClient(); await cz.query('BEGIN');
  const rq3 = await LE.requestGuarantyWaiver(cz, { appId: app2Id, subjectBorrowerId: cb3.rows[0].id, reasonCode: 'other', reasonNote: 'z', requestedBy: loId });
  await cz.query('COMMIT'); cz.release();
  ok(rq3 && rq3.status === 'requested', 'clearing an open request frees the file for a new request');

  // db/271 comments — the staff-only back-and-forth on an exception.
  const sa = await db.query("INSERT INTO staff_users(email,full_name,role,is_active) VALUES($1,'SA','super_admin',true) RETURNING id", [rnd()]);
  const saId = sa.rows[0].id;
  const cm1 = await LE.addComment(rq3.id, saId, 'Confirm primary net worth?');
  ok(cm1 && cm1.author_name === 'SA', 'addComment stores + returns the author name');
  await LE.addComment(rq3.id, loId, 'Statements show $2M liquid.');
  const list = await LE.listComments(rq3.id);
  ok(list.length === 2 && list[0].id === cm1.id, 'listComments returns oldest-first');
  const parts = await LE.commentParticipants(rq3.id);
  ok(parts.includes(saId) && parts.includes(loId), 'commentParticipants includes the requester + the commenting super-admin');
  ok(parts.filter((s) => s !== saId).includes(loId), 'a super-admin comment notifies the requester (LO)');
  let threw = false;
  try { await LE.addComment(rq3.id, saId, '   '); } catch (_) { threw = true; }
  ok(threw, 'an empty comment is rejected');

  // db/275 + db/276 — conditions / documents attached to an exception (owner-directed 2026-07-22).
  // origin_kind='exception' is exactly what the conditions/custom route stamps for a tagged
  // condition — inserting it here proves db/276 widened chk_items_origin_kind (else 23514).
  const ciDoc = await db.query(
    `INSERT INTO checklist_items (scope,application_id,label,borrower_label,audience,item_kind,status,loan_exception_id,origin_kind,created_by_kind)
     VALUES ('application',$1,'Net worth statement','Net worth statement','borrower','document','received',$2,'exception','staff') RETURNING id`,
    [app2Id, rq3.id]);
  await db.query(
    `INSERT INTO documents (checklist_item_id,application_id,filename,content_type,storage_provider)
     VALUES ($1,$2,'networth.pdf','application/pdf','local')`, [ciDoc.rows[0].id, app2Id]);
  const conds = await LE.listConditions(rq3.id);
  ok(conds.length === 1 && conds[0].id === ciDoc.rows[0].id, 'listConditions returns the tagged condition');
  ok(conds[0].documents.length === 1 && conds[0].documents[0].filename === 'networth.pdf', 'listConditions attaches the uploaded document to its condition');
  ok((await LE.listConditions(rBad.id)).length === 0, 'an exception with no tagged conditions returns []');
  // ON DELETE SET NULL: deleting the exception detaches the tag but keeps the condition + its document.
  await db.query(`DELETE FROM loan_exceptions WHERE id=$1`, [rq3.id]);
  ok((await db.query('SELECT loan_exception_id FROM checklist_items WHERE id=$1', [ciDoc.rows[0].id])).rows[0].loan_exception_id === null,
     'deleting an exception detaches its conditions (SET NULL) — the condition + document survive');
  ok((await db.query('SELECT 1 FROM documents WHERE checklist_item_id=$1', [ciDoc.rows[0].id])).rows.length === 1,
     'the uploaded document is never destroyed by clearing an exception');

  // db/284 — send-before-clear-to-close exception (owner-directed 2026-07-23). A
  // NEW exception_type on the same queue (proves the CHECK was widened, else 23514),
  // with its own reason codes and no subject borrower.
  ok(LE.isEsignReasonCode('review_pending') === true && LE.isEsignReasonCode('passive_member') === false,
     'esign reason codes are their own set (guaranty codes are not valid here)');
  ok(LE.reasonCodesFor('esign_before_ctc') !== LE.REASON_CODES, 'reasonCodesFor returns the esign set for the esign type');
  const app3 = await db.query('INSERT INTO applications(borrower_id) VALUES($1) RETURNING id', [b.rows[0].id]);
  const app3Id = app3.rows[0].id;
  let ce = await db.getClient(); await ce.query('BEGIN');
  const e1 = await LE.requestEsignBeforeCtc(ce, { appId: app3Id, reasonCode: 'review_pending', reasonNote: 'appraisal review pending', requestedBy: loId });
  await ce.query('COMMIT'); ce.release();
  ok(e1.exception_type === 'esign_before_ctc' && e1.status === 'requested' && e1.subject_borrower_id === null,
     'requestEsignBeforeCtc inserts an esign_before_ctc row with no subject borrower');
  ok((await LE.latestEsignBeforeCtc(app3Id)) && (await LE.latestEsignBeforeCtc(app3Id)).id === e1.id, 'latestEsignBeforeCtc finds it');
  ok((await LE.openForApp(app3Id, 'esign_before_ctc')) && (await LE.openForApp(app3Id)) === null,
     'openForApp is per-type: the esign request is open, but there is no open guaranty_waiver');
  // an unknown reason code falls back to 'other'
  let ce2 = await db.getClient(); await ce2.query('BEGIN');
  const e2 = await LE.requestEsignBeforeCtc(ce2, { appId: app3Id, reasonCode: 'not_a_real_code', reasonNote: 'y', requestedBy: loId });
  await ce2.query('COMMIT'); ce2.release();
  ok(e2.reason_code === 'other', 'unknown esign reason code falls back to other');
  ok((await LE.latestEsignBeforeCtc(app3Id)).id === e2.id, 're-request supersedes the prior open esign request');
  // approve → latest is approved (this is exactly what the send-gate reads)
  const eDec = await LE.decideException(e2.id, 'approved', saId, 'ok to send early');
  ok(eDec && eDec.status === 'approved', 'an esign_before_ctc exception approves');
  ok((await LE.latestEsignBeforeCtc(app3Id)).status === 'approved', 'the approved row is the latest — the send-gate will read it');
  // getById carries the per-type reason label
  const eById = await LE.getById(e1.id);
  ok(eById && eById.reason_label === LE.ESIGN_BEFORE_CTC_REASONS.review_pending, 'getById attaches the per-type reason_label');
  // the review box lists BOTH types
  const allOpen = await LE.listExceptions({ status: 'all' });
  ok(allOpen.some((x) => x.exception_type === 'esign_before_ctc') && allOpen.some((x) => x.exception_type === 'guaranty_waiver'),
     'listExceptions returns both exception types on one queue');

  await db.pool.end();
})().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(2); });
