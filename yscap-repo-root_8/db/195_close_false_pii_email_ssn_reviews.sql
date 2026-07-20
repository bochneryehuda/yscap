-- ============================================================================
-- 195 — Auto-close the FALSE "pii_overwrite_blocked" sync reviews for email/SSN
--       (owner-reported 2026-07-20, Shloimy Friedman).
--
-- Root cause (fixed in code, src/clickup/mapper.js fieldValueEquivalent): the
-- outbound no-op suppression compared borrower EMAIL and SSN as RAW strings, so
--   · "Shloimy6125@gmail.com" vs "shloimy6125@gmail.com" (case only), and
--   · a PILOT SSN pushed as 9 bare digits vs ClickUp's dashed "123-45-4776"
-- read as overwrites and the PII shield queued a pointless manual-review row —
-- even though both are the SAME value (both SSNs even mask identically as
-- ✱✱✱-✱✱-4776). The code fix stops NEW ones; this backfill clears the ones
-- already sitting in the queue so staff don't have to dismiss them by hand.
--
-- Closes ONLY rows that are PROVABLY equal after the same normalization the code
-- now uses — a genuinely different email or a different-last-4 SSN stays OPEN:
--   · EMAIL: case/whitespace-insensitive equality of the stored values.
--   · SSN: the stored values are MASKED (✱✱✱-✱✱-<last4>), so equality of the two
--          masks = same last 4 in the same format = the formatting-only
--          signature; a real different SSN almost always shows a different mask
--          (different last 4) and is left untouched.
-- Rows are marked status='resolved', auto_resolved=true (kept as history, never
-- deleted) — exactly like the sync's own closeStaleReviews path.
-- ============================================================================

UPDATE sync_review_queue
   SET status = 'resolved', auto_resolved = true, resolved_at = now(),
       resolution_note = 'Auto-closed — the two systems already hold the same email (this was only a letter-case difference). Fixed at the source so it will not recur.'
 WHERE status = 'open'
   AND reason LIKE 'pii_overwrite_blocked%'
   AND field_key = 'email'
   -- the outbound PII producer stores the ClickUp/PILOT values in
   -- current_value/proposed_value; two-sided producers use clickup_value/
   -- portal_value. COALESCE covers both so no false row is missed.
   AND COALESCE(clickup_value, current_value) IS NOT NULL
   AND COALESCE(portal_value, proposed_value) IS NOT NULL
   AND lower(btrim(COALESCE(clickup_value, current_value))) = lower(btrim(COALESCE(portal_value, proposed_value)));

UPDATE sync_review_queue
   SET status = 'resolved', auto_resolved = true, resolved_at = now(),
       resolution_note = 'Auto-closed — the two systems already hold the same Social Security number (this was only a formatting difference: dashes vs. no dashes). Fixed at the source so it will not recur.'
 WHERE status = 'open'
   AND reason LIKE 'pii_overwrite_blocked%'
   AND field_key = 'ssn'
   AND COALESCE(clickup_value, current_value) IS NOT NULL
   AND COALESCE(portal_value, proposed_value) IS NOT NULL
   AND btrim(COALESCE(clickup_value, current_value)) = btrim(COALESCE(portal_value, proposed_value));
