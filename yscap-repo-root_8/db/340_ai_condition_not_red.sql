-- 340 — A condition created from an AI suggestion is not born RED (owner-directed 2026-07-27).
--
-- ROOT CAUSE. `routes/underwriting.js` convert_to_condition inserted the new
-- checklist_items row with status 'issue'. In this system 'issue' does NOT mean
-- "new"; it means "we sent this BACK to the borrower because something was
-- wrong" — it is the red "Needs attention" bucket, and it is what a REJECTED
-- document sets. Nothing was ever rejected on these rows: PILOT noticed the file
-- needs something and a human clicked to create it. So an ordinary new ask was
-- being presented to staff and borrower alike as a rejection.
--
-- The insert now writes 'outstanding' (the normal "not started" state). This
-- migration is the PREVIOUS-files half of that fix — the same class of row
-- already sitting on live files.
--
-- SAFETY — this only touches rows it can PROVE are the untouched artifact:
--   * created_by_kind = 'system' AND the notes carry the '[from AI suggestion]'
--     marker the insert stamps, so a human-created condition is never touched;
--   * still status = 'issue';
--   * NEVER reviewed, signed off or waived (an item a human has worked is left
--     exactly as it is);
--   * has NO rejected document — if a document really was rejected against it,
--     'issue' is CORRECT and must stay. This is the important guard: a row can
--     be born 'issue' by this bug AND later legitimately earn 'issue', and we
--     must not silently clear a real rejection.
--
-- Idempotent (the WHERE clause stops matching once flipped) and reversible in
-- effect — it only moves a row from one open state to another open state. No
-- document, sign-off, gate or audit row is altered.

UPDATE checklist_items ci
   SET status = 'outstanding'
 WHERE ci.status = 'issue'
   AND ci.created_by_kind = 'system'
   AND COALESCE(ci.notes,'') LIKE '[from AI suggestion]%'
   AND ci.reviewed_at IS NULL
   AND ci.signed_off_at IS NULL
   AND ci.waived_at IS NULL
   AND NOT EXISTS (
         SELECT 1 FROM documents d
          WHERE d.checklist_item_id = ci.id
            AND d.review_status = 'rejected');
