-- ============================================================================
-- db/581 — lt ppe disqualifier review queue
--
-- WHAT THIS CHANGES, AND WHY. The owner was asked which wins when Lender Price's
-- eligibility rules and our rate sheet disagree, and answered with an instruction
-- instead of a rule: "look on the eligibility rule in Lender Price, go into the
-- disqualifier, and look for the actual disqualifier. You then look at the rate to
-- see if you can find where he's taking this disqualifier. You need a human to
-- review these findings for every single scenario." `disqualifier-review.js` does
-- those three steps and produces the question; this table is where the questions
-- wait, and — far more importantly — where the ANSWERS stay.
--
-- WHY A TABLE AT ALL, when the review is computed. Because the computation is
-- re-run: the daily check prices the same battery again tomorrow. Without durable
-- rows a reviewer's decision would be recomputed away every single day and the
-- same question would be asked forever, which is the failure the RTL side already
-- learned twice (ai_suggestions re-raising a dismissed row, and finding_decisions
-- being built to stop it). So the ROW is the question and the DECISION lives on it.
--
-- THE DECISION SURVIVES A RE-RUN, AND ONLY A CHANGED SITUATION REOPENS IT. Each
-- item carries a `state_key` — a fingerprint of WHAT WAS TRUE when it was asked
-- (the classification plus what our sheet does about it). A re-run that finds the
-- same state refreshes `last_seen_at` and leaves a decided row alone. A re-run that
-- finds a DIFFERENT state reopens it, keeping the old answer in `prior_decision`
-- so nobody has to guess whether it was ever answered: a decision made about "our
-- sheet says nothing here" is not an answer about "our sheet now charges 0.750".
--
-- IT DECIDES NOTHING ITSELF. There is no rule here that turns a decision into a
-- published rule or a changed price. Publishing a pricing rule is a super admin's
-- act with its own door (§2.57); this queue records what a human concluded, and
-- acting on it is a separate, deliberate step.
--
-- IDEMPOTENT: every statement is IF NOT EXISTS / drop-then-add.
--
-- BACKFILL: none, and deliberately. There is no historical queue to migrate — the
-- items are computed from runs, so the first run after this lands fills it.
--
-- PRODUCT SEPARATION: `lt_*` only. Long-Term, no RTL table touched.
-- ============================================================================

CREATE TABLE IF NOT EXISTS lt_ppe_disqualifier_review (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scope            TEXT NOT NULL DEFAULT 'company',

    -- The program whose sheet and rules produced our side of the comparison. A
    -- question about a disqualifier is only meaningful against one program's
    -- answer, so this is never nullable.
    program_id       UUID NOT NULL REFERENCES lt_ppe_program(id) ON DELETE CASCADE,

    -- WHICH LOAN. `scenario_key` is a stable digest of the facts (computed in JS,
    -- never here — the digest and the review must come from one definition), and
    -- `scenario` keeps the facts themselves so a row can be read years later
    -- without re-deriving what "sc_9f2…" meant.
    scenario_key     TEXT NOT NULL,
    scenario         JSONB NOT NULL,

    -- WHICH DISQUALIFIER. `dimension` is NULL exactly when Lender Price refused for
    -- something outside our curated crosswalk — that is a real and useful state
    -- (somebody has to name it), never a placeholder. `item_key` is what makes the
    -- row unique: the dimension when we have one, LP's own reason text when we do
    -- not, so two unnameable refusals on one scenario stay two rows.
    item_key         TEXT NOT NULL,
    dimension        TEXT,
    lp_reason        TEXT,
    adj_type         TEXT,
    layer            TEXT,

    -- WHAT WE FOUND. `classification` is the machine-readable answer to "what does
    -- our side do about this"; `question` is the same thing in the words a person
    -- reads. Both are stored: a screen renders the sentence, and a report counts
    -- the codes, and neither should have to re-derive the other.
    classification   TEXT NOT NULL,
    needs_human      BOOLEAN NOT NULL DEFAULT TRUE,
    question         TEXT NOT NULL,
    our_sheet        JSONB,
    our_eligibility  JSONB,

    -- The fingerprint of the situation this question was asked about. See the
    -- header: this is what makes a decision durable without making it blind.
    state_key        TEXT NOT NULL,

    status           TEXT NOT NULL DEFAULT 'open',
    decision         TEXT,
    decision_note    TEXT,
    decided_by       TEXT,
    decided_at       BIGINT,
    -- Kept when a changed situation reopens a decided row, so the history of what
    -- was concluded is never destroyed by the reopen that supersedes it.
    prior_decision   JSONB,

    first_seen_at    BIGINT NOT NULL,
    last_seen_at     BIGINT NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_ppe_disq_review_status_chk
      CHECK (status IN ('open','decided','stale')),
    -- The decisions a human may reach. `lp_is_wrong` is a real outcome and is named
    -- rather than folded into "allow": Lender Price mis-encoding a guideline is a
    -- thing we have already found more than once, and it needs a different
    -- follow-up from deciding our own sheet should let the loan through.
    CONSTRAINT lt_ppe_disq_review_decision_chk
      CHECK (decision IS NULL OR decision IN ('refuse','price','allow','lp_is_wrong','needs_more_info')),
    -- A decided row must say who decided it. The same discipline db/577 applies to
    -- publishing a rule: the recording IS the accountability, and a decision with
    -- nobody's name on it is an anonymous change to how we underwrite.
    CONSTRAINT lt_ppe_disq_review_decided_chk
      CHECK (status <> 'decided' OR (decision IS NOT NULL AND decided_by IS NOT NULL AND decided_at IS NOT NULL))
);

-- ONE ROW PER (program, scenario, disqualifier). This is what makes a re-run
-- idempotent — the writer upserts on it — and it is a UNIQUE INDEX rather than a
-- constraint so the upsert can name it directly.
CREATE UNIQUE INDEX IF NOT EXISTS lt_ppe_disq_review_item_uk
    ON lt_ppe_disqualifier_review (scope, program_id, scenario_key, item_key);

-- The queue's own read: what is open on this program, newest question first.
CREATE INDEX IF NOT EXISTS lt_ppe_disq_review_open_idx
    ON lt_ppe_disqualifier_review (scope, program_id, status, last_seen_at DESC);

-- "How many of these are DSCR questions?" — the report the owner will actually ask
-- for, since a hundred rows of one dimension is one rule to write, not a hundred.
CREATE INDEX IF NOT EXISTS lt_ppe_disq_review_dimension_idx
    ON lt_ppe_disqualifier_review (scope, program_id, dimension, status);
