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
  // No configured reply domain = the whole inbound feature is DORMANT: never
  // extract an id from an address on some other domain (round-2 audit — the old
  // "route is dormant anyway" assumption did not hold for non-production envs).
  if (!cfg.chatReplyDomain) return null;
  const m = String(addr || '').trim().toLowerCase().match(/^file\+([^@\s]+)@([^@\s]+)$/);
  if (!m) return null;
  const id = m[1];
  const domain = m[2];
  if (domain !== cfg.chatReplyDomain) return null;
  return UUID_RE.test(id) ? id : null;
}

/**
 * Per-ORDER reply-to address (#orders). A title / insurance order emails the
 * vendor with a UNIQUE reply-to so the vendor's reply — and any documents they
 * send back — land on the RIGHT order (title docs → the title order, insurance
 * docs → the insurance order), not just the generic file inbox:
 *   title+<applicationId>@<domain>   /   insurance+<applicationId>@<domain>
 * Returns null under the same conditions as fileReplyTo (no domain / bad id / bad
 * kind), so the order email still sends — just without order-scoped inbound.
 */
function orderReplyTo(applicationId, kind) {
  if (!cfg.chatReplyDomain) return null;
  const k = String(kind || '').trim().toLowerCase();
  if (k !== 'title' && k !== 'insurance') return null;
  const id = String(applicationId || '').trim().toLowerCase();
  if (!UUID_RE.test(id)) return null;
  return `${k}+${id}@${cfg.chatReplyDomain}`;
}

/**
 * Parse a `title+<uuid>@<domain>` / `insurance+<uuid>@<domain>` recipient into
 * { applicationId, orderType }, or null when it isn't a well-formed order address
 * on the configured reply domain. Matched case-insensitively.
 */
function orderRefFromRecipient(addr) {
  if (!cfg.chatReplyDomain) return null;
  const m = String(addr || '').trim().toLowerCase().match(/^(title|insurance)\+([^@\s]+)@([^@\s]+)$/);
  if (!m) return null;
  const orderType = m[1];
  const id = m[2];
  const domain = m[3];
  if (domain !== cfg.chatReplyDomain) return null;
  return UUID_RE.test(id) ? { applicationId: id, orderType } : null;
}

module.exports = { fileReplyTo, applicationIdFromRecipient, orderReplyTo, orderRefFromRecipient, UUID_RE };
