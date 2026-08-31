'use strict';
/**
 * LONG-TERM — CHANGING A CONDITION ON A FILE.
 *
 * Every write to a Long-Term condition that a person makes goes through here, so
 * the rules below have one home rather than one per route.
 *
 * ── THE GATE IS THE POINT ───────────────────────────────────────────────────
 *
 * `signOffProblem` is the ONE answer to "may this be marked done?", and it
 * REFUSES IN WORDS rather than with a code. A refusal a person cannot act on is
 * a dead end, and a dead end on a condition is what makes somebody reach for a
 * way around the system.
 *
 * ── NOTHING UN-REVIEWED IS FULFILMENT ───────────────────────────────────────
 *
 * A document condition needs an ACCEPTED document, not merely a document nobody
 * threw away. `<> 'rejected'` is a test for "nobody discarded this"; a document
 * nobody has looked at is `pending`, and treating it as satisfaction is how an
 * unchecked file reaches the investor.
 *
 * ── A WAIVER IS A DECISION AND IS RECORDED AS ONE ───────────────────────────
 *
 * Who waived it and why, always. "Satisfied", "waived" and "did not apply" are
 * three different facts and the last two are the ones asked about a year later.
 *
 * ── THE GATE FAILS OPEN ON AN UNREADABLE FILE, DELIBERATELY ─────────────────
 *
 * A database hiccup must never make a condition permanently unsignable. A read
 * that fails allows the sign-off and SAYS the check could not run, which is a
 * recorded decision rather than a silent one.
 *
 * ── WHERE IT WRITES (db/652 + db/653) ───────────────────────────────────────
 *
 * `checklist_items` in the ONE Condition Center, owned by `lt_loan_id`, through
 * the shared owner descriptor. Six Long-Term statuses round-trip onto the shared
 * five plus the two stamps this table has carried for a long time — the mapping
 * and the reason for it are in `vocabulary.js`; the short version is that this
 * system already had a way to say "waived" (`waived_at` beside status
 * 'satisfied') and inventing a second one is not sharing a Condition Center.
 */

const db = require('../db');
// SHARED (2026-08-30): the owner's one-out-of-three rule now lives in
// src/lib/conditions/answers.js so the ONE sign-off gate can read it too — while
// it lived here, this door and the shared gate disagreed about the same condition.
const answers = require('../../lib/conditions/answers');
const entityPrefill = require('./entity-prefill');
const vocab = require('./vocabulary');
const { ownerOf, ownerWhere, ownerCols } = require('../../lib/condition-owner');
// The generic required-slots rule, PORTED OUT OF HERE into the shared gate so
// the sign-off door and this module can never disagree about what a condition is
// still waiting on. It is imported back rather than kept as a second copy —
// which is the whole point of the port.
const requiredSlots = require('../../lib/conditions/required-slots');
// LAZY on purpose: `workspace.js` requires nothing from here today, but the two
// are the read and write halves of the same three conditions and a direct
// require would make a cycle the first time it needs one of these rules.
const workspace = require('./workspace');

/** How many accepted documents a slot-bearing condition still needs. */
function missingSlots(condition, files) {
  return requiredSlots.missingSlots(condition && condition.slots, files);
}

/** Which per-line keys have an ACCEPTED document against them. A per-line
    condition tags each upload with the liability's own key in `slot_label`, so
    the ordinary document plumbing carries it with no second table. */
function documentsByLine(files) {
  const out = {};
  for (const f of files || []) {
    if (f.is_current !== false && String(f.review_status || 'pending') === 'accepted' && f.slot_label) {
      out[String(f.slot_label)] = true;
    }
  }
  return out;
}

/**
 * May this condition be marked satisfied?
 *
 * @returns {{ok: true} | {ok: false, why: string}} — never throws.
 */
