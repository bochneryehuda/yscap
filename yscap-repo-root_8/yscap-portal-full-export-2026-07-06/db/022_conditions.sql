-- 022_conditions.sql — first-class loan conditions, linkable to a real object
-- (a document, LLC, track-record row, appraisal, message, task). Replaces the
-- ad-hoc "condition as a checklist item" with a richer model that carries
-- severity, borrower-safe wording, and a clear/waive workflow. The old
-- checklist-item conditions keep working; new ones use this table. Idempotent.
CREATE TABLE IF NOT EXISTS conditions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id    uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  title             text NOT NULL,          -- internal
  borrower_title    text,                   -- borrower-facing (nullable => staff-only)
  detail            text,
  borrower_detail   text,
  audience          text NOT NULL DEFAULT 'staff' CHECK (audience IN ('staff','borrower','both')),
  severity          text NOT NULL DEFAULT 'standard'
                    CHECK (severity IN ('standard','prior_to_docs','prior_to_funding','post_closing')),
  status            text NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','borrower_responded','cleared','waived')),
  linked_entity_type text,                  -- document / llc / track_record / appraisal / message / task
  linked_entity_id  uuid,
  checklist_item_id uuid REFERENCES checklist_items(id) ON DELETE SET NULL,
  created_by        uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  cleared_by        uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  cleared_at        timestamptz,
  waive_reason      text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conditions_app ON conditions(application_id, status);
