'use strict';
/**
 * Class Valuation PUBLIC callback receiver.
 *
 * Class pushes rather than being polled: we register a URL once, and they POST an
 * event whenever something happens to an order. Their contract (guide pp.5-6): HTTP
 * Basic auth with credentials WE choose and hand them at registration, and a 200
 * back within 30 seconds.
 *
 * So this router does the least possible: authenticate, store the delivery verbatim,
 * answer 200, and hand the thinking to `class/callbacks.js` off the request path.
 * Everything that could be slow — resolving the order, updating it, deciding whether
 * to fetch anything — happens after the response. A delivery we answer late is a
 * delivery they retry, and eventually stop sending.
 *
 * MOUNTED BEFORE THE GLOBAL JSON PARSER, with its own small one, mirroring the
 * ClickUp / DocuSign / TrustPoint webhooks: their payloads are tiny and the global
 * 32MB parser is not the right thing to point at a public URL. That also means this
 * router sits ABOVE the request-boundary NUL stripper, so anything reaching a text
 * or jsonb column goes through `F.jsonbText` here — the same rule those webhooks
 * follow, for the same reason.
 *
 * AUTH IS BASIC AND FAILS CLOSED. With no callback credentials configured, every
 * delivery is refused: an unauthenticated public endpoint that writes rows is worse
 * than a receiver that is switched off, and "off" is the safe reading of "nobody has
 * set this up yet". The comparison is over sha256 digests so it is constant-time and
 * does not leak the length of either value.
 *
 * VERSION-AWARENESS lives downstream, and cannot live here: their event does not say
 * which UAD version its order was placed on, so the version is read from our own
 * order row. See the header of `class/callbacks.js` — this file must never try to
 * infer it from the payload or from the current default.
 */

const crypto = require('crypto');
const express = require('express');
const router = require('../lib/safe-router')();
const F = require('../lib/fields');
const db = require('../db');
const cfg = require('../config');
const { rateLimit } = require('../lib/rate-limit');

router.use(rateLimit({ bucket: 'class-webhook', windowMs: 60000, max: 240 }));
router.use(express.json({ limit: '2mb' }));

// Constant-time compare of two strings via their digests — length-oblivious, so a
// wrong password cannot be distinguished from a wrong-length one by timing.
function sameSecret(a, b) {
  if (!a || !b) return false;
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

/**
 * HTTP Basic, as their guide specifies. Their registration body also allows an
 * `ApiToken` mode with a custom header name; that is supported here too so the mode
 * can be switched at Class's end without a deploy — but Basic is what we register.
 * BOTH modes fail closed when nothing is configured.
 */
function authed(req) {
  const c = cfg.class || {};
  const h = req.headers || {};

  // ApiToken mode: a token in a header we chose at registration.
  if (c.callbackToken) {
    const headerName = String(c.callbackTokenHeader || 'x-api-key').toLowerCase();
    if (sameSecret(h[headerName], c.callbackToken)) return true;
  }

  if (!c.callbackUser || !c.callbackPassword) return false;   // fail CLOSED
  const raw = String(h.authorization || '');
  const m = /^Basic\s+(.+)$/i.exec(raw);
  if (!m) return false;
  let decoded = '';
  try { decoded = Buffer.from(m[1], 'base64').toString('utf8'); } catch (_) { return false; }
  const at = decoded.indexOf(':');
  if (at < 0) return false;
  // BOTH halves are compared, and both comparisons always run — an early return on
  // the username would leak, by timing, whether the username was right.
  const userOk = sameSecret(decoded.slice(0, at), c.callbackUser);
  const passOk = sameSecret(decoded.slice(at + 1), c.callbackPassword);
  return userOk && passOk;
}

// Their events all carry the same envelope; these are the only fields we index on.
function envelope(p) {
  const s = (v) => { const t = v == null ? '' : String(v).trim(); return t || null; };
  return {
    eventName: s(p.eventName || p.EventName),
    classOrderId: s(p.orderId != null ? p.orderId : p.OrderId),
    referenceNumber: s(p.referenceNumber || p.ReferenceNumber),
  };
}

/**
 * ONE handler for every event. Class registers a URL per EVENT NAME, but the event
 * names itself in the body, so one endpoint serves all of them — and a new event
 * type they add later is stored rather than 404'd. The optional `:event` segment is
 * accepted so each registration can carry a distinct URL if that is ever wanted; the
 * BODY is always what decides, never the path (a path anyone can call is not
 * evidence of anything).
 */
async function receive(req, res) {
  try {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' });

    const p = req.body && typeof req.body === 'object' ? req.body : {};
    const env = envelope(p);
    if (!env.eventName) return res.status(400).json({ error: 'missing eventName' });

    let payload = F.jsonbText(p);
    // NEVER slice a JSON string — an invalid fragment fails the ::jsonb cast and 500s
    // the receive, and a non-2xx is a delivery they will eventually stop retrying.
    // Oversize becomes a marker object that still records what arrived.
    if (payload.length > 200000) {
      payload = F.jsonbText({
        truncated: true, eventName: env.eventName,
        orderId: env.classOrderId, referenceNumber: env.referenceNumber,
      });
    }

    // Dedupe. Their retries repeat a delivery verbatim, so the same bytes on the same
    // day collapse; the day is inside the hash because a byte-identical legitimate
    // event weeks later is a real second event, not a retry.
    const day = new Date().toISOString().slice(0, 10);
    const hash = crypto.createHash('sha256').update(`${env.eventName}|${day}|${payload}`).digest('hex');

    await db.query(
      `INSERT INTO class_callback_events (event_name, class_order_id, reference_number, payload, payload_hash)
       VALUES ($1,$2,$3,$4::jsonb,$5)
       ON CONFLICT (event_name, payload_hash) DO NOTHING`,
      [env.eventName.slice(0, 64), env.classOrderId, env.referenceNumber, payload, hash]);

    // 200 FIRST. Everything below is best-effort and must never delay the answer.
    res.json({ ok: true });

    setImmediate(() => {
      require('../class/callbacks').drain({ limit: 25 }).catch(() => {});
    });
  } catch (e) {
    console.warn('[class] callback receive failed:', e && e.message);
    // A 500 asks them to retry, which is right: we failed to STORE it, so the
    // delivery is genuinely not recorded and their retry is our second chance.
    res.status(500).json({ error: 'server error' });
  }
}

router.post('/', receive);
router.post('/:event', receive);

module.exports = router;
