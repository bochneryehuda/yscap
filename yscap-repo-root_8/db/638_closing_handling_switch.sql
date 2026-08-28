-- ============================================================================
-- db/638 — closing handling switch
--
-- WHAT THIS CHANGES, AND WHY (owner-directed 2026-08-28): WHO HANDLES THE
-- CLOSING is now a recorded, three-way setting instead of an unstated
-- assumption that the attorney always does. The owner: "we should have a
-- switch in the API health page … if the attorney is handling the closing or
-- we are handling the closing in house, that should be the default for the
-- company and then in the closing section for each and every file, we can go
-- in and set and flip it … And on each and every note buyer you can choose by
-- default settings who's handling the closing. And there should be three
-- options: internal … attorney … lender directly."
--
-- Three layers, narrowest wins (src/lib/closing-handling.js is the ONE
-- resolver): the FILE's own override → the file's NOTE BUYER's default → the
-- COMPANY default → 'attorney' (exactly what every file did before this
-- landed, so nothing changes until somebody flips something).
--
--   · closing_handling_settings — the company default row (scope='company')
--     and one row per note buyer (scope='note_buyer', keyed on the normalized
--     note-buyer key so every spelling of a name shares one setting).
--   · applications.closing_handling — the per-file override, NULL = inherit.
--     (The owner asked for this per-file flip by name, which is what allows a
--     column on applications here.)
--
-- SEED (the owner's own prefill): "you can pre-fill that TempleView and RCN is
-- lender directly. Everything else should be attorney." Templeview + RCN get
-- lender_direct rows; the company default row is NOT seeded — an absent row IS
-- 'attorney' in the resolver, so the company default stays a deliberate,
-- visible choice on the settings page rather than a row nobody remembers
-- writing. Seeds are idempotent (ON CONFLICT DO NOTHING) and never overwrite a
-- later human choice. (The owner also mentioned a third buyer to prefill in
-- wording we could not read with certainty — "Our OC" — so nothing was seeded
-- for it; the settings page flips any buyer in one click.)
--
-- BACKFILL: none beyond the seeds — every file inherits 'attorney' through the
-- resolver, which is today's behavior.
--
-- PRODUCT SEPARATION: RTL only (closings, note buyers and `applications` are
-- RTL). Nothing here touches lt_*.
-- ============================================================================

CREATE TABLE IF NOT EXISTS closing_handling_settings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope           text NOT NULL CHECK (scope IN ('company', 'note_buyer')),
  -- The NORMALIZED note-buyer key (field-registry.normNoteBuyer: lowercased,
  -- non-alphanumerics stripped) so "RCN Capital, LLC" and "rcn capital" share
  -- one setting. NULL exactly when scope='company'.
  note_buyer_key  text,
  handling        text NOT NULL CHECK (handling IN ('internal', 'attorney', 'lender_direct')),
  updated_by      uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT closing_handling_scope_key_chk
    CHECK ((scope = 'company' AND note_buyer_key IS NULL) OR (scope = 'note_buyer' AND note_buyer_key IS NOT NULL))
);

-- Exactly one company row; exactly one row per buyer key.
CREATE UNIQUE INDEX IF NOT EXISTS closing_handling_company_uk
  ON closing_handling_settings ((1)) WHERE scope = 'company';
CREATE UNIQUE INDEX IF NOT EXISTS closing_handling_buyer_uk
  ON closing_handling_settings (note_buyer_key) WHERE scope = 'note_buyer';

-- The per-file override (NULL = inherit the note-buyer / company default).
ALTER TABLE applications ADD COLUMN IF NOT EXISTS closing_handling text;
ALTER TABLE applications DROP CONSTRAINT IF EXISTS applications_closing_handling_chk;
ALTER TABLE applications ADD CONSTRAINT applications_closing_handling_chk
  CHECK (closing_handling IS NULL OR closing_handling IN ('internal', 'attorney', 'lender_direct'));

-- The owner's prefill: Templeview + RCN close with the lender directly. Keyed on
-- the normalized name; a human's later change on the settings page is never
-- overwritten (ON CONFLICT DO NOTHING, replayed safely on every boot).
INSERT INTO closing_handling_settings (scope, note_buyer_key, handling)
VALUES ('note_buyer', 'templeview', 'lender_direct')
ON CONFLICT (note_buyer_key) WHERE scope = 'note_buyer' DO NOTHING;
INSERT INTO closing_handling_settings (scope, note_buyer_key, handling)
VALUES ('note_buyer', 'rcn', 'lender_direct')
ON CONFLICT (note_buyer_key) WHERE scope = 'note_buyer' DO NOTHING;

-- THE SETTLEMENT-AGENT ORDER rides the same orders desk (file_orders), so the
-- order_type CHECK widens to carry it. Re-asserting ALL prior values (title,
-- insurance, attorney from db/359, appraisal from db/564) because every file
-- replays on every boot and a narrower re-assert would break the older rows.
ALTER TABLE file_orders DROP CONSTRAINT IF EXISTS file_orders_order_type_check;
ALTER TABLE file_orders
  ADD CONSTRAINT file_orders_order_type_check
  CHECK (order_type IN ('title','insurance','attorney','appraisal','settlement'));
-- Same guarded shape as db/564: replace a constraint ONLY when it is nothing
-- but an order_type IN-list (never a composite check), then re-add the widened
-- list UNDER A FIXED NAME so the boot runner's superseded-constraint pre-scan
-- can see this file as the name's latest definer.
DO $$
DECLARE cname text;
BEGIN
  IF to_regclass('public.file_order_events') IS NULL THEN RETURN; END IF;
  SELECT con.conname INTO cname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
   WHERE rel.relname = 'file_order_events'
     AND con.contype = 'c'
     AND pg_get_constraintdef(con.oid) ILIKE '%order_type%'
     AND pg_get_constraintdef(con.oid) NOT ILIKE '%kind%'
     AND pg_get_constraintdef(con.oid) NOT ILIKE '%status%'
     AND pg_get_constraintdef(con.oid) NOT ILIKE '%application_id%'
   LIMIT 1;
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE file_order_events DROP CONSTRAINT %I', cname);
  END IF;
  EXECUTE 'ALTER TABLE file_order_events ADD CONSTRAINT file_order_events_order_type_check '
       || 'CHECK (order_type IN (''title'',''insurance'',''attorney'',''appraisal'',''settlement''))';
END $$;

-- ── after this lands ────────────────────────────────────────────────────────
-- The schema map (docs/schema/) describes the database these migrations build,
-- so this file makes it stale. CI refreshes it on this pull request by itself.
