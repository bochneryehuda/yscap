/**
 * Checklist ⇄ ClickUp status translation — pure module, no DB/HTTP.
 *
 * The portal's document conditions (checklist_items.status) map to a set of
 * ClickUp dropdown fields (F.CHECKLIST). Portal statuses are one of:
 *   outstanding | requested | received | satisfied | issue
 * ClickUp option shapes differ per field:
 *   - "full-5" fields (title, insurance, contract, assignment, reo, assets):
 *     requested | received | satisfied | issue | outstanding
 *   - rehabBudget: requested | received | issue | receivedUploaded
 *     (NO satisfied option — "receivedUploaded" is the terminal/satisfied state;
 *      NO outstanding option)
 *   - signedTermSheet: requested | received | issue
 *     (NO satisfied, NO outstanding — "received" is the terminal state)
 *
 * resolveOutbound = portal status -> the option to write (+ the token it reads
 * back as). normalizeInbound = an option UUID -> the portal status. Anything
 * without a real option returns null (we NEVER invent an option id).
 *
 * NOTE: this module only translates values. It performs no I/O and, critically,
 * contains NO enqueue/push — the pull path (ingest.applyChecklistStatuses) uses
 * only normalizeInbound + shouldApplyInbound and writes solely to the portal DB.
 */
const F = require('./fields');

// Reverse of F.CHECKLIST, keyed by the ClickUp field id:
//   { [fieldId]: { key: 'contract', options: { requested: uuid, ... } } }
const BY_FIELD = {};
for (const [key, def] of Object.entries(F.CHECKLIST)) {
  BY_FIELD[def.fieldId] = { key, options: def.options };
}

// Forward-progress rank. 'issue' is orthogonal (not ranked) — handled explicitly.
const RANK = { outstanding: 0, requested: 1, received: 2, satisfied: 3 };

const PASS_THROUGH = new Set(['outstanding', 'requested', 'received', 'satisfied', 'issue']);

/**
 * Portal status -> { optionUUID, token } to write to ClickUp, or null when the
 * field has no option for that status (a legitimate skip — e.g. rehabBudget /
 * signedTermSheet have no "outstanding" option). `token` is the portal status
 * the written option reads back as via normalizeInbound (so callers can detect
 * whether the value will round-trip cleanly).
 *
 *   full-5:          status -> its own option (token = status)
 *   rehabBudget:     outstanding->null, satisfied->receivedUploaded (token 'satisfied')
 *   signedTermSheet: outstanding->null, satisfied->received (token 'received')
 */
function resolveOutbound(fieldId, portalStatus) {
  const entry = BY_FIELD[fieldId];
  if (!entry) return null;
  const o = entry.options;
  switch (portalStatus) {
    case 'issue':
      return o.issue ? { optionUUID: o.issue, token: 'issue' } : null;
    case 'requested':
      return o.requested ? { optionUUID: o.requested, token: 'requested' } : null;
    case 'received':
      return o.received ? { optionUUID: o.received, token: 'received' } : null;
    case 'outstanding':
      // full-5 only; rehabBudget/signedTermSheet have no outstanding option -> skip.
      return o.outstanding ? { optionUUID: o.outstanding, token: 'outstanding' } : null;
    case 'satisfied':
      if (o.satisfied) return { optionUUID: o.satisfied, token: 'satisfied' };          // full-5
      if (o.receivedUploaded) return { optionUUID: o.receivedUploaded, token: 'satisfied' }; // rehabBudget
      if (o.received) return { optionUUID: o.received, token: 'received' };              // signedTermSheet
      return null;
    default:
      return null; // unknown portal status -> never invent
  }
}

/**
 * A ClickUp option UUID -> the portal status it represents, or null.
 * option-key 'receivedUploaded' -> 'satisfied'; the five canonical keys pass
 * through; anything unrecognized -> null.
 */
function normalizeInbound(fieldId, optionUUID) {
  const entry = BY_FIELD[fieldId];
  if (!entry || !optionUUID) return null;
  let optKey = null;
  for (const [k, uuid] of Object.entries(entry.options)) {
    if (uuid === optionUUID) { optKey = k; break; }
  }
  if (!optKey) return null;
  if (optKey === 'receivedUploaded') return 'satisfied';
  return PASS_THROUGH.has(optKey) ? optKey : null;
}

/**
 * Authority / no-downgrade rule (portal is the system of record). Given an
 * inbound (ClickUp) status and the current portal status, decide whether to
 * apply the inbound value. Never downgrade; skip when equal; 'issue' is sticky.
 *   forward = RANK[inbound] > RANK[cur]
 *   apply iff forward OR inbound==='issue' OR (cur==='issue' && forward)
 */
function shouldApplyInbound(inbound, cur) {
  if (!inbound || inbound === cur) return false;
  const forward = RANK[inbound] > RANK[cur];
  return forward || inbound === 'issue' || (cur === 'issue' && forward);
}

module.exports = { BY_FIELD, RANK, resolveOutbound, normalizeInbound, shouldApplyInbound };
