-- ============================================================================
-- 384 - Vesting defaults to LLC; a personal-name purchase flips it to Individual
--       (owner-directed 2026-07-31).
--
-- "Most of them are being bought by an LLC — the vesting should automatically be
-- set to LLC." The ClickUp *Vesting dropdown is DERIVED at push time (it is not a
-- stored column and has no inbound path — src/clickup/mapper.js): it used to read
-- `llc ? 'LLC / Corp' : 'Individual'`, so a file with no linked entity pushed
-- 'Individual'. The owner wants LLC to be the default regardless, and Individual
-- to be an EXPLICIT choice: a file bought in a personal name, waived off the LLC
-- condition by uploading a non-owner-occupied affidavit (in lieu of LLC docs).
--
-- `personal_name_purchase` is that explicit flag. Default false → the mapper
-- pushes 'LLC / Corp'. The affidavit-waiver route sets it true → the mapper pushes
-- 'Individual', and the LLC condition (rtl_p1_llc) is signed off with the affidavit
-- as its evidence. Linking a real vesting entity (src/lib/vesting.setVestingLlc)
-- clears it back to false, so an LLC always wins.
--
-- Going-forward: vesting is push-derived and PILOT-owned, so every future push /
-- edit carries the new default; existing cards update on their next sync. No bulk
-- overwrite (a mass Individual→LLC flip could clobber a deliberately-Individual
-- card), matching the "fill blanks, never overwrite" posture of the program /
-- property-type defaults.
-- ============================================================================

ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS personal_name_purchase boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN applications.personal_name_purchase IS
  'true = bought in a personal name (LLC condition waived via a non-owner-occupied affidavit); drives the ClickUp *Vesting dropdown to Individual. Default false → Individual is never the default; vesting is LLC / Corp. (db/384)';
