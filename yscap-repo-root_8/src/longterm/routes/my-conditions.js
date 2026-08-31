'use strict';

/**
 * THE LONG-TERM BORROWER'S OWN CONDITIONS — what is still needed from them, and
 * the door they put it through.
 *
 * THE GAP THIS CLOSES. A short-term borrower signs in, sees their conditions,
 * uploads a document and watches it clear. A long-term borrower saw a card with a
 * loan amount and a status on it and NOTHING ELSE — zero conditions, no upload,
 * no way to learn what was outstanding. The whole staff side of the Condition
 * Center is shared and working; this is the audience that was never built, and
 * the cost of leaving it is that every long-term document has to be chased by
 * telephone and email the way it worked before PILOT.
 *
 * MOUNTED INSIDE `my-loans.js`, which is already at /api/lt/my behind
 * `requireAuth` + `requireBorrower` — so this file never repeats an
 * authentication decision, it only makes an AUTHORIZATION one.
 *
 * ── WHAT MAKES A LOAN THEIRS ────────────────────────────────────────────────
 *
 * `my-scope.loadOwnLoan` and nothing else: the borrower-facing switch, the
 * admin-CONFIRMED borrower link, and the trash exclusion. It is the SAME
 * fragment the loans list is built on, so the list and these doors can never
 * disagree about which loans are theirs — the failure the staff side already
 * paid for when seven routers each copied one branch of a five-branch scope.
 *
 * It answers null for every reason a client is not entitled to a loan and
 * deliberately does not say which, so nobody can learn which loan ids are real.
 *
 * ── WHAT A BORROWER MAY SEE ─────────────────────────────────────────────────
 *
 * `read.forLoan(…, { audience: 'client' })` — the same read the team's screen
 * uses, asked the client question. Its payload is BUILT for the client from a
 * named whitelist rather than filtered down from the staff one, which is the
 * strong form of the rule: a column added to the table tomorrow cannot reach a
 * borrower through it because nobody asked for it.
 *
 * ── WHAT A BORROWER MAY DO ──────────────────────────────────────────────────
 *
 * Upload, and only onto a condition that is addressed to them. Accepting,
 * rejecting, deleting, signing off and waiving stay where they were: those are
 * OUR decisions about their document, and a borrower who could accept their own
 * upload could clear every condition on their file.
 *
 * THE CONDITION MUST BE BORROWER-FACING, and that is checked HERE rather than
 * left to the shared door — the shared door's job is what happens to a document,
 * not which audience may send one. A staff-only condition (an internal flood
 * certificate, a fraud check) is not something a borrower may file against, and
 * the refusal is a 404 for the same reason the loan lookup is: a distinguishable
 * "that exists but is not yours" tells them what we hold.
 */

const express = require('express');
const router = express.Router();

const db = require('../db');
const myScope = require('../my-scope');
const read = require('../conditions-center/read');
const condUpload = require('../../lib/condition-docs/upload');
const { ownerOf } = require('../../lib/condition-owner');
const uploadStream = require('../../lib/upload-stream');

/** The signed-in borrower, or null. */
const meId = (req) => (req.actor && req.actor.kind === 'borrower' ? String(req.actor.id) : null);

/**
 * The loan named in the path, if it is theirs. Answers the response and returns
 * null otherwise, so a caller reads as `if (!loan) return;`.
 */
async function ownLoan(req, res) {
  const borrowerId = meId(req);
  if (!borrowerId) { res.status(401).json({ error: 'Please sign in again.' }); return null; }
  const loan = await myScope.loadOwnLoan(borrowerId, req.params.loanId, db);
  if (!loan) { res.status(404).json({ error: 'not found' }); return null; }
  return loan;
}

/**
 * Is this condition on that loan AND addressed to the borrower?
 *
 * THE LOAN IS IN THE STATEMENT, not checked afterwards. A condition id from
 * somebody else's file matches NO ROW rather than reaching a row that some later
 * comparison is trusted to refuse — the same shape the staff door uses, and the
 * reason a missed comparison cannot become a disclosure.
 *
 * The audience test names the two client values explicitly rather than excluding
 * the internal one: a value nobody has defined yet reads as NOT borrower-facing,
 * which is the safe direction.
 */
async function borrowerCondition(loanId, conditionId, client = db) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(conditionId || ''))) return null;
  try {
    const { rows } = await client.query(
      `SELECT id, audience, status
         FROM checklist_items
        WHERE id = $1::uuid
          AND lt_loan_id = $2::uuid
          AND audience IN ('borrower', 'both')
        LIMIT 1`,
      [conditionId, loanId],
    );
    return rows[0] || null;
  } catch (e) {
    console.error('[lt] borrower condition lookup failed:', (e && e.message) || e);
    return null;
  }
}

