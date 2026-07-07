-- 053_ezra_green_see_all_files.sql
-- Owner-directed: make Ezra Green a "semi-admin" — able to see every loan file
-- from all loan officers even when he is not assigned. This grants the
-- see_all_files capability as a per-user override on staff_users.permissions
-- (jsonb), without changing his role. Idempotent: re-running just re-sets the
-- flag true. Matched by name (case-insensitive) — if his staff record is named
-- differently the UPDATE is a harmless no-op and the flag can be set from the
-- Team screen instead.

UPDATE staff_users
   SET permissions = COALESCE(permissions, '{}'::jsonb) || '{"see_all_files": true}'::jsonb,
       updated_at = now()
 WHERE lower(btrim(full_name)) LIKE '%ezra%green%'
   AND is_active = true;
