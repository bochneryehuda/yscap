-- 079: Indexes for the system-wide audit log (#145).
-- The company-wide audit-log screen sorts the whole table by time and paginates
-- (ORDER BY created_at DESC, id DESC LIMIT/OFFSET); the filter facets GROUP BY
-- action. Without these, both seq-scan + full-sort the unbounded audit_log on
-- every page. Idempotent; safe to re-run on boot.
CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_log (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log (action);
