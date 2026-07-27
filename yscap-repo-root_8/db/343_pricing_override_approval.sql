-- ============================================================================
-- 343 — Pricing-override approval (owner-directed 2026-07-27, evening).
--
-- The owner: "every single time somebody is changing the defaults and he's
-- overriding something in the admin section this should be sent to the admin
-- for approval, no matter if it's reducing the rate, reducing the fee, or
-- manual programs."
--
-- Before this, only a MANUAL result (below the program minimum / over the
-- maximum / a guideline exception) or a MANUAL PROGRAM (a structural LTV / LTC /
-- ARV override, db/207) went to the Escalations box. Manual PRICING — a reduced
-- rate markup, reduced origination points, a discounted or waived closing fee,
-- an approved effective purchase price — registered silently and confirmed terms
-- to the borrower with nobody senior ever seeing it.
--
-- `needs_approval` is the registration's own resolved answer to "may these terms
-- be confirmed?", so every consumer (the borrower terms email, the DocuSign
-- issuance gate in src/lib/esign/gate.js, the file screens) reads ONE flag
-- instead of re-deriving the policy. `override_changes` is the plain-language
-- record of WHAT was moved off the company default, so the approver — and the
-- permanent loan file — can see exactly what was blessed.
--
-- Idempotent — safe to re-run on every boot.
-- ============================================================================

ALTER TABLE product_registrations
  ADD COLUMN IF NOT EXISTS needs_approval   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS override_changes jsonb;

COMMENT ON COLUMN product_registrations.needs_approval IS
  'True when these terms may NOT be confirmed (borrower terms email + DocuSign term sheet) until an admin approves the escalation: a Manual Program, an engine MANUAL result, or any admin-zone pricing override off the company default (db/343).';
COMMENT ON COLUMN product_registrations.override_changes IS
  'The admin-zone knobs moved off the company default on this registration: [{key,label,unit,value,defaultValue}] (db/343).';

-- ----------------------------------------------------------------------------
-- Back-date: every EXISTING registration that already needed sign-off under the
-- old rule keeps that meaning, so the issuance gate reads identically for
-- previous files (it used to derive this from is_manual / status). Nothing is
-- newly BLOCKED by the back-date: a pricing-only override on an old file is
-- deliberately NOT flagged retroactively — those terms were already issued under
-- the rule of the day, and re-flagging them would freeze live files that nobody
-- can act on. The new rule is go-forward, on the next registration.
-- ----------------------------------------------------------------------------
UPDATE product_registrations
   SET needs_approval = true
 WHERE needs_approval = false
   AND (is_manual = true OR status = 'MANUAL');
