-- 418 — THE TRACK RECORD REVIEWS ITSELF, AND THE EXPERIENCE CONDITION WAITS FOR IT
--
-- Owner-directed 2026-08-02, in the owner's own words:
--   "if you find any errors within the track record — like a few [properties]
--    that sound like the same or anything like that — we should NOT send it to
--    the regular manual review queue. We should have findings ON the track
--    record of stuff that was not done correctly … and you should not be able
--    to clear and sign off on the experience condition till you clear those
--    findings. If you find our SUBJECT PROPERTY on the track record that should
--    be a finding to be cleared … give a few options over there what to do."
--
-- WHY ITS OWN TABLE, AND NOT THE SYNC REVIEW QUEUE. The sync queue answers
-- "PILOT and another system disagree about a field" — it is keyed on a ClickUp
-- task, it lives on an admin screen nobody opens while underwriting a file, and
-- resolving a row there has no bearing on whether a condition may be signed off.
-- A track-record problem is none of those things: it is about OUR OWN data, the
-- person who must judge it is the one working the file, and it MUST be able to
-- hold the experience condition. So it follows the appraisal_findings shape
-- (db/137) instead — the pattern this repo already uses for "a desk that finds
-- things a human then clears".
--
-- BORROWER-SCOPED, NOT FILE-SCOPED. A track record belongs to the PERSON and is
-- shared by every file they have. A duplicate line is wrong on all of them at
-- once, so the finding hangs off `borrower_id`. `application_id` is set only for
-- a finding that is genuinely about one deal — today that is exactly one code,
-- `subject_property_on_record` (this file's own property is sitting on the
-- borrower's list of completed deals), which is meaningless without the file.
--
-- NOTHING HERE DELETES ANYTHING. A finding is a note asking a human to look;
-- the actions it offers are carried out by the ordinary, audited code paths.

CREATE TABLE IF NOT EXISTS track_record_findings (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    borrower_id      uuid NOT NULL REFERENCES borrowers(id) ON DELETE CASCADE,
    -- Set ONLY for a finding that is about one deal (subject_property_on_record).
    application_id   uuid REFERENCES applications(id) ON DELETE CASCADE,
    code             text NOT NULL,          -- duplicate_line | subject_property_on_record
    severity         text NOT NULL DEFAULT 'warning',   -- warning | info
    title            text NOT NULL,
    detail           text,
    -- The line(s) the finding is about. ON DELETE CASCADE: once a line is gone
    -- the finding about it is meaningless, and leaving it would block the
    -- experience condition forever with nothing to click.
    track_record_id  uuid REFERENCES track_records(id) ON DELETE CASCADE,
    other_id         uuid REFERENCES track_records(id) ON DELETE CASCADE,
    -- A stable identity for "this exact problem about these exact lines", so a
    -- re-run updates the row instead of raising a second copy of it.
    dedupe_key       text NOT NULL,
    status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
    resolution       text,                   -- merged | removed_line | kept_both | not_our_property | dismissed
    resolution_note  text,
    resolved_by      uuid REFERENCES staff_users(id),
    resolved_at      timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now()
);

-- ONE row per problem. The partial-unique index is what makes the detector safe
-- to re-run on every file view: an open finding is refreshed, never duplicated.
CREATE UNIQUE INDEX IF NOT EXISTS uq_trk_finding_open
  ON track_record_findings(borrower_id, dedupe_key) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_trk_findings_borrower
  ON track_record_findings(borrower_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_trk_findings_app
  ON track_record_findings(application_id) WHERE status = 'open';

-- A DECIDED finding stays decided. The detector consults this before raising,
-- so dismissing "these two really are different properties" sticks forever
-- rather than coming back on the next file view — the same discipline
-- finding_decisions (db/333) established for the AI desks.
CREATE INDEX IF NOT EXISTS idx_trk_findings_decided
  ON track_record_findings(borrower_id, dedupe_key, status)
  WHERE status IN ('resolved','dismissed');
