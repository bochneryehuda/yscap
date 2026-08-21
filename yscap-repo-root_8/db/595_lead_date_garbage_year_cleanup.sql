-- ============================================================================
-- db/595 — lead date garbage year cleanup
--
-- WHAT THIS CHANGES, AND WHY. The lead CRM's "Next follow-up" box saved on
-- every keystroke with NO date validation, and an HTML date input fires change
-- with each intermediate value while the year is typed (0002 → 0020 → 0202 →
-- 2026) — so a mid-type fragment or a 2-digit-year artifact ("26" → 0026)
-- could land in leads.next_follow_up / leads.estimated_close verbatim
-- (owner-reported 2026-08-19: "you type the date, and it doesn't get saved" —
-- the racing saves also wiped the field). The PATCH now routes both dates
-- through normalizeTypedDate (src/routes/staff.js), and the input is
-- draft-commit (DateCommitInput); this file repairs what the old door already
-- stored. A year outside 1900–2100 is provably that bug's residue, and it is
-- NULLED, never guessed at (wipe-don't-guess, the DOB doctrine): a mid-type
-- fragment like 0020-08-25 carries no recoverable intent — pivoting it to 2020
-- would mark the lead overdue for a follow-up nobody chose, while a blank is
-- visible and the officer simply sets the real date in the fixed field. Each
-- wipe is recorded on the audit log with the value it removed (the old value
-- is captured in a pre-select CTE — UPDATE ... RETURNING yields the NEW value,
-- which here is NULL).
--
-- IDEMPOTENT. The WHERE finds only out-of-window years, and a repaired row is
-- NULL, so the second replay matches nothing.
--
-- BACKFILL. This file IS the backfill; no other data moves.
--
-- PRODUCT SEPARATION. `leads` is RTL (db/008); nothing here touches lt_*.
-- ============================================================================

WITH bad AS (
  SELECT id, next_follow_up AS old_val
    FROM leads
   WHERE next_follow_up IS NOT NULL
     AND EXTRACT(YEAR FROM next_follow_up) NOT BETWEEN 1900 AND 2100
), repaired AS (
  UPDATE leads l
     SET next_follow_up = NULL
    FROM bad
   WHERE l.id = bad.id
  RETURNING l.id, bad.old_val
)
INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
SELECT 'system', NULL, 'lead_date_wipe_dont_guess', 'lead', id,
       jsonb_build_object(
         'column', 'next_follow_up', 'from', to_char(old_val, 'YYYY-MM-DD'),
         'why', 'a mid-type/2-digit-year artifact stored by the unvalidated save-per-keystroke follow-up box (db/595)')
  FROM repaired;

WITH bad AS (
  SELECT id, estimated_close AS old_val
    FROM leads
   WHERE estimated_close IS NOT NULL
     AND EXTRACT(YEAR FROM estimated_close) NOT BETWEEN 1900 AND 2100
), repaired AS (
  UPDATE leads l
     SET estimated_close = NULL
    FROM bad
   WHERE l.id = bad.id
  RETURNING l.id, bad.old_val
)
INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
SELECT 'system', NULL, 'lead_date_wipe_dont_guess', 'lead', id,
       jsonb_build_object(
         'column', 'estimated_close', 'from', to_char(old_val, 'YYYY-MM-DD'),
         'why', 'a mid-type/2-digit-year artifact stored by the unvalidated lead date PATCH (db/595)')
  FROM repaired;
