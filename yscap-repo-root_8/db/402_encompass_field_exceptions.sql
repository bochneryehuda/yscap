-- db/402 — Super-admin FIELD EXCEPTIONS on the Encompass reconcile (owner-directed 2026-08-02).
--
-- A not-matching / "no data to compare" Encompass field can be escalated: any assigned
-- staffer REQUESTS an exception, a SUPER ADMIN grants it, and the field then PASSES the
-- term-sheet gate ("it doesn't need to match"). The per-field state lives in
-- encompass_sync_resolutions (the table that already carries 'replaced'/'accepted'):
--   'exception_requested' — a staffer asked, awaiting the super admin (still blocks)
--   'excepted'            — a super admin granted it (passes the gate)
-- Both snapshot the LIVE normalized values, so the exception auto-voids the instant the
-- data changes (reconcile.applyFieldExceptions) — it can never hide a NEW disagreement.
--
-- Idempotent: additive columns + a DROP/re-ADD of the named resolution CHECK.

-- Who requested the exception (vs resolved_by = who granted it) + when.
ALTER TABLE encompass_sync_resolutions ADD COLUMN IF NOT EXISTS requested_by uuid REFERENCES staff_users(id) ON DELETE SET NULL;
ALTER TABLE encompass_sync_resolutions ADD COLUMN IF NOT EXISTS requested_at timestamptz;

-- Widen the resolution CHECK to allow the two exception states alongside the originals.
ALTER TABLE encompass_sync_resolutions DROP CONSTRAINT IF EXISTS encompass_sync_resolutions_resolution_chk;
ALTER TABLE encompass_sync_resolutions
  ADD CONSTRAINT encompass_sync_resolutions_resolution_chk
    CHECK (resolution IN ('replaced', 'accepted', 'exception_requested', 'excepted'));

-- ── loan_exceptions register: a record-only 'encompass_mismatch' type ────────
-- When a super admin GRANTS an Encompass field exception, the decide route also drops a
-- born-approved, RECORD-ONLY row into the policy-exception register (best-effort) so the
-- grant shows on the Exceptions screen, the EX-n export and the decision certificate —
-- mirroring condition_override / issuance_override. The gate itself does NOT read this
-- table (it reads encompass_sync_resolutions); this is purely the audit surface.
--
-- IDEMPOTENCY (per db/344 / db/388 / db/397): this file is numbered ABOVE every prior
-- widening, and it re-asserts BOTH the exception_type CHECK (the FULL list + the new
-- value) AND the status CHECK verbatim — because an older migration's narrower re-ADD
-- replays on every boot and would otherwise roll our new value back (and drop the status
-- re-assertion). The full list MUST include every type any lower-numbered file added —
-- notably 'tape_encompass_override' (db/397) — or that value would be dropped here.
ALTER TABLE loan_exceptions DROP CONSTRAINT IF EXISTS loan_exceptions_exception_type_check;
ALTER TABLE loan_exceptions
  ADD CONSTRAINT loan_exceptions_exception_type_check CHECK (exception_type IN
    ('guaranty_waiver','esign_before_ctc','pricing_exception','issuance_override',
     'condition_override','appraisal_xml_waiver','oop_rehab','tape_encompass_override',
     'encompass_mismatch'));

ALTER TABLE loan_exceptions DROP CONSTRAINT IF EXISTS loan_exceptions_status_check;
ALTER TABLE loan_exceptions
  ADD CONSTRAINT loan_exceptions_status_check CHECK (status IN
    ('requested','approved','denied','withdrawn','cleared','expired'));
