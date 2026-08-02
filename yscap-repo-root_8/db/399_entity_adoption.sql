-- ============================================================================
-- 399 — ADOPT AN OUTSIDE ENTITY ONTO THE BORROWER'S PROFILE
--       (owner-directed 2026-08-02: "when he is finding assets on a different
--        LLC it's not major fraud — you just don't have the LLC documents for
--        that LLC. Give a button on that finding to add this LLC to the
--        borrower profile so it's safe for always and we can always see he has
--        this LLC on his record, then suggest posting a condition to ask for
--        entity documents to allow him to use this LLC.")
--
-- Two additive pieces, both idempotent:
--
-- 1. PROVENANCE ON `llcs`. An entity added from a bank-statement finding is a
--    NAME we read off a statement — nobody has yet proven the borrower owns it.
--    Stamping WHERE it came from is what lets the liquidity engine keep that
--    entity's balances OUT of the qualifying total until its entity documents
--    land (src/lib/underwriting/file-view.js -> bank-liquidity.js). Without the
--    stamp, adding the name would silently flip those funds into the borrower's
--    provable liquidity the moment somebody pressed the button — the exact
--    over-count the different-LLC finding exists to prevent. NULL on every
--    entity that already exists and on every entity typed in by a human, so
--    nothing about previous files changes.
--
-- 2. THE CONDITION THE FINDING PROPOSES. `rtl_cond_entity_docs` is the real,
--    application-scoped template the finding's "Post the condition" button
--    materializes. It replaces a broken pointer: the suggestion previously
--    proposed `rtl_llc_opagmt`, which is scope='llc' — and the convert-to-
--    condition route only instantiates scope='application' templates, so every
--    click 400'd with "unknown template rtl_llc_opagmt".
--    auto_apply='manual' — the rules engine never posts it on its own; it exists
--    so a human's click has something real to attach.
-- ============================================================================

-- 1. Where an entity came from, when PILOT proposed it rather than a human.
ALTER TABLE llcs ADD COLUMN IF NOT EXISTS adopted_from_application_id uuid REFERENCES applications(id) ON DELETE SET NULL;
ALTER TABLE llcs ADD COLUMN IF NOT EXISTS adopted_at     timestamptz;
ALTER TABLE llcs ADD COLUMN IF NOT EXISTS adopted_source text;   -- e.g. 'bank_statement_finding'

CREATE INDEX IF NOT EXISTS idx_llcs_adopted
  ON llcs (borrower_id)
  WHERE adopted_at IS NOT NULL;

-- 2. The entity-documents condition the different-entity finding proposes.
INSERT INTO checklist_templates
  (code, label, scope, audience, item_kind, applies_loan_type, role_scope, phase,
   sort_order, category, hint, borrower_label, borrower_hint, clickup_field_id,
   tpr_exclude, slots, is_active, auto_apply)
SELECT 'rtl_cond_entity_docs',
       'Entity documents — the business whose bank funds are being used',
       'application', 'both', 'document', 'rtl', 'processor', '3',
       435, 'prior_to_approval',
       'The borrower is showing funds in an account held by a business that is not the vesting entity. Collect that entity''s OPERATING AGREEMENT (borrower as managing member or 25%+ owner), its ARTICLES OF ORGANIZATION (formation) and its IRS EIN letter, so the borrower''s control of the account is documented. Add the entity to the borrower''s profile at the same time so it is on their record for future files.',
       'Company documents for the business account you are using',
       'You are showing money held in a business account. So we can count those funds, please upload that company''s Operating Agreement, its Articles of Organization (the state formation certificate) and its IRS EIN letter — together they show you own and control the company.',
       NULL,
       false, NULL, true, 'manual'
 WHERE NOT EXISTS (SELECT 1 FROM checklist_templates WHERE code = 'rtl_cond_entity_docs');

-- Re-assert the definition on every boot (never touches instances already on files).
UPDATE checklist_templates
   SET label      = 'Entity documents — the business whose bank funds are being used',
       audience   = 'both',
       item_kind  = 'document',
       auto_apply = 'manual',
       is_active  = true
 WHERE code = 'rtl_cond_entity_docs';
