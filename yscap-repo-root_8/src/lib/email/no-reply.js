'use strict';
/**
 * THE NO-REPLY FAMILY — one definition (owner-directed 2026-08-26).
 *
 * The standing rule (owner-directed 2026-07-20, restated 2026-08-26: "No email
 * should come from a no-reply because it technically IS a reply — every email
 * that is going out from our system has a special, unique reply-to address") is
 * that PILOT's emails are genuinely repliable, so the SENDER must never claim
 * otherwise. The code default for NOTIFY_FROM has been a monitored address
 * since 2026-07-20 — but the production Render DASHBOARD value can override it
 * (and did: no-reply@yscapgroup.com), and a mail client displays the FROM
 * header, not the Reply-To, so every email READ as no-reply however carefully
 * the reply-to was wired. Nothing enforced the rule against the environment.
 *
 * This module is that enforcement's vocabulary: which local parts mean
 * "do not reply", and how to repair a From that carries one (rewrite the LOCAL
 * PART to a monitored one, keep the domain — for Resend only the DOMAIN must be
 * verified, so the rewrite is deliverability-neutral — and keep the display
 * name). PURE: no requires, no config, so config.js can consume it with no
 * cycle and lib/thread-participants.js can share the family list.
 */

// Local parts that announce "replies go nowhere". Compared on letters only
// (separators stripped), so no-reply / noreply / no_reply / do-not-reply /
// donotreply / dont-reply all read as one family.
const NO_REPLY_LOCALS = ['noreply', 'donotreply', 'dontreply', 'noresponse'];

/** "Name <addr@x>" | "addr@x" → { name, local, domain } (null when unreadable). */
function parseFrom(from) {
  const s = String(from == null ? '' : from).trim();
  if (!s) return null;
  const m = /^(.*?)<([^<>]+@[^<>]+)>\s*$/.exec(s);
  const addr = (m ? m[2] : s).trim();
  const at = addr.lastIndexOf('@');
  if (at <= 0 || at === addr.length - 1) return null;
  return {
    name: m ? m[1].trim().replace(/^"|"$/g, '').trim() : '',
    local: addr.slice(0, at),
    domain: addr.slice(at + 1),
  };
}

/** Is this From (display form or bare address) a no-reply-family sender? */
function isNoReplyAddress(from) {
  const p = parseFrom(from);
  if (!p) return false;
  const key = p.local.toLowerCase().replace(/[^a-z]/g, '');
  return NO_REPLY_LOCALS.includes(key);
}

/**
 * Repair a no-reply From: same display name, same (verified) domain, monitored
 * local part. A From that is not in the family comes back untouched.
 *   repairNoReplyFrom('PILOT <no-reply@x.com>') →
 *     { from: 'PILOT <notifications@x.com>', changed: true }
 */
function repairNoReplyFrom(from, { replacementLocal = 'notifications' } = {}) {
  if (!isNoReplyAddress(from)) return { from, changed: false };
  const p = parseFrom(from);
  const addr = `${replacementLocal}@${p.domain}`;
  return { from: p.name ? `${p.name} <${addr}>` : addr, changed: true };
}

module.exports = { NO_REPLY_LOCALS, isNoReplyAddress, repairNoReplyFrom, parseFrom };
