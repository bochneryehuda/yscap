'use strict';

/*
 * Every document slot on a condition keeps EVERY document (owner-directed). When a
 * plain ADD lands on a slot that already holds a document, the two must not display
 * under one identical label — so this makes the incoming label unique among the
 * item's current documents: "Insurance binder" → "Insurance binder (2)",
 * "Document 2" → "Document 2 (2)", and so on. Only ever appends a numeric suffix;
 * never renames an existing document. Case-insensitive collision test.
 *
 * Deliberately a no-op for a replace (the caller only invokes it on a plain add):
 * an explicit replace supersedes one document, so its label is meant to match.
 */

async function uniqueSlotLabel(checklistItemId, wantedRaw, client) {
  const wanted = String(wantedRaw || '').trim().slice(0, 80);
  if (!wanted || !checklistItemId) return wanted || null;
  if (!client) client = require('../db');   // lazy — keeps this module pg-free for pure tests
  let taken;
  try {
    const ex = await client.query(
      `SELECT lower(slot_label) AS s FROM documents
        WHERE checklist_item_id=$1 AND is_current=true AND slot_label IS NOT NULL`,
      [checklistItemId]);
    taken = new Set(ex.rows.map((r) => r.s));
  } catch (_) {
    // Never break an upload over a label-uniqueness lookup — fall back to the
    // wanted label as-is (a duplicate display label is cosmetic; a lost upload
    // is not).
    return wanted;
  }
  if (!taken.has(wanted.toLowerCase())) return wanted;
  for (let n = 2; n < 1000; n++) {
    const cand = `${wanted} (${n})`.slice(0, 80);
    if (!taken.has(cand.toLowerCase())) return cand;
  }
  return wanted;
}

module.exports = { uniqueSlotLabel };
