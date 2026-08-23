-- ============================================================================
-- db/618 — LONG-TERM: which ClickUp card belongs to this Encompass loan.
--
-- WHAT THIS CHANGES, AND WHY. The owner, 2026-08-23: *"every Encompass
-- Long-Term file that is after the starting status ... should be linked already
-- with a ClickUp file. Anything new, we can open confidently, and he can create
-- a new ClickUp file. If not, if we're not linking them before, then even old
-- files that already have a ClickUp file are going to create new ones, and we're
-- going to find ourselves with duplicate ClickUps."*
--
-- That is the whole reason this exists. Long-Term is about to become
-- Encompass-first: an office opens the file in Encompass and PILOT opens its
-- ClickUp card. A loan that cannot say which card is already its own has no way
-- to tell "open a card for me" from "a card already exists" — so on the first
-- pass it opens a second one, on every loan the office has ever worked, and the
-- pipeline everybody reads doubles. The link is what makes creation safe.
--
-- IT IS RECORDED, NOT DERIVED. Matching a loan to a card is a judgement made
-- once, off a loan number, an address and an amount, with a human confirming
-- anything short of certain. Re-deriving it on every read would put that
-- judgement back in the hot path and let it come out differently tomorrow, so
-- the ANSWER is stored and the reasoning is not.
--
-- A GUESS IS NEVER STAMPED. `clickup_link_confidence` separates a link nobody
-- has to think about ('confirmed') from one PILOT proposed and a person has not
-- yet agreed to ('probable'). `lt_loans_clickup_stamp_confirmed_chk` makes that
-- structural rather than a rule somebody has to remember: a row may not carry a
-- stamp time unless its link is confirmed. Writing our id onto the wrong card in
-- ClickUp is the expensive mistake here — it teaches the office that two
-- unrelated deals are one deal — and this is what makes it unwritable.
--
-- ONE CARD, ONE LOAN. `lt_loans_clickup_task_uk` is a PARTIAL unique index (only
-- over rows that carry a task id), so the many loans with no card yet do not
-- collide with each other. Unlike db/549's mistake with the loan number, this
-- one is ours to enforce: a ClickUp task genuinely names one deal, and two loans
-- claiming the same card is an error we want refused at the moment it is made
-- rather than discovered later on a pipeline that quietly counts one deal twice.
--
-- BACKFILL: NONE, and deliberately. Every column starts NULL, which reads as
-- "we have not worked out this loan's card yet" — the truth on the day this
-- lands. The links are established by the reconciliation the owner asked for and
-- are written one at a time, each with its source recorded; inventing them here
-- would put a guess into the one column whose whole job is to be trusted.
--
-- PRODUCT SEPARATION: `lt_*` only. No RTL table is read or written, no trigger
-- and no function is defined, and nothing here implies a write to Encompass.
-- ============================================================================

-- ── the link itself, on the loan ────────────────────────────────────────────

-- ClickUp's own task id ("868kur80x") — the durable key. NOT the FILLE-#### the
-- office reads: that one is a per-workspace display id, and matching on it would
-- break the day the workspace prefix changes.
ALTER TABLE lt_loans ADD COLUMN IF NOT EXISTS clickup_task_id        TEXT;

-- The FILLE-#### a person recognises, and the link they can click. Both are
-- DISPLAY copies of what ClickUp holds: nothing keys on them, and a stale one
-- costs a re-read, never a mismatched loan.
ALTER TABLE lt_loans ADD COLUMN IF NOT EXISTS clickup_custom_id      TEXT;
ALTER TABLE lt_loans ADD COLUMN IF NOT EXISTS clickup_url            TEXT;

ALTER TABLE lt_loans ADD COLUMN IF NOT EXISTS clickup_linked_at      timestamptz;

-- HOW this link came to exist. 'reconciliation' = the one-time pass over the
-- book that already existed; 'created' = PILOT opened the card itself, so the
-- link is a fact rather than a match; 'manual' = a person tied them together.
ALTER TABLE lt_loans ADD COLUMN IF NOT EXISTS clickup_link_source    TEXT;

-- 'confirmed' or 'probable'. See the header: only a confirmed link may be
-- stamped back into ClickUp.
ALTER TABLE lt_loans ADD COLUMN IF NOT EXISTS clickup_link_confidence TEXT;

