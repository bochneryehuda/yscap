-- ============================================================================
-- db/652 — THE LONG-TERM LOAN BECOMES A FOURTH OWNER OF THE ONE CONDITION CENTER
--
-- WHAT THIS CHANGES, AND WHY. The owner ordered the parallel Long-Term condition
-- build deleted and the REAL Condition Center shared (2026-08-30, recorded with
-- their quoted words in docs/longterm/SHARE-THE-CODE-DIRECTIVE.md and in the
-- crossing ledger): "I gave you written authorization to bring that exact
-- Condition Center over here. Take that exact Condition Center and make your
-- conditions in that Condition Center follow those rules." The Condition Center
-- was multi-owner from day one — checklist_templates/checklist_items carry a
-- scope of application / borrower_profile / llc with EXACTLY ONE owner column
-- set (chk_one_owner), and documents carries the same three nullable owners.
-- This file adds the FOURTH owner: scope 'lt_loan', owner column lt_loan_id.
-- That one move is what makes the sharing structural: one templates table, one
-- items table, one documents table, one upload/review path, one SharePoint
-- mirror, one backup — and every RTL selector is already scope-filtered
-- (engine: scope='application'; generateChecklist: scope IN
-- ('application','borrower_profile') / scope='llc'), so an lt_loan row is
-- invisible to every RTL pass by construction, and the reverse.
--
-- PRODUCT SEPARATION. This is the authorized crossing itself, not a leak: the
-- 2026-08-30 share-the-code grant in docs/LONG-TERM-AUTHORIZED-COPIES.md is the
-- owner's written authorization for exactly this. Long-Term loans STAY in
-- lt_loans — nothing here puts a Long-Term loan into applications; the FK points
-- the other way (a condition/document row may now belong to an lt_loan).
--
-- BACKFILL: none, deliberately. No row changes meaning; the new columns are
-- NULL on every existing row and the widened CHECKs admit exactly what they
-- admitted before plus the new scope. Rows with scope='lt_loan' are written
-- only by the Long-Term routes that land with this shipment.
-- ============================================================================

-- ── checklist_items: the fourth owner ───────────────────────────────────────
ALTER TABLE checklist_items ADD COLUMN IF NOT EXISTS lt_loan_id uuid;

-- DELIBERATELY NO FOREIGN KEY. The separation gate refuses an RTL table
-- gaining an FK to a Long-Term table, and it is right to: a hard FK would weld
-- the side build to the main product (a rebuild or drop of the Long-Term side
-- would then touch RTL's biggest tables). lt_loan_id is a bare uuid the
-- Long-Term code interprets; Long-Term loans are never hard-deleted (the trash
-- system parks them), and the Long-Term delete path owns cleaning up any rows
-- that point at a loan it removes.

CREATE INDEX IF NOT EXISTS idx_checklist_lt_loan
  ON checklist_items (lt_loan_id) WHERE lt_loan_id IS NOT NULL;

-- The scope CHECK was born inline in db/schema.sql (auto-named
-- <table>_<column>_check) and no other migration re-asserts it, so widening it
-- under its own name is a plain drop + re-add with every value named.
ALTER TABLE checklist_items DROP CONSTRAINT IF EXISTS checklist_items_scope_check;
ALTER TABLE checklist_items
  ADD CONSTRAINT checklist_items_scope_check
  CHECK (scope IN ('application', 'borrower_profile', 'llc', 'lt_loan'));

-- EXACTLY ONE owner, now out of four. Same name, same shape, one more term —
-- and no other migration re-asserts chk_one_owner (verified: db/075 and db/504
-- only mention it in prose), so this is the standing definition from here on.
ALTER TABLE checklist_items DROP CONSTRAINT IF EXISTS chk_one_owner;
ALTER TABLE checklist_items
  ADD CONSTRAINT chk_one_owner CHECK (
      (application_id IS NOT NULL)::int
    + (borrower_id    IS NOT NULL)::int
    + (llc_id         IS NOT NULL)::int
    + (lt_loan_id     IS NOT NULL)::int = 1
  );

-- ── checklist_templates: lt_loan-scoped templates ───────────────────────────
-- A template with scope='lt_loan' is structurally invisible to the RTL engine
-- (it selects scope='application') and to generateChecklist (application /
-- borrower_profile / llc) — the scope column IS the product separation here,
-- by the table's own original design.
ALTER TABLE checklist_templates DROP CONSTRAINT IF EXISTS checklist_templates_scope_check;
ALTER TABLE checklist_templates
  ADD CONSTRAINT checklist_templates_scope_check
  CHECK (scope IN ('application', 'borrower_profile', 'llc', 'lt_loan'));

-- ── documents: the fourth denormalized owner ────────────────────────────────
-- documents' owners were always nullable and denormalized (application_id /
-- borrower_id / llc_id, db/schema.sql:263) — llc-owned rows with no application
-- have filed and mirrored since day one. lt_loan_id joins them; the SharePoint
-- mirror's pendingBatch already selects every row with a storage_ref, so an
-- lt_loan document mirrors through the SAME pipeline (its folder resolution
-- learns the scope in the same shipment), and the off-site backup already
-- copies the whole bucket.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS lt_loan_id uuid;

-- Same rule as above: a bare uuid, no FK — the gate forbids the weld.

CREATE INDEX IF NOT EXISTS idx_documents_lt_loan
  ON documents (lt_loan_id) WHERE lt_loan_id IS NOT NULL;
