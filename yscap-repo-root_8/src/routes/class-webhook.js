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
// `verify` sees the RAW bytes before they are parsed, which is the only place a body
// can be measured and fingerprinted exactly. That fingerprint is what keeps two
// different un-storable deliveries apart (see `marker` below); deriving one from the
// PARSED object cannot do the job, because the bodies that need a marker are precisely
// the ones that re-serializing fails or distorts.
router.use(express.json({
  limit: '2mb',
  verify: (req, _res, buf) => {
    try {
      req.rawBodyBytes = buf ? buf.length : 0;
      req.rawBodyDigest = crypto.createHash('sha256').update(buf || Buffer.alloc(0)).digest('hex');
    } catch (_) { /* never block parsing over bookkeeping */ }
  },
}));

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
  // the username would leak, by timing, whether the username was right. During a
  // password rotation (their API is delete-and-recreate, so there is a window in
  // which Class still sends the old password) the PREVIOUS password is accepted too
  // — only while CLASS_CALLBACK_PASSWORD_PREVIOUS is set, and compared the same way.
  const pw = decoded.slice(at + 1);
  const userOk = sameSecret(decoded.slice(0, at), c.callbackUser);
  const passOk = sameSecret(pw, c.callbackPassword);
  const prevOk = c.callbackPasswordPrevious ? sameSecret(pw, c.callbackPasswordPrevious) : false;
  return userOk && (passOk || prevOk);
}

// THEIR DELIVERY IDENTITY. Their self-registration guide states the contract in so
// many words: deliveries are at-least-once, "deduplicate on orderId + eventName +
// created". A retry is NOT guaranteed byte-identical (the `sent` stamp moves), so a
// payload hash alone would file a retry as a second event and process it twice. When
// the envelope carries both an order id and a parseable `created`, the dedupe key is
// theirs — PLUS a digest of the content with the transport stamps (`sent`, `created`)
// removed. Their three fields are the identity of a retry; the content digest is what
// keeps two DIFFERENT legitimate events that happen to share all three (two notes on
// one order in the same second, a status change re-fired with new data) from
// silently collapsing to one. A retry carries the same content, so it still collapses.
// Otherwise (a malformed or partial body, a marker) it falls back to the payload
// bytes + the day, which still collapses a verbatim retry.
//
// `created` without a timezone is read as UTC: their examples are `…Z`, and
// Date.parse treats an offset-less ISO string as LOCAL time, which would make the
// same instant hash differently on two servers in two zones. The lowercase `t` and
// the SQL-style space separator are accepted for the same reason — V8 reads both as
// local time too.
const ISO_NO_OFFSET = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;
const TRANSPORT_KEYS = new Set(['sent', 'Sent', 'created', 'Created']);
// ITERATIVE on purpose — an explicit stack, no recursion, no depth cap. JSON.parse is
// iterative too, so anything it can hand this router, this can canonicalise, however
// deep. The recursive version had a cap, and the band between that cap and the point
// where the STORED body overflows into the marker was exactly where a deep retry with
// a moved `sent` digested differently and was processed twice.
function canonical(root) {
  // A string on the stack is text to emit; an object or array is a node to expand.
  // Scalars and separators go on as their final text, so the only allocation per
  // element is the key label — the first cut wrapped every element in a small object
  // and ran 3-9x slower than the recursive form on a wide body.
  if (root === null || typeof root !== 'object') return scalar(root);
  const out = [];
  const stack = [root];
  while (stack.length) {
    const it = stack.pop();
    if (typeof it === 'string') { out.push(it); continue; }
    if (Array.isArray(it)) {
      // A leaf array is emitted by the native serializer in one call: with no keys to
      // sort its JSON IS the canonical form, element for element (undefined and holes
      // both print null, -0 prints 0 — exactly what scalar() does).
      if (it.length === 0) { out.push('[]'); continue; }
      if (allScalar(it)) { out.push(JSON.stringify(it)); continue; }
      out.push('[');
      stack.push(']');
      for (let i = it.length - 1; i >= 0; i--) {
        pushValue(stack, it[i]);
        if (i) stack.push(',');
      }
    } else {
      const keys = Object.keys(it).sort();
      if (keys.length === 0) { out.push('{}'); continue; }
      if (allScalarValues(it, keys)) {
        out.push('{' + keys.map((k) => JSON.stringify(k) + ':' + scalar(it[k])).join(',') + '}');
        continue;
      }
      out.push('{');
      stack.push('}');
      for (let i = keys.length - 1; i >= 0; i--) {
        pushValue(stack, it[keys[i]]);
        stack.push(JSON.stringify(keys[i]) + ':');
        if (i) stack.push(',');
      }
    }
  }
  return out.join('');
}
function scalar(v) {
  const j = JSON.stringify(v === undefined ? null : v);
  return j === undefined ? 'null' : j;
}
function allScalar(arr) {
  // A toJSON reachable on the array itself would let the native call answer for it —
  // only a polluted Array/Object prototype can put one there, but then the slow path
  // is the one that still emits the elements.
  if (typeof arr.toJSON === 'function') return false;
  for (let i = 0; i < arr.length; i++) { const v = arr[i]; if (v !== null && typeof v === 'object') return false; }
  return true;
}
function allScalarValues(obj, keys) {
  for (let i = 0; i < keys.length; i++) { const v = obj[keys[i]]; if (v !== null && typeof v === 'object') return false; }
  return true;
}
function pushValue(stack, v) {
  if (v !== null && typeof v === 'object') stack.push(v);
  else stack.push(scalar(v));
}
// The digest is over the body sans the transport stamps. `rest` has a null prototype
// so a top-level "__proto__" key — which JSON.parse does produce as an own property —
// is data, not an assignment to the object's prototype. The catch is a floor, not a
// rung a parsed body can reach: canonical only throws on a value JSON.stringify
// refuses (a BigInt, say), which JSON.parse never yields. There the stored marker's
// raw-body digest stands in — distinguishing, though a moved `sent` would then count
// as a second delivery, which is why the floor must stay unreachable for JSON.
function contentDigest(p, payload) {
  const rest = Object.create(null);
  if (p && typeof p === 'object') for (const k of Object.keys(p)) if (!TRANSPORT_KEYS.has(k)) rest[k] = p[k];
  let material;
  try { material = canonical(rest); }
  catch (_) { material = String(payload); }
  return crypto.createHash('sha256').update(material).digest('hex');
}
function deliveryKey(env, p, payload, day) {
  const createdRaw = p && (p.created != null ? p.created : p.Created);
  let createdStr = createdRaw == null || createdRaw === '' ? null : String(createdRaw).trim();
  if (createdStr && ISO_NO_OFFSET.test(createdStr)) createdStr = createdStr.replace(/[t ]/, 'T') + 'Z';
  const createdMs = createdStr == null ? NaN : Date.parse(createdStr);
  if (env.classOrderId && Number.isFinite(createdMs)) {
    return {
      keyed: true,
      material: `k|${env.eventName}|${env.classOrderId}|${new Date(createdMs).toISOString()}|${contentDigest(p, payload)}`,
    };
  }
  return { keyed: false, material: `${env.eventName}|${day}|${payload}` };
}

