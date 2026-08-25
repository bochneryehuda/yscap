-- ============================================================================
-- db/630 — assignment condition is a purchase concept
--
-- WHAT WAS OBSERVED (owner-reported 2026-08-25, YSCAP258134828 / 601 South 18th
-- Street): a "Refinance — Cash-Out" file carrying the borrower-facing condition
-- "Assignment letter (if the contract is assigned)". On a purchase that is NOT
-- an assignment it correctly does not appear — only refinances were wrong.
--
-- ROOT CAUSE: THREE PLACES DECIDED ONE QUESTION AND THEY DISAGREED.
--   · db/179's AFTER trigger asks TWO questions — flagged as an assignment AND
--     a purchase — and DELETES the condition otherwise.
--   · src/lib/conditions/ensure.js asked ONE (`is_assignment === true`) and
--     re-created it on the very next ensure. ensureFileConditions runs on every
--     create path, every re-sync and every key-field change, so on a refinance
--     whose assignment box was ticked the two rules FOUGHT: the strict one took
--     the condition off, the lax one put it straight back, and the borrower kept
--     being asked for an assignment letter for a loan that buys nothing.
--   · db/095's boot reconciler asks that same single question.
-- And nothing ever un-ticked the box: ClickUp's "Contract assignment" checkbox
-- writes applications.is_assignment straight through on any file (clickup/
-- mapper.js), so a refinance could hold is_assignment = true forever.
--
-- The JavaScript half of this fix is src/lib/conditions/assignment-purchase.js —
-- one shared predicate every JS door now reads. This file is the database half,
-- because a checklist row can be written by SQL that never runs through it
-- (db/077, db/095, db/161 and db/179 all INSERT one directly).
--
--   §1 makes the DATA true: a refinance cannot STORE is_assignment = true, nor
--      the assignment money that travels with it (db/515's rule).
--   §2 makes the CONDITION true BY CONSTRUCTION: an rtl_p5_assign row cannot be
--      inserted onto a file that is not an assignment purchase, whoever inserts
--      it — db/095's reconciler, generateChecklist, or a door added next year.
--   §3 is the previous half of previous-and-future.
--
-- The refinance test is `COALESCE(loan_type,'') ~* 'refi'`, byte-for-byte
-- db/179's and pricing.js loanTypeOf's. ONE question, ONE answer, on every layer.
--
-- IDEMPOTENT: CREATE OR REPLACE FUNCTION + DROP/CREATE TRIGGER, and both
-- backfills match zero rows on every later boot (the triggers keep it that way).
--
-- BACKFILL: yes, §3 — every refinance already holding a ticked assignment box is
-- cleared (audited first, because the value is gone from the row afterwards) and
-- every stray assignment condition is deleted. USER TRIGGERS ARE DISABLED for
-- the duration, the same mechanism and the same reasoning as db/399 and db/515:
-- nine triggers on `applications` watch these columns and would reopen Products
-- & Pricing, un-sign live term sheets and reopen cleared conditions across the
-- whole back book for a change that moves NO number the engine ever read
-- (pricing.js buildInputs reads the fee/underlying ONLY when the loan type is a
-- Purchase, so on these files those columns fed nothing). migrate-boot runs this
-- file as ONE implicit transaction, so a failure rolls the DISABLE back with it.
--
-- PRODUCT SEPARATION: RTL only. `applications` and `checklist_items` are RTL
-- tables; nothing here names an `lt_*` table or an LT concept.
-- ============================================================================

-- ── §1 — a refinance cannot store an assignment ─────────────────────────────
-- An assignment of contract is definitionally a PURCHASE concept: somebody
-- assigns their position as the BUYER under a contract of sale. A refinance
-- buys nothing, so there is no contract and no position to assign.
--
-- fields.assignmentFields already enforces this at the application layer, but it
-- can only see the request in front of it: a door that sends `isAssignment`
-- WITHOUT `loanType` reads as a purchase, and the ClickUp inbound pull writes
-- the card's checkbox straight onto the column with no loan-type term at all.
-- This is the one chokepoint every one of those doors shares.
CREATE OR REPLACE FUNCTION assignment_is_a_purchase_concept() RETURNS trigger AS $$
BEGIN
  IF NEW.is_assignment IS TRUE AND COALESCE(NEW.loan_type, '') ~* 'refi' THEN
    NEW.is_assignment := false;
    -- The money travels with the flag (db/515: "a file that is not an assignment
    -- carries no assignment money"). Cleared ONLY in the moment we force the flag
    -- off, so an ordinary save on an ordinary refinance touches nothing and the
    -- economics-reopen triggers never fire for it.
    NEW.underlying_contract_price := NULL;
    NEW.assignment_fee := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_assignment_is_a_purchase_concept ON applications;
CREATE TRIGGER trg_assignment_is_a_purchase_concept
  BEFORE INSERT OR UPDATE OF is_assignment, loan_type, underlying_contract_price, assignment_fee
  ON applications
  FOR EACH ROW EXECUTE FUNCTION assignment_is_a_purchase_concept();

-- ── §2 — the condition cannot be created on a file that is not one ──────────
-- Returning NULL from a BEFORE INSERT trigger SKIPS the row: db/095's
-- `INSERT ... SELECT` simply inserts one row fewer, and insertFromTemplate's
-- single-row INSERT reports zero rows affected, which it already ignores. No
-- caller has to know this exists, which is the point — the invariant holds for
-- doors nobody has written yet.
--
-- UNCONDITIONAL, deliberately: db/179's trigger already DELETES this condition
-- off a refinance whoever created it, so admitting a hand-added one here would
-- leave the two rules disagreeing again — which is the bug this file exists to
-- close. A staff-typed condition carries no template_id and is never touched.
CREATE OR REPLACE FUNCTION assignment_condition_is_purchase_only() RETURNS trigger AS $$
DECLARE
  is_assign_purchase boolean;
BEGIN
  -- Cheapest tests first: this fires on EVERY checklist_items insert (~40 per
  -- new file), so anything that is not an application-scoped template row is
  -- out after two NULL checks.
  IF NEW.application_id IS NULL OR NEW.template_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM checklist_templates t
                  WHERE t.id = NEW.template_id AND t.code = 'rtl_p5_assign') THEN
    RETURN NEW;
  END IF;

  SELECT (a.is_assignment IS TRUE AND COALESCE(a.loan_type, '') !~* 'refi')
    INTO is_assign_purchase
    FROM applications a
   WHERE a.id = NEW.application_id;

  -- A file we cannot read is not an assignment purchase we can prove, so the
  -- condition is not created. Erring the other way would put a borrower-facing
  -- request for an assignment letter on a file nobody could vouch for.
  IF COALESCE(is_assign_purchase, false) THEN
    RETURN NEW;
  END IF;
  RETURN NULL;   -- skip the row
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_assignment_condition_is_purchase_only ON checklist_items;
CREATE TRIGGER trg_assignment_condition_is_purchase_only
  BEFORE INSERT ON checklist_items
  FOR EACH ROW EXECUTE FUNCTION assignment_condition_is_purchase_only();

-- ── §3 — the previous half of previous-and-future ──────────────────────────
ALTER TABLE applications DISABLE TRIGGER USER;

-- §3a — record what is about to be cleared, on the file's own trail. The value
-- is gone from the row afterwards, so this line is the only place it survives.
INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
SELECT 'system', NULL, 'assignment_flag_cleared_on_refinance', 'application', a.id,
       jsonb_build_object(
         'loan_type',                 a.loan_type,
         'assignment_fee',            a.assignment_fee,
         'underlying_contract_price', a.underlying_contract_price,
         'why', 'An assignment of contract is a purchase concept — the borrower '
             || 'assigns their position as the BUYER under a contract of sale, and a '
             || 'refinance buys nothing. The assignment box was ticked on this '
             || 'refinance, which kept putting the borrower-facing "Assignment letter" '
             || 'condition back on the file. If this deal really is a purchase, change '
             || 'the loan purpose first and then tick the assignment box again.')
  FROM applications a
 WHERE a.is_assignment IS TRUE
   AND COALESCE(a.loan_type, '') ~* 'refi';

-- §3b — a refinance carries no assignment.
UPDATE applications
   SET is_assignment = false,
       underlying_contract_price = NULL,
       assignment_fee = NULL,
       updated_at = now()
 WHERE is_assignment IS TRUE
   AND COALESCE(loan_type, '') ~* 'refi';

ALTER TABLE applications ENABLE TRIGGER USER;

-- §3c — and drop every assignment condition left on a file that is not an
-- assignment purchase. This runs AFTER §3b, so a refinance whose box was just
-- cleared is caught here too. Deleting is safe: documents.checklist_item_id is
-- ON DELETE SET NULL (db/179 records the same).
DELETE FROM checklist_items ci
  USING checklist_templates t, applications a
 WHERE ci.template_id = t.id
   AND t.code = 'rtl_p5_assign'
   AND ci.application_id = a.id
   AND NOT (a.is_assignment IS TRUE AND COALESCE(a.loan_type, '') !~* 'refi');
