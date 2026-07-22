'use strict';

/**
 * Sync-review RE-CHECK — "look again" (owner-directed 2026-07-22).
 *
 * A reviewer often fixes the underlying data by hand (in ClickUp, or in PILOT)
 * and then wants the review row to go away WITHOUT adopting a side — "rerun the
 * search to see if that review is still needed, or if the fix was already done,
 * in the back end, without them being involved." This module does exactly that:
 * it re-reads BOTH systems live and decides whether the disagreement is gone.
 *
 * It NEVER blind-dismisses. A row is only ever CLOSED (as an auto-resolution,
 * kept in history) when the current values PROVE it resolved — the two systems
 * now agree, or one side is authoritative and the other provably a corruption
 * artifact (DOB only, via the shared decideDob logic). Anything still in genuine
 * disagreement is left OPEN; every re-check stamps last_checked_at / check_count
 * so the card can show "checked just now — still needs you."
 *
 * All judgment is the SAME as the normal resolver + auto-resolver (decideDob,
 * the field transforms) — this adds no new arbitration rules, only a re-read.
 *
 * recheckReview(row, { clickup?, db? }) → one of:
 *   { outcome:'closed',     reason, ... }   — proven resolved; the row is closed
 *   { outcome:'still_open', reason }         — real disagreement remains; stays open
 *   { outcome:'unsupported', reason }        — this kind can't be auto-decided here
 *   { outcome:'error',      reason, message} — a live read failed; nothing changed
 */

const dbDefault = require('../db');
const F = require('./../clickup/fields');
const T = require('./../clickup/transforms');
const { sanitizeDateOnly } = require('./fields');

// The "actual closing" custom field id (kept in lock-step with sync-autoresolve).
const ACTUAL_CLOSING_FIELD = '0846edc7-8619-4ee6-827e-a673570d3057';
const APP_DATE_FIELDS = {
  expected_closing: () => F.PIPELINE.expectedClosing,
  actual_closing: () => ACTUAL_CLOSING_FIELD,
  acquisition_date: () => F.EXTRA.acquisitionDate,
};
const IDENTITY_FIELDS = {
  email: () => F.SHARED.borrowerEmail,
  cell_phone: () => F.SHARED.borrowerCell,
  first_name: () => F.SHARED.borrowerName,
  current_address: () => F.SHARED.borrowerAddress,
};

// ---- pure canonicalizers (no DB, no ClickUp — unit-testable) ----------------
const canonEmail = (v) => String(v == null ? '' : v).trim().toLowerCase();
const canonPhone = (v) => { const d = String(v == null ? '' : v).replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : d; };
const canonName = (v) => String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function canonAddr(v) {
  if (v == null) return '';
  if (typeof v === 'object') v = v.formatted_address || v.formattedAddress || v.oneLine || v.line1 || v.address || '';
  return String(v).toLowerCase().replace(/[^a-z0-9]/g, '');
}
const canonSsn = (v) => { const d = String(v == null ? '' : v).replace(/\D/g, ''); return d.length === 9 ? d : ''; };
const canonDay = (v) => sanitizeDateOnly(v) || '';
const canonLoan = (v) => String(v == null ? '' : v).trim().toUpperCase();

// The contested YS loan number for a loan-number finding, read out of the row.
// The ingest producer stores it in raw_value.number (and clickup_value); the
// staff front-door producer stores it in proposed_value (and clickup/portal).
function loanNumberOf(row) {
  let raw = null;
  try { raw = row && row.raw_value ? JSON.parse(row.raw_value) : null; } catch (_) { raw = null; }
  const n = (raw && raw.number) || (row && (row.clickup_value || row.proposed_value || row.portal_value)) || null;
  return n ? String(n).trim() : null;
}

/**
 * Pure: do the two live values for `fieldKey` AGREE now (disagreement gone)?
 * Conservative — a positive, non-blank match returns true; a one-sided blank or
 * any doubt returns false (keep the review open). DOB is NOT handled here — it
 * goes through decideDob, which carries the full adult-plausibility logic.
 */
