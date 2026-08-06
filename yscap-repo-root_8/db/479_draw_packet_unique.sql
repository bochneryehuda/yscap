-- ============================================================================
-- 479_draw_packet_unique.sql — DB backstop against a duplicate draw-packet row
--
-- The draw-packet Excel (owner-directed 2026-08-06) is stored as a `documents`
-- row under a DETERMINISTIC, content-hashed filename
-- (pilot-draw-<num>-packet-<loanslug>-<hash>.xlsx, doc_kind='draw_packet') so it
-- mirrors into the per-draw SharePoint folder. Two concurrent filings of the SAME
-- unchanged packet compute the same filename; the in-code idempotency is a
-- check-then-insert, which two interleaving requests can both pass and duplicate
-- the row — and `backfillDrawPacketsOnce` runs at boot on EVERY Render instance
-- with no cross-instance lock, so a multi-instance boot can race. This PARTIAL
-- unique index is the real backstop; storeDrawPacketDoc catches the violation and
-- reuses the winner's row (mirrors uq_documents_draw_report in db/171).
--
-- Partial (only the packet kind) so it never constrains ordinary uploads.
-- Idempotent. 'draw_packet' is a brand-new kind, so no pre-existing rows can make
-- creating it fail on a duplicate.
-- ============================================================================
CREATE UNIQUE INDEX IF NOT EXISTS uq_documents_draw_packet
  ON documents(application_id, doc_kind, filename)
  WHERE doc_kind = 'draw_packet';
