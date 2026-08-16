'use strict';
/**
 * Trinity PUBLIC webhook receiver.
 *
 * Trinity webhooks carry NO signature and NO shared secret — their own documentation
 * describes them as notifications that "only provide the IDs, event type, and a short
 * description". So this endpoint is designed on the assumption that ANYONE can call it:
 *
 *   1. It authenticates on a SECRET PATH TOKEN we choose (`/api/public/trinity-webhook/:token`,
 *      compared as sha256 digests in constant time) and fails CLOSED when unconfigured.
 *   2. It BELIEVES NOTHING in the body. The delivery is stored as a nudge; the poller
 *      then resolves the order it names and re-reads every fact from the authenticated
 *      API. The worst a forged delivery can achieve is making us look at one of our own
 *      orders slightly early.
 *   3. It answers 2xx fast and processes out of band, so a slow drain can never make
 *      Trinity think the endpoint is down.
 *
 * Mounted BEFORE the global JSON parser with its own small one (these payloads are tiny)
 * and its own rate-limit bucket — the same discipline as the TrustPoint receiver.
 */

const crypto = require('crypto');
const express = require('express');
const router = require('../lib/safe-router')();
const F = require('../lib/fields');
const db = require('../db');
const cfg = require('../config');
const { rateLimit } = require('../lib/rate-limit');

router.use(rateLimit({ bucket: 'trinity-webhook', windowMs: 60000, max: 240 }));
router.use(express.json({ limit: '512kb' }));

function tokenOk(given) {
  const expect = cfg.trinity && cfg.trinity.webhookToken;
  if (!expect) return false;                       // fail CLOSED: unconfigured = receiver off
  if (!given) return false;
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expect)).digest();
  return crypto.timingSafeEqual(a, b);
}

async function receive(req, res) {
  try {
    if (!tokenOk(req.params.token)) return res.status(401).json({ error: 'unauthorized' });
    const p = req.body || {};
    const event = String(p.eventType || p.event || '').replace(/\s+/g, '').slice(0, 64) || 'Unknown';
    const orderId = p.orderId != null ? Number(p.orderId) : null;
    const projectId = p.projectId != null ? Number(p.projectId) : null;

    let payload = F.jsonbText(p);
    // NEVER slice a JSON string — an invalid fragment fails the ::jsonb cast and 500s
    // the receive, which some senders treat as "endpoint down, stop delivering".
    if (payload.length > 60000) payload = F.jsonbText({ truncated: true, eventType: event, orderId, projectId });

    // Dedupe within a UTC day: a retried delivery collapses, while a genuinely identical
    // event weeks later is not swallowed forever.
    const day = new Date().toISOString().slice(0, 10);
    const hash = crypto.createHash('sha256').update(`${event}|${day}|${payload}`).digest('hex');

    await db.query(
      `INSERT INTO trinity_webhook_events (event, trinity_order_id, trinity_project_id, payload, payload_hash)
       VALUES ($1,$2,$3,$4::jsonb,$5)
       ON CONFLICT (event, payload_hash) DO NOTHING`,
      [event, Number.isFinite(orderId) ? orderId : null, Number.isFinite(projectId) ? projectId : null, payload, hash]);

    // 2xx first, work afterwards.
    res.json({ ok: true });

    // A prompt drain only while the integration is on; the 30s poller drain is the
    // backstop, and deliveries received while it is off are stored and drain later.
    try {
      const client = require('../trinity/client');
      if (client.enabled() && client.available()) {
        setImmediate(() => {
          require('../trinity/poller').drainWebhooksOnce(10)
            .catch((e) => console.warn('[trinity] prompt drain:', e && e.message));
        });
      }
    } catch (_) { /* the drain is best-effort; the poller will get it */ }
  } catch (e) {
    console.warn('[trinity] webhook receive failed:', e && e.message);
    if (!res.headersSent) res.status(200).json({ ok: true });   // never invite a retry storm
  }
}

router.post('/:token', receive);

module.exports = router;
