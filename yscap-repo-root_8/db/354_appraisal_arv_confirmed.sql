-- ============================================================================
-- 354 — An officer can enter the ARV by hand, and that decision is recorded
--       (owner-directed 2026-07-28, closing an audit finding).
--
-- db/353 gave PILOT the ability to rewrite `applications.arv` from the
-- appraisal, but gave a human no matching way to correct it and no place to
-- record that they had. The As-Is has had both since db/352
-- (`as_is_confirmed_*` + the box on the condition); these are its ARV twin, so
-- the two values are protected the same way and the condition can offer both.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS).
-- ============================================================================
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS arv_confirmed_value numeric(14,2);
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS arv_confirmed_by    uuid REFERENCES staff_users(id);
ALTER TABLE appraisals ADD COLUMN IF NOT EXISTS arv_confirmed_at    timestamptz;
