/**
 * Sync review queue — the human gate for suspicious cross-system changes
 * (2026-07-15 date incident; db/108 + two-sided upgrade db/110). The sync
 * stays fully bidirectional: normal changes flow both ways as always, and the
 * auto-resolution engine (src/lib/sync-autoresolve.js) settles the PROVABLE
 * conflicts by itself. Only genuine ambiguity stops here and waits for a
 * person:
 *   * outbound DOB changes of any magnitude (a DOB change is a human decision),
 *   * inbound dates with out-of-range years (mid-typing / 2-digit-year "26"),
 *   * inbound DOBs that disagree with the portal and can't be auto-resolved,
 *   * PII overwrites a bulk repush wanted to make.
 * Every row is TWO-SIDED: it records what ClickUp holds and what PILOT holds,
 * and resolving picks a winner that is applied to BOTH systems (values are
 * re-read live at resolve time — stored values are display-only; SSNs are
 * stored masked, never cleartext).
 * The file's LOAN OFFICER is notified (in-app + branded email) the moment a
 * row lands, with a deep link to /internal/sync-reviews — reviews are theirs
 * to resolve, not an admin-only backwater.
 * Queueing is best-effort and deduped (one open row per task+field+proposal;
 * DOBs dedupe per borrower) — it must never break a sync pass.
 */
const db = require('../db');

const FIELD_LABELS = {
  date_of_birth: 'Date of birth', expected_closing: 'Expected closing date',
  actual_closing: 'Actual closing date', acquisition_date: 'Acquisition date',
  ssn: 'Social Security number', first_name: 'Borrower name', email: 'Borrower email',
  cell_phone: 'Borrower cell', current_address: 'Borrower home address', status: 'File status',
  // FILE-LEVEL rows (owner-directed 2026-07-15 night: "not only a field that is
  // wrong — entire files; anything stuck goes to manual review, with options"):
  file_link: 'File not syncing', ys_loan_number: 'YS loan number', push_job: 'ClickUp push failed',
  co_first_name: 'Co-borrower name', co_cell_phone: 'Co-borrower cell',
  sharepoint_folder: 'SharePoint filing', sharepoint_doc: 'SharePoint document sync',
  // Two different people merged onto one profile (the wrong-officer incident):
  borrower_identity: 'Borrower identity — one profile, two people',
  co_borrower_identity: 'Co-borrower identity — one profile, two people',
  // Two different people using ONE email address (owner-directed: the email
  // must be assigned to exactly one borrower; until then it never links files):
  shared_email: 'Shared email — two borrowers',
  // ClickUp changed a loan FIGURE while the file was frozen (sent term sheet /
  // Clear-to-Close / Funded) — the change was held so the sent term sheet stays
  // in agreement with the file:
  economics_frozen: 'Loan figures — frozen (term sheet sent / file locked)',
  // ClickUp moved the file to Clear to Close while PILOT is not there yet — held
  // for a human to confirm the move (owner-directed 2026-07-27):
  status_ctc: 'Clear to Close — confirm the move',
};

