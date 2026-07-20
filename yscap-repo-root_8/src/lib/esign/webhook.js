/**
 * esign/webhook.js — the inbound Connect drainer.
 *
 * The webhook receiver (src/routes/esign-webhook.js) only verifies the HMAC and
 * records the event in docusign_event_inbox. This drainer does the real work,
 * asynchronously, and — critically — NEVER trusts the event payload as state: it
 * re-fetches the truth from DocuSign (Envelopes:get with include=recipients) and
 * reconciles our rows to it. That makes duplicate / out-of-order / replayed
 * deliveries harmless (the current truth is idempotent).
 *
 * On envelope completion it downloads each signed PDF by its NUMERIC documentId
 * (from esign_envelope_docs — never by name), stores it under the signed doc_kind
 * against the condition it clears, downloads the Certificate of Completion, and
 * moves each mapped condition to 'received' (the conservative default: signed +
 * provided, a processor still signs off — docs/DOCUSIGN-DOCUMENT-BUILD-SPEC §8.4).
 *
 * Dependency-injected (db / docusign / storage) so it is unit-testable without a
 * live account.
 */
const dbDefault = require('../../db');
const docusignDefault = require('../integrations/docusign');
const storageDefault = require('../storage');

let enqueueChecklistStatusPush = () => Promise.resolve();
try { ({ enqueueChecklistStatusPush } = require('../../clickup/enqueue')); } catch (_) { /* optional */ }

const MAX_INBOX_ATTEMPTS = 20;

// DocuSign envelope status → our esign_envelopes.status enum + its timestamp col.
const ENV_STATUS = {
  sent:      { status: 'sent',      col: 'sent_at' },
  delivered: { status: 'delivered', col: 'delivered_at' },
  completed: { status: 'completed', col: 'completed_at' },
  declined:  { status: 'declined',  col: 'declined_at' },
  voided:    { status: 'voided',    col: 'voided_at' },
};

// Our esign_recipients.status enum: created|sent|delivered|signed|declined|completed|autoresponded.
function recipientStatus(r) {
  if (r.declined) return 'declined';
  if (r.signed) return 'completed';
  const s = String(r.status || '').toLowerCase();
  if (['created', 'sent', 'delivered', 'autoresponded'].includes(s)) return s;
  return 'sent';
}

