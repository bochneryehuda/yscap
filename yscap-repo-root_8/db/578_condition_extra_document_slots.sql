-- ============================================================================
-- db/578 — EXTRA NAMED DOCUMENT SLOTS ON A CONDITION (owner-directed 2026-08-18).
--
-- The owner: "Within a condition — let's say you got one document and you wanna
-- request another document within that condition. Technically, the document that
-- he sent, you accepted it, but you don't wanna sign off this condition [and]
-- you don't wanna go post a brand new underwriting condition for it. The same
-- way the appraisal condition has two slots — on conditions that don't have two
-- slots open, there should be a button for the staff members to open up another
-- slot in a condition and type the name of that slot. That should populate as an
-- open item needing it. If it's on an external condition, it should populate as
-- an open item needing from external. If it's internal, it should be open as an
-- item from internal. … When that document is uploaded, it should be uploaded as
-- part of the condition, included in the same folder of the TPR export."
--
-- checklist_items.extra_slots is a jsonb ARRAY of the ad-hoc slots staff opened
-- on THIS item — [{key, label, audience:'external'|'internal', added_by,
-- added_by_name, added_at}] — beside the TEMPLATE's fixed `slots` (db/144's
-- shape). One definition of everything about them: src/lib/conditions/extra-slots.js
-- (validation, the atomic append, the sign-off gate, the borrower's
-- still-needed view). Documents fill a slot exactly the way template slots fill
-- (documents.slot_label base-label match), so the whole existing slot UI, the
-- TPR folder (same checklist_item), and SharePoint all inherit for free.
--
-- BACKFILL: none — the column starts NULL (no slots requested) on every
-- existing item, which reads identically to before.
-- ============================================================================

ALTER TABLE checklist_items
  ADD COLUMN IF NOT EXISTS extra_slots jsonb;
