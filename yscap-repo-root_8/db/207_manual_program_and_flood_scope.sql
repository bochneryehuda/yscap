-- ============================================================================
-- 207 — Manual Program (custom LTV/LTC/ARV product) + program-scoped flood cert
--       (owner-directed 2026-07-20).
--
-- Two linked owner requests:
--
-- (A) FLOOD CERTIFICATE is only REQUIRED for the Gold and the (new) Manual
--     program — NOT the Standard program — UNLESS a flood zone is known from the
--     appraisal / appraisal XML findings (a Special Flood Hazard Area), in which
--     case it is ALWAYS required regardless of program. Previously db/177 put the
--     flood cert INTERNAL condition on EVERY RTL file unconditionally.
--     This converts the rtl_cond_flood template to a RULE-DRIVEN Condition Center
--     template (auto_apply='rules') gated on:
--         registered_program IN (gold, manual)  OR  in_flood_zone = true
--     and REMOVES the untouched flood items db/177 added to files that are neither
--     Gold/Manual nor in a flood zone (so a plain Standard file no longer carries
--     it). The engine (src/lib/conditions/engine.js) attaches/retracts it going
--     forward; the new registry fields `registered_program=manual` and
--     `in_flood_zone` back the rule (src/lib/conditions/field-registry.js +
--     engine.loadRuleContext).
--
-- (B) MANUAL PROGRAM — a manual override of the deal STRUCTURE (LTV / LTC / ARV)
--     is no longer registered under the Standard or Gold program. It becomes its
--     own "Manual Program", priced on the Standard (Fidelis) guideline engine but
--     carrying the manual leverage, requiring a super-admin ESCALATION approval,
--     and requiring the registrant to state how many months of liquidity/assets
--     the file must show. (Manual PRICING — markup / points / fees only — is NOT
--     a manual product and still registers under Standard/Gold.)
--       · manual_program_settings — the company-level Manual Program config
--         (default LTV/LTC/ARV ceilings + the REQUIRED default asset/liquidity
--         months), append-only history mirroring company_pricing_settings.
--       · manual_program_escalations — one row per manual registration; a
--         super-admin approves/declines it. The file registers immediately but the
--         product stays "pending super-admin approval" until decided.
--       · product_registrations gains is_manual + asset_months.
--
-- Idempotent — safe to re-run on every boot.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- (B1) product_registrations — mark manual registrations + carry the required
--      liquidity months the registrant stated on the registration screen.
-- ----------------------------------------------------------------------------
ALTER TABLE product_registrations ADD COLUMN IF NOT EXISTS is_manual    boolean NOT NULL DEFAULT false;
ALTER TABLE product_registrations ADD COLUMN IF NOT EXISTS asset_months integer;

-- ----------------------------------------------------------------------------
-- (B2) manual_program_settings — the admin-managed Manual Program config.
--      Singleton current row (is_current), append-only history + rollback, same
--      shape/convention as company_pricing_settings. asset_months is REQUIRED
--      (NOT NULL) — an admin must state the default liquidity months before the
--      Manual Program can be used. Leverage ceilings are advisory guardrails the
--      admin sets (0 = "no ceiling").
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS manual_program_settings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  max_acq_ltv    numeric(6,3),                 -- ceiling for acquisition LTV %  (null/0 = none)
  max_arv_ltv    numeric(6,3),                 -- ceiling for after-repair LTV %
  max_ltc        numeric(6,3),                 -- ceiling for loan-to-cost %
  asset_months   integer NOT NULL DEFAULT 2,   -- REQUIRED default liquidity months for a manual product
  is_active      boolean NOT NULL DEFAULT true,
  note           text,
  is_current     boolean NOT NULL DEFAULT true,
  updated_by     uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_manual_program_settings_current
  ON manual_program_settings(is_current) WHERE is_current;

-- Seed one current row if none exists (default 2 months of liquidity, no leverage
-- ceilings — an admin fills these in the Manual Program admin screen).
INSERT INTO manual_program_settings (asset_months, is_active, note)
SELECT 2, true, 'Default manual-program config (seeded)'
 WHERE NOT EXISTS (SELECT 1 FROM manual_program_settings WHERE is_current);

