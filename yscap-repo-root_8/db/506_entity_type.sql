-- 506_entity_type.sql — AN ENTITY IS NOT ALWAYS AN LLC (owner-directed 2026-08-09).
--
-- PILOT's table for a borrowing company is called `llcs` and every line of code
-- around it assumed the name was the whole truth. It is not, and three things
-- were wrong because of it:
--
--   · we asked every borrower for an OPERATING AGREEMENT — a document a
--     corporation does not have;
--   · the loan documents could not be drafted, because DocLab needs to know
--     whether the entity has MEMBERS holding a PERCENTAGE or SHAREHOLDERS
--     holding SHARES (six of its fields hang off that one answer);
--   · nobody's TITLE was recorded, and a title prints under the signature line
--     on every recorded instrument.
--
-- The rules live in src/lib/entity-type.js — the ONE definition of what each
-- type is called, which document it is asked for, and which titles its owners
-- may hold. This file only makes room for the answers.
--
-- THE TABLE IS NOT RENAMED, AND THAT IS DELIBERATE. `llcs` is referenced by
-- ~200 files, by `llc_id` foreign keys on nine tables, by the ClickUp field map
-- and by the SharePoint folder resolver. Renaming it would be a mechanical
-- change with a real chance of a silent miss, and it would buy nothing a human
-- can see. What the OWNER sees is the wording, and the wording is what moves:
-- "LLC" becomes "entity" on every screen. The column name stays.
--
-- THE BACK BOOK BECOMES LLC — AND SAYS SO. Owner-directed: "everything created
-- till now should automatically be default LLC, only going forward this change
-- to go in effect." So every existing entity is stamped `llc`. But it is ALSO
-- stamped `entity_type_confirmed = false`, because "we assumed" and "a person
-- chose" are different facts and only one of them is safe to print on a
-- mortgage. Nothing behaves differently on an unconfirmed entity — it is treated
-- as an LLC everywhere — it just lets a surface that is about to draft real
-- documents admit it is assuming instead of stating a guess as a fact.

-- ─────────────────────────────── the entity ───────────────────────────────

-- DEFAULT 'llc' is what performs the back-fill: Postgres stamps every existing
-- row as it adds the column, so there is no separate UPDATE to get wrong and no
-- window where a row has no type.
ALTER TABLE llcs ADD COLUMN IF NOT EXISTS entity_type text NOT NULL DEFAULT 'llc';

-- Confirmed = a human picked it. FALSE for the whole back book by definition,
-- and the create doors set it true going forward.
ALTER TABLE llcs ADD COLUMN IF NOT EXISTS entity_type_confirmed boolean NOT NULL DEFAULT false;
ALTER TABLE llcs ADD COLUMN IF NOT EXISTS entity_type_set_at timestamptz;
ALTER TABLE llcs ADD COLUMN IF NOT EXISTS entity_type_set_by uuid REFERENCES staff_users(id) ON DELETE SET NULL;

-- The four types src/lib/entity-type.js defines. A CHECK rather than an enum so
-- adding a fifth is one guarded ALTER, not a type rewrite — and so an unknown
-- value is refused at the door rather than silently stored.
DO $$
BEGIN
  ALTER TABLE llcs DROP CONSTRAINT IF EXISTS llcs_entity_type_check;
  ALTER TABLE llcs ADD CONSTRAINT llcs_entity_type_check
    CHECK (entity_type IN ('llc','corporation','partnership','trust'));
END $$;

-- ─────────────────────────── the owners' details ───────────────────────────
--
-- BOTH owner tables get the same three columns, because PILOT splits owners in
-- two: `llc_borrowers` is the owners who are our borrowers, `llc_members` is
-- everybody else. A loan document does not care about that distinction — it
-- lists every owner with their title and their stake — so a column on only one
-- of them would produce a document missing half the ownership.
--
-- `title` is from the fixed list in entity-type.js, NEVER free text: this value
-- is printed under a signature line and merged verbatim into a mortgage, so
-- "managing member" / "Managing Member" / "MGR" must not all be reachable.
--
-- `shares` and `certificate_number` are the CORPORATION analogue of
-- `ownership_pct`. A corporation issues a numbered stock certificate — "Certificate
-- No. 3: 500 shares" — and the pledge of that ownership has to name the exact
-- certificate being handed over, the same way a mortgage names the exact
-- property. An LLC normally has no certificate, which is why the percentage
-- serves there and these two stay null.

ALTER TABLE llc_borrowers ADD COLUMN IF NOT EXISTS member_title       text;
ALTER TABLE llc_borrowers ADD COLUMN IF NOT EXISTS shares             integer;
ALTER TABLE llc_borrowers ADD COLUMN IF NOT EXISTS certificate_number text;

ALTER TABLE llc_members   ADD COLUMN IF NOT EXISTS member_title       text;
ALTER TABLE llc_members   ADD COLUMN IF NOT EXISTS shares             integer;
ALTER TABLE llc_members   ADD COLUMN IF NOT EXISTS certificate_number text;

-- A share COUNT is a whole number and cannot be negative. Zero is refused too:
-- an owner with zero shares is not an owner, and a zero would print "0 shares"
-- onto a pledge. Null means "not answered", which is the honest state today.
DO $$
BEGIN
  ALTER TABLE llc_borrowers DROP CONSTRAINT IF EXISTS llc_borrowers_shares_check;
  ALTER TABLE llc_borrowers ADD CONSTRAINT llc_borrowers_shares_check
    CHECK (shares IS NULL OR shares > 0);
  ALTER TABLE llc_members DROP CONSTRAINT IF EXISTS llc_members_shares_check;
  ALTER TABLE llc_members ADD CONSTRAINT llc_members_shares_check
    CHECK (shares IS NULL OR shares > 0);
