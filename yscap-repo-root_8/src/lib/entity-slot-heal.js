'use strict';
/**
 * THE ENTITY-DOCUMENT SLOTS SAY WHAT THIS ENTITY IS ACTUALLY ASKED FOR —
 * RE-ASSERTED ON EVERY BOOT (owner-directed 2026-08-09).
 *
 * A corporation is asked for its BYLAWS AND STOCK CERTIFICATE where an LLC is
 * asked for an operating agreement, and PILOT carries that wording on the
 * per-entity checklist ITEM because there is one shared template and one item per
 * entity — the template cannot say both things at once. `llc.applyEntitySlotWording`
 * is the one place that decides the wording.
 *
 * WHY THIS EXISTS AS A BOOT PASS. **db/033 copies the TEMPLATE's borrower wording
 * back down onto every item made from these three templates, on EVERY boot.** That
 * is correct for an LLC — the template says exactly what an LLC needs — and wrong
 * for every other type, whose item was deliberately re-worded. Migrations are
 * never edited in this repo, and the numeric-ordering trick (a later migration
 * that re-asserts the converged state, the db/374 pattern) would mean writing the
 * wording table a SECOND time in SQL, where it would drift from the JavaScript
 * the moment either changed — the `pilot_term_norm` / `pilot_property_type_norm`
 * trap this repo has already been bitten by twice. So the repair is JavaScript
 * that calls the SAME function every other caller does, and runs after the
 * migrations.
 *
 * SCOPED TO THE ENTITIES THAT CAN DISAGREE. An `llc` entity's correct wording IS
 * the template's, so db/033 doing its thing to those rows is a no-op and they are
 * never selected — which keeps this pass tiny for the whole back book (db/509
 * stamped every existing entity `llc`) and means it does real work only for the
 * handful of corporations, partnerships and trusts that exist.
 *
 * Bounded, idempotent, never throws — a cosmetic wording pass must not be able to
 * fail a boot. Off with ENTITY_SLOT_HEAL_DISABLED=1.
 */

const db = require('../db');

const DEFAULT_LIMIT = 200;

async function healEntitySlotWordingOnce({ limit = DEFAULT_LIMIT } = {}) {
  if (String(process.env.ENTITY_SLOT_HEAL_DISABLED || '') === '1') {
    return { skipped: true, reason: 'disabled' };
  }
  const out = { checked: 0, updated: 0, entities: 0, failed: 0 };
  try {
    const llcLib = require('./llc');
    const ET = require('./entity-type');
    // Only the types whose wording differs from the template's. An unrecognised
    // stored value is left alone rather than guessed at — it cannot have been
    // written by any door we own (the column has a CHECK), so a row carrying one
    // is a hand edit or a future type, and neither is ours to rewrite.
    const r = await db.query(
      `SELECT id FROM llcs
        WHERE entity_type IS NOT NULL
          AND entity_type <> $1
          AND entity_type = ANY($2::text[])
        ORDER BY updated_at DESC NULLS LAST
        LIMIT $3`,
      [ET.DEFAULT_TYPE, ET.KEYS.filter((k) => k !== ET.DEFAULT_TYPE), Math.max(1, limit)]);
    out.entities = r.rows.length;
    for (const row of r.rows) {
      out.checked += 1;
      const res = await llcLib.applyEntitySlotWording(row.id);
      if (res && res.failed) out.failed += 1;
      out.updated += (res && res.updated) || 0;
    }
    if (out.updated) {
      console.log(`[entity-slot-heal] re-worded ${out.updated} document slot(s) across ${out.entities} non-LLC entit${out.entities === 1 ? 'y' : 'ies'}`);
    }
    return out;
  } catch (e) {
    // Never noisy-fail a boot over wording, but never silent either: a slot
    // asking a corporation for an operating agreement is invisible from here.
    console.warn('[entity-slot-heal] pass failed:', e && e.message);
    return { ...out, error: true };
  }
}

module.exports = { healEntitySlotWordingOnce };
