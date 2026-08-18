-- ============================================================================
-- db/576 — the PLANS & PERMITS first-draw condition (owner-directed 2026-08-18).
--
-- The owner: "At the plans and permits condition, if it's a purchase, then you
-- should be able to click 'Waive this condition' for now. That condition should
-- populate as an enforcement before the first draw, saying that that condition
-- was not satisfied yet. … Even if they provide it at closing at a purchase,
-- that condition should populate again, pre-filled with that document that was
-- uploaded already, on the first draw. The draw coordinator needs to sign off
-- on it again, and it should be delivered as part of the investor delivery on
-- the first draw. The plans and permits only on a purchase should be delivered
-- after closing, and on a refinance, it's required before closing."
--
-- This file seeds ONE new template: `draw_cond_plans_permits` — the DRAW-phase
-- re-enforcement of the closing-time `rtl_p1_plans` condition, raised by
-- src/sitewire/plans-permits.js before a ground-up file's FIRST draw (never by
-- the rules engine: auto_apply='manual', the db/206 pattern, so generateChecklist
-- and the engine never dump it on unrelated files). The closing-time template is
-- deliberately untouched: db/178's trigger owns rtl_p1_plans' lifecycle, and
-- un-waiving it would destroy the audit fact that it WAS waived at purchase.
--
-- tpr_exclude=true ON PURPOSE: the document on this condition is a COPY of the
-- closing-time plans document (pre-filled so the coordinator signs off on it
-- again); the ORIGINAL on rtl_p1_plans already ships in the investor TPR
-- package, and shipping the copy too would double every plans document there.
-- The investor DRAW delivery attaches the plans directly (investor-delivery-send
-- section 7), which is the "included as part of the investor draw delivery" half.
--
-- BACKFILL: none, deliberately. The condition is raised per file at its first
-- draw by the live code (go-forward — a file already mid-draws has passed its
-- first draw, and inventing the enforcement there would block money mid-project).
-- ============================================================================

INSERT INTO checklist_templates
  (code, label, borrower_label, scope, audience, item_kind, role_scope, phase,
   sort_order, category, hint, borrower_hint, tpr_exclude, is_required, is_gate, auto_apply)
SELECT
  'draw_cond_plans_permits',
  'Plans & permits — confirmed before the first draw',
  'Plans & building permits for the construction work',
  'application', 'both', 'document', 'processor', '5',
  902, 'draw',
  'Before the FIRST construction draw is released, the approved plans and building permits must be on file and signed off by the draw coordinator — even when they were provided (or waived) at closing. Pre-filled with the plans document from closing when one exists; review it and sign off again. Delivered to the investor with the first draw.',
  'The approved plans and building permits for your construction work — needed before your first draw can be released. If you already sent them, they are attached here for a fresh review.',
  true, true, true, 'manual'
WHERE NOT EXISTS (SELECT 1 FROM checklist_templates WHERE code = 'draw_cond_plans_permits');
