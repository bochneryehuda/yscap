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
async function storeSignedDocument(db, storage, { applicationId, checklistItemId, docKind, filename, bytes, visibility }) {
  // Idempotent: the filename is deterministic (<kind>_<envelopeId>.pdf), so if a
  // prior pass (e.g. one that crashed after the INSERT but before stamping
  // completed_document_id) already stored it, reuse that row rather than writing
  // a duplicate. Also covers a concurrent drain (L2).
  const existing = await db.query(
    `SELECT id FROM documents WHERE application_id=$1 AND doc_kind=$2 AND filename=$3 LIMIT 1`,
    [applicationId, docKind, filename]);
  if (existing.rows.length) return existing.rows[0].id;
  const { ref, provider } = await storage.save(Buffer.from(bytes), { filename });
  // uploaded_by_kind is CHECK IN ('borrower','staff') — a system fill uses
  // 'staff' + source_type='system' (exactly like tpr-export / track-record
  // snapshots); 'system' would violate the constraint.
  try {
    const ins = await db.query(
      `INSERT INTO documents
         (application_id, checklist_item_id, filename, content_type, size_bytes,
          storage_provider, storage_ref, uploaded_by_kind, uploaded_by_id, doc_kind,
          source_type, visibility, is_current, review_status)
       VALUES ($1,$2,$3,'application/pdf',$4,$5,$6,'staff',NULL,$7,'system',$8,true,'pending')
       RETURNING id`,
      [applicationId, checklistItemId || null, filename, Buffer.from(bytes).length, provider, ref, docKind, visibility || 'borrower']);
    // Supersede any PRIOR current copy of the same signed kind on this file. A
    // re-issue signs a NEW envelope → a new deterministic filename → a fresh
    // documents row; without this the old signed copy stays is_current=true and
    // BOTH would ride into the TPR note-buyer package and the SharePoint mirror
    // (mirrors tpr-export's supersede). Latest signed copy wins.
    await db.query(
      `UPDATE documents SET is_current=false,
          review_status=CASE WHEN review_status IN ('pending','rejected') THEN 'superseded' ELSE review_status END
        WHERE application_id=$1 AND doc_kind=$2 AND id<>$3 AND is_current=true`,
      [applicationId, docKind, ins.rows[0].id]);
    return ins.rows[0].id;
  } catch (e) {
    // A concurrent drain (poller tick + manual /esign/drain interleaving at an
    // await) can pass the existence check and both INSERT — the uq_documents_
    // esign_signed partial index (db/142) rejects the loser; reuse the winner.
    if (e && e.code === '23505') {
      const again = await db.query(
        `SELECT id FROM documents WHERE application_id=$1 AND doc_kind=$2 AND filename=$3 LIMIT 1`,
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
  // App-less TEST envelope: there is no loan file to store signed documents against
  // and no condition to clear — just mark its docs settled so the cockpit shows it
  // complete. Never touches real-file storage / SharePoint / the Certificate table.
  if (!envelopeRow.application_id) {
    await db.query(
      `UPDATE esign_envelope_docs SET cleared_at = COALESCE(cleared_at, now()) WHERE envelope_row_id = $1`,
      [envelopeRow.id]);
    return;
  }
  const docs = (await db.query(
    `SELECT id, document_id, doc_kind, checklist_item_id, completed_document_id
       FROM esign_envelope_docs WHERE envelope_row_id = $1 ORDER BY document_id`, [envelopeRow.id])).rows;

  for (const d of docs) {
    if (d.completed_document_id) continue;   // idempotent — already stored
    const bytes = await docusign.getDocument(envelopeId, d.document_id);
    const filename = `${d.doc_kind}_${envelopeId}.pdf`;
    const storedId = await storeSignedDocument(db, storage, {
      applicationId: envelopeRow.application_id,
      checklistItemId: d.checklist_item_id,
      docKind: d.doc_kind,
      filename, bytes, visibility: 'borrower',
    });
    await db.query(
      `UPDATE esign_envelope_docs SET completed_document_id = $2, cleared_at = now() WHERE id = $1`,
      [d.id, storedId]);
    // Conservative clear: signed + provided → 'received' (a processor signs off).
    // Never downgrade a condition already satisfied/waived by a human.
    if (d.checklist_item_id) {
      await db.query(
        `UPDATE checklist_items SET status='received', updated_at=now()
          WHERE id=$1 AND status NOT IN ('satisfied','waived')`, [d.checklist_item_id]);
      enqueueChecklistStatusPush(d.checklist_item_id).catch(() => {});
    }
  }

  // Certificate of Completion (once per envelope; staff-only, never TPR/SharePoint).
  const certName = `esign_certificate_${envelopeId}.pdf`;
  const exists = await db.query(
    `SELECT 1 FROM documents WHERE application_id=$1 AND doc_kind='esign_certificate' AND filename=$2 LIMIT 1`,
    [envelopeRow.application_id, certName]);
  if (!exists.rows.length) {
    try {
      const cert = await docusign.getCertificate(envelopeId);
      await storeSignedDocument(db, storage, {
        applicationId: envelopeRow.application_id, checklistItemId: null,
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
    title = `Documents signed — ${label}`;
    body = `The borrower completed signing the ${label}. The signed copies are now on the file.`;
  }
  const opts = {
    type: 'status_change', title, body, applicationId: envelopeRow.application_id,
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