function signOffProblem(condition, files, opts = {}) {
  if (!condition) return { ok: false, why: 'That condition is not on this file.' };
  if (opts.readFailed) {
    // FAILS OPEN, and says so. The caller records `checkSkipped` on the row.
    return { ok: true, checkSkipped: 'PILOT could not read this condition’s documents, so it did not check them.' };
  }

  const kind = String(condition.kind || 'document');
  const current = (files || []).filter((f) => f.is_current);

  // NOTHING UN-REVIEWED IS EVER FULFILMENT, whatever the kind. A pending
  // document on any condition is somebody's unfinished work.
  const pending = current.filter((f) => f.review_status === 'pending');
  if (pending.length) {
    return {
      ok: false,
      why: `${pending.length} document${pending.length === 1 ? '' : 's'} on this condition ${pending.length === 1 ? 'has' : 'have'} not been looked at yet. Accept or reject ${pending.length === 1 ? 'it' : 'them'} first.`,
    };
  }

  // ── THE COMPANY IS ALREADY VERIFIED ON THE BORROWER'S PROFILE ────────────
  // The owner: *"if that LLC is already verified somehow on his profile … that
  // information should automatically be pre-filled in this condition"* and *"in
  // future when you use this LLC it's already verified."* An entity is verified
  // ONCE — a person having read the operating agreement and confirmed the
  // borrower controls the company — and asking a second loan to re-do that is
  // asking the borrower to prove the same fact twice.
  //
  // Documents present but NOT verified deliberately do NOT clear it: they
  // pre-fill the condition (so nothing is sent again) and leave it open, because
  // the review has not happened. `opts.entity` is the caller's read; an
  // unreadable profile leaves the ordinary document rules standing, which asks
  // for documents that may not be needed — the safe way to be wrong.
  if (opts.entity && opts.entity.verified) {
    return { ok: true, note: 'This company is already verified on the borrower’s profile.' };
  }

  // ── A CONDITION THAT CAN BE ANSWERED ANOTHER WAY ─────────────────────────
  // Three of these conditions are a CHOICE, not an upload: the subject
  // property's mortgage (statement, or the figures typed in, or the FCI waiver)
  // and every mortgage on the credit report (a statement, or "this is the home
  // they live in", or the property it is secured by). `answers.js` is the ONE
  // definition, read here AND by the door that records the answer, so what may
  // be recorded and what finishes the condition can never disagree.
  //
  // It is asked BEFORE the document rules on purpose: a condition answered by
  // the FCI waiver has no document and must not be refused for want of one.
  if (answers.plan(condition)) {
    const recorded = condition.answer && typeof condition.answer === 'object' ? condition.answer : {};
    const mortgages = Array.isArray(recorded.mortgages) ? recorded.mortgages : [];
    const verdict = answers.satisfies(condition, recorded, {
      // The lines that must be answered are the ones a PERSON marked as
      // mortgages, read off the condition's own answer — never re-derived here,
      // or the gate and the screen could disagree about how many there are.
      lines: mortgages.map((m) => (typeof m === 'string' ? { key: m, label: m } : m)),
      documentsByLine: documentsByLine(current),
      hasDocument: current.some((f) => f.review_status === 'accepted'),
    });
    if (!verdict.ok) return { ok: false, why: verdict.why };
    return { ok: true };
  }

  if (kind === 'document') {
    const short = missingSlots(condition, current);
    if (short.length) {
      return { ok: false, why: requiredSlots.missingSlotsMsg(short) };
    }
    const accepted = current.filter((f) => f.review_status === 'accepted');
    // A REQUIRED document condition with NOTHING on it cannot be signed off.
    // A condition that is not required may be — that is what "not required"
    // means, and refusing it would leave no way to close an optional item.
    if (!accepted.length && condition.is_required) {
      return { ok: false, why: 'Nothing has been accepted against this condition yet. Upload the document, or waive the condition with a reason.' };
    }
  }

  return { ok: true };
}

/** One condition plus its documents, scoped to a loan so an id alone reaches nothing. */
async function loadCondition(loanId, conditionId, client = db) {
  const where = ownerWhere(ownerOf('lt_loan', loanId), 'c', 2);
  const { rows } = await client.query(
    `SELECT c.*, t.code, t.config
       FROM checklist_items c
       LEFT JOIN checklist_templates t ON t.id = c.template_id
      WHERE c.id = $1::uuid AND ${where.sql}`,
    [String(conditionId), ...where.params],
  );
  if (!rows.length) return null;
  // Read back into this module's own vocabulary, once, at the door — so every
  // rule below reasons about `kind`/`status`/`answer` the way the owner's rules
  // are written, and only the statements at the bottom speak the shared column
  // names.
  const row = rows[0];
  const condition = {
    ...row,
    kind: vocab.kindFromShared(row),
    status: vocab.statusOf(row),
    answer: row.tool_payload || {},
    config: row.config || {},
  };
  let files = [];
  let readFailed = false;
  try {
    ({ rows: files } = await client.query(
      `SELECT id, slot_label, COALESCE(review_status,'pending') AS review_status,
              is_current, filename
         FROM documents WHERE checklist_item_id = $1::uuid`,
      [String(conditionId)],
    ));
  } catch (_) {
    readFailed = true;
  }
  // For the vesting-entity condition only, ask the borrower's shared profile what
  // they already hold for this company. Its own module never throws, so a failure
  // here is reported as "nothing on file" and the ordinary rules apply.
  let entity = null;
  if (String(condition.code || '') === 'lt_vesting_entity') {
    try {
      const { rows: loanRows } = await client.query(
        `SELECT borrower_id, vesting_entity_name FROM lt_loans WHERE id = $1::uuid`,
        [String(loanId)],
      );
      const loan = loanRows[0] || {};
      entity = await entityPrefill.forEntity(loan.borrower_id, loan.vesting_entity_name, client);
    } catch (_) {
      entity = null;
    }
  }

  return { condition, files, readFailed, entity };
}

