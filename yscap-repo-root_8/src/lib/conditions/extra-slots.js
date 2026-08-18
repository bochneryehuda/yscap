'use strict';
/**
 * EXTRA NAMED DOCUMENT SLOTS ON A CONDITION (db/578, owner-directed 2026-08-18,
 * verbatim: "you got one document and you wanna request another document within
 * that condition … the document that he sent, you accepted it, but you don't
 * wanna sign off this condition [and] you don't wanna go post a brand new
 * underwriting condition for it. The same way the appraisal condition has two
 * slots — on conditions that don't have two slots open, there should be a button
 * for the staff members to open up another slot in a condition and type the name
 * of that slot. That should populate as an open item needing it. If it's on an
 * external condition, it should populate as an open item needing from external.
 * If it's internal, it should be open as an item from internal. … When that
 * document is uploaded, it should be uploaded as part of the condition, included
 * in the same folder of the TPR export.")
 *
 * ONE definition of everything about an ad-hoc slot:
 *   - the SHAPE (checklist_items.extra_slots jsonb: [{key,label,audience,
 *     added_by,added_by_name,added_at}]) and its validation;
 *   - the ATOMIC append (one guarded UPDATE — a duplicate label on the same item
 *     is refused inside the statement, so two clicks can never open two copies);
 *   - REOPENING a signed-off condition when a new slot is asked of it (the
 *     stamps clear with an [auto] note; the condition is genuinely open again);
 *   - the SIGN-OFF GATE (an extra slot with no current ACCEPTED document under
 *     its label refuses the sign-off, naming the slot and who asked for it —
 *     the same accepted-only standard db/424 set for the template slots);
 *   - the borrower's STILL-NEEDED view (external slots only, computed against
 *     any CURRENT document — once they upload, it reads "in review", not a nag).
 *
 * A document FILLS an extra slot exactly the way it fills a template slot: its
 * documents.slot_label base-label (the " (2)" duplicate suffix stripped) equals
 * the slot's label, case-insensitively. That is what lets the whole existing
 * slot UI, the per-slot upload/drop, the unslotted-document assignment picker,
 * the TPR export folder (same checklist_item → same category) and the
 * SharePoint mirror inherit the feature with no second machinery.
 */
const db = require('../../db');

const AUDIENCES = Object.freeze(['external', 'internal']);
const MAX_SLOTS = 12;   // a condition carrying more than a dozen ad-hoc asks is a workflow smell, not a slot list

const baseLabel = (v) => String(v == null ? '' : v).replace(/ \(\d+\)$/, '').trim().toLowerCase();

/** The normalized slot list off an item row. Never throws; junk reads as []. */
function normalize(raw) {
  const arr = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const s of arr) {
    if (!s || typeof s !== 'object') continue;
    const label = String(s.label || '').trim();
    if (!label) continue;
    out.push({
      key: String(s.key || baseLabel(label)),
      label,
      audience: AUDIENCES.includes(s.audience) ? s.audience : 'internal',
      added_by: s.added_by || null,
      added_by_name: s.added_by_name || null,
      added_at: s.added_at || null,
    });
  }
  return out;
}

/** Validate a requested slot. '' when clean, else the plain-language refusal. */
function slotProblem(b = {}) {
  const label = String(b.label == null ? '' : b.label).trim();
  if (!label) return 'Name the document you are requesting (e.g. "Updated operating agreement", "October bank statement").';
  if (label.length > 80) return 'Keep the document name under 80 characters.';
  if (!AUDIENCES.includes(String(b.audience || ''))) return 'Say who provides it — the borrower (external) or the internal team.';
  return '';
}

/**
 * Open a slot on a condition — ATOMIC: the duplicate-label check runs inside the
 * UPDATE, so two simultaneous clicks cannot open two copies. When the condition
 * was already SIGNED OFF (the owner's own scenario — the first document was
 * accepted), the sign-off is cleared with an [auto] note so the new ask is a
 * genuinely open item again. Returns { added, reopened, slot } or { added:false,
 * reason } (duplicate / cap / not-found).
 */
