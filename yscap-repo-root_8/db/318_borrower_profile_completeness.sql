-- ============================================================================
-- 318_borrower_profile_completeness.sql
--
-- Four owner-directed borrower-profile changes (2026-07-26), all additive and
-- idempotent (every file re-runs on every boot).
--
-- 1) SHARED EMAIL (a husband and wife who use one mailbox). `borrowers.email`
--    carried a hard UNIQUE constraint, so the SECOND person could never be
--    stored under the same address: the ClickUp sync minted a
--    `noemail+<task>@clickup.local` shadow instead, and the staff "new file" /
--    invite doors 409'd. The constraint is replaced by a PARTIAL unique index
--    that ignores rows explicitly marked `shares_email` — so exactly one
--    profile OWNS an address (that one keeps the portal login and every
--    `ON CONFLICT (email)` upsert still resolves deterministically), and any
--    number of deliberately-linked people may sit alongside it.
--
-- 2) BORROWER → LOAN OFFICER. An officer's "my borrowers" book was derived
--    ONLY from RTL loan files. Every DSCR / non-RTL ClickUp card builds a full
--    borrower profile but never a loan file, so those people were invisible to
--    the officer who owns them. `borrowers.primary_officer_id` already existed
--    but was never populated from the sync — backfill it from every file the
--    person is on (primary OR co-borrower), and record the resolved officer on
--    the task index so non-RTL cards can carry one too.
--
-- 3) The borrower CRM profile now edits HOUSING + employment, which already
--    live on `borrowers` — no new columns needed, only the index that makes
--    "everyone who belongs to this officer" a cheap lookup.
-- ============================================================================

-- ---- 1) shared email ------------------------------------------------------
ALTER TABLE borrowers ADD COLUMN IF NOT EXISTS shares_email boolean NOT NULL DEFAULT false;

-- Drop the blanket UNIQUE (constraint + its implicit index) and re-create it as
-- a PARTIAL unique index over the address OWNERS only. Guarded so a re-run is a
-- no-op. NOTE: every `ON CONFLICT (email)` upsert in the codebase now names the
-- same predicate (`... WHERE shares_email = false`) so Postgres can infer this
-- index — they were updated in the same change.
ALTER TABLE borrowers DROP CONSTRAINT IF EXISTS borrowers_email_key;
DROP INDEX IF EXISTS borrowers_email_key;
CREATE UNIQUE INDEX IF NOT EXISTS borrowers_email_owner_uk
  ON borrowers (email) WHERE shares_email = false;
-- Plain lookup index for the (now non-unique) address: every email→borrower
-- read still needs to be O(log n).
CREATE INDEX IF NOT EXISTS idx_borrowers_email ON borrowers (email);

-- ---- 2) officer ownership of a borrower -----------------------------------
ALTER TABLE clickup_task_index
  ADD COLUMN IF NOT EXISTS loan_officer_id uuid REFERENCES staff_users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_clickup_task_index_officer
  ON clickup_task_index(loan_officer_id) WHERE loan_officer_id IS NOT NULL;

-- Backfill the owning officer from the borrower's own files — PRIMARY borrower
-- first (the strongest claim), then co-borrower-only people. Soft-deleted and
-- descoped files count: a DSCR file that was descoped out of the portal is
-- still that officer's client. Fill-only — never steals an officer a human set.
UPDATE borrowers b
   SET primary_officer_id = x.officer_id, updated_at = now()
  FROM (SELECT DISTINCT ON (a.borrower_id) a.borrower_id AS bid, a.loan_officer_id AS officer_id
          FROM applications a
         WHERE a.loan_officer_id IS NOT NULL
         ORDER BY a.borrower_id, a.created_at DESC) x
 WHERE b.id = x.bid AND b.primary_officer_id IS NULL;

UPDATE borrowers b
   SET primary_officer_id = x.officer_id, updated_at = now()
  FROM (SELECT DISTINCT ON (a.co_borrower_id) a.co_borrower_id AS bid, a.loan_officer_id AS officer_id
          FROM applications a
         WHERE a.loan_officer_id IS NOT NULL AND a.co_borrower_id IS NOT NULL
         ORDER BY a.co_borrower_id, a.created_at DESC) x
 WHERE b.id = x.bid AND b.primary_officer_id IS NULL;

-- Non-RTL (DSCR / long-term) ClickUp cards never build a loan file, so their
-- people can only be attributed through the task index. Any row whose officer
-- the sync has already resolved fills the profile the same way.
UPDATE borrowers b
   SET primary_officer_id = x.officer_id, updated_at = now()
  FROM (SELECT DISTINCT ON (t.borrower_id) t.borrower_id AS bid, t.loan_officer_id AS officer_id
          FROM clickup_task_index t
         WHERE t.borrower_id IS NOT NULL AND t.loan_officer_id IS NOT NULL
         ORDER BY t.borrower_id, t.last_seen DESC) x
 WHERE b.id = x.bid AND b.primary_officer_id IS NULL;

-- ---- 1b) ONE portal login per email address --------------------------------
-- Two people may now SHARE an email, but only one of them can hold the portal
-- LOGIN for it: every sign-in / reset / verify path resolves an account by
-- `borrowers JOIN borrower_auth ON email = ?`, and a second credentialed row on
-- the same address would make that lookup ambiguous (a coin-flip on whose file
-- you land in). Enforced in the database so no route can bypass it — the door
-- checks (staff invite / set-password) give the friendly wording, this is the
-- backstop. Raised as 23505 so the existing "that email is already in use"
-- handlers answer sensibly if one is ever missed.
CREATE OR REPLACE FUNCTION borrower_auth_one_login_per_email() RETURNS trigger AS $$
DECLARE
  addr citext;
  other uuid;
BEGIN
  SELECT email INTO addr FROM borrowers WHERE id = NEW.borrower_id;
  IF addr IS NULL THEN RETURN NEW; END IF;
  SELECT b.id INTO other
    FROM borrowers b JOIN borrower_auth a ON a.borrower_id = b.id
   WHERE b.email = addr AND b.id <> NEW.borrower_id
   LIMIT 1;
  IF other IS NOT NULL THEN
    RAISE EXCEPTION 'another borrower profile already has the portal login for %', addr
      USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_borrower_auth_one_login_per_email ON borrower_auth;
CREATE TRIGGER trg_borrower_auth_one_login_per_email
  BEFORE INSERT ON borrower_auth
  FOR EACH ROW EXECUTE FUNCTION borrower_auth_one_login_per_email();
