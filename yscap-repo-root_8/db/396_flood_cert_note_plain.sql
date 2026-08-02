-- ============================================================================
-- 396 — The flood-certificate marker note is STAFF-FACING, so it must read like a
--       note a colleague would leave (owner-directed 2026-08-02: "for a
--       professional system it doesn't make sense to have notes like this … the
--       front-end staff should just see what they need to see").
--
-- WHAT WAS WRONG. Two auto notes sit on the internal flood cert (rtl_cond_flood)
-- and BOTH talk to the wrong audience:
--   • db/376 — "…a standing internal condition kept on every file, whatever the
--     capital provider. This note keeps the condition from being rebuilt on each
--     deploy so its history stays intact…" — that is PLUMBING. A processor opening
--     the condition does not care how our migrations avoid churn.
--   • db/281 — "…(capital-partner requirement). Auto-added by the Condition
--     Center; an underwriter can waive it if the deal no longer needs it." — leaks
--     WHICH capital partner drives a requirement to front-line staff, and is now
--     simply WRONG: db/374 made the flood cert universal and required on every
--     file, so it is not a per-partner requirement and not waivable by default.
--
-- WHY THE NOTE CANNOT SIMPLY BE DELETED. It is LOAD-BEARING. db/207 §A2, db/335 §2
-- and db/337 §1 each DELETE an untouched flood cert on every boot, guarded on
-- `notes IS NULL OR btrim(notes) = ''`. A NON-EMPTY note is exactly what makes them
-- skip the row — that is the whole mechanism db/376 introduced to stop the cert
-- losing its id/created_at (and its FKs and aging clock) on every deploy. Blanking
-- it would resurrect that bug. The note's CONTENT, however, is free — so this
-- rewrites the text and keeps the marker.
--
-- ORDERING. Runs after db/281 and db/376, so on the boot that introduces it those
-- migrations stamp their old text and this converts it in the SAME pass; from then
-- on the note is already correct and every one of them is a no-op (db/376 only
-- stamps note-less items, and the WHERE below no longer matches).
--
-- A HUMAN'S WORDS ARE NEVER LOST. If somebody appended their own text to the auto
-- note, only the auto sentence is replaced and their remainder is carried over —
-- the same surgical replace()+NULLIF idiom db/374 §3 uses. Idempotent: the guard
-- matches only a row still carrying one of the two OLD texts.
-- ============================================================================

UPDATE checklist_items ci
   SET notes = CASE
         WHEN NULLIF(btrim(replace(replace(ci.notes,
                '[auto] Flood determination certificate — a standing internal condition kept on every file, whatever the capital provider. This note keeps the condition from being rebuilt on each deploy so its history stays intact; it does not change what is required.', ''),
                '[auto] A flood determination certificate is required on this file (capital-partner requirement). Auto-added by the Condition Center; an underwriter can waive it if the deal no longer needs it.', '')), '') IS NULL
           THEN '[auto] Required on every file — attach the flood determination certificate.'
         ELSE '[auto] Required on every file — attach the flood determination certificate.' || E'\n\n' ||
              btrim(replace(replace(ci.notes,
                '[auto] Flood determination certificate — a standing internal condition kept on every file, whatever the capital provider. This note keeps the condition from being rebuilt on each deploy so its history stays intact; it does not change what is required.', ''),
                '[auto] A flood determination certificate is required on this file (capital-partner requirement). Auto-added by the Condition Center; an underwriter can waive it if the deal no longer needs it.', ''))
       END,
       updated_at = now()
  FROM checklist_templates t
 WHERE ci.template_id = t.id
   AND t.code = 'rtl_cond_flood'
   -- Only a row still carrying one of the two OLD auto texts. A human's own note
   -- (and an already-converted row) is never touched, so this is a no-op from the
   -- second boot on.
   AND (ci.notes LIKE '%standing internal condition kept on every file%'
        OR ci.notes LIKE '%(capital-partner requirement)%');