/* ── THE SUBJECT-PROPERTY MORTGAGE, SATISFIED FROM THE CREDIT REPORT ────────
   Owner-directed 2026-08-31: *"If you click that button then it links to subject
   property and then the mortgage for subject property condition … It should
   satisfy two things at once, one line item of the REO … and it satisfies the
   condition for the mortgage statement for subject property."*

   TWO CONDITIONS, ONE CLICK — and the second one is written HERE rather than by
   the screen, because a screen that writes a second condition is a second write
   path with its own idea of what a valid answer looks like. This one goes
   through `answers.answerProblem` exactly as a typed answer does, so the fill is
   held to the same standard as a person typing it.

   IT NEVER OVERWRITES A PERSON. A subject-mortgage condition that already
   carries an answer somebody chose is LEFT ALONE and said so — the credit report
   is a convenience, not an authority, and quietly replacing a closer's typed
   loan number with four digits off a credit report is exactly the kind of silent
   overwrite this repo has been bitten by before. The only answer it will replace
   is one IT wrote (`filledFromCreditReport`), which is what lets the fill follow
   the line if somebody changes their mind about which mortgage it is.

   AND IT RETRACTS ITSELF. Un-mark the line and the fill that came from it goes,
   because an answer sourced from a line that no longer claims to be the subject
   property is a claim nobody is making any more.

   BEST-EFFORT, ALWAYS. The REO answer has already been recorded by the time this
   runs; a failure here reports what did not happen and never un-records it. */
const SUBJECT_CODE = 'lt_subject_mortgage_statement';

/** Which line, if any, an answer says is the mortgage on the subject property. */
function subjectLineKeys(answer) {
  const lines = (answer && answer.lines && typeof answer.lines === 'object') ? answer.lines : {};
  return Object.keys(lines).filter((k) => lines[k] && String(lines[k].way || '') === 'subject_property');
}

/** The subject-property mortgage condition on this loan, or null. */
async function subjectCondition(loanId, client) {
  const where = ownerWhere(ownerOf('lt_loan', loanId), 'c', 1);
  const { rows } = await client.query(
    `SELECT c.id, c.tool_payload AS answer, c.notes, c.status, c.signed_off_at, c.waived_at, t.code
       FROM checklist_items c
       JOIN checklist_templates t ON t.id = c.template_id
      WHERE t.code = $${where.params.length + 1} AND ${where.sql}
      ORDER BY c.created_at
      LIMIT 1`,
    [...where.params, SUBJECT_CODE],
  );
  return rows[0] || null;
}

/** The liability row behind one line key, shaped the way `answers` reads it. */
async function liabilityForKey(loanId, lineKey, client) {
  const id = String(lineKey || '').replace(/^liab:/, '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { rows } = await client.query(
    `SELECT l.id, l.creditor_name, l.account_last4, l.unpaid_balance
       FROM lt_liabilities l
       JOIN lt_parties p ON p.id = l.party_id
       JOIN lt_borrower_pairs bp ON bp.id = p.pair_id
      WHERE bp.loan_id = $1::uuid AND l.id = $2::uuid`,
    [String(loanId), id],
  );
  const r = rows[0];
  if (!r) return null;
  const last4 = String(r.account_last4 || '').trim();
  return {
    key: `liab:${r.id}`,
    label: last4 ? `${r.creditor_name || 'Unnamed creditor'} ····${last4}` : (r.creditor_name || 'Unnamed creditor'),
    creditor: r.creditor_name || null,
    last4: last4 || null,
    balance: r.unpaid_balance == null ? null : Number(r.unpaid_balance),
  };
}

