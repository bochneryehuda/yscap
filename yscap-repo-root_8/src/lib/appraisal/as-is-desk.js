'use strict';
/**
 * The As-Is desk — the ONE place that runs the As-Is reader against a real file and settles the
 * result: record the reading on the appraisal, apply it to the loan file when (and only when) the
 * owner's rule allows, refresh the "Confirm the As-Is value" condition so a human can re-review or
 * enter it, and retire the appraisal findings the reading just answered.
 *
 * Owner-directed 2026-07-28 (the reading ladder itself, the write rule and the wording all live in
 * ./as-is-reader.js — this module is the database half).
 *
 * NON-NEGOTIABLES, all enforced here:
 *   • CONFIDENCE IS THE RULE. `decideAsIsApply` writes a confident reading in either direction; a
 *     reading we are not confident in is never written, only reported.
 *   • A HUMAN'S DECISION IS FINAL. A value someone typed on the condition, or an `asis_mismatch`
 *     finding they resolved with keep/custom, is never re-litigated by a later read.
 *   • THE APPRAISAL MUST BE ABOUT THIS PROPERTY. An open fatal address / units / property-type
 *     finding stops the write — we may be holding a report for someone else's house.
 *   • The FILE FREEZE wins. A term-sheet-sent / clear-to-close / funded file is locked for everyone
 *     (src/lib/file-lock.js); PILOT has no private door through it. On a frozen file the reading is
 *     still recorded and the condition explains it, so a human decides.
 *   • The write is OPTIMISTIC — it is pinned to the exact value we read a moment ago, so a human (or
 *     another path) changing the As-Is in between can never be silently clobbered.
 *   • It NEVER throws. A failure here must not break the appraisal import that triggered it.
 *
 * This module does not INSERT a condition (that is the appraisal desk's job — src/lib/appraisal/
 * desk.js, the reviewed condition-writer); it only refreshes one that already exists.
 */
const db = require('../../db');
const switches = require('../integrations/switches');
const { readAsIs, decideAsIsApply, buildAsIsNote, buildAsIsHint } = require('./as-is-reader');

const CONDITION_CODE = 'appraisal_as_is_verify';

// Fed to `decideAsIsApply` as a lock reason when the appraisal may not be describing this property.
// It reads as a lock because that is exactly what it is: nobody — PILOT least of all — should adopt a
// number off a report whose address / unit count / property type disagrees with the file.
const IDENTITY_LOCK = 'this appraisal does not match the property on the file (address, unit count or property type), so nothing was taken from it automatically';
// Fed the same way when a person has already settled the As-Is by hand. PILOT reports what it read
// and changes nothing — a human's decision about this number is final.
const HUMAN_LOCK = 'someone has already decided this file\'s As-Is value by hand, so PILOT did not change it';

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

async function audit(actorId, action, appId, detail) {
  try {
    await db.query(
      `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
       VALUES ($1,$2,$3,'application',$4,$5)`,
      [actorId ? 'staff' : 'system', actorId || null, action, appId, JSON.stringify(detail || {})]);
  } catch (_) { /* audit is best-effort — never block the action */ }
}

// Is the automatic As-Is update switched on? Owner-directed ON; the admin API-health page can flip
// APPRAISAL_ASIS_AUTO_ENABLED off instantly without a deploy if it ever misbehaves.
function autoEnabled() {
  try { return switches.on('APPRAISAL_ASIS_AUTO_ENABLED'); } catch (_) { return false; }
}

/**
 * Refresh the condition's per-file wording. The NOTE is `[auto]`-guarded so a note an officer typed
 * by hand is never clobbered; the HINT is system-owned and always reflects the current state.
 */
