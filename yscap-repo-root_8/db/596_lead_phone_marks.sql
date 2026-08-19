-- ============================================================================
-- db/596 — lead phone marks
--
-- WHAT THIS CHANGES, AND WHY. The RTL lead CRM shows every phone number a
-- person has — the lead's own two plus everything the Elementix unlock
-- brought in — but an officer who rang one had nowhere to record the verdict
-- (owner-directed 2026-08-19: "I should be able to mark any of the numbers
-- that are not working, but it should NOT be removed … mark which phone
-- number is actually working … even a non-answered call, I should be able to
-- put in that this number is working and this is going to the right person").
-- This table is that verdict, one row per (lead, number): NEVER a delete of
-- the number anywhere — a dead number stays listed wearing its mark, because
-- the fact that it is dead IS the information (nobody should redial it next
-- month). `status` NULL means unmarked (a cleared mark keeps the row —
-- nothing here is ever removed); `right_person` records "this number reaches
-- the person on this lead", which the owner separated from answered/working
-- (a voicemail greeting can prove the right person on a call nobody
-- answered). `phone_key` is the normalized digits form produced by
-- src/lib/elementix/crm.js phoneKey — the ONE phone identity used across the
-- Elementix plane — so "(555) 123-4567" and "5551234567" are one row.
--
-- IDEMPOTENT. CREATE TABLE IF NOT EXISTS only.
--
-- BACKFILL. None — a mark exists only once an officer makes one; there is no
-- historical source to derive verdicts from, and guessing one would put words
-- in officers' mouths.
--
-- PRODUCT SEPARATION. `leads` is RTL (db/008); nothing here touches lt_*.
-- ============================================================================

CREATE TABLE IF NOT EXISTS lead_phone_marks (
  lead_id      uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  phone_key    text NOT NULL,
  status       text CHECK (status IN ('working','not_working')),
  right_person boolean,
  marked_by    uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  marked_at    timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (lead_id, phone_key)
);
