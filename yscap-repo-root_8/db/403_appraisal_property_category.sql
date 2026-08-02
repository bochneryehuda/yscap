-- 403 — THE APPRAISAL'S PROPERTY TYPE IS A CATEGORY, NOT AN ATTACHMENT STYLE
--
-- Owner-reported 2026-08-02, quoting the data-comparison row: "Property type | Detached | Multi 2–4
-- … you're taking the property type from the wrong place … we need you to find if on the appraisal
-- it's a single family, or a 2–4, or a condo."
--
-- `appraisals.property_type` has always held `PROPERTY/STRUCTURE/@AttachmentType`, whose entire
-- controlled value list is Detached / Attached — a statement about whether the building touches its
-- neighbour, which says nothing about how many dwellings it holds. That one value fed the Appraisal
-- tab, the tie-out matrix / Data comparison, and the document-review desk's appraisal column.
--
-- Going forward the importer writes the real CATEGORY into `property_type` (in the portal's own
-- vocabulary — "SFR (1 unit)" / "Multi 2–4" / "Condo" / …) plus the canonical key in
-- `property_category`, and parks the style in its own column so the fact is kept, never guessed at
-- and never again read as a property type.
--
-- PREVIOUS FILES are repaired by `src/lib/appraisal/property-category-heal.js` at boot, NOT here:
-- the derivation reads the form, the unit count and the ownership signals together, and a PL/pgSQL
-- twin of it would drift from the live JavaScript exactly the way `pilot_term_norm` /
-- `pilot_property_type_norm` are documented to. One definition, in JS, used by the importer, the
-- repair and every read surface.
--
-- Idempotent.

ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS property_category text;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS attachment_type text;

COMMENT ON COLUMN appraisals.property_type IS
  'The property CATEGORY in the portal vocabulary (SFR (1 unit) / Multi 2-4 / Multi 5+ / Condo / Townhouse / PUD / Mixed use), derived by lib/appraisal/property-category.js from the form + unit count + ownership signals. NULL when the appraisal does not say. Never the attachment style.';
COMMENT ON COLUMN appraisals.property_category IS
  'The canonical key behind property_type (sfr / multi_2_4 / multi_5_plus / condo / townhouse / pud / mixed_use). Also the drain marker for the boot repair.';
COMMENT ON COLUMN appraisals.attachment_type IS
  'MISMO PROPERTY/STRUCTURE/@AttachmentType — Detached / Attached. A STYLE, never a property type; kept so the appraiser''s statement is not lost.';

-- The repair walks rows that have not been re-derived yet; keep that scan cheap on a big table.
CREATE INDEX IF NOT EXISTS idx_appraisals_property_category_null
  ON appraisals (imported_at DESC)
  WHERE property_category IS NULL;
