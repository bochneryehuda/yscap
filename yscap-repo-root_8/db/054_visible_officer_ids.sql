-- 054_visible_officer_ids.sql
-- Per-staffer file-access sharing: in addition to "see every file" (see_all_files),
-- a staffer can be granted access to the files of SPECIFIC loan officers even when
-- they are not assigned. The chosen officers' ids live in staff_users.visible_officer_ids
-- (uuid[]). Empty array = no extra access (the default). The scope checks expand to:
--   assigned (loan_officer_id/processor_id = me) OR loan_officer_id = ANY(my visible list).

ALTER TABLE staff_users
  ADD COLUMN IF NOT EXISTS visible_officer_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];
