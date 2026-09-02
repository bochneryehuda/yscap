'use strict';
/**
 * LONG-TERM — THE GENERAL CONDITION CENTER (HTTP).
 *
 * Mounted at /api/lt/condition-center; staff authentication is applied at the
 * seam in src/server.js, so this router imports no RTL code.
 *
 * ── THIS IS NOT THE ENCOMPASS MIRROR ────────────────────────────────────────
 *
 * /api/lt/conditions is db/612's READ-ONLY mirror of Encompass's Enhanced
 * Conditions and eFolder — what the investor's underwriter raised after buying
 * the loan. This is OUR OWN centre: what we need to get a file submitted,
 * cleared, docked, funded and sold. Two centres, two routers, two tables, on
 * purpose (db/643's header says why).
 *
 * ── FOUR RULES ──────────────────────────────────────────────────────────────
 *
 * 1. EVERY PER-FILE ROUTE GOES THROUGH `loadScopedLoan`, the same loader every
 *    other per-file route uses. A condition screen must never reach a file the
 *    file screen would refuse.
 *
 * 2. EVERY CONDITION ID IS SCOPED TO ITS LOAN IN THE STATEMENT, not checked
 *    afterwards. `WHERE id = $1 AND loan_id = $2` means an id from another file
 *    matches no row, which is a property of the query rather than of a check
 *    somebody has to remember to write.
 *
 * 3. THE AUDIENCE IS `internal` HERE. Every route is behind the staff mount.
 *    The borrower's own view is its own door on /api/lt/my, and it asks
 *    `read.forLoan` for the CLIENT payload — which is BUILT for the client
 *    rather than being the internal one with fields deleted.
 *
 * 4. CHANGING THE LIBRARY IS AN ADMINISTRATOR'S. A template is on every file in
 *    the book; the wording on it is what a borrower reads. Working a condition
 *    on a file is any staff member's.
 */

const express = require('express');

const router = express.Router();

const db = require('../db');
const access = require('../access');
const settingsStore = require('../settings/store');
const engine = require('../conditions-center/engine');
const read = require('../conditions-center/read');
const write = require('../conditions-center/write');
const workspace = require('../conditions-center/workspace');
const rules = require('../conditions-center/rules');
const registry = require('../conditions-center/field-registry');
const library = require('../conditions-center/library');
const vocab = require('../conditions-center/vocabulary');
const entityPrefill = require('../conditions-center/entity-prefill');
const entityProfile = require('../conditions-center/entity-profile');
const profileLinks = require('../conditions-center/profile-links');
const guestSend = require('../guest/send');
const { loadScopedLoan, UUID_RE } = require('./scoped-loan');

/* THE ONE CONDITION-DOCUMENT SERVICE, SHARED WITH THE SHORT-TERM SIDE
   (docs/LONG-TERM-AUTHORIZED-COPIES.md, the 2026-08-30 share-the-code grant):
   *"if I'm updating something in the logic of the Condition Center (the way you
   preview stuff, the way you preview the PDFs, the way you drag and drop, accept,
   reject, preview, download, and delete), it should update them both places. You
   need to share the code."*  These four doors are THIN CALLERS of it, exactly as
   `src/routes/staff.js` is — the same functions, a different owner. */
const condUpload = require('../../lib/condition-docs/upload');
const condReview = require('../../lib/condition-docs/review');
const condRemove = require('../../lib/condition-docs/remove');
const condServe = require('../../lib/condition-docs/serve');
const { ownerOf } = require('../../lib/condition-owner');
// The rules run by themselves (db/668): the file's own door runs the engine
// when the loan is DUE, before its conditions are read.
const sweep = require('../conditions-center/sweep');
// Prior to submittal — completed (db/669): the officer's list and the button,
// and the one ClickUp write it makes.
const submittal = require('../conditions-center/submittal');
const clickupSubmittal = require('../clickup/submittal');

const staffId = (req) => (req.actor && req.actor.id ? String(req.actor.id) : null);

async function isAdmin(req) {
  try {
    const { settings } = await settingsStore.load();
    return access.mayManagePeople(req.actor, settings);
  } catch (_) {
    // The gate failing to be READ is not permission to pass it.
    return false;
  }
}

/** Every write door answers the same shape, so the screen has one thing to read. */
function answer(res, out) {
  if (out && out.ok) return res.json(out);
  return res.status((out && out.status) || 400).json({ error: (out && out.error) || 'That did not work.' });
}

// ─────────────────────────────────────────────────────────────────────────────
// ONE FILE
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/lt/condition-center/loans/:loanId — the file's conditions by bucket.
router.get('/loans/:loanId', async (req, res) => {
  const scoped = await loadScopedLoan(req, res, 'lt-cond');
  if (!scoped) return;
  try {
    /* THE RULES RUN BEFORE THE LIST IS READ, when the file is DUE a pass
       (owner-directed 2026-09-02: *"you don't need to click this button"*).
       The background sweep covers the book on its own tick; this is the same
       predicate at the moment a person is actually looking, so what they open
       is current now rather than five minutes from now. Best-effort — a pass
       that fails is reported in `rules` and the list is read regardless. */
    const rules = await sweep.evaluateIfStale(scoped.loan.id, { db });
    const out = await read.forLoan(scoped.loan.id, { audience: 'internal', db });
    res.json({ loanId: scoped.loan.id, rules, ...out });
  } catch (e) {
    console.error('[lt] condition centre read failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not read this file’s conditions just now.' });
  }
});

// POST …/loans/:loanId/evaluate — re-run the rules against this file.
//
// The engine never throws, so a failed pass comes back as a REPORT rather than
// an error: what it added, what it removed, and — the part that matters — what
// it could not decide and why.
router.post('/loans/:loanId/evaluate', async (req, res) => {
  const scoped = await loadScopedLoan(req, res, 'lt-cond');
  if (!scoped) return;
  const out = await engine.evaluateLoan(scoped.loan.id, { db });
  res.json(out);
});

// ─────────────────────────────────────────────────────────────────────────────
// PRIOR TO SUBMITTAL — COMPLETED (owner-directed 2026-09-02)
// ─────────────────────────────────────────────────────────────────────────────

// GET …/loans/:loanId/submittal — what the officer still has to do, and the
// completion stamp / ClickUp state once it is done. The list is derived from
// the same sign-off rules the back office uses; see conditions-center/submittal.js.
router.get('/loans/:loanId/submittal', async (req, res) => {
  const scoped = await loadScopedLoan(req, res, 'lt-cond');
  if (!scoped) return;
  const out = await submittal.readiness(scoped.loan.id, { db });
  if (!out.ok) return res.status(503).json({ error: out.degraded || 'Could not read this file just now.' });
  return res.json(out);
});

// POST …/loans/:loanId/submittal/complete — the button. Refuses (422, with the
// list) while anything is outstanding; stamps once; tells ClickUp best-effort.
router.post('/loans/:loanId/submittal/complete', async (req, res) => {
  const scoped = await loadScopedLoan(req, res, 'lt-cond');
  if (!scoped) return;
  const out = await submittal.complete(scoped.loan.id, staffId(req), { db });
  if (!out.ok) return res.status(out.status || 400).json({ error: out.error, outstanding: out.outstanding || [] });
  return res.json(out);
});

// POST …/loans/:loanId/submittal/push-clickup — try the card again by hand
// (the worker retries on its own; this is for the person watching the screen).
router.post('/loans/:loanId/submittal/push-clickup', async (req, res) => {
  const scoped = await loadScopedLoan(req, res, 'lt-cond');
  if (!scoped) return;
  const push = await clickupSubmittal.pushForLoan(scoped.loan.id, { db });
  const state = await submittal.stateOf(scoped.loan.id, db);
  return res.json({ ok: !!push.ok, push, completed: state && state.completed, clickup: state && state.clickup });
});

// ─────────────────────────────────────────────────────────────────────────────
// ONE CONDITION ON ONE FILE
// ─────────────────────────────────────────────────────────────────────────────

/** Every condition route shares this: scope the loan, then check the id's shape. */
async function scopedCondition(req, res) {
  const scoped = await loadScopedLoan(req, res, 'lt-cond');
  if (!scoped) return null;
  if (!UUID_RE.test(String(req.params.conditionId || ''))) {
    res.status(404).json({ error: 'That condition is not on this file.' });
    return null;
  }
  return scoped;
}

/**
 * THE WORKING DATA for a condition that is a CHOICE rather than an upload — the
 * mortgages on the credit report, the subject property's mortgage, the vesting
 * entity. Its own door on purpose: the conditions LIST is loaded by every screen
 * and every borrower, and these three reads are only wanted once somebody opens
 * one of them.
 *
 * Answers `{ workspace: null }` for an ordinary condition rather than a 404 — the
 * screen asks the same question of every condition it opens, and "this one has
 * no workspace" is a normal answer, not an error.
 */
