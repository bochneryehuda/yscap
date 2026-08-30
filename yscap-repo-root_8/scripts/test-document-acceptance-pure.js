/**
 * "ACCEPTED" IS ONE DEFINITION, AND EVERY OUTBOUND SELECTOR USES IT — pure.
 *
 * Owner-reported 2026-08-03: an insurance condition carried a PREVIOUS policy's
 * documents that were never accepted; the condition was signed off on the newly
 * ordered (and accepted) binder, and the TPR export + the closing-prep email to
 * the outside law firm shipped ALL of them.
 *
 * Two halves are tested here, both without a database:
 *   1. the predicate itself — what counts as accepted, what counts as still
 *      waiting, and the SQL both compile to;
 *   2. a SOURCE GUARD: every outbound selector really does ask for ACCEPTED. A
 *      behavioural test can only prove the query it happens to run; this proves
 *      that the `<> 'rejected'` shape — the actual bug, and a shape that reads
 *      perfectly reasonable — has not crept back into any of them. That matters
 *      more than usual here, because the SAME line was written independently in
 *      four selectors and each one shipped documents on its own.
 */
const fs = require('fs');
const path = require('path');
const A = require('../src/lib/document-acceptance');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

/* ── 1. the predicate ─────────────────────────────────────────────────────── */

assert(A.isAccepted({ review_status: 'accepted' }) === true, 'an accepted document ships');
assert(A.isAccepted({ review_status: 'pending' }) === false, 'a pending document does NOT ship — the reported bug');
assert(A.isAccepted({ review_status: 'rejected' }) === false, 'a rejected document does not ship');
assert(A.isAccepted({ review_status: 'superseded' }) === false, 'a superseded document does not ship');
assert(A.isAccepted({}) === false, 'no review_status reads as pending (the db/013 default), so it does NOT ship');
assert(A.isAccepted(null) === false, 'a missing document is safe');
assert(A.isAccepted({ review_status: 'ACCEPTED' }) === true, 'casing never decides whether a document ships');

// "Waiting" is the sign-off blocker, and the owner named exactly three ways out:
// accepted, rejected, or deleted. Rejected and superseded are DECISIONS.
assert(A.isAwaiting({ review_status: 'pending' }) === true, 'pending is waiting on a human');
assert(A.isAwaiting({}) === true, 'and so is an absent status');
assert(A.isAwaiting({ review_status: 'rejected' }) === false, 'rejected is a decision, not a wait');
assert(A.isAwaiting({ review_status: 'superseded' }) === false, 'superseded is a decision, not a wait');
assert(A.isAwaiting({ review_status: 'accepted' }) === false, 'accepted is a decision, not a wait');

// Nothing may be both, or neither-but-shippable.
for (const s of ['accepted', 'pending', 'rejected', 'superseded', '', 'nonsense']) {
  const d = { review_status: s };
  assert(!(A.isAccepted(d) && A.isAwaiting(d)), `"${s}" is never both accepted and waiting`);
}
assert(A.isAccepted({ review_status: 'nonsense' }) === false,
  'an unrecognised status is NOT shippable — an unknown state must fail closed');

/* ── the SQL the predicate compiles to ────────────────────────────────────── */

assert(/COALESCE\(d\.review_status,'pending'\) = 'accepted'/.test(A.ACCEPTED_SQL('d')),
  'the accepted fragment is COALESCE-guarded (a bare nullable column in a negated guard is this repo’s #1 SQL trap)');
assert(/COALESCE\(review_status,'pending'\) = 'accepted'/.test(A.ACCEPTED_SQL('')),
  'an unaliased single-table query is supported');
assert(/= 'pending'/.test(A.AWAITING_SQL('d')), 'the waiting fragment asks for pending');
let threw = false;
try { A.ACCEPTED_SQL('d; DROP TABLE documents'); } catch (_) { threw = true; }
assert(threw, 'a bad alias throws rather than being interpolated into SQL');

/* ── the wording ──────────────────────────────────────────────────────────── */

assert(/one document/i.test(A.pendingDocsMsg(1)) && !/1 documents/.test(A.pendingDocsMsg(1)),
  'one pending document is described in the singular');
assert(/3 documents/.test(A.pendingDocsMsg(3)), 'three are counted');
assert(/accept/i.test(A.pendingDocsMsg(2)) && /reject/i.test(A.pendingDocsMsg(2)) && /delete/i.test(A.pendingDocsMsg(2)),
  'the refusal names all THREE ways out the owner gave — accept, reject, delete');
assert(A.pendingDocsMsg(2, ['a.pdf', 'b.pdf']).includes('a.pdf'),
  'and it names the documents, so nobody has to hunt for which one');
assert(/\+2 more/.test(A.pendingDocsMsg(5, ['a', 'b', 'c', 'd', 'e'])),
  'a long list is capped without hiding that it was capped');
assert(A.heldBackNote(0) === '', 'nothing held back says nothing');
assert(/1 document is not accepted/.test(A.heldBackNote(1)) && /2 documents are not accepted/.test(A.heldBackNote(2)),
  'the held-back note agrees with itself in number');

/* ── 2. the source guard — every outbound selector asks for ACCEPTED ─────── */

const tpr = read('src/lib/tpr-export.js');

// The four selectors that feed a package. Each one shipped documents on its own
// before this change, which is why each is asserted on its own.
for (const fn of ['selectTprDocuments', 'selectSowExports', 'selectTrackRecordDocs', 'selectTprMissing']) {
  assert(tpr.includes(fn), `${fn} still exists`);
}
assert(/TPR_DOC_SELECT_FOR = \(reviewTest\)/.test(tpr),
  'the shipped set and the held-back set are ONE query body with two review tests — they cannot describe different corpora');
