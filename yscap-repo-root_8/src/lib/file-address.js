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

/* ═══════════════════ THE APPRAISAL-VENDOR MESSAGE ADDRESS ═══════════════════
   `rv+<applicationId>@<domain>` — how a Richer Values reply finds its way back to
   the order it is about.

   WHY AN ADDRESS AND NOT AN API CALL. Their API has no messaging: 31
   messaging-shaped paths were probed live on both GET and POST and every one
   answered 404. A question to their desk, a revision request and a rebuttal all
   have to travel by email, so the address IS the integration — exactly the
   position the closing chain is in.

   WHY THE FILE ID RATHER THAN AN OPAQUE TOKEN, unlike closing+. This address is
   never printed in a body for a human to retype: it rides the Reply-To of a
   message we send, so it only has to be machine-stable. It therefore follows the
   title+/insurance+ shape — a vendor order scoped to a file — and the live order
   is resolved from the file the way the Orders desk already does it. A file has at
   most one live Richer Values order, so the file id is unambiguous.
   ════════════════════════════════════════════════════════════════════════════ */

/** Build `rv+<applicationId>@<domain>`, or null when the inbound domain is unset
    or the id is not an application UUID — the message then still sends, just
    without a reply route (identical to how fileReplyTo/orderReplyTo degrade). */
function rvReplyTo(applicationId) {
  if (!cfg.chatReplyDomain) return null;
  const id = String(applicationId || '').trim().toLowerCase();
  if (!UUID_RE.test(id)) return null;
  return `rv+${id}@${cfg.chatReplyDomain}`;
}

/** Parse `rv+<uuid>@<domain>` into the application id, case-insensitively.
    Null for anything that is not a well-formed rv address on the configured
    reply domain — the caller then silently ignores that recipient. */
function rvRefFromRecipient(addr) {
  // No configured reply domain = the whole inbound feature is DORMANT. Never
  // extract an id from an address on some other domain (the round-2 audit lesson
  // recorded on applicationIdFromRecipient — "it's dormant anyway" did not hold).
  if (!cfg.chatReplyDomain) return null;
  const m = String(addr || '').trim().toLowerCase().match(/^rv\+([^@\s]+)@([^@\s]+)$/);
  if (!m) return null;
  if (m[2] !== cfg.chatReplyDomain) return null;
  return UUID_RE.test(m[1]) ? m[1] : null;
}

/* ══════════════════════════ THE CLOSING CHAIN ADDRESS ═══════════════════════
   A per-CLOSING address, and the one address family here whose local part is NOT
   the application id:
       closing+<token>@<domain>
   Three reasons the token is a random opaque value instead of the file id:
     · it is PRINTED IN THE EMAIL BODY and typed by an outside closing attorney,
       so it has to be short and must not publish an internal identifier;
     · an attorney does not reply to our order — they open a BRAND-NEW chain with
       the title company, the settlement agent and our team. Everything on that
       chain reaches the file only because they kept this address on it, so the
       address is the file's identity to the outside world and is rotatable;
     · a leaked file id would be guessable across addresses (file+/title+/…);
       a rotated token invalidates only the closing chain.

   LOWERCASE HEX on purpose. The chat+ family is base64url and therefore
   CASE-SENSITIVE, which has already caused one live regression (see
   file-inbox.chatKeyFromRecipients) — a hex token can be lowercased wholesale
   like file+/title+, and a human can retype it without ambiguity.
   ════════════════════════════════════════════════════════════════════════════ */
// 16–40 hex chars: today's tokens are 20 (80 bits); the range leaves room to
// lengthen or shorten later without breaking addresses already in the wild.
const CLOSING_TOKEN_RE = /^[0-9a-f]{16,40}$/;

/** Build `closing+<token>@<domain>`, or null when the inbound domain is unset or
    the token isn't well-formed (the caller then simply has no closing address). */
function closingReplyTo(token) {
  if (!cfg.chatReplyDomain) return null;
  const t = String(token || '').trim().toLowerCase();
  if (!CLOSING_TOKEN_RE.test(t)) return null;
  return `closing+${t}@${cfg.chatReplyDomain}`;
}

/** Extract the closing token from a recipient address, case-insensitively.
    Returns null for anything that isn't a well-formed closing address on the
    configured reply domain. Pure — resolving the token to a file is
    closing-thread.resolveByToken's job (this module stays DB-free). */
function closingTokenFromRecipient(addr) {
  if (!cfg.chatReplyDomain) return null;
  const m = String(addr || '').trim().toLowerCase().match(/^closing\+([^@\s]+)@([^@\s]+)$/);
  if (!m) return null;
  if (m[2] !== cfg.chatReplyDomain) return null;
  return CLOSING_TOKEN_RE.test(m[1]) ? m[1] : null;
}

module.exports = {
  fileReplyTo, applicationIdFromRecipient,
  orderReplyTo, orderRefFromRecipient,
  rvReplyTo, rvRefFromRecipient,
  closingReplyTo, closingTokenFromRecipient,
  UUID_RE, CLOSING_TOKEN_RE,
};