router.get('/loans/:loanId/conditions/:conditionId/workspace', async (req, res) => {
  const scoped = await scopedCondition(req, res);
  if (!scoped) return;
  try {
    res.json({ workspace: await workspace.forCondition(scoped.loan.id, req.params.conditionId, { db }) });
  } catch (e) {
    console.error('[lt] condition workspace failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not open that condition just now.' });
  }
});

/**
 * RECORD THE ANSWER. Validated through `answers.js` — the SAME module the
 * sign-off gate reads — so a shape this accepts is always one the gate honours.
 * Merges, so two people working the mortgages list a line at a time do not wipe
 * each other's rows.
 */
router.post('/loans/:loanId/conditions/:conditionId/answer', async (req, res) => {
  const scoped = await scopedCondition(req, res);
  if (!scoped) return;
  try {
    answer(res, await write.recordAnswer(
      scoped.loan.id, req.params.conditionId, (req.body || {}).answer, staffId(req), db,
    ));
  } catch (e) {
    console.error('[lt] record condition answer failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not save that just now.' });
  }
});

router.post('/loans/:loanId/conditions/:conditionId/satisfy', async (req, res) => {
  const scoped = await scopedCondition(req, res);
  if (!scoped) return;
  try {
    answer(res, await write.satisfy(scoped.loan.id, req.params.conditionId, staffId(req), db));
  } catch (e) {
    console.error('[lt] satisfy condition failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not update that condition just now.' });
  }
});

router.post('/loans/:loanId/conditions/:conditionId/waive', async (req, res) => {
  const scoped = await scopedCondition(req, res);
  if (!scoped) return;
  try {
    answer(res, await write.waive(scoped.loan.id, req.params.conditionId, staffId(req), (req.body || {}).reason, db));
  } catch (e) {
    console.error('[lt] waive condition failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not update that condition just now.' });
  }
});

router.post('/loans/:loanId/conditions/:conditionId/reopen', async (req, res) => {
  const scoped = await scopedCondition(req, res);
  if (!scoped) return;
  try {
    answer(res, await write.reopen(scoped.loan.id, req.params.conditionId, db));
  } catch (e) {
    console.error('[lt] reopen condition failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not update that condition just now.' });
  }
});

// The loan officer's own step. A STAMP, never a status — the back office still
// signs the condition off after them, which is the whole reason it is a separate
// mark. Same two columns the short-term side has always used, so a file reads the
// same way whichever product it belongs to.
router.post('/loans/:loanId/conditions/:conditionId/done', async (req, res) => {
  const scoped = await scopedCondition(req, res);
  if (!scoped) return;
  try {
    // Absent reads as "mark it done" — the button's ordinary press — while an
    // explicit false is the undo. Anything else is not a third state.
    const done = (req.body || {}).done !== false;
    answer(res, await write.markDone(scoped.loan.id, req.params.conditionId, staffId(req), done, db));
  } catch (e) {
    console.error('[lt] mark condition done failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not update that condition just now.' });
  }
});

router.post('/loans/:loanId/conditions/:conditionId/status', async (req, res) => {
  const scoped = await scopedCondition(req, res);
  if (!scoped) return;
  try {
    answer(res, await write.setStatus(scoped.loan.id, req.params.conditionId, (req.body || {}).status, db));
  } catch (e) {
    console.error('[lt] set condition status failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not update that condition just now.' });
  }
});

router.post('/loans/:loanId/conditions/:conditionId/note', async (req, res) => {
  const scoped = await scopedCondition(req, res);
  if (!scoped) return;
  try {
    answer(res, await write.setNote(scoped.loan.id, req.params.conditionId, (req.body || {}).note, db));
  } catch (e) {
    console.error('[lt] set condition note failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not save that note just now.' });
  }
});

// POST …/loans/:loanId/conditions — add one from the library, by hand.
router.post('/loans/:loanId/conditions', async (req, res) => {
  const scoped = await loadScopedLoan(req, res, 'lt-cond');
  if (!scoped) return;
  const body = req.body || {};
  if (!body.code) return res.status(400).json({ error: 'Say which condition to add.' });
  try {
    answer(res, await write.addFromTemplate(scoped.loan.id, body.code, { db, fieldKey: body.fieldKey }));
  } catch (e) {
    console.error('[lt] add condition failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not add that condition just now.' });
  }
});

