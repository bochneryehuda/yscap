-- ============================================================================
-- db/675 — lt_file_orders.condition_id points at the shared Condition Center
--
-- WHAT THIS FIXES. db/644 gave `lt_file_orders.condition_id` a foreign key to
-- `lt_file_conditions`, the long-term conditions table of the day. db/653 then
-- moved every long-term condition into the SHARED `checklist_items` (scope
-- 'lt_loan') and nothing has written `lt_file_conditions` since — but the key
-- stayed. `routes/orders.js` accepts a `conditionId` from the screen, the screen
-- sends the real `checklist_items` id (the only id a condition has any more),
-- and Postgres refused the INSERT with a foreign-key violation: pressing
-- "Order it" on a condition card answered 500 on every long-term file.
--
-- WHY THE KEY IS DROPPED AND NOT RE-POINTED. The honest target is now
-- `checklist_items`, and it is NOT an `lt_*` table. A long-term table may only
-- declare a database-level reference to another `lt_*` table or to the shared
-- identity tables (CLAUDE.md rule 4; `check-product-separation.js` enforces it
-- per REFERENCES, and the ledger authorizes `checklist_items` for reads and
-- writes, not for a key). So the column keeps the id and JOINS to the shared
-- table when it reads — exactly the shape `lt_loan_vendors.service_contact_id`
-- and `lt_borrower_landlords.service_contact_id` (db/665) already take. A
-- condition retired from a file leaves an id that matches nothing, which reads
-- as "no condition", the same as NULL did under ON DELETE SET NULL.
--
-- ORDERING IS THE MECHANISM. db/644 replays on every boot and its CREATE TABLE
-- IF NOT EXISTS carries the key, so on a FRESH database 644 creates it and this
-- file, numbered above it, is the final word each boot — the db/665-over-db/662
-- pattern. On an existing database the CREATE is a no-op and only the DROP here
-- does anything.
--
-- BACKFILL: none. The column is nullable and every value it holds today was
-- written against `lt_file_conditions`; those ids match no `checklist_items`
-- row and read as "no condition", which is what they are. Nothing reads the
-- column for a decision yet — `desk.place` only writes it.
--
-- PRODUCT SEPARATION: `lt_*` only. After this file `lt_file_orders` points at
-- `lt_loans` and nothing else.
-- ============================================================================

ALTER TABLE lt_file_orders DROP CONSTRAINT IF EXISTS lt_file_orders_condition_fk;

COMMENT ON COLUMN lt_file_orders.condition_id IS
  'The checklist_items row (scope lt_loan) this order answers — the shared Condition Center, since db/653. A plain id and NOT a foreign key: a long-term table may not declare a reference to a table outside lt_* (CLAUDE.md rule 4), so it joins when it reads and an id whose condition was retired simply matches nothing. db/644''s key to the retired lt_file_conditions was dropped by db/675.';
