-- 094 — Layered entities (owner-directed major enhancement).
--
-- An LLC's owner ("member") can now be ANOTHER ENTITY, not only a natural
-- person: llc_members grows a member_kind ('person' | 'entity') and, for
-- entity members, an owner_llc_id pointing at the owning LLC's own row in
-- llcs. The owning LLC is a first-class entity of the same borrower — it gets
-- its own info, its own three document slots (formation / EIN / operating
-- agreement via generateLlcChecklist), its own folder in SharePoint, and its
-- own verification — recursively, layer by layer, exactly like the base
-- entity. Cycle prevention + a depth cap live in src/lib/llc.js
-- (wouldCreateCycle / MAX_ENTITY_DEPTH); a child entity can only be verified
-- once every entity that owns it is verified (bottom-up).
--
-- Existing rows are all natural persons (default 'person'); no data backfill
-- is needed.

ALTER TABLE llc_members
  ADD COLUMN IF NOT EXISTS member_kind text NOT NULL DEFAULT 'person';

ALTER TABLE llc_members
  ADD COLUMN IF NOT EXISTS owner_llc_id uuid REFERENCES llcs(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_llc_member_kind') THEN
    ALTER TABLE llc_members
      ADD CONSTRAINT chk_llc_member_kind CHECK (member_kind IN ('person', 'entity'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_llc_members_owner_llc
  ON llc_members(owner_llc_id) WHERE owner_llc_id IS NOT NULL;