/**
 * Carry a `subject_property` answer across onto the subject-mortgage condition.
 *
 * @returns {Promise<{filled?:boolean, cleared?:boolean, why?:string, note?:string}>}
 *   — a report, never a throw.
 */
async function crossFillSubjectMortgage(loanId, condition, merged, staffId, client) {
  const out = {};
  try {
    if (String(condition.code || '') !== 'lt_reo_liabilities') return out;

    const keys = subjectLineKeys(merged);
    const target = await subjectCondition(loanId, client);
    /* No such condition on the file is not a failure — on a purchase the engine
       never attached one. It is only worth SAYING when somebody has just claimed
       a line; otherwise every ordinary save of this condition would carry a
       sentence about a condition that has nothing to do with it. */
    if (!target) {
      return keys.length
        ? { why: 'There is no subject-property mortgage condition on this file to fill in.' }
        : out;
    }

    const existing = target.answer && typeof target.answer === 'object' ? target.answer : {};
    const ours = answers.filledFromCreditReport(existing);

    if (!keys.length) {
      // RETRACT — but only our own fill, and never one somebody has signed off.
      if (!ours) return out;
      if (target.signed_off_at || target.waived_at) {
        return { why: 'The subject-property mortgage condition is already signed off, so its answer was left as it is.' };
      }
      await client.query(
        `UPDATE checklist_items
            SET tool_payload = '{}'::jsonb, notes = $2, updated_at = now()
          WHERE id = $1::uuid`,
        [String(target.id), appendNote(target.notes, '[auto] The mortgage on the credit report is no longer marked as the one on the subject property, so the figures filled in from it were removed.')],
      );
      return { cleared: true, note: 'The figures that had been filled in from the credit report were removed.' };
    }

    if (!ours && answers._internals.has(existing.way)) {
      return { why: 'The subject-property mortgage condition already has an answer somebody chose, so it was left alone.' };
    }

    const line = await liabilityForKey(loanId, keys[0], client);
    if (!line) return { why: 'PILOT could not read that mortgage off the credit report to fill the statement condition in.' };

    const fill = answers.creditReportFill(line);
    if (!fill.ok) return { why: `The statement condition was not filled in because ${fill.why}.` };

    // HELD TO THE SAME STANDARD AS A TYPED ANSWER — through the one validator.
    const problem = answers.answerProblem({ code: SUBJECT_CODE }, fill.answer, { hasDocument: false });
    if (problem) return { why: `The statement condition was not filled in: ${problem}` };

    const answer = { ...fill.answer, answeredBy: staffId || null };
    if (JSON.stringify(existing) === JSON.stringify(answer)) return { filled: true };

    await client.query(
      `UPDATE checklist_items
          SET tool_payload = $2::jsonb, notes = $3, updated_at = now()
        WHERE id = $1::uuid`,
      [String(target.id), JSON.stringify(answer), appendNote(target.notes, `[auto] ${answers.sourceNote(answer)}`)],
    );
    return { filled: true, note: answers.sourceNote(answer) };
  } catch (_) {
    return { why: 'PILOT could not fill in the subject-property mortgage condition just now.' };
  }
}

/**
 * RECORD THE ANSWER on a condition that is a CHOICE rather than an upload.
 *
 * MERGES rather than replaces, for one reason worth keeping: the mortgages
 * condition is worked a line at a time over days, and a screen that posted the
 * whole shape would wipe a colleague's line whenever two people had the file
 * open. A caller that genuinely means "forget this line" sends it as null.
 *
 * VALIDATED THROUGH `answers.js` — the SAME module the sign-off gate reads — so
 * a shape this door accepts is always one the gate will honour.
 */
