-- ============================================================================
-- 333 — A HUMAN'S DECISION ON AN AI FINDING IS DURABLE (owner-reported 2026-07-27).
--
-- THE BUG. "I click Dismiss on a finding, or I escalate it to review and the
-- super-admin says it's OK / grants an exception — and the finding keeps popping
-- up again. It never actually disappears."
--
-- THE ROOT CAUSE (one class, three doors). Every decision was recorded ON THE ROW
-- that carried the finding, and every producer re-creates that row from scratch on
-- the next pass:
--   1. `ai_suggestions.record()` deduped ONLY against `status='open'`. A dismissed
--      row is not open, so the very next sync (which runs every time a staffer
--      opens the file) inserted a BRAND-NEW open row for the same finding.
--   2. `document_findings` are re-inserted by every document (re-)analysis, with no
--      memory of a resolution a human already recorded on the previous row.
--   3. The DERIVED desks (tie-out, entity/seller chain, chain of title, bank
--      liquidity, experience, reasonability, note-buyer guidelines) have no stored
--      row at all — they are pure functions of the file, recomputed on every view,
--      so there was nothing a Dismiss could even attach to.
-- Fixing any one door leaves the other two armed, which is why this is a table and
-- not a patch: the decision now lives on the FINDING'S IDENTITY, independent of
-- whichever row happens to be carrying it today.
--
-- THE KEY. `finding_key` is the stable claim key from
-- src/lib/underwriting/finding-claims.js (`claimOf`) — the same identity the desk
-- already uses to collapse the six desks that notice one fact into one card. So a
-- dismissal recorded from the desk, from the "Findings to review" queue, or from a
-- super-admin's exception all land on the same key, and every producer + reader
-- honours it.
--
-- NOT A MUTE. `ai_silenced_codes` (db/253) is portfolio-wide and super-admin-only.
-- This is per-FILE and per-FINDING: the same code on the next loan is untouched.
-- `superseded_at` un-suppresses (a re-open), keeping the row for the audit trail.
--
-- Idempotent — safe to re-run on every boot. Go-forward by nature (an already-
-- dismissed finding gets its ledger row the next time it is decided); a backfill
-- for the rows that were already decided is at the bottom.
-- ============================================================================

CREATE TABLE IF NOT EXISTS finding_decisions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id   uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  -- The finding's stable identity (finding-claims.claimOf). NOT the row id: the
  -- row is re-created, the identity is not.
  finding_key      text NOT NULL,
  code             text,
  -- Where the decision was taken, for the audit trail only — never for matching.
  --   document_finding | appraisal_finding | ai_suggestion | escalation | derived
  origin           text,
  -- What the human decided: dismissed | exception_granted | cleared | fixed |
  -- declined | resolved. Only the SUPPRESSING ones set suppressed=true.
  decision         text NOT NULL,
  -- Does this decision stop the finding coming back? A dismissal / exception /
  -- clear does; "post a condition" or "request a document" does NOT (the finding
  -- deliberately stays live until the follow-up lands).
  suppressed       boolean NOT NULL DEFAULT true,
  note             text,
  decided_by       uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  decided_at       timestamptz NOT NULL DEFAULT now(),
  -- A re-open: the decision stays on the record but stops suppressing.
  superseded_at    timestamptz,
  superseded_by    uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- ONE live decision per (file, finding). A second decision on the same finding
-- REPLACES the first (the later decision is the current truth) — the app layer
-- upserts on this index.
CREATE UNIQUE INDEX IF NOT EXISTS finding_decisions_file_key_uk
  ON finding_decisions (application_id, finding_key);

-- The hot read: "which findings has a human already dealt with on this file?"
CREATE INDEX IF NOT EXISTS finding_decisions_live_idx
  ON finding_decisions (application_id) WHERE suppressed = true AND superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS finding_decisions_code_idx
  ON finding_decisions (code, decided_at DESC);