async function queueReview({ applicationId, borrowerId, taskId, direction, fieldKey,
  currentValue, proposedValue, rawValue, reason, clickupValue, portalValue, suppressIfRejected,
  source, portalActorId, dbc }) {
  // Callers that are already INSIDE a transaction (the Encompass enrichment pass
  // runs one) must queue on THEIR connection, or the insert cannot see the rows
  // that transaction created and fails its foreign key. Defaults to the pool.
  const q = dbc || db;
  // WHICH SYSTEM is on the other side (db/328). Defaults to 'clickup' — every
  // existing caller. An 'encompass' row's `task_id` is a namespaced
  // `encompass:<loanGuid>`, NOT a ClickUp task, and no resolver may ever hand it
  // to the ClickUp client; the resolvers branch on this column, not on a guess.
  const src = source === 'encompass' ? 'encompass' : 'clickup';
  try {
    // FILE-LEVEL rows are re-produced by every sync pass while the file stays
    // stuck — so a reviewer's explicit DISMISS must stick (the next reconcile
    // is 5 minutes away; without this the dismissed row respawns forever).
    // Field-value rows don't use this: a re-blocked write is a fresh event.
    if (suppressIfRejected) {
      const rej = await q.query(
        `SELECT 1 FROM sync_review_queue
          WHERE coalesce(task_id,'') = coalesce($1,'') AND field_key=$2 AND reason=$3
            AND status='rejected' LIMIT 1`, [taskId || null, fieldKey, reason]);
      if (rej.rows[0]) return false;   // previously dismissed — nothing queued
    }
    // A DOB is a BORROWER-level fact: one open review per borrower + proposal,
    // not one per linked task (a borrower with three tasks was queueing three
    // identical rows — owner-reported noise, 2026-07-15). The task-scoped
    // ON CONFLICT below still dedupes everything else.
    if (fieldKey === 'date_of_birth' && borrowerId) {
      const dup = await q.query(
        `SELECT 1 FROM sync_review_queue
          WHERE status='open' AND field_key='date_of_birth' AND borrower_id=$1
            AND coalesce(proposed_value,'') = coalesce($2,'') LIMIT 1`,
        [borrowerId, proposedValue == null ? null : String(proposedValue)]);
      if (dup.rows[0]) return false;   // an identical open DOB review already exists
    }
    // Two-sided values: prefer explicit clickupValue/portalValue from the
    // caller; otherwise derive from direction (inbound: source=ClickUp is the
    // proposal, destination=PILOT is the current — outbound the reverse).
    const cuV = clickupValue !== undefined ? clickupValue
      : (direction === 'inbound' ? proposedValue : currentValue);
    const pV = portalValue !== undefined ? portalValue
      : (direction === 'inbound' ? currentValue : proposedValue);
    const ins = await q.query(
      `INSERT INTO sync_review_queue
         (application_id, borrower_id, task_id, direction, field_key, current_value, proposed_value, raw_value, reason, clickup_value, portal_value, source, portal_actor_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT ((coalesce(task_id,'')), field_key, direction, (coalesce(proposed_value,''))) WHERE status='open'
       DO NOTHING RETURNING id`,
      [applicationId || null, borrowerId || null, taskId || null, direction, fieldKey,
       currentValue == null ? null : String(currentValue),
       proposedValue == null ? null : String(proposedValue),
       rawValue == null ? null : String(rawValue), reason,
       cuV == null ? null : String(cuV), pV == null ? null : String(pV), src,
       portalActorId || null]);
    if (ins.rows[0]) notifyLoanOfficer(ins.rows[0].id).catch(() => {});
    // Reached the insert without throwing → a row IS in the queue (freshly
    // inserted, or an equal open row already there via ON CONFLICT). Callers that
    // tell the user "flagged for review" rely on this to not over-promise.
    return true;
  } catch (e) { console.warn('[sync-review] queue insert skipped:', e.message); return false; }
}

/**
 * Email + in-app notify the file's loan officer that a review needs them
 * (owner-directed 2026-07-15). Resolution: the row's application's LO; for a
 * borrower-level row (a DOB), every LO across the borrower's active linked
 * files (deduped). Falls back to nothing quietly — notification must never
 * break the sync. notified_at marks delivery so re-queues never double-send.
 */
// A one-line property address for a Sitewire draw-review email subject (from applications.property_address).
function shortAddress(a) {
  if (!a) return null;
  if (typeof a === 'string') { const s = a.trim(); return s || null; }   // legacy: a bare address string
  if (typeof a !== 'object') return null;
  if (a.oneLine && String(a.oneLine).trim()) return String(a.oneLine).trim(); // the stored one-line form wins
  const street = a.line1 || a.street || a.street_with_unit || null;
  const cityState = [a.city, a.state].filter(Boolean).join(', ');
  const tail = [cityState, a.zip || a.postal].filter(Boolean).join(' ');
  const parts = [street, tail].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}
// Turn a coded Sitewire park reason ("sitewire_units_note: the file lists 2 unit(s)…") into the plain
// human sentence for the email body — the WHOLE issue, never blank (owner-directed 2026-07-20).
function humanizeSitewireReason(reason) {
  const s = String(reason || '').trim();
  if (!s) return 'A draw-setup step on this file needs your review.';
  const m = /^sitewire_[a-z0-9_]+:\s*(.+)$/is.exec(s);
  return (m ? m[1] : s).trim();
}

