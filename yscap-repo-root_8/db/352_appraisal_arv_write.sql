-- ============================================================================
-- 352 — The ARV is written onto the file from the appraisal, and the condition
--       now covers BOTH values (owner-directed 2026-07-28).
--
-- The owner: *"once the appraisal is being imported we also want you to add that
--  the ARV value should be rewritten in our file according to the appraisal —
--  we already have logic and XML of the appraisal finding that reads the ARV
--  value that I'm much more highly confident about, and we don't even need OCR
--  for it. So again: import and rewrite in our file the ARV value, and try to
--  find an XML as-is value or look on OCR, and if you're not confident just ask
--  from the human."*
--
-- The ARV is the EASY one, which is why it gets no ladder at all: a MISMO
-- appraisal has ONE structured `PropertyAppraisedValueAmount`, and on a
-- subject-to (renovation) report that figure IS the after-repair value.
-- `extract.js` already resolves it and marks it `definite` — it was recovered
-- from all 33 files in the research corpus. A definite XML ARV is written; a
-- non-definite one is left alone. No OCR, no AI.
--
-- Same guards as the As-Is, none of them about direction: the file must not be
-- frozen, a human must not have already settled the number (an `arv_mismatch`
-- finding resolved keep/custom), the appraisal must match the property, and it
-- must be a real change. A write reopens Products & Pricing (db/071/072), so the
-- loan is re-sized by a person and never by this.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS + a guarded template re-assert).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- (1) What PILOT did with the appraisal's ARV, on the appraisal it came from —
--     mirroring the As-Is columns in db/351 so both values read the same way.
-- ---------------------------------------------------------------------------
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS arv_applied           boolean NOT NULL DEFAULT false;
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS arv_applied_value     numeric(14,2);
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS arv_file_value_before numeric(14,2);
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS arv_skip_reason       text;

-- ---------------------------------------------------------------------------
-- (2) The condition covers BOTH values now, so its stock label/hint says so.
--     The per-file hint + note are still rewritten per instance by the desk
--     (as-is-reader buildAsIsHint / buildAsIsNote); this is what a brand-new
--     instance starts from and what a staffer reads in the conditions list.
--     Deliberately does NOT touch is_active — an admin who deactivates this
--     template must not have it switched back on by the next deploy.
-- ---------------------------------------------------------------------------
UPDATE checklist_templates
   SET label = 'Confirm the appraisal''s values (As-Is and ARV)',
       hint  = 'PILOT reads the appraisal''s values and writes them onto the file. The ARV comes '
               || 'straight from the appraisal data file (that figure is the appraisal''s own headline '
               || 'value, so no OCR is involved). The As-Is is looked for in the data file first, then '
               || 'in the report PDF with OCR and AI — and it is only written when PILOT is confident. '
               || 'If it could not read the As-Is confidently, nothing was filled in: read it off the '
               || 'report and enter it here to clear this condition.'
 WHERE code = 'appraisal_as_is_verify'
   -- …and only while the template still carries the wording a previous deploy wrote. Without this
   -- the re-assert silently reverts an admin's edit to the label or hint on every single boot.
   AND (label IS DISTINCT FROM 'Confirm the appraisal''s values (As-Is and ARV)'
        OR hint NOT LIKE 'PILOT reads the appraisal%');
