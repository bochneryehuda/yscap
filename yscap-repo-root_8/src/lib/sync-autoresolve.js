'use strict';

/**
 * Cross-system conflict AUTO-RESOLUTION (owner-directed 2026-07-15 evening):
 * "the system should know how to handle issues like this — and only when it
 * doesn't know, trigger the review."
 *
 * decideDob() is the ONE decision function every DOB-conflict site consults —
 * the inbound heal, the outbound push gate, and the date-restore script — so
 * the system behaves identically no matter which side surfaces a disagreement.
 * It auto-settles only what is PROVABLE; genuine ambiguity goes to the
 * two-sided review queue. Every auto-resolution is audited and journaled.
 *
 * What is provable (each rule maps to a real incident):
 *   1. SAME DAY, different storage form (a 2-digit-year artifact like
 *      0095-10-19 that pivots to the other side's 1995-10-19; or convention
 *      offsets) → agree; canonicalize silently.
 *   2. ONE side impossible, the other a plausible adult DOB → the plausible
 *      side wins (the "12/11/2022 toddler vs 12/11/2002" class — a DOB that
 *      cannot belong to a borrower is not a candidate, it's corruption).
 *   3. ClickUp holds a TYPED-2-DIGIT-YEAR artifact whose pivot is a plausible
 *      adult DOB, and the portal profile's value has NO independent human
 *      provenance (borrowers.origin='clickup_backfill' — the portal value
 *      itself was derived from ClickUp by the sync) → the direct human typing
 *      in ClickUp wins (the "Shaindel Schwimmer" class: 0095-10-19 in ClickUp
 *      beats a sync-derived 1996-11-19 profile value).
 *   4. Everything else — two plausible adult DOBs that simply differ, with
 *      human provenance on the portal side — is a HUMAN decision → review.
 */

const db = require('../db');
const T = require('../clickup/transforms');
const F = require('../clickup/fields');
const { sanitizeDob, sanitizeDateOnly } = require('./fields');

/** A raw day string is a typed-year ARTIFACT when the strict window rejects it
 *  but the DOB pivot resolves it to a plausible adult date. */
function isArtifactDay(rawDay) {
  if (!rawDay) return false;
  return sanitizeDateOnly(rawDay) == null && sanitizeDob(rawDay) != null;
}

/**
 * The pure decision. Inputs are RAW 'YYYY-MM-DD' strings as each side stores
 * them today (artifacts included — pass the LOOSE day for ClickUp epochs), plus
 * the portal profile's provenance (borrowers.origin).
 * Returns one of:
 *   { outcome:'agree',  value }                       — nothing to resolve
 *   { outcome:'adopt',  value, winner, why }          — provable: apply to BOTH
 *   { outcome:'review', proposal }                    — a human decides
 */
