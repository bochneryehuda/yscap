-- ============================================================================
-- 347 — The As-Is READ: what PILOT found, where it found it, and what it did
--       with it (owner-directed 2026-07-28).
--
-- The owner: *"OCR should click Control F on the PDF appraisal and look for the
--  As is value, and if he's confident that he found that as is value and the as
--  is value is less than the final purchase price he should overwrite the as is
--  value in file and post the condition that he reduced the asset's value based
--  on his OCR reading … you should allow within the condition to have a field
--  that should be only an internal condition … where you can see how much
--  data's value came in and you can overwrite … if you can't read it you should
--  write on the note that you can't confidently read the AS IS and a human
--  should read the AS IS and enter the as is value to clear the condition."*
--
-- The READING is a fact about the APPRAISAL, so it lives on the appraisals row —
-- one current appraisal, one reading, superseded together with it by a re-import.
-- The condition (appraisal_as_is_verify, seeded in db/137) is the human-facing
-- surface; it reads these columns through GET /api/appraisal/:id/as-is.
--
-- NOTHING here changes a value on its own. The write rule lives in
-- src/lib/appraisal/as-is-reader.js `decideAsIsApply` and is deliberately
-- one-directional: a reading may FILL a blank As-Is or LOWER an existing one,
-- never raise it, never on a frozen (term-sheet-sent / clear-to-close / funded)
-- file, and never when the reading is not confident.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS + a guarded template re-assert).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- (1) The reading, on the appraisal it came from.
-- ---------------------------------------------------------------------------
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS as_is_read_value      numeric(14,2);
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS as_is_read_source     text;   -- xml | pdf_text | pdf_ai
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS as_is_read_confidence text;   -- definite | high | low
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS as_is_read_quote      text;   -- the exact wording it was read from
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS as_is_read_engine     text;   -- azure-docint | google-docai | mistral-ocr | ocr-space
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS as_is_read_at         timestamptz;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS as_is_read_detail     jsonb;  -- the ladder's step-by-step trail

-- What PILOT DID with the reading.
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS as_is_applied         boolean NOT NULL DEFAULT false;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS as_is_applied_value   numeric(14,2);
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS as_is_file_value_before numeric(14,2);
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS as_is_skip_reason     text;   -- why it was NOT applied

-- The human's answer, when an officer types the As-Is on the condition.
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS as_is_confirmed_value numeric(14,2);
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS as_is_confirmed_by    uuid REFERENCES staff_users(id);
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS as_is_confirmed_at    timestamptz;

-- The boot sweep (previous AND future rule) resumes from here: a current
-- appraisal with a NULL as_is_read_at has never been read, so the sweep drains
-- naturally as it stamps each one.
CREATE INDEX IF NOT EXISTS idx_appraisals_as_is_unread
  ON appraisals (imported_at DESC)
  WHERE superseded = false AND as_is_read_at IS NULL;

-- ---------------------------------------------------------------------------
-- (2) The condition now covers BOTH outcomes, so its stock wording must too.
--     db/137 seeded it for the "we could not read it" case only. The per-file
--     hint + note are rewritten per instance by the desk (as-is-reader
--     buildAsIsHint / buildAsIsNote); this is the template default a brand-new
--     instance starts from, and the label a staffer sees in the conditions list.
--     Instances already on files are NOT touched (their hint is per-instance and
--     the desk refreshes it on the next read).
-- ---------------------------------------------------------------------------
UPDATE checklist_templates
   SET label = 'Confirm the As-Is value on the appraisal',
       hint  = 'PILOT reads the As-Is value from the appraisal — first the data file (XML), then the '
               || 'report PDF with OCR and AI. If it read one confidently and it is below the purchase '
               || 'price, it lowered the As-Is on the file and this condition is your re-review. If it '
               || 'could not read one confidently, nothing was filled in — read the As-Is off the report '
               || 'and enter it here to clear this condition.',
       is_active = true
 WHERE code = 'appraisal_as_is_verify';
