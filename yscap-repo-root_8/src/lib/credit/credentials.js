'use strict';

/**
 * Per-user credit-vendor credentials (Xactus login).
 *
 * Owner rule: every loan officer sets their OWN login — no shared/surrogate
 * account. The password is a write-only secret: the UI can set it and see its
 * status, but never read it back. At rest it is AES-256-GCM encrypted through
 * the crypto.js chokepoint (crypto.encryptSecret); the plaintext exists only
 * in memory for the moment an order is placed.
 *
 * Public surface:
 *   listForUser(userId)            -> [{ providerId, providerKey, displayName,
 *                                        operatorIdentifier, status, lastVerifiedAt,
 *                                        hasCredential }]  (NEVER the secret)
 *   setForUser(userId, opts)       -> { ok, status, message }   (encrypt + upsert + verify-on-save)
 *   removeForUser(userId, providerId)
 *   getUsable(userId, providerId)  -> { operatorIdentifier, secret } | null   (SERVER-ONLY; decrypts)
 *
 * getUsable is the ONLY path that returns plaintext and is called only by the
 * order flow. Nothing here logs the identifier or secret.
 */
const db = require('../../db');
const crypto = require('../crypto');
const providers = require('./providers');
const xactus = require('../integrations/xactus');
const cfg = require('../../config');

// LoginAccountIdentifier is a vendor login name — bound it and reject control
// chars, but don't over-constrain the character set (vendors vary).
function cleanIdentifier(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s || s.length > 200) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(s)) return null;
  return s;
}

function badRequest(msg) { const e = new Error(msg); e.status = 400; return e; }

/**
 * The status rows the Settings screen renders. One row per ENABLED provider so a
 * staffer sees every vendor they could set a login for, with whether they have
 * one and its verification state. No secret, no ciphertext leaves here.
 */
async function listForUser(userId) {
  const enabled = await providers.listEnabled();
  const { rows } = await db.query(
    `SELECT provider_id, operator_identifier, status, last_verified_at
       FROM user_credit_credentials WHERE user_id = $1`, [userId]);
  const byProvider = new Map(rows.map((r) => [r.provider_id, r]));
  return enabled.map((p) => {
    const c = byProvider.get(p.id);
    return {
      providerId: p.id,
      providerKey: p.key,
      displayName: p.displayName,
      operatorIdentifier: c ? c.operator_identifier : null,
      status: c ? c.status : 'none',
      lastVerifiedAt: c ? c.last_verified_at : null,
      hasCredential: !!c,
    };
  });
}

/**
 * Create or replace the acting user's credential for a provider. Secret is
 * required (write-only: there is no "keep existing secret" — a save always
 * re-supplies it) so a blank field never silently blanks the stored password.
 *
 * opts: { providerKey?|providerId?, operatorIdentifier, secret, verify? }
 */
async function setForUser(userId, opts = {}) {
  if (!userId) throw badRequest('missing user');
  const provider = opts.providerId != null
    ? await providers.getById(opts.providerId)
    : await providers.getByKey(opts.providerKey || 'xactus');
  if (!provider) throw badRequest('unknown credit provider');
  if (!provider.enabled) throw badRequest(`${provider.displayName} is not enabled`);

  const operatorIdentifier = cleanIdentifier(opts.operatorIdentifier);
  if (!operatorIdentifier) throw badRequest('login identifier is required');
  const secret = opts.secret;
  if (secret == null || String(secret) === '') throw badRequest('password is required');
  if (String(secret).length > 1024) throw badRequest('password is too long');

  const encrypted = crypto.encryptSecret(String(secret));
  if (!encrypted) throw badRequest('could not secure the password');

  // Verify-on-save: only providers with a real adapter + config.verifyOnSave.
  // Never blocks the save — a save is always persisted with the resulting status
  // so an unreachable vendor doesn't lose the officer's entry.
  let status = 'unverified';
  let message = 'Saved.';
  const wantVerify = opts.verify !== false && cfg.xactus && cfg.xactus.verifyOnSave;
  if (wantVerify && provider.key === 'xactus') {
    try {
      const v = await xactus.verifyCredential({ operatorIdentifier, secret: String(secret) });
      status = v.status || 'unverified';
      message = v.message || message;
    } catch (_) { status = 'unverified'; message = 'Saved (verification unavailable).'; }
  }

  await db.query(
    `INSERT INTO user_credit_credentials
       (user_id, provider_id, operator_identifier, secret_encrypted, status, last_verified_at, updated_at)
     VALUES ($1,$2,$3,$4,$5, CASE WHEN $5='ok' THEN now() ELSE NULL END, now())
     ON CONFLICT (user_id, provider_id) DO UPDATE
       SET operator_identifier = EXCLUDED.operator_identifier,
           secret_encrypted    = EXCLUDED.secret_encrypted,
           status              = EXCLUDED.status,
           last_verified_at    = CASE WHEN EXCLUDED.status='ok' THEN now() ELSE user_credit_credentials.last_verified_at END,
           updated_at          = now()`,
    [userId, provider.id, operatorIdentifier, encrypted, status]);

  return { ok: true, status, message, providerId: provider.id, providerKey: provider.key };
}

async function removeForUser(userId, providerId) {
  const provider = await providers.getById(providerId);
  if (!provider) throw badRequest('unknown credit provider');
  await db.query(`DELETE FROM user_credit_credentials WHERE user_id=$1 AND provider_id=$2`, [userId, provider.id]);
  return { ok: true };
}

/**
 * SERVER-ONLY: decrypt and return the credential for an order. Returns null when
 * the user has no credential for the provider. The caller must treat `secret` as
 * transient (in-memory for the request; never persist/log it). A decrypt that
 * throws (tampered ciphertext / rotated key) propagates — a credential that
 * can't be decrypted must fail loudly, not order with a blank password.
 */
async function getUsable(userId, providerId) {
  const { rows } = await db.query(
    `SELECT operator_identifier, secret_encrypted
       FROM user_credit_credentials WHERE user_id=$1 AND provider_id=$2`, [userId, providerId]);
  if (!rows.length) return null;
  const secret = crypto.decryptSecret(rows[0].secret_encrypted);
  if (secret == null || secret === '') return null;
  return { operatorIdentifier: rows[0].operator_identifier, secret };
}

/** Mark a credential ok/invalid after an order revealed its true state. */
async function markStatus(userId, providerId, status) {
  const s = status === 'ok' ? 'ok' : status === 'invalid' ? 'invalid' : 'unverified';
  await db.query(
    `UPDATE user_credit_credentials
        SET status=$3, last_verified_at = CASE WHEN $3='ok' THEN now() ELSE last_verified_at END, updated_at=now()
      WHERE user_id=$1 AND provider_id=$2`, [userId, providerId, s]);
}

module.exports = { listForUser, setForUser, removeForUser, getUsable, markStatus, cleanIdentifier };
