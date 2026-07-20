-- 159_sitewire_units_physical.sql
-- Owner-directed 2026-07-20 ("use physical building units").
--
-- The Sitewire push used to HARD-BLOCK (park + return) whenever a file's unit count disagreed with its
-- Scope of Work's unit count (reason class `sitewire_units_mismatch`). That is no longer an error: PILOT
-- now sends the PHYSICAL building unit count (the larger of the file count and the SOW count, always >=
-- every per-unit budget/media line the explosion references) and only raises a NON-BLOCKING advisory
-- (`sitewire_units_note`) when the two disagree. So every previously-parked `sitewire_units_mismatch`
-- row represents a block that no longer applies — resolve them so a stranded file can push on retry and
-- the coordinator's Sync Review isn't cluttered with obsolete blocks. Idempotent (only touches OPEN rows
-- of that exact reason class); a re-run finds none. `resolved` is a valid status (db/110 widened the CHECK).
UPDATE sync_review_queue
   SET status = 'resolved',
       resolved_at = now(),
       resolution_note = 'auto-closed: unit-count mismatch is no longer a blocker — PILOT now pushes the physical building unit count (owner-directed 2026-07-20). Re-run the draw setup to push.'
 WHERE field_key = 'sitewire'
   AND status = 'open'
   AND reason LIKE 'sitewire_units_mismatch%';
