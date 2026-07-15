-- 106_waived_conditions.sql
-- #106: an internal condition can be OPTIONAL, and an optional condition can be
-- WAIVED (the "clear" action, renamed) — marked complete because it does not
-- apply, distinct from a normal sign-off where the document/data was actually
-- provided. The checklist_items V2 model already carries is_required (optional
-- flag) and completes via status='satisfied' + signed_off_at; we add a waive
-- marker so the UI can show "Waived by X" vs "Signed off by X" and so a waive is
-- auditable. A waive still counts as done for every gate (it stamps signed_off_at
-- + status='satisfied' like a sign-off) — the columns here only record that the
-- completion was a WAIVE. Idempotent; safe to re-run every boot.
ALTER TABLE checklist_items
  ADD COLUMN IF NOT EXISTS waived_at timestamptz,
  ADD COLUMN IF NOT EXISTS waived_by uuid REFERENCES staff_users(id) ON DELETE SET NULL;
