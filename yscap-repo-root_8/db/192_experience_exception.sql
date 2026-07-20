-- 192_experience_exception.sql
-- Senior-authority EXCEPTION for the experience gate (the derived experience dealbreaker has no
-- document_findings row, so it can't be waived through the normal finding-exception path). When a
-- heavy/ground-up file genuinely warrants closing despite the experience rule (a judgment call the
-- owner reserved to senior staff — "escalate for an experience exception"), an authorized user
-- records the exception here; assessExperience then stops emitting the blocking finding and the
-- gate opens. Idempotent.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS experience_exception_at   timestamptz;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS experience_exception_by   uuid REFERENCES staff_users(id);
ALTER TABLE applications ADD COLUMN IF NOT EXISTS experience_exception_note text;
