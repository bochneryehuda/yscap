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
  return { condition, files, readFailed };
}

/** Mark a condition satisfied, if the gate allows it. */
async function satisfy(loanId, conditionId, staffId, client = db) {
  const found = await loadCondition(loanId, conditionId, client);
  if (!found) return { ok: false, status: 404, error: 'That condition is not on this file.' };

  const gate = signOffProblem(found.condition, found.files, { readFailed: found.readFailed });
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