// A SharePoint document-mirror failure is NOT a value disagreement and NOT a file-link problem —
// so it must NOT get the generic file-level copy ("create the file / link it to an existing one"),
// which lists the wrong actions and confused LOs. It gets its own plain-language email naming the
// specific document, that it could not be copied into the team drive, and the RIGHT next steps
// (retry / re-check filing on the review screen, or ask for a re-upload if the saved copy is
// damaged). Pure + exported so the copy is unit-tested without a DB. Owner-directed 2026-07-21.
// WHAT PILOT IS ACTUALLY DOING ABOUT IT (owner-reported 2026-08-20). The four
// verdicts the integrity audit writes — carried on the row as raw_value.kind —
// all leave documents.sharepoint_backed_up_at SET, and every selector that feeds
// the mirror (pendingBatch / neverAttemptedStrays / stuckDocuments / the
// force-attempt) requires it NULL. So for these four PILOT is NOT retrying: the
// document sits exactly as it is until a person acts. Telling the loan officer
// “PILOT keeps retrying on its own” there was false, and it is the sentence that
// decides whether they open the screen today or leave it for the automation.
// Every other producer (an upload that failed) really does keep retrying.
const SP_DOC_PARKED = {
  'item-missing': 'The copy PILOT put in the drive is no longer there — someone deleted or moved it, and PILOT looked for it again by name and by its Pilot stamp without finding it. PILOT will NOT put it back on its own (re-uploading over a deliberate deletion is your call), so until you retry it the document is not in the drive.',
  'local-missing': 'PILOT can no longer read its own stored copy, so the SharePoint copy may be the only one left — do NOT delete it. PILOT has stopped touching this one on its own.',
  'source-suspect': 'The saved file itself is damaged — it was already damaged when it was uploaded, so re-mirroring cannot fix it and PILOT has stopped retrying. Ask whoever uploaded it for a fresh copy.',
  'malware-flagged': 'Microsoft Defender flagged the SharePoint copy and blocked it. PILOT has stopped retrying — check the source document in PILOT before you retry anything.',
};
function sharepointDocEmail({ borrowerName, portalValue, rawValue } = {}) {
  const who = borrowerName ? ` for ${borrowerName}` : '';
  const spec = portalValue ? `: ${String(portalValue).trim()}` : '';
  let kind = null;
  try {
    const raw = typeof rawValue === 'string' ? JSON.parse(rawValue) : rawValue;
    kind = raw && raw.kind ? String(raw.kind) : null;
  } catch (_) { /* unreadable raw_value — fall back to the retrying copy */ }
  const status = SP_DOC_PARKED[kind]
    || 'PILOT keeps retrying on its own, but this one needs a look so the document isn’t missing from the drive.';
  return {
    title: `A document couldn’t be saved to SharePoint${who}`,
    body: `A document${who} couldn’t be copied into your SharePoint team drive${spec}. ` +
      `${status} ` +
      `Open the Sync review screen to retry it or re-check where it files — and if the document’s saved copy is damaged, ask the borrower to upload it again.`,
  };
}

