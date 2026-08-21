-- ============================================================================
-- db/603 — the non-owner-occupied certification can actually be sent
--
-- WHAT WAS BROKEN. `noo_affidavit` is a live e-sign package: it has an entry in
-- orchestrate.PACKAGES, its own PDF builder (esign/noo-affidavit-pdf.js), its own
-- condition (cond_noo_affidavit_individual, db/417), a borrower-facing label, and a
-- guard in sendPackage that refuses it on an entity-vested file. The staff send route
-- accepts ANY purpose present in PACKAGES, so it is fully reachable.
--
-- But `chk_esign_purpose` — last defined by db/206 — admits only
-- term_sheet_package / heter_iska / test / draw_request. So the very first statement
-- of a NOO send, the INSERT that creates the envelope row, is refused by Postgres
-- (23514), and the route turns that into a 500 "server error". The package has never
-- been sendable. MEASURED before writing this file: inserting a row with
-- purpose='noo_affidavit' against the live schema returns 23514.
--
-- This is the class CLAUDE.md already records twice (a live purpose the constraint
-- does not know about): the constraint is the newest of several files that each
-- re-define it, and the value was added to the CODE without the SQL following.
--
-- RE-ADDED UNDER db/206's OWN CONSTRAINT NAME, not a new one. Every migration replays
-- on every boot, so db/138/153/206 all re-run BEFORE this file and each re-adds
-- `chk_esign_purpose` guarded on its own name. Widening under a NEW name would leave
-- their name unclaimed, so they would re-add the NARROW constraint and FAIL the moment
-- a noo_affidavit row exists — and migrate-boot's superseded-constraint detection only
-- recognises that case when a LATER file re-defines the SAME name
-- (migrate-boot.isSupersededConstraintFailure). Same rule as db/602 and db/527.
--
-- NOTHING ELSE IS IN THIS FILE. A constraint re-add that can fail on replay must not
-- share a file with trailing DDL: the runner skips the REST of the file when it
-- recognises the failure as superseded, which is how a trigger silently reverted to an
-- older definition once before (the db/529 lesson).
--
-- IDEMPOTENT: DROP IF EXISTS then ADD, and the widened list is a superset, so it can
-- never refuse a row that is already stored.
--
-- PRODUCT SEPARATION: RTL. `esign_envelopes` is an RTL table; nothing here is lt_*.
-- ============================================================================

ALTER TABLE esign_envelopes DROP CONSTRAINT IF EXISTS chk_esign_purpose;
ALTER TABLE esign_envelopes ADD CONSTRAINT chk_esign_purpose CHECK (
  purpose IS NULL OR purpose IN ('term_sheet_package','heter_iska','test','draw_request','noo_affidavit')
);