END $$;

-- ──────────────────── the entity-document slots, by type ────────────────────
--
-- The slot wording now depends on what the entity IS. Owner-directed: "re-label
-- the operating agreement slot for bylaws and stock certificate, and this change
-- needs to be everywhere else — SharePoint syncing, TPR export and everywhere
-- else."
--
-- IT IS THE ITEM THAT CARRIES THE WORDING, NOT THE TEMPLATE — and that is the
-- whole mechanism. There is ONE `rtl_llc_opagmt` template and one row per entity
-- created from it, so the template cannot say "operating agreement" and "bylaws"
-- at the same time. `checklist_items` already COPY the wording at creation (the
-- repo's long-standing pattern), so the per-entity label is written there.
-- SharePoint names its folders from the item's label and the TPR export
-- categorises from it, so BOTH follow with no separate map to keep in step.
--
-- The TEMPLATE labels are made type-neutral in the same pass, because they are
-- what a brand-new slot inherits before anything knows the entity's type, and
-- because they are what the admin condition screens list. "LLC Operating
-- Agreement" would be a lie on a corporation's file either way.

UPDATE checklist_templates SET label = 'Certificate of Formation (formation state)'
 WHERE code = 'rtl_llc_formation' AND label = 'LLC Certificate of Formation (formation state)';
UPDATE checklist_templates SET label = 'EIN letter (IRS)'
 WHERE code = 'rtl_llc_ein' AND label = 'LLC EIN letter (IRS)';
UPDATE checklist_templates SET label = 'Governing document (operating agreement / bylaws)'
 WHERE code = 'rtl_llc_opagmt' AND label = 'LLC Operating Agreement';
UPDATE checklist_templates SET label = 'Certificate of Good Standing (state)'
 WHERE code = 'rtl_llc_goodstanding' AND label = 'LLC Certificate of Good Standing (state)';

-- PREVIOUS AND FUTURE. Existing slots are re-worded to their entity's type —
-- which for the whole back book is `llc`, so in practice this only strips the
-- word "LLC" out of the internal labels and leaves the borrower-facing wording
-- exactly as it is. A corporation created after this migration gets the
-- corporation wording at creation (src/lib/llc.js applyEntitySlotWording).
--
-- Guarded on the exact prior text so a hand-edited label survives every boot —
-- the same discipline db/033, db/363 and db/367 use.
UPDATE checklist_items ci
   SET label = 'Certificate of Formation (formation state)', updated_at = now()
  FROM checklist_templates t
 WHERE t.id = ci.template_id AND t.code = 'rtl_llc_formation'
   AND ci.label = 'LLC Certificate of Formation (formation state)';

UPDATE checklist_items ci
   SET label = 'EIN letter (IRS)', updated_at = now()
  FROM checklist_templates t
 WHERE t.id = ci.template_id AND t.code = 'rtl_llc_ein'
   AND ci.label = 'LLC EIN letter (IRS)';

UPDATE checklist_items ci
   SET label = 'Operating Agreement', updated_at = now()
  FROM checklist_templates t
 WHERE t.id = ci.template_id AND t.code = 'rtl_llc_opagmt'
   AND ci.label = 'LLC Operating Agreement';

UPDATE checklist_items ci
   SET label = 'Certificate of Good Standing (state)', updated_at = now()
  FROM checklist_templates t
 WHERE t.id = ci.template_id AND t.code = 'rtl_llc_goodstanding'
   AND ci.label = 'LLC Certificate of Good Standing (state)';

-- THE FILE-LEVEL ENTITY CONDITION: its LABEL is left alone, its HINTS are not.
--
-- `rtl_cond_entity_docs` is already type-neutral in its label ("Entity documents
-- — the business whose bank funds are being used"), and db/400 RE-ASSERTS that
-- label on every boot — so changing it here would be undone on the next deploy,
-- the exact trap db/191/db/398 documents. It is not touched.
--
-- Its HINTS are a different matter: they name an "OPERATING AGREEMENT" and
-- "ARTICLES OF ORGANIZATION" by name, which are the LLC's documents. On a
-- corporation's bank account that asks for paperwork that does not exist. db/400
-- does NOT re-assert the hints, so these are durable. Guarded on the exact prior
-- text so a hand-edited hint survives.
UPDATE checklist_templates
   SET hint = 'The borrower is showing funds in an account held by a business that is not the vesting entity. Collect that entity''s GOVERNING DOCUMENT (its operating agreement, bylaws, partnership agreement or trust agreement — whichever it has, showing the borrower as a managing member, officer or 25%+ owner), its STATE FORMATION CERTIFICATE and its IRS EIN letter, so the borrower''s control of the account is documented. Add the entity to the borrower''s profile at the same time so it is on their record for future files.'
 WHERE code = 'rtl_cond_entity_docs'
   AND hint LIKE '%OPERATING AGREEMENT%';

UPDATE checklist_templates
   SET borrower_hint = 'You are showing money held in a business account. So we can count those funds, please upload that company''s governing document (its operating agreement, bylaws, partnership agreement or trust agreement — whichever it has), its state formation certificate and its IRS EIN letter — together they show you own and control the company.'
 WHERE code = 'rtl_cond_entity_docs'
   AND borrower_hint LIKE '%Operating Agreement%';

-- ───────────────────────────────── indexes ─────────────────────────────────
-- The closing desk asks "which entities on my files still have no titles?", and
-- the drafting path asks "is this type confirmed?". Both are cheap with this.
CREATE INDEX IF NOT EXISTS idx_llcs_entity_type ON llcs (entity_type)
  WHERE entity_type <> 'llc';
