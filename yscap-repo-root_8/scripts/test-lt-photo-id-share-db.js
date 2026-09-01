#!/usr/bin/env node
'use strict';
/**
 * A GOVERNMENT PHOTO ID IS ONE PERSON'S, NOT ONE PRODUCT'S.
 *
 * Owner-directed 2026-08-31, answering two open questions in one sentence:
 * *"Basically, share the same condition: If he uploads it on the long term, it
 * should share it to the short term. If it's uploaded to the short term, it
 * should share it to the long term. It's on the profiles and the borrower
 * profile."*
 *
 * ── WHAT THIS HAS TO PROVE, AND WHY EACH HALF NEEDS ITS OWN CHECK ───────────
 *
 * The READ half already worked before any of this: the ID lives on
 * `borrowers.photo_id_document_id`, and both products read that column. So a
 * suite that only asked "does the long-term screen show the ID?" would have
 * passed before the change and after it, and proved nothing.
 *
 * The two halves that were genuinely missing are asserted separately because
 * they fail separately:
 *
 *   A. A long-term upload never reached the profile at all.
 *   B. A new ID reopened SHORT-TERM conditions only, so a long-term condition
 *      kept a sign-off that attested to an ID which had been replaced.
 *
 * And the direction that is easiest to get silently wrong is B travelling the
 * OTHER way — a SHORT-TERM upload reopening a LONG-TERM condition — because
 * nothing in that path touches long-term code, so the finder has to have been
 * registered by then. Section D is that case, and it is the one a lazy require
 * would break while every other check stayed green.
 *
 * SOURCE GUARDS, because no behaviour test can see an unwired door: a module
 * nobody calls is not a feature, which is this repo's own repeated lesson.
 *
 * Named `test-lt-…` because it writes to `lt_loans` and imports Long-Term code —
 * the separation gate reads a filename as a product identity.
 *
 *   DATABASE_URL=... node scripts/test-lt-photo-id-share-db.js
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const db = require(path.join(ROOT, 'src/db'));
const { ensureSchema } = require(path.join(ROOT, 'src/migrate-boot'));

let n = 0; let failed = 0;
const ok = (cond, msg) => { n++; if (cond) console.log(`  ok   ${msg}`); else { failed++; console.log(`  FAIL ${msg}`); } };
const eq = (a, b, msg) => ok(Object.is(a, b), `${msg} (got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)})`);

/** Never let an assertion CRASH the battery — a crash reports a pass rate that means nothing. */
async function run(fn, msg) {
  try { return await fn(); } catch (e) { n++; failed++; console.log(`  FAIL ${msg} — threw: ${(e && e.message) || e}`); return null; }
}

const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

