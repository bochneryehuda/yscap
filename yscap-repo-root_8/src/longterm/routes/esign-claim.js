'use strict';
/**
 * LONG-TERM — THE CLAIM ON THE SHARED DOCUSIGN WEBHOOK.
 *
 * DocuSign Connect posts EVERY envelope's events to ONE URL. There is one DocuSign
 * account, so there is one endpoint, and both products' envelopes arrive on it.
 *
 * ── THE SILENT FAILURE THIS EXISTS TO PREVENT ───────────────────────────────
 *
 * The short-term drainer answers an envelope it does not own with
 * `skipped: 'untracked'` — correct for it, and it means a long-term envelope's
 * events were recorded, marked processed, and DROPPED. The landlord signs, nobody
 * hears, and the condition sits open with a form somebody believes is still out.
 * Nothing errors anywhere. It is the same class as the inbound-email collision the
 * `ltorder+` address family closed, and it takes the same shape: a claim mounted IN
 * FRONT of the short-term route that hands on anything that is not ours.
 *
 * ── THE ORDER OF THE CHECKS IS THE SAFETY ───────────────────────────────────
 *
 * 1. Take the RAW body. Body-parser marks `req._body` once, so the short-term
 *    route's own `express.raw` becomes a no-op and sees the same bytes — the
 *    signature covers exactly what arrived, on either path.
 * 2. With no HMAC key configured, hand on WITHOUT looking at anything: the
 *    short-term route owns the 503, and one unauthenticated event must never reach
 *    a database.
 * 3. VERIFY before the database is touched at all. A failed verification hands on
 *    rather than answering, so the 401 — and its diagnostic about which half of the
 *    HMAC setup is wrong — is written in ONE place.
 * 4. Only then look the envelope up. Not ours → `next()`, and the short-term route
 *    behaves exactly as it did before this file existed.
 *
 * ── WHAT IS TRUSTED, AND WHAT IS RE-READ ────────────────────────────────────
 *
 * The STATUS is taken from the verified payload — it is DocuSign's own signed
 * statement and applying it immediately is what makes the desk truthful within
 * seconds. The ANSWERS are not: they are re-read from DocuSign in the background,
 * because a Connect payload's tab data depends on the account's includeData setting
 * and reading a landlord's answers out of an unpredictable shape is how a blank
 * gets recorded as an answer. A re-read that fails costs the ANSWERS, never the
 * fact that the form came back — and the reconcile pass picks the rest up.
 *
 * SEPARATION: lt_* only, plus the authorized shared DocuSign transport (the HMAC
 * verification and the envelope read).
 */

const express = require('express');

const router = express.Router();

const cfg = require('../config');
const docusign = require('../../lib/integrations/docusign');
const desk = require('../vor/desk');

/** The envelope id + status out of a Connect payload, in every shape it arrives in.
    Acting on NOTHING yet — this only decides whose envelope it is. */
function correlate(payload) {
  const p = payload || {};
  const data = p.data || {};
  const envelopeId = data.envelopeId
    || (data.envelopeSummary && data.envelopeSummary.envelopeId)
    || (p.envelopeStatus && p.envelopeStatus.envelopeId)
    || p.envelopeId || null;
  const status = (data.envelopeSummary && data.envelopeSummary.status)
    || (p.envelopeStatus && p.envelopeStatus.status)
    || statusFromEvent(p.event || p.eventType)
    || null;
  return {
    envelopeId: envelopeId ? String(envelopeId) : null,
    status: status ? String(status).toLowerCase() : null,
  };
}

/** Connect's event names ('envelope-completed') carry the status when the summary
    does not. Anything unrecognised answers null, and `applyEnvelopeStatus` ignores
    an unknown status rather than guessing at one. */
function statusFromEvent(ev) {
  const m = String(ev || '').toLowerCase().match(/envelope-([a-z]+)/);
  return m ? m[1] : null;
}

router.use(express.raw({ type: '*/*', limit: '5mb' }));

router.post('/', async (req, res, next) => {
  // (2) Not configured — the short-term route owns that answer.
  if (!(cfg.docusignConnectKeys || []).length) return next();

  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');

  // (3) Verify BEFORE anything else. A bad signature hands on, so the refusal and
  // its diagnostic stay in one place.
  let verified = false;
  try { verified = docusign.verifyConnectHmac(raw, docusign.connectSignatureHeaders(req)); }
  catch (_) { verified = false; }
  if (!verified) return next();

  let payload;
  try { payload = JSON.parse(raw.toString('utf8') || '{}'); }
  catch (_) { return next(); }             // the short-term route answers the 400

  const { envelopeId, status } = correlate(payload);
  if (!envelopeId) return next();

  // (4) Is it ours?
  let applied;
  try {
    applied = await desk.applyEnvelopeStatus(envelopeId, status || '');
  } catch (e) {
    /* A long-term envelope we could not write. Answering 200 would tell DocuSign the
       event was handled and it would never be redelivered, so this hands on: the
       short-term route records it in its own inbox and answers 200, and the
       reconcile pass is what actually recovers the state. Never silent. */
    console.error('[lt-esign-claim] could not apply status:', String((e && e.message) || e).slice(0, 200));
    return next();
  }

  if (!applied || applied.reason === 'untracked' || applied.reason === 'no_envelope') return next();

  /* Ours. Re-read the landlord's answers in the background — never on the request
     path, because DocuSign is slow enough to make Connect retry, and a retry after
     we have already applied the status is pure noise. */
  if (applied.recorded) {
    setImmediate(() => {
      desk.reconcileOpenEnvelopes({ limit: 1 }).catch(() => {});
      readAnswersLater(envelopeId);
    });
  }

  res.status(200).json({ ok: true, claimed: true });
});

/** Pull the typed answers off a completed envelope and file them against the return
    row. Best-effort: the return already exists and says the landlord signed. */
async function readAnswersLater(envelopeId) {
  try {
    const env = await docusign.getEnvelope(envelopeId, { include: 'recipients,tabs' });
    const answers = desk.answersFromEnvelope(env);
    if (!answers || !Object.keys(answers).length) return;
    const db = require('../db');
    await db.query(
      `UPDATE lt_vor_returns r
          SET answers = $2::jsonb
         FROM lt_vor_envelopes e
        WHERE r.envelope_id = e.id AND e.envelope_id = $1
          AND r.source = 'docusign' AND r.answers = '{}'::jsonb`,
      [String(envelopeId), JSON.stringify(answers)]);
  } catch (_) { /* the reconcile pass tries again */ }
}

module.exports = router;
module.exports._internals = { correlate, statusFromEvent };
