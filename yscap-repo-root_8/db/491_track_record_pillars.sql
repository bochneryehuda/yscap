-- ============================================================================
-- 491 — THE THREE VERIFICATION PILLARS, one row per pillar per track-record line.
--
-- Owner-directed 2026-08-09. Every property on a track record has to answer
-- three separate questions, and today the system stores ONE boolean for all
-- three (`track_records.is_verified`), so "we proved they owned it but we have
-- not proved the sale" is unstateable:
--
--   1. RECENCY  — the exit is inside the frozen 36-month window
--   2. OWNERSHIP— they (or an entity they control) actually held the property
--   3. EXIT     — the deal really finished the way they say it did
--
-- ── WHY A TABLE AND NOT THREE COLUMNS ───────────────────────────────────────
-- Each pillar carries its own evidence, its own source, its own grade, its own
-- expiry and its own reviewer. Three columns would be fifteen, and adding a
-- fourth pillar later would be another five. A row per pillar also makes the
-- ONE query the workspace needs ("what is outstanding across this borrower?")
-- a plain WHERE rather than an OR over column groups.
--
-- ── THE MACHINE AND THE HUMAN NEVER COLLAPSE ────────────────────────────────
-- `auto_*` is what PILOT observed. `human_*` is what a person decided. They are
-- deliberately separate column groups because they are DIFFERENT FACTS and must
-- never render identically: "a data vendor's index says this deed exists" is not
-- "an underwriter read the deed."
--
-- **THE SIGN-OFF GATE READS `human_verdict`, NEVER `auto_verdict`.** Nothing
-- automatic may ever satisfy a pillar. This is the same doctrine the repo
-- already applies to `track_records.is_verified` (db/485: nothing arrives
-- verified) and to the AI findings desks (advisory only, 2026-07-27).
--
-- ── auto_verdict: FOUR VALUES, AND 'no_data' IS NOT NULL ────────────────────
-- NULL          = never asked. Every existing line starts here.
-- 'no_data'     = we asked and there is nothing there.
-- 'proved'      = the evidence supports the claim.
-- 'contradicted'= the evidence CONTRADICTS the claim. Loud, and never the same
--                 as 'no_data' — the D2/D3 lesson of this repo is that "we found
--                 nothing" and "we found the opposite" are different facts, and
--                 collapsing them is how a system reports a problem as silence.
-- 'too_recent'  = recency only: the exit has not happened yet.
--
-- ── auto_grade FOLLOWS NIST SP 800-63A ──────────────────────────────────────
-- The identity-evidence ladder (resolution / validation / verification) is the
-- closest published standard to this problem and supplies the vocabulary:
-- superior | strong | fair | weak | unacceptable. Floors are POLICY and live in
-- code, not here, so they can move without a migration.
--
-- Idempotent: CREATE TABLE / INDEX IF NOT EXISTS, additive only. No data is
-- read, written or deleted by this file.
-- ============================================================================

CREATE TABLE IF NOT EXISTS track_record_pillars (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  track_record_id  uuid NOT NULL REFERENCES track_records(id) ON DELETE CASCADE,
  pillar           text NOT NULL CHECK (pillar IN ('recency','ownership','exit')),

  -- THE MACHINE'S ANSWER — an observation, never a verdict.
  auto_verdict     text CHECK (auto_verdict IN ('proved','contradicted','no_data','too_recent')),
  auto_source      text,          -- 'elementix' | 'document' | 'assessor' | 'entity' | 'derived'
  auto_confidence  text CHECK (auto_confidence IN ('certain','likely','possible')),
  auto_evidence    jsonb,         -- {snippet, docId, recordingDate, grantor, grantee, url}
  auto_grade       text CHECK (auto_grade IN ('superior','strong','fair','weak','unacceptable')),
  auto_checked_at  timestamptz,

  -- THE HUMAN'S ANSWER. No automatic pass may ever write these four columns.
  human_verdict    text CHECK (human_verdict IN ('confirmed','rejected','needs_doc')),
  human_note       text,          -- internal, staff-only, never borrower-facing
  human_by         uuid REFERENCES staff_users(id),
  human_at         timestamptz,

  -- OWNERSHIP ONLY: which entity carried this pillar. This is what lets ONE
  -- verification of an LLC satisfy the ownership pillar on every property that
  -- LLC held (owner-directed: "if we verify ownership of these two LLCs, then
  -- all the ownership of all the properties is verified").
  satisfied_by_llc_id uuid REFERENCES llcs(id) ON DELETE SET NULL,

  -- A good-standing certificate goes stale; a recorded deed does not. NULL means
  -- "does not expire", which is the common case.
  expires_at       timestamptz,

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  -- One row per pillar per line. This is what makes a detector safe to re-run:
  -- it can ON CONFLICT rather than reading first and racing (the db/401 lesson).
  CONSTRAINT uq_trp_line_pillar UNIQUE (track_record_id, pillar)
);

-- The workspace's own query: "what is outstanding on this borrower's record?"
-- Answered from the pillars joined back to track_records, so index the join.
CREATE INDEX IF NOT EXISTS idx_trp_line ON track_record_pillars(track_record_id);

-- "Which pillars is a human still owed?" — the queue the staff screen is built
-- from. Partial, because a settled pillar is never in that list.
CREATE INDEX IF NOT EXISTS idx_trp_open
  ON track_record_pillars(track_record_id, pillar)
  WHERE human_verdict IS NULL;

-- Check A carry: "every pillar this entity satisfied", for when an entity's
-- verification is revoked and everything it carried has to be re-opened.
CREATE INDEX IF NOT EXISTS idx_trp_by_llc
  ON track_record_pillars(satisfied_by_llc_id)
  WHERE satisfied_by_llc_id IS NOT NULL;

-- Expiry sweep (db/306's exception-expiry pattern): only rows that CAN lapse.
CREATE INDEX IF NOT EXISTS idx_trp_expiring
  ON track_record_pillars(expires_at)
  WHERE expires_at IS NOT NULL;

COMMENT ON TABLE track_record_pillars IS
  'db/491. Three verification pillars per track-record line: recency, ownership, exit. '
  'auto_* is what PILOT observed; human_* is what a person decided; they are different facts '
  'and never collapse. The sign-off gate reads human_verdict ONLY — nothing automatic '
  'satisfies a pillar, the same doctrine as db/485 and the advisory-only AI findings.';

COMMENT ON COLUMN track_record_pillars.auto_verdict IS
  'NULL = never asked (every pre-existing line starts here). ''no_data'' = asked, nothing found. '
  '''contradicted'' = the evidence says the OPPOSITE — never the same as no_data.';

COMMENT ON COLUMN track_record_pillars.satisfied_by_llc_id IS
  'Ownership pillar only: the entity whose verified control carried this property. '
  'One verified LLC satisfies this pillar on every property it held (owner-directed).';
