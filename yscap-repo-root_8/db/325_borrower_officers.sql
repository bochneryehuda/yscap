-- ============================================================================
-- 325_borrower_officers.sql
--
-- WHO ARE MY BORROWERS? — the many-to-many answer (owner-directed 2026-07-26).
--
-- db/318 gave a borrower ONE owning officer (`borrowers.primary_officer_id`) and
-- widened the staff borrower scope to honor it. That fixed the DSCR-client-with-
-- no-file case, but it is single-valued, and the real relationship is not:
--
--   "he should be able to see a full profile for EVERY borrower where he closed
--    ANY file in the past in ClickUp"
--
-- A borrower who did an RTL deal with one officer and three DSCR deals with
-- another belongs to BOTH. With a single pointer the second officer never sees
-- them — `primary_officer_id` is fill-only (it must be: stealing an existing
-- relationship would be worse), so whoever got there first owns the person
-- forever and everybody else is locked out.
--
-- So the relationship gets its own table. One row per (borrower, officer),
-- accumulated from EVERY ClickUp card the sync reads — RTL and DSCR alike, in
-- every status — plus every portal file. `primary_officer_id` stays as the
-- borrower's PRIMARY relationship (display, routing, the CRM "owner"); this
-- table is the complete set for ACCESS.
--
-- Additive + idempotent: safe to re-run on every boot.
-- ============================================================================

CREATE TABLE IF NOT EXISTS borrower_officers (
    borrower_id   uuid NOT NULL REFERENCES borrowers(id)   ON DELETE CASCADE,
    staff_id      uuid NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
    -- How we learned about the relationship: 'clickup' (a card in their folder /
    -- naming them as the officer), 'application' (a portal loan file), 'staff'
    -- (a human set it). Informational — access does not depend on it.
    source        text NOT NULL DEFAULT 'clickup',
    -- Provenance for auditing a surprising row, and a cheap "how much business"
    -- signal for the officer's list.
    first_task_id text,
    deals         integer NOT NULL DEFAULT 0,   -- CLOSED/funded deals seen together
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_seen     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (borrower_id, staff_id)
);
-- The access lookup is "everyone who belongs to me", so staff_id leads.
CREATE INDEX IF NOT EXISTS idx_borrower_officers_staff ON borrower_officers(staff_id);

-- ---- backfill: every relationship already implied by the data ---------------
-- 1) Portal loan files — the person is the officer's, whether they are the
--    primary borrower or the co-borrower, and whether or not the file is still
--    live (a funded or descoped file is still a past client).
INSERT INTO borrower_officers (borrower_id, staff_id, source, deals, last_seen)
SELECT x.bid, x.officer_id, 'application',
       count(*) FILTER (WHERE x.status = 'funded')::int,
       max(x.created_at)
  FROM (
    SELECT a.borrower_id AS bid, a.loan_officer_id AS officer_id, a.status, a.created_at
      FROM applications a WHERE a.loan_officer_id IS NOT NULL AND a.borrower_id IS NOT NULL
    UNION ALL
    SELECT a.co_borrower_id, a.loan_officer_id, a.status, a.created_at
      FROM applications a WHERE a.loan_officer_id IS NOT NULL AND a.co_borrower_id IS NOT NULL
  ) x
 GROUP BY x.bid, x.officer_id
ON CONFLICT (borrower_id, staff_id) DO NOTHING;

-- 2) ClickUp cards the sync has already indexed — this is what carries the
--    non-RTL (DSCR / long-term) history, which never becomes a loan file.
INSERT INTO borrower_officers (borrower_id, staff_id, source, first_task_id, deals, last_seen)
SELECT t.borrower_id, t.loan_officer_id, 'clickup',
       min(t.task_id),
       count(*) FILTER (WHERE lower(btrim(coalesce(t.internal_status,''))) IN
         ('closed reconciled','closed (6-email funded)','non del closed reconciled','refinanced',
          'waiting for final docs','in purchase review','purchase conditions','pa issued-post closing.'))::int,
       max(t.last_seen)
  FROM clickup_task_index t
 WHERE t.borrower_id IS NOT NULL AND t.loan_officer_id IS NOT NULL
 GROUP BY t.borrower_id, t.loan_officer_id
ON CONFLICT (borrower_id, staff_id) DO NOTHING;

-- 3) The single-pointer relationship db/318 established stays valid.
INSERT INTO borrower_officers (borrower_id, staff_id, source)
SELECT b.id, b.primary_officer_id, 'application'
  FROM borrowers b WHERE b.primary_officer_id IS NOT NULL
ON CONFLICT (borrower_id, staff_id) DO NOTHING;