async function refreshCondition(appId, { note, hint, reopen }) {
  try {
    await db.query(
      `UPDATE checklist_items ci
          SET notes = CASE WHEN ci.notes IS NULL OR ci.notes LIKE '[auto]%' THEN $2 ELSE ci.notes END,
              hint  = $3,
              status = CASE WHEN $4::boolean THEN 'outstanding' ELSE ci.status END,
              signed_off_at = CASE WHEN $4::boolean THEN NULL ELSE ci.signed_off_at END,
              signed_off_by = CASE WHEN $4::boolean THEN NULL ELSE ci.signed_off_by END,
              waived_at     = CASE WHEN $4::boolean THEN NULL ELSE ci.waived_at END,
              waived_by     = CASE WHEN $4::boolean THEN NULL ELSE ci.waived_by END,
              updated_at = now()
         FROM checklist_templates t
        WHERE ci.template_id = t.id AND t.code = $5 AND ci.application_id = $1`,
      [appId, note, hint, !!reopen, CONDITION_CODE]);
  } catch (e) { console.error('[appraisal] as-is condition refresh failed (non-fatal):', e && e.message); }
}

/**
 * A reading that was APPLIED answers the findings that asked for it. Retire exactly those:
 *   • `asis_unreadable` — PILOT has now read it (and says from where);
 *   • `asis_mismatch`   — only when the value we wrote IS the value that finding proposed, i.e. we
 *                         did what "replace" would have done. A mismatch against some OTHER number
 *                         stays open for a human.
 * `asis_below_price` is deliberately LEFT OPEN — the borrower paying over the as-is collateral value
 * is a real underwriting signal, and lowering the file's number is exactly what made it true.
 */
async function retireAnsweredFindings(appId, appliedValue, sourceWord) {
  try {
    await db.query(
      `UPDATE appraisal_findings
          SET status='resolved', resolution='replace', resolution_value=$2,
              resolution_note=$3, resolved_at=now()
        WHERE application_id=$1 AND status='open'
          AND (code = 'asis_unreadable'
               -- Compared NUMERICALLY: appraisal_value is free text and shows up as "312500",
               -- "$ 312,500" and "312500.00" depending on who wrote it, so a string compare would
               -- silently leave the fatal finding open after PILOT did exactly what "replace" does.
               OR (code = 'asis_mismatch'
                   AND NULLIF(regexp_replace(coalesce(appraisal_value,''), '[^0-9.]', '', 'g'), '')::numeric = $2::numeric))`,
      [appId, String(appliedValue), `PILOT read the As-Is value (${sourceWord}) and applied it to the file — see the "Confirm the As-Is value" condition.`]);
  } catch (e) { console.error('[appraisal] as-is finding retire failed (non-fatal):', e && e.message); }
}

/**
 * Run the whole As-Is settlement for one file's CURRENT appraisal.
 *
 * @param {string} appId
 * @param {{pdfBase64?:string, actorId?:string, deps?:object,
 *          ensureCondition?:(appId:string)=>Promise<any>}} opts
 *        `ensureCondition` materializes the "Confirm the As-Is value" condition. It is a CALLBACK on
 *        purpose: the condition INSERT belongs to the appraisal desk (the reviewed condition writer),
 *        while the decision about whether one is needed belongs here, with the reading that made it.
 * @returns {Promise<{ran:boolean, applied?:boolean, value?:number|null, confidence?:string|null,
 *                    source?:string|null, why?:string, needsCondition?:boolean, reason?:string}>}
 */