async function recordAnswer(loanId, conditionId, incoming, staffId, client = db) {
  const found = await loadCondition(loanId, conditionId, client);
  if (!found) return { ok: false, status: 404, error: 'That condition is not on this file.' };

  const { condition, files } = found;
  if (!answers.plan(condition)) {
    return { ok: false, status: 400, error: 'This condition is not answered that way.' };
  }

  const current = (files || []).filter((f) => f.is_current);
  const existing = condition.answer && typeof condition.answer === 'object' ? condition.answer : {};
  const patch = incoming && typeof incoming === 'object' ? incoming : {};

  // Merge one level for `lines`; everything else is replaced as sent.
  const merged = { ...existing, ...patch };
  if (patch.lines && typeof patch.lines === 'object') {
    const lines = { ...(existing.lines || {}) };
    for (const [k, v] of Object.entries(patch.lines)) {
      if (v === null) delete lines[k]; else lines[k] = v;
    }
    merged.lines = lines;
  }

  /* ONLY ONE MORTGAGE CAN BE THE ONE ON THE SUBJECT PROPERTY. Two lines both
     claiming it is a contradiction, and the cross-fill below would silently pick
     whichever came first — so it is refused here, in words, before anything is
     written. */
  const subjectKeys = subjectLineKeys(merged);
  if (subjectKeys.length > 1) {
    return {
      ok: false,
      status: 422,
      error: 'Only one mortgage can be the one on the subject property — there is one loan being refinanced. Choose a different answer for the others.',
    };
  }

  // WHAT KIND OF DEAL THIS IS — read through the SAME `dealFor` the screen uses,
  // so a way this door refuses is one the screen never offered.
  const deal = await workspace._internals.dealFor(loanId, client);

  // REFUSE A SHAPE THE GATE WOULD NOT HONOUR. A door that accepts what the gate
  // ignores leaves somebody pressing a button that changes nothing.
  const problem = answers.answerProblem(condition, merged, {
    deal,
    hasDocument: current.some((f) => f.review_status === 'accepted'),
    documentsByLine: documentsByLine(current),
    lineLabels: Object.fromEntries(
      (Array.isArray(merged.mortgages) ? merged.mortgages : [])
        .filter((m) => m && typeof m === 'object')
        .map((m) => [String(m.key), String(m.label || m.key)]),
    ),
  });
  if (problem) return { ok: false, status: 422, error: problem };

  merged.answeredBy = staffId || null;

  // `tool_payload` IS the shared table's answer column — the place RTL already
  // keeps a submitted tool answer, which is why undoing a sign-off there reads
  // it to decide whether a condition goes back to 'received' or 'outstanding'.
  // Long-Term gets that behaviour for free by using it rather than a new column.
  const w = ownerWhere(ownerOf('lt_loan', loanId), null, 2);
  const { rows } = await client.query(
    `UPDATE checklist_items
        SET tool_payload = $3::jsonb, updated_at = now()
      WHERE id = $1::uuid AND ${w.sql}
      RETURNING id, tool_payload AS answer, status`,
    [String(conditionId), ...w.params, JSON.stringify(merged)],
  );
  if (!rows.length) return { ok: false, status: 404, error: 'That condition is not on this file.' };

  // TWO CONDITIONS, ONE CLICK — best-effort, and only AFTER this answer is safely
  // recorded. It reports what it did or could not do; it can never undo the write
  // above, which is the answer the person actually made.
  const subject = await crossFillSubjectMortgage(loanId, condition, merged, staffId, client);

  return { ok: true, condition: { ...rows[0], status: vocab.statusOf(rows[0]) }, subjectMortgage: subject };
}

/** Mark a condition satisfied, if the gate allows it. */
async function satisfy(loanId, conditionId, staffId, client = db) {
  const found = await loadCondition(loanId, conditionId, client);
  if (!found) return { ok: false, status: 404, error: 'That condition is not on this file.' };

  const gate = signOffProblem(found.condition, found.files, { readFailed: found.readFailed, entity: found.entity });
  if (!gate.ok) return { ok: false, status: 422, error: gate.why };

  const note = gate.checkSkipped
    ? appendNote(found.condition.notes, `[auto] ${gate.checkSkipped}`)
    : found.condition.notes;

  const { rows } = await client.query(
    `UPDATE checklist_items
        SET status = 'satisfied', signed_off_at = now(), signed_off_by = $2::uuid,
            waived_at = NULL, waived_by = NULL, waived_reason = NULL,
            notes = $3, updated_at = now()
      WHERE id = $1::uuid RETURNING id, status, waived_at, is_required`,
    [String(conditionId), staffId || null, note],
  );
  return { ok: true, condition: shapeStatus(rows[0]), checkSkipped: gate.checkSkipped || null };
}

/**
 * Waive a condition. A REASON IS REQUIRED — a waiver with no reason is an
 * unanswerable question a year later, and this is the one place it can be asked.
 */
