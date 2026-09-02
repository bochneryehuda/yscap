-- ============================================================================
-- db/672 — the LOAN OFFICER ASSISTANT role (owner-directed 2026-09-02,
--          short-term / RTL side).
--
-- WHAT THIS CHANGES, AND WHY. The owner asked for a new back-office role, the
-- Loan Officer Assistant: a person who works a loan officer's files with the
-- LOAN OFFICER'S permissions and screens — explicitly NOT a processor's — who
-- can be placed on a file as a loan officer assistant and can NEVER be placed
-- on a file as a processor. Two value lists in the database name the roles a
-- staffer may hold and the slots a file may carry people in, and neither knew
-- this role, so:
--
--   (1) staff_users.role gains 'loan_officer_assistant'. The registry that
--       drives every screen and gate is src/lib/permissions.js (ROLES); this
--       CHECK is the database's copy of that list and is re-asserted IN FULL
--       (db/039 → db/131 → db/212 → db/523 → here), the two external TPO roles
--       included, so it stays exact and a superset — no existing row can fail.
--
--   (2) application_assignees.role gains 'loan_officer_assistant' — the
--       assistant's OWN slot on a file, beside loan_officer / processor /
--       closer / draw_coordinator (db/103, db/392) and the TPO-side
--       account_executive / account_manager (db/524). Like draw_coordinator it
--       has NO denormalized pointer on `applications` — the assignee row IS the
--       record — so sync_primary_assignee() (db/529) needs no change, and there
--       is nothing here for a primary to mirror.
--
-- "Cannot be added as a processor" is enforced where the slot is written, not
-- here: POST /applications/:id/assignees refuses a staffer whose role is not
-- the slot's role, and the processor pointer (/assign, file create) only ever
-- accepts a staffer with role='processor'. The CHECKs below make the assistant
-- slot EXIST; the routes decide who may fill which slot.
--
-- BACKFILL: none. No row exists yet that should carry either new value; a
-- person becomes an assistant when an admin sets the role on the Team screen,
-- and joins a file when a teammate adds them to it.
--
-- IDEMPOTENT (drop-then-add, the db/359 / db/392 / db/523 pattern). Because
-- db/523 and db/524 re-add the NARROWER lists on every boot, the moment a real
-- row uses 'loan_officer_assistant' their re-adds fail with 23514 and roll
-- back — migrate-boot recognises that exact shape (a CHECK re-added by a LATER
-- file) and skips it quietly, leaving the wider constraints asserted here in
-- place. That is the mechanism the runner was built for; nothing else in those
-- two files is data-dependent.
--
-- PRODUCT SEPARATION. `staff_users` is the shared IDENTITY roster, changed here
-- for the RTL product at the owner's request; `application_assignees` is RTL's.
-- Long-Term reads the roster and fails CLOSED on a role it does not map
-- (src/longterm/access.js: an unmapped role scopes to `own`, never `all`), so
-- this value reaches LT as "no long-term access" until LT is separately asked.
-- ============================================================================

-- (1) The staff role set — the FULL list, re-asserted.
ALTER TABLE staff_users DROP CONSTRAINT IF EXISTS staff_users_role_check;
ALTER TABLE staff_users ADD  CONSTRAINT staff_users_role_check
  CHECK (role IN ('super_admin','admin','underwriter','loan_officer','loan_officer_assistant',
                  'loan_coordinator','draw_coordinator','processor','closer','software_setup',
                  'tpo_officer','tpo_processor'));

-- (2) The file-slot set — the FULL list, re-asserted.
ALTER TABLE application_assignees DROP CONSTRAINT IF EXISTS application_assignees_role_check;
ALTER TABLE application_assignees
  ADD CONSTRAINT application_assignees_role_check
  CHECK (role IN ('loan_officer','processor','closer','draw_coordinator',
                  'account_executive','account_manager','loan_officer_assistant'));