async function settleAsIs(appId, opts = {}) {
  if (!appId) return { ran: false, reason: 'no application id' };
  try {
    const appr = (await db.query(
      `SELECT id, as_is_value, as_is_confidence, arv_value, appraised_value, condition_of_appraisal,
              value_cost_approach, value_income_approach, value_sales_approach, site_value,
              as_is_confirmed_value, as_is_confirmed_at,
              pdf_document_id, source_xml_document_id
         FROM appraisals
        WHERE application_id=$1 AND superseded=false
        ORDER BY imported_at DESC NULLS LAST LIMIT 1`, [appId])).rows[0];
    if (!appr) return { ran: false, reason: 'no current appraisal on this file' };

    const file = (await db.query(
      `SELECT as_is_value, purchase_price FROM applications WHERE id=$1 AND deleted_at IS NULL`, [appId])).rows[0];
    if (!file) return { ran: false, reason: 'file not found' };

    // The PDF bytes: whatever the caller already had in hand, else recovered from what the import
    // stored (the uploaded PDF slot, or the PDF embedded in the source XML). Only bothered with when
    // the data file did NOT already state a definite As-Is — the reader stops at the XML step in that
    // case, so pulling a 30 MB PDF out of storage first would be pure waste on the common path.
    const xmlIsDefinite = appr.as_is_value != null && appr.as_is_confidence === 'definite';
    let pdfBase64 = opts.pdfBase64 || null;
    if (!pdfBase64 && !xmlIsDefinite) {
      try { pdfBase64 = await require('./desk').pdfBytesForAppraisal(appr); } catch (_) { pdfBase64 = null; }
    }

    // The GPT locator is the one PAID call in the ladder, so it obeys the per-file spend cap the
    // rest of the AI stack obeys (ai-guideline-verify does the same). Over the cap → the
    // deterministic Ctrl-F still runs and still reports; only the AI step is skipped. A cost-meter
    // failure must never block the read, so it fails OPEN (the cap is a budget guard, not a gate).
    let useAi = true;
    try { useAi = await require('../ai/cost-meter').allowSpend(appId, db); } catch (_) { useAi = true; }

    const read = await readAsIs({
      xmlAsIs: appr.as_is_value, xmlAsIsConfidence: appr.as_is_confidence,
      arv: num(appr.arv_value), pdfBase64, useAi,
      // What the appraisal's ONE headline value means (AsIs vs SubjectTo…) and what that value is —
      // together these let the reader refuse to adopt an INFERRED basis, which is the one way an
      // after-repair value could be written into the As-Is.
      xmlBasis: appr.condition_of_appraisal, appraisedValue: num(appr.appraised_value),
      // The appraisal's OTHER figures — on a subject-to report each of these is a plausible dollar
      // amount printed near "as is" wording, and the income approach can even sit below the ARV.
      valueCostApproach: num(appr.value_cost_approach), valueIncomeApproach: num(appr.value_income_approach),
      valueSalesApproach: num(appr.value_sales_approach), siteValue: num(appr.site_value),
      // SANITY ONLY — the file's own numbers let the reader spot a ten-fold digit slip. They never
      // influence WHAT the appraisal is read to say.
      fileAsIs: num(file.as_is_value), purchasePrice: num(file.purchase_price),
    }, opts.deps || {});

    // The file freeze, checked with NO actor — this is PILOT writing, not a person, so it can never
    // inherit a super-admin's unlock.
    //
    // Deliberately NOT `structuralLockReason`: that helper swallows every error and returns null
    // ("if we can't read status, don't hard-block"), which is right for a human's edit — a 500 is
    // worse than a permitted write — and exactly wrong for an unattended writer. A statement timeout
    // during the boot sweep would make PILOT read a funded, term-sheet-sent file as UNLOCKED and
    // write to it. Same two halves, composed here so a failed read FAILS CLOSED.
    let lockReason = null;
    try {
      const FL = require('../file-lock');
      const row = await FL._internals.lockInputs(appId, db);
      lockReason = row
        ? (FL._internals.statusFreezeReason(row, {}) || FL._internals.termSheetFreezeReason(row, {}) || null)
        : 'this file could not be found to confirm its figures are unlocked';
    } catch (_) { lockReason = 'this file\'s figures could not be confirmed as unlocked'; }

    // IS THIS APPRAISAL EVEN ABOUT THIS PROPERTY? The desk already raises a FATAL finding when the
    // appraisal's address, unit count or property type disagrees with the file — every one of which
    // means we may be holding a report for a different property or a different deal. Adopting a
    // number off it would put a stranger's valuation on the loan, so no automatic write happens while
    // one is open. (The As-Is findings themselves — asis_mismatch / asis_below_price — are
    // deliberately NOT in this list: resolving those is the entire point.) Fails CLOSED: if we cannot
    // read the findings we do not write.
    let identityIssue = null;
    try {
      const bad = (await db.query(
        `SELECT code FROM appraisal_findings
          WHERE application_id=$1 AND status='open' AND severity='fatal'
            AND code = ANY($2::text[]) LIMIT 1`,
        [appId, ['address_mismatch', 'units_mismatch', 'property_type_mismatch']])).rows[0];
      if (bad) identityIssue = bad.code;
    } catch (_) { identityIssue = 'unknown'; }

    // A HUMAN'S DECISION ABOUT THE As-Is IS FINAL, and PILOT never re-litigates it. Two ways a person
    // can have already settled this number, and both must win:
    //   • they TYPED it on the condition (`as_is_confirmed_*`, and the file still shows what they
    //     typed) — the override path's own promise; without this, the "Read the appraisal again"
    //     button sitting one control away would overwrite them on the next click;
    //   • they resolved the `asis_mismatch` finding with KEEP or CUSTOM — an underwriter looking at
    //     the same two numbers and deciding the file's value stands. Re-reading the same appraisal
    //     must not quietly undo that, on this file or across the whole book in the boot sweep.
    // A DISMISS is not in that list on purpose: dismissing a finding sets it aside, it does not
    // choose a value. Fails CLOSED — an unreadable ledger means we do not write.
    let humanSettled = null;
    try {
      if (appr.as_is_confirmed_at && appr.as_is_confirmed_value != null
          && file.as_is_value != null
          && Math.abs(Number(file.as_is_value) - Number(appr.as_is_confirmed_value)) < 0.005) {
        humanSettled = 'entered_by_hand';
      } else {
        const kept = (await db.query(
          `SELECT 1 FROM appraisal_findings
            WHERE application_id=$1 AND code='asis_mismatch'
              AND status IN ('resolved','dismissed') AND resolution IN ('keep','custom') LIMIT 1`,
          [appId])).rows[0];
        if (kept) humanSettled = 'finding_resolved_by_hand';
      }
    } catch (_) { humanSettled = 'unknown'; }

    const fileAsIsBefore = num(file.as_is_value);
    const purchasePrice = num(file.purchase_price);
    const decision = decideAsIsApply({
      read, fileAsIs: fileAsIsBefore, purchasePrice,
      // A human's settled decision and an identity mismatch are both treated exactly like a lock: the
      // reading is kept and explained, the file is not touched, and a human decides. A human's
      // decision outranks the identity mismatch — it is the more specific reason.
      lockReason: lockReason || (humanSettled ? HUMAN_LOCK : null) || (identityIssue ? IDENTITY_LOCK : null),
      autoEnabled: autoEnabled(),
    });
    // Relabel ONLY when one of these locks is what actually stopped it. A reading that was already
    // refused for a better reason (we are not confident in it, the switch is off, the file agrees)
    // must keep saying so — hiding the real reason behind this one would send a human hunting for a
    // mismatch that is not what held it up.
    if (decision.why === 'file_locked' && !lockReason) {
      decision.why = humanSettled ? 'human_decided' : 'appraisal_identity_mismatch';
    }

    // ---- apply (the owner's rule) ------------------------------------------
    let applied = false;
    if (decision.apply) {
      // Pinned to the value we read a moment ago: if anything changed the As-Is in between, this
      // writes nothing rather than clobbering it. Writing as_is_value trips the reprice trigger
      // (db/071), which reopens the Products & Pricing condition — that is intended: the loan must
      // be re-priced on the lower value.
      const upd = await db.query(
        `UPDATE applications SET as_is_value=$2, updated_at=now()
          WHERE id=$1 AND as_is_value IS NOT DISTINCT FROM $3::numeric`,
        [appId, decision.value, fileAsIsBefore]);
      applied = upd.rowCount > 0;
      if (applied) {
        await audit(opts.actorId || null, 'appraisal_as_is_auto_applied', appId, {
          from: fileAsIsBefore, to: decision.value, kind: decision.kind,
          source: read.source, confidence: read.confidence, engine: read.engine || null,
          purchasePrice, quote: read.quote ? String(read.quote).slice(0, 300) : null,
        });
        await retireAnsweredFindings(appId, decision.value,
          read.source === 'xml' ? 'from the appraisal data file' : 'from the appraisal report PDF with OCR and AI');
      } else {
        decision.apply = false;
        decision.why = 'value_changed_underneath';
      }
    }

    // ---- record the reading on the appraisal --------------------------------
    try {
      await db.query(
        `UPDATE appraisals
            SET as_is_read_value=$2, as_is_read_source=$3, as_is_read_confidence=$4,
                as_is_read_quote=$5, as_is_read_engine=$6, as_is_read_detail=$7,
                -- Only STAMP a read that reached a verdict. A reader outage is retryable, and
                -- stamping it would drain this file out of the "previous AND future" sweep forever
                -- (the sweep selects rows whose as_is_read_at is NULL) — the same self-healing discipline the
                -- comp-split backfill documents.
                as_is_read_at = CASE WHEN $12::boolean THEN as_is_read_at ELSE now() END,
                -- NEVER DOWNGRADE THE APPLIED STAMP. A second read of a file PILOT already wrote
                -- returns same_value, and blindly writing applied=false here would erase the record
                -- that undoAppraisalImport relies on to take a PDF-read value back off the loan.
                as_is_applied           = CASE WHEN $8::boolean THEN true          ELSE as_is_applied END,
                as_is_applied_value     = CASE WHEN $8::boolean THEN $9::numeric   ELSE as_is_applied_value END,
                as_is_file_value_before = CASE WHEN $8::boolean THEN $10::numeric  ELSE as_is_file_value_before END,
                as_is_skip_reason=$11
          WHERE id=$1 AND superseded=false`,
        [appr.id, read.value, read.source, read.confidence,
         read.quote ? String(read.quote).slice(0, 1000) : null, read.engine,
         JSON.stringify({ steps: read.steps || [], candidates: read.candidates || [], reason: read.reason || null }),
         applied, applied ? decision.value : null, fileAsIsBefore,
         applied ? null : (decision.why || null), !!read.retryable]);
    } catch (e) { console.error('[appraisal] as-is read record failed (non-fatal):', e && e.message); }

    // ---- the human-facing condition ----------------------------------------
    // The owner's rule, both halves: a write gets a RE-REVIEW, and a reading PILOT is not confident
    // in must ALWAYS ask a human ("if you're not confident you should always ask in the condition
    // for the loan officer to look on the appraisal and enter it").
    //
    // So the ONLY state with no condition is the settled one: PILOT is confident AND the file already
    // shows exactly that value — the appraisal and the loan file agree, confirmed from two sides,
    // with nothing for anyone to do. Everything else raises it, including a confident reading it
    // could not act on (a frozen file, the switch off, the value moving underneath us).
    const settled = read.confident && !applied && decision.why === 'same_value';
    const needsCondition = !settled;
    if (needsCondition && typeof opts.ensureCondition === 'function') {
      try { await opts.ensureCondition(appId); }
      catch (e) { console.error('[appraisal] as-is condition attach failed (non-fatal):', e && e.message); }
    }
    // The wording is refreshed UNCONDITIONALLY. When no instance exists the UPDATE simply matches
    // nothing; when one DOES exist — attached by an earlier read that could not find the value, say —
    // it must never be left showing a stale explanation of a reading that has since changed.
    const note = buildAsIsNote({ read, decision, fileAsIsBefore, purchasePrice });
    const hint = buildAsIsHint(decision);
    await refreshCondition(appId, { note, hint, reopen: applied });

    return {
      ran: true, applied, value: read.value, confidence: read.confidence, source: read.source,
      why: decision.why, appliedValue: applied ? decision.value : null, needsCondition,
    };
  } catch (e) {
    console.error('[appraisal] as-is settle failed (non-fatal):', e && e.message);
    return { ran: false, reason: e && e.message };
  }
}

