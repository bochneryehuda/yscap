-- Allow origin_kind='exception' on checklist_items (owner-directed 2026-07-22).
--
-- db/275 added the loan_exception_id tag, and the conditions/custom route stamps
-- origin_kind='exception' when a condition is created FROM an exception. But the
-- original CHECK (db/037) only allowed auto/manual_library/manual_custom, so the
-- tagged INSERT failed with 23514. Widen it to include 'exception'.
--
-- Idempotent (DROP IF EXISTS then re-ADD). Existing rows/values are unaffected —
-- this only ADDS an allowed value. Nothing reads origin_kind expecting a closed
-- set that would break on the new value (engine.js only tests ='auto';
-- draw-wire.js filters ='manual_custom' — an exception-origin condition is
-- correctly excluded from the draw-wire manual-condition query).
ALTER TABLE checklist_items DROP CONSTRAINT IF EXISTS chk_items_origin_kind;
ALTER TABLE checklist_items
  ADD CONSTRAINT chk_items_origin_kind CHECK (origin_kind IS NULL OR origin_kind IN
    ('auto','manual_library','manual_custom','exception'));