// ---- store a signed document via the standard documents chokepoint ----------
async function storeSignedDocument(db, storage, { applicationId, borrowerId, checklistItemId, docKind, filename, bytes, visibility }) {
  // Idempotent: the filename is deterministic (<kind>_<envelopeId>.pdf), so if a
  // prior pass (e.g. one that crashed after the INSERT but before stamping
  // completed_document_id) already stored it, reuse that row rather than writing
  // a duplicate. Also covers a concurrent drain (L2).
  // application_id IS NOT DISTINCT FROM $1 so an app-less TEST envelope (application_id
  // NULL) dedupes correctly too — `= NULL` is never true and would re-store on retry.
  const existing = await db.query(
    `SELECT id FROM documents WHERE application_id IS NOT DISTINCT FROM $1 AND doc_kind=$2 AND filename=$3 LIMIT 1`,
    [applicationId, docKind, filename]);
  if (existing.rows.length) return existing.rows[0].id;
  const { ref, provider } = await storage.save(Buffer.from(bytes), { filename });
  // uploaded_by_kind is CHECK IN ('borrower','staff') — a system fill uses
  // 'staff' + source_type='system' (exactly like tpr-export / track-record
  // snapshots); 'system' would violate the constraint.
  try {
    const ins = await db.query(
      `INSERT INTO documents
         (application_id, borrower_id, checklist_item_id, filename, content_type, size_bytes,
          storage_provider, storage_ref, uploaded_by_kind, uploaded_by_id, doc_kind,
          source_type, visibility, is_current, review_status)
       VALUES ($1,$2,$3,$4,'application/pdf',$5,$6,$7,'staff',NULL,$8,'system',$9,true,'pending')
       RETURNING id`,
      [applicationId, borrowerId || null, checklistItemId || null, filename, Buffer.from(bytes).length, provider, ref, docKind, visibility || 'borrower']);
    // Supersede any PRIOR current copy of the same signed kind on this file. A
    // re-issue signs a NEW envelope → a new deterministic filename → a fresh
    // documents row; without this the old signed copy stays is_current=true and
    // BOTH would ride into the TPR note-buyer package and the SharePoint mirror
    // (mirrors tpr-export's supersede). Latest signed copy wins. ONLY for a real
    // file — an app-less TEST doc (application_id NULL) must not supersede OTHER
    // tests' docs of the same kind (each self-test stands alone; its filename is
    // already unique per envelope).
    if (applicationId) {
      await db.query(
        `UPDATE documents SET is_current=false,
            review_status=CASE WHEN review_status IN ('pending','rejected') THEN 'superseded' ELSE review_status END
          WHERE application_id=$1 AND doc_kind=$2 AND id<>$3 AND is_current=true`,
        [applicationId, docKind, ins.rows[0].id]);
    } else {
      // App-less self-test doc: there is no loan file / borrower to file it under, so
      // the SharePoint mirror can NEVER place it (scopeKeyFor → null). Settle it OUT of
      // the mirror's pending population at birth (stamp backed_up_at + a skip reason) —
      // otherwise it sits sharepoint_backed_up_at IS NULL forever and trips a permanent
      // backlog / health-SLO alert. Mirrors the Heter-Iska skip precedent in
      // lib/sharepoint-backup.js. (Test docs are staff-only and never TPR/SharePoint.)
      await db.query(
        `UPDATE documents SET sharepoint_backed_up_at = now(),
            sharepoint_skipped_reason = 'e-sign self-test — no loan file to mirror under'
          WHERE id = $1`, [ins.rows[0].id]);
    }
    return ins.rows[0].id;
  } catch (e) {
    // A concurrent drain (poller tick + manual /esign/drain interleaving at an
    // await) can pass the existence check and both INSERT — the uq_documents_
    // esign_signed partial index (db/142) rejects the loser; reuse the winner.
    if (e && e.code === '23505') {
      const again = await db.query(
        `SELECT id FROM documents WHERE application_id IS NOT DISTINCT FROM $1 AND doc_kind=$2 AND filename=$3 LIMIT 1`,
        [applicationId, docKind, filename]);
      if (again.rows.length) return again.rows[0].id;
    }
    throw e;
  }
}

// ---- update the recipient roster from fetched truth -------------------------
async function applyRecipients(db, envelopeRowId, envelope) {
  const parsed = docusignDefault.parseRecipients(envelope);
  for (const r of parsed) {
    await db.query(
      `UPDATE esign_recipients
          SET status = $3,
              sent_at      = COALESCE($4, sent_at),
              delivered_at = COALESCE($5, delivered_at),
              signed_at    = COALESCE($6, signed_at),
              declined_at  = COALESCE($7, declined_at),
              decline_reason = COALESCE($8, decline_reason),
              last_event_at = now(), updated_at = now()
        WHERE envelope_row_id = $1 AND recipient_id_ds = $2`,
      [envelopeRowId, String(r.recipientId), recipientStatus(r),
       r.sentAt, r.deliveredAt, r.signedAt, r.declinedAt, r.declineReason]);
  }
}

