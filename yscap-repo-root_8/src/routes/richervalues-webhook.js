'use strict';
/**
 * Richer Values PUBLIC webhook receiver.
 *
 * They push rather than being polled: we give them a URL once, and they POST an
 * event whenever something happens to an order — `{order_type, intake_token,
 * order_token, data:{action_type, action}, datetime}`.
 *
 * So this router does the least possible: authenticate, store the delivery
 * verbatim, answer 200, and hand the thinking to `richervalues/sync.js` off the
 * request path. Everything that could be slow — resolving the order, reading their
 * API for the detail, fetching a finished report — happens after the response. A
 * delivery we answer late is a delivery they retry, and eventually stop sending.
 *
 * MOUNTED BEFORE THE GLOBAL JSON PARSER, with its own small one, mirroring the
 * ClickUp / DocuSign / TrustPoint / Class webhooks: their payloads are tiny and
 * the global 32MB parser is not the right thing to point at a public URL. That
 * also means this router sits ABOVE the request-boundary NUL stripper, so
 * anything reaching a text or jsonb column goes through `F.jsonbText` here — the
 * same rule those webhooks follow, for the same reason.
 *
 * AUTH FAILS CLOSED. With no webhook credentials configured, every delivery is
 * refused: an unauthenticated public endpoint that writes rows is worse than a
 * receiver that is switched off, and "off" is the honest reading of "nobody has
 * set this up yet". The comparison is over sha256 digests so it is constant-time
 * and does not leak the length of either value.
 *
 * THE EVENT IS A NUDGE, NOT THE TRUTH. Their payload carries an action and
 * nothing else — no status figures, no report — so nothing here interprets money
 * or values. It records that something happened and lets the sync go and ASK. A
 * push we treat as authoritative is a push we cannot verify.
 */

const crypto = require('crypto');
const express = require('express');
const router = require('../lib/safe-router')();
const F = require('../lib/fields');
const db = require('../db');
const cfg = require('../config');
const { rateLimit } = require('../lib/rate-limit');

router.use(rateLimit({ bucket: 'rv-webhook', windowMs: 60000, max: 240 }));
// `verify` sees the RAW bytes before they are parsed, which is the only place a
// body can be measured and fingerprinted exactly. That fingerprint is what keeps
// two different un-storable deliveries apart; deriving one from the PARSED object
// cannot do the job, because the bodies that need a marker are precisely the ones
// re-serializing fails or distorts.
router.use(express.json({
  limit: '256kb',
  verify: (req, _res, buf) => {
    try {
      req.rawBodyBytes = buf ? buf.length : 0;
      req.rawBodyDigest = crypto.createHash('sha256').update(buf || Buffer.alloc(0)).digest('hex');
    } catch (_) { /* never block parsing over bookkeeping */ }
  },
}));

/** Constant-time compare via digests — length-oblivious. */
function sameSecret(a, b) {
  if (!a || !b) return false;
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

/**
 * HTTP Basic with credentials WE issue them, or a token in a header we name.
 * BOTH modes fail closed when nothing is configured.
 */
function authed(req) {
  const c = cfg.richerValue || {};
  const h = req.headers || {};

  if (c.webhookToken) {
    const headerName = String(c.webhookTokenHeader || 'x-api-key').toLowerCase();
    if (sameSecret(h[headerName], c.webhookToken)) return true;
  }

  if (!c.webhookUser || !c.webhookPassword) return false;   // fail CLOSED
  const raw = String(h.authorization || '');
  const m = /^Basic\s+(.+)$/i.exec(raw);
  if (!m) return false;
  let decoded = '';
  try { decoded = Buffer.from(m[1], 'base64').toString('utf8'); } catch (_) { return false; }
  const at = decoded.indexOf(':');
  if (at < 0) return false;
  return sameSecret(decoded.slice(0, at), c.webhookUser) && sameSecret(decoded.slice(at + 1), c.webhookPassword);
}

/**
 * The dedupe key. Their retries repeat a delivery verbatim, so the same event
 * must record once — but a byte-identical event on a LATER DAY is legitimate (an
 * order genuinely going on hold twice), so the DAY is inside the hash. That is
 * the rule the TrustPoint and Class inboxes already follow, and it is the reason
 * a naive "hash the body" dedupe silently drops real events.
 */
function dedupeHash(body, digest) {
  const day = new Date().toISOString().slice(0, 10);
  let serialized;
  try { serialized = JSON.stringify(body); } catch (_) { serialized = null; }
  return crypto.createHash('sha256').update(`${day}|${serialized || `raw:${digest || ''}`}`).digest('hex');
}

router.post('/', async (req, res) => {
  if (!authed(req)) return res.status(401).json({ error: 'unauthorized' });

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const data = (body.data && typeof body.data === 'object') ? body.data : {};
  const hash = dedupeHash(body, req.rawBodyDigest);

  // STORE FIRST, INTERPRET LATER. An event shape we do not handle yet is still on
  // the record and can be replayed once we do.
  let rowId = null;
  try {
    const ins = await db.query(
      `INSERT INTO rv_order_events
         (order_type, action_type, action, intake_token, order_token, event_at, payload, payload_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
       ON CONFLICT (payload_hash) DO NOTHING
       RETURNING id`,
      [F.jsonbText(body.order_type), F.jsonbText(data.action_type), F.jsonbText(data.action),
        F.jsonbText(body.intake_token), F.jsonbText(body.order_token),
        parseTime(body.datetime), JSON.stringify(F.jsonbText(body) || {}), hash]);
    rowId = ins.rows[0] ? ins.rows[0].id : null;
  } catch (e) {
    // A body we could not store is still worth acknowledging — refusing it makes
    // them retry the same unstorable thing until they give up. It is logged so it
    // is not invisible.
    console.error('[rv-webhook] could not store a delivery:', (e && e.message) || e);
    return res.status(200).json({ received: true, stored: false });
  }

  // ANSWER FIRST. Their contract is a fast 200; everything else happens after.
  res.status(200).json({ received: true, duplicate: rowId == null });

  if (rowId != null) {
    setImmediate(() => {
      require('../richervalues/sync').drain({ limit: 10 })
        .catch((e) => console.error('[rv-webhook] drain failed:', (e && e.message) || e));
    });
  }
  return undefined;
});

/** Their `datetime` is ISO; anything unparseable records as unknown, never as now. */
function parseTime(v) {
  if (!v) return null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

module.exports = router;
