-- ============================================================================
-- db/684 — the co-browse redaction counter is RETIRED (owner-directed 2026-09-02)
--
-- WHAT THIS CHANGES, AND WHY. db/683 added `cobrowse_sessions.redaction_drops`
-- for a server-side content guard that DROPPED an rrweb batch carrying an
-- SSN-shaped or card-shaped value in the clear. The owner reported the result:
-- the viewer showed a blank stage with a cursor moving over it, and "Refresh
-- picture" produced another blank one.
--
-- An rrweb stream is STATEFUL — the full snapshot establishes every DOM node id
-- and each later mutation is expressed against those ids — so a refused batch
-- does not cost one frame, it desynchronises the mirror for the rest of the
-- session. And the batch such a guard fires on is USUALLY THE FULL SNAPSHOT,
-- because that is where a printed Social Security number actually lives. The
-- owner asked for the check to go ("this is all internal … we can remove the
-- security feature"), and the defect was the DROP, not the detector: the browser
-- mask (app-v2/src/lib/cobrowseMask.js) was always the real protection.
--
-- THE COLUMN IS KEPT AND IS NOT DROPPED. This repository never drops a column,
-- and the counts already recorded are a true record of what happened while the
-- guard was live. It is simply written by nothing now, so the COMMENT — the
-- database's own documentation, which describes live behaviour to anybody
-- reading the schema — is corrected to say so.
--
-- IDEMPOTENT. `migrate-boot` replays EVERY file in db/ on EVERY boot, in
-- filename order. COMMENT ON is naturally idempotent (it replaces whatever
-- comment is there), and this file is numbered above db/683 so it is the last
-- word on this column every boot.
-- ============================================================================

COMMENT ON COLUMN cobrowse_sessions.redaction_drops IS
  'RETIRED 2026-09-02 (db/684) and written by nothing. It counted batches a '
  'server-side content guard refused to relay; refusing a batch desynchronises '
  'a stateful rrweb stream and blanked the mirror, so the guard was removed. '
  'Masking happens in the guest browser before a byte leaves it. Historic counts '
  'are kept as a record of what happened while it was live.';
