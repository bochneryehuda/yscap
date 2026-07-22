-- 232 — Document authenticity signals on `documents` (Sovereign, blueprint).
--
-- Owner-directed 2026-07-22: PILOT now scores every document read for
-- signs of TAMPERING (fake bank statement, doctored appraisal, resaved-and-
-- edited PDF). A low authenticity score raises a fatal underwriting finding
-- so a reviewer looks BEFORE trusting the extracted values.
--
-- Pure heuristics from the raw PDF bytes — no external forensics API. When
-- Regula or Ondato is signed up (see docs/UNDERWRITING-API-LANDSCAPE.md
-- Tier 2 §7), the same columns are populated by a much stronger analyzer.
--
-- Idempotent (safe to re-run every boot).

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS authenticity_score      numeric,
  ADD COLUMN IF NOT EXISTS authenticity_level      text,      -- 'high' | 'medium' | 'low' | 'unreadable'
  ADD COLUMN IF NOT EXISTS authenticity_signals    jsonb,     -- [{name, present, weight, note}]
  ADD COLUMN IF NOT EXISTS authenticity_checked_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_doc_low_authenticity
  ON documents (authenticity_level)
  WHERE authenticity_level = 'low';
