'use strict';
/**
 * THE GENERIC REQUIRED-DOCUMENT-SLOTS ARM OF THE SIGN-OFF GATE.
 *
 * PORTED OUT OF THE LONG-TERM BUILD (`src/longterm/conditions-center/write.js`
 * `missingSlots`), which had something the short-term side does not: a condition
 * that declares its own required slots and a gate that reads them. RTL states the
 * same rule three times by hand inside `signOffGate` — insurance needs a binder
 * AND an invoice, the appraisal needs an XML AND a PDF, fraud needs a background
 * report — so a fourth two-slot condition means a fourth `if`. This is that rule
 * said once, from data.
 *
 * ── IT CHANGES NOTHING FOR RTL, AND NOT BY BEING CAREFUL ────────────────────
 *
 * It reads `checklist_items.slots` — the PER-ITEM list (db/653) — and nothing
 * else. RTL writes that column nowhere, so every RTL item reads `null`, and
 * `null` returns "no slots, no problem" on the first line. The behaviour is
 * identical because the input is empty, which is a fact about the data rather
 * than a promise about a code path.
 *
 * READING THE TEMPLATE'S SLOTS INSTEAD WOULD HAVE BEEN A LIVE BEHAVIOUR CHANGE,
 * and this is the whole reason the column exists. Three RTL templates already
 * carry a `slots` list, and for two of them the hard-coded arm is deliberately
 * NOT "every slot is required":
 *
 *   · `rtl_cond_fraud` carries background + criminal, and the criminal report is
 *     required ONLY on a Gold Standard file. A generic template-slots gate would
 *     have demanded it on every file.
 *   · `rtl_cond_appraisaldocs` carries xml + pdf, and the "No XML available"
 *     waiver (owner-directed 2026-07-29) lifts the XML while keeping the PDF. A
 *     generic template-slots gate would have refused every waived file.
 *
 * So the hard-coded arms stay exactly where they are and keep owning those four
 * conditions; this arm serves the conditions that carry their own list.
 *
 * ── WHAT COUNTS AS FILLED ───────────────────────────────────────────────────
 *
 * A CURRENT, ACCEPTED document whose `slot_label` matches the slot. ACCEPTED,
 * not merely "not rejected" — the owner's 2026-08-03 rule, and the incident
 * behind it was an insurance condition signed off on a previous policy's binder
 * that nobody had ever opened. Matching is on the base label (the " (2)"
 * duplicate suffix stripped, case-insensitively) via `extra-slots.baseLabel`, so
 * this arm and the extra-slots arm can never disagree about what "filled" means.
 * A document labelled with the slot's KEY counts too — RTL's own hard-coded arms
 * already treat the key as a fill (they test `slot.includes('binder')`).
 */

const db = require('../../db');
const { baseLabel } = require('./extra-slots');

/** The normalized required-slot list off an item's `slots` column. Junk reads as []. */
function normalize(raw) {
  const arr = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const s of arr) {
    if (!s || typeof s !== 'object') continue;
    const key = String(s.key == null ? '' : s.key).trim();
    const label = String(s.label == null ? '' : s.label).trim();
    if (!key && !label) continue;
    // REQUIRED BY DEFAULT. A slot list is a list of what the condition needs;
    // `required: false` is the deliberate exception, and defaulting the other way
    // would turn a typo into a condition that gates on nothing.
    out.push({ key: key || label, label: label || key, required: s.required !== false });
  }
  return out;
}

/** Does this document fill this slot? */
function fills(slot, doc) {
  if (!doc || doc.is_current === false) return false;
  const want = baseLabel(doc.slot_label);
  if (!want) return false;
  return want === baseLabel(slot.label) || want === baseLabel(slot.key);
}

/**
 * Which required slots still have no ACCEPTED document — PURE, so the whole
 * decision is unit-testable without a Postgres.
 *
 * @param {Array} slots — the item's `slots` column, raw.
 * @param {Array} docs  — [{slot_label, review_status, is_current}]
 * @returns {string[]} the human labels of the slots still waiting.
 */
function missingSlots(slots, docs) {
  const required = normalize(slots).filter((s) => s.required);
  if (!required.length) return [];
  const accepted = (docs || []).filter((d) => d && d.is_current !== false
    && String(d.review_status || 'pending') === 'accepted');
  return required.filter((s) => !accepted.some((d) => fills(s, d))).map((s) => s.label);
}

/** The refusal wording, in the Long-Term gate's own words — kept verbatim so the
    message a person reads does not change as the code moves house. */
const missingSlotsMsg = (labels) => `Still waiting on: ${labels.join(', ')}.`;

/**
 * The gate arm. Returns null when clear, or a plain-language refusal.
 *
 * FAILS OPEN on a read error, like every other arm of this gate: a database
 * hiccup must never make a condition permanently unsignable.
 */
async function gateProblem(itemId, client = db) {
  try {
    const it = (await client.query(
      `SELECT slots FROM checklist_items WHERE id=$1`, [itemId])).rows[0];
    if (!it) return null;
    const required = normalize(it.slots).filter((s) => s.required);
    if (!required.length) return null;   // the RTL case, every time
    const docs = (await client.query(
      `SELECT slot_label, COALESCE(review_status,'pending') AS review_status, is_current
         FROM documents WHERE checklist_item_id=$1 AND is_current`, [itemId])).rows;
    const missing = missingSlots(it.slots, docs);
    if (!missing.length) return null;
    return missingSlotsMsg(missing);
  } catch (_) { return null; }
}

module.exports = { normalize, fills, missingSlots, missingSlotsMsg, gateProblem };
