-- An Encompass home-address conflict is now looked up by the PERSON, not by the
-- Encompass loan it happened to arrive on (2026-07-28): the pass reads the
-- borrower's prior address rows and compares them by MEANING, so a decision a
-- human already made survives a newly-mirrored loan and a re-rendered address
-- string. That lookup runs once per borrower per enrichment pass, so give it an
-- index instead of a sequential scan of the whole queue.
--
-- Idempotent; no data is changed.
CREATE INDEX IF NOT EXISTS idx_sync_review_borrower_field
  ON sync_review_queue (borrower_id, field_key);
