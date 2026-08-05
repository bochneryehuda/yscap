'use strict';
/**
 * TPO "own-Xactus" — per-firm CREDIT credentials (owner roadmap Phase 5b).
 *
 * A brokerage firm may pull credit on THEIR OWN Xactus account. This module is the
 * ONE place that:
 *   • RESOLVES the credentials for a credit pull — a TPO file whose firm has an
 *     ACTIVE credentials row uses the firm's Xactus login; every other file (retail,
 *     or a TPO firm with none configured) resolves to `null`, and the credit
 *     provider then uses our shared company account (config.xactusProd) exactly as
 *     before. So this is INERT until an admin configures a firm.
 *   • MANAGES the credentials — set / status / activate / clear. The password is
 *     encrypted at rest (crypto.encryptSecret) and is NEVER returned to any client;
 *     `status()` reports presence only.
 *
 * FLOOD is unaffected — flood is always ordered on our account (config.xactusFlood).
 * The resolved password is only ever handed to `credit/provider.pull({credentials})`
 * at the moment of a pull; it is never logged (provider.scrubCredentials strips the
 * ACTIVE login from every error/log line).
 */
const db = require('../../db');
const C = require('../crypto');

// ── RESOLVE (read; returns the decrypted login for a pull, or null → use ours) ──

/** Build the provider-shaped credentials object from a DB row (decrypts the
 *  password). Returns null if the row is incomplete or the password can't be
 *  decrypted — a broken firm row must FALL BACK to our shared account, never fail
 *  a pull. */
function credsFromRow(row) {
  if (!row) return null;
  const password = C.decryptSecret(row.password_encrypted);
  if (!password || !row.endpoint || !row.username) return null;
  return {
    endpoint: String(row.endpoint).trim().replace(/\/+$/, ''),
    username: row.username,
    password,
    account: row.account || '',
    clientId: row.client_id || '',
    version: row.version || undefined,          // undefined → provider falls back to its default (3.4)
    requestingParty: row.requesting_party || undefined,
    authMode: row.auth_mode === 'query' ? 'query' : 'basic',
    _source: 'firm',
  };
}

/** The credentials for a credit pull on this application, or null (→ our account).
 *  Only a TPO file (`is_tpo`) whose firm has an ACTIVE credentials row resolves to
 *  firm credentials; everything else is null. Never throws — a lookup failure falls
 *  back to our account. */
async function resolveForApplication(appId, dbc = db) {
  if (!appId) return null;
  try {
    const r = await dbc.query(
      `SELECT c.endpoint, c.username, c.password_encrypted, c.account, c.client_id,
              c.version, c.requesting_party, c.auth_mode
         FROM applications a
         JOIN tpo_firm_credit_credentials c
           ON c.tpo_firm_id = a.tpo_firm_id AND c.is_active = true
        WHERE a.id = $1 AND a.is_tpo = true AND a.tpo_firm_id IS NOT NULL
        LIMIT 1`, [appId]);
    return credsFromRow(r.rows[0]);
  } catch (_) { return null; }
}

/** The resolved (decrypted) credentials for a firm by id — used ONLY by the
 *  internal admin "test connection" action. Null if not configured/active. */
async function resolveForFirm(firmId, dbc = db) {
  if (!firmId) return null;
  try {
    const r = await dbc.query(
      `SELECT endpoint, username, password_encrypted, account, client_id, version, requesting_party, auth_mode
         FROM tpo_firm_credit_credentials WHERE tpo_firm_id=$1 AND is_active=true`, [firmId]);
    return credsFromRow(r.rows[0]);
  } catch (_) { return null; }
}

// ── MANAGE (internal admin) ──

function badRequest(msg) { const e = new Error(msg); e.status = 400; e.userMessage = msg; return e; }

/** Set (create or replace) a firm's Xactus credit credentials. The password is
 *  REQUIRED and stored encrypted; it is never read back. */
async function setForFirm(firmId, creds = {}, actorId = null, dbc = db) {
  const endpoint = String(creds.endpoint || '').trim().replace(/\/+$/, '');
  const username = String(creds.username || '').trim();
  const password = String(creds.password || '');
  if (!endpoint || !username || !password) {
    throw badRequest('The Xactus web address, username and password are all required to set up a firm’s own credit account.');
  }
  let u;
  try { u = new URL(endpoint); } catch (_) { throw badRequest('The Xactus web address must be a full link starting with https://.'); }
  if (u.protocol !== 'https:') throw badRequest('The Xactus web address must start with https://.');
  const authMode = /^query$/i.test(String(creds.authMode || '').trim()) ? 'query' : 'basic';
  const enc = C.encryptSecret(password);
  if (!enc) throw badRequest('Could not secure the password — check the encryption key is configured.');
  await dbc.query(
    `INSERT INTO tpo_firm_credit_credentials
       (tpo_firm_id, endpoint, username, password_encrypted, account, client_id, version, requesting_party, auth_mode, is_active, configured_by)
     VALUES ($1,$2,$3,$4,NULLIF($5,''),NULLIF($6,''),NULLIF($7,''),NULLIF($8,''),$9,true,$10)
     ON CONFLICT (tpo_firm_id) DO UPDATE SET
       endpoint=EXCLUDED.endpoint, username=EXCLUDED.username, password_encrypted=EXCLUDED.password_encrypted,
       account=EXCLUDED.account, client_id=EXCLUDED.client_id, version=EXCLUDED.version,
       requesting_party=EXCLUDED.requesting_party, auth_mode=EXCLUDED.auth_mode, is_active=true, configured_by=EXCLUDED.configured_by`,
    [firmId, endpoint, username, enc, String(creds.account || ''), String(creds.clientId || ''),
     String(creds.version || ''), String(creds.requestingParty || ''), authMode, actorId]);
}

/** Turn a firm's own-account on/off WITHOUT re-entering the password. */
async function setActiveForFirm(firmId, active, dbc = db) {
  const r = await dbc.query(
    `UPDATE tpo_firm_credit_credentials SET is_active=$2 WHERE tpo_firm_id=$1`, [firmId, !!active]);
  return r.rowCount > 0;
}

/** Remove a firm's own-account entirely (they revert to our shared account). */
async function clearForFirm(firmId, dbc = db) {
  const r = await dbc.query(`DELETE FROM tpo_firm_credit_credentials WHERE tpo_firm_id=$1`, [firmId]);
  return r.rowCount > 0;
}

/** Presence + non-secret config for the admin screen — NEVER the password. */
async function statusForFirm(firmId, dbc = db) {
  const r = await dbc.query(
    `SELECT endpoint, username, account, client_id, version, requesting_party, auth_mode, is_active,
            configured_at, updated_at, (password_encrypted IS NOT NULL) AS has_password
       FROM tpo_firm_credit_credentials WHERE tpo_firm_id=$1`, [firmId]);
  const row = r.rows[0];
  if (!row) return { configured: false, isActive: false };
  return {
    configured: true,
    isActive: row.is_active,
    endpoint: row.endpoint,
    username: row.username,
    account: row.account || '',
    clientId: row.client_id || '',
    version: row.version || null,
    requestingParty: row.requesting_party || null,
    authMode: row.auth_mode,
    hasPassword: row.has_password,
    configuredAt: row.configured_at,
    updatedAt: row.updated_at,
  };
}

module.exports = {
  resolveForApplication, resolveForFirm,
  setForFirm, setActiveForFirm, clearForFirm, statusForFirm,
  _internals: { credsFromRow },
};
