-- 515 — A FILE THAT IS NOT AN ASSIGNMENT CARRIES NO ASSIGNMENT MONEY
--       (owner-reported 2026-08-10, YSCAP258134769 / 54 Avenue C).
--
-- The owner removed a $7,500 assignment fee from a file — three separate saves,
-- each proven by its own audit row clearing assignment_fee 7500→NULL — and the
-- Encompass comparison kept showing the fee as "No data to compare". Root cause
-- is a one-way round trip with ClickUp: the details door clears the two columns
-- and pushes the assignment CHECKBOX off, but the card's two currency fields
-- ("Contract assignment/flip fee", the underlying price) can never be cleared by
-- the push — the no-wipe guard skips empty values by design — so the card kept
-- 7500/75000 forever, and every inbound pull wrote them straight back over the
-- file's deliberate NULL via its COALESCE. Invisibly, too: the inbound change
-- audit skips null→value fills, so the resurrection never left a trace.
--
-- The code half of the fix (same commit): the pull now declines to import
-- assignment money from a card whose assignment checkbox is not ticked
-- (ingest.dropAssignmentMoneyWithoutCheckbox), and the Encompass comparison
-- reads a non-assignment file's fee as ZERO (reconcile.buildOurValues), which
-- meets Encompass's blank/0 through the field's own zeroMeansNone and MATCHES.
--
-- This file is the PREVIOUS half of previous-and-future: every file already on
-- disk that says "not an assignment" while still holding assignment money gets
-- the leftovers cleared, audited first. This changes NO priced number —
-- src/lib/pricing.js buildInputs reads the fee/underlying ONLY when
-- is_assignment is true (isAssignment = loanType Purchase && is_assignment &&
-- underlying > 0), so on these files the columns fed nothing; this is a repair,
-- not a re-price (the db/322 doctrine).
--
-- USER TRIGGERS ARE DISABLED for the duration — the reopen triggers (db/072 et
-- al) watch assignment_fee/underlying_contract_price and would reopen Products
-- & Pricing and un-sign cleared conditions across the back book for a change
-- that moves no number the engine ever read. Same mechanism and same reasoning
-- as db/399; migrate-boot runs this file as ONE implicit transaction, so a
-- failure rolls the DISABLE back with it.
--
-- IDEMPOTENT: after this runs no non-assignment file holds assignment money, so
-- both statements match zero rows on every later boot. (The pull-side guard is
-- what keeps it that way — without it, the next sync would re-import the fee
-- from the card and this file would "heal" the same rows every night.)

ALTER TABLE applications DISABLE TRIGGER USER;

-- §A — record what is about to be cleared, on the file's own trail.
INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
SELECT 'system', NULL, 'stale_assignment_economics_cleared', 'application', a.id,
       jsonb_build_object(
         'assignment_fee',            a.assignment_fee,
         'underlying_contract_price', a.underlying_contract_price,
         'why', 'The file is not an assignment (is_assignment=false), so these are leftovers '
             || 'from a removed assignment that the ClickUp round-trip kept restoring. '
             || 'If this deal really is an assignment, tick the assignment box on the file '
             || 'and re-enter the underlying price — the fee derives from it.')
  FROM applications a
 WHERE a.is_assignment = false
   AND (a.assignment_fee IS NOT NULL OR a.underlying_contract_price IS NOT NULL);

-- §B — a non-assignment file carries no assignment money.
UPDATE applications
   SET assignment_fee = NULL,
       underlying_contract_price = NULL
 WHERE is_assignment = false
   AND (assignment_fee IS NOT NULL OR underlying_contract_price IS NOT NULL);

ALTER TABLE applications ENABLE TRIGGER USER;