/**
 * A human types the As-Is on the condition (the internal field the owner asked for). This is the
 * override path: it always wins over anything PILOT read.
 *
 * Returns { ok } or { ok:false, error, status } — the caller (the route) turns it into HTTP.
 */
async function setAsIsByHuman(appId, value, { actorId, actor = null, note = null } = {}) {
  const v = Number(String(value == null ? '' : value).replace(/[,$\s]/g, ''));
  if (!Number.isFinite(v) || v <= 0) return { ok: false, status: 400, error: 'Enter the As-Is value as a number.' };
  if (v < 1000 || v > 100000000) return { ok: false, status: 400, error: 'That does not look like a property value — check the amount and try again.' };

  const lock = await require('../file-lock').structuralLockReason(appId, db, { actor });
  if (lock) return { ok: false, status: 409, error: lock, locked: true };

  const before = (await db.query(`SELECT as_is_value FROM applications WHERE id=$1 AND deleted_at IS NULL`, [appId])).rows[0];
  if (!before) return { ok: false, status: 404, error: 'not found' };

  await db.query(`UPDATE applications SET as_is_value=$2, updated_at=now() WHERE id=$1`, [appId, v]);
  try {
    await db.query(
      `UPDATE appraisals SET as_is_confirmed_value=$2, as_is_confirmed_by=$3, as_is_confirmed_at=now()
        WHERE application_id=$1 AND superseded=false`, [appId, v, actorId || null]);
  } catch (_) { /* the confirmation stamp is a record, not the write itself */ }

  await audit(actorId || null, 'appraisal_as_is_entered', appId, {
    from: num(before.as_is_value), to: v, note: note ? String(note).slice(0, 300) : null,
  });

  // The officer has answered the condition's question — say so on it, without clobbering a note they
  // typed themselves.
  await refreshCondition(appId, {
    note: `[auto] An officer entered the As-Is value: $${v.toLocaleString('en-US')}${before.as_is_value != null ? ` (it was $${Number(before.as_is_value).toLocaleString('en-US')})` : ''}. Sign this condition off once you are happy with it.`,
    hint: 'The As-Is value has been entered by hand. Sign this condition off once you have confirmed it against the appraisal report.',
    reopen: false,
  });

  return { ok: true, value: v, previous: num(before.as_is_value) };
}