-- ---------------------------------------------------------------------------
-- BACKFILL — previous AND future (the standing rule in CLAUDE.md).
--
-- Every finding a human ALREADY dismissed / cleared / granted an exception on,
-- before this ledger existed, gets its decision recorded now — otherwise the fix
-- would only help findings decided from today forward, and the owner's live files
-- would keep re-raising everything that was already dealt with.
--
-- The key format MUST match finding-claims.claimOf's non-family branch exactly:
--   code:<code>::<field>::<document_id|extraction_id|''>::<doc_value|''>
-- all lower-cased and trimmed. Findings in a CLAIM FAMILY (the handful of codes
-- that several desks raise for one fact) key on `claim:<family>` instead; those
-- are deliberately NOT backfilled here — the family list lives in JS, it changes,
-- and a wrong key would suppress the wrong finding. They re-record on their next
-- decision, which is the safe direction to be wrong in.
-- ---------------------------------------------------------------------------
INSERT INTO finding_decisions (application_id, finding_key, code, origin, decision, suppressed, note, decided_by, decided_at)
SELECT DISTINCT ON (f.application_id, key)
       f.application_id,
       key,
       f.code,
       'document_finding',
       CASE WHEN f.status = 'dismissed' THEN 'dismissed' ELSE COALESCE(f.resolution, 'resolved') END,
       true,
       left(COALESCE(f.resolution_note, ''), 1000),
       f.resolved_by,
       COALESCE(f.resolved_at, now())
  FROM (
    SELECT df.*,
           'code:' || lower(btrim(COALESCE(df.code, '')))
             || '::' || lower(btrim(COALESCE(df.field, '')))
             || '::' || lower(btrim(COALESCE(df.document_id::text, df.extraction_id::text, '')))
             || '::' || lower(btrim(COALESCE(df.doc_value, ''))) AS key
      FROM document_findings df
     WHERE df.application_id IS NOT NULL
       AND df.status IN ('dismissed', 'resolved')
       -- Only the resolutions that MEAN "this is settled". post_condition /
       -- request_document keep the finding open by design and must never suppress.
       AND COALESCE(df.resolution, '') IN ('dismiss', 'clear', 'grant_exception', 'fix_file', 'decline')
  ) f
 WHERE f.code IS NOT NULL AND btrim(f.code) <> ''
 ORDER BY f.application_id, key, f.resolved_at DESC NULLS LAST
ON CONFLICT (application_id, finding_key) DO NOTHING;

-- The same for the appraisal desk's own findings table (identical identity rule;
-- its doc-side value column is `appraisal_value`, and it has no document id — so
-- the document slot is empty, exactly as claimOf computes it for a derived row).
INSERT INTO finding_decisions (application_id, finding_key, code, origin, decision, suppressed, note, decided_by, decided_at)
SELECT DISTINCT ON (f.application_id, key)
       f.application_id, key, f.code, 'appraisal_finding',
       CASE WHEN f.status = 'dismissed' THEN 'dismissed' ELSE COALESCE(f.resolution, 'resolved') END,
       true,
       left(COALESCE(f.resolution_note, ''), 1000),
       f.resolved_by,
       COALESCE(f.resolved_at, now())
  FROM (
    SELECT af.*,
           'code:' || lower(btrim(COALESCE(af.code, '')))
             || '::' || lower(btrim(COALESCE(af.field, '')))
             || '::' || ''
             || '::' || lower(btrim(COALESCE(af.appraisal_value, ''))) AS key
      FROM appraisal_findings af
     WHERE af.application_id IS NOT NULL
       AND af.status IN ('dismissed', 'resolved')
       AND COALESCE(af.resolution, '') IN ('dismiss', 'keep', 'grant_exception', 'acknowledge', 'decline', 'replace', 'custom')
  ) f
 WHERE f.code IS NOT NULL AND btrim(f.code) <> ''
 ORDER BY f.application_id, key, f.resolved_at DESC NULLS LAST
ON CONFLICT (application_id, finding_key) DO NOTHING;