function valuesAgree(fieldKey, clickupVal, portalVal) {
  if (fieldKey === 'email') { const a = canonEmail(clickupVal), b = canonEmail(portalVal); return !!a && a === b; }
  if (fieldKey === 'cell_phone') { const a = canonPhone(clickupVal), b = canonPhone(portalVal); return a.length >= 10 && a === b; }
  if (fieldKey === 'first_name') { const a = canonName(clickupVal), b = canonName(portalVal); return !!a && a === b; }
  if (fieldKey === 'current_address') { const a = canonAddr(clickupVal), b = canonAddr(portalVal); return !!a && a === b; }
  if (fieldKey === 'ssn') { const a = canonSsn(clickupVal), b = canonSsn(portalVal); return !!a && a === b; }
  if (APP_DATE_FIELDS[fieldKey]) { const a = canonDay(clickupVal), b = canonDay(portalVal); return !!a && a === b; }
  return false;
}

// Mirror ingest.js: PROVE from the audit trail whether a human ever touched this
// borrower's DOB in the portal (a sync-derived profile with no human fingerprint
// has no authority against ClickUp's current value). Errors → null (conservative).
async function dobHumanEdited(db, borrowerId) {
  try {
    const he = await db.query(
      `SELECT 1 FROM audit_log al
        WHERE al.actor_kind IN ('staff','borrower')
          AND ((al.entity_type='borrower' AND al.entity_id=$1)
            OR (al.entity_type='application' AND EXISTS (
                  SELECT 1 FROM applications a2
                   WHERE a2.id = al.entity_id AND (a2.borrower_id=$1 OR a2.co_borrower_id=$1))))
          AND (al.action = 'sync_dob_auto_resolve' OR al.detail::text ILIKE '%date_of_birth%')
        LIMIT 1`, [borrowerId]);
    return !!he.rows[0];
  } catch (_) { return null; }
}

function readTaskField(task, fieldId) {
  const cf = ((task && task.custom_fields) || []).find((c) => c.id === fieldId);
  return cf && cf.value != null ? cf.value : null;
}

/**
 * Re-run the underlying comparison for one open review row and close it iff the
 * data now proves it resolved. Only value-disagreement rows are auto-decidable
 * (DOB, the three application dates, SSN, and the identity fields). File-level
 * and Sitewire rows can't be proven from a value re-read here — they are stamped
 * "checked" and reported unsupported (they auto-close on natural recovery via
 * their own machinery). Never throws — a failed live read returns 'error'.
 */
async function recheckReview(row, opts = {}) {
  const db = opts.db || dbDefault;
  const out = await computeRecheck(row, { ...opts, db });
  // Record that we actually LOOKED — but only when a real comparison ran. An
  // 'error' outcome means we could not reach ClickUp, so no check happened and
  // we must not stamp "checked just now" (audit nit: a stale "last re-checked"
  // would overstate that a real look occurred).
  if (out.outcome !== 'error') {
    await db.query(
      `UPDATE sync_review_queue SET last_checked_at=now(), check_count=check_count+1 WHERE id=$1`,
      [row.id]).catch(() => {});
  }
  return out;
}

