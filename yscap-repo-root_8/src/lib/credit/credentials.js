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
    `SELECT provider_id, operator_identifier, status, last_verified_at, updated_at
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
      updatedAt: c ? c.updated_at : null,   // for the rotation nudge (a very old login may be stale)
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

/**
 * On-demand "test my login" (E4): decrypt the acting user's stored credential,
 * probe the provider's NO-CHARGE verify endpoint, persist the resulting status
 * (ok / invalid / unverified), and return it. Never places a billable pull; the
 * decrypted secret is transient (never returned or logged). A transport can be
 * injected for tests. Throws 400 when there is no saved login to test.
 */
async function verifyForUser(userId, providerId, opts = {}) {
  const provider = opts.providerId != null || providerId != null
    ? await providers.getById(providerId != null ? providerId : opts.providerId)
    : await providers.getByKey(opts.providerKey || 'xactus');
  if (!provider) throw badRequest('unknown credit provider');
  if (provider.key !== 'xactus') throw badRequest(`${provider.displayName} cannot be tested yet`);
  // A decrypt failure (rotated key / tampered ciphertext) is a foreseeable
  // "your saved login can't be read" state — surface it as a friendly 400 asking
  // the officer to re-enter, not a raw 500. (getUsable throws on a bad tag.)
  let cred;
  try {
    cred = await getUsable(userId, provider.id);
  } catch (_) {
    throw badRequest('your saved login could not be read — please re-enter it');
  }
  if (!cred) throw badRequest('no login saved to test — save your login first');
  let v;
  try {
    v = await xactus.verifyCredential({
      operatorIdentifier: cred.operatorIdentifier, secret: cred.secret,
      // production uses the configured endpoint/verify path; these are injectable for tests.
      transport: opts.transport, endpoint: opts.endpoint, verifyPath: opts.verifyPath,
    });
  } catch (_) {
    v = { status: 'unverified', message: 'Could not reach the provider to test the login right now.' };
  }
  const status = v && v.status ? v.status : 'unverified';
  await markStatus(userId, provider.id, status);
  const row = (await db.query(
    `SELECT last_verified_at FROM user_credit_credentials WHERE user_id=$1 AND provider_id=$2`, [userId, provider.id])).rows[0];
  // A test-tuned message: when the vendor gives no ok/invalid (no probe endpoint
  // configured, or unreachable), say so plainly rather than "verified on first use".
  const message = status === 'ok' ? 'Login verified with the provider.'
    : status === 'invalid' ? 'The provider rejected this login — re-enter it.'
    : 'Could not verify the login right now — it will be checked automatically on your next pull.';
  return { ok: status === 'ok', status, message, lastVerifiedAt: row ? row.last_verified_at : null, providerId: provider.id };
}

module.exports = { listForUser, setForUser, removeForUser, getUsable, markStatus, verifyForUser, cleanIdentifier };
