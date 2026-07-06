-- 023_post_closing.sql — post-closing trailing-doc tracking, separate from
-- borrower intake. Seeded when a file funds. Idempotent.
CREATE TABLE IF NOT EXISTS post_closing_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id    uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  code              text NOT NULL,
  label             text NOT NULL,
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','ordered','received','accepted','exception')),
  document_id       uuid REFERENCES documents(id) ON DELETE SET NULL,
  due_date          date,
  exception_note    text,
  assigned_staff_id uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (application_id, code)
);
CREATE INDEX IF NOT EXISTS idx_post_closing_app ON post_closing_items(application_id, status);
