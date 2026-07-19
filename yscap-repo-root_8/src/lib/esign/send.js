/**
 * esign/send.js — the send-EXACTLY-once engine (owner's #1 ask).
 *
 * Drives outbound DocuSign envelope creation directly off `esign_envelopes`
 * (which carries the send-once claim on `send_claimed_at`). This is the durable
 * "queue": a drainer picks due rows, atomically claims each, builds the package,
 * and creates the envelope with a deterministic idempotency key.
 *
 * The four send-once layers (docs/DOCUSIGN-ERROR-HANDLING-AND-HARDENING.md §1):
 *   1. Atomic claim on send_claimed_at (never a fake status — H-5). The winner
 *      alone calls DocuSign; a racing/duplicate call claims 0 rows and skips.
 *   2. Deterministic X-DocuSign-Idempotency-Key so a retry/reclaim replays the
 *      SAME key — DocuSign returns the original envelope, never a duplicate (M-7).
 *   3. The partial unique index uq_esign_inflight (in db/132) is the DB backstop.
 *   4. Crash-between-claim-and-envelope_id (M-12): a stale claim (>5min, still no
 *      envelope_id) is re-claimed and re-POSTs the same key.
 *
 * Retry taxonomy mirrors the ClickUp queue: OUTAGE (429/5xx/timeout/network/
 * breaker — patient, fixed 600s, dead@40) vs PERMANENT (4xx validation — exp
 * backoff, dead@8). Exhausted/permanent → dead-letter (status='error',
 * dead_lettered_at) so a human sees it; nothing stuck is ever invisible.
 *
 * Dependency-injected (db / docusign / buildDefinition / onDeadLetter) so the
 * engine is unit-testable without a live DocuSign account.
 */
const dbDefault = require('../../db');
const docusignDefault = require('../integrations/docusign');
const cfg = require('../../config').docusign;

const CLAIM_STALE_MIN = 5;
const MAX_ATTEMPTS_OUTAGE = 40;
const MAX_ATTEMPTS_PERMANENT = 8;

/** Classify a send failure into the retry taxonomy. `attempts` is post-increment. */
function classify(e, attempts) {
  const outage = !!(e && (
    e.retryable === true ||
    e.code === 'DOCUSIGN_TIMEOUT' || e.code === 'DOCUSIGN_NETWORK' ||
    e.code === 'DOCUSIGN_CIRCUIT_OPEN' || e.code === 'DOCUSIGN_NOT_CONFIGURED' ||
    e.status === 429 || (typeof e.status === 'number' && e.status >= 500)
  ));
  const maxA = outage ? MAX_ATTEMPTS_OUTAGE : MAX_ATTEMPTS_PERMANENT;
  const permanent = !outage && e && e.retryable === false;
  const dead = permanent || attempts >= maxA;
  const backoffSec = outage ? 600 : Math.min(2 ** attempts, 3600);
  return { outage, permanent, dead, backoffSec };
}

/**
 * M-13: refuse to mail anyone not on the allow-list whenever we're NOT fully
 * live. The gate is active on the DEMO host (always) AND on the PRODUCTION host
 * while test mode is on (the default) — so pointing at live creds during testing
 * can never mail a real borrower a watermark-free binding envelope by accident.
 * Only an explicit DOCUSIGN_TEST_MODE=0 on the production host lifts the gate.
 */
function guardTestEmails(docusign, signers) {
  const onDemo = !!(docusign.isDemoHost && docusign.isDemoHost());
  const gated = onDemo || cfg.testMode;
  if (!gated) return;   // production host + test mode explicitly OFF = true go-live
  const allow = cfg.testEmailAllowlist || [];
  for (const s of (signers || [])) {
    const em = String(s.email || '').toLowerCase();
    if (!allow.includes(em)) {
      const err = new Error(`Send blocked (${onDemo ? 'demo' : 'test mode'}): "${s.email}" is not on DOCUSIGN_TEST_EMAIL_ALLOWLIST — a real recipient must never receive an envelope until go-live`);
      err.code = 'DOCUSIGN_TEST_EMAIL_BLOCKED';
      err.retryable = false;   // permanent until the allow-list / go-live flag changes
      throw err;
    }
  }
}

/** DB-backed send circuit breaker — counts on SEND time (L-3), not created_at. */
async function breakerOpen(db) {
  const r = await db.query(
    `SELECT count(*)::int AS n FROM esign_envelopes WHERE sent_at > now() - interval '10 minutes'`);
  return (r.rows[0] && r.rows[0].n) >= cfg.maxSends10min;
}

/**
 * Claim + build + create for ONE envelope row. Idempotent under retry.
 * Returns { sent } | { skipped } | { retry } | { dead }.
 */
