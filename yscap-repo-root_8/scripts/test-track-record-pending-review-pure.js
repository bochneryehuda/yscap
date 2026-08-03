'use strict';
/**
 * A TRACK RECORD SOMEBODY TYPED IS PENDING REVIEW (owner-directed 2026-08-03),
 * proven with no database.
 *
 * The report: "The borrower entered his entire track record, and everything came
 * back as verified already … it should go to the processing queue to review the
 * track record that the borrower imported, and this should be pending review …
 * anyone that enters the track record first should be pending review till they
 * review it and they provide documentation, then it should go for verified."
 *
 * TWO HALVES, and this file guards both:
 *   (1) THE DATA. No door may leave a borrower-typed line reading as reviewed,
 *       and every door records WHO typed it (db/458) — the fact that made a
 *       review queue impossible to write before.
 *   (2) WHAT THE BORROWER IS TOLD. Nothing was ever marked verified in the
 *       database; what said "it went through" was the tool's own headline, which
 *       ranked the portfolio and counted qualifying exits off unreviewed typing
 *       and never once used the word review.
 *
 * THE PROPERTY THAT MUST NOT REGRESS: `is_verified` is written by exactly ONE
 * place — the audited staff verify route. A well-meaning "reset it on edit" in a
 * tool door would silently revoke a verification a human recorded, with no
 * reason and no notice to the borrower.
 */
const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };

const borrower = read('src', 'routes', 'borrower.js');
const staff = read('src', 'routes', 'staff.js');
const sql = read('db', '458_track_record_entry_review.sql');
const tool = read('web', 'v2', 'tools', 'track-record.js');

console.log('\nA. the schema can finally express "self-reported, waiting on us"');

ok(/ADD COLUMN IF NOT EXISTS entered_by_kind text/.test(sql), 'entered_by_kind is added');
ok(/ADD COLUMN IF NOT EXISTS entered_at\s+timestamptz/.test(sql), 'entered_at is added');
ok(/track_records_entered_by_kind_check/.test(sql)
  && /'borrower','staff','clickup','encompass','system'/.test(sql),
  'the kind is a closed set — a typo can never become a new kind of author');
// A row PILOT imported is not somebody's work list; a row from before db/458 has
// no recorded author and must not be guessed into one.
ok(/origin LIKE 'clickup%'/.test(sql) && /origin = 'encompass'/.test(sql),
  'previous rows take their kind from the origin the importers already stamp');
ok(/origin NOT IN \('portal', ''\)/.test(sql),
  "…and a plain 'portal' row stays NULL — nobody recorded WHICH human typed it, so it is not guessed");
ok(/WHERE entered_by_kind = 'borrower' AND is_verified = false/.test(sql),
  'the queue\'s exact question is indexed');
ok(/entered_by_kind IS NULL/.test(sql), 'the backfill is idempotent — it only fills a blank');

console.log('\nB. every door records who typed it, and a borrower edit is PENDING again');

ok(/function trackRecordEnteredCols\(kind\)/.test(borrower),
  'ONE helper decides what "somebody just typed this" writes');
{
  const helper = borrower.slice(borrower.indexOf('function trackRecordEnteredCols'), borrower.indexOf('function trackRecordEnteredCols') + 400);
  ok(/entered_by_kind: kind/.test(helper) && /entered_at:/.test(helper), 'it stamps who and when');
  ok(/if \(kind === 'borrower'\) cols\.verification_status = 'pending'/.test(helper),
    'a BORROWER write resets the line to pending review');
  /* THE STAFF DOOR DELIBERATELY DOES NOT RESET. A staffer may correct a VERIFIED
     line's figures; writing 'pending' over that leaves the row claiming both at
     once — verification_status 'pending' next to is_verified true — which every
     count reads as verified and every screen reads as pending. */
  ok(!/verification_status: 'pending'/.test(helper.replace(/if \(kind === 'borrower'\)[^\n]*\n/, '')),
    "…and only the borrower's, so a staff correction can't leave a row claiming pending AND verified");
}
{
  // Both borrower doors (create + edit) and the staff door must go through it —
  // guarding two of three leaves a way in that keeps a stale verdict.
  const inBorrower = (borrower.match(/trackRecordEnteredCols\('borrower'\)/g) || []).length;
  ok(inBorrower === 2, `both borrower doors stamp it — create and edit (found ${inBorrower})`);
  ok(/trackRecordEnteredCols\('staff'\)/.test(staff), 'the staff door stamps it too');
}