// The decision half (no stamping) — returns the outcome object. Split out so
// recheckReview can stamp last_checked_at only on a real (non-error) check.
async function computeRecheck(row, opts) {
  const db = opts.db;
  const clickup = opts.clickup || require('./../clickup/client');
  const syncReview = require('./sync-review');
  const AR = require('./sync-autoresolve');
  const fieldKey = row.field_key;

  // Resolve borrower + task ids the same way the resolver does.
  let borrowerId = row.borrower_id || null;
  let taskId = row.task_id || null;
  const appId = row.application_id || null;
  if (appId && (!taskId || !borrowerId)) {
    const a = (await db.query(`SELECT borrower_id, clickup_pipeline_task_id FROM applications WHERE id=$1`, [appId])).rows[0];
    if (a) { borrowerId = borrowerId || a.borrower_id; taskId = taskId || a.clickup_pipeline_task_id; }
  }

  // ---- DOB — reuse the full plausibility decision on freshly-read values.
  if (fieldKey === 'date_of_birth') {
    if (!borrowerId) return { outcome: 'unsupported', reason: 'no_borrower' };
    // No ClickUp task to compare against → we CANNOT prove anything. Never fall
    // through to decideDob with clickupDay=null, which would read as "ClickUp is
    // blank" and adopt the portal value — a false close of a still-open review
    // (audit BLOCKER: mirror the value-field guard below).
    if (!taskId) return { outcome: 'unsupported', reason: 'no_task' };
    let clickupDay = null;
    try {
      const task = await clickup.getTask(taskId);
      clickupDay = readTaskField(task, F.SHARED.borrowerDOB);
      clickupDay = clickupDay != null ? T.epochToDayLoose(clickupDay) : null;
    } catch (e) { return { outcome: 'error', reason: 'clickup_read_failed', message: e.message }; }
    const b = (await db.query(`SELECT date_of_birth, origin FROM borrowers WHERE id=$1`, [borrowerId])).rows[0];
    const portalDay = b && b.date_of_birth ? String(b.date_of_birth) : null;
    const portalHumanEdited = await dobHumanEdited(db, borrowerId);
    const d = AR.decideDob({ clickupDay, portalDay, portalOrigin: (b && b.origin) || null, portalHumanEdited });
    if (d.outcome === 'agree') {
      const closed = await syncReview.closeStaleReviews({
        borrowerId, fieldKey: 'date_of_birth',
        note: 'auto-closed by re-check — both systems now show the same date of birth' });
      return { outcome: 'closed', reason: 'agree', value: d.value, closed };
    }
    if (d.outcome === 'adopt') {
      // A provable winner — apply it to both systems (which itself closes the
      // stale DOB rows for this borrower), exactly as the auto-resolver would.
      await AR.adoptDobEverywhere({ borrowerId, day: d.value, why: `recheck_${d.why}`, source: 'recheck' });
      return { outcome: 'closed', reason: 'adopt', value: d.value };
    }
    return { outcome: 'still_open', reason: 'differs' };
  }

  // ---- YS loan-number DUPLICATE finding — the "two files claim ONE number" class
  // (ingest's copied_loan_number_needs_assignment, or the staff front-door
  // loan_number_duplicate_entered). This is NOT a two-sided value disagreement, so
  // it fell through to 'unsupported' before — Re-check could never clear it, which
  // is exactly the dead-end the owner hit after turning the duplicate into a DSCR
  // and clearing its number (2026-07-22, Libby Baum / 1600 Mildred Ave). Re-derive
  // the collision LIVE and close the row iff the clash is genuinely gone; a number
  // still owned by another live file/task keeps the row open (never a blind close).
  if (fieldKey === 'ys_loan_number') {
    const number = loanNumberOf(row);
    if (!number) return { outcome: 'unsupported', reason: 'no_number' };

    // (a) THIS file was removed from the portal (descoped to a data-only DSCR, or
    // soft-deleted). The "this file holds a copy" clash is moot — nothing on a file
    // that no longer exists can clash with anything.
    if (appId) {
      const a = (await db.query(`SELECT deleted_at FROM applications WHERE id=$1`, [appId])).rows[0];
      if (a && a.deleted_at) {
        const closed = await syncReview.closeStaleReviews({
          applicationId: appId, taskId: taskId || undefined, fieldKey: 'ys_loan_number',
          note: 'auto-closed by re-check — this file was removed from the portal (its ClickUp task is no longer a loan file), so the loan number no longer clashes here.' });
        return { outcome: 'closed', reason: 'file_removed', closed };
      }
    }

    // (b) Re-derive the LIVE collision from THIS file's perspective. No collision →
    // the number is unique now (the duplicate was cleared or renumbered) → close.
    let collision;
    try {
      collision = await require('./loan-number').findLoanNumberCollision(number, { excludeAppId: appId || undefined });
    } catch (e) { return { outcome: 'error', reason: 'loan_number_check_failed', message: e.message }; }

    // (c) A ClickUp-only collision may be a STALE cache row (the duplicate's number
    // was cleared in ClickUp but that task hasn't been re-pulled into the index
    // yet). Confirm it LIVE before keeping the row open — read the specific task and
    // see whether it still carries the number. A read hiccup is conservative (keep
    // the collision); a 404 means the other task is gone, so its claim is gone.
    if (collision && collision.where === 'clickup_file' && collision.taskId) {
      try {
        const task = await clickup.getTask(collision.taskId);
        const cf = ((task && task.custom_fields) || []).find((c) => c.id === F.PIPELINE.ysLoanNumber);
        const live = cf && cf.value != null ? canonLoan(cf.value) : '';
        if (live !== canonLoan(number)) collision = null;   // stale cache — cleared at the source
      } catch (e) { if (e && e.status === 404) collision = null; }
    }

    if (!collision) {
      const closed = await syncReview.closeStaleReviews({
        applicationId: appId || undefined, taskId: taskId || undefined, fieldKey: 'ys_loan_number',
        note: `auto-closed by re-check — loan number ${number} is no longer used on any other file (the duplicate was cleared or renumbered).` });
      return { outcome: 'closed', reason: 'no_longer_duplicated', closed };
    }
    return { outcome: 'still_open', reason: 'still_duplicated' };
  }

  // ---- Value fields we can prove by a two-sided re-read.
  const fieldIdFn = APP_DATE_FIELDS[fieldKey] || IDENTITY_FIELDS[fieldKey]
    || (fieldKey === 'ssn' ? () => F.SHARED.borrowerSSN : null);
  if (fieldIdFn) {
    if (!taskId) return { outcome: 'unsupported', reason: 'no_task' };
    let clickupVal;
    try {
      const task = await clickup.getTask(taskId);
      clickupVal = readTaskField(task, fieldIdFn());
    } catch (e) { return { outcome: 'error', reason: 'clickup_read_failed', message: e.message }; }
    // ClickUp DATE custom fields come back as epoch-ms — normalize to a day
    // string before comparing (the DOB branch already does this; this branch
    // must too, or a matching date could never be recognized). SSN/identity
    // fields are plain strings and pass through unchanged.
    const clickupCmp = APP_DATE_FIELDS[fieldKey]
      ? (clickupVal != null ? T.epochToDayLoose(clickupVal) : null)
      : clickupVal;

    // Read PILOT's current value for this field.
    let portalVal = null;
    if (APP_DATE_FIELDS[fieldKey]) {
      if (!appId) return { outcome: 'unsupported', reason: 'no_application' };
      const a = (await db.query(`SELECT ${fieldKey} FROM applications WHERE id=$1`, [appId])).rows[0];
      portalVal = a ? a[fieldKey] : null;
    } else if (fieldKey === 'ssn') {
      if (!borrowerId) return { outcome: 'unsupported', reason: 'no_borrower' };
      const b = (await db.query(`SELECT ssn_encrypted FROM borrowers WHERE id=$1`, [borrowerId])).rows[0];
      if (b && b.ssn_encrypted) { try { portalVal = require('./crypto').decryptSSN(b.ssn_encrypted); } catch (_) { portalVal = null; } }
    } else {
      if (!borrowerId) return { outcome: 'unsupported', reason: 'no_borrower' };
      const col = fieldKey === 'first_name'
        ? `trim(coalesce(first_name,'') || ' ' || coalesce(last_name,'')) AS v`
        : fieldKey === 'current_address' ? `current_address AS v` : `${fieldKey} AS v`;
      const b = (await db.query(`SELECT ${col} FROM borrowers WHERE id=$1`, [borrowerId])).rows[0];
      portalVal = b ? b.v : null;
    }

    if (valuesAgree(fieldKey, clickupCmp, portalVal)) {
      // Scope the close to THIS FILE (application + its task) — NOT the borrower.
      // A value field like expected_closing genuinely differs per property, so a
      // borrower-wide close would wrongly resolve a still-differing sibling row
      // on the borrower's OTHER file (audit BLOCKER; the existing sync closes
      // these by task only). DOB is the one borrower-level fact and is closed
      // borrower-scoped in its own branch above.
      const closed = await syncReview.closeStaleReviews({
        applicationId: appId || undefined, taskId: taskId || undefined,
        fieldKey,
        note: 'auto-closed by re-check — both systems now hold the same value' });
      return { outcome: 'closed', reason: 'agree', closed };
    }
    return { outcome: 'still_open', reason: 'differs' };
  }

  // File-level / Sitewire / status rows: nothing to prove from a value re-read
  // here — they resolve through their own actions / natural recovery.
  return { outcome: 'unsupported', reason: 'not_value_field' };
}

module.exports = { recheckReview, valuesAgree, canonAddr, canonName, canonPhone, canonEmail, canonSsn, canonDay };
