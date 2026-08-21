-- ============================================================================
-- db/602 — the data tape's investor contacts are its OWN, and the tape send can
--          be scheduled
--
-- WHAT THIS CHANGES, AND WHY (owner-reported 2026-08-21). Sending the data tape
-- to an investor prefilled the DRAW team's addresses: "It's automatically
-- filling in the FileContacts as those same as the draw. It's a different
-- contact." That is exactly what the data said — db/454 built
-- `investor_delivery_contacts` for the DRAW delivery, keyed on the note buyer
-- ALONE, and the tape send (2026-08-18) read the same book. One buyer, one list,
-- two completely different conversations: the draw team releases construction
-- money, the tape desk reviews a new file for purchase.
--
-- So a contact now carries WHICH conversation it belongs to. `purposes` is an
-- ARRAY rather than a single column on purpose: one person can genuinely handle
-- both, and a scalar would have forced a second row for them — which the
-- existing unique index (label_norm, lower(email)) forbids. Keeping that index
-- untouched also means db/454 replays cleanly for ever.
--
-- DEFAULT 'draw', so every row already in the table keeps the meaning it was
-- entered with and the draw delivery reads byte-for-byte the list it read
-- yesterday. Nothing about draws changes.
--
-- The owner supplied the tape addresses:
--   Fidelis  → MBrancatella@fidelis-investors.com
--   EMCAP    → bdetommaso@emcapfinancial.com, tmartello@emcapfinancial.com
--
-- EMCAP RE-KEYING. `investorKeyFor` folds every EMCAP spelling onto 'emcap' via
-- the blessed prefix helper (field-registry.isEmcapNoteBuyer), the same way it
-- has always folded Fidelis. Any row saved before that fold landed under the
-- unfolded key ('emcapfinancial', 'emcapfinancialllc') and would be invisible
-- afterwards, so those rows are moved onto 'emcap' here — skipping any whose
-- address is already there, so the unique index can never refuse the move.
--
-- SCHEDULING. db/599 gave four order emails a scheduled send; the tape send is
-- the fifth ("We need to add the scheduling feature over there"). Widening the
-- kind CHECK is one value, re-added under db/599's OWN constraint name — the
-- runner recognises the earlier file's narrower re-add as superseded ONLY when
-- the later file re-defines the SAME name (migrate-boot.isSupersededConstraintFailure).
-- A new name would leave db/599 re-narrowing on every boot with no recognition.
--
-- IDEMPOTENT. ADD COLUMN IF NOT EXISTS; the seed is ON CONFLICT DO UPDATE and
-- converges (adding 'tape' to a list that already has it is a no-op); the
-- re-key is a WHERE-guarded UPDATE that matches nothing on the second run; the
-- CHECK is DROP-then-ADD.
--
-- BACKFILL: the DEFAULT does it — Postgres stamps every existing row 'draw' as
-- the column is added, so there is no separate UPDATE to get wrong and no window
-- in which a row has no purpose.
--
-- PRODUCT SEPARATION: RTL. `investor_delivery_contacts` and `scheduled_sends`
-- are both RTL tables; nothing here references `lt_*`.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. WHICH conversation a contact belongs to.
ALTER TABLE investor_delivery_contacts
  ADD COLUMN IF NOT EXISTS purposes text[] NOT NULL DEFAULT ARRAY['draw']::text[];

-- Only the two we know about. A typo'd purpose is a list nobody would ever be
-- read from — silent, and exactly the kind of thing that is noticed months later.
ALTER TABLE investor_delivery_contacts DROP CONSTRAINT IF EXISTS inv_contact_purposes_chk;
ALTER TABLE investor_delivery_contacts ADD CONSTRAINT inv_contact_purposes_chk
  CHECK (
    array_length(purposes, 1) >= 1
    AND purposes <@ ARRAY['draw','tape']::text[]
  );

-- Reading a list is `'tape' = ANY(purposes)`; this makes that indexed.
CREATE INDEX IF NOT EXISTS idx_inv_contact_purposes
  ON investor_delivery_contacts USING GIN (purposes);

-- ---------------------------------------------------------------------------
-- 2. Fold any pre-existing EMCAP rows onto the key investorKeyFor now returns.
-- Guarded both ways: only rows that are NOT already on 'emcap', and only where
-- the same address is not already sitting there.
UPDATE investor_delivery_contacts c
   SET label_norm = 'emcap', updated_at = now()
 WHERE c.label_norm LIKE 'emcap%'
   AND c.label_norm <> 'emcap'
   AND NOT EXISTS (
     SELECT 1 FROM investor_delivery_contacts d
      WHERE d.label_norm = 'emcap' AND lower(d.email) = lower(c.email));

-- ---------------------------------------------------------------------------
-- 3. The owner's tape-delivery contacts.
-- ON CONFLICT DO UPDATE (never DO NOTHING): the address may already be on file
-- as a DRAW contact, and the point of this row is to add the tape purpose to it.
-- The update is written so re-running adds nothing a second time.
INSERT INTO investor_delivery_contacts (label_norm, label, email, role, purposes) VALUES
  ('fidelis', 'Fidelis', 'mbrancatella@fidelis-investors.com', 'Data tape delivery', ARRAY['tape']::text[]),
  ('emcap',   'EMCAP',   'bdetommaso@emcapfinancial.com',      'Data tape delivery', ARRAY['tape']::text[]),
  ('emcap',   'EMCAP',   'tmartello@emcapfinancial.com',       'Data tape delivery', ARRAY['tape']::text[])
ON CONFLICT (label_norm, lower(email)) DO UPDATE
  SET purposes = CASE
        WHEN 'tape' = ANY(investor_delivery_contacts.purposes) THEN investor_delivery_contacts.purposes
        ELSE investor_delivery_contacts.purposes || 'tape'::text
      END,
      active = true,
      updated_at = now()
  WHERE NOT ('tape' = ANY(investor_delivery_contacts.purposes)) OR investor_delivery_contacts.active = false;

-- ---------------------------------------------------------------------------
-- 4. The tape send joins the four schedulable order emails.
-- SAME constraint name as db/599 — see the header.
ALTER TABLE scheduled_sends DROP CONSTRAINT IF EXISTS scheduled_sends_kind_chk;
ALTER TABLE scheduled_sends ADD CONSTRAINT scheduled_sends_kind_chk
  CHECK (kind IN ('title_order','insurance_order','closing_prep','investor_delivery','tape_to_investor'));