async function waive(loanId, conditionId, staffId, reason, client = db) {
  const clean = String(reason == null ? '' : reason).trim();
  if (clean.length < 4) {
    return { ok: false, status: 400, error: 'Say why this condition is being waived — a few words is enough, and it is what somebody reads a year from now.' };
  }
  const found = await loadCondition(loanId, conditionId, client);
  if (!found) return { ok: false, status: 404, error: 'That condition is not on this file.' };

  // A WAIVE IS `satisfied` PLUS THE STAMP — this system's own way of recording
  // one, and the reason `vocabulary.js` maps rather than widens the status CHECK
  // (src/routes/staff.js says it in those words at the RTL waive). The REASON
  // lands in its own column (db/653) rather than in free-text notes, because a
  // waiver nobody can explain a year later is the thing the rule exists to stop.
  // `is_required` is deliberately LEFT ALONE: a waived condition was required
  // and somebody decided against it, which is a different fact from one that
  // never applied.
  const { rows } = await client.query(
    `UPDATE checklist_items
        SET status = 'satisfied', waived_at = now(), waived_by = $2::uuid,
            waived_reason = $3,
            signed_off_at = NULL, signed_off_by = NULL, updated_at = now()
      WHERE id = $1::uuid RETURNING id, status, waived_at, is_required`,
    [String(conditionId), staffId || null, clean.slice(0, 500)],
  );
  return { ok: true, condition: shapeStatus(rows[0]) };
}

/**
 * Put a condition back to outstanding.
 *
 * EVERY STAMP IS CLEARED. A reopened condition that still reads "waived by
 * Chaya" is a row that contradicts itself, and the next person to look at it
 * would believe the stamp over the status.
 */
async function reopen(loanId, conditionId, client = db) {
  const w = ownerWhere(ownerOf('lt_loan', loanId), null, 2);
  const { rows } = await client.query(
    `UPDATE checklist_items
        SET status = 'outstanding',
            signed_off_at = NULL, signed_off_by = NULL,
            waived_at = NULL, waived_by = NULL, waived_reason = NULL,
            updated_at = now()
      WHERE id = $1::uuid AND ${w.sql} RETURNING id, status, waived_at, is_required`,
    [String(conditionId), ...w.params],
  );
  if (!rows.length) return { ok: false, status: 404, error: 'That condition is not on this file.' };
  return { ok: true, condition: shapeStatus(rows[0]) };
}

/** Move a condition to a working state without claiming it is finished. */
async function setStatus(loanId, conditionId, status, client = db) {
  const allowed = new Set(['outstanding', 'in_progress', 'received', 'not_applicable']);
  if (!allowed.has(String(status))) {
    return { ok: false, status: 400, error: 'That is not a status a condition can be moved to here. Satisfying or waiving one has its own door.' };
  }
  // `statusWrite` is the COMPLETE instruction for a status — the column plus
  // both stamps — so this door cannot move a condition while forgetting one.
  // "Did not apply" is `satisfied` + the waive stamp + `is_required=false`,
  // which is exactly how this system already reads a not-applicable condition.
  const w = vocab.statusWrite(status);
  const where = ownerWhere(ownerOf('lt_loan', loanId), null, 2);
  const { rows } = await client.query(
    `UPDATE checklist_items
        SET status = $3, updated_at = now(),
            signed_off_at = NULL, signed_off_by = NULL,
            waived_at = CASE WHEN $4 THEN now() ELSE NULL END,
            waived_by = NULL,
            waived_reason = CASE WHEN $4 THEN waived_reason ELSE NULL END,
            is_required = CASE WHEN $5 THEN false ELSE is_required END
      WHERE id = $1::uuid AND ${where.sql}
      RETURNING id, status, waived_at, is_required`,
    [String(conditionId), ...where.params, w.status, w.waived, w.notApplicable],
  );
  if (!rows.length) return { ok: false, status: 404, error: 'That condition is not on this file.' };
  return { ok: true, condition: shapeStatus(rows[0]) };
}

/** The internal note. Staff-only by construction — the client read never selects it. */
async function setNote(loanId, conditionId, note, client = db) {
  const w = ownerWhere(ownerOf('lt_loan', loanId), null, 2);
  const { rows } = await client.query(
    `UPDATE checklist_items SET notes = $3, updated_at = now()
      WHERE id = $1::uuid AND ${w.sql} RETURNING id`,
    [String(conditionId), ...w.params, String(note == null ? '' : note).slice(0, 4000) || null],
  );
  if (!rows.length) return { ok: false, status: 404, error: 'That condition is not on this file.' };
  return { ok: true };
}