assert(/const TPR_DOC_SELECT = TPR_DOC_SELECT_FOR\(docAccept\.ACCEPTED_SQL\('d'\)\)/.test(tpr),
  'what ships is built from the ACCEPTED predicate');
assert(/const TPR_DOC_PENDING_SELECT = TPR_DOC_SELECT_FOR\(docAccept\.AWAITING_SQL\('d'\)\)/.test(tpr),
  'what was held back is built from the WAITING predicate');

// THE REGRESSION GUARD. `review_status <> 'rejected'` is the exact shape of the
// bug: it reads as "not thrown away" and was taken for "checked". Nothing in
// the export selectors may say it again.
const badShape = /review_status[^\n]{0,40}<>\s*'rejected'/g;
const tprHits = (tpr.match(badShape) || []);
assert(tprHits.length === 0,
  `no export selector tests "<> 'rejected'" any more (found ${tprHits.length})`);

// The sign-off gate is the other half of the owner's rule.
const staff = read('src/routes/staff.js');
assert(/async function pendingDocumentsBlock/.test(staff),
  'the sign-off gate has a pending-documents check');
assert(/const pendingBlock = await pendingDocumentsBlock\(itemId\);\s*\n\s*if \(pendingBlock\) return pendingBlock;/.test(staff),
  'and it runs FIRST, before any per-condition rule — it is true of every condition');
assert(/checklist_item_id=\$1 AND is_current AND \$\{docAccept\.ACCEPTED_SQL\('' \)?\}/.test(staff)
  || /is_current AND \$\{docAccept\.ACCEPTED_SQL\(''\)\}/.test(staff),
  'the slot-based gate (insurance binder + invoice, title, fraud, appraisal) counts only ACCEPTED slots');

// The insurance refusal is the one the owner hit. It must say ACCEPT, not just upload.
assert(/insurance binder and the insurance invoice, and accept each one/.test(staff),
  'the insurance refusal tells the reviewer to accept both, not merely to upload them');

/* ── 3. PILOT's own documents are born accepted AT THE INSERT ─────────────── */

// The alternative — an exception list inside the predicate — was rejected on
// purpose: it drifts from the inserts, and it would have swept up the two
// system-written documents that are DOCUMENTED as needing a human first.
const bornAccepted = [
  ['src/lib/esign/webhook.js', /'system',\$9,true,'accepted'/, 'a DocuSign-executed package'],
  ['src/routes/borrower.js', /'system','borrower',\$9,'accepted',now\(\)/, "the borrower tool's own export"],
  ['src/routes/staff.js', /'system','borrower',\$10,'accepted',now\(\)/, "the staff tool's own export"],
  ['src/sitewire/sow-line-edit.js', /'rehab_budget_export','accepted',now\(\)/, 'a regenerated SOW workbook'],
  ['src/xactus/flood-desk.js', /'system',\$9,'accepted',now\(\)/, 'a flood certificate PILOT ordered (Xactus)'],
  ['src/encompass/flood-desk.js', /'system',\$9,'accepted',now\(\)/, 'a flood certificate PILOT ordered (ICE)'],
];
for (const [file, re, what] of bornAccepted) {
  assert(re.test(read(file)), `${what} is born accepted, not pending`);
}

// THE NEAR-MISS. The Term Sheet Studio's own PDF rides the ORDINARY upload door,
// which files everything pending — so the acceptance rule would have dropped it
// from the export AND made closing-prep refuse every order for want of a term
// sheet sitting right there. Both doors accept it, and ONLY it.
//
// THE STAFF DOOR'S INSERT MOVED (2026-08-30, the shared Condition Center): the
// statement now lives in `src/lib/condition-docs/upload.js`, which BOTH products
// call, so the guard is RE-POINTED at the file that carries it rather than
// loosened — a stale guard reads as a broken feature and gets "fixed" by deleting
// it. The bind POSITION is deliberately no longer pinned (it is an implementation
// detail of one statement, and pinning it is exactly what went stale here); what
// is pinned is the RULE — that kind is born accepted and every other upload
// through the same door is still born pending.
for (const f of ['src/lib/condition-docs/upload.js', 'src/routes/borrower.js']) {
  const src = read(f);
  assert(/CASE WHEN \$\d+='term_sheet' THEN 'accepted' ELSE 'pending' END/.test(src),
    `${f}: a studio-generated term sheet is born accepted`);
  assert(/ELSE 'pending' END/.test(src),
    `${f}: and every OTHER upload through the same door is still born pending`);
}
// …and the staff route really does go through that shared door, or the assertion
// above would be about a module nothing calls.
assert(/condDocs\.uploadConditionDocument\(/.test(staff),
  'the staff upload door calls the shared condition-document service');

// …and the two that must NOT be, because a human genuinely reviews them.
const adopt = read('src/lib/underwriting/entity-adopt.js');
assert(!/'accepted'/.test(adopt),
  'an entity document COPIED onto a profile still waits for a reviewer (it is system-written but not authoritative)');
const orderInbox = read('src/lib/order-inbox.js');
assert(/'pending'/.test(orderInbox),
  "a vendor's emailed order return still waits for a human — this is the document in the owner's own story");

console.log(failures ? `\n${failures} FAILURE(S)` : '\ndocument-acceptance: all assertions passed');
process.exit(failures ? 1 : 0);