(async () => {
  if (!process.env.DATABASE_URL) { console.log('SKIP — no DATABASE_URL'); process.exit(0); }
  await ensureSchema();

  // Requiring the Long-Term ROUTER is what registers its finder — exactly as
  // src/server.js mounting it does. Doing it here rather than requiring the
  // share module directly is deliberate: it proves the registration really does
  // ride on the existing seam.
  require(path.join(ROOT, 'src/longterm'));
  const profilePhotoId = require(path.join(ROOT, 'src/lib/profile-photo-id'));
  const share = require(path.join(ROOT, 'src/longterm/conditions-center/photo-id-share'));

  console.log('A. the two products both said where their ID conditions are');
  ok(profilePhotoId.registeredReopeners().includes('lt_loan'),
    'mounting the long-term router registers its finder — so a SHORT-TERM upload can reach it');

  // ── fixtures ───────────────────────────────────────────────────────────────
  const tag = crypto.randomUUID().slice(0, 8);
  const borrower = (await db.query(
    `INSERT INTO borrowers (first_name, last_name, email) VALUES ('Ida','Probe',$1) RETURNING id`,
    [`idshare-${tag}@example.test`])).rows[0].id;
  const other = (await db.query(
    `INSERT INTO borrowers (first_name, last_name, email) VALUES ('Otto','Probe',$1) RETURNING id`,
    [`idshare-other-${tag}@example.test`])).rows[0].id;

  const mkApp = async (bid) => (await db.query(
    `INSERT INTO applications (borrower_id, status, program, loan_type)
     VALUES ($1::uuid,'file_intake','Standard Program','Purchase') RETURNING id`, [bid])).rows[0].id;
  const app = await mkApp(borrower);
  const otherApp = await mkApp(other);

  const loan = crypto.randomUUID();
  await db.query(
    `INSERT INTO lt_loans (id, borrower_id, loan_number, program_name) VALUES ($1::uuid,$2::uuid,$3,'DSCR 30yr')`,
    [loan, borrower, `IDSHARE-${tag}`]);
  const orphanLoan = crypto.randomUUID();
  await db.query(
    `INSERT INTO lt_loans (id, loan_number, program_name) VALUES ($1::uuid,$2,'DSCR 30yr')`,
    [orphanLoan, `IDORPHAN-${tag}`]);

  // The long-term library seeds itself the first time anything asks for it, and
  // `lt_photo_id` is one of its own rows — read, never invented here.
  await require(path.join(ROOT, 'src/longterm/conditions-center/library')).ensureSeeded(db);
  const tplId = async (code) => {
    const r = await db.query(`SELECT id FROM checklist_templates WHERE code=$1`, [code]);
    return r.rows[0] ? r.rows[0].id : null;
  };
  const ltTpl = await tplId('lt_photo_id');
  const rtlTpl = await tplId('rtl_p1_id');
  const profTpl = await tplId('gov_id');
  ok(!!ltTpl && !!rtlTpl && !!profTpl,
    'the three government-ID conditions exist: the long-term one, the short-term one, and the person’s own');

  /** A condition that has been SIGNED OFF — the state the reopen has to undo. */
  const signedOff = async (scope, col, owner, templateId, label) => (await db.query(
    `INSERT INTO checklist_items (scope, ${col}, template_id, category, label, audience, status,
                                  item_kind, is_required, signed_off_at, signed_off_by, reviewed_at)
     VALUES ($1,$2::uuid,$3::uuid,'prior_to_approval',$4,'staff','satisfied','document',true,
             now(), NULL, now()) RETURNING id`,
    [scope, owner, templateId, label])).rows[0].id;

  const stateOf = async (id) => (await db.query(
    `SELECT status, signed_off_at, reviewed_at FROM checklist_items WHERE id=$1`, [id])).rows[0];

  const mkDoc = async (name) => (await db.query(
    `INSERT INTO documents (borrower_id, filename, content_type, size_bytes, storage_provider, storage_ref,
                            uploaded_by_kind, uploaded_by_id, doc_kind)
     VALUES ($1::uuid,$2,'image/jpeg',1234,'local',$3,'borrower',$1::uuid,'photo_id') RETURNING id`,
    [borrower, name, `probe/${crypto.randomUUID()}`])).rows[0].id;

  const ltItem = await signedOff('lt_loan', 'lt_loan_id', loan, ltTpl, 'LT photo ID');
  const rtlItem = await signedOff('application', 'application_id', app, rtlTpl, 'RTL photo ID');
  const profItem = await signedOff('borrower_profile', 'borrower_id', borrower, profTpl, 'Profile photo ID');
  const strangerItem = await signedOff('application', 'application_id', otherApp, rtlTpl, 'Someone else’s photo ID');

  // ────────────────────────────────────────────────────────────────────────────
  console.log('\nB. AN ID GIVEN ON THE LONG TERM BECOMES THE PERSON’S — and the short term sees it');
  const ltDoc = await mkDoc('licence-from-the-long-term.jpg');
  const r1 = await run(() => share.adoptFromLoan({
    loanId: loan, documentId: ltDoc, conditionCode: 'lt_photo_id', q: db }), 'the long-term upload is adopted');
  ok(r1 && r1.adopted === true, 'a photo ID uploaded on a long-term loan is recorded on the borrower’s profile');
  const stamped = (await db.query(`SELECT photo_id_document_id FROM borrowers WHERE id=$1`, [borrower])).rows[0];
  eq(String(stamped.photo_id_document_id), String(ltDoc),
    '…and the profile now points at THAT document, so the short-term side reads the same ID');

  const rtlAfter = await stateOf(rtlItem);
  eq(rtlAfter.status, 'received', 'the SHORT-TERM ID condition came back for review');
  eq(rtlAfter.signed_off_at, null, '…and its sign-off is gone — it attested to the ID that was just replaced');
  const profAfter = await stateOf(profItem);
  eq(profAfter.status, 'received', 'the PERSON’S OWN ID condition came back too — "it’s on the profiles"');
  const strangerAfter = await stateOf(strangerItem);
  eq(strangerAfter.status, 'satisfied', 'another borrower’s file is untouched — this is one person’s ID, not everyone’s');

  // ────────────────────────────────────────────────────────────────────────────
  console.log('\nC. …AND THE LONG-TERM CONDITION ITSELF REOPENS on the same act');
  const ltAfter = await stateOf(ltItem);
  eq(ltAfter.status, 'received', 'the long-term ID condition is back for review');
  eq(ltAfter.signed_off_at, null, '…with its sign-off dropped, exactly as the short-term one has always behaved');

  // ────────────────────────────────────────────────────────────────────────────
  console.log('\nD. THE OTHER DIRECTION — an ID given on the SHORT TERM reaches the long term');
  // Put every condition back to signed-off, so what follows can only be caused
  // by this second act and not left over from the first.
  for (const id of [ltItem, rtlItem, profItem]) {
    await db.query(`UPDATE checklist_items SET status='satisfied', signed_off_at=now(), reviewed_at=now() WHERE id=$1`, [id]);
  }
  const rtlDoc = await mkDoc('licence-from-the-short-term.jpg');
  const r2 = await run(() => profilePhotoId.adopt({ borrowerId: borrower, documentId: rtlDoc, q: db }),
    'the short-term profile upload is adopted');
  ok(r2 && r2.stamped === true, 'a photo ID given on the short-term side is recorded on the profile');
  eq(JSON.stringify(r2 && r2.failed), '[]', '…and no product’s finder failed');
  ok(r2 && r2.reopened && r2.reopened.lt_loan >= 1,
    'the LONG-TERM ID condition was found and reopened by a short-term upload — the direction that needs the registration');
  eq((await stateOf(ltItem)).status, 'received', '…and it really is back for review on the long-term file');
  eq((await stateOf(ltItem)).signed_off_at, null, '…with the sign-off that attested to the old ID dropped');
  eq((await stateOf(rtlItem)).status, 'received', 'the short-term condition reopens exactly as it always did');

  // ────────────────────────────────────────────────────────────────────────────
  console.log('\nE. IT NEVER DECIDES THAT SOME OTHER DOCUMENT IS THE PERSON’S ID');
  const before = (await db.query(`SELECT photo_id_document_id FROM borrowers WHERE id=$1`, [borrower])).rows[0].photo_id_document_id;
  const otherDoc = await mkDoc('a-bank-statement.pdf');
  const r3 = await run(() => share.adoptFromLoan({
    loanId: loan, documentId: otherDoc, conditionCode: 'lt_bank_statements', q: db }), 'a non-ID condition is refused');
  ok(r3 && r3.adopted === false && r3.why === 'not_the_photo_id_condition',
    'a document on any OTHER long-term condition is never adopted as the ID');
  eq(String((await db.query(`SELECT photo_id_document_id FROM borrowers WHERE id=$1`, [borrower])).rows[0].photo_id_document_id),
    String(before), '…and the person’s ID of record is exactly what it was');

  console.log('\nF. A LOAN WITH NOBODY ON IT IS REPORTED, NEVER CRASHED');
  const r4 = await run(() => share.adoptFromLoan({
    loanId: orphanLoan, documentId: rtlDoc, conditionCode: 'lt_photo_id', q: db }), 'an unlinked loan answers');
  ok(r4 && r4.adopted === false && r4.why === 'loan_has_no_borrower_profile',
    'a long-term loan with no borrower linked says so — the document is still filed, there is just nowhere to keep the ID');

  console.log('\nG. ONE PRODUCT’S REOPEN FAILING NEVER COSTS THE OTHER ITS ID');
  const finders = profilePhotoId._internals.reopeners;
  const realLt = finders.get('lt_loan');
  finders.set('lt_loan', async () => { throw new Error('long-term is unreachable just now'); });
  await db.query(`UPDATE checklist_items SET status='satisfied', signed_off_at=now() WHERE id=$1`, [rtlItem]);
  const brokenDoc = await mkDoc('licence-while-the-other-side-is-down.jpg');
  const r5 = await run(() => profilePhotoId.adopt({ borrowerId: borrower, documentId: brokenDoc, q: db }),
    'the adopt survives a broken finder');
  ok(r5 && r5.stamped === true, 'the ID is still recorded on the person');
  eq((await stateOf(rtlItem)).status, 'received', '…and the short-term condition still reopens');
  ok(r5 && r5.failed.length === 1 && r5.failed[0].product === 'lt_loan',
    '…and the product that could not be reached is NAMED rather than silently skipped');
  finders.set('lt_loan', realLt);

  // ────────────────────────────────────────────────────────────────────────────
  console.log('\nH. THE DOORS ACTUALLY CALL IT — a module nobody calls is not a feature');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  const rtlDoor = strip(src('src/routes/borrower.js'));
  ok(/require\(['"]\.\.\/lib\/profile-photo-id['"]\)\.adopt\(/.test(rtlDoor),
    'the short-term profile door goes through the ONE shared definition');
  /* SCOPED TO THIS DOOR'S OWN HANDLER, and both loosenings that got there first
     are worth remembering. Naming `rtl_p1_id` does not make something a reopen —
     this file legitimately names it twice more, to link an upload to a file's
     condition and to mark a NEW file's condition 'received' from an ID already
     on the profile, and neither touches a sign-off. And clearing a sign-off does
     not make something THIS reopen — the file carries two others, about other
     conditions entirely. What has to be absent is a reopen inside the photo-ID
     handler, so the handler is what is read. */
  const photoDoor = (rtlDoor.split("router.post('/profile/photo-id'")[1] || '').split('\nrouter.')[0];
  ok(photoDoor.length > 200, 'the photo-ID handler was found to read (a guard that reads nothing proves nothing)');
  ok(!/signed_off_at\s*=\s*NULL/i.test(photoDoor),
    '…and no longer carries its own copy of the reopen — the sign-off is dropped in the shared module, nowhere else');
  /* PIN THE GUARD CLAUSE, NOT JUST THE CALL. A first cut asked only whether the
     call appeared anywhere in the file, and a mutation that wrapped it in
     `if (false)` — leaving the text exactly where it was — sailed straight
     through. What has to be true is that the adopt is what runs on a real
     landing, so the `if (!landed.deduped)` and the call are read together. */
  for (const f of ['src/longterm/routes/condition-center.js', 'src/longterm/routes/my-conditions.js']) {
    ok(/if\s*\(!landed\.deduped\)\s*\{\s*\n\s*profile\s*=\s*await\s+require\(['"][^'"]*photo-id-share['"]\)\.adoptFromLoan\(/
      .test(strip(src(f))),
    `${f.split('/').pop()} adopts a long-term photo ID onto the profile, on every real landing`);
  }
  ok(/require\(['"]\.\/conditions-center\/photo-id-share['"]\)/.test(strip(src('src/longterm/index.js'))),
    'the long-term router registers its finder on load — not lazily, or the short-term direction would go dark');

  if (failed) { console.log(`\n${failed} of ${n} checks FAILED`); process.exit(1); }
  console.log(`\nall passed (${n})`);
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
