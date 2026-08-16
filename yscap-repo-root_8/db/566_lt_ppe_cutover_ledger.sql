-- ============================================================================
-- LONG-TERM (LT) — db/566 — PPE cutover DECISION LEDGER.
--
-- The durable home for an investor's lifecycle history (§11 of
-- docs/longterm/PPE-MEGA-PLAN.md): draft → shadow → live → retired, each move
-- stamped with WHO decided, WHEN, from→to, the REASON, and the agreement
-- SCOREBOARD as it stood at that moment. The pure LOGIC already exists in
-- src/longterm/ppe/cutover-ledger.js (which delegates every legality question to
-- cutover.transition, so the ledger and the live gate can never disagree about
-- what "promote" requires); this is its durable home, and
-- src/longterm/ppe/cutover-store.js is the bridge.
--
-- WHY IT HAD TO EXIST BEFORE ANY PROMOTE BUTTON. /api/lt/ppe/* deliberately
-- shipped with no promote-to-live, and said so in its own header rather than
-- leaving it as silence: a promote decision that cannot be durably recorded is
-- worse than no promote at all. Turning an investor live is the single most
-- consequential move in this system — it is the moment our engine, not Lender
-- Price, answers a real quote — and "who turned this on, when, on what evidence"
-- must be answerable years later, by someone who was not there. Until now that
-- history lived only in whatever array a caller happened to hold.
--
-- APPEND-ONLY, AND THE DATABASE ENFORCES IT. A governance trail that can be
-- edited is not a trail. There is no updated_at and nothing here is ever meant
-- to be UPDATEd or DELETEd; a correction is a NEW decision (the `reopen` /
-- `rollback` actions exist precisely so a mistake is answered by another
-- recorded move rather than by rewriting the record of the first one). The
-- store performs INSERT only.
--
-- IDENTITY + THE CONCURRENCY GUARD: a decision is keyed by (scope, investor,
-- seq). `seq` is computed in JS from the loaded history (cutover-ledger.nextSeq),
-- which is a read-then-write — two admins deciding at the same instant would both
-- compute the same next seq. The UNIQUE key is what makes that race SAFE rather
-- than silent: the loser's INSERT is refused by the database (23505) and the
-- store surfaces it as "someone else just decided; re-read and try again",
-- instead of two contradictory decisions both claiming to be step 4. NEVER drop
-- this constraint to "fix" a duplicate-key error — that error IS the feature.
--
-- NULL-SAFE UNIQUENESS: investor is NOT NULL DEFAULT '' for the same reason as
-- db/565 — it is PART of the unique key, and SQL NULLs are distinct in a UNIQUE,
-- so a NULL would let two company-wide ledgers interleave their sequence numbers
-- undetected. A company-wide lifecycle uses ''; cutover-store.js normalizes
-- null → '' on write and filters on the same value on read.
--
-- `from_mode` / `to_mode` are recorded rather than derived so the history is
-- REPLAYABLE: cutover-ledger.validateHistory walks the rows from DRAFT and
-- confirms each entry's `from` equals the running mode and that the rule would
-- have allowed the move — which is how a tampered or partially-restored ledger
-- is detected instead of trusted. `eligible` records whether the scoreboard gate
-- had actually passed at decision time; `scoreboard` keeps that snapshot verbatim,
-- because the numbers a decision was made on are part of the decision and will
-- not still be true tomorrow.
--
-- SEPARATION: lt_ppe_* only; no RTL table read or written; no trigger or function
-- defined. MULTI-TENANT + SELLABLE: every row carries scope (default 'company');
-- nothing here is specific to us.
--
-- SOURCE OF TRUTH FOR THE SHAPE: src/longterm/prisma/schema.prisma
-- (LtPpeCutoverLedger) + docs/schema/beyond-prisma.json. Model, migration and
-- snapshot land together.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lt_ppe_cutover_ledger (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scope       TEXT NOT NULL DEFAULT 'company',
    investor    TEXT NOT NULL DEFAULT '',        -- '' = a company-wide lifecycle (NULL-safe unique key)
    seq         INTEGER NOT NULL,                -- 1-based, dense, per (scope, investor)
    action      TEXT NOT NULL,                   -- activate | promote | rollback | retire | reopen
    from_mode   TEXT NOT NULL,                   -- the mode this decision moved AWAY from (replayable)
    to_mode     TEXT NOT NULL,                   -- the mode it moved TO
    decided_by  TEXT NOT NULL,                   -- the human (or system actor) — this is an audit trail
    decided_at  BIGINT NOT NULL,                 -- the injected clock (epoch ms), matching cutover-ledger.atMs
    reason      TEXT NOT NULL,                   -- every governance move is explained
    eligible    BOOLEAN NOT NULL DEFAULT false,  -- did the scoreboard gate pass at decision time
    scoreboard  JSONB,                           -- that scoreboard snapshot, verbatim
    created_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT lt_ppe_cutover_ledger_seq_uk UNIQUE (scope, investor, seq)
);

-- The one read this table serves: replay a lifecycle oldest-first.
CREATE INDEX IF NOT EXISTS lt_ppe_cutover_ledger_history_idx
    ON lt_ppe_cutover_ledger (scope, investor, seq);
