'use strict';
/**
 * A PILOT LINK INSTEAD OF AN ATTACHMENT (owner-directed 2026-08-14; db/549).
 *
 * When a document genuinely cannot be made small enough to email, the fallback is a link that takes
 * the recipient straight to the PDF. The owner's own ordering, kept here because it is a judgement
 * and not a technical preference: **compression is tried first and a link is the second choice** —
 * *"just give a double warning that the person may not be able to open it, and we should rather try
 * compressing it"*. An outside recipient, a capital partner especially, may simply not open a link
 * that arrived from a system they do not recognise, and their mail security may rewrite or strip
 * it. On the borrower side the same link is far safer (they already live in PILOT), which is why
 * the owner asked for it there in particular.
 *
 * THE TOKEN IS THE WHOLE AUTHORIZATION, exactly as the borrower's draw reply_token is — so it is
 * built to the same standard and given three limits a logged-in download does not need:
 *   · 128 bits of randomness, and NOT derived from any id, so it publishes nothing internal and
 *     cannot be walked from one document to the next;
 *   · an EXPIRY, so a forwarded email is not a permanent hole; and
 *   · a REVOKE, plus a counted, timestamped record of every open — which is the only thing that can
 *     ever answer the question the double warning raises: did they actually get it?
 *
 * IT NEVER SERVES A DOCUMENT BY ID. The link carries its OWN storage reference. That is not
 * incidental: a `documents` row can be superseded and re-pointed, and a link that quietly begins
 * serving different bytes than the recipient was told about is worse than a dead one. It also lets
 * a link stand for bytes that are deliberately NOT a document at all — the compressed copy of our
 * draw report that the delivery email builds at send time and never files, because filing it would
 * supersede the full-quality report on the file.
 *
 * Every function here is best-effort about logging and strict about access: a failure to record an
 * open never denies a legitimate recipient their document, and no failure anywhere hands out bytes.
 */

const crypto = require('crypto');
const db = require('../../db');
const cfg = require('../../config');
const storage = require('../storage');

// Long enough for an investor to fund a draw and for a borrower to come back to it; short enough
// that a forwarded email stops working within a sensible window.
const DEFAULT_EXPIRY_DAYS = Math.max(1, Number(process.env.SHARE_LINK_EXPIRY_DAYS) || 30);
// A hard ceiling so a caller cannot mint an effectively permanent public link by passing a big
// number — changing this is a deliberate decision, not a parameter at a call site.
const MAX_EXPIRY_DAYS = Math.max(DEFAULT_EXPIRY_DAYS, Number(process.env.SHARE_LINK_MAX_EXPIRY_DAYS) || 180);

/** 128 bits, hex. Lowercase so it survives being retyped out of an email. */
function mintToken() { return crypto.randomBytes(16).toString('hex'); }

/** The absolute URL a recipient clicks. Short on purpose — it is printed in an email body. */
function shareUrl(token) {
  const base = String(cfg.appUrl || '').replace(/\/+$/, '');
  return `${base}/d/${token}`;
}

/**
 * Mint a link.
 *
 * Pass EITHER `documentId` + the document's own storage reference, OR raw `buf` for bytes that are
 * not a filed document (they are written to storage under their own reference, never as a
 * `documents` row).
 *
 * Returns { id, token, url, expiresAt, filename, bytes } — or null when it could not be created.
 * NEVER throws: a link is a fallback, and a fallback that can break the send it is rescuing is
 * worse than no fallback at all.
 */
async function createShareLink(p) {
  const o = p || {};
  try {
    const filename = String(o.filename || 'document.pdf').slice(0, 200);
    let ref = o.storageRef || null;
    let provider = o.storageProvider || null;
    let size = Number(o.sizeBytes) || null;

    if (!ref) {
      if (!o.buf || !o.buf.length) return null;
      const saved = await storage.save(o.buf, { filename });
      if (!saved || !saved.ref) return null;
      ref = saved.ref; provider = saved.provider; size = o.buf.length;
    }

    const days = Math.min(MAX_EXPIRY_DAYS, Math.max(1, Number(o.expiresDays) || DEFAULT_EXPIRY_DAYS));
    const token = mintToken();
    const row = (await db.query(
      `INSERT INTO document_share_links
         (token, application_id, document_id, storage_provider, storage_ref, filename, content_type,
          size_bytes, purpose, label, created_by, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now() + ($12 || ' days')::interval)
       RETURNING id, token, expires_at`,
      [token, o.applicationId || null, o.documentId || null, provider, ref, filename,
        o.contentType || 'application/pdf', size, o.purpose || null,
        o.label ? String(o.label).slice(0, 200) : null, o.createdBy || null, String(days)])).rows[0];
    if (!row) return null;
    return {
      id: row.id, token: row.token, url: shareUrl(row.token),
      expiresAt: row.expires_at, filename, bytes: size, label: o.label || filename,
    };
  } catch (_) { return null; }
}

