-- 093 — Track record: personal-name ownership + per-line-item document requests.
--
-- 1) `track_records.owned_personally` — the borrower held this property under
--    their PERSONAL name (no LLC). When true the line carries no entity: the
--    tool hides the LLC/entity input and the server nulls entity_name/llc_id.
-- 2) `checklist_items.track_record_id` — a document-request condition raised by
--    the back office FOR ONE track-record line item links straight to that line.
--    Uploads to the condition inherit the link, so the document lands on the
--    line item (and in its REO/<address> folder) as well as on the condition.
-- 3) Backfills (previous AND future, owner-directed): existing raised-entity
--    conditions ('issue:tr:<id>' from src/lib/raise-issue.js) get their
--    track_record_id stamped, and documents already uploaded to those
--    conditions inherit the line-item link.

ALTER TABLE track_records
  ADD COLUMN IF NOT EXISTS owned_personally boolean NOT NULL DEFAULT false;

ALTER TABLE checklist_items
  ADD COLUMN IF NOT EXISTS track_record_id uuid REFERENCES track_records(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_checklist_items_track_record
  ON checklist_items(track_record_id) WHERE track_record_id IS NOT NULL;

-- Backfill: raised-against-track-record conditions link to their line item.
-- raised_entity = {kind:'track_record', id, name} (db/075). Guarded so a
-- deleted line item can't break the cast/FK.
UPDATE checklist_items ci
   SET track_record_id = (ci.raised_entity->>'id')::uuid
 WHERE ci.track_record_id IS NULL
   AND ci.raised_entity->>'kind' = 'track_record'
   AND (ci.raised_entity->>'id') ~ '^[0-9a-fA-F-]{36}$'
   AND EXISTS (SELECT 1 FROM track_records t WHERE t.id = (ci.raised_entity->>'id')::uuid);

-- Backfill: documents uploaded to a line-item condition inherit the link.
UPDATE documents d
   SET track_record_id = ci.track_record_id
  FROM checklist_items ci
 WHERE d.checklist_item_id = ci.id
   AND ci.track_record_id IS NOT NULL
   AND d.track_record_id IS NULL;
