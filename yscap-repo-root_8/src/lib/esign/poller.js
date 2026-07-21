/**
 * esign/poller.js — the background heartbeat for the DocuSign integration.
 *
 * Three cheap jobs on one interval, all self-gating so this is inert until
 * DocuSign is actually configured:
 *   1. drainInbox()  — process any Connect events the webhook recorded.
 *   2. drainDue()    — retry any send that failed transiently (the synchronous
 *                      send path is the norm; this is the durable backstop).
 *   3. reconcileStale() — re-fetch the truth for any in-flight envelope we
 *      haven't heard about in a while. This is the belt-and-suspenders for a
 *      MISSED webhook (Connect down, our endpoint briefly 500ing): status still
 *      converges even if an event never arrives.
 *
 * Started from server boot like the other pollers; a no-op when DocuSign creds
 * are absent, so it is always safe to wire.
 */
const dbDefault = require('../../db');
const docusign = require('../integrations/docusign');
const storageDefault = require('../storage');
const webhook = require('./webhook');
const send = require('./send');
const orchestrate = require('./orchestrate');
const gate = require('./gate');
const onDeadLetter = require('./dead-letter');
const cfg = require('../../config').docusign;

const POLL_SEC = parseInt(process.env.DOCUSIGN_POLL_SEC || '60', 10);
const STALE_MIN = parseInt(process.env.DOCUSIGN_RECONCILE_STALE_MIN || '30', 10);
// A freshly-sent, not-yet-finished envelope is ACTIVELY being signed — reconcile it
// EVERY tick (not just after STALE_MIN of quiet) so a signature is reflected within
// one poll cycle even if the real-time Connect webhook isn't delivering/verifying.
// After this window it falls back to the STALE_MIN missed-webhook belt.
const ACTIVE_MIN = parseInt(process.env.DOCUSIGN_ACTIVE_RECONCILE_MIN || '180', 10);

let timer = null;

/**
 * The durable send-retry backstop. drainDue needs the SAME envelope-assembly
 * callback the synchronous send uses (orchestrate.buildDefinition) — without it
 * every retry throws "requires a buildDefinition" and silently does nothing. We
 * ALSO re-check the send-gate here: if the file's gate reopened (e.g. the deal
 * economics changed) between claim and retry, we must NOT mail the stale envelope
 * — fail permanent so it dead-letters (visible to a human) and a re-registered
 * deal sends a fresh one.
 */
async function retrySend(opts = {}) {
  // Honor the master kill-switch here too (belt-and-suspenders — sendClaimedEnvelope
  // also refuses): when sending is paused, don't even claim/drain the send queue.
  // Reconcile of already-sent envelopes still runs (tracking must not stop). Tests
  // toggle the config singleton, so read it live rather than caching a boolean.
  if (!require('../integrations/switches').on('DOCUSIGN_SEND_ENABLED')) return { paused: true };
  const db = opts.db || dbDefault;
  const storage = opts.storage || storageDefault;
  const ds = opts.docusign || docusign;
  return send.drainDue({
    db, docusign: ds, onDeadLetter,
    buildDefinition: async (row) => {
      const g = await gate.esignSendGate(row.application_id, { db });
      if (!g.ready) {
        const e = new Error(`Send cancelled — file no longer ready to send: ${g.outstanding.map((o) => o.label).join('; ')}`);
        e.retryable = false;   // permanent → dead-letter (a changed deal re-sends fresh)
        throw e;
      }
      return orchestrate.buildDefinition(row, { db, storage });
    },
  });
}

/** Re-fetch truth for in-flight envelopes gone quiet — recovers missed webhooks. */
async function reconcileStale(opts = {}) {
  const db = opts.db || dbDefault;
  const rows = (await db.query(
    `SELECT * FROM esign_envelopes
      WHERE envelope_id IS NOT NULL
        AND status IN ('sent','delivered')
        AND (sent_at > now() - ($2 || ' minutes')::interval    -- fresh: reconcile every tick
             OR last_event_at IS NULL
             OR last_event_at < now() - ($1 || ' minutes')::interval)
      ORDER BY COALESCE(last_event_at, sent_at) NULLS FIRST
      LIMIT 25`, [String(STALE_MIN), String(ACTIVE_MIN)])).rows;
  const out = [];
  for (const row of rows) {
    try { out.push({ id: row.id, status: await webhook.reconcileEnvelope(db, docusign, opts.storage || require('../storage'), row) }); }
    catch (e) { out.push({ id: row.id, error: e.message }); }
  }
  // Completion-artifact backfill: a transient download failure at completion time is
  // otherwise never retried (the scan above only covers sent/delivered). Re-drive a
  // completed REAL envelope that is missing EITHER the Certificate of Completion OR
  // any signed document (an esign_envelope_docs row with no completed_document_id).
  // handleCompletion is per-doc idempotent — it only re-fetches what's still missing.
  // (Under the current ordering a missing signed doc keeps the envelope out of
  // 'completed', so this mainly guards legacy rows / any future path that could stamp
  // completed early — belt-and-suspenders so a signed copy can never be left behind.)
  const incomplete = (await db.query(
    `SELECT e.* FROM esign_envelopes e
      WHERE e.status = 'completed' AND e.application_id IS NOT NULL AND e.envelope_id IS NOT NULL
        AND (NOT EXISTS (
              SELECT 1 FROM documents d
               WHERE d.application_id = e.application_id
                 AND d.doc_kind = 'esign_certificate'
                 AND d.filename = 'esign_certificate_' || e.envelope_id || '.pdf')
          OR EXISTS (
              SELECT 1 FROM esign_envelope_docs ed
               WHERE ed.envelope_row_id = e.id AND ed.completed_document_id IS NULL))
      ORDER BY e.completed_at NULLS FIRST
      LIMIT 10`)).rows;
  for (const row of incomplete) {
    try { await webhook.handleCompletion(db, docusign, opts.storage || require('../storage'), row); out.push({ id: row.id, backfill: 'redriven' }); }
    catch (e) { await webhook.noteCompletionFailure(db, row, e); out.push({ id: row.id, backfillError: e.message }); }
  }
  return out;
}

async function tick() {
  try { await webhook.drainInbox({}); } catch (e) { console.warn('[esign-poll] inbox drain failed:', e.message); }
  try { await retrySend({}); } catch (e) { console.warn('[esign-poll] send retry failed:', e.message); }
  try { await reconcileStale({}); } catch (e) { console.warn('[esign-poll] reconcile failed:', e.message); }
}

function start() {
  if (!docusign.configured || !docusign.configured()) {
    console.log('[esign-poll] DocuSign not configured — poller inert.');
    return;
  }
  if (timer) return;
  // First tick shortly after boot, then on the interval. Both handles unref'd so
  // a short-lived process is never kept alive waiting on the e-sign heartbeat.
  const boot = setTimeout(() => { tick().catch(() => {}); }, 8000);
  if (boot.unref) boot.unref();
  timer = setInterval(() => { tick().catch(() => {}); }, POLL_SEC * 1000);
  if (timer.unref) timer.unref();
  console.log(`[esign-poll] started (every ${POLL_SEC}s; reconcile stale > ${STALE_MIN}m)`);
}

function stop() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { start, stop, tick, reconcileStale, retrySend };
