-- 119_grandfather_email_verified.sql — S1-08 lockout guard.
--
-- S1-08 makes the borrower LOGIN require a confirmed email (a self-registered
-- account must prove it owns the address before it gets a session). To avoid
-- locking out EXISTING borrowers who never happened to click a verify link,
-- grandfather every account that has clearly already proven itself: it has
-- logged in before, OR it owns a real application (a file exists for them).
-- Those are unambiguously legitimate users. Genuinely-never-used accounts stay
-- unverified and must confirm on their next login (which re-sends the one-click
-- link). Idempotent (only flips false→true, never the reverse).
UPDATE borrower_auth ba
   SET email_verified = true,
       email_verified_at = COALESCE(ba.email_verified_at, now())
 WHERE ba.email_verified = false
   AND (ba.last_login_at IS NOT NULL
        OR EXISTS (SELECT 1 FROM applications a
                    WHERE a.borrower_id = ba.borrower_id
                       OR a.co_borrower_id = ba.borrower_id));
