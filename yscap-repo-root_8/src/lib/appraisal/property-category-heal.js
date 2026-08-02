'use strict';
/**
 * PREVIOUS FILES REPAIR — re-read the property CATEGORY on appraisals that were imported while
 * `appraisals.property_type` was being filled with the MISMO attachment STYLE.
 *
 * The owner's standing "previous AND future" rule. Going forward the importer derives the real
 * category (lib/appraisal/property-category.js) and stores the style in its own column. Every
 * appraisal already on disk still reads "Detached" / "Attached" in the property-type column — which
 * is what the Appraisal tab prints, what the tie-out matrix compares, and what the owner was
 * looking at when they reported this (2026-08-02). No front-end change can fix that: the wrong
 * value is what was stored.
 *
 * WHY IT IS JAVASCRIPT AND NOT A MIGRATION. The derivation weighs the form, the settled unit count
 * and the ownership signals together. A PL/pgSQL twin would drift from the live one — the exact
 * class of bug `pilot_term_norm` / `pilot_property_type_norm` each needed a dedicated drift test to
 * contain. There is ONE derivation and this pass calls it.
 *
 * SAFETY, in order of importance:
 *   · It only ever RE-READS what the appraisal already stored. Nothing is fetched, re-parsed or
 *     invented; the inputs are the row's own form type, unit count, design text and `fields` jsonb.
 *   · The attachment style is never destroyed — it moves to `attachment_type`, so the appraiser's
 *     statement is kept, just no longer misfiled as a property type.
 *   · It never overwrites a property_type it cannot improve on. A row whose stored value is real
 *     appraiser text (not a bare style) keeps that text when nothing can be derived.
 *   · A row it cannot read is stamped `unreadable` so a bounded pass drains instead of re-reading
 *     the same rows every boot (the `unclassified` pattern from the photo-kind backfill).
 *   · The UPDATE is pinned to the values read a moment earlier, so a concurrent re-import is never
 *     clobbered.
 *   · It never throws — a repair that cannot run must not stop a boot.
 */

const db = require('../../db');
const { fromAppraisalRow, isAttachmentStyle } = require('./property-category');

const DEFAULT_LIMIT = Number(process.env.APPRAISAL_CATEGORY_HEAL_FILES || 400) || 400;
// Written into property_category when the appraisal genuinely does not say what the property is
// (no unit count, no recognizable form). It is NOT a category — `LABEL_OF` has no such key, so
// every read surface still answers "the appraisal doesn't say"; it only drains the pass.
const UNREADABLE = 'unreadable';

/**
 * One bounded pass. Returns { looked, rederived, styleMoved, unreadable, skipped }.
 */
async function healAppraisalPropertyCategoriesOnce({ limit = DEFAULT_LIMIT } = {}) {
  const out = { looked: 0, rederived: 0, styleMoved: 0, unreadable: 0, skipped: 0 };
  let rows;
  try {
    rows = (await db.query(
      `SELECT id, form_type, units, property_type, property_category, attachment_type,
              design_style, condo_project_type, fields
         FROM appraisals
        WHERE property_category IS NULL
        ORDER BY imported_at DESC
        LIMIT $1`, [limit])).rows;
  } catch (_) {
    // A database that has not applied db/403 yet is not an error — the next boot runs it.
    return out;
  }

  for (const r of rows) {
    out.looked += 1;
    let cat = null;
    try { cat = fromAppraisalRow(r); } catch (_) { cat = null; }

    // The style only ever moves OUT of property_type — it is never invented, and a row that
    // already has it parked keeps what it has.
    const styleInTypeCol = isAttachmentStyle(r.property_type) ? String(r.property_type).trim() : null;
    const attachment = r.attachment_type != null ? r.attachment_type : styleInTypeCol;

    // What property_type should hold afterwards:
    //   · the derived category label, when we could read one;
    //   · NULL when the column is holding a bare style we cannot replace (the honest answer — the
    //     style is preserved in attachment_type);
    //   · otherwise exactly what is there now (real appraiser text we have nothing better than).
    const nextType = cat ? cat.label : (styleInTypeCol ? null : r.property_type);
    const nextCategory = cat ? cat.key : UNREADABLE;

    try {
      const w = await db.query(
        `UPDATE appraisals
            SET property_type = $2,
                property_category = $3,
                attachment_type = $4
          WHERE id = $1
            AND property_category IS NULL
            AND property_type IS NOT DISTINCT FROM $5`,
        [r.id, nextType, nextCategory, attachment, r.property_type]);
      if (!w.rowCount) { out.skipped += 1; continue; }
      if (cat) out.rederived += 1; else out.unreadable += 1;
      if (styleInTypeCol && r.attachment_type == null) out.styleMoved += 1;
    } catch (_) {
      out.skipped += 1;
    }
  }
  return out;
}

module.exports = { healAppraisalPropertyCategoriesOnce, _internals: { UNREADABLE, DEFAULT_LIMIT } };
