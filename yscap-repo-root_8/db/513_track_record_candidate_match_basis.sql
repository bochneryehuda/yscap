-- ============================================================================
-- 513 — A CANDIDATE RECORDS HOW IT MATCHED THE BORROWER.
--
-- The owner (2026-08-10), on the public-records search — a "MAJOR enhancement":
-- "Every single record should come up: why you matched it, how you matched it …
-- we should have a personal name and the entity name … if you find properties
-- related to any entity on the profile but you see a lot of different people's
-- names and you don't see our borrower's name, set up a high-level warning that
-- it's matching the entity but not the personal name."
--
-- The staging table recorded WHAT was found (the deeds, the figures) and whether
-- it already matched a line on the record (match_track_record_id / match_why),
-- but nothing about HOW it tied back to the borrower — by their personal name,
-- by a company on the profile, or by a company whose people do NOT include them
-- (the same-name-different-company case the owner wants flagged pending).
--
-- match_basis is that reasoning, computed at STAGE time from the search branch
-- and the entity's associated-people list (src/lib/track-record/match-basis.js)
-- and rendered on every candidate. It is ADVISORY: a warning is shown, nothing
-- is ever auto-declined ("it should not decide by her own that it's out of the
-- footprint").
--
-- Idempotent, additive. Reads nothing, deletes nothing. Legacy candidates keep
-- a NULL basis and simply render without the badge until the next search
-- re-stages them.
-- ============================================================================

ALTER TABLE track_record_candidates
  ADD COLUMN IF NOT EXISTS match_basis jsonb;

COMMENT ON COLUMN track_record_candidates.match_basis IS
  'How this candidate matched the borrower: {personalMatched, entityMatched, personalName, '
  'entityName, basis (personal|both|entity_only), warn, why}. Computed at stage time from the '
  'search branch + the entity''s associated people. Advisory — a warning is shown, never an '
  'auto-decline. NULL on candidates staged before db/513.';
