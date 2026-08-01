-- 393 — The two investor gates, on the copies db/367 could not reach.
--
-- db/367 renamed 'Final review requested' -> 'Investor final review' and
-- 'CTC — Clear to Close received' -> 'Investor Clear to Close (CTC)' after the
-- owner's 2026-07-29 note that both are the INVESTOR's answer. That work is
-- right and this migration does not revisit it — the wording below is db/367's,
-- character for character, so the two spellings can never disagree.
--
-- WHAT IT MISSED. Every statement in db/367 joins checklist_items to
-- checklist_templates, so it can only reach an item that HAS a template_id.
-- Measured on a real database: 103 of 43,633 items on files carry NO template
-- at all (they arrive through paths that create a condition without one), and
-- among them was exactly one live file still reading 'Final review requested'
-- and one still reading 'CTC — Clear to Close received'. Two loan files kept
-- the old words on the very screen db/367 was written to correct.
--
-- Guarded so tightly that only a verbatim copy of the seeded condition can
-- match: no template, the EXACT old label, the same item_kind, and the same
-- staff audience (neither of these is ever borrower-facing). Anything a human
-- wrote in their own words is untouched.
--
-- Idempotent: guarded on the old text, so a re-run — which happens on every
-- boot — matches nothing once applied.

UPDATE checklist_items SET label = 'Investor final review', updated_at = now()
 WHERE template_id IS NULL AND label = 'Final review requested'
   AND item_kind = 'condition' AND audience = 'staff';

UPDATE checklist_items SET label = 'Investor Clear to Close (CTC)', updated_at = now()
 WHERE template_id IS NULL AND label = 'CTC — Clear to Close received'
   AND item_kind = 'condition' AND audience = 'staff';

-- The hint is the half that actually says WHO the answer comes from, so a
-- template-less copy gets it too — but only into an EMPTY hint, never over
-- somebody's own words. Runs after the renames above, so it matches on the NEW
-- label and is a no-op on the next boot.
UPDATE checklist_items SET
       hint = 'The investor reviews the full file. Clear this when their approval comes back — not when we send it. Last step before their CTC.',
       updated_at = now()
 WHERE template_id IS NULL AND label = 'Investor final review'
   AND item_kind = 'condition' AND audience = 'staff'
   AND NULLIF(BTRIM(COALESCE(hint, '')), '') IS NULL;

UPDATE checklist_items SET
       hint = 'The Clear to Close is issued BY the investor. Clear this only when their written CTC is on the file — PILOT never issues one.',
       updated_at = now()
 WHERE template_id IS NULL AND label = 'Investor Clear to Close (CTC)'
   AND item_kind = 'condition' AND audience = 'staff'
   AND NULLIF(BTRIM(COALESCE(hint, '')), '') IS NULL;
