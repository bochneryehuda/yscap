-- Go-forward-only error handling (owner-directed 2026-07-20).
--
-- A file only enters the sync-review ERROR QUEUE once PILOT has actually pushed it (a live created Sitewire
-- property). Everything that can go wrong BEFORE that — no Scope of Work, a budget that doesn't tie out, an
-- unmatched capital partner, an incomplete address, a loan already in Sitewire that PILOT didn't create, the
-- unit/type advisories — is a SETUP problem on a not-yet-managed file. Going forward those live ON THE FILE
-- (sitewire_property_links.raw.setup_status) and show in its own draw section, never as a global error row.
--
-- This migration cleans up the rows created under the old behavior:
--   1) Seed the pre-existing-property collision onto the file's setup_status so its draw section shows the
--      "Already in Sitewire — not managed" banner immediately (no re-push needed).
--   2) Auto-close every open BIRTH-phase Sitewire review for a file PILOT has NOT pushed (no live created
--      property). Reviews on managed files (post-push workflow) are left untouched.
-- Idempotent: re-running finds no open birth reviews and is a no-op.

-- 1) Collision -> setup_status on the file (create the holder link row if the file has none yet).
INSERT INTO sitewire_property_links (application_id, matched_by, state, raw, updated_at)
SELECT DISTINCT ON (q.application_id)
       q.application_id, 'created', 'pending',
       jsonb_build_object('setup_status', jsonb_build_object(
         'reason', q.reason, 'class', 'sitewire_loan_already_in_sitewire',
         'preexisting_property_id', q.current_value)),
       now()
  FROM sync_review_queue q
 WHERE q.field_key = 'sitewire' AND q.status = 'open'
   AND split_part(q.reason, ':', 1) = 'sitewire_loan_already_in_sitewire'
   AND NOT EXISTS (SELECT 1 FROM sitewire_property_links l
                    WHERE l.application_id = q.application_id
                      AND l.matched_by = 'created' AND l.sitewire_property_id IS NOT NULL)
 ORDER BY q.application_id, q.created_at DESC
ON CONFLICT (application_id) DO UPDATE
  SET raw = COALESCE(sitewire_property_links.raw, '{}'::jsonb) || EXCLUDED.raw,
      updated_at = now();

-- 2) Close every open BIRTH-phase Sitewire review for a file PILOT hasn't pushed.
UPDATE sync_review_queue q
   SET status = 'resolved', resolved_at = now(),
       resolution_note = 'auto-closed: go-forward error handling — setup status now lives on the file'
 WHERE q.field_key = 'sitewire' AND q.status = 'open'
   AND split_part(q.reason, ':', 1) IN (
       'sitewire_missing_loan_number', 'sitewire_no_budget', 'sitewire_no_sow', 'sitewire_units_note',
       'sitewire_budget_mismatch', 'sitewire_capital_partner_unmatched', 'sitewire_address_incomplete',
       'sitewire_type_unmapped', 'sitewire_dupe_check_failed', 'sitewire_loan_already_in_sitewire',
       'sitewire_property_rejected', 'sitewire_bind_missing_property')
   AND NOT EXISTS (SELECT 1 FROM sitewire_property_links l
                    WHERE l.application_id = q.application_id
                      AND l.matched_by = 'created' AND l.sitewire_property_id IS NOT NULL);
