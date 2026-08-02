'use strict';
/**
 * TrustPoint PUBLIC webhook receiver (phase 2; hardened per the phase-2 audit).
 * Mounted in server.js BEFORE the global 32MB JSON parser with its OWN small parser
 * (webhook payloads are tiny) + an IP rate-limit bucket, mirroring the ClickUp/DocuSign
 * webhook discipline. Auth = the shared token PILOT issued at registration — compared
 * as sha256 digests (constant-time, length-oblivious), fail-CLOSED when unconfigured.
 *
 * Contract: 2xx fast (INSERT into the inbox + return). Dedupe = (event, payload hash)
 * with a UTC-day bucket in the hash, so retried deliveries within the day collapse but
 * a byte-identical legitimate event months later is not swallowed forever. Processing
 * is decoupled: the 30s poller drain is the backstop; a prompt drain fires only while
 * the TRUSTPOINT_ENABLED switch is on (the switch gates the MIRROR — deliveries are
 * still stored while off, and drain when it turns back on).
 */

const crypto = require('crypto');
const express = require('express');
const router = require('../lib/safe-router')();
const F = require('../lib/fields');           // jsonbText: this router is mounted ABOVE
                                              // the request-boundary NUL stripper (it needs the
                                              // RAW body for signature checks), so the helper is
                                              // genuinely the only guard here (audit 2026-08-02).
const db = require('../db');
const cfg = require('../config');
const { rateLimit } = require('../lib/rate-limit');

router.use(rateLimit({ bucket: 'trustpoint-webhook', windowMs: 60000, max: 240 }));
router.use(express.json({ limit: '1mb' }));

function tokenOk(req) {
  const expect = cfg.trustpointWebhookToken;
  if (!expect) return false;   // fail CLOSED: no token configured = receiver off
  const h = req.headers || {};
  const raw = h['x-api-key'] || String(h.authorization || '').replace(/^(Bearer|Api-Key)\s+/i, '');
  if (!raw) return false;
  const a = crypto.createHash('sha256').update(String(raw)).digest();
  const b = crypto.createHash('sha256').update(String(expect)).digest();
  return crypto.timingSafeEqual(a, b);
}

router.post('/', async (req, res) => {
  try {
    if (!tokenOk(req)) return res.status(401).json({ error: 'unauthorized' });
    const p = req.body || {};
    const event = String(p.event || p.event_type || '').toUpperCase().replace(/\s+/g, '_').slice(0, 64);
    if (!event) return res.status(400).json({ error: 'missing event' });
    const data = p.data && typeof p.data === 'object' ? p.data : p;
    let payload = F.jsonbText(data);
    // NEVER slice a JSON string (an invalid fragment fails the ::jsonb cast and 500s the
    // receive — TrustPoint drops non-2xx forever). Oversize → a marker object instead.
    if (payload.length > 100000) payload = F.jsonbText({ truncated: true, event, draw_id: data.draw_id || null, project_id: data.project_id || null, loan_id: data.loan_id || null });
    const day = new Date().toISOString().slice(0, 10);
    const hash = crypto.createHash('sha256').update(event + '|' + day + '|' + payload).digest('hex');
    await db.query(
      `INSERT INTO trustpoint_webhook_events (event, tp_project_id, tp_draw_id, tp_service_order_id, loan_id, payload, payload_hash)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
       ON CONFLICT (event, payload_hash) DO NOTHING`,
      [event, data.project_id != null ? String(data.project_id).slice(0, 64) : null,
       data.draw_id != null ? String(data.draw_id).slice(0, 64) : null,
       data.service_order_id != null ? String(data.service_order_id).slice(0, 64) : null,
       data.loan_id != null ? String(data.loan_id).slice(0, 64) : null, payload, hash]);
    res.json({ ok: true });
    const client = require('../trustpoint/client');
    if (client.enabled()) setImmediate(() => { require('../trustpoint/mirror').drainInbox().catch(() => {}); });
  } catch (e) {
    console.warn('[trustpoint] webhook receive failed:', e && e.message);
    res.status(500).json({ error: 'server error' });
  }
});

module.exports = router;
