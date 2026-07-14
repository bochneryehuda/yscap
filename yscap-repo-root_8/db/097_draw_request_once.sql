-- 097 — Draw setup is requested ONCE per file (owner-directed 2026-07-14).
-- The borrower's "Request a draw" button used to fire the full email fan-out
-- on every click (nothing visible happened, so borrowers clicked it dozens of
-- times → dozens of emails). The request timestamp is now recorded on the
-- file: the endpoint no-ops (and the button greys out) once set.

ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS draw_setup_requested_at timestamptz;
