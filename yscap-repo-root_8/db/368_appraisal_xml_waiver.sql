-- ============================================================================
-- 368 — APPRAISAL "NO XML AVAILABLE" WAIVER (owner-directed 2026-07-29).
--
-- "In the appraisal condition you should be able to click a button that there is
--  no XML available. If you click it you need to type the ARV value and the As-Is
--  value by hand, and you can waive ONLY the XML upload — the PDF is still
--  required. When you waive, a few reasons come up. A TRANSFERRED APPRAISAL waives
--  automatically and just asks for a PDF transfer letter in that same slot (no
--  exception). Any other reason needs a note and goes for an exception. Either way
--  the values are entered by hand first, because we usually read them off the XML."
--
-- The appraisal-documents condition (rtl_cond_appraisaldocs) has two slots — XML
-- and PDF — and its sign-off gate requires BOTH plus a successful MISMO import.
-- Sometimes there is no XML (a transferred appraisal, a desk/manual appraisal, an
-- appraiser who won't send the data file). This records the waiver so the gate can
-- accept the file on the PDF alone, once the ARV + As-Is are typed in by hand.
--
-- One waiver per file (the condition is one-per-file), so application_id is the PK.
-- Additive + idempotent; no backfill (no waiver = the normal both-slots rule, which
-- is the truth for every previous file).
-- ============================================================================

CREATE TABLE IF NOT EXISTS appraisal_xml_waivers (
  application_id           uuid PRIMARY KEY REFERENCES applications(id) ON DELETE CASCADE,
  -- 'transferred_appraisal' auto-waives + needs a transfer-letter PDF (no exception);
  -- every other reason needs a note and routes to the exception register.
  reason                   text NOT NULL,
  note                     text,
  -- The ARV + As-Is the reviewer typed in (usually read off the XML). Mirrored onto
  -- applications.arv / .as_is_value so pricing + the rest of the file see them.
  arv                      numeric,
  as_is_value              numeric,
  -- A transferred appraisal must have a transfer letter in the PDF slot.
  requires_transfer_letter boolean NOT NULL DEFAULT false,
  -- When a non-transfer reason opened a policy exception, its id lives here so the
  -- gate can require the exception be APPROVED before the condition clears.
  exception_id             uuid REFERENCES loan_exceptions(id) ON DELETE SET NULL,
  waived_by                uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  waived_at                timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- The policy-exception register learns the new type. DROP + re-ADD is the house
-- pattern (mirrors db/306 / db/344). This file runs LAST, so it also RE-ASSERTS the
-- full type list AND the status CHECK verbatim — an earlier file (306 / 344) that
-- re-adds a NARROWER type CHECK will roll back once an appraisal_xml_waiver row
-- exists, taking its status-CHECK re-assertion with it, and this restores both.
-- (See db/344's own note for why the status CHECK is the part that bites.)
ALTER TABLE loan_exceptions DROP CONSTRAINT IF EXISTS loan_exceptions_exception_type_check;
ALTER TABLE loan_exceptions
  ADD CONSTRAINT loan_exceptions_exception_type_check CHECK (exception_type IN
    ('guaranty_waiver','esign_before_ctc','pricing_exception','issuance_override',
     'condition_override','appraisal_xml_waiver'));

ALTER TABLE loan_exceptions DROP CONSTRAINT IF EXISTS loan_exceptions_status_check;
ALTER TABLE loan_exceptions
  ADD CONSTRAINT loan_exceptions_status_check CHECK (status IN
    ('requested','approved','denied','withdrawn','cleared','expired'));
