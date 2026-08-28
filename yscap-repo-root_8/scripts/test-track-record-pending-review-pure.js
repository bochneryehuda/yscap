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
  /* EVERY WRITE RESETS THE LINE, WHOEVER TYPED IT (owner-directed 2026-08-07: "There
     should not even be a single thing where somebody entered their track record that
     should come up as verified… no matter how you enter it").
     This used to read `if (kind === 'borrower')`, and the reason recorded here was a
     REAL one worth keeping: writing 'pending' while leaving `is_verified` true leaves
     the row claiming BOTH at once — pending on every screen, verified in every count.
     The answer is not to skip the reset for staff; it is to write BOTH halves, which is
     what the helper now does, so the contradiction it warned about is impossible. */
  ok(!/kind === 'borrower'/.test(helper),
    'no per-actor branch — a helper that takes the actor and behaves differently is two rules, not one');
  ok(/verification_status: 'pending'/.test(helper),
    'EVERY write — borrower or staff — resets the line to pending review');
  ok(/is_verified: false/.test(helper),
    "…and clears is_verified in the same breath, so a row can never claim pending AND verified");
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

/* THE SCREEN CHANGED, THE REQUIREMENTS DID NOT. `StaffTrackRecordReviews` was
   replaced on 2026-08-09 by `StaffTrackRecordWorkspace` — the owner's "two
   stacked track records, combine into ONE". Every assertion below is the SAME
   property re-pointed at the screen that now carries it; none is relaxed. If a
   future screen replaces this one, do the same rather than deleting a line. */
{
  const screen = read('app-v2', 'src', 'screens', 'StaffTrackRecordWorkspace.jsx');
  /* THE PER-LINE WORK MOVED INTO A SHARED COMPONENT (owner-directed 2026-08-09,
     "one screen, everything"): the workspace renders <LineDetail>, the SAME
     component the inline Track Record Center renders, so the full screen and the
     default screen can never drift. The verdict + request-doc capabilities are
     therefore asserted on the component that now carries them, and the workspace
     is proven to MOUNT it — the property is intact, only its home moved. This is
     the "re-point, do not relax" rule the D2 header states, applied to a
     component extraction instead of a screen swap. */
  const detail = read('app-v2', 'src', 'components', 'track-record', 'LineDetail.jsx');
  /* COMMENTS STRIPPED — the hub's own note explaining why the tab went spells
     out the route, so a grep over the raw file matches the PROSE and would
     pass with the link deleted. Read code, never prose. */
  const hub = read('app-v2', 'src', 'screens', 'StaffApprovals.jsx')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const layout = read('app-v2', 'src', 'components', 'StaffLayout.jsx');
  ok(/staffTrackRecordWorkspace\(/.test(screen), 'the screen reads the queue');
  ok(/<LineDetail\b/.test(screen),
    '…and renders the shared per-line detail, so the full screen and the inline center can never drift');
  ok(/staffVerifyTrackRecord\(/.test(detail), '…and sets a verdict through the ONE audited verify route');
  ok(/staffRequestTrackRecordDoc/.test(detail), '…and can ask for the documentation that is missing');
  // The refusals here are real underwriting rules (no exit, a stale exit, not a
  // processor) and each names the way forward — summarising them loses that.
  ok(/e && e\.message/.test(detail), '…and shows the server\'s own refusal wording, never a summary');
  ok(/maySignOff/.test(detail) && /sign_off_conditions/.test(screen),
    'verifying is offered only to somebody with sign-off — the same rule the route enforces');
  /* IT MOVED OUT OF THE HUB, AND THE REQUIREMENT DID NOT — re-pointed, not
     relaxed, exactly as this section's header says to do. The owner took the
     tab out on 2026-08-26 ("I don't know why the admin has a section for track
     record verification. I don't know where it's coming into play in the
     approvals section"), so asserting the TAB now pins a decision they
     reversed. What the line was ever protecting is two things, and both are
     asserted below on the surfaces that now carry them: the queue has a screen
     you can actually reach, and reaching it did not cost another top-level nav
     link. The third assertion is the one the move made necessary — the hub
     still counts these in its badge, so it must still SAY so and offer a way
     through, or the badge counts work you cannot get to from it. */
  const app = read('app-v2', 'src', 'App.jsx');
  ok(/path="\/internal\/track-record"/.test(app) && /StaffTrackRecordWorkspace/.test(app),
    'it has its own full-screen route, so the queue is reachable on its own');
  ok(!/to="\/internal\/track-record"/.test(layout),
    '…and that did not cost another top-level nav link');
  /* THE ANCHOR, not merely the string. The hub carries this route TWICE — the
     old-bookmark redirect and the signpost — so a bare substring test is
     satisfied by the redirect and passes with the link deleted. Proven: the
     loose version survived its own mutation. */
  ok(/href="#\/internal\/track-record"/.test(hub) && /counts\['track-record'\]/.test(hub),
    '…and the Approvals hub, whose badge still counts these, says how many are waiting and links to them');
  ok(/requested === 'track-record'/.test(hub),
    '…so an old ?tab=track-record bookmark still lands on the screen that owns it');
  ok(!/StaffTrackRecordReviews/.test(hub),
    '…and the screen it replaced is not mounted alongside it — two of them is the complaint this rebuild started from');
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
