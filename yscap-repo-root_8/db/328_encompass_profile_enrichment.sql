-- ============================================================================
-- 328_encompass_profile_enrichment.sql
--
-- ENCOMPASS BUILDS THE PROFILE — and its disagreements go to manual review
-- (owner-directed 2026-07-26).
--
-- The weekly Encompass pass is READ-ONLY toward Encompass and only ever ADDS to
-- a borrower's profile (extra entities, extra properties, extra phone numbers
-- and email addresses). The ONE thing it can genuinely disagree with us about is
-- the person's PRIMARY HOME ADDRESS, which the owner asked to verify against the
-- most recent file — and a disagreement must "come up in the manual review
-- section" rather than be applied or dropped.
--
-- `sync_review_queue` was built for ClickUp ↔ PILOT, and every resolver branch
-- assumes the other side is a ClickUp task it can re-read live. A row from a
-- THIRD system must be distinguishable, or the resolver would try to fetch a
-- ClickUp task that does not exist. Hence `source`:
--   'clickup'   — every existing row (the default, so nothing changes)
--   'encompass' — a read-only enrichment disagreement; the winner is
--                 'encompass' or 'portal', and NOTHING is ever written back to
--                 Encompass.
--
-- Additive + idempotent: safe to re-run on every boot.
-- ============================================================================

ALTER TABLE sync_review_queue ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'clickup';

-- 'encompass' JOINS the existing winners — it does not replace them. 'custom'
-- (db/112, the reviewer typing the right answer when NEITHER side is correct)
-- must stay listed or every custom resolution starts failing its check.
-- Encompass itself is NEVER written to: winning as 'encompass' means "adopt the
-- value Encompass already holds INTO PILOT".
ALTER TABLE sync_review_queue DROP CONSTRAINT IF EXISTS sync_review_queue_winner_check;
ALTER TABLE sync_review_queue ADD CONSTRAINT sync_review_queue_winner_check
  CHECK (winner IS NULL OR winner IN ('clickup', 'portal', 'custom', 'encompass'));

-- The reviews list filters and counts by source, and the enrichment pass looks up
-- its own open rows to avoid re-queueing a disagreement a human is already
-- looking at.
CREATE INDEX IF NOT EXISTS idx_sync_review_source
  ON sync_review_queue(source, borrower_id) WHERE status = 'open';

-- Where each accumulated email / phone came from is already recorded in
-- `borrower_contacts.source` ('clickup:<task>', 'merge', now 'encompass:<guid>')
-- — no schema change needed there, only this index so "everything Encompass
-- contributed" is answerable without a full scan.
CREATE INDEX IF NOT EXISTS idx_borrower_contacts_source ON borrower_contacts(source);
