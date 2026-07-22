-- 260 — Seed the Mortgage Knowledge Graph with the DOCUMENTED, stable frozen
--       baselines for the Standard + Gold programs (R5.36, owner-directed
--       2026-07-22).
--
-- HARD RULE (owner, 2026-07-21): never change the pricing/guideline LOGIC or
-- NUMBERS. This seed does NOT change anything — it DESCRIBES the frozen rules as
-- knowledge-graph data so the AI can reason about + cite them. Every value here
-- is a documented, stable frozen baseline (from CLAUDE.md's frozen-baseline
-- notes and the frozen engines standard-program.js / gold-standard.js), NOT a
-- new number.
--
-- The VOLATILE per-geography leverage MATRIX (max LTV/LTC/ARV/loan by band ×
-- strategy × tier) is deliberately NOT duplicated here — the frozen engine stays
-- the single computational source of truth for it. Instead a single rule per
-- program RECORDS that those caps exist and are engine-computed (so the
-- knowledge graph knows to consult the engine, and can never drift from it).
--
-- Idempotent: stable seed UUIDs + ON CONFLICT, so re-running on every boot is a
-- no-op. Program docs are investor_id NULL (a base YS program, not a note buyer).

-- Base program guideline documents (fixed UUIDs for idempotency).
INSERT INTO guideline_documents (id, investor_id, program, title, published_at, meta)
VALUES
  ('00000000-0000-4000-8000-000000000001', NULL, 'standard', 'YS Capital — Standard Program (frozen baseline)', '2026-07-21', '{"seed":"r5.36","source":"standard-program.js + CLAUDE.md frozen baselines"}'::jsonb),
  ('00000000-0000-4000-8000-000000000002', NULL, 'gold',     'YS Capital — Gold Standard Program (frozen baseline)', '2026-07-21', '{"seed":"r5.36","source":"gold-standard.js + CLAUDE.md frozen baselines"}'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- One active version per program.
INSERT INTO guideline_versions (id, guideline_document_id, version, effective_from, approval_status, notes)
VALUES
  ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-000000000001', 'frozen-2026.07', '2026-07-21', 'active', 'Snapshot of the frozen Standard baseline as of the 2026-07-21 re-freeze.'),
  ('00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-000000000002', 'frozen-2026.07', '2026-07-21', 'active', 'Snapshot of the frozen Gold Standard baseline as of the 2026-07-21 re-freeze.')
ON CONFLICT (guideline_document_id, version) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Rules. `expression` gates applicability; `outcome` records the frozen fact.
-- materiality: hard_stop = ineligible; material = must be met / manual review.
-- ---------------------------------------------------------------------------

-- Standard program rules.
INSERT INTO guideline_rules (guideline_version_id, rule_key, scope, expression, outcome, materiality, exception_allowed, meta)
VALUES
  -- Absolute FICO floor 600 (engine: fico < 600 → INELIGIBLE).
  ('00000000-0000-4000-8000-0000000000a1', 'fico_floor', '{}'::jsonb,
   '{"field":"fico","cmp":">=","value":600}'::jsonb,
   '{"min_fico":600,"below":"ineligible"}'::jsonb, 'hard_stop', false,
   '{"source":"standard-program.js L485"}'::jsonb),
  -- Bank statements: Standard requires 1 month (CLAUDE.md liquidity note).
  ('00000000-0000-4000-8000-0000000000a1', 'statement_months', '{}'::jsonb,
   '{}'::jsonb, '{"statement_months":1}'::jsonb, 'material', false,
   '{"source":"CLAUDE.md liquidity baseline; src/lib/liquidity.js"}'::jsonb),
  -- Leverage caps exist and are engine-computed (NOT duplicated here).
  ('00000000-0000-4000-8000-0000000000a1', 'leverage_caps', '{}'::jsonb,
   '{}'::jsonb,
   '{"source":"frozen_engine","reference":"standard-program.js MATRIX","caps":["maxLoan","maxAcqLTV","maxARLTV","maxLTC"],"note":"per geography-band x strategy x tier; engine is the computational authority"}'::jsonb,
   'material', false, '{"do_not_duplicate":true}'::jsonb),
  -- Assignment financeable fee capped at 15% of the seller's ORIGINAL price.
  ('00000000-0000-4000-8000-0000000000a1', 'assignment_fee_cap', '{"is_assignment":true}'::jsonb,
   '{}'::jsonb,
   '{"financeable_fee_pct_of_seller_price":0.15,"basis":"seller_original_contract_price"}'::jsonb,
   'material', true, '{"source":"CLAUDE.md assignment freeze 2026-07-17; standard-program.js maxFee=0.15*sellerPP"}'::jsonb)
ON CONFLICT (guideline_version_id, rule_key) DO NOTHING;

-- Gold Standard program rules.
INSERT INTO guideline_rules (guideline_version_id, rule_key, scope, expression, outcome, materiality, exception_allowed, meta)
VALUES
  ('00000000-0000-4000-8000-0000000000a2', 'statement_months', '{}'::jsonb,
   '{}'::jsonb, '{"statement_months":2}'::jsonb, 'material', false,
   '{"source":"CLAUDE.md liquidity baseline (Gold = 2 months)"}'::jsonb),
  -- Gold requires a >=5% SOW contingency on the construction subtotal.
  ('00000000-0000-4000-8000-0000000000a2', 'sow_contingency', '{}'::jsonb,
   '{"field":"sow_contingency_pct","cmp":">=","value":0.05}'::jsonb,
   '{"min_contingency_pct":0.05,"of":"construction_subtotal"}'::jsonb, 'material', false,
   '{"source":"CLAUDE.md Gold contingency 2026-07-12; also Blue Lake note buyer"}'::jsonb),
  -- Interest reserve: renovation finances NONE; ground-up up to 75% of term.
  ('00000000-0000-4000-8000-0000000000a2', 'interest_reserve', '{}'::jsonb,
   '{}'::jsonb,
   '{"renovation":"none","ground_up":"up_to_75pct_of_term","bridge":"none"}'::jsonb,
   'material', false, '{"source":"CLAUDE.md Gold interest-reserve freeze 2026-07-06; gold-standard.js"}'::jsonb),
  -- Assignment fee: lesser of $75,000 or 15% of the seller's original price.
  ('00000000-0000-4000-8000-0000000000a2', 'assignment_fee_cap', '{"is_assignment":true}'::jsonb,
   '{}'::jsonb,
   '{"financeable_fee":"lesser_of","dollar_ceiling":75000,"pct_of_seller_price":0.15,"basis":"seller_original_contract_price"}'::jsonb,
   'material', true, '{"source":"CLAUDE.md assignment freeze 2026-07-17 (Gold ceiling $75k)"}'::jsonb)
ON CONFLICT (guideline_version_id, rule_key) DO NOTHING;

-- Program-wide baselines that apply to BOTH programs (seed once against each).
INSERT INTO guideline_rules (guideline_version_id, rule_key, scope, expression, outcome, materiality, exception_allowed, meta)
VALUES
  ('00000000-0000-4000-8000-0000000000a1', 'track_record_window', '{}'::jsonb, '{}'::jsonb,
   '{"exit_window_months":36,"note":"only a completed exit within 3 years counts toward experience"}'::jsonb,
   'material', false, '{"source":"CLAUDE.md track-record freeze 2026-07-07"}'::jsonb),
  ('00000000-0000-4000-8000-0000000000a2', 'track_record_window', '{}'::jsonb, '{}'::jsonb,
   '{"exit_window_months":36,"note":"only a completed exit within 3 years counts toward experience"}'::jsonb,
   'material', false, '{"source":"CLAUDE.md track-record freeze 2026-07-07"}'::jsonb),
  ('00000000-0000-4000-8000-0000000000a1', 'min_interest', '{}'::jsonb, '{}'::jsonb,
   '{"min_interest_months":3,"note":"minimum earned interest — NOT a prepayment penalty"}'::jsonb,
   'info', false, '{"source":"CLAUDE.md 3-month minimum interest 2026-07-14"}'::jsonb),
  ('00000000-0000-4000-8000-0000000000a2', 'min_interest', '{}'::jsonb, '{}'::jsonb,
   '{"min_interest_months":3,"note":"minimum earned interest — NOT a prepayment penalty"}'::jsonb,
   'info', false, '{"source":"CLAUDE.md 3-month minimum interest 2026-07-14"}'::jsonb)
ON CONFLICT (guideline_version_id, rule_key) DO NOTHING;
