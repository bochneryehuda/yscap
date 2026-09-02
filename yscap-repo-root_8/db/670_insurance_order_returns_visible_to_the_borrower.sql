-- ============================================================================
-- db/670 — insurance order returns visible to the borrower
--
-- WHAT THIS CHANGES, AND WHY. Documents an insurance agent sends back on an order
-- (the quote, the binder, the invoice) are filed against the file's internal
-- insurance condition and were stamped visibility='staff_only' — the same stamp a
-- title return gets, which exists to keep a title company's wiring instructions
-- away from a borrower. The owner (2026-09-01): "The insurance documents that are
-- coming in, the borrower should be able to see that on their document section,
-- even though it's only an internal condition." The borrower's document library
-- filters on documents.visibility, so this flips the INSURANCE returns already on
-- file to 'borrower'. Going forward order-inbox files them that way (its
-- returnVisibility). Title returns are untouched.
--
-- IDEMPOTENT: an UPDATE whose WHERE excludes rows already flipped.
--
-- BACKFILL: yes — this IS the backfill (the owner's standing "previous AND future"
-- rule). Scoped to doc_kind = 'insurance_order_return' only.
--
-- PRODUCT SEPARATION: RTL only (documents is an RTL table).
-- ============================================================================

UPDATE documents
   SET visibility = 'borrower'
 WHERE doc_kind = 'insurance_order_return'
   AND visibility = 'staff_only';
