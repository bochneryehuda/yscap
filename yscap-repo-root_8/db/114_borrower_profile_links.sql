-- ============================================================================
-- 114_borrower_profile_links.sql
--
-- Staff-granted links between two borrower profiles that legitimately share
-- one email (owner-directed 2026-07-15 night, Reuven Steimetz): a spouse
-- pair (borrower + co-borrower) or a same-person duplicate profile. The
-- "Allow — same email for both" action on a 'Shared email — two borrowers'
-- sync-review card writes BOTH directions here; the borrower portal's
-- OWN_FILE_SQL predicate (src/routes/borrower.js) then lets a login on
-- either profile see BOTH people's files. Links never merge the profiles —
-- each person keeps their own identity, and profile-scoped data (LLCs,
-- track record) stays per-profile.
--
-- Additive + idempotent: safe to re-run on every boot.
-- ============================================================================
CREATE TABLE IF NOT EXISTS borrower_profile_links (
    borrower_id        uuid NOT NULL REFERENCES borrowers(id) ON DELETE CASCADE,
    linked_borrower_id uuid NOT NULL REFERENCES borrowers(id) ON DELETE CASCADE,
    reason             text NOT NULL DEFAULT 'shared_email_allowed',
    created_by         uuid REFERENCES staff_users(id),
    created_at         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (borrower_id, linked_borrower_id),
    CHECK (borrower_id <> linked_borrower_id)
);
CREATE INDEX IF NOT EXISTS idx_borrower_profile_links_linked
  ON borrower_profile_links(linked_borrower_id);
