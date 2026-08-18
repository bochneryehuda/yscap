-- ============================================================================
-- LONG-TERM (LT) — db/578 — the canary TICK's cross-instance LEASE, and the
-- record of what the last tick did (and why it did nothing).
--
-- WHAT PROBLEM THIS FIXES. `POST /api/lt/ppe/canary/tick` is the tick that fires
-- the daily change-detection schedules saved in db/570. NOTHING CALLS IT — no
-- cron, no worker, no interval, no Render job, no other route — so a schedule can
-- be stored, enabled and never fire, and "the daily battery detects a Lender
-- Price change" is true of the code and false of the running system. That is
-- recorded in docs/longterm/LT-ROUTES-UNREACHED.md under "The one row that is a
-- defect, not a gap". This table is the safety half of the fix: the in-process
-- driver that can call the tick (`src/longterm/ppe/canary-driver.js`) is OFF by
-- default behind an environment switch, and it may never fire a schedule twice.
--
-- WHY A LEASE AND NOT A TIMER GUARD. A tick prices a whole battery against a LIVE
-- vendor and every run costs money. Two instances of one service — a deploy
-- overlap, a scale-out, a restart racing a still-draining process — each hold
-- their own timer and cannot see one another. An in-process mutex is invisible
-- across processes; only the database is shared by all of them. So the claim is a
-- DURABLE ROW: an instance takes it or it does not run, and a crashed holder's
-- claim simply expires instead of wedging the schedule forever.
--
-- WHY NOT `sync_locks`. That is the RTL table this shape is copied from
-- (db/115, used by `src/lib/sharepoint-backup.js` for exactly this job: a
-- conditional upsert that succeeds only when the row is free or already ours).
-- The pattern is REUSED verbatim; the TABLE cannot be, because Long-Term may not
-- read or write an RTL table in raw SQL (CLAUDE.md, "TWO PRODUCTS, TWO SYSTEMS",
-- rule 4). So this is that same lease, named `lt_*` and owned by this side.
--
-- WHY THE OUTCOME LIVES ON THE SAME ROW. "When did the tick last run, what did it
-- do, and why did it not run?" has no home in the existing stores, and that is not
-- an oversight: the run series (db/565) records a canary that ACTUALLY PRICED
-- something, and the findings ledger (db/561) records what disagreed. A tick that
-- held every schedule — because nothing was due, because a program would not load,
-- because the lease was held elsewhere — writes to neither, so an operator
-- watching those two sees a driver that has never run and a driver that is running
-- perfectly as exactly the same silence. The outcome columns here are that missing
-- answer, and they sit on the lease row because it is the same fact about the same
-- worker: who holds it, and what happened when they last had it.
--
-- THE DENIAL COLUMNS ARE SEPARATE ON PURPOSE. The instance that is TURNED AWAY
-- must also record why — a silent skip is the failure mode this whole change
-- exists to remove — but it must not overwrite the state of the instance that is
-- holding the lease and doing the work. So a loser writes only `last_denied_*`,
-- and both halves of the story are readable at once.
--
-- BACKFILL: NONE, and nothing is seeded. A lease row is created by the first
-- instance that attempts a tick. No row means no tick has ever been attempted,
-- which is exactly the state this table must be able to express — it is the state
-- the running system is in today, and the driver ships OFF, so it is the state it
-- stays in until somebody deliberately turns the switch on.
--
-- SEPARATION: lt_ppe_* only; no RTL table read or written; no trigger and no
-- function defined. MULTI-TENANT + SELLABLE: the lock key carries the scope, so
-- one tenant's tick can never hold another tenant's lease.
--
-- IDEMPOTENT: CREATE TABLE / CREATE INDEX IF NOT EXISTS only; every CHECK is
-- dropped before it is re-added, so a replay on every boot is a no-op.
-- ============================================================================

CREATE TABLE IF NOT EXISTS lt_ppe_canary_driver_state (
    -- The claim. One row per (worker, scope) — e.g. 'lt-ppe-canary-tick:company'.
    lock_key            TEXT PRIMARY KEY,

    -- ── the LEASE ───────────────────────────────────────────────────────────
    -- Who holds it, and until when. `holder` is a per-process identity (pid +
    -- random), so the same instance can renew and release its own claim while a
    -- different one cannot. NULL holder + past expiry = free.
    holder              TEXT,
    expires_at          timestamptz,
    acquired_at         timestamptz,

    -- ── what the last HOLDER did ────────────────────────────────────────────
    last_attempt_at     timestamptz,     -- when a holder last began a tick
    last_finished_at    timestamptz,     -- when it finished (NULL while running, or if it never did)
    last_outcome        TEXT,            -- ran | nothing_due | refused | error  (see the CHECK)
    last_reason         TEXT,            -- the plain-language why, for a human
    last_detail         JSONB,           -- the tick's own report: what ran, what was held, why
    last_holder         TEXT,            -- which instance produced the outcome above

    -- ── what a DENIED instance recorded ─────────────────────────────────────
    -- Written by the instance that could NOT take the lease. Deliberately its own
    -- set of columns so being turned away is never mistaken for having run, and
    -- never erases the holder's outcome.
    last_denied_at      timestamptz,
    last_denied_by      TEXT,
    last_denied_reason  TEXT,

    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

-- The four outcomes a tick can honestly report. `nothing_due` is a SUCCESS — the
-- driver woke, asked, and every schedule said "not yet" — and it is kept apart
-- from `ran` because an operator asking "is this thing alive?" needs to tell a
-- healthy quiet night from a night nothing happened at all. `refused` is the tick
-- deciding not to run (an unreadable schedule set, a program that would not load);
-- `error` is the tick or the driver throwing. Deliberately LOOSER than the module:
-- the driver owns the exact wording, and a CHECK that duplicated it would be a
-- second copy of a rule that drifts.
ALTER TABLE lt_ppe_canary_driver_state DROP CONSTRAINT IF EXISTS lt_ppe_canary_driver_state_outcome_chk;
ALTER TABLE lt_ppe_canary_driver_state ADD CONSTRAINT lt_ppe_canary_driver_state_outcome_chk
    CHECK (last_outcome IS NULL OR last_outcome IN ('ran', 'nothing_due', 'refused', 'error'));

-- A lease with a holder must state when it expires, or it can never be reclaimed
-- and one crashed process silences the schedule forever. The database refuses the
-- shape that would wedge it.
ALTER TABLE lt_ppe_canary_driver_state DROP CONSTRAINT IF EXISTS lt_ppe_canary_driver_state_lease_chk;
ALTER TABLE lt_ppe_canary_driver_state ADD CONSTRAINT lt_ppe_canary_driver_state_lease_chk
    CHECK (holder IS NULL OR expires_at IS NOT NULL);

-- The one read an operator screen performs: the most recently active workers.
CREATE INDEX IF NOT EXISTS lt_ppe_canary_driver_state_attempt_idx
    ON lt_ppe_canary_driver_state (last_attempt_at DESC);


-- ── after this lands ────────────────────────────────────────────────────────
-- The schema map (docs/schema/) describes the database these migrations build,
-- so this file makes it stale. CI refreshes it on this pull request by itself;
-- if you would rather do it by hand, with DATABASE_URL pointing at a database
-- built from these migrations:
--
--   npm run schema:snapshot     # refresh the inventory from the database
--   npm run schema:restamp      # re-stamp the map header (no database needed)
