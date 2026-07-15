/**
 * Per-file shared reply-to address helpers (#68).
 *
 * A file notification email carries a Reply-To of
 *   file+<applicationId>@<CHAT_REPLY_DOMAIN>
 * so that ANY reply (from staff or the borrower) lands at one address that the
 * inbound webhook fans out to every active assignee on that file. The domain is
 * NEVER hardcoded — it comes from CHAT_REPLY_DOMAIN via cfg.chatReplyDomain (the
 * same env var that switches on external-chat reply-by-email, #75).
 *
 * This module intentionally depends ONLY on config so it can be required by
 * notify.js AND email/catalog.js without a circular dependency (notify.js already
 * requires email/catalog.js). The heavier retrieval/forwarding logic lives in
 * lib/file-inbox.js.
 */
const cfg = require('../config');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Build the per-file reply-to address, or null when it shouldn't be set:
 *   - no inbound domain configured (CHAT_REPLY_DOMAIN unset) → email still sends,
 *     just without a reply-to (identical to today), OR
 *   - applicationId isn't a real application UUID (e.g. a non-file notification).
 */
function fileReplyTo(applicationId) {
  if (!cfg.chatReplyDomain) return null;
  const id = String(applicationId || '').trim().toLowerCase();
  if (!UUID_RE.test(id)) return null;
  return `file+${id}@${cfg.chatReplyDomain}`;
}

/**
 * Extract the applicationId from a `file+<uuid>@<domain>` recipient address,
 * matched CASE-INSENSITIVELY. Returns null for any address that isn't a
 * well-formed file address on the configured reply domain (malformed local part,
 * non-UUID id, or wrong domain) — the caller then silently ignores it.
 */
function applicationIdFromRecipient(addr) {
  const m = String(addr || '').trim().toLowerCase().match(/^file\+([^@\s]+)@([^@\s]+)$/);
  if (!m) return null;
  const id = m[1];
  const domain = m[2];
  // If a reply domain is configured, the address must be on it. (When unset the
  // route is dormant anyway, but stay strict about the local-part shape.)
  if (cfg.chatReplyDomain && domain !== cfg.chatReplyDomain) return null;
  return UUID_RE.test(id) ? id : null;
}

module.exports = { fileReplyTo, applicationIdFromRecipient, UUID_RE };
