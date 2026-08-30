'use strict';
/**
 * LONG-TERM — THE INBOUND WEBHOOK, sharing ONE endpoint with the short-term inbox.
 *
 * ── WHY IT IS MOUNTED IN FRONT OF THE SHORT-TERM ROUTE, NOT BESIDE IT ───────
 *
 * A mail provider routes inbound mail per DOMAIN to ONE webhook, and both products
 * mint reply addresses on the same verified domain. So there is exactly one delivery
 * endpoint and it has to serve both, which `src/server.js` does by mounting this
 * router at the SAME path, immediately before the short-term one: this handler
 * claims a delivery only when it names a long-term order address and otherwise calls
 * `next()`, leaving the short-term reader to see the request exactly as it always
 * has. Nothing in `src/routes/**` changed, and no short-term code knows this exists.
 *
 * Express's body parsers set `req._body` once one of them has run, so the
 * short-term route's own `express.raw` is a no-op and `req.body` is still the very
 * Buffer verified here — the signature is over the exact bytes on both sides.
 *
 * ── THE CLAIM IS DECIDED BEFORE THE SIGNATURE, AND ACTED ON AFTER ───────────
 *
 * Routing reads the parsed recipients; ACTING requires a valid signature. Reading an
 * unverified body to answer "is this mine?" is safe because a forged body that names
 * a long-term address is then refused at the signature and never reaches the
 * short-term reader either — which is correct, since that reader would have refused
 * it too.
 *
 * ── STATUS CONTRACT, matching the short-term route exactly ──────────────────
 *
 *  · 400 — invalid signature, or no webhook secret configured. An unconfigured
 *    endpoint refuses everything; a missing secret can authenticate nobody.
 *  · 503 — a RETRYABLE processing failure (the provider's retrieval is down, a
 *    transient database error). The provider redelivers on its own schedule and the
 *    unique index on `inbound_id` makes the second attempt idempotent. A reply that
 *    carries a title commitment must never be dropped because a fetch blinked.
 *  · 200 — every TERMINAL outcome (filed, unknown order, auto-responder, duplicate),
 *    so the provider never retries one.
 */

const express = require('express');

const router = express.Router();

const cfg = require('../config');
const webhook = require('../../lib/resend-webhook');
const inbox = require('../orders/inbox');

// Raw body for THIS route only (a Buffer), so the signature covers exact bytes.
router.use(express.raw({ type: '*/*', limit: '5mb' }));

router.post('/', async (req, res, next) => {
  let raw;
  try {
    // `express.raw` leaves req.body as {} (not a Buffer) when the request carries no
    // body — `Buffer.from({})` throws, and an async throw before a response hangs
    // the connection forever. Coerce defensively, exactly as the short-term route does.
    raw = Buffer.isBuffer(req.body) ? req.body
      : Buffer.from(typeof req.body === 'string' ? req.body : '');
  } catch (_) { return next(); }

  let event = null;
  try { event = JSON.parse(raw.toString('utf8') || '{}'); }
  catch (_) { return next(); }   // not JSON we can read — the other reader may still want it

  const type = event && (event.type || event.event);
  if (type && type !== 'email.received') return next();

  // IS THIS OURS? Nothing is acted on yet.
  let refs = [];
  try { refs = inbox.ordersFromEvent(event && event.data); } catch (_) { refs = []; }
  if (!refs.length) return next();

  // It is ours — from here on this router owns the response.
  try {
    if (!cfg.resendWebhookSecret) return res.status(400).json({ error: 'webhook not configured' });
    const v = webhook.verify(raw, req.headers, cfg.resendWebhookSecret);
    if (!v.ok) return res.status(400).json({ error: 'invalid signature' });

    const result = await inbox.processReceivedEvent(event);
    if (result && result.retryable) {
      return res.status(503).json({ ok: false, retry: true, result: result.status });
    }
    return res.json({ ok: true, product: 'long-term', result: result && result.status });
  } catch (e) {
    console.error('[lt-order-inbox] unhandled:', (e && e.message ? String(e.message) : String(e)).slice(0, 200));
    return res.status(503).json({ ok: false, retry: true });
  }
});

module.exports = router;
