-- ============================================================================
-- 376 — Stop the flood-certificate condition from churning its identity on every
--       deploy (owner-reported 2026-07-30: the flood cert kept losing its history
--       and looking brand-new after each deploy).
--
-- THE BUG. The internal flood cert (rtl_cond_flood) is delete-and-recreated on
-- EVERY boot for most files, so its row id and created_at reset each deploy —
-- which nulls the foreign keys that point at it (a message about the condition,
-- a linked condition row) and resets its condition-aging clock (the file reads as
-- if the condition were just opened). Reproduced on a real database: a plain
-- Standard, non-flood file's flood cert got a fresh id + created_at on the second
-- ensureSchema() pass.
--
-- WHY IT CHURNS. Three earlier migrations DELETE an UNTOUCHED flood cert every
-- boot from files they consider out of their scope —
--   • db/207 §A2  — any file that is not Gold/Manual and not in a flood zone,
--   • db/335 §2 / db/337 §1 — any Fidelis file with no flood-zone evidence —
-- and then db/374 §2 (owner-directed 2026-07-30: "flood cert on EVERY file")
-- runs LAST and re-INSERTs a brand-new row. Delete → re-insert = a new id and a
-- reset created_at every single boot. The db/374 author noted the churn and judged
-- it harmless ("the item is untouched, so nothing is lost"); it is not — the id is
-- what the FKs and the aging metrics hang off of.
--
-- THE FIX (the pattern db/281 already established and documents in its own header).
-- Every one of those DELETEs guards on `notes IS NULL OR btrim(notes) = ''` —
-- "anything a human touched is left standing". db/281 exploits exactly this: it
-- attaches the Blue Lake / CorrFirst flood cert WITH a short marker note so
-- db/207's boot DELETE skips it and the row is stable across deploys. This
-- migration extends that same, blessed idiom to EVERY file: it stamps a marker
-- note on every UNTOUCHED, note-less flood cert, so db/207 §A2, db/335 §2 and
-- db/337 §1 all skip it from the next boot on. Nothing is deleted, so the id and
-- created_at (and every FK and aging metric) are preserved.
--
-- ORDERING. This runs LAST (after db/374, which re-adds and re-requires the cert),
-- so on the deploy that introduces it there is ONE final delete/re-insert before
-- the note lands (the item is note-less until this statement runs); from the very
-- next boot the note is present at db/207 time and no delete fires. That single
-- residual swap only ever hits an UNTOUCHED item, which is why it is safe — a
-- touched item was never in any of those DELETEs' scope to begin with.
--
-- WHAT THIS DOES NOT CHANGE. is_required stays true (db/374 owns that — required
-- on every file). The note is audience='staff' only (the flood cert is a staff
-- upload slot) and never reaches a borrower. It does not touch the template
-- (db/374 already made it auto_apply='always', rule_logic NULL, required), and it
-- never overwrites a human's note, sign-off, review, waiver, upload or payload.
--
-- One knock-on, non-destructive: on a Fidelis non-flood file the cert now survives
-- (instead of being deleted), so db/335 §3 / db/337 §2 flip is_required true→false
-- and db/374 §3 flips it back to true within the same boot. That flip bumps
-- updated_at but never changes the row id or created_at — the destructive churn is
-- gone; the harmless in-boot toggle is an accepted cost of not being able to edit
-- the append-only db/335 / db/374.
--
-- Previous AND future: this back-dates onto every existing flood cert AND, because
-- it re-runs every boot, catches any note-less cert a later boot re-creates (a
-- brand-new file the engine attached to, then db/207 removed, then db/374 re-added)
-- — after which that file is stable too. Idempotent by the note-empty guard.
-- ============================================================================

UPDATE checklist_items ci
   SET notes = '[auto] Flood determination certificate — a standing internal condition kept on every file, whatever the capital provider. This note keeps the condition from being rebuilt on each deploy so its history stays intact; it does not change what is required.',
       updated_at = now()
  FROM checklist_templates t, applications a
 WHERE ci.template_id = t.id
   AND t.code = 'rtl_cond_flood'
   AND ci.application_id = a.id
   AND a.deleted_at IS NULL
   AND a.status NOT IN ('withdrawn', 'cancelled')
   -- Only UNTOUCHED, note-less items — exactly the set db/207 §A2 / db/335 §2 /
   -- db/337 §1 delete. Setting a note here is never a clobber (there is none) and
   -- never touches a human-worked condition (it is excluded by these same tests).
   AND ci.signed_off_at IS NULL
   AND ci.reviewed_at IS NULL
   AND ci.waived_at IS NULL
   AND ci.tool_payload IS NULL
   AND (ci.notes IS NULL OR btrim(ci.notes) = '')
   AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.checklist_item_id = ci.id);