/**
 * The read + the file's numbers, for the condition's internal field and the appraisal desk.
 * `actor` is passed through to the file-freeze check so the panel shows THIS person's own lock
 * state (a super-admin on an unlocked file sees none, and the wording is the staff wording).
 */
async function asIsState(appId, actor = null) {
  const appr = (await db.query(
    `SELECT id, as_is_value, as_is_confidence, arv_value,
            as_is_read_value, as_is_read_source, as_is_read_confidence, as_is_read_quote,
            as_is_read_engine, as_is_read_at, as_is_read_detail,
            as_is_applied, as_is_applied_value, as_is_file_value_before, as_is_skip_reason,
            as_is_confirmed_value, as_is_confirmed_at, as_is_confirmed_by
       FROM appraisals
      WHERE application_id=$1 AND superseded=false
      ORDER BY imported_at DESC NULLS LAST LIMIT 1`, [appId])).rows[0] || null;
  const file = (await db.query(
    `SELECT as_is_value, purchase_price, arv FROM applications WHERE id=$1`, [appId])).rows[0] || {};
  const lock = await require('../file-lock').structuralLockReason(appId, db, { actor });
  return {
    hasAppraisal: !!appr,
    file: { asIs: num(file.as_is_value), purchasePrice: num(file.purchase_price), arv: num(file.arv) },
    read: appr ? {
      value: num(appr.as_is_read_value), source: appr.as_is_read_source, confidence: appr.as_is_read_confidence,
      quote: appr.as_is_read_quote, engine: appr.as_is_read_engine, at: appr.as_is_read_at,
      applied: !!appr.as_is_applied, appliedValue: num(appr.as_is_applied_value),
      fileValueBefore: num(appr.as_is_file_value_before), skipReason: appr.as_is_skip_reason,
      candidates: (appr.as_is_read_detail && appr.as_is_read_detail.candidates) || [],
      reason: (appr.as_is_read_detail && appr.as_is_read_detail.reason) || null,
    } : null,
    confirmed: appr && appr.as_is_confirmed_at
      ? { value: num(appr.as_is_confirmed_value), at: appr.as_is_confirmed_at } : null,
    xml: appr ? { asIs: num(appr.as_is_value), confidence: appr.as_is_confidence, arv: num(appr.arv_value) } : null,
    locked: lock || null,
    autoEnabled: autoEnabled(),
  };
}

module.exports = { settleAsIs, setAsIsByHuman, asIsState, refreshCondition, autoEnabled, CONDITION_CODE };