function decideDob({ clickupDay, portalDay, portalOrigin, portalHumanEdited }) {
  const cu = clickupDay || null, p = portalDay || null;
  const vc = sanitizeDob(cu), vp = sanitizeDob(p);
  if (!cu && !p) return { outcome: 'agree', value: null };
  if (vc && vp && vc === vp) return { outcome: 'agree', value: vc };
  if (vc && !vp) {
    return { outcome: 'adopt', value: vc, winner: 'clickup', why: p ? 'portal_value_implausible' : 'portal_blank' };
  }
  if (!vc && vp) {
    return { outcome: 'adopt', value: vp, winner: 'portal', why: cu ? 'clickup_value_implausible' : 'clickup_blank' };
  }
  if (vc && vp) {
    // Both plausible but different. One provable case: ClickUp's stored value
    // is a direct human TYPING artifact (2-digit year) and the portal value has
    // no independent human provenance (the sync itself derived it) — then the
    // human's typing wins over the derived copy.
    if (isArtifactDay(cu) && !isArtifactDay(p) && portalOrigin === 'clickup_backfill') {
      return { outcome: 'adopt', value: vc, winner: 'clickup', why: 'typed_artifact_beats_sync_derived_profile' };
    }
    // BACKDATING rule (owner-directed 2026-07-15 night: "everything should
    // read the correct thing that was updated in ClickUp"): when the portal
    // profile was CREATED BY THE SYNC (origin clickup_backfill) and no human
    // has ever edited its DOB in the portal (portalHumanEdited === false —
    // the caller PROVES this from the audit trail; unknown/null never
    // qualifies), the portal side has zero human authority: whatever it
    // holds is a sync artifact of the incident era. ClickUp's current,
    // human-maintained plausible value wins and heals the whole backlog on
    // the boot re-ingest pass. A portal value a human DID touch still goes
    // to review — never silently overridden.
    if (portalOrigin === 'clickup_backfill' && portalHumanEdited === false) {
      return { outcome: 'adopt', value: vc, winner: 'clickup', why: 'clickup_current_beats_sync_derived_profile' };
    }
    return { outcome: 'review', proposal: null, kind: 'differs' };
  }
  // Neither side resolves to a plausible adult DOB → review with a vetted
  // pivot proposal when one exists. COMMON SENSE (owner-directed 2026-07-15):
  // when both systems carry the SAME impossible value there is no
  // disagreement to arbitrate — the review must say "this DOB can't be
  // right" (future-born / minor / impossibly old), not "they differ".
  return {
    outcome: 'review',
    proposal: sanitizeDob(T.pivotSuspectYear(cu || p, 'dob')),
    kind: (cu && p && cu === p) ? 'same_impossible' : 'unusable',
  };
}

/**
 * Apply a canonical DOB to BOTH systems for a borrower: the portal profile and
 * every linked ClickUp task. Idempotent (equal values skipped), best-effort per
 * task, everything journaled (clickup_write_log, source) + audited. The
 * ClickUp side is gated by the outbound switch; the portal side always applies.
 */
async function adoptDobEverywhere({ borrowerId, day, why, source = 'auto_resolve', actorId = null }) {
  const out = { portalUpdated: false, tasksUpdated: 0, tasksSkipped: 0, tasksFailed: 0 };
  if (!borrowerId || !sanitizeDob(day)) return out;
  const cfg = require('../config');
  const clickup = require('../clickup/client');

  const cur = (await db.query(`SELECT date_of_birth FROM borrowers WHERE id=$1`, [borrowerId])).rows[0];
  const priorPortalDay = cur && cur.date_of_birth ? String(cur.date_of_birth) : null;   // before-image for the audit row
  if (cur && String(cur.date_of_birth || '') !== day) {
    await db.query(`UPDATE borrowers SET date_of_birth=$2::date, updated_at=now() WHERE id=$1`, [borrowerId, day]);
    out.portalUpdated = true;
  }
  const apps = (await db.query(
    `SELECT id, clickup_pipeline_task_id AS task_id FROM applications
      WHERE borrower_id=$1 AND deleted_at IS NULL AND clickup_pipeline_task_id IS NOT NULL`, [borrowerId])).rows;
  if (cfg.clickupOutboundEnabled) {
    const epoch = T.dateOnlyToClickUpEpoch(day);
    for (const a of apps) {
      try {
        const task = await clickup.getTask(a.task_id);
        const cf = ((task && task.custom_fields) || []).find((c) => c.id === F.SHARED.borrowerDOB);
        const curDay = cf && cf.value != null ? T.epochToDayLoose(cf.value) : null;
        if (curDay === day && Number(cf.value) === epoch) { out.tasksSkipped++; continue; }
        // Count into the ONE shared volume breaker (post-merge audit d41136e:
        // this write path bypassed it — with human-edit-wins/backdating firing
        // from any inbound ingest, an upstream flap could have written
        // uncapped). A breaker-open throws into the per-task catch: the
        // portal side stays healed, the task write waits for a later pass.
        require('../clickup/orchestrator').circuitCheck(a.id, a.task_id, 1);
        await clickup.setField(a.task_id, F.SHARED.borrowerDOB, epoch);
        out.tasksUpdated++;
        await db.query(
          `INSERT INTO clickup_write_log (application_id, task_id, field_id, field_key, old_value, new_value, changed, source)
           VALUES ($1,$2,$3,'dob',$4,$5,true,$6)`,
          [a.id, String(a.task_id), F.SHARED.borrowerDOB,
           cf && cf.value != null ? JSON.stringify(String(cf.value)) : null,
           JSON.stringify(String(epoch)), source]).catch(() => {});
      } catch (e) { out.tasksFailed++; console.warn('[sync-autoresolve] task DOB apply failed', a.task_id, e.message); }
    }
  }
  await db.query(
    `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
     VALUES ($1,$2,'sync_dob_auto_resolve','borrower',$3,$4)`,
    [actorId ? 'staff' : 'system', actorId, borrowerId,
     JSON.stringify({ day, before: priorPortalDay, why, source, ...out })]).catch(() => {});   // before-image kept (audit #271 nit)
  // The disagreement is settled — any OPEN review rows for this borrower's DOB
  // are now stale; close them so a fix at the source clears the queue with no
  // clicks (owner-directed 2026-07-15).
  try {
    await require('./sync-review').closeStaleReviews({
      borrowerId, fieldKey: 'date_of_birth',
      note: `auto-closed — resolved to ${day} (${why}, ${source})` });
  } catch (_) { /* best-effort */ }
  return out;
}

