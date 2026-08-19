-- ============================================================================
-- db/588 — WHO UNLOCKED THIS CONTACT: the vendor tells us, by email.
--
-- WHAT THIS CHANGES, AND WHY. db/587 was built on the belief that Elementix
-- cannot say who unlocked a contact, so attribution had to be established from
-- our side by giving every officer their own OAuth seat. THE OWNER SAID THAT WAS
-- WRONG ("dig in deeper, I'm 100% you can link who discovered the number by
-- email link"), AND THEY WERE RIGHT.
--
-- Measured live on 2026-08-18, against the real account:
--   · get_contact_status returns `unlockedBy` — AN EMAIL ADDRESS — and
--     `unlockedAt`. The vendor's own published description of that tool says it
--     returns only {isUnlocked, isJobCompleted}; the real response carries two
--     more fields, and one of them is the answer.
--   · list_people takes `unlockStatus:'unlocked'` and returns `unlockedBy` and
--     `unlockedAt` ON EVERY ROW. The whole history came back: 1,041 contacts,
--     13 distinct users, every single one carrying the email of the person who
--     unlocked it, and NOT ONE row missing it.
--
-- So the backfill the owner asked for — "go back to the beginning, find which
-- leads each officer already skip traced" — is not merely possible, it is two
-- calls. And no officer has to connect their own login for us to know whose
-- lead it is.
--
-- THE VENDOR'S EMAIL IS STORED AS THE VENDOR GAVE IT, ALONGSIDE the staff row we
-- matched it to and never instead of it. An email we cannot match to anybody on
-- the roster is a fact worth keeping — it is how a leaver, a typo or an account
-- nobody told us about becomes visible — and a match we guessed at would be
-- worse than no match at all.
--
-- IDEMPOTENT: every statement is IF NOT EXISTS / ON CONFLICT and re-runs on
-- every boot.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. THE VENDOR'S OWN ANSWER, kept verbatim.
--
-- `unlocked_by` (db/587) is OUR staff id and stays the thing every screen reads.
-- These two record what Elementix said, so the two can be compared — and so a
-- contact unlocked by somebody who is not on our roster still says who.
-- ---------------------------------------------------------------------------
ALTER TABLE elementix_contacts ADD COLUMN IF NOT EXISTS unlocked_by_email citext;
ALTER TABLE elementix_contacts ADD COLUMN IF NOT EXISTS vendor_unlocked_at  timestamptz;
CREATE INDEX IF NOT EXISTS idx_elx_contacts_by_email
  ON elementix_contacts (unlocked_by_email) WHERE unlocked_by_email IS NOT NULL;

ALTER TABLE elementix_skip_traces ADD COLUMN IF NOT EXISTS unlocked_by_email citext;

-- ---------------------------------------------------------------------------
-- 2. THE ELEMENTIX USER LIST — requirement #1, answerable at last.
--
-- The owner asked for "a list of all our Elementix users, linked to the loan
-- officers in PILOT". The vendor publishes no user-list tool, but every unlocked
-- contact names its unlocker, so the roster is DERIVED from the work: read the
-- unlocked list, take the distinct emails, match them to staff.
--
-- This table is that derivation, recorded rather than recomputed on every page
-- load: one row per Elementix login we have ever seen do anything.
--
-- `staff_id` NULL means "we have never matched this email to anybody" — an
-- honest state, shown on the admin screen as something to resolve, never
-- guessed at. `linked_by` NULL alongside a staff_id means the match was made by
-- the email agreeing exactly; a staff id WITH a linked_by is a human's decision,
-- and a human's decision is never overwritten by the automatic pass.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS elementix_users (
  email          citext PRIMARY KEY,
  staff_id       uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  -- Set when a PERSON decided this link (or deliberately un-linked it). The
  -- automatic matcher never writes it and never overrules it.
  linked_by      uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  linked_at      timestamptz,
  -- A human can say "this login belongs to nobody here" and have that stick.
  ignored        boolean NOT NULL DEFAULT false,
  unlock_count   integer NOT NULL DEFAULT 0,
  first_unlock_at timestamptz,
  last_unlock_at  timestamptz,
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_elx_users_staff ON elementix_users (staff_id) WHERE staff_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. THE BACKFILL'S OWN PROGRESS, so a run that stops can carry on.
--
-- 1,041 people, each needing a free contact read, against a 400-an-hour self
-- cap: this cannot be one pass and must not restart from the beginning. One row
-- per person, stamped as it is worked.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS elementix_backfill_queue (
  person_id     text PRIMARY KEY,
  person_name   text,
  person_state  text,
  unlocked_by_email citext,
  unlocked_at   timestamptz,
  -- pending  = listed, contact not read yet
  -- done     = contact read (or confirmed to have none) and the lead settled
  -- failed   = the vendor refused; kept so a retry is deliberate, not endless
  -- skipped  = nothing to do (no officer to give it to, and the owner is told)
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','done','failed','skipped')),
  attempts      integer NOT NULL DEFAULT 0,
  detail        text,
  lead_id       uuid REFERENCES leads(id) ON DELETE SET NULL,
  listed_at     timestamptz NOT NULL DEFAULT now(),
  worked_at     timestamptz
);
-- The work list: oldest listing first, only what is still waiting.
CREATE INDEX IF NOT EXISTS idx_elx_backfill_pending
  ON elementix_backfill_queue (listed_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_elx_backfill_email
  ON elementix_backfill_queue (unlocked_by_email);