// GET /api/lt/my/loans/:loanId/conditions — what is still needed from them.
router.get('/loans/:loanId/conditions', async (req, res) => {
  const loan = await ownLoan(req, res);
  if (!loan) return;
  try {
    const payload = await read.forLoan(loan.id, { audience: 'client', db });
    return res.json({
      // The loan's own identity, from the row the scope already read — never a
      // second query, and never a field the client list does not already carry.
      loan: { id: loan.id, file: loan.loan_number || '(not numbered yet)' },
      ...payload,
    });
  } catch (e) {
    console.error('[lt] borrower conditions read failed:', (e && e.message) || e);
    return res.status(500).json({ error: 'Could not load your conditions just now.' });
  }
});

/**
 * PUT A DOCUMENT ON ONE OF THEIR CONDITIONS — one handler, two transports.
 *
 * The same pair the staff door carries, for the same reason: the JSON door holds
 * the whole file in memory as base64 and is capped well below the size of an
 * ordinary scanned document, while the streamed door writes bytes to storage as
 * they arrive. A borrower photographing a bank statement on a phone is exactly
 * the caller that hits the small ceiling.
 */
const uploadOwnDoc = async (req, res) => {
  const loan = await ownLoan(req, res);
  if (!loan) return;
  const cond = await borrowerCondition(loan.id, req.params.conditionId, db);
  if (!cond) return res.status(404).json({ error: 'not found' });

  const body = Object.assign({}, req.body || {});
  try { condUpload.assertUploadIntake(body); }
  catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  // THE CONDITION COMES FROM THE PATH. A body naming a different one must not be
  // able to file against a condition the path never authorized.
  body.checklistItemId = String(cond.id);
  /* AND SO DOES EVERYTHING ELSE A CLIENT MUST NOT CHOOSE — three keys that
     would otherwise ride the body straight into the shared door.

     `docKind` — and the value that matters is `term_sheet`, not something
     exotic. The shared door honours that ONE kind from a body on purpose (the
     Term Sheet Studio captures its own PDF through the ordinary upload path),
     and honouring it supersedes every other term sheet on the file and stamps
     the final/initial flag the issuance gate reads. A borrower who could name it
     could supersede the term sheet we sent them. An invented kind is already
     ignored, so this strip is about that one word.

     `replaceDocumentId` supersedes an existing copy — including one WE have
     already accepted, which is a way to make a cleared condition un-clear itself.

     `visibility` is REDUNDANT TODAY and is written down as redundant rather than
     left to imply it bites: the shared door derives it from the condition's
     audience and never reads it from a body (upload.js: `staffOnly ? 'staff_only'
     : 'borrower'`), so removing this line fails no test. It stays as the second
     lock on a door whose first lock lives in another module. */
  delete body.docKind;
  delete body.replaceDocumentId;
  delete body.visibility;

  try {
    const landed = await condUpload.uploadConditionDocument(req, {
      owner: ownerOf('lt_loan', loan.id),
      body,
      actorId: meId(req),
      actorKind: 'borrower',
      /* NO `borrower_id` ON THE ROW, EVEN THOUGH A BORROWER UPLOADED IT — the
         same disclosure rule the staff door carries, and it bites HARDER here
         because the temptation is greater. That column is what the SHORT-TERM
         borrower portal's own document list selects on, so stamping it would put
         a long-term document onto this person's RTL screen, which is the exact
         crossing the two-product law forbids. Their long-term view is this door.
         `uploaded_by_kind` + `uploaded_by_id` already record who sent it. */
      borrowerId: null,
      hooks: {},
      q: db,
    });
    /* THE SAME RULE ON THE BORROWER'S OWN DOOR. An ID they send here is their
       ID everywhere — the owner's *"it's on the profiles and the borrower
       profile"* — through the ONE shared definition, so it can never mean one
       thing given on this screen and another given on the short-term one.
       Nothing about a long-term document's own disclosure changes: the row is
       still filed with no `borrower_id` (see above), and what reaches the
       profile is the POINTER on the person record, which is what both products
       have always read. */
    let profile = null;
    if (!landed.deduped) {
      profile = await require('../conditions-center/photo-id-share').adoptFromLoan({
        loanId: loan.id,
        documentId: landed.documentId,
        conditionCode: landed.item && landed.item.code,
        q: db,
      });
    }
    return res.status(201).json({
      ok: true, documentId: landed.documentId, deduped: !!landed.deduped,
      savedToProfile: !!(profile && profile.adopted),
    });
  } catch (e) {
    if (e && e.status) return res.status(e.status).json({ error: e.message });
    console.error('[lt] borrower condition upload failed:', (e && e.message) || e);
    return res.status(500).json({ error: 'Could not save that document just now.' });
  }
};

router.post('/loans/:loanId/conditions/:conditionId/documents', uploadOwnDoc);
router.post('/loans/:loanId/conditions/:conditionId/documents/binary',
  uploadStream.binaryIntake, uploadOwnDoc);

module.exports = router;