router.delete('/loans/:loanId/conditions/:conditionId', async (req, res) => {
  const scoped = await scopedCondition(req, res);
  if (!scoped) return;
  try {
    answer(res, await write.removeManual(scoped.loan.id, req.params.conditionId, db));
  } catch (e) {
    console.error('[lt] remove condition failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not remove that condition just now.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// THE DOCUMENTS ON A CONDITION — upload, accept/reject, delete, download.
//
// THE OWNER'S COMPLAINT THESE ANSWER, verbatim: *"You can't really upload stuff.
// You can't do anything."* This router had eighteen routes and not one of them
// accepted a document, so a Long-Term condition asking for a bank statement had
// nowhere to put one.
//
// EVERY ONE OF THEM IS A THIN CALLER. The rules about DOCUMENTS — which slot the
// bytes land in, what a duplicate is, which prior version they supersede, what a
// verdict does to the condition, what a delete re-opens — live once, in
// `src/lib/condition-docs/**`, and are the same rules the short-term door runs.
// What is OURS is the two things a product owns: WHO may reach the row, and what
// this product does about a document afterwards (nothing — see the hooks note).
//
// ── WHICH DOOR AUTHORIZES WHAT ──────────────────────────────────────────────
//
// THE UPLOAD carries the loan in its own path, so `scopedCondition` is the whole
// authorization: `loadScopedLoan` decides whether this person may open the file
// (rule 1), and the shared door's own condition lookup runs
// `WHERE id = $1 AND lt_loan_id = $2`, so a condition id from another file
// matches NO ROW rather than reaching a row some later check is trusted to
// refuse (rule 2).
//
// THE OTHER THREE take a documentId with NO loan in the path, and they do NOT
// invent a second authorization model. `scopedDocument` resolves the document's
// OWNING long-term loan first — in a statement that already refuses an RTL
// document — and then puts that loan through the SAME `loadScopedLoan`. The
// owner is then handed to the shared service, which welds `lt_loan_id = $n` into
// the read and into the DELETE itself: a document belonging to another product,
// or to a long-term loan other than the one just authorized, is not merely
// refused, it is unreachable.
//
// NO RTL HOOKS ARE PASSED, DELIBERATELY (`hooks: {}` — an empty set, not the
// default). The ClickUp condition push, the borrower's portal notification and
// the Sitewire memory are facts about the short-term product; a long-term loan
// has no ClickUp condition field and no `/app/:id` portal page. `defaultHooks`
// already hands over nothing for a non-application owner, so this is belt and
// braces: a hook set that defaulted ON would send a short-term portal link to a
// long-term borrower the first time somebody forgot an argument.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ONE DOCUMENT, IF IT IS A LONG-TERM ONE AND THIS PERSON MAY OPEN ITS FILE.
 *
 * The first statement is the product boundary and it is a property of the query:
 * `lt_loan_id IS NOT NULL` means an RTL document — an application's, an entity's,
 * a borrower-profile one — matches nothing at all here, whatever its id. The
 * second is the file gate every other per-file route in this router goes through.
 *
 * Answers the response itself and returns null, the same contract as
 * `loadScopedLoan`, so a handler's whole obligation stays `if (!scoped) return;`.
 */
async function scopedDocument(req, res) {
  const documentId = String(req.params.documentId || '');
  if (!UUID_RE.test(documentId)) {
    res.status(404).json({ error: 'That document is not on this file.' });
    return null;
  }
  let rows;
  try {
    ({ rows } = await db.query(
      `SELECT lt_loan_id FROM documents WHERE id = $1::uuid AND lt_loan_id IS NOT NULL`,
      [documentId],
    ));
  } catch (e) {
    // A database failure is not a statement about the document. Same posture as
    // `loadScopedLoan`: an outage is a 503, never the 404 disguise.
    console.error('[lt] condition document lookup failed:', (e && e.message) || e);
    res.status(503).json({ error: 'Could not read that document just now. Try again in a moment.' });
    return null;
  }
  if (!rows.length) {
    // Deliberately the SAME sentence a document on another long-term loan would
    // get: whether a document exists at all on some other product's file is not
    // something this door is entitled to reveal.
    res.status(404).json({ error: 'That document is not on this file.' });
    return null;
  }
  const scoped = await loadScopedLoan(req, res, 'lt-cond-doc', { loanId: String(rows[0].lt_loan_id) });
  if (!scoped) return null;
  return { scoped, documentId, owner: ownerOf('lt_loan', scoped.loan.id) };
}

/* PUT A DOCUMENT ON A CONDITION — ONE HANDLER, TWO TRANSPORTS.
 *
 * The short-term side registers its upload handler TWICE (staff.js: the JSON door
 * and `…/documents/binary` behind `binaryIntake`), and this side needs the same
 * pair for a reason that is not cosmetic: the JSON door carries the file as base64
 * inside the request body, and `takeUpload` caps that at `maxJsonUploadMb` — 25 MB
 * — while the streamed door writes to storage as the bytes arrive and is bounded
 * by `maxUploadMb`, which is 1 GB. With only the JSON door a long-term file could
 * take a 25 MB document and refuse a 26 MB one that the short-term side accepts
 * without blinking: an appraisal with photographs, a scanned closing package, a
 * survey. Same Condition Center, two different answers to the same file.
 *
 * `takeUpload` reads `req.uploaded` FIRST, so when `binaryIntake` has already
 * streamed the bytes into storage the handler below is byte-for-byte the same code
 * on either transport — it never learns which door it was called through. That is
 * why this is one function and not two. */
/* THE ONE PLACE THE READER'S VERDICT BECOMES SOMETHING A SCREEN SAYS. Kept next
   to the door rather than in the reader, because the reader answers in facts and
   this decides which of them are the person's business. Never throws. */
function statementReadReport(r) {
  if (!r) return null;
  if (r.filled) {
    return {
      status: 'filled',
      servicer: r.servicer,
      loanNumber: r.loanNumber,
      balance: r.balance,
      note: r.note || null,
    };
  }
  /* READ, AND CAME UP SHORT. `detail` is the reader's own sentence naming which
     of the three it could not make out; without it there is nothing useful to
     say, so nothing is said. */
  if (r.why === 'unreadable' && r.detail) return { status: 'short', detail: String(r.detail) };
  return null;
}

const uploadConditionDoc = async (req, res) => {
  const scoped = await scopedCondition(req, res);
  if (!scoped) return;
  const body = Object.assign({}, req.body || {});
  // The intake contract and the ONE filename sanitiser are the shared door's, so
  // both products answer the same refusal to the same bad request.
  try { condUpload.assertUploadIntake(body); }
  catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  // THE CONDITION COMES FROM THE PATH, never from the body: a caller naming a
  // different condition in its payload must not be able to file a document
  // against a condition the path never authorized.
  body.checklistItemId = String(req.params.conditionId);

  try {
    const landed = await condUpload.uploadConditionDocument(req, {
      owner: ownerOf('lt_loan', scoped.loan.id),
      body,
      actorId: staffId(req),
      /* NO BORROWER ON THE DOCUMENT ROW, AND THAT IS A DISCLOSURE RULE RATHER
         THAN AN OMISSION. `documents.borrower_id` is what the short-term
         borrower portal's own document list selects on
         (`WHERE borrower_id = $1 AND (… OR application_id = …)`), so stamping it
         here would put a long-term document — and its download — on the RTL
         borrower's screen, which is exactly the crossing the two-product law
         forbids. The long-term borrower's own view is its own door on
         /api/lt/my. Nothing downstream needs it: the shared SharePoint mirror
         resolves a long-term loan's borrower from `lt_loans` itself
         (src/longterm/sharepoint-scope.js), and asks `lt_loan_id` BEFORE the
         bare borrower fallback. */
      borrowerId: null,
      hooks: {},
      q: db,
    });
    /* THE PHOTO ID BELONGS TO THE PERSON (owner-directed 2026-08-31: *"if he
       uploads it on the long term, it should share it to the short term"*).
       Recorded on the shared profile through the ONE definition, so the
       short-term side sees the same ID and every product's ID condition drops a
       sign-off that attested to the old one. Only the photo-ID condition — the
       module refuses any other code, so a document on some other condition can
       never become the person's ID of record. A DEDUPE is skipped deliberately:
       identical bytes were filed moments ago and already adopted. Never throws
       (the document is filed either way), and the answer is reported so the
       screen can say what happened rather than implying more than it did. */
    let profile = null;
    if (!landed.deduped) {
      profile = await require('../conditions-center/photo-id-share').adoptFromLoan({
        loanId: scoped.loan.id,
        documentId: landed.documentId,
        conditionCode: landed.item && landed.item.code,
        q: db,
      });
    }
    /* THE MORTGAGE STATEMENT READS ITSELF (owner-directed 2026-08-31: *"bring in
       … the OCR engine to be able to read the mortgage statement and read who is
       the servicer name, who is the loan number, and what's the outstanding
       principal balance, and should automatically fill"*). Only that one
       condition — the module refuses any other code — and only ever a PRE-FILL:
       an answer a person gave is left exactly as it is, and a person still
       confirms this one. Best-effort in both directions: the document is filed
       whatever the reader does, and what it did is REPORTED so the screen can
       say it rather than a figure appearing with nothing explaining how. */
    let statement = null;
    if (!landed.deduped) {
      statement = await require('../mortgage-statement-read').fillFromUpload({
        loanId: scoped.loan.id,
        conditionId: String(req.params.conditionId),
        documentId: landed.documentId,
        code: landed.item && landed.item.code,
        storageRef: landed.up && landed.up.ref,
        filename: body.filename,
      }, {
        db,
        storage: require('../../lib/storage'),
        ocr: require('../../lib/ai/ocr-router'),
        ai: require('../../lib/ai/azure-openai'),
        /* NO SPEND METER IS PASSED, and that is a decision rather than an
           omission. The short-term meter is keyed on an APPLICATION id, so asking
           it about a long-term loan gets a confident zero — a cap that never
           caps — and RECORDING against it would write long-term rows into a
           short-term table, which is a crossing nobody authorized. The real
           bound is the shape of the work: one read per uploaded statement, on one
           condition, and the model is only asked at all when the deterministic
           scanner came up short. */
      });
    }
    return res.status(201).json({
      ok: true,
      documentId: landed.documentId,
      deduped: !!landed.deduped,
      visibility: landed.visibility,
      savedToProfile: !!(profile && profile.adopted),
      /* WHAT THE READER DID, IN BOTH DIRECTIONS. Reporting only the SUCCESS is
         the half that leaves somebody wondering whether it even tried — and on a
         statement it could not make out, the honest sentence ("it does not
         clearly state the servicer") is the one thing that tells them to type it
         rather than re-scan. Only the two verdicts a person can act on are sent:
         a fill, or a document that was read and came up short. Everything else
         (this is not that condition, a duplicate upload, no OCR configured) is
         about US, not about their document, and says nothing worth printing. */
      statementRead: statementReadReport(statement),
    });
  } catch (e) {
    // Only a refusal the shared door RAISED carries a status; anything else is a
    // real failure and is reported as one rather than dressed up as a bad request.
    if (e && e.status) return res.status(e.status).json({ error: e.message });
    console.error('[lt] condition document upload failed:', (e && e.message) || e);
    return res.status(500).json({ error: 'Could not save that document just now.' });
  }
};

// The JSON door: the body carries the file as base64. Small documents, and the
// shape every other route on this router already speaks.
router.post('/loans/:loanId/conditions/:conditionId/documents', uploadConditionDoc);
// The STREAMED door, for everything the JSON ceiling would refuse. `binaryIntake`
// stores the bytes as they arrive and hands the handler the same `req.body` shape
// the JSON door produces, so nothing below the transport changes.
router.post('/loans/:loanId/conditions/:conditionId/documents/binary',
  require('../../lib/upload-stream').binaryIntake, uploadConditionDoc);

/* ────────────────────────────────────────────────────────────────────────────
 * THE TWO CONDITIONS WHOSE ANSWER LIVES ON THE PERSON
 *
 * The appraisal card and the government photo ID both belong to the BORROWER,
 * not to a loan, so both read from and (for the card) write to the shared
 * profile — the owner's share-the-code directive, item 7. Neither condition had
 * any implementation behind the promise its own hint makes.
 * ──────────────────────────────────────────────────────────────────────────── */

// GET …/profile-links — what the borrower already has on file for these two.
// Masked: the card number is never decrypted anywhere on this path.
router.get('/loans/:loanId/profile-links', async (req, res) => {
  const scoped = await loadScopedLoan(req, res, 'lt-profile-links');
  if (!scoped) return;
  try {
    res.json(await profileLinks.forLoan(scoped.loan.id, { db }));
  } catch (e) {
    console.error('[lt] profile links failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not read the borrower’s profile just now.' });
  }
});

/**
 * POST …/appraisal-card — keep a card on the borrower's PROFILE.
 *
 * NOTHING ABOUT THE BODY IS EVER LOGGED. It carries a primary account number, so
 * the catch below logs a fixed sentence and never the error's own text either —
 * a driver error can quote the parameters it was given.
 */
router.post('/loans/:loanId/appraisal-card', async (req, res) => {
  const scoped = await loadScopedLoan(req, res, 'lt-appraisal-card');
  if (!scoped) return;
  let out;
  try {
    out = await profileLinks.saveCard(scoped.loan.id, req.body || {}, { db });
  } catch (_) {
    console.error('[lt] appraisal card save failed');
    return res.status(500).json({ error: 'The card could not be saved just now.' });
  }
  if (!out.ok) return res.status(out.status || 400).json({ error: out.error });
  // Only the non-secret summary goes back — brand and last four, which is what a
  // screen shows and all it ever needs.
  return res.status(201).json({ ok: true, last4: out.last4, brand: out.brand });
});

/* ────────────────────────────────────────────────────────────────────────────
 * THE VESTING COMPANY ON THE BORROWER'S PROFILE
 *
 * Two doors, and between them they are the write half of `entity-prefill.js`:
 * put the company on the profile, then file its documents onto the company's OWN
 * slots rather than onto this loan. The second door is the point — it takes the
 * SHARED upload module's `llcId` path, which leaves both file-owner columns null
 * and files the document against the company, so the next loan for the same
 * company finds it already there with nothing copied.
 * ──────────────────────────────────────────────────────────────────────────── */

// POST …/vesting-entity — put this loan's vesting company on the borrower's
// profile (create-or-REUSE) and give it its document slots. Deliberately a
// button and never automatic: a company on a person's permanent record is a
// decision, which is the same posture the short-term side takes.
router.post('/loans/:loanId/vesting-entity', async (req, res) => {
  const scoped = await loadScopedLoan(req, res, 'lt-vesting-entity');
  if (!scoped) return;
  let out;
  try {
    out = await entityProfile.putOnProfile(scoped.loan.id, { db, actorId: staffId(req) });
  } catch (e) {
    console.error('[lt] vesting entity to profile failed:', (e && e.message) || e);
    return res.status(500).json({ error: 'Could not save the company to the profile just now.' });
  }
  if (!out.ok) return res.status(out.status || 400).json({ error: out.error });
  // The entity's own conditions and the mirror, after the write — best-effort,
  // so neither can reverse a company a person just put on a profile.
  await entityProfile.afterPutOnProfile(out.llcId);
  return res.status(201).json(out);
});

/**
 * FILE A DOCUMENT ONTO ONE OF THE COMPANY'S SLOTS.
 *
 * THE COMPANY AND THE SLOT ARE BOTH RE-DERIVED HERE, never taken from the body:
 * the loan says which borrower, the borrower's profile says which company, and
 * the shared door then scopes the slot to that company (`WHERE id=$1 AND
 * llc_id=$2`). So a caller naming another borrower's company, or another
 * company's slot, files nothing — the same discipline the condition door applies
 * by taking the condition from the path.
 */
const uploadEntitySlotDoc = async (req, res) => {
  const scoped = await loadScopedLoan(req, res, 'lt-vesting-entity-doc');
  if (!scoped) return;
  if (!UUID_RE.test(String(req.params.slotItemId || ''))) {
    return res.status(404).json({ error: 'That document slot is not on this company.' });
  }

  // WHICH COMPANY — resolved from the loan, exactly as the read side does, so
  // the two can never disagree about which company this loan's condition is
  // about. This never CREATES one: uploading is not the moment to put a company
  // on somebody's permanent record, and the button above is.
  let prefill = null;
  try {
    // The loan row the ACCESS CHECK already ran on (`loadScopedLoan` selects
    // `l.*`), not a second read of the same table — two reads are two chances to
    // answer about different rows.
    prefill = await entityPrefill.forEntity(
      scoped.loan.borrower_id, scoped.loan.vesting_entity_name, db,
    );
  } catch (_) {
    prefill = null;
  }
  if (!prefill || prefill.unreadable) {
    return res.status(503).json({ error: 'PILOT could not read the borrower’s profile just now. Try again in a moment.' });
  }
  if (!prefill.found || !prefill.llcId) {
    return res.status(409).json({
      error: 'This company is not on the borrower’s profile yet. Save it to the profile first, then its documents have somewhere to go.',
    });
  }

  return fileEntityDocument(req, res, {
    llcId: prefill.llcId,
    borrowerId: scoped.loan.borrower_id || null,
    loanId: scoped.loan.id,
    slotItemId: String(req.params.slotItemId),
  });
};

/**
 * FILE A DOCUMENT ONTO ONE OF A COMPANY'S SLOTS — the body BOTH entity upload
 * doors share.
 *
 * The two doors differ only in HOW they establish which company: one resolves
 * the loan's own vesting company from the profile, the other resolves any
 * company in that loan's ownership chain (`scopedEntity`). By the time either
 * of them gets here the company is settled, so everything that decides what
 * happens to the BYTES — the verified lock, the intake contract, the slot coming
 * from the path, the owner columns — is written once.
 *
 * A function DECLARATION on purpose: it is hoisted, so it can sit beside the
 * doors that use it without the file having to be read in dependency order.
 */
async function fileEntityDocument(req, res, { llcId, borrowerId, loanId, slotItemId }) {
  /* THE VERIFIED LOCK, and it is the SHORT-TERM one (2026-08-31). A verified
     company's papers have been read and accepted, so replacing one behind the
     verification would leave a company marked "checked" against documents nobody
     checked — and the entity is SHARED, so a long-term upload that walked past
     the lock would undermine a short-term verification of the same company.
     Revoking is the recorded way through, and it is one click. */
  const lock = await llcEdit.documentLock(llcId, db);
  if (!lock.ok) return res.status(lock.status || 400).json({ error: lock.error });

  const body = Object.assign({}, req.body || {});
  try { condUpload.assertUploadIntake(body); }
  catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  // THE SLOT COMES FROM THE PATH, never the body — same rule as the condition id
  // on the condition door. The shared door then scopes it to this company
  // (`WHERE id=$1 AND llc_id=$2`), so a slot belonging to another company files
  // nothing rather than reaching a row a later check is trusted to refuse.
  body.checklistItemId = slotItemId;

  try {
    const landed = await condUpload.uploadConditionDocument(req, {
      owner: ownerOf('lt_loan', loanId),
      body,
      actorId: staffId(req),
      /* THE COMPANY, NOT THE LOAN. The shared door reads this and files the
         document against `llc_id` with BOTH file-owner columns null — the shape
         a short-term borrower upload has always produced. That is what makes
         this ONE document on the profile rather than a copy of one. */
      llcId,
      /* The entity documents ARE the borrower's, and the short-term entity
         screens select on `documents.borrower_id`, so unlike a long-term
         CONDITION document (which must never appear on the RTL borrower's
         screen) this one is stamped: it is a profile document by construction,
         and it is exactly what the next loan is meant to find. */
      borrowerId: borrowerId || null,
      hooks: {},
      q: db,
    });
    /* THE ENTITY'S OWN CONDITIONS, on BOTH products, after the write. A document
       landing on a slot can complete an entity, and each product syncs its own
       condition (the short-term one joins `applications`, so it can neither see
       nor touch a long-term file, and the long-term one is this router's). Both
       are best-effort: the document is already filed, and a condition that did
       not re-sync is fixed by the next read, while a throw here would report a
       successful upload as a failure. */
    try { await llcLib.syncLlcConditions(llcId); } catch (_) { /* best-effort */ }
    await syncLtEntityCondition(llcId);
    /* NO SHAREPOINT KICK HERE, deliberately. The mirror's own drain finds this
       document on its next pass exactly as it finds every other Long-Term one
       (this router's condition-document door does not kick either), and a kick
       is only a latency shortcut — it would buy seconds at the price of a
       crossing into the short-term mirror that nothing else on this side makes. */
    return res.status(201).json({
      ok: true,
      documentId: landed.documentId,
      deduped: !!landed.deduped,
      llcId,
    });
  } catch (e) {
    if (e && e.status) return res.status(e.status).json({ error: e.message });
    console.error('[lt] entity slot upload failed:', (e && e.message) || e);
    return res.status(500).json({ error: 'That document could not be filed just now.' });
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   THE ENTITY SECTION — the SAME one, reached from a Long-Term file.

   Owner-directed 2026-08-31: *"I think you're missing the entire entity section
   that we were officially needing to bring in from the RTL side. The logic
   should work the same: the exact entity section, same exact form information to
   type in an entity section. The exact verification workflow. The entity section
   should be directly linked to the profile. The exact document slots and
   bi-directional … Bring in the entire logic, just giving you authorization to
   share the code. Don't reinvent."*

   NOT ONE RULE IS RE-STATED HERE. Every one of these doors is a scope check and
   a call into `lib/llc-edit.js` — the module the short-term routes now call too,
   so "may this be edited", "does the ownership add up", "who may verify", "what
   does a revoke do to the entities underneath it" have ONE answer for both
   products. What is passed in is what genuinely belongs to this side: which
   entity this loan may reach, and which condition to re-sync afterwards.

   ── WHICH ENTITY A LOAN MAY REACH ──────────────────────────────────────────
   The loan's own vesting company, and the companies that OWN it. Layered
   entities verify bottom-up, so an owner has to be workable from the file that
   depends on it — and nothing else on the borrower's profile is reachable from
   here at all. A caller naming another company gets the same answer as one
   naming a company that does not exist.
   ═══════════════════════════════════════════════════════════════════════════ */
const llcLib = require('../../lib/llc');
const llcEdit = require('../../lib/llc-edit');

/**
 * Resolve `:llcId` against the loan, or answer the caller and return null.
 *
 * FAILS CLOSED on an unreadable profile: "we could not read it" is answered as a
 * 503 a person can retry, never as "that is not your company".
 */
async function scopedEntity(req, res) {
  const scoped = await loadScopedLoan(req, res, 'lt-entity');
  if (!scoped) return null;
  const llcId = String(req.params.llcId || '');
  if (!UUID_RE.test(llcId)) {
    res.status(404).json({ error: 'That company is not on this loan.' });
    return null;
  }
  return entityReachable(req, res, scoped, llcId);
}

/**
 * Is `llcId` a company THIS LOAN may reach, given the loan is already authorized?
 *
 * Split out of `scopedEntity` because the DOCUMENT door derives the company from
 * the document rather than from the path, and both must answer that question the
 * same way — a second copy is how one door ends up reaching a company the other
 * refuses.
 */
async function entityReachable(req, res, scoped, llcId) {
  let prefill = null;
  try {
    prefill = await entityPrefill.forEntity(scoped.loan.borrower_id, scoped.loan.vesting_entity_name, db);
  } catch (_) { prefill = null; }
  if (!prefill || prefill.unreadable) {
    res.status(503).json({ error: 'PILOT could not read the borrower’s profile just now. Try again in a moment.' });
    return null;
  }
  if (!prefill.found || !prefill.llcId) {
    res.status(409).json({
      error: 'This company is not on the borrower’s profile yet. Save it to the profile first.',
    });
    return null;
  }

  if (String(prefill.llcId) !== llcId) {
    // An OWNER in the chain is reachable; anything else is not.
    let ancestors = [];
    try { ancestors = await llcLib.getAncestorEntityIds(prefill.llcId); } catch (_) { ancestors = null; }
    if (!ancestors) {
      res.status(503).json({ error: 'PILOT could not read the ownership chain just now. Try again in a moment.' });
      return null;
    }
    if (!ancestors.map(String).includes(llcId)) {
      res.status(404).json({ error: 'That company is not on this loan.' });
      return null;
    }
  }
  return { scoped, llcId, vestingLlcId: String(prefill.llcId) };
}

/* THE LONG-TERM CONDITION THIS ENTITY ANSWERS. `llc.syncLlcConditions` is the
   SHORT-TERM one — it joins `applications` and `rtl_p1_llc` — so it can neither
   see nor touch a long-term file, and calling it here would silently do nothing.
   Each product syncs its OWN condition; the ENTITY is what is shared. */
async function syncLtEntityCondition(llcId) {
  try {
    const bundle = await llcLib.getLlcBundle(llcId);
    if (!bundle) return;
    const verified = !!bundle.is_verified;
    /* EVERY long-term file that vests in this company by NAME. The loan carries
       `vesting_entity_name` rather than an entity id, which is the same join the
       prefill read uses, so the two cannot disagree about which files a company
       is on. */
    /* EVERY PARAMETER BOUND HERE IS REFERENCED, and that is not tidiness:
       Postgres REFUSES a statement carrying a parameter it cannot type, so an
       unused `$1` makes the whole UPDATE throw — and `llc-edit` runs this as a
       best-effort hook, which SWALLOWS the error. The first cut of this bound
       the entity id and never used it (the match is by NAME, deliberately), so
       verifying a company from a long-term file silently moved no condition at
       all. Caught by the suite before it shipped; the same class this repo has
       recorded once already on the borrower-view scope. */
    await db.query(
      `UPDATE checklist_items ci
          SET status = CASE WHEN $1 THEN 'satisfied' ELSE 'outstanding' END,
              signed_off_at = CASE WHEN $1 THEN COALESCE(ci.signed_off_at, now()) ELSE NULL END,
              signed_off_by = CASE WHEN $1 THEN ci.signed_off_by ELSE NULL END,
              notes = CASE WHEN ci.notes IS NULL OR ci.notes LIKE '[auto]%'
                           THEN $2 ELSE ci.notes END,
              updated_at = now()
         FROM checklist_templates t, lt_loans l
        WHERE t.id = ci.template_id AND t.code = 'lt_vesting_entity'
          AND l.id = ci.lt_loan_id
          AND lower(btrim(COALESCE(l.vesting_entity_name,''))) = lower(btrim($3))
          AND ci.status IS DISTINCT FROM CASE WHEN $1 THEN 'satisfied' ELSE 'outstanding' END`,
      [verified,
        verified
          ? `[auto] "${bundle.llc_name}" is verified on the borrower’s profile — condition satisfied.`
          : `[auto] Verification of "${bundle.llc_name}" was revoked, so this condition is open again.`,
        bundle.llc_name || ''],
    );
  } catch (e) {
    // Best-effort by design: the entity is already written, and a condition that
    // did not re-sync is fixed by the next read, while a throw here would report
    // a successful verification as a failure.
    console.warn('[lt] entity condition sync failed:', (e && e.message) || e);
  }
}

// GET …/entities/:llcId — the whole bundle the shared entity section renders.
router.get('/loans/:loanId/entities/:llcId', async (req, res) => {
  const found = await scopedEntity(req, res);
  if (!found) return;
  try {
    const bundle = await llcLib.getLlcBundle(found.llcId);
    if (!bundle) return res.status(404).json({ error: 'That company is not on this loan.' });
    res.json({ ...bundle, read_only: false, vesting: String(found.llcId) === found.vestingLlcId });
  } catch (e) {
    console.error('[lt] entity read failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not read that company just now.' });
  }
});

// PATCH …/entities/:llcId — its own details.
router.patch('/loans/:loanId/entities/:llcId', async (req, res) => {
  const found = await scopedEntity(req, res);
  if (!found) return;
  const out = await llcEdit.updateDetails(found.llcId, req.body || {}, { actorId: staffId(req) });
  if (!out.ok) return res.status(out.status || 400).json({ error: out.error });
  res.json({ ok: true });
});

// PUT …/entities/:llcId/members — who owns it, and how much.
router.put('/loans/:loanId/entities/:llcId/members', async (req, res) => {
  const found = await scopedEntity(req, res);
  if (!found) return;
  const out = await llcEdit.saveMembers(found.llcId, (req.body || {}).members || [], {
    // The long-term desk is STAFF, so it sets the signature title and, on a
    // corporation, the shares and certificate number — exactly as the
    // short-term staff door does.
    allowOwnerDetails: true,
    syncConditions: (id) => syncLtEntityCondition(id),
  });
  if (!out.ok) return res.status(out.status || 400).json({ error: out.error });
  res.json({ ok: true });
});

// POST …/entities/:llcId/verify — the SAME workflow, with this side's condition.
router.post('/loans/:loanId/entities/:llcId/verify', async (req, res) => {
  const found = await scopedEntity(req, res);
  if (!found) return;
  const out = await llcEdit.setVerified(found.llcId, req.body || {}, {
    actorId: staffId(req),
    /* VERIFYING IS A SIGN-OFF and the rule that it is a processor's call is the
       shared module's. This side's answer to "may this person sign off" is the
       one its own condition doors use: working a long-term file is any staff
       member's job (this router's header, rule 4). */
    maySignOff: true,
    syncConditions: (id) => syncLtEntityCondition(id),
  });
  if (!out.ok) {
    const body = { error: out.error };
    if (out.missing) body.missing = out.missing;
    return res.status(out.status || 400).json(body);
  }
  res.json(out);
});

/* ── THE COMPANY'S DOCUMENT SLOTS, FOR EVERY COMPANY THIS LOAN REACHES ────────
 *
 * The pair above is the VESTING company's, resolved from the loan's own name.
 * These are the same doors for any company `scopedEntity` admits — which is the
 * vesting company AND the companies that own it, because a layered entity
 * verifies bottom-up and its owner's operating agreement has to be fileable from
 * the file that depends on it. Anything else on the borrower's profile is not
 * reachable from here at all.
 *
 * TWO TRANSPORTS, ONE HANDLER, for the reason the condition door has two: the
 * JSON door carries the file as base64 in the body and is capped at 25 MB, while
 * the streamed door writes to storage as the bytes arrive and is bounded by the
 * 1 GB document ceiling. An operating agreement is a multi-page scan and is
 * routinely the largest thing anybody files on a loan.
 * ──────────────────────────────────────────────────────────────────────────── */
const uploadEntityDoc = async (req, res) => {
  const found = await scopedEntity(req, res);
  if (!found) return;
  if (!UUID_RE.test(String(req.params.slotItemId || ''))) {
    return res.status(404).json({ error: 'That document slot is not on this company.' });
  }
  return fileEntityDocument(req, res, {
    llcId: found.llcId,
    borrowerId: found.scoped.loan.borrower_id || null,
    loanId: found.scoped.loan.id,
    slotItemId: String(req.params.slotItemId),
  });
};
router.post('/loans/:loanId/entities/:llcId/slots/:slotItemId/documents', uploadEntityDoc);
router.post('/loans/:loanId/entities/:llcId/slots/:slotItemId/documents/binary',
  require('../../lib/upload-stream').binaryIntake, uploadEntityDoc);

/**
 * GET …/entities/documents/:documentId/file — open one of a company's documents,
 * or preview it with `?inline=1`.
 *
 * IT CANNOT GO THROUGH `scopedDocument`. That door's first statement is the
 * product boundary — `lt_loan_id IS NOT NULL` — and an ENTITY document has NO
 * file owner at all (both owner columns null, `llc_id` carries it), which is
 * exactly what makes it follow the company to every loan it vests. So the scope
 * is the COMPANY, and the company is DERIVED FROM THE DOCUMENT rather than taken
 * from the path: the read below returns nothing for a document that belongs to a
 * loan file on either product, and the company it does return is then put
 * through the same `entityReachable` the path-scoped doors use. A document on
 * another borrower's company is refused for the same reason and in the same
 * sentence as one on a company that does not exist.
 *
 * NOT in the path deliberately — the shared entity section renders a whole
 * ownership CHAIN from one adapter, and a nested owner's document must download
 * through the same call as the vesting company's without every level having to
 * carry its own copy of the id.
 *
 * The BYTES are the one implementation every download in this codebase uses, so
 * the content-type scrub and the narrow inline allowlist are not restated here.
 */
router.get('/loans/:loanId/entities/documents/:documentId/file', async (req, res) => {
  const scoped = await loadScopedLoan(req, res, 'lt-entity-doc');
  if (!scoped) return;
  const documentId = String(req.params.documentId || '');
  if (!UUID_RE.test(documentId)) {
    return res.status(404).json({ error: 'That document is not on this company.' });
  }
  let row;
  try {
    ({ rows: [row] } = await db.query(
      `SELECT llc_id FROM documents
        WHERE id = $1::uuid AND llc_id IS NOT NULL
          AND application_id IS NULL AND lt_loan_id IS NULL`,
      [documentId],
    ));
  } catch (e) {
    console.error('[lt] entity document lookup failed:', (e && e.message) || e);
    return res.status(503).json({ error: 'Could not read that document just now. Try again in a moment.' });
  }
  if (!row) return res.status(404).json({ error: 'That document is not on this company.' });

  const found = await entityReachable(req, res, scoped, String(row.llc_id));
  if (!found) return;
  try {
    const doc = await condServe.entityDocumentForServe(db, documentId, found.llcId);
    if (!doc) return res.status(404).json({ error: 'That document is not on this company.' });
    return condServe.serveConditionDocument(res, doc, { inline: req.query.inline === '1' });
  } catch (e) {
    console.error('[lt] entity document serve failed:', (e && e.message) || e);
    return res.status(503).json({ error: 'Could not open that document just now. Try again in a moment.' });
  }
});

router.post('/loans/:loanId/vesting-entity/slots/:slotItemId/documents', uploadEntitySlotDoc);
router.post('/loans/:loanId/vesting-entity/slots/:slotItemId/documents/binary',
  require('../../lib/upload-stream').binaryIntake, uploadEntitySlotDoc);

// POST …/documents/:documentId/review — accept or reject one.
router.post('/documents/:documentId/review', async (req, res) => {
  const found = await scopedDocument(req, res);
  if (!found) return;
  let verdict;
  try {
    /* WHO MAY ACCEPT is the caller's, because the two products have different
       role systems — and on this side rule 4 of this router's header settles it:
       *working a condition on a file is any staff member's*. Satisfying a
       condition outright already needs nothing beyond opening the file
       (`…/satisfy`), so gating ACCEPT — a weaker act, on one document — harder
       than that would be incoherent. The ORDER and the WORDING of the refusals
       are the shared door's, so the two products can never answer a different
       sentence to the same bad request. */
    verdict = condReview.validateVerdict(req.body || {}, { canAccept: true });
  } catch (e) {
    if (e && e.status) return res.status(e.status).json({ error: e.message });
    throw e;
  }
  try {
    const doc = await condReview.loadDocument(db, found.documentId, found.owner);
    if (!doc) return res.status(404).json({ error: 'That document is not on this file.' });
    const out = await condReview.applyVerdict(db, {
      doc, verdict, actorId: staffId(req), hooks: {},
    });

    /* AND THE BORROWER IS TOLD — the parity engine's own finding (2026-08-31).
       Sending a document back reopened the condition and NOBODY WAS TOLD, so the
       borrower had no way to learn short of opening the portal and noticing,
       while the same act on a short-term file has emailed them since it shipped.

       The notice decides for itself whether there is anything to say (a plain
       accept is an internal step; an internal condition is not the borrower's),
       throttles on the SHARED claim so a set of exported formats rejected
       together sends one email, and NEVER THROWS — the verdict is already
       recorded, so a mail failure must never report a completed review as an
       error. Its answer rides on the response so the desk can see what happened
       rather than having to guess. */
    const told = await guestSend.sendVerdictNotice({
      loanId: found.scoped.loan.id,
      checklistItemId: doc.checklist_item_id,
      filename: doc.filename,
      action: verdict.status === 'rejected' ? 'reject'
        : (verdict.requestMore ? 'request_more' : 'accept'),
      reason: verdict.status === 'rejected' ? (req.body || {}).reason : verdict.moreNote,
      actorId: staffId(req),
    }, db);
    return res.json({ ok: true, ...out, borrowerTold: told.sent === true, borrowerWhy: told.why });
  } catch (e) {
    console.error('[lt] condition document review failed:', (e && e.message) || e);
    return res.status(500).json({ error: 'Could not record that decision just now.' });
  }
});

/**
 * PUT …/documents/:documentId/slot — file a returned document into its slot.
 *
 * Owner-directed 2026-08-31: *"Each document should be linked to a slot within
 * the condition … When the documents are coming back from the order, we can
 * assign each document to each and every slot after previewing it."*
 *
 * The order desk already GUESSES on arrival (`orders/kinds.js slotMap` reads the
 * filename), which is right for the common case and cannot be right for all of
 * them — a title company that names three attachments "scan001.pdf" defeats any
 * rule there will ever be. This is the human's correction, and until it existed
 * `slot_label` was written ONCE at upload and could never be changed.
 *
 * THE SLOT MUST BE ONE THE CONDITION ACTUALLY HAS. A free-typed label files a
 * document into a slot nothing renders — it is then invisible on the screen, and
 * the condition reads as missing a document that is sitting right there. So the
 * label is matched against the condition's own `slots`, and anything else is a
 * refusal rather than a silent write.
 *
 * `null` UNFILES it, deliberately: a document put in the wrong slot has to be
 * takeable back out, and forcing somebody to pick a different wrong slot to undo
 * a mistake is how wrong data becomes permanent.
 */
router.put('/documents/:documentId/slot', async (req, res) => {
  const found = await scopedDocument(req, res);
  if (!found) return;
  const raw = (req.body || {}).slot;
  const wants = raw == null || raw === '' ? null : String(raw).trim();

  try {
    // The document's own condition, and that condition's slots. Read together so
    // the check is against the slot list of the condition the document is
    // actually on — not the one the caller says it is on.
    const { rows } = await db.query(
      `SELECT d.id, d.checklist_item_id, COALESCE(t.slots, ci.slots, '[]'::jsonb) AS slots
         FROM documents d
         JOIN checklist_items ci ON ci.id = d.checklist_item_id
         LEFT JOIN checklist_templates t ON t.id = ci.template_id
        WHERE d.id = $1::uuid`,
      [found.documentId]);
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'That document is not on this file.' });
    if (!row.checklist_item_id) {
      return res.status(409).json({ error: 'That document is not on a condition, so it has no slot to go in.' });
    }

    const slots = Array.isArray(row.slots) ? row.slots : [];
    if (wants !== null) {
      const hit = slots.find((sl) => String(sl.label) === wants || String(sl.key) === wants);
      if (!hit) {
        return res.status(400).json({
          error: 'That is not one of this condition’s slots.',
          slots: slots.map((sl) => sl.label),
        });
      }
      // Stored as the LABEL, because that is what every existing reader of
      // `slot_label` compares against (lib/order-slots.js matches on an exact
      // label) and what the screen prints.
      await db.query(`UPDATE documents SET slot_label = $2 WHERE id = $1::uuid`,
        [found.documentId, String(hit.label)]);
      return res.json({ ok: true, slot: String(hit.label) });
    }
    await db.query(`UPDATE documents SET slot_label = NULL WHERE id = $1::uuid`, [found.documentId]);
    return res.json({ ok: true, slot: null });
  } catch (e) {
    console.error('[lt] condition document slot write failed:', (e && e.message) || e);
    return res.status(500).json({ error: 'Could not file that document just now.' });
  }
});

// DELETE …/documents/:documentId — remove one permanently.
router.delete('/documents/:documentId', async (req, res) => {
  const found = await scopedDocument(req, res);
  if (!found) return;
  try {
    const doc = await condRemove.loadDocument(db, found.documentId, found.owner);
    if (!doc) return res.status(404).json({ error: 'That document is not on this file.' });
    const out = await condRemove.removeDocument(db, { doc, owner: found.owner, hooks: {} });
    // The shared door answers `{deleted:false}` when the owner-scoped DELETE
    // matched nothing — it says so rather than reporting a success that never
    // happened, and so does this.
    if (!out.deleted) return res.status(404).json({ error: 'That document is not on this file.' });
    return res.json({ ok: true, ...out });
  } catch (e) {
    console.error('[lt] condition document delete failed:', (e && e.message) || e);
    return res.status(500).json({ error: 'Could not remove that document just now.' });
  }
});

// GET …/documents/:documentId/file — download it, or preview it with ?inline=1.
router.get('/documents/:documentId/file', async (req, res) => {
  const found = await scopedDocument(req, res);
  if (!found) return;
  try {
    const doc = await condServe.documentForServe(db, found.documentId, found.owner);
    if (!doc) return res.status(404).json({ error: 'That document is not on this file.' });
    // The BYTES have had one definition since day one (lib/serve-document.js):
    // it scrubs the attacker-controlled content type, refuses to render anything
    // outside a narrow inline allowlist and sets one Content-Disposition.
    // Nothing here duplicates a line of it.
    return condServe.serveConditionDocument(res, doc, { inline: req.query.inline === '1' });
  } catch (e) {
    console.error('[lt] condition document serve failed:', (e && e.message) || e);
    return res.status(500).json({ error: 'Could not open that document just now.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// THE LIBRARY — the settings side.
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/lt/condition-center/library — every bucket, every template, and the
// fields a rule may name. The rule builder draws its whole picker from THIS, so
// a screen can never offer a field the evaluator would refuse.
// ─────────────────────────────────────────────────────────────────────────────
// THE LOGIN-FREE LINK — email the borrower their outstanding conditions
//
// The owner asked for this on 2026-08-28: *"another way for borrowers to manage
// their conditions if they're not so technical … an email directly with links to
// upload and enter the information over there … without him being able to set up
// an account or portal."*
//
// EVERY MOVING PART IS THE SHARED ONE. The link, its expiry, its revocation, the
// jail that decides which doors a guest may reach, the token and the email body
// all live in `src/lib/condition-link.js` — the same module the short-term desk
// has used since it shipped, authorized in the crossing ledger. What is here is
// the three things that are genuinely this product's: which loan, who its
// borrower is, and which conditions are still outstanding.
//
// NOTHING IS RE-DERIVED ON THE SCREEN. The blockers, the recipients, the item
// list and the preview all come from this router, and the send RE-CHECKS every
// one of them rather than trusting what the screen was told a minute ago.
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/lt/condition-center/loans/:loanId/outreach — what would be sent.
router.get('/loans/:loanId/outreach', async (req, res) => {
  const scoped = await loadScopedLoan(req, res, 'lt-cond-outreach');
  if (!scoped) return;
  try {
    answer(res, await guestSend.outreachPreview(scoped.loan.id, db));
  } catch (e) {
    console.error('[lt] outreach preview failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not build the outstanding-conditions preview.' });
  }
});

// POST /api/lt/condition-center/loans/:loanId/outreach — send it.
router.post('/loans/:loanId/outreach', async (req, res) => {
  const scoped = await loadScopedLoan(req, res, 'lt-cond-outreach');
  if (!scoped) return;
  const b = req.body || {};
  try {
    answer(res, await guestSend.sendOutreach({
      loanId: scoped.loan.id,
      emails: b.emails,
      note: b.note,
      actorId: staffId(req),
    }, db));
  } catch (e) {
    console.error('[lt] outreach send failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not send the outstanding-conditions email.' });
  }
});

// POST /api/lt/condition-center/loans/:loanId/outreach/:linkId/revoke — kill one link.
router.post('/loans/:loanId/outreach/:linkId/revoke', async (req, res) => {
  const scoped = await loadScopedLoan(req, res, 'lt-cond-outreach');
  if (!scoped) return;
  if (!UUID_RE.test(String(req.params.linkId || ''))) {
    return res.status(404).json({ error: 'That link was not found on this loan.' });
  }
  try {
    answer(res, await guestSend.revokeLink({
      loanId: scoped.loan.id,
      linkId: req.params.linkId,
      actorId: staffId(req),
    }, db));
  } catch (e) {
    console.error('[lt] outreach revoke failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not revoke that link just now.' });
  }
});

router.get('/library', async (req, res) => {
  try {
    const fields = registry.fieldMap();
    // First read of the library seeds it (see library.ensureSeeded).
    await library.ensureSeeded(db);
    const [bucketRows, templateRows] = await Promise.all([
      read.buckets(db),
      // THE LIBRARY LIVES IN THE ONE CONDITION CENTER NOW (db/653), scope
      // 'lt_loan'. Every enumerated value comes straight back through
      // `vocabulary.js` — the same translation the seed wrote through — so this
      // screen goes on speaking the owner's own wording while the COLUMN speaks
      // the one vocabulary both products share.
      db.query(
        `SELECT code, category, label, hint, borrower_label, borrower_hint,
                audience, item_kind, tool_key, auto_apply, rule_logic, is_required,
                slots, config, is_active, sort_order, origin
           FROM checklist_templates
          WHERE scope = 'lt_loan'
          ORDER BY sort_order, code`,
      ).then((r) => r.rows.map((t) => ({
        ...t,
        bucket_key: vocab.bucketOf(t.category),
        audience: vocab.audienceFromShared(t.audience),
        kind: vocab.kindFromShared(t),
        is_enabled: !(t.config && t.config.enabled === false),
        disabled_reason: (t.config && t.config.disabledReason) || null,
        // `is_seeded` has no shared column; `origin='system'` is what the seed
        // writes and is the same fact — this row came from the library rather
        // than from an administrator.
        is_seeded: t.origin === 'system',
      }))),
    ]);
    res.json({
      buckets: bucketRows,
      templates: templateRows.map((t) => ({
        code: t.code,
        bucket: t.bucket_key,
        label: t.label,
        hint: t.hint,
        borrowerLabel: t.borrower_label,
        borrowerHint: t.borrower_hint,
        audience: t.audience,
        kind: t.kind,
        autoApply: t.auto_apply,
        rule: t.rule_logic,
        // The rule in words, so an administrator can READ what they are about to
        // change. A rule nobody can read is a rule nobody can safely edit.
        ruleInWords: rules.describeRule(t.rule_logic, fields),
        isRequired: t.is_required,
        slots: t.slots || [],
        config: t.config || {},
        enabled: t.is_enabled,
        disabledReason: t.disabled_reason,
        active: t.is_active,
        sortOrder: t.sort_order,
        seeded: t.is_seeded,
      })),
      fields: registry.catalog(),
      operators: rules.OPERATORS_BY_TYPE,
      operatorLabels: rules.OPERATOR_LABEL,
      noValueOperators: [...rules.NO_VALUE_OPS],
      kinds: ['informational', 'form', 'order', 'esign', 'document'],
      audiences: ['internal', 'external', 'both'],
      canEdit: await isAdmin(req),
    });
  } catch (e) {
    console.error('[lt] condition library read failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not read the condition library just now.' });
  }
});

// PATCH /api/lt/condition-center/library/:code — change one template.
//
// THE RULE IS VALIDATED BEFORE IT IS STORED, against the same registry the
// engine reads. A rule naming a field that does not exist would sit in the
// database attaching to nothing, which reads exactly like a condition nobody
// needs — and the person who wrote it would never find out.
router.patch('/library/:code', async (req, res) => {
  if (!(await isAdmin(req))) {
    return res.status(403).json({ error: 'Only an administrator can change the condition library — a template is on every file in the book.' });
  }
  const body = req.body || {};
  const sets = [];
  const params = [String(req.params.code)];
  const put = (col, val, cast) => { params.push(val); sets.push(`${col} = $${params.length}${cast || ''}`); };

  // TWO OF THE OWNER'S SETTINGS HAVE NO SHARED COLUMN and ride inside `config`
  // instead: `enabled` (built, but switched off — shown greyed WITH ITS REASON)
  // and its `disabledReason`. They are merged INTO whatever config is already
  // there rather than replacing it, or turning a condition off would wipe the
  // rest of its settings. Assembled first so the ordinary `config` branch below
  // can fold them into one write.
  const cfgPatch = {};
  if (Object.prototype.hasOwnProperty.call(body, 'enabled')) cfgPatch.enabled = body.enabled === true;
  if (Object.prototype.hasOwnProperty.call(body, 'disabledReason')) {
    const v = String(body.disabledReason == null ? '' : body.disabledReason).trim();
    cfgPatch.disabledReason = v === '' ? null : v.slice(0, 4000);
  }

  const TEXT = { label: 'label', hint: 'hint', borrowerLabel: 'borrower_label', borrowerHint: 'borrower_hint' };
  for (const [k, col] of Object.entries(TEXT)) {
    if (Object.prototype.hasOwnProperty.call(body, k)) {
      const v = String(body[k] == null ? '' : body[k]).trim();
      put(col, v === '' ? null : v.slice(0, 4000));
    }
  }
  if (Object.prototype.hasOwnProperty.call(body, 'bucket')) {
    const category = vocab.categoryOf(body.bucket);
    if (!category) {
      return res.status(400).json({ error: `“${body.bucket}” is not one of the buckets a condition can sit in.` });
    }
    put('category', category);
  }
  for (const [k, col] of [['isRequired', 'is_required'], ['active', 'is_active']]) {
    if (Object.prototype.hasOwnProperty.call(body, k)) put(col, body[k] === true);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'sortOrder')) {
    const n = Number(body.sortOrder);
    if (!Number.isFinite(n)) return res.status(400).json({ error: 'The position has to be a number.' });
    put('sort_order', Math.round(n));
  }
  // The wording an administrator picks is still the OWNER'S — internal /
  // external / both, and the five kinds — and is translated on the way into the
  // column. The allow-lists are read off the translation itself so the screen
  // and the mapping can never offer different words.
  for (const [k, allowed] of [
    ['audience', Object.keys(vocab.AUDIENCE_TO_SHARED)],
    ['kind', Object.keys(vocab.KIND_TO_ITEM_KIND)],
    ['autoApply', ['always', 'rules', 'manual']],
  ]) {
    if (Object.prototype.hasOwnProperty.call(body, k)) {
      if (!allowed.includes(String(body[k]))) {
        return res.status(400).json({ error: `“${body[k]}” is not one of: ${allowed.join(', ')}.` });
      }
    }
  }
  if (Object.prototype.hasOwnProperty.call(body, 'audience')) {
    put('audience', vocab.audienceToShared(body.audience));
  }
  if (Object.prototype.hasOwnProperty.call(body, 'kind')) {
    // A kind is TWO columns — the shared item_kind and the tool_key that keeps a
    // form / order / esign out of the sign-off gate's document arm. Setting one
    // without the other would make a form ask for a document it never wants.
    const mapped = vocab.kindToShared(body.kind);
    put('item_kind', mapped.item_kind);
    put('tool_key', mapped.tool_key);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'autoApply')) put('auto_apply', String(body.autoApply));
  if (Object.prototype.hasOwnProperty.call(body, 'rule')) {
    const rule = body.rule;
    if (rule !== null) {
      const v = rules.validateRule(rule, registry.fieldMap());
      if (!v.ok) {
        return res.status(400).json({
          error: `That rule cannot be saved: ${v.problems.map((p) => p.why || p.reason).join(' ')}`,
          problems: v.problems,
        });
      }
    }
    put('rule_logic', rule === null ? null : JSON.stringify(rule), '::jsonb');
  }
  if (Object.prototype.hasOwnProperty.call(body, 'slots')) {
    if (typeof body.slots !== 'object' || body.slots === null) {
      return res.status(400).json({ error: 'slots has to be a list or an object.' });
    }
    put('slots', JSON.stringify(body.slots), '::jsonb');
  }
  if (Object.prototype.hasOwnProperty.call(body, 'config')) {
    if (typeof body.config !== 'object' || body.config === null) {
      return res.status(400).json({ error: 'config has to be a list or an object.' });
    }
    // A whole-config write still keeps the two switches unless this same request
    // is changing them, so saving the settings blob cannot silently switch a
    // held-back condition back on.
    put('config', JSON.stringify({ ...body.config, ...cfgPatch }), '::jsonb');
  } else if (Object.keys(cfgPatch).length) {
    // MERGED IN THE STATEMENT, so a settings save landing at the same moment
    // cannot be clobbered by a config this request read a moment earlier.
    put('config', JSON.stringify(cfgPatch), '::jsonb');
    sets[sets.length - 1] = `config = COALESCE(config, '{}'::jsonb) || $${params.length}::jsonb`;
  }

  if (!sets.length) return res.status(400).json({ error: 'Nothing to change.' });

  try {
    const { rows } = await db.query(
      `UPDATE checklist_templates SET ${sets.join(', ')}, updated_at = now()
        WHERE code = $1 AND scope = 'lt_loan' RETURNING code`,
      params,
    );
    if (!rows.length) return res.status(404).json({ error: 'There is no such condition in the library.' });
    // WHAT CHANGED IS TOLD, NOT IMPLIED. Editing a template does not touch the
    // files that already carry a copy of it — the wording on a live file is a
    // snapshot on purpose — and somebody who does not know that will believe
    // they have just changed every file in the book.
    res.json({
      ok: true,
      code: rows[0].code,
      note: 'Saved. Files that already carry this condition keep the wording they were given — a live file is never rewritten under somebody who is working it. New files, and any file you re-run the rules on, use this.',
    });
  } catch (e) {
    console.error('[lt] library patch failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not save that just now.' });
  }
});

