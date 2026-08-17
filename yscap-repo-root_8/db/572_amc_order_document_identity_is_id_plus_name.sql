-- ============================================================================
-- db/572 — amc order document identity is id plus name
--
-- WHAT THIS CHANGES, AND WHY. `amc_order_documents` said a returned AppraisalScope
-- document is identified by (order, direction, the AMC's documentId). The AMC does
-- not agree: their OWN sample RetriveAppraisalDocuments response returns two
-- different documents both carrying `documentId: "1004_XML"`, and a completed order
-- returns the appraisal report and its MISMO data file under the same id too — the
-- data file is NAMED on the report's entry (`objectXMLFileName`), not listed with an
-- id of its own, so the only thing that tells the two apart is the FILENAME.
--
-- OBSERVED: filing the second document raised
--   duplicate key value violates unique constraint "uq_amc_documents_amc_id"
-- The ingest catches per-document errors and logs them, so the effect was a returned
-- appraisal document — sometimes the data file the whole appraisal import runs on —
-- silently not landing on the file, with only a server log line saying so.
--
-- src/amc/sync.js has always tested identity as the PAIR (amc_document_id,
-- object_name); this index was the weaker half of the same rule, and the weaker one
-- is what threw. Bringing the index up to the code's identity is the fix: two entries
-- agreeing on BOTH really are the same document, which is exactly what re-polling
-- must never double-file.
--
-- IDEMPOTENT. Drop-then-create under IF EXISTS / IF NOT EXISTS, so every replay is a
-- no-op after the first. The new index is strictly WEAKER than the old one (it
-- permits everything the old one permitted, and more), so it cannot fail to build on
-- an existing database however many rows are already there.
--
-- BACKFILL: none, and none is possible. The rows that this constraint refused were
-- never written — they are lost documents, not bad rows. They come back on their own:
-- the next poll of an order re-lists the vendor's documents and files whatever is
-- missing, because the ingest's dedupe is per (id, name) and the missing document has
-- no row.
--
-- PRODUCT SEPARATION. RTL only (`amc_orders` / `amc_order_documents` are the RTL
-- appraisal-vendor tables). Nothing here touches `lt_*`.
-- ============================================================================

DROP INDEX IF EXISTS uq_amc_documents_amc_id;

-- Identity is the PAIR. COALESCE, never the bare column: two NULL names are two
-- UNKNOWNS to Postgres and would not conflict, so a document with no filename could
-- be filed again on every single poll — the runaway the index exists to prevent.
CREATE UNIQUE INDEX IF NOT EXISTS uq_amc_documents_amc_id
  ON amc_order_documents(order_id, direction, amc_document_id, COALESCE(object_name, ''))
  WHERE amc_document_id IS NOT NULL;


-- ── after this lands ────────────────────────────────────────────────────────
-- The schema map (docs/schema/) describes the database these migrations build,
-- so this file makes it stale. CI refreshes it on this pull request by itself;
-- if you would rather do it by hand, with DATABASE_URL pointing at a database
-- built from these migrations:
--
--   npm run schema:snapshot     # refresh the inventory from the database
--   npm run schema:restamp      # re-stamp the map header (no database needed)