/**
 * Add a condition to a file by hand, from the library.
 *
 * `origin` is 'manual', which is what makes it permanent: the engine only ever
 * retracts what it put there itself, so a condition a person added because they
 * know something the rules do not is never taken away by a later pass.
 */
async function addFromTemplate(loanId, code, opts = {}) {
  const client = opts.db || db;
  const { rows: t } = await client.query(
    `SELECT * FROM checklist_templates
      WHERE code = $1 AND scope = 'lt_loan' AND is_active = true`, [String(code)],
  );
  if (!t.length) return { ok: false, status: 404, error: 'There is no such condition in the library.' };
  const tpl = { ...t[0], audience: vocab.audienceFromShared(t[0].audience) };

  // The engine's own audience rule, applied here too: a borrower-facing
  // condition with no borrower wording is added STAFF-ONLY rather than shown to
  // a client under an internal label.
  const wantsClient = tpl.audience !== 'internal';
  const audience = wantsClient && String(tpl.borrower_label || '').trim() ? tpl.audience : 'internal';

  try {
    const owner = ownerOf('lt_loan', loanId);
    const cols = ownerCols(owner);
    const { rows } = await client.query(
      `INSERT INTO checklist_items
         (scope, application_id, lt_loan_id, template_id, category, field_key,
          label, hint, borrower_label, borrower_hint, audience,
          item_kind, tool_key, is_required, slots, origin_kind, sort_order)
       VALUES ($1, $2::uuid, $3::uuid, $4::uuid, $5, $6,
               $7, $8, $9, $10, $11,
               $12, $13, $14, $15::jsonb, $16, $17)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [owner.scope, cols.application_id, cols.lt_loan_id, tpl.id, tpl.category, opts.fieldKey || null,
        tpl.label, tpl.hint, tpl.borrower_label, tpl.borrower_hint, vocab.audienceToShared(audience),
        tpl.item_kind, tpl.tool_key, tpl.is_required, JSON.stringify(tpl.slots || []),
        vocab.originToShared('manual'), tpl.sort_order],
    );
    if (!rows.length) {
      return { ok: false, status: 409, error: 'That condition is already on this file.' };
    }
    return { ok: true, id: rows[0].id, downgraded: wantsClient && audience === 'internal' };
  } catch (e) {
    return { ok: false, status: 500, error: `Could not add it: ${String((e && e.message) || e).slice(0, 160)}` };
  }
}

/**
 * Remove a condition a PERSON added.
 *
 * An `auto` condition is deliberately NOT removable this way: it is there
 * because the rules say so, and taking it off by hand would put the file at odds
 * with the rule until somebody changed the rule. Waiving it is the recorded way
 * to say "not on this file", and it keeps the reason.
 */
async function removeManual(loanId, conditionId, client = db) {
  const w = ownerWhere(ownerOf('lt_loan', loanId), null, 2);
  const { rows } = await client.query(
    `DELETE FROM checklist_items
      WHERE id = $1::uuid AND ${w.sql} AND origin_kind = $3
    RETURNING id`,
    [String(conditionId), ...w.params, vocab.originToShared('manual')],
  );
  if (!rows.length) {
    return {
      ok: false,
      status: 409,
      error: 'Only a condition somebody added by hand can be removed. This one is here because the rules put it here — waive it with a reason instead, which keeps the record of why.',
    };
  }
  return { ok: true };
}

/** A written row, read back in this module's own words — so a caller never has
    to know that a waive is `satisfied` plus a stamp. */
function shapeStatus(row) {
  if (!row) return row;
  return { id: row.id, status: vocab.statusOf(row) };
}

function appendNote(existing, line) {
  const base = String(existing == null ? '' : existing).trim();
  return (base ? `${base}\n${line}` : line).slice(0, 4000);
}

module.exports = {
  recordAnswer,
  crossFillSubjectMortgage,
  missingSlots,
  signOffProblem,
  loadCondition,
  satisfy,
  waive,
  reopen,
  setStatus,
  setNote,
  addFromTemplate,
  removeManual,
  _internals: { appendNote },
};
