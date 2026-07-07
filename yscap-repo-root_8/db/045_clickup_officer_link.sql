-- ============================================================================
-- 045_clickup_officer_link.sql — inbound officer assignment + dedup hardening
--
--  * Populate staff_users.{clickup_user_id, pipeline_folder_id, crm_folder_id}
--    (columns existed since schema.sql but were never filled) by EMAIL — the
--    stable key. Lets ingest resolve a task's pipeline folder / Loan Officer
--    Email -> a staff_users.id, and lets the per-officer "sync my files" button
--    scope to that officer's ClickUp folder.
--  * UNIQUE index on applications(clickup_pipeline_task_id) — one portal file per
--    ClickUp task; closes the concurrent-ingest duplicate-file race.
--  * clickup_task_index.match_status/match_detail — records how each task was
--    linked (stamp/identity/created) or flags 'ambiguous' for a Manual Review queue.
-- Additive + idempotent.
-- ============================================================================

-- ---- staff_users: ClickUp linkage (matched by email) ----------------------
-- Loan officers
UPDATE staff_users SET clickup_user_id=81586262,  pipeline_folder_id=90116357907, crm_folder_id=90116357856 WHERE lower(email)='joshua@yscapgroup.com';
UPDATE staff_users SET clickup_user_id=81441384,  pipeline_folder_id=90115283054, crm_folder_id=90115283061 WHERE lower(email)='esther@yscapgroup.com';
UPDATE staff_users SET clickup_user_id=81441383,  pipeline_folder_id=90115017331, crm_folder_id=90115018413 WHERE lower(email)='solomon@yscapgroup.com';
UPDATE staff_users SET clickup_user_id=120151948, pipeline_folder_id=90115017377, crm_folder_id=90115018437 WHERE lower(email)='yehuda@yscapgroup.com';
UPDATE staff_users SET clickup_user_id=81466296,  pipeline_folder_id=90115279409, crm_folder_id=90115279344 WHERE lower(email)='yosef@yscapgroup.com';
UPDATE staff_users SET clickup_user_id=81537660,  pipeline_folder_id=90115913843, crm_folder_id=90115913766 WHERE lower(email)='moshe@yscapgroup.com';
UPDATE staff_users SET clickup_user_id=81561587,  pipeline_folder_id=90116152676, crm_folder_id=90116152663 WHERE lower(email)='shia@yscapgroup.com';
UPDATE staff_users SET clickup_user_id=87369209,  pipeline_folder_id=90117307844, crm_folder_id=90117576712 WHERE lower(email)='mendel@yscapgroup.com';
UPDATE staff_users SET clickup_user_id=87396408,  pipeline_folder_id=90117588937, crm_folder_id=90117589009 WHERE lower(email)='abraham@yscapgroup.com';
UPDATE staff_users SET clickup_user_id=87406875,  pipeline_folder_id=90117693051, crm_folder_id=90117693135 WHERE lower(email)='sol@yscapgroup.com';
UPDATE staff_users SET clickup_user_id=87406877,  pipeline_folder_id=90117693037, crm_folder_id=90117693155 WHERE lower(email)='josef@yscapgroup.com';
-- Isaac Zadmehr: portal email is isaac@ (ClickUp uses yitzchak@).
UPDATE staff_users SET clickup_user_id=87406874,  pipeline_folder_id=90117692994, crm_folder_id=90117693166 WHERE lower(email)='isaac@yscapgroup.com';
UPDATE staff_users SET clickup_user_id=87441231,  pipeline_folder_id=90118028635, crm_folder_id=90118110162 WHERE lower(email)='pinchus@yscapgroup.com';
UPDATE staff_users SET clickup_user_id=87450032,  pipeline_folder_id=90118081048, crm_folder_id=90118110163 WHERE lower(email)='yisroel@yscapgroup.com';
UPDATE staff_users SET clickup_user_id=87451319,  pipeline_folder_id=90118094956, crm_folder_id=90118110164 WHERE lower(email)='simcha@yscapgroup.com';
-- Loan officers with a pipeline folder but no ClickUp member (folder-only assign)
UPDATE staff_users SET pipeline_folder_id=90118110153 WHERE lower(email)='chaim@yscapgroup.com';
UPDATE staff_users SET pipeline_folder_id=90118110154 WHERE lower(email)='mendelb@yscapgroup.com';
-- Processors (pipeline only)
UPDATE staff_users SET clickup_user_id=87335667,  pipeline_folder_id=90117376201 WHERE lower(email)='malky@yscapgroup.com';
UPDATE staff_users SET clickup_user_id=87380437,  pipeline_folder_id=90117430703 WHERE lower(email)='goldy@yscapgroup.com';
UPDATE staff_users SET clickup_user_id=87431116,  pipeline_folder_id=90117952996 WHERE lower(email)='lisa@yscapgroup.com';
UPDATE staff_users SET pipeline_folder_id=90118065743 WHERE lower(email)='yonah@yscapgroup.com';
UPDATE staff_users SET pipeline_folder_id=90117447287 WHERE lower(email)='ezra@yscapgroup.com';

CREATE INDEX IF NOT EXISTS idx_staff_users_clickup_user  ON staff_users(clickup_user_id)    WHERE clickup_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_staff_users_pipeline_folder ON staff_users(pipeline_folder_id) WHERE pipeline_folder_id IS NOT NULL;

-- ---- one portal file per ClickUp task (dedup) -----------------------------
-- Defensive: if the pre-fix ingest ever double-linked a task, unlink the newer
-- copies (keep the oldest as canonical) so the unique index can be created and
-- boot never fails. Unlinked copies re-link cleanly on the next sync.
WITH d AS (
  SELECT id, row_number() OVER (PARTITION BY clickup_pipeline_task_id ORDER BY created_at, id) AS rn
    FROM applications WHERE clickup_pipeline_task_id IS NOT NULL
)
UPDATE applications a SET clickup_pipeline_task_id = NULL, sync_state = 'unlinked'
  FROM d WHERE d.id = a.id AND d.rn > 1;

-- NULLs are allowed & distinct in Postgres, so unlinked files are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS uq_applications_clickup_task
  ON applications(clickup_pipeline_task_id) WHERE clickup_pipeline_task_id IS NOT NULL;

-- ---- inbound match bookkeeping / Manual Review queue ----------------------
ALTER TABLE clickup_task_index ADD COLUMN IF NOT EXISTS match_status text;   -- linked_task | linked_stamp | linked_identity | created | ambiguous | data_only | skipped
ALTER TABLE clickup_task_index ADD COLUMN IF NOT EXISTS match_detail jsonb;  -- {stamp, candidates:[appId...], fields:[...]}
CREATE INDEX IF NOT EXISTS idx_clickup_task_index_match ON clickup_task_index(match_status) WHERE match_status IS NOT NULL;
