'use strict';
/**
 * LONG-TERM — CHANGING A CONDITION ON A FILE.
 *
 * Every write to `lt_file_conditions` that a person makes goes through here, so
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
 * SEPARATION: `lt_*` only.
 */

const db = require('../db');
const answers = require('./answers');
const entityPrefill = require('./entity-prefill');

/** How many accepted documents a slot-bearing condition still needs. */
function missingSlots(condition, files) {
  const slots = Array.isArray(condition.slots) ? condition.slots : [];
  const required = slots.filter((s) => s.required !== false);
  if (!required.length) return [];
  const filled = new Set(
    (files || [])
      .filter((f) => f.is_current && f.review_status === 'accepted' && f.slot_key)
      .map((f) => String(f.slot_key)),
  );
  return required.filter((s) => !filled.has(String(s.key))).map((s) => s.label || s.key);
}

/** Which per-line keys have an ACCEPTED document against them. A per-line
    condition tags each upload with the liability's own key in `slot_key`, so the
    ordinary document plumbing carries it with no second table. */
function documentsByLine(files) {
  const out = {};
  for (const f of files || []) {
    if (f.is_current && f.review_status === 'accepted' && f.slot_key) out[String(f.slot_key)] = true;
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
      return { ok: false, why: `Still waiting on: ${short.join(', ')}.` };
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
  const { rows } = await client.query(
    `SELECT * FROM lt_file_conditions WHERE id = $1::uuid AND loan_id = $2::uuid`,
    [String(conditionId), String(loanId)],
  );
  if (!rows.length) return null;
  const condition = rows[0];
  let files = [];
  let readFailed = false;
  try {
    ({ rows: files } = await client.query(
      `SELECT id, slot_key, review_status, is_current, filename
         FROM lt_condition_files WHERE condition_id = $1::uuid`,
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

  // REFUSE A SHAPE THE GATE WOULD NOT HONOUR. A door that accepts what the gate
  // ignores leaves somebody pressing a button that changes nothing.
  const problem = answers.answerProblem(condition, merged, {
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

  const { rows } = await client.query(
    `UPDATE lt_file_conditions
        SET answer = $3::jsonb, updated_at = now()
      WHERE id = $1::uuid AND loan_id = $2::uuid
      RETURNING id, answer, status`,
    [String(conditionId), String(loanId), JSON.stringify(merged)],
  );
  if (!rows.length) return { ok: false, status: 404, error: 'That condition is not on this file.' };
  return { ok: true, condition: rows[0] };
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
    `UPDATE lt_file_conditions
        SET status = 'satisfied', satisfied_at = now(), satisfied_by = $2::uuid,
            waived_at = NULL, waived_by = NULL, waived_reason = NULL,
            notes = $3, updated_at = now()
      WHERE id = $1::uuid RETURNING id, status`,
    [String(conditionId), staffId || null, note],
  );
  return { ok: true, condition: rows[0], checkSkipped: gate.checkSkipped || null };
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

  const { rows } = await client.query(
    `UPDATE lt_file_conditions
        SET status = 'waived', waived_at = now(), waived_by = $2::uuid,
            waived_reason = $3,
            satisfied_at = NULL, satisfied_by = NULL, updated_at = now()
      WHERE id = $1::uuid RETURNING id, status`,
    [String(conditionId), staffId || null, clean.slice(0, 500)],
  );
  return { ok: true, condition: rows[0] };
}

/**
 * Put a condition back to outstanding.
 *
 * EVERY STAMP IS CLEARED. A reopened condition that still reads "waived by
 * Chaya" is a row that contradicts itself, and the next person to look at it
 * would believe the stamp over the status.
 */
async function reopen(loanId, conditionId, client = db) {
  const { rows } = await client.query(
    `UPDATE lt_file_conditions
        SET status = 'outstanding',
            satisfied_at = NULL, satisfied_by = NULL,
            waived_at = NULL, waived_by = NULL, waived_reason = NULL,
            updated_at = now()
      WHERE id = $1::uuid AND loan_id = $2::uuid RETURNING id, status`,
    [String(conditionId), String(loanId)],
  );
  if (!rows.length) return { ok: false, status: 404, error: 'That condition is not on this file.' };
  return { ok: true, condition: rows[0] };
}

/** Move a condition to a working state without claiming it is finished. */
async function setStatus(loanId, conditionId, status, client = db) {
  const allowed = new Set(['outstanding', 'in_progress', 'received', 'not_applicable']);
  if (!allowed.has(String(status))) {
    return { ok: false, status: 400, error: 'That is not a status a condition can be moved to here. Satisfying or waiving one has its own door.' };
  }
  const { rows } = await client.query(
    `UPDATE lt_file_conditions
        SET status = $3, updated_at = now(),
            satisfied_at = NULL, satisfied_by = NULL,
            waived_at = NULL, waived_by = NULL, waived_reason = NULL
      WHERE id = $1::uuid AND loan_id = $2::uuid RETURNING id, status`,
    [String(conditionId), String(loanId), String(status)],
  );
  if (!rows.length) return { ok: false, status: 404, error: 'That condition is not on this file.' };
  return { ok: true, condition: rows[0] };
}

/** The internal note. Staff-only by construction — the client read never selects it. */
async function setNote(loanId, conditionId, note, client = db) {
  const { rows } = await client.query(
    `UPDATE lt_file_conditions SET notes = $3, updated_at = now()
      WHERE id = $1::uuid AND loan_id = $2::uuid RETURNING id`,
    [String(conditionId), String(loanId), String(note == null ? '' : note).slice(0, 4000) || null],
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
    `SELECT * FROM lt_condition_templates WHERE code = $1 AND is_active = true`, [String(code)],
  );
  if (!t.length) return { ok: false, status: 404, error: 'There is no such condition in the library.' };
  const tpl = t[0];

  // The engine's own audience rule, applied here too: a borrower-facing
  // condition with no borrower wording is added STAFF-ONLY rather than shown to
  // a client under an internal label.
  const wantsClient = tpl.audience !== 'internal';
  const audience = wantsClient && String(tpl.borrower_label || '').trim() ? tpl.audience : 'internal';

  try {
    const { rows } = await client.query(
      `INSERT INTO lt_file_conditions
         (loan_id, template_id, code, bucket_key, field_key, label, hint,
          borrower_label, borrower_hint, audience, kind, is_required, slots,
          config, origin, sort_order)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
               $13::jsonb, $14::jsonb, 'manual', $15)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [String(loanId), tpl.id, tpl.code, tpl.bucket_key, opts.fieldKey || null,
        tpl.label, tpl.hint, tpl.borrower_label, tpl.borrower_hint, audience,
        tpl.kind, tpl.is_required, JSON.stringify(tpl.slots || []),
        JSON.stringify(tpl.config || {}), tpl.sort_order],
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
  const { rows } = await client.query(
    `DELETE FROM lt_file_conditions
      WHERE id = $1::uuid AND loan_id = $2::uuid AND origin = 'manual'
    RETURNING id`,
    [String(conditionId), String(loanId)],
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

function appendNote(existing, line) {
  const base = String(existing == null ? '' : existing).trim();
  return (base ? `${base}\n${line}` : line).slice(0, 4000);
}

module.exports = {
  recordAnswer,
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
