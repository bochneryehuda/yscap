-- ============================================================================
-- 343 — SUPER-ADMIN CONDITION OVERRIDE (owner-directed 2026-07-27).
--
-- "We need to add an admin override for each and every condition — if we're
--  unable to clear it, the admin should be able to overwrite and clear the
--  condition without a document attached to it, or without fulfilling the
--  requirement of that condition. Only super admin."
--
-- Every condition on a loan file is fulfillment-gated (staff.js signOffGate):
-- a required document condition needs a current document, the credit condition
-- needs an IMPORTED report, the vesting-entity condition needs a VERIFIED LLC,
-- the budget condition needs the Scope of Work to agree to the cent, and so on.
-- Those gates are correct and they stay exactly as they are — 2026-07-20 made
-- them apply to EVERYONE with no role bypass, and that stays true for the
-- ordinary Sign off / Waive buttons.
--
-- What this adds is a SEPARATE, EXPLICIT action: a super admin (and nobody
-- else) may clear a condition the gate is refusing, by asking for an override
-- and typing a reason. It is never automatic — a super admin pressing plain
-- "Sign off" on an unfulfilled condition is still refused exactly as before.
-- The distinction matters: the accident the gate exists to prevent (signing off
-- the government-ID condition with nothing uploaded) is still impossible by
-- accident; only a deliberate, reasoned, recorded decision gets through.
--
-- So the override is stored, not just permitted: WHO overrode it, WHEN, WHY,
-- and — the part that makes it reviewable — WHAT THE GATE WOULD HAVE SAID
-- (override_blocked_reason). A year from now the file itself can answer "what
-- was missing when this was cleared?" without anyone reconstructing it.
--
-- Three additive pieces, no behavior change to any existing row:
--   (1) checklist_items  — the conditions list (document / condition / task).
--   (2) conditions       — the first-class condition objects (db/022).
--   (3) loan_exceptions  — a new record-only exception type so every override
--                          also lands in the policy-exception register, the way
--                          issuance_override already does (db/306). That is what
--                          puts it on the Exceptions screen, in the EX-n
--                          register export, and in the decision certificate's
--                          policy_exceptions block — for free, no new plumbing.
--
-- Idempotent (IF NOT EXISTS / DROP+re-ADD constraint); safe on every boot. No
-- backfill: a NULL override column reads as "never overridden", which is the
-- truth for every previous file.
-- ============================================================================

-- (1) The conditions list.
ALTER TABLE checklist_items
  ADD COLUMN IF NOT EXISTS override_by uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS override_at timestamptz,
  ADD COLUMN IF NOT EXISTS override_reason text,
  -- What the fulfillment gate refused with at the moment of the override — the
  -- evidence of what was actually missing. NULL means nothing was blocking.
  ADD COLUMN IF NOT EXISTS override_blocked_reason text;

-- (2) First-class conditions (db/022) — same three columns, same meaning.
ALTER TABLE conditions
  ADD COLUMN IF NOT EXISTS override_by uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS override_at timestamptz,
  ADD COLUMN IF NOT EXISTS override_reason text;

-- Reporting: "show me every condition cleared by override". Partial, so it costs
-- nothing on the overwhelming majority of rows that were never overridden.
CREATE INDEX IF NOT EXISTS idx_checklist_items_override
  ON checklist_items(override_at DESC) WHERE override_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conditions_override
  ON conditions(override_at DESC) WHERE override_at IS NOT NULL;

-- (3) The policy-exception register learns the new record-only type. Mirrors the
-- widening db/306 did — DROP + re-ADD is the house pattern, and migrate-boot
-- recognizes an earlier narrower re-add as benign (isSupersededConstraintFailure).
ALTER TABLE loan_exceptions DROP CONSTRAINT IF EXISTS loan_exceptions_exception_type_check;
ALTER TABLE loan_exceptions
  ADD CONSTRAINT loan_exceptions_exception_type_check CHECK (exception_type IN
    ('guaranty_waiver','esign_before_ctc','pricing_exception','issuance_override','condition_override'));

-- (3b) …AND RE-ASSERT THE STATUS CHECK, WHICH IS THE PART THAT BITES.
--
-- Every migration replays on every boot. Once one real `condition_override` row
-- exists, db/306's own re-add of the type CHECK (its list stops at
-- issuance_override) can no longer be satisfied, so THAT WHOLE FILE ROLLS BACK
-- on each boot from then on. migrate-boot correctly classifies the error as
-- benign — a later migration widens the same constraint — but "benign" is only
-- true for the constraint itself. The collateral damage is everything ELSE in
-- 306 that the rollback takes with it, and one of those things is the STATUS
-- check: db/270 (earlier in the same boot) re-adds it WITHOUT 'expired', 306
-- widens it back, and if 306 dies the narrow one is what survives. The next
-- expiry sweep then fails with a check violation on a perfectly ordinary
-- 'expired' write — a failure with no visible connection to this change.
-- (Everything else 306 does is additive DDL that a rollback cannot lose: on any
-- boot where 306 fails, a condition_override row exists, which means 306 already
-- succeeded on an earlier boot and its columns/indexes/trigger are in place.)
--
-- Caught in exactly that way: test-exception-register-db.js started failing on
-- loan_exceptions_status_check the first time the full suite ran after a
-- condition_override row existed.
--
-- So this file — which runs LAST and always succeeds — re-asserts 306's status
-- CHECK verbatim. It is both belt-and-suspenders for future boots and a repair
-- for any database already left narrow. The rule for the next person adding an
-- exception type: widening a CHECK an earlier migration re-adds means you also
-- own restoring whatever else that earlier file's rollback would undo.
ALTER TABLE loan_exceptions DROP CONSTRAINT IF EXISTS loan_exceptions_status_check;
ALTER TABLE loan_exceptions
  ADD CONSTRAINT loan_exceptions_status_check CHECK (status IN
    ('requested','approved','denied','withdrawn','cleared','expired'));
