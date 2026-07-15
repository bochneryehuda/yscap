-- ============================================================================
-- 107_clickup_write_journal.sql — append-only journal of every ClickUp write
--
-- 2026-07-15 DOB incident: the sync pushed day-shifted dates into ClickUp and
-- the only outbound trail was an audit_log row with a FIELD COUNT — no field
-- ids, no before/after values, so damage assessment required forensics instead
-- of a query. This journal records EVERY outbound field write (create, scoped
-- push, full repush) with the value ClickUp held immediately before, plus
-- blocked writes (guardrail refusals). SSN/card values are masked by the app
-- layer before insert — cleartext PII never lands here.
--
-- Additive + idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS clickup_write_log (
  id             bigserial PRIMARY KEY,
  application_id uuid,
  task_id        text NOT NULL,
  field_id       text,              -- ClickUp custom field id (NULL for status writes)
  field_key      text,              -- logical key when no field id applies (e.g. 'status')
  old_value      jsonb,             -- ClickUp's value immediately before the write (NULL = unknown/new task)
  new_value      jsonb,             -- the value we wrote (or tried to)
  changed        boolean NOT NULL DEFAULT true,   -- false = guardrail refused the write
  blocked        boolean NOT NULL DEFAULT false,  -- true  = write refused by a guardrail
  source         text,              -- 'create' | 'scoped_push' | 'full_repush'
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_clickup_write_log_task ON clickup_write_log(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_clickup_write_log_app  ON clickup_write_log(application_id, created_at);
CREATE INDEX IF NOT EXISTS idx_clickup_write_log_blocked ON clickup_write_log(created_at) WHERE blocked;
