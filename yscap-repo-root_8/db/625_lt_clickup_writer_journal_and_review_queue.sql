-- db/625: the Long-Term ClickUp WRITER's journal, review queue, and push stamps.
--
-- Owner-directed 2026-08-23 (the CLICKUP WRITER'S INHERITANCE, recorded in
-- docs/LONG-TERM-AUTHORIZED-COPIES.md): the LT Encompass→ClickUp field writer
-- inherits the RTL machinery's guards, and the guards need somewhere to live —
-- a write JOURNAL (every outbound field write, before + after, blocked writes
-- too), a REVIEW QUEUE (a blocked identity overwrite asks a human instead of
-- silently winning or silently dropping), and the per-loan PUSH STAMPS the
-- drain works off. LT tables only — RTL's clickup_write_log / sync_review_queue
-- carry no authorization for LT (the two-products law).
--
-- Idempotent; replays safely on every boot. Prisma model updated in the SAME
-- commit (src/longterm/prisma/schema.prisma — the db/621 lesson).

-- ── 1. The write journal (the RTL db/107 shape, keyed to LT) ────────────────
-- Append-only. SSN masked / values trimmed BEFORE insert (push.js does the
-- masking — the journal never holds a readable Social). Best-effort: a journal
-- failure never blocks a push. The circuit breaker seeds its rolling window
-- from here on boot, so a restart mid-storm cannot reset the budget.
CREATE TABLE IF NOT EXISTS lt_clickup_write_log (
    id          BIGSERIAL PRIMARY KEY,
    lt_loan_id  UUID,
    task_id     TEXT NOT NULL,
    field_id    TEXT,              -- NULL for a non-field event (e.g. a refused card)
    field_key   TEXT,              -- the mapper's logical key ('ssn', 'loan_amount', …)
    old_value   JSONB,             -- ClickUp's value immediately before (NULL = unknown/new)
    new_value   JSONB,             -- what we wrote (or tried / were refused to)
    changed     BOOLEAN NOT NULL DEFAULT true,   -- false = nothing landed
    blocked     BOOLEAN NOT NULL DEFAULT false,  -- true  = a guardrail refused it
    source      TEXT,              -- 'create' | 'scoped_push' | 'full_repush'
    created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE lt_clickup_write_log IS
  'Every outbound Long-Term ClickUp field write — before and after values (SSN masked), including writes a guardrail refused. Append-only; the volume circuit breaker seeds from it on boot.';

CREATE INDEX IF NOT EXISTS lt_cu_write_log_task_idx ON lt_clickup_write_log (task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS lt_cu_write_log_loan_idx ON lt_clickup_write_log (lt_loan_id, created_at DESC);
CREATE INDEX IF NOT EXISTS lt_cu_write_log_recent_idx ON lt_clickup_write_log (created_at) WHERE blocked = false;

-- ── 2. The review queue (a blocked write asks a human) ──────────────────────
-- Reasons the writer produces today: 'pii_overwrite_blocked' (a differing
-- identity field is FILLED only when blank, never rewritten) and
-- 'dob_change_blocked_pending_review' (ANY change to an existing ClickUp DOB
-- is a human decision). Values arrive MASKED — an SSN is never stored here.
CREATE TABLE IF NOT EXISTS lt_clickup_review_queue (
    id             BIGSERIAL PRIMARY KEY,
    lt_loan_id     UUID,
    task_id        TEXT NOT NULL,
    direction      TEXT NOT NULL DEFAULT 'outbound',
    field_key      TEXT NOT NULL,
    current_value  TEXT,           -- what the card holds (masked where PII)
    proposed_value TEXT,           -- what the mirror wanted to write (masked)
    reason         TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'open',   -- 'open' | 'resolved' | 'rejected'
    resolved_by    UUID,
    resolved_at    timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT lt_cu_review_status_chk CHECK (status IN ('open', 'resolved', 'rejected'))
);

COMMENT ON TABLE lt_clickup_review_queue IS
  'Outbound Long-Term ClickUp writes a guardrail held for a person: a differing identity field, a DOB change. Resolving one re-pushes the single field with approvedReview; rejecting keeps the card as it is.';

-- One OPEN row per (task, field, proposal) — the sync-review dedupe shape, so
-- a retried pass never stacks duplicate questions in front of the reviewer.
CREATE UNIQUE INDEX IF NOT EXISTS lt_cu_review_open_uk
  ON lt_clickup_review_queue (task_id, field_key, direction, (COALESCE(proposed_value, '')))
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS lt_cu_review_loan_idx ON lt_clickup_review_queue (lt_loan_id, created_at DESC);
CREATE INDEX IF NOT EXISTS lt_cu_review_open_idx ON lt_clickup_review_queue (created_at DESC) WHERE status = 'open';

-- ── 3. The push stamps on the loan row ──────────────────────────────────────
-- clickup_pushed_at: the last CLEAN push (zero failed writes — a lossy push is
-- never marked done, so the drain retries it). clickup_push_error: the last
-- failure, plain text, cleared on the next clean push.
ALTER TABLE lt_loans ADD COLUMN IF NOT EXISTS clickup_pushed_at timestamptz;
ALTER TABLE lt_loans ADD COLUMN IF NOT EXISTS clickup_push_error TEXT;

COMMENT ON COLUMN lt_loans.clickup_pushed_at IS
  'When the ClickUp field writer last pushed this loan CLEANLY (every intended field landed). NULL = never pushed. The drain works off encompass_synced_at > clickup_pushed_at.';
COMMENT ON COLUMN lt_loans.clickup_push_error IS
  'The last push failure, plain text; cleared on the next clean push.';

-- The drain: linked loans whose mirror moved since the last clean push.
CREATE INDEX IF NOT EXISTS lt_loans_clickup_push_due_idx
  ON lt_loans (clickup_pushed_at ASC NULLS FIRST)
  WHERE clickup_task_id IS NOT NULL;

-- ── 4. The link-log vocabulary grows 'created' ──────────────────────────────
-- lt_clickup_link_log.action carries no CHECK (db/618 keeps the vocabulary in
-- a comment); the writer adds the 'created' action — a card the writer itself
-- created and linked in one motion. Recorded here so the vocabulary comment
-- stays honest.
COMMENT ON COLUMN lt_clickup_link_log.action IS
  '''linked'' | ''relinked'' | ''unlinked'' | ''confirmed'' | ''stamped'' | ''stamp_failed'' | ''created'' (the writer created the card and linked it in one motion)';