// ---- two-sided review resolution (owner-directed 2026-07-15 evening) --------
// "which one do you want to adopt should override on both." The reviewer picks
// a WINNER side; the chosen value is re-read LIVE from that side at resolve
// time (the row's stored values are display-only — an SSN is never stored in
// the queue) and applied to BOTH systems through audited, journaled writes.
const ACTUAL_CLOSING_FIELD = '0846edc7-8619-4ee6-827e-a673570d3057';
const APP_DATE_FIELDS = {
  expected_closing: () => F.PIPELINE.expectedClosing,
  acquisition_date: () => F.EXTRA.acquisitionDate,
  actual_closing: () => ACTUAL_CLOSING_FIELD,
};

// `expose` = OUR validation error, safe to relay verbatim. A ClickUp client
// error also carries `.status` (ClickUp's own HTTP status) and must NOT be
// relayed — an upstream 401 would read as session-expiry and log the staff
// user out of PILOT. Routes map non-expose statuses to 502.
function httpError(status, message) { const e = new Error(message); e.status = status; e.expose = true; return e; }

async function journalResolveWrite(appId, taskId, fieldId, fieldKey, oldVal, newVal, masked) {
  await db.query(
    `INSERT INTO clickup_write_log (application_id, task_id, field_id, field_key, old_value, new_value, changed, source)
     VALUES ($1,$2,$3,$4,$5,$6,true,'review_resolve')`,
    [appId || null, String(taskId), fieldId, fieldKey,
     oldVal == null ? null : JSON.stringify(masked ? '✱✱✱' : String(oldVal)),
     newVal == null ? null : JSON.stringify(masked ? '✱✱✱' : String(newVal))]).catch(() => {});
}

/**
 * Apply a review winner to BOTH systems. row = the sync_review_queue row;
 * winner = 'clickup' | 'portal'. Throws {status:4xx} for unusable states so
 * the route can surface a clear message. Returns a summary for the audit row.
 */