// POST /api/lt/condition-center/library/preview — what would this rule do?
//
// An administrator about to change a rule that is on every file in the book
// should be able to read it in words and try it against one loan first.
router.post('/library/preview', async (req, res) => {
  if (!(await isAdmin(req))) return res.status(403).json({ error: 'Only an administrator can try a rule.' });
  const body = req.body || {};
  const fields = registry.fieldMap();
  const check = rules.validateRule(body.rule, fields);
  const out = { inWords: rules.describeRule(body.rule, fields), valid: check.ok, problems: check.problems };

  if (body.loanId && UUID_RE.test(String(body.loanId))) {
    try {
      const ctx = await engine.loadContext(String(body.loanId), db);
      out.matches = rules.evaluateRule(body.rule, ctx.values, fields);
      // NAMED, not vague: `null` is "PILOT could not read the rule against this
      // file", which is a different answer from "this file does not match".
      out.matchesWhy = out.matches === null
        ? 'PILOT could not decide this rule against that file.'
        : (out.matches ? 'That file matches.' : 'That file does not match.');
      out.unreadable = ctx.unreadable;
    } catch (e) {
      out.matchesWhy = `Could not read that file: ${String((e && e.message) || e).slice(0, 160)}`;
    }
  }
  res.json(out);
});

// ─────────────────────────────────────────────────────────────────────────────
// THE BUCKETS — the gates themselves.
// ─────────────────────────────────────────────────────────────────────────────

