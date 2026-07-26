-- 317 — pull_credit capability backfill (owner-directed 2026-07-23).
--
-- Credit import moved from the broad `sign_off_conditions` capability to a
-- dedicated `pull_credit` capability so a LOAN OFFICER can pull credit without
-- gaining the processor's sign-off power. `pull_credit` is granted by ROLE DEFAULT
-- (lib/permissions.js) to loan_officer / processor / underwriter / loan_coordinator
-- / closer / admin (super_admin implicitly), so every standard staffer keeps (or,
-- for loan officers, gains) the ability with NO data change — effectivePermissions
-- merges role defaults at request time.
--
-- The ONLY population this migration touches is a NON-STANDARD user who was
-- manually granted `sign_off_conditions` via a per-user override on a role whose
-- default doesn't include it (e.g. an admin gave a draw_coordinator sign-off). Such
-- a user could import credit BEFORE this change (the old gate was sign_off_conditions)
-- and must keep that ability AFTER — so we copy an explicit pull_credit:true onto
-- them. Idempotent (|| is an upsert on the jsonb key); safe to re-run every boot.
-- The guard is KEY-ABSENCE (NOT ? 'pull_credit'), not value != true: once the key
-- exists we never touch it, so an admin's explicit pull_credit:false REVOKE sticks
-- across reboots (this only ever FILLS an unset key, never overrides a decision).
UPDATE staff_users
   SET permissions = COALESCE(permissions, '{}'::jsonb) || '{"pull_credit": true}'::jsonb
 WHERE (permissions ->> 'sign_off_conditions') = 'true'
   AND NOT (permissions ? 'pull_credit');
