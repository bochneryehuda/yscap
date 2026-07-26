-- ============================================================================
-- 316 — DEFAULT CLOSER = Malky Katz (owner-directed 2026-07-26).
--
-- "Closer on file" is applications.closer_id; the DEFAULT closer is whoever holds
-- the `closer` role (the submit-to-closing route auto-routes to the sole closer and
-- sets closer_id). Malky Katz is seeded (db/007) as role `processor`, title
-- "Closer & Funder Manager" — flip her to the `closer` role so files route to her
-- workflow. Later, adding a second closer + switching a file's closer_id routes it
-- to that closer's workflow instead (no code change). Idempotent; email-matched.
-- The `manage_closings` capability itself lives in src/lib/permissions.js (a role
-- default for closer + admin) — no DB row needed.
-- ============================================================================

UPDATE staff_users SET role='closer', updated_at=now()
 WHERE lower(email)='malky@yscapgroup.com' AND is_active=true AND role <> 'closer';

-- Default any file ALREADY in the closing workflow with no closer assigned to her,
-- so previous in-closing files land on her workflow too (previous AND future).
UPDATE applications a SET closer_id = s.id, updated_at=now()
  FROM staff_users s
 WHERE lower(s.email)='malky@yscapgroup.com' AND s.is_active=true AND s.role='closer'
   AND a.closer_id IS NULL
   AND a.deleted_at IS NULL
   AND EXISTS (SELECT 1 FROM closing_workflow cw WHERE cw.application_id = a.id);