/**
 * Resolve a token for the public door.
 *
 * Returns { ok:true, row } or { ok:false, code } with `code` one of unknown | expired | revoked.
 * The three are told apart ON PURPOSE: an EXPIRED link has a real remedy the recipient can act on
 * ("ask us to send it again") while an unknown token does not, and telling somebody holding a
 * genuinely expired link that it never existed sends them chasing the wrong thing. This leaks
 * nothing — you cannot reach either answer without already holding a 128-bit token.
 */
async function resolveShareToken(token) {
  const t = String(token || '').trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(t)) return { ok: false, code: 'unknown' };
  let row;
  try {
    row = (await db.query(
      `SELECT id, token, application_id, document_id, storage_provider, storage_ref, filename,
              content_type, size_bytes, purpose, label, expires_at, revoked_at
         FROM document_share_links WHERE token = $1`, [t])).rows[0];
  } catch (_) {
    // A database problem is OUR failure, not a bad link — say so, so nobody is told their
    // perfectly good link is invalid and gives up on it.
    return { ok: false, code: 'unavailable' };
  }
  if (!row) return { ok: false, code: 'unknown' };
  if (row.revoked_at) return { ok: false, code: 'revoked' };
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return { ok: false, code: 'expired' };
  return { ok: true, row };
}

/** Read the bytes a link stands for. null when they cannot be read. Never throws. */
async function readShareBytes(row) {
  try {
    if (!row || !row.storage_ref) return null;
    const buf = await storage.read(row.storage_ref);
    return buf && buf.length ? buf : null;
  } catch (_) { return null; }
}

/**
 * Record an open. Best-effort and deliberately AFTER the bytes are served — a counter that fails
 * must never cost a recipient their document, which is the entire point of the link.
 */
async function recordOpen(id, ip) {
  try {
    await db.query(
      `UPDATE document_share_links
          SET opened_count = opened_count + 1,
              first_opened_at = COALESCE(first_opened_at, now()),
              last_opened_at = now(),
              last_opened_ip = $2
        WHERE id = $1`, [id, ip ? String(ip).slice(0, 60) : null]);
  } catch (_) { /* best-effort */ }
}

/** Turn a link off now. Returns true when a live link was actually revoked. */
async function revokeShareLink(id, staffId) {
  try {
    const r = await db.query(
      `UPDATE document_share_links SET revoked_at = now(), revoked_by = $2
        WHERE id = $1 AND revoked_at IS NULL RETURNING id`, [id, staffId || null]);
    return !!r.rowCount;
  } catch (_) { return false; }
}

/** Every link ever minted on a file, newest first — "what have we shared, and did anyone open it?". */
async function linksForApplication(appId, limit = 50) {
  try {
    return (await db.query(
      `SELECT id, token, filename, label, purpose, size_bytes, created_at, created_by,
              expires_at, revoked_at, opened_count, first_opened_at, last_opened_at
         FROM document_share_links
        WHERE application_id = $1
        ORDER BY created_at DESC LIMIT $2`, [appId, Math.min(200, Math.max(1, limit))])).rows
      .map((r) => ({ ...r, url: shareUrl(r.token) }));
  } catch (_) { return []; }
}

/**
 * THE DOUBLE WARNING, in one place so every surface says the same thing (owner-directed:
 * *"just give a double warning that the person may not be able to open it, and we should rather try
 * compressing it"*). Two distinct warnings, not one worded twice — the first is about the
 * recipient, the second is about the choice being made.
 */
const LINK_WARNINGS = [
  'The recipient may never open it. A link from a system they do not recognise can look like spam, and their mail security may strip or rewrite it — an attachment always arrives, a link has to be trusted and clicked.',
  'Anyone who has the link can open the document until it expires or you revoke it. Try compressing the document first; send a link only when it genuinely cannot be made to fit.',
];

module.exports = {
  createShareLink, resolveShareToken, readShareBytes, recordOpen, revokeShareLink,
  linksForApplication, shareUrl, mintToken,
  LINK_WARNINGS, DEFAULT_EXPIRY_DAYS, MAX_EXPIRY_DAYS,
};