-- ----------------------------------------------------------------------------
-- (B3) manual_program_escalations — the super-admin approval queue. One row per
--      manual product registration; the file registers immediately but the
--      product is "pending" until a super-admin approves/declines.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS manual_program_escalations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id     uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  registration_id    uuid REFERENCES product_registrations(id) ON DELETE CASCADE,
  status             text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','approved','declined')),
  asset_months       integer,                    -- liquidity months stated on the registration
  overrides          jsonb,                      -- the manual LTV/LTC/ARV overrides used
  summary            jsonb,                       -- snapshot (loan amount, rate, leverage) for the box
  requested_by       uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  decided_by         uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  decided_at         timestamptz,
  decision_note      text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_manual_esc_status ON manual_program_escalations(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_manual_esc_app    ON manual_program_escalations(application_id, created_at DESC);
-- At most one OPEN (pending) escalation per file — a re-register supersedes the
-- prior pending row (handled in code) so the box never shows stale duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS uq_manual_esc_pending_per_app
  ON manual_program_escalations(application_id) WHERE status = 'pending';

-- ----------------------------------------------------------------------------
-- (A1) Flood cert template → rule-driven, gated on Gold/Manual or a known flood
--      zone. Re-assert idempotently (never touches instances already on files).
--      NOTE: the engine ignores applies_loan_type, so the rule itself is the gate.
-- ----------------------------------------------------------------------------
UPDATE checklist_templates
   SET auto_apply = 'rules',
       rule_logic = '{"combinator":"or","rules":[{"field":"registered_program","operator":"in","value":["gold","manual"]},{"field":"in_flood_zone","operator":"is_true"}]}'::jsonb,
       is_active = true
 WHERE code = 'rtl_cond_flood';

-- (A1b) Adopt the legacy db/177 flood items into engine ownership: mark every
--       UNTOUCHED flood item origin_kind='auto' so the Condition Center engine
--       will RETRACT it cleanly the moment a file transitions out of scope (e.g.
--       Gold → Standard with no flood zone), without waiting for a reboot. A
--       touched item (upload / sign-off / review / notes / payload) is left as-is
--       for an underwriter to waive manually.
UPDATE checklist_items ci
   SET origin_kind = 'auto'
  FROM checklist_templates t
 WHERE ci.template_id = t.id
   AND t.code = 'rtl_cond_flood'
   AND (ci.origin_kind IS NULL OR ci.origin_kind <> 'auto')
   AND ci.status = 'outstanding'
   AND ci.signed_off_at IS NULL
   AND ci.reviewed_at IS NULL
   AND ci.tool_payload IS NULL
   AND (ci.notes IS NULL OR ci.notes = '')
   AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.checklist_item_id = ci.id);

-- ----------------------------------------------------------------------------
-- (A2) Remove the flood cert item from files where it should no longer live: not
--      Gold/Manual registered, not in a known flood zone — and ONLY when the item
--      is UNTOUCHED (no upload, no sign-off/review, no notes, no tool payload,
--      still outstanding). Anything a human/borrower touched is left for an
--      underwriter to waive manually (mirrors the engine's retract-only-if-clean
--      rule). Idempotent; the engine re-adds it if the file later goes Gold/Manual
--      or a flood zone is found.
-- ----------------------------------------------------------------------------
DELETE FROM checklist_items ci
 USING checklist_templates t
 WHERE ci.template_id = t.id
   AND t.code = 'rtl_cond_flood'
   AND ci.status = 'outstanding'
   AND ci.signed_off_at IS NULL
   AND ci.reviewed_at IS NULL
   AND ci.tool_payload IS NULL
   AND (ci.notes IS NULL OR ci.notes = '')
   AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.checklist_item_id = ci.id)
   -- not registered Gold/Manual right now
   AND NOT EXISTS (SELECT 1 FROM product_registrations pr
                    WHERE pr.application_id = ci.application_id
                      AND pr.is_current = true
                      AND pr.program IN ('gold','manual'))
   -- not in a known Special Flood Hazard Area per the current appraisal
   -- (FEMA SFHA flag, FEMA zone A*/V*, or the appraiser's stated zone A*/V*)
   AND NOT EXISTS (SELECT 1 FROM appraisals ap
                    WHERE ap.application_id = ci.application_id
                      AND ap.superseded = false
                      AND (ap.fema_flood_sfha = true
                           OR upper(coalesce(ap.fema_flood_zone,'')) ~ '^(A|V)'
                           OR upper(coalesce(ap.flood_zone,'')) ~ '^(A|V)'));