// ---- on completion: download + store signed docs, clear conditions ----------
async function handleCompletion(db, docusign, storage, envelopeRow) {
  const envelopeId = envelopeRow.envelope_id;
  const appId = envelopeRow.application_id;   // NULL for an app-less TEST envelope
  // We store the signed PDFs + the Certificate of Completion for BOTH a real file
  // AND an app-less admin self-test. For a real file the signed copies are the
  // borrower's own documents (stamp borrower_id so they show in the borrower's library
  // and file into the condition); a TEST envelope has no borrower/condition, so its
  // copies are stored STAFF-ONLY with no condition — but they DO appear in the cockpit
  // so the self-test proves the full "signed → PDF + certificate come back" chain.
  // A TEST envelope never touches SharePoint/TPR (both are scoped by application_id).
  const bId = appId
    ? ((await db.query(`SELECT borrower_id FROM applications WHERE id=$1`, [appId])).rows[0] || {}).borrower_id || null
    : null;
  const docVisibility = appId ? 'borrower' : 'staff_only';

  const docs = (await db.query(
    `SELECT id, document_id, doc_kind, checklist_item_id, completed_document_id
       FROM esign_envelope_docs WHERE envelope_row_id = $1 ORDER BY document_id`, [envelopeRow.id])).rows;

  for (const d of docs) {
    if (d.completed_document_id) continue;   // idempotent — already stored
    const bytes = await docusign.getDocument(envelopeId, d.document_id);
    const filename = `${d.doc_kind}_${envelopeId}.pdf`;
    const storedId = await storeSignedDocument(db, storage, {
      applicationId: appId,
      borrowerId: bId,
      checklistItemId: appId ? d.checklist_item_id : null,   // no condition on a test
      docKind: d.doc_kind,
      filename, bytes, visibility: docVisibility,
    });
    await db.query(
      `UPDATE esign_envelope_docs SET completed_document_id = $2, cleared_at = now() WHERE id = $1`,
      [d.id, storedId]);
    // Conservative clear: signed + provided → 'received' (a processor signs off).
    // Never downgrade a condition already satisfied/waived by a human. Real files only.
    if (appId && d.checklist_item_id) {
      await db.query(
        `UPDATE checklist_items SET status='received', updated_at=now()
          WHERE id=$1 AND status NOT IN ('satisfied','waived')`, [d.checklist_item_id]);
      enqueueChecklistStatusPush(d.checklist_item_id).catch(() => {});
    }
  }

  // Certificate of Completion (once per envelope; staff-only, never TPR/SharePoint) —
  // for a real file AND a self-test. IS NOT DISTINCT FROM so the app-less (NULL) case
  // dedupes too.
  const certName = `esign_certificate_${envelopeId}.pdf`;
  const exists = await db.query(
    `SELECT 1 FROM documents WHERE application_id IS NOT DISTINCT FROM $1 AND doc_kind='esign_certificate' AND filename=$2 LIMIT 1`,
    [appId, certName]);
  if (!exists.rows.length) {
    try {
      const cert = await docusign.getCertificate(envelopeId);
      await storeSignedDocument(db, storage, {
        applicationId: appId, checklistItemId: null,
        docKind: 'esign_certificate', filename: certName, bytes: cert, visibility: 'staff_only',
      });
    } catch (e) {
      console.warn(`[esign-webhook] certificate download failed for ${envelopeId}: ${e.message}`);
      // Non-fatal: the signed documents are already stored + conditions cleared.
    }
  }
}