// Their events all carry the same envelope; these are the only fields we index on.
//
// Every one of these three lands in a `text` column, so each is stripped of NUL and
// capped HERE rather than at the INSERT. Both halves matter and neither is theoretical:
// Postgres refuses a NUL in text with 22021, and this router is mounted ABOVE the
// global NUL stripper (it has to be — it needs its own small JSON parser), so nothing
// else in the stack catches one. An uncapped id is worse than untidy: the oversize
// guard below re-embeds these values, so a 2 MB `orderId` would sail straight through
// the very guard that exists to keep the row small.
const ENV_MAX = 256;
function envelope(p) {
  const s = (v) => {
    if (v == null) return null;
    const t = String(v).replace(/\u0000/g, '').trim();
    return t ? t.slice(0, ENV_MAX) : null;
  };
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

    // A marker stands in for a body we cannot store as-is. It always carries
    // `bodyDigest` — a digest of what actually arrived — and that field is the whole
    // point of it, not decoration: the dedupe hash below is computed over the stored
    // payload, so WITHOUT it every oversize delivery on one order collapses to the
    // same bytes, the unique index drops the second, and we answer 200 so the vendor
    // never retries. That is silent event loss on the one path that must never lose a
    // delivery. With it, two different bodies stay two different rows.
    const marker = (why) => F.jsonbText({
      truncated: true, reason: why,
      eventName: env.eventName,
      orderId: env.classOrderId, referenceNumber: env.referenceNumber,
      bodyBytes: req.rawBodyBytes == null ? null : req.rawBodyBytes,
      bodyDigest: req.rawBodyDigest || null,
    });

    let payload;
    try {
      payload = F.jsonbText(p);
      // NEVER slice a JSON string — an invalid fragment fails the ::jsonb cast and 500s
      // the receive, and a non-2xx is a delivery they will eventually stop retrying.
      if (payload.length > 200000) payload = marker('oversize');
    } catch (e) {
      // Serializing the body itself failed — a pathologically nested payload overflows
      // the stack inside the recursive NUL strip, and an exotic value would throw here
      // too. A 500 would be exactly wrong: their retry replays the SAME body, so it can
      // never succeed, and we would have taught a poison delivery to retry forever.
      // Record that it arrived, at its digest, and take it off their hands.
      payload = marker(`unserializable: ${(e && e.message) || 'error'}`.slice(0, 200));
    }

    // Dedupe — on THEIR identity (orderId + eventName + created) when the envelope
    // carries it, see deliveryKey(); else the same bytes on the same day collapse. The
    // day is inside the fallback hash because a byte-identical legitimate event weeks
    // later is a real second event, not a retry.
    const day = new Date().toISOString().slice(0, 10);
    const hash = crypto.createHash('sha256').update(deliveryKey(env, p, payload, day).material).digest('hex');

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
module.exports._internals = { authed, deliveryKey, envelope, sameSecret, canonical, contentDigest };