async function notifyLoanOfficer(reviewId) {
  const r = await db.query(
    `SELECT q.*, NULLIF(b.full_name,'') AS borrower_name, sa.email AS actor_email
       FROM sync_review_queue q
       LEFT JOIN borrowers b ON b.id = q.borrower_id
       LEFT JOIN staff_users sa ON sa.id = q.portal_actor_id AND sa.is_active
      WHERE q.id=$1 AND q.status='open' AND q.notified_at IS NULL`, [reviewId]);
  const row = r.rows[0];
  if (!row) return;
  const officers = new Map();
  const add = (id, email, appId) => { if (id && !officers.has(id)) officers.set(id, { email, appId }); };
  if (row.application_id) {
    // HARD SCOPE GUARD (owner-reported 2026-07-15 night: an officer with NO
    // relation to the file was emailed a review for it): a FILE-scoped row
    // notifies ONLY that file's assigned loan officer — never any other
    // officer, and NEVER the borrower-wide fan-out below. A file with no
    // assigned LO emails nobody (the admin queue, the sidebar badge, and the
    // 7-day admin escalation still surface it).
    const a = (await db.query(
      `SELECT a.loan_officer_id, s.email FROM applications a
         LEFT JOIN staff_users s ON s.id = a.loan_officer_id AND s.is_active
        WHERE a.id=$1`, [row.application_id])).rows[0];
    if (a) add(a.loan_officer_id, a.email, row.application_id);
  } else if (row.borrower_id) {
    // BORROWER-level rows only (no file to scope to — e.g. a DOB): the loan
    // officers of THIS borrower's own active files, each of whom owns the
    // shared fact being reviewed.
    const apps = (await db.query(
      `SELECT a.id, a.loan_officer_id, s.email FROM applications a
         LEFT JOIN staff_users s ON s.id = a.loan_officer_id AND s.is_active
        WHERE a.borrower_id=$1 AND a.deleted_at IS NULL AND a.loan_officer_id IS NOT NULL`, [row.borrower_id])).rows;
    for (const a of apps) add(a.loan_officer_id, a.email, a.id);
  }
  // ALSO notify the person who MADE the change (owner-directed 2026-08-11): "every user
  // should have their own view of the stuff THEY changed that doesn't agree with ClickUp."
  // The actor caused this row, so they are by definition related to the file — this does
  // not widen past the hard scope guard's intent, and it also gives an UNASSIGNED file a
  // recipient (the editor) where before it emailed nobody. add() dedupes if they are the LO.
  if (row.portal_actor_id && row.actor_email) add(row.portal_actor_id, row.actor_email, row.application_id);
  if (!officers.size) return;   // unassigned file with no known editor — the admin queue view still shows it
  const notify = require('./notify');
  const label = FIELD_LABELS[row.field_key] || row.field_key;
  const who = row.borrower_name ? ` for ${row.borrower_name}` : '';
  // ---- Sitewire construction-draw reviews get their OWN email: the property ADDRESS anchors the subject
  // and the row's REASON (the full, human issue text) is the body. NEVER the ClickUp two-sided copy — a
  // Sitewire row has no ClickUp side, so that template rendered "In ClickUp: — / In PILOT: —" (blank +
  // wrong system name). Owner-directed 2026-07-20. ----
  const isSitewire = row.field_key === 'sitewire';
  const isSharepointDoc = row.field_key === 'sharepoint_doc';
  // A frozen-economics hold is neither a two-sided "pick a winner" nor a generic
  // file-level stuck state — it needs its OWN email (pre-merge audit): PILOT held
  // a ClickUp loan-figure change because the file is frozen, and the ONE action is
  // keep-the-file's-figures (or clear the term sheet to accept the change).
  const isEconomicsFrozen = row.field_key === 'economics_frozen';
  // A Clear-to-Close confirm hold — ClickUp moved the file to Clear to Close but
  // PILOT is not there yet, so the move was held for a human to confirm.
  const isCtcConfirm = row.field_key === 'status_ctc';
  let swAddress = null;
  if (isSitewire && row.application_id) {
    try { const ar = (await db.query(`SELECT property_address FROM applications WHERE id=$1`, [row.application_id])).rows[0]; swAddress = ar ? shortAddress(ar.property_address) : null; } catch (_) {}
  }
  // FILE-LEVEL rows aren't a value disagreement — the email must say what the
  // situation is and that the review screen offers ACTIONS, not sides
  // (pre-merge audit #257 should-fix: the two-sided copy misdirected LOs).
  const fileLevel = ['file_link', 'push_job', 'ys_loan_number', 'sharepoint_folder', 'co_first_name', 'co_cell_phone', 'borrower_identity', 'co_borrower_identity', 'shared_email'].includes(row.field_key);
  let title, body;
  if (isSharepointDoc) {
    ({ title, body } = sharepointDocEmail({
      borrowerName: row.borrower_name, portalValue: row.portal_value, rawValue: row.raw_value }));
  } else if (isCtcConfirm) {
    title = `Confirm needed: ClickUp moved this file to Clear to Close${who}`;
    body = `ClickUp changed this file's status to Clear to Close, but in PILOT it is still "${row.portal_value || 'an earlier status'}". ` +
      `PILOT did NOT move it on its own — Clear to Close is a major milestone (it locks the file and notifies the borrower), so it waits for you to confirm.\n\n` +
      `Open the Sync review screen. Confirm to move the file to Clear to Close in PILOT (the borrower is notified), or dismiss to keep its current status.`;
  } else if (isEconomicsFrozen) {
    title = `Sync review needed: loan figures held — the file is locked${who}`;
    body = `A loan figure was changed in ClickUp, but this file is LOCKED — a term sheet has been sent for signature, or the file is Clear-to-Close / Funded — so PILOT did NOT change the file (the term sheet that already went out stays accurate).\n\n` +
      `In ClickUp: ${row.clickup_value || '—'}\nOn the file (kept): ${row.portal_value || '—'}\n\n` +
      `Open the Sync review screen. You can keep the file's figures and push them back to ClickUp so the two match. To ACCEPT the ClickUp change instead, clear the Term Sheet package (or ask a super-admin to unlock a Clear-to-Close / Funded file) and re-register — the figures then update on their own.`;
  } else if (isSitewire) {
    const place = swAddress || row.borrower_name || 'a construction-draw file';
    title = `Draw review needed — ${place}`;
    body = `A construction-draw (Sitewire) review needs your decision${who}${swAddress ? ` — ${swAddress}` : ''}:\n\n` +
      `${humanizeSitewireReason(row.reason)}\n\n` +
      `Open the Sync review screen to resolve it — the card shows the exact options for this review (for example: acknowledge the note, retry the push after fixing the cause, or dismiss).`;
  } else {
    title = `Sync review needed: ${label}${who}`;
    body = fileLevel
      ? `A file${who} needs a decision: ${label.toLowerCase()}` +
        (row.clickup_value ? ` (${row.clickup_value})` : '') + '. ' +
        `Open the Sync review screen — it explains what happened and offers the resolution options (create the file, link it to an existing one, retry the push, or dismiss).`
      : `PILOT and ClickUp disagree on the ${label.toLowerCase()}${who}. ` +
        `In ClickUp: ${row.clickup_value || '—'}. In PILOT: ${row.portal_value || '—'}. ` +
        `Open the Sync review screen, compare both sides, and choose which value should win — it will be applied to both systems.`;
  }
  for (const [staffId, o] of officers) {
    try {
      await notify.notifyStaff(staffId, {
        type: 'sync_review',
        title,
        body,
        applicationId: row.application_id || o.appId || null,
        link: '/internal/sync-reviews',
        // Every one of these bodies says "open the Sync review screen" — and the
        // button under it said "Open the loan file", which is where these do NOT
        // appear (owner-reported 2026-07-28). The link was always right; only the
        // label lied, and the label is what people read.
        ctaLabel: 'Open the sync review screen',
        emailTo: o.email || undefined,
      });
    } catch (e) { console.warn('[sync-review] LO notify failed:', e.message); }
  }
  await db.query(`UPDATE sync_review_queue SET notified_at=now() WHERE id=$1`, [reviewId]).catch(() => {});
}

