-- 348 — THE PURCHASING WORKFLOW (owner-directed 2026-07-26).
--
-- "Open up another workflow that the admin should be able to see, and for now the
--  closer should also see — every file that is moving to purchasing after investor
--  delivery. Once you click investor delivered it goes to the purchasing workflow
--  where you can see it's outstanding purchasing, add notes what you're still
--  missing, and add tasks. On the investor delivery there should be a TABLE FUNDING
--  button before you sign off investor delivery — if that's checked, it's sold right
--  away at closing and you don't need to put it into the purchasing workflow. And
--  once reconciled it should go off the closing workflow either way."
--
-- Model:
--   * table funding is a CLOSING flag, set BEFORE the investor-delivery sign-off.
--   * signing off investor delivery WITHOUT table funding enrolls the file in
--     purchasing ('outstanding'); WITH table funding it is sold at closing and
--     never enters purchasing.
--   * the closer's closing hand-off clears once the file is reconciled AND
--     investor-delivered — either way (that lives in code, not here).

-- ---------------------------------------------------------------------------
-- (1) Table funding — recorded on the closing row, next to the sign-offs.
-- ---------------------------------------------------------------------------
ALTER TABLE closing_workflow ADD COLUMN IF NOT EXISTS table_funded     boolean NOT NULL DEFAULT false;
ALTER TABLE closing_workflow ADD COLUMN IF NOT EXISTS table_funded_at  timestamptz;
ALTER TABLE closing_workflow ADD COLUMN IF NOT EXISTS table_funded_by  uuid REFERENCES staff_users(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- (2) purchasing_workflow — one row per file that entered purchasing.
--     A table-funded file never gets a row (sold at closing).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS purchasing_workflow (
  application_id uuid PRIMARY KEY REFERENCES applications(id) ON DELETE CASCADE,
  status         text NOT NULL DEFAULT 'outstanding' CHECK (status IN ('outstanding', 'complete')),
  entered_at     timestamptz NOT NULL DEFAULT now(),
  entered_by     uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  completed_at   timestamptz,
  completed_by   uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid REFERENCES staff_users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_purchasing_status ON purchasing_workflow(status, entered_at);

-- ---------------------------------------------------------------------------
-- (3) Per-file purchasing NOTES — "what you're still missing".
--     Same shape as closing_notes so the read/write code mirrors it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS purchasing_notes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  author_staff_id uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  body            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_purchasing_notes_app ON purchasing_notes(application_id, created_at);

-- ---------------------------------------------------------------------------
-- (4) Per-file purchasing TASKS — a flat, checkable to-do list per file.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS purchasing_tasks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  label          text NOT NULL,
  done           boolean NOT NULL DEFAULT false,
  done_by        uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  done_at        timestamptz,
  sort_order     integer NOT NULL DEFAULT 100,
  created_by     uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_purchasing_tasks_app ON purchasing_tasks(application_id, sort_order, created_at);

-- ---------------------------------------------------------------------------
-- (5) PREVIOUS files — a file already handed to purchasing (closing stage
--     'in_purchasing') belongs in the new purchasing workflow. Deterministic +
--     idempotent; a table-funded file is excluded (sold at closing).
-- ---------------------------------------------------------------------------
INSERT INTO purchasing_workflow (application_id, status, entered_at)
SELECT cw.application_id, 'outstanding', COALESCE(cw.purchasing_at, now())
  FROM closing_workflow cw
  JOIN applications a ON a.id = cw.application_id AND a.deleted_at IS NULL
 WHERE cw.stage = 'in_purchasing'
   AND COALESCE(cw.table_funded, false) = false
   AND NOT EXISTS (SELECT 1 FROM purchasing_workflow p WHERE p.application_id = cw.application_id);