async function addSlot(appId, itemId, { label, audience, actorId = null, actorName = null }, client = db) {
  const slot = {
    key: `${baseLabel(label)}-${Date.now().toString(36)}`,
    label: String(label).trim(),
    audience,
    added_by: actorId, added_by_name: actorName || null,
    added_at: new Date().toISOString(),
  };
  const r = await client.query(
    `UPDATE checklist_items ci
        SET extra_slots = COALESCE(ci.extra_slots, '[]'::jsonb) || $3::jsonb, updated_at = now()
      WHERE ci.id = $1 AND ci.application_id = $2
        AND jsonb_array_length(COALESCE(ci.extra_slots, '[]'::jsonb)) < $4
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(ci.extra_slots, '[]'::jsonb)) e
           WHERE lower(btrim(e->>'label')) = lower(btrim($5)))
      RETURNING ci.id, ci.status, ci.signed_off_at, ci.waived_at`,
    [itemId, appId, JSON.stringify([slot]), MAX_SLOTS, slot.label]);
  if (!r.rows[0]) {
    // Say WHY: cap, duplicate, or a wrong id — the caller renders the reason.
    const cur = await client.query(
      `SELECT extra_slots FROM checklist_items WHERE id=$1 AND application_id=$2`, [itemId, appId]);
    if (!cur.rows[0]) return { added: false, reason: 'not_found' };
    const existing = normalize(cur.rows[0].extra_slots);
    if (existing.some((s) => baseLabel(s.label) === baseLabel(slot.label))) return { added: false, reason: 'duplicate' };
    if (existing.length >= MAX_SLOTS) return { added: false, reason: 'too_many' };
    return { added: false, reason: 'not_found' };
  }
  const row = r.rows[0];
  let reopened = false;
  if (row.status === 'satisfied' || row.signed_off_at || row.waived_at) {
    // A NEW ask reopens the condition — the sign-off that stood was made before
    // this slot existed. The [auto] note says exactly why (appended once).
    const note = `[auto] Reopened — a new document was requested on this condition: "${slot.label}". Sign off again once it is in and accepted.`;
    await client.query(
      `UPDATE checklist_items
          SET status='requested', signed_off_by=NULL, signed_off_at=NULL, waived_by=NULL, waived_at=NULL,
              notes = CASE WHEN notes IS NULL OR notes='' THEN $2
                           WHEN notes LIKE '%' || $2 || '%' THEN notes
                           ELSE notes || E'\n' || $2 END,
              updated_at=now()
        WHERE id=$1`, [itemId, note]);
    reopened = true;
  } else if (audience === 'external') {
    // An external ask reads as REQUESTED from the borrower (their portal's
    // "we asked you for something" state); an internal ask keeps the working status.
    await client.query(
      `UPDATE checklist_items SET status='requested', updated_at=now()
        WHERE id=$1 AND status='outstanding'`, [itemId]);
  }
  return { added: true, reopened, slot };
}

/**
 * Remove a slot — only an UNFILLED one (a slot with a document in it is a record;
 * reject/delete the document first). Returns { removed } or { removed:false, reason }.
 */
async function removeSlot(appId, itemId, key, client = db) {
  const cur = (await client.query(
    `SELECT extra_slots FROM checklist_items WHERE id=$1 AND application_id=$2`, [itemId, appId])).rows[0];
  if (!cur) return { removed: false, reason: 'not_found' };
  const slots = normalize(cur.extra_slots);
  const slot = slots.find((s) => s.key === String(key));
  if (!slot) return { removed: false, reason: 'not_found' };
  const filled = (await client.query(
    `SELECT 1 FROM documents
      WHERE checklist_item_id=$1 AND is_current
        AND lower(btrim(regexp_replace(COALESCE(slot_label,''), ' \\(\\d+\\)$', ''))) = lower(btrim($2))
      LIMIT 1`, [itemId, slot.label])).rows[0];
  if (filled) return { removed: false, reason: 'filled' };
  const next = slots.filter((s) => s.key !== slot.key);
  await client.query(
    `UPDATE checklist_items SET extra_slots = $3::jsonb, updated_at=now() WHERE id=$1 AND application_id=$2`,
    [itemId, appId, JSON.stringify(next)]);
  return { removed: true, slot };
}

/** Per-slot fill state against an item's documents (any current / accepted-only). */
function fillOf(slot, docs) {
  const want = baseLabel(slot.label);
  const inSlot = (docs || []).filter((d) => d && d.is_current !== false && baseLabel(d.slot_label) === want);
  return {
    any: inSlot.length > 0,
    accepted: inSlot.some((d) => String(d.review_status || 'pending') === 'accepted'),
  };
}

/**
 * THE SIGN-OFF GATE ARM — every condition, every kind: an extra slot without a
 * current ACCEPTED document under its label refuses the sign-off, naming the
 * slot and who asked (the whole point: "the system should understand that as an
 * outstanding thing"). Fails OPEN on a read error — a DB hiccup must never make
 * a condition permanently unsignable (the same posture as every other gate arm).
 */
async function gateProblem(itemId, client = db) {
  try {
    const it = (await client.query(
      `SELECT extra_slots FROM checklist_items WHERE id=$1`, [itemId])).rows[0];
    if (!it) return null;
    const slots = normalize(it.extra_slots);
    if (!slots.length) return null;
    const docs = (await client.query(
      `SELECT slot_label, COALESCE(review_status,'pending') AS review_status
         FROM documents WHERE checklist_item_id=$1 AND is_current`, [itemId])).rows;
    const missing = slots.filter((s) => !fillOf(s, docs).accepted);
    if (!missing.length) return null;
    const names = missing.map((s) => `"${s.label}"${s.added_by_name ? ` (requested by ${s.added_by_name})` : ''}`).join(', ');
    return `This condition has ${missing.length === 1 ? 'a requested document' : 'requested documents'} still outstanding — ${names}. `
      + 'Upload it into its slot and accept it (or remove the request) before signing off.';
  } catch (_) { return null; }
}

/** The borrower's still-needed labels: EXTERNAL slots with no current document yet. */
function stillNeededExternal(rawSlots, docs) {
  return normalize(rawSlots)
    .filter((s) => s.audience === 'external' && !fillOf(s, docs).any)
    .map((s) => s.label);
}

module.exports = { AUDIENCES, MAX_SLOTS, normalize, slotProblem, addSlot, removeSlot, fillOf, gateProblem, stillNeededExternal, baseLabel };