/**
 * Auto-close OPEN review rows whose underlying disagreement no longer exists
 * (owner-directed 2026-07-15: "once it's fixed in ClickUp, the review should
 * go away on the next sync, even if you don't click anything"). Called by the
 * sync whenever it observes the two systems AGREEING (or auto-adopts a
 * canonical value) for a field that has open rows. Closed as
 * status='resolved' + auto_resolved=true with an explanatory note — kept as
 * history, never deleted. A NEW conflict later simply queues a new row.
 */
async function closeStaleReviews({ borrowerId, taskId, applicationId, fieldKey, note }) {
  if (!fieldKey || (!borrowerId && !taskId && !applicationId)) return 0;
  try {
    const r = await db.query(
      `UPDATE sync_review_queue
          SET status='resolved', auto_resolved=true, resolved_at=now(),
              resolution_note=$1
        WHERE status='open' AND field_key=$2
          AND (($3::uuid IS NOT NULL AND borrower_id=$3) OR ($4::text IS NOT NULL AND task_id=$4)
               OR ($5::uuid IS NOT NULL AND application_id=$5))
        RETURNING id`,
      [note || 'auto-closed — the two systems now agree (fixed at the source)',
       fieldKey, borrowerId || null, taskId || null, applicationId || null]);
    return r.rowCount || 0;
  } catch (e) { console.warn('[sync-review] stale-close skipped:', e.message); return 0; }
}

