-- =====================================================================
-- 012_profile_and_checklist_copy.sql
-- (a) Borrower profile: physical vs mailing address (+unit), residence
--     tenure & housing, and a profile-linked government photo ID (collected
--     once, reused on every file).
-- (b) Borrower-FACING vs internal checklist language. Templates and items get
--     borrower_label / borrower_hint columns; the borrower portal shows those
--     (falling back to the internal label/hint), staff keep the internal text.
--     Also fixes copy that leaked internal info or was mislabelled — on BOTH the
--     templates and the items already generated from them in production.
-- Idempotent: safe to re-run. Never destroys existing checklist statuses.
-- =====================================================================

-- ---- profile columns ------------------------------------------------
ALTER TABLE borrowers
  ADD COLUMN IF NOT EXISTS mailing_address       jsonb,
  ADD COLUMN IF NOT EXISTS photo_id_document_id  uuid REFERENCES documents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS months_at_residence   integer,
  ADD COLUMN IF NOT EXISTS housing_status        text,      -- rent / mortgage / own_free_clear
  ADD COLUMN IF NOT EXISTS housing_payment       numeric(12,2);

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS doc_kind text;

-- ---- borrower-facing vs internal checklist language -----------------
ALTER TABLE checklist_templates
  ADD COLUMN IF NOT EXISTS borrower_label text,
  ADD COLUMN IF NOT EXISTS borrower_hint  text;
ALTER TABLE checklist_items
  ADD COLUMN IF NOT EXISTS borrower_label text,
  ADD COLUMN IF NOT EXISTS borrower_hint  text;

-- Helper: copy a template's borrower_label/borrower_hint onto every item made
-- from it, and (for the general renames) the internal label/hint too.
-- We run explicit statements below rather than a function to stay dependency-free.

-- ---- (1) note-buyer name leak on the borrower portal ----------------
UPDATE checklist_templates
   SET borrower_hint = 'Your Gold Standard Program requires two months of statements',
       hint = 'Gold Standard Program requires two months of statements'
 WHERE code = 'rtl_p3_assets';
UPDATE checklist_items
   SET borrower_hint = 'Your Gold Standard Program requires two months of statements',
       hint = 'Gold Standard Program requires two months of statements'
 WHERE template_id = (SELECT id FROM checklist_templates WHERE code = 'rtl_p3_assets');

-- ---- (2) LLC verification: clean name + borrower-friendly hint -------
UPDATE checklist_templates
   SET label = 'LLC verification',
       borrower_label = 'LLC verification',
       borrower_hint  = 'Upload formation documents, EIN letter, and operating agreement for this LLC'
 WHERE code = 'rtl_p1_llc';
UPDATE checklist_items
   SET label = 'LLC verification',
       borrower_label = 'LLC verification',
       borrower_hint  = 'Upload formation documents, EIN letter, and operating agreement for this LLC'
 WHERE template_id = (SELECT id FROM checklist_templates WHERE code = 'rtl_p1_llc');

-- ---- (3) title / insurance contact tasks ----------------------------
UPDATE checklist_templates SET label = 'Title company contact', borrower_label = 'Title company contact',
       borrower_hint = 'Add your title company: name, contact, email and phone'
 WHERE code = 'rtl_p1_titlec';
UPDATE checklist_items SET label = 'Title company contact', borrower_label = 'Title company contact',
       borrower_hint = 'Add your title company: name, contact, email and phone'
 WHERE template_id = (SELECT id FROM checklist_templates WHERE code = 'rtl_p1_titlec');

UPDATE checklist_templates SET label = 'Insurance agent contact', borrower_label = 'Insurance agent contact',
       borrower_hint = 'Add your insurance agent: name, agency, email and phone'
 WHERE code = 'rtl_p1_insc';
UPDATE checklist_items SET label = 'Insurance agent contact', borrower_label = 'Insurance agent contact',
       borrower_hint = 'Add your insurance agent: name, agency, email and phone'
 WHERE template_id = (SELECT id FROM checklist_templates WHERE code = 'rtl_p1_insc');

-- ---- (4) rehab budget + scope of work: borrower-facing wording -------
UPDATE checklist_templates SET borrower_label = 'Construction / rehab budget',
       borrower_hint = 'Complete your budget and submit it to your loan file'
 WHERE code = 'rtl_p1_budget';
UPDATE checklist_items SET borrower_label = 'Construction / rehab budget',
       borrower_hint = 'Complete your budget and submit it to your loan file'
 WHERE template_id = (SELECT id FROM checklist_templates WHERE code = 'rtl_p1_budget');

UPDATE checklist_templates SET borrower_label = 'Scope of Work',
       borrower_hint = 'Complete your Scope of Work and submit it to your loan file'
 WHERE code = 'rtl_p3_sow1';
UPDATE checklist_items SET borrower_label = 'Scope of Work',
       borrower_hint = 'Complete your Scope of Work and submit it to your loan file'
 WHERE template_id = (SELECT id FROM checklist_templates WHERE code = 'rtl_p3_sow1');

-- ---- (5) REO / experience: borrower-facing wording ------------------
UPDATE checklist_templates SET borrower_label = 'Track record / experience',
       borrower_hint = 'Add your prior deals in the Track Record tool: entity, address, price, dates'
 WHERE code = 'rtl_p3_reo';
UPDATE checklist_items SET borrower_label = 'Track record / experience',
       borrower_hint = 'Add your prior deals in the Track Record tool: entity, address, price, dates'
 WHERE template_id = (SELECT id FROM checklist_templates WHERE code = 'rtl_p3_reo');

-- ---- (6) expected ARV is APPLICATION data, not a condition ----------
UPDATE checklist_templates SET is_active = false WHERE code = 'rtl_p1_arv';
UPDATE documents SET checklist_item_id = NULL
 WHERE checklist_item_id IN (
   SELECT id FROM checklist_items
    WHERE template_id = (SELECT id FROM checklist_templates WHERE code = 'rtl_p1_arv'));
UPDATE messages SET checklist_item_id = NULL
 WHERE checklist_item_id IN (
   SELECT id FROM checklist_items
    WHERE template_id = (SELECT id FROM checklist_templates WHERE code = 'rtl_p1_arv'));
DELETE FROM checklist_items
 WHERE template_id = (SELECT id FROM checklist_templates WHERE code = 'rtl_p1_arv');
