-- =====================================================================
-- 003_autosave.sql — save-as-you-go drafts for the borrower application
-- ---------------------------------------------------------------------
-- Each in-progress application is a single draft row owned by the borrower.
-- The React wizard debounce-saves the whole form-state object into `data`
-- (jsonb) as the borrower types, so they can leave and resume on any device.
-- On submit, the draft is converted into a real applications row and the
-- draft is stamped with submitted_application_id (kept for audit, not reused).
-- Drafts never touch the live pipeline, notifications, or pricing engines.
-- =====================================================================
CREATE TABLE IF NOT EXISTS application_drafts (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    borrower_id              uuid NOT NULL REFERENCES borrowers(id) ON DELETE CASCADE,
    label                    text,                         -- property nickname / free label
    data                     jsonb NOT NULL DEFAULT '{}',  -- full form-state snapshot
    step                     integer NOT NULL DEFAULT 1,   -- wizard step the borrower is on
    submitted_application_id uuid REFERENCES applications(id) ON DELETE SET NULL,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_drafts_borrower ON application_drafts(borrower_id);
CREATE INDEX IF NOT EXISTS idx_drafts_open ON application_drafts(borrower_id) WHERE submitted_application_id IS NULL;