-- When PILOT last wrote its own file id into the card's "ys portal" field, so
-- the link reads the same from either side. NULL = never stamped.
ALTER TABLE lt_loans ADD COLUMN IF NOT EXISTS clickup_stamped_at     timestamptz;

-- WHY the last stamp did not go through, in the words a person reads. Left NULL
-- on success — a reason sitting on a healthy row trains people to ignore the
-- column.
ALTER TABLE lt_loans ADD COLUMN IF NOT EXISTS clickup_stamp_error    TEXT;

COMMENT ON COLUMN lt_loans.clickup_task_id IS
  'ClickUp task id this long-term loan belongs to. NULL = no card worked out yet. One card, one loan.';
COMMENT ON COLUMN lt_loans.clickup_link_confidence IS
  '''confirmed'' (nobody needs to think about it) or ''probable'' (PILOT proposed it, a person has not agreed). Only confirmed may be stamped.';

-- ── the guards ──────────────────────────────────────────────────────────────

ALTER TABLE lt_loans DROP CONSTRAINT IF EXISTS lt_loans_clickup_confidence_chk;
ALTER TABLE lt_loans ADD  CONSTRAINT lt_loans_clickup_confidence_chk
  CHECK (clickup_link_confidence IS NULL
         OR clickup_link_confidence IN ('confirmed', 'probable'));

ALTER TABLE lt_loans DROP CONSTRAINT IF EXISTS lt_loans_clickup_source_chk;
ALTER TABLE lt_loans ADD  CONSTRAINT lt_loans_clickup_source_chk
  CHECK (clickup_link_source IS NULL
         OR clickup_link_source IN ('reconciliation', 'created', 'manual'));

-- The structural half of "a guess is never stamped".
ALTER TABLE lt_loans DROP CONSTRAINT IF EXISTS lt_loans_clickup_stamp_confirmed_chk;
ALTER TABLE lt_loans ADD  CONSTRAINT lt_loans_clickup_stamp_confirmed_chk
  CHECK (clickup_stamped_at IS NULL OR clickup_link_confidence = 'confirmed');

CREATE UNIQUE INDEX IF NOT EXISTS lt_loans_clickup_task_uk
  ON lt_loans (clickup_task_id) WHERE clickup_task_id IS NOT NULL;

-- The two questions the reconciliation screen asks: which loans still have no
-- card, and which confirmed links are still waiting to be stamped.
CREATE INDEX IF NOT EXISTS lt_loans_clickup_unlinked_idx
  ON lt_loans (created_at DESC) WHERE clickup_task_id IS NULL;

-- ── the trail ───────────────────────────────────────────────────────────────
-- A link that changes silently is the one thing that could quietly re-point a
-- deal at somebody else's card, so every set, change and clear writes a row
-- here. The loan keeps the CURRENT answer; this keeps how it got there.
CREATE TABLE IF NOT EXISTS lt_clickup_link_log (
    id                UUID        NOT NULL,
    lt_loan_id        UUID        NOT NULL,
    -- 'linked' | 'relinked' | 'unlinked' | 'confirmed' | 'stamped' | 'stamp_failed'
    action            TEXT        NOT NULL,
    from_task_id      TEXT,
    to_task_id        TEXT,
    confidence        TEXT,
    source            TEXT,
    -- Plain language: what was matched on, or what refused. Read by a person.
    reason            TEXT,
    -- The staff_users row that did it. NULL for a pass PILOT ran on its own.
    acted_by          UUID,
    created_at        timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_clickup_link_log_pkey PRIMARY KEY (id)
);

COMMENT ON TABLE lt_clickup_link_log IS
  'Every time a long-term loan gained, changed, lost or stamped its ClickUp card, and why. The loan row holds the current answer; this holds the history.';

CREATE INDEX IF NOT EXISTS lt_clickup_link_log_loan_idx
  ON lt_clickup_link_log (lt_loan_id, created_at DESC);


-- ── after this lands ────────────────────────────────────────────────────────
-- The schema map (docs/schema/) describes the database these migrations build,
-- so this file makes it stale. CI refreshes it on this pull request by itself.