async function applyReviewWinner(row, winner, customValue) {
  const cfg = require('../config');
  const clickup = require('../clickup/client');
  const fieldKey = row.field_key;
  const appId = row.application_id || null;
  let borrowerId = row.borrower_id || null;
  let taskId = row.task_id || null;
  if (appId && (!taskId || !borrowerId)) {
    const a = (await db.query(`SELECT borrower_id, clickup_pipeline_task_id FROM applications WHERE id=$1`, [appId])).rows[0];
    if (a) { borrowerId = borrowerId || a.borrower_id; taskId = taskId || a.clickup_pipeline_task_id; }
  }
  // THIRD OPTION — the reviewer TYPES the correct value when NEITHER side is
  // right (owner/mega-audit enhancement #1: previously they had to hand-edit
  // one system and wait for a sync). The typed value runs through exactly the
  // same sanitizers and appliers as an adopted side — never new machinery.
  const custom = winner === 'custom' ? String(customValue == null ? '' : customValue).trim() : null;
  if (winner === 'custom' && !custom) throw httpError(400, 'a value is required to resolve with a custom value');

  // ---- DOB: borrower-level; the adopter writes the portal + every linked task.
  if (fieldKey === 'date_of_birth') {
    if (!borrowerId) throw httpError(422, 'no borrower on this review');
    let day;
    if (winner === 'custom') {
      day = sanitizeDob(custom);
      if (!day) throw httpError(422, 'that is not a plausible adult birth date (YYYY-MM-DD)');
    } else if (winner === 'clickup') {
      if (!taskId) throw httpError(422, 'no ClickUp task on this review');
      const task = await clickup.getTask(taskId);
      const cf = ((task && task.custom_fields) || []).find((c) => c.id === F.SHARED.borrowerDOB);
      day = sanitizeDob(T.epochToDayLoose(cf && cf.value));
      if (!day) throw httpError(422, "ClickUp's current DOB is not a plausible adult date — fix it there first, or adopt PILOT's value");
    } else {
      const b = (await db.query(`SELECT date_of_birth FROM borrowers WHERE id=$1`, [borrowerId])).rows[0];
      day = sanitizeDob(b && b.date_of_birth);
      if (!day) throw httpError(422, "PILOT's current DOB is not a plausible adult date — fix it there first, or adopt ClickUp's value");
    }
    const out = await adoptDobEverywhere({ borrowerId, day, why: `review_winner_${winner}`, source: 'review_resolve' });
    return { fieldKey, winner, value: day, ...out };
  }

  // ---- Application-level date fields.
  if (APP_DATE_FIELDS[fieldKey]) {
    if (!appId) throw httpError(422, 'no application on this review');
    const fieldId = APP_DATE_FIELDS[fieldKey]();
    let day;
    if (winner === 'custom') {
      day = require('./fields').normalizeTypedDate(custom);
      if (!day) throw httpError(422, 'that is not a usable calendar date (YYYY-MM-DD)');
    } else if (winner === 'clickup') {
      if (!taskId) throw httpError(422, 'no ClickUp task on this review');
      const task = await clickup.getTask(taskId);
      const cf = ((task && task.custom_fields) || []).find((c) => c.id === fieldId);
      day = require('./fields').sanitizeDateOnly(T.epochToDayLoose(cf && cf.value))
         || require('./fields').normalizeTypedDate(T.epochToDayLoose(cf && cf.value));
      if (!day) throw httpError(422, "ClickUp's current value is not a usable date — fix it there first, or adopt PILOT's value");
    } else {
      const a = (await db.query(`SELECT ${fieldKey} FROM applications WHERE id=$1`, [appId])).rows[0];
      day = require('./fields').sanitizeDateOnly(a && a[fieldKey]);
      if (!day) throw httpError(422, "PILOT's current value is not a usable date — fix it there first, or adopt ClickUp's value");
    }
    const before = (await db.query(`SELECT ${fieldKey} FROM applications WHERE id=$1`, [appId])).rows[0];
    await db.query(`UPDATE applications SET ${fieldKey}=$2::date, updated_at=now() WHERE id=$1`, [appId, day]);
    if (taskId && cfg.clickupOutboundEnabled) {
      const epoch = T.dateOnlyToClickUpEpoch(day);
      if (epoch != null) {
        try {
          require('../clickup/orchestrator').circuitCheck(appId, taskId, 1);   // every ClickUp write counts into the ONE breaker
          await clickup.setField(taskId, fieldId, epoch);
          await journalResolveWrite(appId, taskId, fieldId, fieldKey, before && before[fieldKey], epoch, false);
        }
        catch (e) { console.warn('[sync-autoresolve] resolve ClickUp write failed', taskId, e.message); }
      }
    }
    return { fieldKey, winner, value: day };
  }

  // ---- SSN: values are NEVER stored in the queue; both sides re-read live.
  if (fieldKey === 'ssn') {
    if (!borrowerId) throw httpError(422, 'no borrower on this review');
    const C = require('./crypto');
    const identity = require('../clickup/identity');
    const { sanitizeSsnDigits } = require('./fields');
    let digits;
    if (winner === 'custom') {
      digits = sanitizeSsnDigits(custom);
      if (!digits) throw httpError(422, 'a full 9-digit Social Security number is required');
      await db.query(
        `UPDATE borrowers SET ssn_encrypted=$2, ssn_last4=$3, ssn_hash=$4, updated_at=now() WHERE id=$1`,
        [borrowerId, C.encryptSSN(digits), digits.slice(-4), identity.ssnHash(digits, cfg.ssnMatchKey)]);
      if (taskId && cfg.clickupOutboundEnabled) {
        require('../clickup/orchestrator').circuitCheck(appId, taskId, 1);
        await clickup.setField(taskId, F.SHARED.borrowerSSN, digits);
        await journalResolveWrite(appId, taskId, F.SHARED.borrowerSSN, 'ssn', '✱✱✱', '✱✱✱', true);
      }
      return { fieldKey, winner, value: `✱✱✱-✱✱-${digits.slice(-4)}` };
    }
    if (winner === 'clickup') {
      if (!taskId) throw httpError(422, 'no ClickUp task on this review');
      const task = await clickup.getTask(taskId);
      const cf = ((task && task.custom_fields) || []).find((c) => c.id === F.SHARED.borrowerSSN);
      digits = sanitizeSsnDigits(cf && cf.value);
      if (!digits) throw httpError(422, "ClickUp's current SSN is not a full 9-digit number — fix it there first, or adopt PILOT's value");
      await db.query(
        `UPDATE borrowers SET ssn_encrypted=$2, ssn_last4=$3, ssn_hash=$4, updated_at=now() WHERE id=$1`,
        [borrowerId, C.encryptSSN(digits), digits.slice(-4), identity.ssnHash(digits, cfg.ssnMatchKey)]);
    } else {
      const b = (await db.query(`SELECT ssn_encrypted FROM borrowers WHERE id=$1`, [borrowerId])).rows[0];
      if (!b || !b.ssn_encrypted) throw httpError(422, 'PILOT has no SSN on file — adopt ClickUp’s value instead');
      try { digits = sanitizeSsnDigits(C.decryptSSN(b.ssn_encrypted)); } catch (_) { digits = null; }
      if (!digits) throw httpError(422, "PILOT's stored SSN could not be read — adopt ClickUp's value instead");
      if (taskId && cfg.clickupOutboundEnabled) {
        require('../clickup/orchestrator').circuitCheck(appId, taskId, 1);   // breaker-counted like every write
        await clickup.setField(taskId, F.SHARED.borrowerSSN, digits);
        await journalResolveWrite(appId, taskId, F.SHARED.borrowerSSN, 'ssn', '✱✱✱', '✱✱✱', true);
      }
    }
    return { fieldKey, winner, value: `✱✱✱-✱✱-${digits.slice(-4)}` };
  }

  // ---- File status: each side's normal machinery applies the other side.
  if (fieldKey === 'status') {
    if (!appId) throw httpError(422, 'no application on this review');
    if (winner === 'clickup') {
      if (!taskId) throw httpError(422, 'no ClickUp task on this review');
      await require('../sync/clickup-sync').ingestOne(taskId);   // pull applies status via the normal inbound path
    } else {
      await require('../clickup/orchestrator').pushApplication(appId, { only: ['status'], approvedReview: true, force: true });
    }
    return { fieldKey, winner };
  }

  // ---- Borrower identity fields (owner-directed 2026-07-15 night: the
  // mismatch-audit rows must be RESOLVABLE, not dismiss-only). winner=portal
  // re-pushes the field scoped with the review bypass (the same path a PII
  // approval uses); winner=clickup re-reads the task live and writes the
  // borrower column — audited by the route, journal-free on the portal side
  // like every inbound pull.
  const IDENTITY_FIELDS = {
    email: { cu: () => F.SHARED.borrowerEmail },
    cell_phone: { cu: () => F.SHARED.borrowerCell },
    first_name: { cu: () => F.SHARED.borrowerName },
    current_address: { cu: () => F.SHARED.borrowerAddress },
  };
  if (IDENTITY_FIELDS[fieldKey]) {
    if (!borrowerId) throw httpError(422, 'no borrower on this review');
    if (winner === 'portal') {
      if (!appId) throw httpError(422, 'no application on this review');
      await require('../clickup/orchestrator').pushApplication(appId, { only: [fieldKey], approvedReview: true, force: true });
      return { fieldKey, winner };
    }
    // ONE applier for both adopt-ClickUp and reviewer-typed custom values —
    // identical validation, identical portal write.
    const applyIdentityValue = async (v, sourceLabel) => {
      if (fieldKey === 'email') {
        const email = String(v).trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw httpError(422, `${sourceLabel} is not a valid email`);
        try { await db.query(`UPDATE borrowers SET email=$2, updated_at=now() WHERE id=$1`, [borrowerId, email]); }
        catch (e) { if (e.code === '23505') throw httpError(409, 'that email is already in use by another borrower'); throw e; }
        return email;
      }
      if (fieldKey === 'cell_phone') {
        const phone = String(v).trim();
        if (phone.replace(/\D/g, '').length < 10) throw httpError(422, `${sourceLabel} is not a full phone number`);
        await db.query(`UPDATE borrowers SET cell_phone=$2, updated_at=now() WHERE id=$1`, [borrowerId, phone]);
        return phone;
      }
      if (fieldKey === 'first_name') {
        const parts = String(v).trim().split(/\s+/);
        if (!parts[0] || require('../clickup/transforms').isPlaceholderName(String(v))) {
          throw httpError(422, `${sourceLabel} is not a usable name`);
        }
        const first = parts.shift(), last = parts.join(' ') || null;
        await db.query(
          `UPDATE borrowers SET first_name=$2, last_name=COALESCE($3, last_name), updated_at=now() WHERE id=$1`,
          [borrowerId, first, last]);
        return String(v).trim();
      }
      // current_address: object (ClickUp location) or typed text → jsonb shape.
      const addr = typeof v === 'object'
        ? { formatted_address: v.formatted_address || null,
            ...(v.location && Number.isFinite(Number(v.location.lat)) ? { lat: Number(v.location.lat), lng: Number(v.location.lng) } : {}) }
        : { formatted_address: String(v).trim() };
      if (!addr.formatted_address) throw httpError(422, `${sourceLabel} has no readable address text`);
      await db.query(`UPDATE borrowers SET current_address=$2::jsonb, updated_at=now() WHERE id=$1`, [borrowerId, JSON.stringify(addr)]);
      return addr.formatted_address;
    };
    if (winner === 'custom') {
      const value = await applyIdentityValue(custom, 'that value');
      // The typed value is now the PORTAL's value — push it out scoped with
      // the review bypass so BOTH systems carry it.
      if (appId) {
        try { await require('../clickup/orchestrator').pushApplication(appId, { only: [fieldKey], approvedReview: true, force: true }); }
        catch (e) { console.warn('[sync-autoresolve] custom-value push failed (portal applied):', e.message); }
      }
      return { fieldKey, winner, value };
    }
    if (!taskId) throw httpError(422, 'no ClickUp task on this review');
    const task = await clickup.getTask(taskId);
    const cf = ((task && task.custom_fields) || []).find((c) => c.id === IDENTITY_FIELDS[fieldKey].cu());
    const v = cf && cf.value != null ? cf.value : null;
    if (v == null || v === '') throw httpError(422, "ClickUp's current value is blank — fix it there first, or adopt PILOT's value");
    const value = await applyIdentityValue(v, "ClickUp's current value");
    return { fieldKey, winner, value };
  }

  throw httpError(422, `resolving '${fieldKey}' two-sided is not supported yet — use approve/reject`);
}

module.exports = { decideDob, isArtifactDay, adoptDobEverywhere, applyReviewWinner };
