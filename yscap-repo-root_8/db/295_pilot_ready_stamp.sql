-- PILOT ADVISORY overlay on Condition Center conditions (owner-directed 2026-07-24).
-- PILOT must NEVER sign off / clear a real Condition Center condition itself — a human
-- always clears it. Instead PILOT lays an ADVISORY on top of the human layer, on EVERY
-- condition (open OR already signed off):
--   • pilot_advice      — PILOT's verdict for this condition:
--        'ready'      → open, PILOT verified it is met and it is ready to clear
--        'not_ready'  → open, PILOT still needs something before it can be cleared
--        'agree'      → signed off, PILOT confirms it was cleared correctly
--        'dispute'    → signed off, but PILOT found evidence it should NOT be — revisit
--        NULL         → PILOT has no advisory for this condition (can't judge it yet)
--   • pilot_advice_note — a short plain-language reason (what PILOT saw / why)
--   • pilot_advice_at   — when PILOT last set the advisory
-- The condition's own status / signed_off_* are NEVER touched by the advisory — the human
-- still clears (or un-clears) it. (PILOT's OWN findings — AI / document-review / investor-
-- guideline findings — are a different thing and MAY be auto-resolved by PILOT with a note;
-- that lives in the document_findings / ai_suggestions layer, not here.)
--
-- Idempotent, additive columns only. Applies to previous AND future files (the advisory is
-- computed live by the per-condition advisory engine; nothing to backfill).

ALTER TABLE checklist_items
  ADD COLUMN IF NOT EXISTS pilot_advice      text,
  ADD COLUMN IF NOT EXISTS pilot_advice_note text,
  ADD COLUMN IF NOT EXISTS pilot_advice_at   timestamptz;

-- A small partial index so "which conditions is PILOT advising on / disputing?" is cheap.
CREATE INDEX IF NOT EXISTS idx_checklist_items_pilot_advice
  ON checklist_items(application_id, pilot_advice)
  WHERE pilot_advice IS NOT NULL;
