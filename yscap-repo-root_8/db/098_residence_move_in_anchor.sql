-- 098 — Residence duration is anchored to a MOVE-IN DATE, not a static count
--       (owner-directed 2026-07-14).
--
-- The borrower enters "2 years 3 months at this address" once. Storing that as
-- a frozen number means a file started a year later still shows 2y3m. Instead
-- we store the DATE they moved in (derived from the count + the moment they
-- entered it), and compute the live duration at any later date on read. The
-- frontend stays simple (years/months inputs); the backend keeps the anchor.
--
-- residence_since is the derived move-in date. years_at_residence /
-- months_at_residence are kept (back-compat + the source when a borrower
-- re-enters a fresh count), but the LIVE duration is always computed from
-- residence_since when it is present.
--
-- Backfill: for existing rows that have a count but no anchor, derive the
-- move-in date from the count as of updated_at (the best available "as of"
-- timestamp for when the count was last accurate).

ALTER TABLE borrowers
  ADD COLUMN IF NOT EXISTS residence_since date;

UPDATE borrowers
   SET residence_since = (
         COALESCE(updated_at, now())
         - make_interval(years => FLOOR(COALESCE(years_at_residence,0))::int,
                         months => COALESCE(months_at_residence,0)
                                   + ROUND((COALESCE(years_at_residence,0) - FLOOR(COALESCE(years_at_residence,0))) * 12)::int)
       )::date
 WHERE residence_since IS NULL
   AND (COALESCE(years_at_residence,0) > 0 OR COALESCE(months_at_residence,0) > 0);
