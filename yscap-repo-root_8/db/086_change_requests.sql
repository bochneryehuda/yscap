-- 086_change_requests.sql — borrower change-request "sandbox" (S5-03 / S2-05).
--
-- Once a product is registered, the deal's economics (ARV, rehab budget, purchase
-- price, program, loan/property type) are authoritative. A borrower may no longer
-- silently rewrite them on the live record — every proposed change becomes a
-- change_requests row that the loan officer + processor approve or reject. On
-- approval, staff apply the value in an audited write (which re-fires the existing
-- economics-reopen triggers). This gives the auditable "changed circumstance"
-- trail the audit flagged as missing.
--
-- Idempotent: guarded CREATE TABLE / indexes. No backfill needed — this only
-- governs NEW borrower edits on already-registered files going forward.
CREATE TABLE IF NOT EXISTS change_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id    uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  field             text NOT NULL,                 -- e.g. 'arv','rehab_budget','program'
  field_label       text NOT NULL,                 -- human label shown to both sides
  old_value         text,                          -- live value at request time (audit trail)
  new_value         text NOT NULL,                 -- proposed value
  reason            text,                           -- borrower's note (why)
  status            text NOT NULL DEFAULT 'pending' -- pending | approved | rejected | superseded
                    CHECK (status IN ('pending','approved','rejected','superseded')),
  requested_by_kind text NOT NULL DEFAULT 'borrower',
  requested_by_id   uuid,                          -- borrower or staff acting on their behalf
  decided_by        uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  decided_at        timestamptz,
  decision_note     text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- One pending request per (file, field): opening a new one supersedes the old
-- (handled in code), and this partial index keeps the pending queue clean/fast.
CREATE INDEX IF NOT EXISTS idx_change_requests_app     ON change_requests(application_id);
CREATE INDEX IF NOT EXISTS idx_change_requests_pending ON change_requests(application_id, field) WHERE status='pending';
