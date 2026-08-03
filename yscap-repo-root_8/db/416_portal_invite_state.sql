-- 416 — THE FILE SAYS WHERE EACH BORROWER STANDS WITH THE PORTAL
--
-- Owner-directed 2026-08-02: the loan file must show, for the borrower AND the
-- co-borrower, whether they were invited to the portal and when, with a way to
-- send it again — and whether they actually joined and when they last signed in.
--
-- WHAT WAS MISSING. Two "Invite" buttons existed (the file's primary invite and
-- the co-borrower's own), and both were WRITE-ONLY: you pressed one, a transient
-- green line appeared, and nothing on the screen ever said it had happened. So
-- "did anyone ever invite this person?" could not be answered, and the honest
-- answer to "should I send it again?" was always a shrug.
--
-- WHY THE INVITE IS RECORDED ON THE BORROWER, not read back out of invite_tokens.
-- Three reasons, each a real defect of the token table for this purpose:
--   1. A token row is only written when the person has NO login yet. Inviting
--      somebody who already has one sends a SIGN-IN link and writes nothing — so
--      the most common re-send is invisible.
--   2. invite_tokens is keyed on EMAIL, with no borrower_id. db/318 deliberately
--      allows TWO profiles to share one mailbox (a husband and wife), so reading
--      invites back by email would show one person the other's history.
--   3. A borrower whose email is later corrected loses the whole trail.
-- The person's portal login is per-PERSON (borrower_auth.borrower_id), so the
-- invite belongs on the person too.
--
-- WHAT EACH COLUMN IS FOR:
--   portal_invited_at        the LAST time we sent it — what "send it again?" is judged on
--   portal_first_invited_at  the FIRST time — how long they have been ignoring it
--   portal_invite_count      how many times, so a fifth send reads as a fifth send
--   portal_invited_by        which staffer sent the last one (NULL = the borrower's
--                            own side sent it, e.g. a co-borrower invited from the
--                            borrower portal, or a self-registration claim email)
--   portal_invited_email     the address it actually went to, so an invite sent to
--                            a since-corrected address is visibly stale rather than
--                            silently counted as "we told them"
--
-- JOINED / LAST SIGNED IN need no new columns: borrower_auth.created_at is the
-- moment the login came into existence and last_login_at is already maintained.

ALTER TABLE borrowers ADD COLUMN IF NOT EXISTS portal_invited_at       timestamptz;
ALTER TABLE borrowers ADD COLUMN IF NOT EXISTS portal_first_invited_at timestamptz;
ALTER TABLE borrowers ADD COLUMN IF NOT EXISTS portal_invite_count     integer NOT NULL DEFAULT 0;
ALTER TABLE borrowers ADD COLUMN IF NOT EXISTS portal_invited_by       uuid REFERENCES staff_users(id);
ALTER TABLE borrowers ADD COLUMN IF NOT EXISTS portal_invited_email    citext;

-- PREVIOUS AND FUTURE. Every invite already sent that DID mint a token is
-- recovered here, so the panel is populated on the first deploy rather than only
-- for people invited from now on.
--
-- SCOPED TO AN UNAMBIGUOUS MAILBOX. A token names an email, not a person, so it
-- is only attributed when exactly ONE borrower profile carries that address —
-- which is precisely the shared-mailbox case (db/318) the email key cannot tell
-- apart. Attributing one spouse's invite to the other would be worse than
-- leaving the line blank, and a blank line reads honestly ("not invited yet")
-- until somebody presses the button.
--
-- Guarded on portal_invited_at IS NULL so it can never overwrite a real stamp
-- written by the live code on a later boot; idempotent.
WITH sole AS (
  -- borrowers whose email is theirs alone
  SELECT b.id, b.email
    FROM borrowers b
   WHERE b.email IS NOT NULL
     AND (SELECT count(*) FROM borrowers b2 WHERE b2.email = b.email) = 1
), inv AS (
  SELECT s.id AS borrower_id,
         min(t.created_at)                                      AS first_at,
         max(t.created_at)                                      AS last_at,
         count(*)::int                                          AS n,
         (array_agg(t.created_by ORDER BY t.created_at DESC))[1] AS last_by,
         s.email                                                AS to_email
    FROM sole s
    JOIN invite_tokens t ON t.email = s.email AND t.kind = 'borrower'
   GROUP BY s.id, s.email
)
UPDATE borrowers b
   SET portal_invited_at       = inv.last_at,
       portal_first_invited_at = inv.first_at,
       portal_invite_count     = inv.n,
       portal_invited_by       = inv.last_by,
       portal_invited_email    = inv.to_email
  FROM inv
 WHERE inv.borrower_id = b.id
   AND b.portal_invited_at IS NULL;

-- The panel asks for one borrower at a time; no index is needed for that. This
-- one serves the "who have we invited and never heard from" reading.
CREATE INDEX IF NOT EXISTS idx_borrowers_portal_invited
    ON borrowers(portal_invited_at) WHERE portal_invited_at IS NOT NULL;
