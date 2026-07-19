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
const webhook = require('./webhook');
const send = require('./send');

const POLL_SEC = parseInt(process.env.DOCUSIGN_POLL_SEC || '60', 10);
const STALE_MIN = parseInt(process.env.DOCUSIGN_RECONCILE_STALE_MIN || '30', 10);

let timer = null;

/** Re-fetch truth for in-flight envelopes gone quiet — recovers missed webhooks. */
async function reconcileStale(opts = {}) {
  const db = opts.db || dbDefault;
  const rows = (await db.query(
    `SELECT * FROM esign_envelopes
      WHERE envelope_id IS NOT NULL
        AND status IN ('sent','delivered')
        AND (last_event_at IS NULL OR last_event_at < now() - ($1 || ' minutes')::interval)
      ORDER BY COALESCE(last_event_at, sent_at) NULLS FIRST
      LIMIT 25`, [String(STALE_MIN)])).rows;
  const out = [];
  for (const row of rows) {
    try { out.push({ id: row.id, status: await webhook.reconcileEnvelope(db, docusign, opts.storage || require('../storage'), row) }); }
    catch (e) { out.push({ id: row.id, error: e.message }); }
  }
  return out;
}

async function tick() {
  try { await webhook.drainInbox({}); } catch (e) { console.warn('[esign-poll] inbox drain failed:', e.message); }
  try { await send.drainDue({}); } catch (e) { console.warn('[esign-poll] send drain failed:', e.message); }
  try { await reconcileStale({}); } catch (e) { console.warn('[esign-poll] reconcile failed:', e.message); }
}

function start() {
  if (!docusign.configured || !docusign.configured()) {
    console.log('[esign-poll] DocuSign not configured — poller inert.');
    return;
  }
  if (timer) return;
  // First tick shortly after boot, then on the interval.
  setTimeout(() => { tick().catch(() => {}); }, 8000);
  timer = setInterval(() => { tick().catch(() => {}); }, POLL_SEC * 1000);
  if (timer.unref) timer.unref();
  console.log(`[esign-poll] started (every ${POLL_SEC}s; reconcile stale > ${STALE_MIN}m)`);
}

function stop() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { start, stop, tick, reconcileStale };