/**
 * Recover the STAFF member whose PILOT edit produced a sync-review row, from the audit
 * trail (owner-directed 2026-08-11: "every user should have their own view of the stuff
 * THEY changed that doesn't agree with ClickUp"). We do NOT stamp a *_edited_by column on
 * every write door — the audit log already records who changed what, keyed on the file.
 *
 * Precise pass: the most recent staff edit whose recorded diff names one of the conflicting
 * columns (PATCH /details → detail.changes keyed by column; the completeness panels →
 * detail.fields / detail.app arrays of column keys). Fallback: the most recent staff edit of
 * the file in a short window — very likely the person who just made the change the pull tried
 * to revert (e.g. the closing-date door, whose audit detail is camelCase, not column keys).
 * Best-effort: returns null (unattributed) on any miss or error — the "My changes" view and
 * the actor notification both tolerate null. Never throws.
 *
 * @param {string} appId
 * @param {string[]} columns  the conflicting column names
 * @returns {Promise<string|null>} a staff_users.id, or null
 */
const EDIT_ACTIONS = ['edit_application', 'set_closing_date', 'complete_fields', 'edit_field', 'condition_field'];
async function lastFieldEditor(appId, columns, client) {
  if (!appId) return null;
  const q = client || db;
  const cols = (Array.isArray(columns) ? columns : []).filter(Boolean).map(String);
  try {
    if (cols.length) {
      const p = await q.query(
        `SELECT actor_id FROM audit_log
          WHERE actor_kind='staff' AND actor_id IS NOT NULL
            AND entity_type='application' AND entity_id=$1
            AND action = ANY($3::text[])
            AND ( detail->'changes' ?| $2::text[]
               OR detail->'fields'  ?| $2::text[]
               OR detail->'app'     ?| $2::text[]
               OR detail->'borrower' ?| $2::text[] )
            AND created_at > now() - interval '60 days'
          ORDER BY created_at DESC LIMIT 1`, [appId, cols, EDIT_ACTIONS]);
      if (p.rows[0]) return p.rows[0].actor_id;
    }
    const f = await q.query(
      `SELECT actor_id FROM audit_log
        WHERE actor_kind='staff' AND actor_id IS NOT NULL
          AND entity_type='application' AND entity_id=$1
          AND action = ANY($2::text[])
          AND created_at > now() - interval '7 days'
        ORDER BY created_at DESC LIMIT 1`, [appId, EDIT_ACTIONS]);
    return f.rows[0] ? f.rows[0].actor_id : null;
  } catch (_) { return null; }   // best-effort; an unattributed row is fine
}

/**
 * AGING + ESCALATION (mega-audit enhancement #2; db/112): "nothing is silent"
 * must be a STANDING guarantee, not a point-in-time one. A row still open
 * after 3 days re-notifies the file's loan officer once (reminded_at); after
 * 7 days it escalates once to every active admin (escalated_at). Runs on boot
 * and daily; bounded and best-effort — never breaks the sync.
 */
async function remindStaleReviewsOnce() {
  const notify = require('./notify');
  let reminded = 0, escalated = 0;
  try {
    const remind = await db.query(
      `SELECT id FROM sync_review_queue
        WHERE status='open' AND reminded_at IS NULL AND created_at < now() - interval '3 days'
        ORDER BY created_at ASC LIMIT 50`);
    for (const row of remind.rows) {
      try {
        // Re-run the standard LO notification for the row (it targets the
        // file's LO / the borrower's LOs); notified_at gates only the FIRST
        // send, so clear our own gate by calling notify directly per row.
        await db.query(`UPDATE sync_review_queue SET notified_at=NULL WHERE id=$1`, [row.id]);
        await notifyLoanOfficer(row.id);
        await db.query(`UPDATE sync_review_queue SET reminded_at=now() WHERE id=$1`, [row.id]);
        reminded++;
      } catch (_) { /* per-row best-effort */ }
    }
    const esc = await db.query(
      `SELECT q.id, q.field_key, NULLIF(b.full_name,'') AS borrower_name
         FROM sync_review_queue q LEFT JOIN borrowers b ON b.id=q.borrower_id
        WHERE q.status='open' AND q.escalated_at IS NULL AND q.created_at < now() - interval '7 days'
        ORDER BY q.created_at ASC LIMIT 25`);
    if (esc.rows.length) {
      const admins = (await db.query(
        `SELECT id, email FROM staff_users WHERE is_active AND role IN ('admin','super_admin')`)).rows;
      const lines = esc.rows.map((r) => `• ${FIELD_LABELS[r.field_key] || r.field_key}${r.borrower_name ? ` — ${r.borrower_name}` : ''}`).join('\n');
      for (const a of admins) {
        try {
          await notify.notifyStaff(a.id, {
            type: 'sync_review',
            title: `${esc.rows.length} sync review item(s) open for over a week`,
            body: `These have been waiting more than 7 days with no decision:\n${lines}\n\nOpen the Sync review screen to settle them.`,
            link: '/internal/sync-reviews', ctaLabel: 'Open the sync review screen',
            emailTo: a.email || undefined,
          });
        } catch (_) { /* per-admin best-effort */ }
      }
      await db.query(`UPDATE sync_review_queue SET escalated_at=now() WHERE id = ANY($1)`, [esc.rows.map((r) => r.id)]);
      escalated = esc.rows.length;
    }
  } catch (e) { console.warn('[sync-review] aging sweep skipped:', e.message); }
  if (reminded || escalated) console.log(`[sync-review] aging: ${reminded} reminded, ${escalated} escalated`);
  return { reminded, escalated };
}