console.log('\nC. `is_verified` still has exactly ONE writer — the audited verify route');

{
  /* Anything that flips the flag outside that route is a silent verification (or
     a silent revocation) with no reason and no notice to the borrower. Each
     `UPDATE track_records SET …` is read as its OWN statement — bounded by the
     backtick that closes its template literal — because a `[^;]*` window walks
     straight across into the NEXT query and reads its `is_verified=true` as this
     one's. */
  const statements = (src) => (src.match(/UPDATE track_records SET[\s\S]*?`/g) || []);
  // Only the SET clause decides what is WRITTEN. `WHERE … is_verified=true` is a
  // filter (the document-rejection paths legitimately revoke a verification, and
  // scope themselves to rows that HAVE one) and must not be read as a write.
  const setClause = (q) => q.slice(q.indexOf('SET') + 3).split(/\bWHERE\b/)[0];
  ok(/verification_status=\$3,\s*\n\s*is_verified=\$4/.test(staff),
    'the verify route sets the status and the flag together, from one decision');
  const staffStmts = statements(staff);
  ok(staffStmts.length > 0, 'the track-record write statements were actually found (sanity)');
  const verifying = staffStmts.filter((q) => /is_verified\s*=\s*true/.test(setClause(q)));
  ok(verifying.length === 0,
    `no track-record UPDATE sets is_verified true outside the parameterised verify route (found ${verifying.length})`);
  // Rejecting a document a verification stood on DOES revoke it — that direction
  // is safe and must keep working.
  ok(staffStmts.some((q) => /is_verified=false/.test(setClause(q)) && /verification_status='docs'/.test(setClause(q))),
    'rejecting the evidence still un-verifies the line');
  ok(statements(borrower).every((q) => !/is_verified\s*=/.test(setClause(q))),
    '…and no borrower door writes the flag at all');
}
{
  // The borrower is structurally locked out of a verified line — which is what
  // makes the pending reset above safe.
  ok(/ON CONFLICT \(borrower_id, client_row_id\)[\s\S]{0,200}WHERE track_records\.is_verified = false/.test(borrower),
    'the borrower create/upsert cannot touch a verified line');
  ok(/WHERE id=\$1 AND borrower_id=\$2 AND is_verified=false/.test(borrower),
    '…nor the borrower edit');
}

console.log('\nD. the processing queue — what is waiting on us');

{
  const q = staff.slice(staff.indexOf("router.get('/track-record-reviews'"));
  ok(q.length > 0, 'the review queue exists');
  const body = q.slice(0, 2500);
  // The question itself lives in ONE constant that both the list and the badge
  // interpolate — asserted where it is DEFINED, not where it is used.
  const where = staff.match(/const TR_REVIEW_WHERE = "([^"]+)"/);
  ok(!!where, 'the queue has ONE definition of what is waiting');
  ok(/entered_by_kind = 'borrower'/.test(where ? where[1] : ''), 'it lists what a BORROWER typed');
  ok(/is_verified = false/.test(where ? where[1] : ''), '…that nobody has verified');
  ok(/VISIBLE_BORROWER_SQL\('b'/.test(body),
    'scoped the BORROWER way — a track record hangs on a person, not a loan file');
  ok(/seesAllBorrowers\(req\)/.test(body), '…with the whole desk for admins / underwriters / processors');
  ok(/doc_count/.test(body), 'each line says whether documentation has arrived — the thing being reviewed');
  // The reviewer opens the documents and acts from the queue, so the rows must
  // carry the documents themselves AND a live file (a document request becomes a
  // condition ON a file — with none there is nowhere to put it).
  ok(/AS docs/.test(body), '…and the documents themselves, so they can be opened from the queue');
  ok(/AS files/.test(body), '…and a live loan file, so a document can actually be requested');

  // The badge and the list must answer the SAME question — two definitions is
  // how a tab reading "3" opens onto an empty screen.
  const c = staff.slice(staff.indexOf("router.get('/track-record-reviews/count'"));
  ok(c.length > 0, 'the badge count endpoint exists');
  ok(/TR_REVIEW_WHERE/.test(c.slice(0, 1200)) && /TR_REVIEW_WHERE/.test(body),
    'both read ONE definition of what is waiting');
  ok(/res\.json\(\{ pending: 0 \}\)/.test(c.slice(0, 1200)),
    'the count never errors out to the caller — a badge must not break the hub\'s poll');
}

console.log('\nD2. the queue has a SCREEN, in the hub for things waiting on a decision');

{
  const screen = read('app-v2', 'src', 'screens', 'StaffTrackRecordReviews.jsx');
  const hub = read('app-v2', 'src', 'screens', 'StaffApprovals.jsx');
  const layout = read('app-v2', 'src', 'components', 'StaffLayout.jsx');
  ok(/staffTrackRecordReviews\(\)/.test(screen), 'the screen reads the queue');
  ok(/staffVerifyTrackRecord\(/.test(screen), '…and sets a verdict through the ONE audited verify route');
  ok(/staffRequestTrackRecordDoc\(/.test(screen), '…and can ask for the documentation that is missing');
  // The refusals here are real underwriting rules (no exit, a stale exit, not a
  // processor) and each names the way forward — summarising them loses that.
  ok(/e && e\.message/.test(screen), '…and shows the server\'s own refusal wording, never a summary');
  ok(/mayVerify/.test(screen) && /sign_off_conditions/.test(screen),
    'verifying is offered only to a processor — the same rule the route enforces');
  ok(/StaffTrackRecordReviews/.test(hub) && /'track-record'/.test(hub),
    'it is a TAB of the Approvals hub, not another top-level nav link');
  ok(/staffTrackRecordReviewsCount/.test(hub) && /staffTrackRecordReviewsCount/.test(layout),
    'both the tab badge and the one Approvals nav badge count it');
  ok(/\+ trReviewCount/.test(layout), '…so the nav badge total includes what is waiting here');
}

console.log('\nE. the borrower is never told a self-reported deal went through');

{
  ok(/function inPortal\(\)/.test(tool),
    'the tool knows whether it is inside a real loan file (the marketing copy has nobody to review anything)');
  ok(/self-reported/i.test(tool), 'the ranking says it is self-reported');
  ok(/verifies each deal/i.test(tool), '…and who verifies it');
  ok(/waiting on our review|waiting for your loan team to review/i.test(tool),
    '…and how many are still waiting');
  ok(/"Verified by your loan team"/.test(tool), 'a tile counts what has actually been verified');
  /* THE FROZEN 3-YEAR EXIT WINDOW IS UNTOUCHED — this change is about what the
     count is CALLED, never about which deals count (frozen baseline 2026-07-07). */
  ok(/const EXIT_WINDOW_MO=36;/.test(tool), 'the frozen experience window is unchanged');
  ok(/return ma!=null && ma>=0 && ma<=EXIT_WINDOW_MO;/.test(tool),
    'qualifies() is byte-for-byte the frozen rule');
}

console.log(fail
  ? `\n${fail} FAILURE(S)`
  : '\nOK  track-record: typed means pending, every door records who typed it, and only the verify route verifies');
process.exit(fail ? 1 : 0);