// ---- reconcile ONE tracked envelope to DocuSign truth -----------------------
async function reconcileEnvelope(db, docusign, storage, envelopeRow) {
  const envelope = await docusign.getEnvelope(envelopeRow.envelope_id, { include: 'recipients' });
  const status = String((envelope && envelope.status) || '').toLowerCase();
  const map = ENV_STATUS[status];

  await applyRecipients(db, envelopeRow.id, envelope);

  // On completion, STORE THE SIGNED DOCS FIRST and only then stamp 'completed'.
  // If a signed-PDF download fails, handleCompletion throws BEFORE the status
  // advances — so the envelope stays 'sent'/'delivered' and both the inbox retry
  // and reconcileStale (which cover those states) re-drive it to completion when
  // DocuSign recovers. Otherwise a completion whose download failed would show a
  // green "completed" with missing signed docs + uncleared conditions that nothing
  // ever re-drives (handleCompletion is per-doc idempotent, so re-running is safe).
  if (status === 'completed') {
    await handleCompletion(db, docusign, storage, envelopeRow);
  }

  const terminal = map && ['completed', 'declined', 'voided'].includes(map.status);
  if (terminal) {
    // Terminal transition. Stamp the terminal timestamp ONLY if it's still NULL, so
    // exactly ONE reconcile wins the first transition (RETURNING a row) and fires the
    // alert — a concurrent poll tick + inbox drain can't double-notify. A
    // staff-initiated void already set voided_at locally, so this correctly matches
    // 0 rows and stays silent (the staff already know).
    const voidReason = status === 'voided' ? (envelope.voidedReason || null) : null;
    const won = await db.query(
      `UPDATE esign_envelopes
          SET status = $2, ${map.col} = now(), void_reason = COALESCE($3, void_reason),
              last_event_at = now(), updated_at = now()
        WHERE id = $1 AND ${map.col} IS NULL
        RETURNING id`, [envelopeRow.id, map.status, voidReason]);
    if (!won.rows.length) {
      // Already stamped by an earlier pass — keep status/last_event_at fresh, no alert.
      await db.query(
        `UPDATE esign_envelopes SET status = $2, last_event_at = now(), updated_at = now() WHERE id = $1`,
        [envelopeRow.id, map.status]);
    } else if (envelopeRow.application_id) {
      // A decline / expiry / cancellation (or completion) otherwise updates SILENTLY
      // and the deal stalls unseen. Alert the file's team. App-less test envelopes
      // have no team. Best-effort — a notify failure must never break reconcile.
      try { await notifyTerminal(db, envelopeRow, map.status, voidReason); }
      catch (e) { console.warn(`[esign] terminal notify failed for ${envelopeRow.id}: ${e.message}`); }
    }
  } else if (map) {
    // Non-terminal mapped status (sent/delivered) — refresh + advance the aging clock.
    await db.query(
      `UPDATE esign_envelopes
          SET status = $2, ${map.col} = COALESCE(${map.col}, now()), last_event_at = now(), updated_at = now()
        WHERE id = $1`, [envelopeRow.id, map.status]);
    // MILESTONE: the borrower(s) finished signing but the lender still needs to
    // counter-sign. The envelope stays 'sent' at DocuSign through this whole window,
    // so without this the file's team never learns the deal is now waiting on THEM
    // (owner-directed 2026-07-20). Fire exactly once (countersign_notified_at guard).
    try { await maybeNotifyCountersign(db, envelopeRow); }
    catch (e) { console.warn(`[esign] countersign notify failed for ${envelopeRow.id}: ${e.message}`); }
  } else if (status) {
    // Unrecognized DocuSign status (e.g. 'timedout', 'authoritativecopy'). Don't
    // silently ignore it — that would leave last_event_at stale and hot-loop the
    // poller (re-fetching this envelope every tick forever). Advance last_event_at
    // so the STALE belt paces it, and log so a new status surfaces rather than hides.
    await db.query(`UPDATE esign_envelopes SET last_event_at = now(), updated_at = now() WHERE id = $1`, [envelopeRow.id]);
    console.warn(`[esign] envelope ${envelopeRow.id}: unrecognized DocuSign status '${status}' — awaiting a mapped status`);
  }
  return status;
}

const PURPOSE_LABEL = { term_sheet_package: 'term-sheet package', heter_iska: 'Heter Iska' };

/** Alert the file's team on the FIRST terminal transition of a real envelope. */
async function notifyTerminal(db, envelopeRow, status, voidReason) {
  const notify = require('../notify');
  const cfg = require('../../config');
  const label = PURPOSE_LABEL[envelopeRow.purpose] || 'e-signature package';
  let title, body;
  if (status === 'declined') {
    title = `Borrower declined to sign — ${label}`;
    body = `The borrower declined to sign the ${label}${voidReason ? ` (reason: ${voidReason})` : ''}. Open the file's e-signature section to follow up or re-issue.`;
  } else if (status === 'voided') {
    title = `E-signature cancelled/expired — ${label}`;
    body = `The ${label} is no longer active${voidReason ? ` (${voidReason})` : ''} and nothing was signed. Open the file to re-issue it if the borrower still needs to sign.`;
  } else { // completed
    title = `Fully signed — ${label}`;
    body = envelopeRow.countersign_required
      // A counter-signed package completes only AFTER the lender's admin counter-signs.
      ? `The ${label} is fully executed — the borrower and the lender have both signed. The signed copies + Certificate of Completion are now on the file.`
      : `The borrower completed signing the ${label}. The signed copy + Certificate of Completion are now on the file.`;
  }
  const badge = status === 'completed' ? { text: 'Fully signed', tone: 'positive' }
    : status === 'declined' ? { text: 'Declined', tone: 'action' }
    : { text: 'Cancelled', tone: 'neutral' };
  const opts = {
    type: 'status_change', title, body, badge, applicationId: envelopeRow.application_id,
    link: `${cfg.appUrl || ''}${cfg.portalPath}/#/internal/app/${envelopeRow.application_id}`,
  };
  const sent = await notify.notifyAppStaff(envelopeRow.application_id, opts);
  if (!sent || !sent.length) await notify.notifyAdmins(opts);   // unassigned file → admins
}

