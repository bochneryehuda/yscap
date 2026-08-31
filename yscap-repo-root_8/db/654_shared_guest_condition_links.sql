-- ============================================================================
-- 654 — THE GUEST CONDITION LINK GAINS A LONG-TERM OWNER
-- ============================================================================
--
-- `condition_links` (db/637) is the login-free way a borrower works their
-- conditions: an emailed, unguessable token that opens a jailed borrower
-- session on ONE file. The owner's sharing directive says the Condition Center
-- is ONE implementation serving both products, and this is the row that names
-- which file a link opens — so it takes a second owner rather than a second
-- table. A parallel `lt_condition_links` would be a second copy of the expiry,
-- the revocation, the single-use stamp and the path jail, and the copy is what
-- drifts.
--
-- This is the SAME shape db/652 gave `checklist_items`: one more owner column,
-- exactly one of them set per row, and the product separation carried by which
-- column is filled.
--
-- SAFE ON EVERY EXISTING ROW. `lt_loan_id` lands NULL everywhere, so every
-- link already out in somebody's inbox keeps working unchanged, and the
-- exactly-one-owner CHECK admits precisely what the NOT NULL admitted before
-- plus the new case.
-- ============================================================================

-- ── The second owner ────────────────────────────────────────────────────────
ALTER TABLE condition_links ADD COLUMN IF NOT EXISTS lt_loan_id uuid;

-- DELIBERATELY NO FOREIGN KEY, exactly as db/652 reasons for checklist_items:
-- the separation gate refuses an RTL table gaining an FK to a Long-Term table,
-- and it is right to — a hard FK would weld the side build to the main product,
-- so a rebuild or drop of the Long-Term side would touch an RTL table. It is a
-- bare uuid the Long-Term code interprets; Long-Term loans are never hard
-- deleted (the trash system parks them), and the Long-Term delete path owns
-- cleaning up rows that point at a loan it removes.

-- ── The first owner stops being mandatory ───────────────────────────────────
-- db/637 declared `application_id uuid NOT NULL`. A long-term link names no
-- application at all, so the NOT NULL becomes the exactly-one CHECK below —
-- which is strictly stronger than what it replaces, because it also refuses a
-- row owning BOTH. db/637 creates the table with CREATE TABLE IF NOT EXISTS and
-- never re-asserts the column, so this is not undone on the next boot.
ALTER TABLE condition_links ALTER COLUMN application_id DROP NOT NULL;

-- ── EXACTLY ONE owner ───────────────────────────────────────────────────────
-- Both would be a link with two jails, where whichever rule list ran first
-- would decide what the holder may reach; neither would be a link that names
-- no file. `condition-link.js` refuses both cases in JavaScript too — this is
-- the half that cannot be forgotten by a future writer.
ALTER TABLE condition_links DROP CONSTRAINT IF EXISTS condition_links_one_owner;
ALTER TABLE condition_links
  ADD CONSTRAINT condition_links_one_owner CHECK (
      (application_id IS NOT NULL)::int
    + (lt_loan_id     IS NOT NULL)::int = 1
  );

-- ── The long-term lookup ────────────────────────────────────────────────────
-- Mirrors condition_links_app_idx: the staff screen lists a file's links newest
-- first. Partial, so it costs nothing on the short-term rows.
CREATE INDEX IF NOT EXISTS condition_links_lt_idx
  ON condition_links (lt_loan_id, created_at DESC) WHERE lt_loan_id IS NOT NULL;
