-- Out-of-pocket rehab exception — Phase 2 (owner-directed 2026-07-31):
-- "make sure this feeds over to the actual loan file — that the loan file
--  understands it's more initial and less construction … force it so the first
--  amount is out of pocket and cannot be reimbursed, only the next can."
--
-- Two go-forward-only columns, both byte-identical for a file with no exception:
--
--  1. applications.financed_rehab_budget — the FINANCED portion of the rehab (the
--     part disbursed through draws). rehab_budget stays the FULL construction budget
--     (Sitewire's budget must equal it to the cent — G-RECON); financed_rehab_budget
--     is what the loan actually advances. With no OOP exception the two are equal, so
--     the backfill sets financed_rehab_budget := rehab_budget for every existing file
--     (previous files read "fully financed"). The out-of-pocket rehab is the
--     difference (rehab_budget − financed_rehab_budget).
--
--  2. sitewire_property_links.oop_floor_cents — the dollar floor (in cents) that the
--     draw ledger enforces: the first `oop_floor_cents` of CUMULATIVE approved rehab
--     across all draws is the borrower's own money and is never reimbursed. Snapshotted
--     from the current registration's OOP-rehab amount when the coordinator starts the
--     draw process; 0 (the default) means every release is byte-identical to before.

ALTER TABLE applications ADD COLUMN IF NOT EXISTS financed_rehab_budget numeric;

-- Previous files: the whole rehab budget was financed (no exception existed), so the
-- financed portion equals the full budget. Idempotent — only fills a NULL.
UPDATE applications
   SET financed_rehab_budget = rehab_budget
 WHERE financed_rehab_budget IS NULL
   AND rehab_budget IS NOT NULL;

ALTER TABLE sitewire_property_links
  ADD COLUMN IF NOT EXISTS oop_floor_cents bigint NOT NULL DEFAULT 0;