/**
 * MILESTONE notify: the borrower(s) finished signing (routing order 1) but the lender's
 * admin counter-signature (routing order 2) is still outstanding. DocuSign keeps the
 * envelope 'sent' through this whole window, so nothing else surfaces "now waiting on
 * US" to the file's team. Fired at most ONCE per envelope (countersign_notified_at),
 * and only for a counter-signed package on a real file that hasn't gone terminal.
 */
async function maybeNotifyCountersign(db, envelopeRow) {
  if (!envelopeRow.countersign_required || !envelopeRow.application_id) return;
  const recs = (await db.query(
    `SELECT routing_order, signed_at, declined_at, status FROM esign_recipients WHERE envelope_row_id = $1`,
    [envelopeRow.id])).rows;
  const isSigned = (r) => !!(r.signed_at || r.status === 'completed' || r.status === 'signed');
  const isDeclined = (r) => !!(r.declined_at || r.status === 'declined');
  const order1 = recs.filter((r) => Number(r.routing_order) === 1);
  const order1Done = order1.length > 0 && order1.every(isSigned);
  const adminPending = recs.some((r) => Number(r.routing_order) >= 2 && !isSigned(r) && !isDeclined(r));
  if (!(order1Done && adminPending)) return;
  // Fire exactly once — the poller re-reads this envelope every ~60s while it waits.
  const won = await db.query(
    `UPDATE esign_envelopes SET countersign_notified_at = now()
      WHERE id = $1 AND countersign_notified_at IS NULL RETURNING id`, [envelopeRow.id]);
  if (!won.rows.length) return;
  const notify = require('../notify');
  const cfg = require('../../config');
  const label = PURPOSE_LABEL[envelopeRow.purpose] || 'e-signature package';
  const opts = {
    type: 'status_change',
    title: `Borrower signed — counter-signature needed on the ${label}`,
    badge: { text: 'Counter-sign needed', tone: 'gold' },
    body: `The borrower has signed the ${label}. It now needs the lender's counter-signature to finish. The signer has been emailed the counter-signing link; open the file's e-signature section to counter-sign.`,
    applicationId: envelopeRow.application_id,
    link: `${cfg.appUrl || ''}${cfg.portalPath}/#/internal/app/${envelopeRow.application_id}`,
  };
  const sent = await notify.notifyAppStaff(envelopeRow.application_id, opts);
  if (!sent || !sent.length) await notify.notifyAdmins(opts);   // unassigned file → admins
}

// ---- inbox drainer ----------------------------------------------------------
async function processInboxRow(db, docusign, storage, row) {
  // Find the tracked envelope. An event for an envelope we don't own (or before
  // our envelope_id is written) is a benign no-op — mark processed.
  if (!row.envelope_id) return { skipped: 'no-envelope-id' };
  const env = (await db.query(
    `SELECT * FROM esign_envelopes WHERE envelope_id = $1 LIMIT 1`, [row.envelope_id])).rows[0];
  if (!env) return { skipped: 'untracked' };
  const status = await reconcileEnvelope(db, docusign, storage, env);
  return { reconciled: status };
}

/** Drain unprocessed inbox events. Serial, bounded, self-healing on error. */
async function drainInbox(opts = {}) {
  const db = opts.db || dbDefault;
  const docusign = opts.docusign || docusignDefault;
  const storage = opts.storage || storageDefault;
  const limit = opts.limit || 50;

  const due = await db.query(
    `SELECT * FROM docusign_event_inbox
      WHERE processed_at IS NULL AND attempts < $2
      ORDER BY received_at LIMIT $1`, [limit, MAX_INBOX_ATTEMPTS]);
  const results = [];
  for (const row of due.rows) {
    try {
      const r = await processInboxRow(db, docusign, storage, row);
      await db.query(`UPDATE docusign_event_inbox SET processed_at = now(), process_error = NULL WHERE id = $1`, [row.id]);
      results.push({ id: row.id, ...r });
    } catch (e) {
      const msg = ((e && e.message) || String(e)).slice(0, 500);
      await db.query(
        `UPDATE docusign_event_inbox SET attempts = attempts + 1, process_error = $2 WHERE id = $1`, [row.id, msg]);
      results.push({ id: row.id, error: msg });
    }
  }
  return results;
}

module.exports = {
  drainInbox, processInboxRow, reconcileEnvelope, handleCompletion, applyRecipients,
  storeSignedDocument, recipientStatus,
};