/**
 * A digest line a person can read. The stored `reason` is a CODE, sometimes with
 * a sentence glued on after a colon ("encompass_address_differs: the most recent
 * Encompass file has …"), which is what made the digest read like a stack trace.
 * Pure + exported so the wording is unit-tested without a DB.
 */
function digestReasonLabel(fieldKey, reason) {
  const field = FIELD_LABELS[fieldKey] || fieldKey || 'Sync review';
  const raw = String(reason || '').trim();
  if (!raw) return field;
  // "<code>: <sentence>" → the sentence; a bare code → the code as words.
  const m = /^([a-z0-9_]+):\s*(.+)$/is.exec(raw);
  const detail = m ? m[2].trim() : raw.replace(/_/g, ' ');
  return `${field} — ${detail}`;
}

/**
 * The digest's whole decision — send or stay quiet, and what it says — as ONE
 * pure function of the numbers. Pure + exported so every branch (including
 * "there is nothing to send") is unit-tested without a database.
 *
 *   stats    — the counts query below
 *   byReason — [{field_key, reason, n}] over the OPEN rows
 * Returns { send, why, title, body }.
 */
function digestMessage(stats, byReason) {
  const n = (v) => Number(v) || 0;
  const openNow = n(stats && stats.open_now);
  const open14 = n(stats && stats.open_14d);
  const settled = n(stats && stats.auto_closed) + n(stats && stats.human_resolved) + n(stats && stats.dismissed);
  // NOTHING WAITING → NOTHING SENT. A digest whose only content is "the system
  // worked and left you nothing to do" is the noise itself.
  if (!openNow) return { send: false, why: 'nothing_open', title: null, body: null };
  const rows = Array.isArray(byReason) ? byReason : [];
  const listed = rows.reduce((s, r) => s + n(r.n), 0);
  const reasonLines = rows.map((r) => `• ${digestReasonLabel(r.field_key, r.reason)}: ${n(r.n)}`).join('\n') || '• (none)';
  const more = listed < openNow ? `\n• …and ${openNow - listed} more` : '';
  return {
    send: true,
    why: 'open_items',
    title: `Sync review — ${openNow} waiting for a person`,
    body: `${openNow} item${openNow === 1 ? '' : 's'} ${openNow === 1 ? 'is' : 'are'} waiting for someone to decide` +
      `${open14 ? ` — ${open14} of them for more than two weeks` : ''}.\n\n` +
      `What's waiting:\n${reasonLines}${more}\n\n` +
      `Nothing else needs you: in the last 7 days ${n(stats.opened)} came up and ${settled} were already settled ` +
      `(${n(stats.auto_closed)} closed by the system on its own, ${n(stats.human_resolved)} decided by a person, ` +
      `${n(stats.dismissed)} dismissed).`,
  };
}

