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
    const out = await read.forLoan(scoped.loan.id, { audience: 'internal', db });
    res.json({ loanId: scoped.loan.id, ...out });
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
    return res.status(201).json({
      ok: true,
      documentId: landed.documentId,
      deduped: !!landed.deduped,
      visibility: landed.visibility,
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
    return res.json({ ok: true, ...out });
  } catch (e) {
    console.error('[lt] condition document review failed:', (e && e.message) || e);
    return res.status(500).json({ error: 'Could not record that decision just now.' });
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