router.get('/buckets', async (req, res) => {
  try {
    res.json({ buckets: await read.buckets(db), canEdit: await isAdmin(req) });
  } catch (e) {
    console.error('[lt] buckets read failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not read the gates just now.' });
  }
});

router.post('/buckets', async (req, res) => {
  if (!(await isAdmin(req))) return res.status(403).json({ error: 'Only an administrator can change the gates.' });
  const body = req.body || {};
  const key = String(body.key || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const label = String(body.label || '').trim();
  if (!key || !label) return res.status(400).json({ error: 'A gate needs a name.' });
  const position = Number.isFinite(Number(body.position)) ? Math.round(Number(body.position)) : 100;
  try {
    await db.query(
      `INSERT INTO lt_condition_buckets (key, label, blurb, position)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO UPDATE
         SET label = EXCLUDED.label, blurb = EXCLUDED.blurb,
             position = EXCLUDED.position, updated_at = now()`,
      [key, label.slice(0, 120), String(body.blurb || '').trim().slice(0, 500) || null, position],
    );
    res.json({ ok: true, key });
  } catch (e) {
    console.error('[lt] bucket save failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not save that gate just now.' });
  }
});

// A gate is RETIRED, never deleted. Conditions filed under it keep their key and
// keep showing, which is the honest answer — deleting the row would leave rows
// pointing at a gate that no longer has a name.
router.delete('/buckets/:key', async (req, res) => {
  if (!(await isAdmin(req))) return res.status(403).json({ error: 'Only an administrator can change the gates.' });
  try {
    const { rows } = await db.query(
      `UPDATE lt_condition_buckets SET is_active = false, updated_at = now()
        WHERE key = $1 RETURNING key`,
      [String(req.params.key)],
    );
    if (!rows.length) return res.status(404).json({ error: 'There is no such gate.' });
    res.json({ ok: true, note: 'Retired. Conditions already filed under it keep showing — nothing was deleted.' });
  } catch (e) {
    console.error('[lt] bucket retire failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not retire that gate just now.' });
  }
});

// POST /api/lt/condition-center/library/reseed — put back anything missing.
//
// It can only ever ADD: `seed()` is ON CONFLICT DO NOTHING, so a buyer's own
// edits survive and a template somebody deliberately retired stays retired
// (it still exists, so the insert finds it). It is here for the case the seed
// could not run at boot, and it says exactly what it did.
router.post('/library/reseed', async (req, res) => {
  if (!(await isAdmin(req))) return res.status(403).json({ error: 'Only an administrator can reseed the library.' });
  try {
    const out = await library.seed(db);
    res.json({
      ok: out.verified.ok,
      inserted: out.inserted,
      alreadyThere: out.skipped,
      failed: out.failed,
      problems: out.verified.problems,
    });
  } catch (e) {
    console.error('[lt] library reseed failed:', (e && e.message) || e);
    res.status(500).json({ error: 'Could not reseed the library just now.' });
  }
});

module.exports = router;