/**
 * WEEKLY DIGEST (mega-audit enhancement #5): proof the review system is being
 * worked + early warning when a producer starts flooding. Emails active
 * admins a summary; self-gates via an audit_log stamp so it sends at most once
 * every 6 days regardless of how often the caller fires.
 *
 * IT REPORTS THE BACKLOG, NOT THE WEEK'S CHURN (owner-reported 2026-07-28:
 * "why am I still getting these emails, most of this was resolved already and
 * it's not coming up as a manual review required"). The old digest listed every
 * row CREATED in the last 7 days regardless of whether it was already settled,
 * so a week in which the system opened 77 address rows and closed 74 of them by
 * itself read as 77 things to go and do — and clicking through showed almost
 * nothing, because almost nothing was still open. Two rules now:
 *   • the "what's waiting" list is the OPEN queue, whenever it was raised;
 *   • an EMPTY queue sends NOTHING. A digest whose only content is "the system
 *     worked and left you nothing" is the noise itself.
 * The week's activity numbers stay, clearly marked as activity that needs
 * nothing from the reader.
 */
async function sendReviewDigestOnce() {
  try {
    // Atomically CLAIM the 6-day window so two overlapping passes / instances can't
    // both pass the check and both email every admin (owner-reported duplicate sweep
    // 2026-07-20). Uses the shared advisory-locked claim — a plain INSERT…WHERE NOT
    // EXISTS is not atomic under READ COMMITTED (audit G4). Detail is enriched after
    // we compute the stats.
    const claimId = await require('./throttle-claim').claimOncePerPeriod({ action: 'sync_review_digest_sent', interval: '6 days' });
    if (!claimId) return false;   // another pass already sent this week
    const stats = (await db.query(
      `SELECT
         count(*) FILTER (WHERE created_at > now() - interval '7 days') AS opened,
         count(*) FILTER (WHERE status='resolved' AND auto_resolved AND resolved_at > now() - interval '7 days') AS auto_closed,
         count(*) FILTER (WHERE status IN ('resolved','approved') AND NOT auto_resolved AND resolved_at > now() - interval '7 days') AS human_resolved,
         count(*) FILTER (WHERE status='rejected' AND resolved_at > now() - interval '7 days') AS dismissed,
         count(*) FILTER (WHERE status='open') AS open_now,
         count(*) FILTER (WHERE status='open' AND created_at < now() - interval '14 days') AS open_14d
       FROM sync_review_queue`)).rows[0];
    // WHAT IS STILL WAITING — the open queue, whenever it was raised. Grouped by
    // the field AND the reason so two different problems with one field stay
    // distinguishable, then rendered as a sentence rather than a code.
    const byReason = (await db.query(
      `SELECT field_key, reason, count(*)::int AS n FROM sync_review_queue
        WHERE status='open' GROUP BY field_key, reason ORDER BY n DESC LIMIT 8`)).rows;
    const msg = digestMessage(stats, byReason);
    // The 6-day claim above is deliberately KEPT even when nothing is sent: the
    // point is one decision per week, and a quiet week must not turn into a daily
    // re-check that eventually finds one row and mails everybody. The audit row
    // records that the week was clean.
    if (!msg.send) {
      await db.query(`UPDATE audit_log SET detail=$1::jsonb WHERE id=$2`,
        [JSON.stringify({ ...stats, sent: false, why: msg.why }), claimId]).catch(() => {});
      return false;
    }
    const notify = require('./notify');
    const admins = (await db.query(
      `SELECT id, email FROM staff_users WHERE is_active AND role IN ('admin','super_admin')`)).rows;
    for (const a of admins) {
      try {
        await notify.notifyStaff(a.id, {
          type: 'sync_review',
          title: msg.title,
          body: msg.body,
          link: '/internal/sync-reviews',
          // The default staff CTA is "Open the loan file", which is wrong here and
          // was read as a promise that the loan file would show the review — it
          // does not; these live on the review screen (owner-reported 2026-07-28).
          ctaLabel: 'Open the sync review screen',
          emailTo: a.email || undefined,
        });
      } catch (_) { /* per-admin best-effort */ }
    }
    // Enrich the claim row with the stats for the audit trail (the throttle stamp
    // was already written by the atomic claim above — never a second row).
    await db.query(
      `UPDATE audit_log SET detail=$1::jsonb WHERE id=$2`,
      [JSON.stringify({ ...stats, sent: true, admins: admins.length }), claimId]).catch(() => {});
    return true;
  } catch (e) { console.warn('[sync-review] digest skipped:', e.message); return false; }
}

module.exports = { queueReview, notifyLoanOfficer, closeStaleReviews, lastFieldEditor, remindStaleReviewsOnce, sendReviewDigestOnce, digestMessage, digestReasonLabel, FIELD_LABELS, sharepointDocEmail };