async function sendClaimedEnvelope(rowId, opts = {}) {
  const db = opts.db || dbDefault;
  const docusign = opts.docusign || docusignDefault;
  const buildDefinition = opts.buildDefinition;
  if (typeof buildDefinition !== 'function') throw new Error('sendClaimedEnvelope requires a buildDefinition(row) function');

  // Layer 1 + 4: atomic claim — fresh OR stale reclaim, backoff-gated, not dead, not sent.
  const claimed = await db.query(
    `UPDATE esign_envelopes
        SET send_claimed_at = now(), attempts = attempts + 1, updated_at = now()
      WHERE id = $1
        AND envelope_id IS NULL
        AND dead_lettered_at IS NULL
        AND (send_claimed_at IS NULL OR send_claimed_at < now() - ($2 || ' minutes')::interval)
        AND (next_attempt_at IS NULL OR next_attempt_at <= now())
      RETURNING *`,
    [rowId, String(CLAIM_STALE_MIN)]);
  if (!claimed.rows.length) return { skipped: true };   // already sent / dead / held by another / backing off
  const row = claimed.rows[0];

  try {
    // Circuit breaker (before we mint anything) — a runaway loop stops hard.
    if (await breakerOpen(db)) {
      const err = new Error(`DocuSign send circuit open (> ${cfg.maxSends10min} sends / 10 min)`);
      err.code = 'DOCUSIGN_CIRCUIT_OPEN'; err.retryable = true;
      throw err;
    }
    const inputs = await buildDefinition(row);
    if (!inputs) { const e = new Error('buildDefinition returned nothing'); e.retryable = false; throw e; }
    guardTestEmails(docusign, inputs.signers);

    // Layer 2: deterministic key — replayed verbatim on any retry/reclaim.
    const idem = docusign.idempotencyKey(row.application_id, row.purpose, row.product_version);
    const def = docusign.buildEnvelopeDefinition(inputs);
    const res = await docusign.createEnvelope(def, { idempotencyKey: idem });
    if (!res || !res.envelopeId) { const e = new Error('createEnvelope returned no envelopeId'); e.retryable = true; throw e; }

    // Stamp SENT — guarded on envelope_id IS NULL so a double never double-stamps.
    const recipients = JSON.stringify((inputs.signers || []).map((s) => ({
      role: s.role, name: s.name, email: s.email, recipientId: s.recipientId, routingOrder: s.routingOrder, embedded: !!s.clientUserId,
    })));
    const upd = await db.query(
      `UPDATE esign_envelopes
          SET envelope_id = $2, status = 'sent', sent_at = now(), idempotency_key = $3,
              recipients = $4::jsonb, embedded = $5, last_error = NULL, next_attempt_at = NULL, updated_at = now()
        WHERE id = $1 AND envelope_id IS NULL
        RETURNING *`,
      [row.id, res.envelopeId, idem, recipients, (inputs.signers || []).some((s) => s.clientUserId)]);
    return { sent: true, envelopeId: res.envelopeId, row: upd.rows[0] || row };
  } catch (e) {
    return handleSendError(db, row, e, opts);
  }
}

async function handleSendError(db, row, e, opts) {
  const attempts = row.attempts;   // already incremented by the claim
  const { dead, backoffSec } = classify(e, attempts);
  const msg = ((e && e.message) || String(e)).slice(0, 500);
  if (dead) {
    // Permanent OR exhausted → dead-letter. Release the claim, stamp for a human.
    await db.query(
      `UPDATE esign_envelopes
          SET status = 'error', last_error = $2, dead_lettered_at = now(),
              send_claimed_at = NULL, next_attempt_at = NULL, updated_at = now()
        WHERE id = $1`, [row.id, msg]);
    try {
      if (opts.onDeadLetter) await opts.onDeadLetter(row, e);
      else console.warn(`[esign] DEAD-LETTER envelope row ${row.id} (app ${row.application_id}, ${row.purpose}): ${msg}`);
    } catch (le) { console.warn(`[esign] dead-letter hook failed for ${row.id}: ${le.message}`); }
    return { dead: true, error: msg };
  }
  // Retryable → schedule backoff, RELEASE the claim so it's re-eligible at next_attempt_at.
  await db.query(
    `UPDATE esign_envelopes
        SET last_error = $2, next_attempt_at = now() + ($3 || ' seconds')::interval,
            send_claimed_at = NULL, updated_at = now()
      WHERE id = $1`, [row.id, msg, String(backoffSec)]);
  return { retry: true, backoffSec, error: msg };
}

/** Drain all due (never-sent, not-dead, backoff-elapsed) rows. Serial, bounded. */
async function drainDue(opts = {}) {
  const db = opts.db || dbDefault;
  const limit = opts.limit || 25;
  const due = await db.query(
    `SELECT id FROM esign_envelopes
      WHERE envelope_id IS NULL AND dead_lettered_at IS NULL AND status = 'not_sent'
        AND (next_attempt_at IS NULL OR next_attempt_at <= now())
        AND (send_claimed_at IS NULL OR send_claimed_at < now() - interval '5 minutes')
      ORDER BY created_at
      LIMIT $1`, [limit]);
  const results = [];
  for (const r of due.rows) {
    results.push(await sendClaimedEnvelope(r.id, opts).catch((e) => ({ error: e.message, id: r.id })));
  }
  return results;
}

module.exports = { sendClaimedEnvelope, drainDue, classify, guardTestEmails, breakerOpen };
