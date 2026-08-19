-- ============================================================================
-- db/591 — arena day setup stamp, so a whole day can be pre-filled once
--
-- WHAT THIS CHANGES, AND WHY. The owner opened the Arena's Sessions list, found
-- it empty, and asked to have the two events they described ALREADY THERE —
-- pre-filled and adjustable — so that starting the day is one press rather than
-- a form to fill in on the morning. Today it is three steps in three panels:
-- type a name, put the session LIVE, and only then load the two ready-made
-- plans (the control room shows that panel for the live session only). So the
-- day cannot be prepared in advance at all, which is the whole ask.
--
-- `setup_day` is that preparation, recorded on the session: the LOCAL calendar
-- day the room is having. It is a `date`, never a timestamp, because "which day
-- is this?" is a question about a wall calendar in an office, not an instant —
-- and the session already carries `starts_at`/`ends_at` for the instants.
--
-- WHY AN INDEX AND NOT A CHECK-THEN-INSERT. Setting a day up is one button, and
-- a button gets pressed twice — by an impatient hand, by a double-submitting
-- browser, by two admins at once. Reading "is this day already set up?" and
-- then inserting is the exact race db/401 had to close on the conditions
-- engine: both readers see nothing and both insert. So the DATABASE decides,
-- and the code asks it to rather than asking itself.
--
-- SCOPED TO `state <> 'closed'` DELIBERATELY. A closed day is history; setting
-- the same calendar day up again afterwards (a re-run, a second attempt after
-- something went wrong) is legitimate and must stay possible. What must never
-- happen is two OPEN copies of one day, because the room, the chat, the
-- leaderboard and the recap all resolve "the day" and would have to guess.
--
-- THE SPIN HALF IS THE SAME RULE ONE LEVEL DOWN. `arena_spins.template_key`
-- (db/586) records which ready-made plan a spin was built from. Two Early Birds
-- inside one day is the same duplicate wearing different clothes — the second
-- would take its own check-ins, freeze its own roster and hand out its own
-- prizes — so one plan may appear once per session. A spin somebody built BY
-- HAND carries no template_key and is untouched by this: the index is partial,
-- so any number of hand-built spins remain fine.
--
-- NOTHING IS BACK-FILLED. Every existing session predates the button and was
-- assembled by hand; stamping a day onto one would be inventing a fact nobody
-- stated, and would then claim that day as taken. They stay NULL, which reads
-- exactly right: nobody set these up this way.
--
-- IDEMPOTENT. `migrate-boot` replays EVERY file in db/ on EVERY boot, in
-- filename order. That is not a safety net, it is the contract: a statement
-- that throws on its second run breaks every future deploy, and migrate-boot
-- logs the failure and CONTINUES, so it breaks quietly. The four shapes the
-- hygiene gate enforces:
--
--   CREATE TABLE IF NOT EXISTS t (...);
--   CREATE INDEX IF NOT EXISTS t_col_idx ON t (col);
--   ALTER TABLE t ADD COLUMN IF NOT EXISTS c text;
--   ALTER TABLE t DROP CONSTRAINT IF EXISTS t_chk;   -- always drop first,
--   ALTER TABLE t ADD CONSTRAINT t_chk CHECK (...);  -- then re-add
--
-- NO CHECK CONSTRAINT IS DECLARED HERE, and that is on purpose: db/585 and
-- db/586 both declare constraints on these two tables and re-assert them on
-- every boot, so a THIRD file re-declaring one of theirs is precisely the
-- rollback trap db/590 exists to repair. This file adds a column and two
-- indexes and nothing else, so it has nothing that can fail on a replay and
-- nothing that can take another file's work down with it.
--
-- PRODUCT SEPARATION. RTL and Long-Term do not share tables. The Arena is an
-- internal staff game: it touches no borrower, no file, and no loan, and the
-- only identity it reads is the shared `staff_users` roster.
-- ============================================================================

-- ── (1) THE DAY A SESSION WAS SET UP FOR ────────────────────────────────────
ALTER TABLE arena_sessions ADD COLUMN IF NOT EXISTS setup_day date;

COMMENT ON COLUMN arena_sessions.setup_day IS
  'The local calendar day this session was pre-filled for by the one-click day '
  'setup. NULL on a session somebody assembled by hand. At most one non-closed '
  'session may hold a given day.';

-- ── (2) ONE OPEN COPY OF A DAY ──────────────────────────────────────────────
-- The pressed-twice guard. Partial, so it constrains only the days the button
-- actually claimed and never a hand-built session (setup_day IS NULL), and only
-- while that day is still open for business.
CREATE UNIQUE INDEX IF NOT EXISTS arena_sessions_setup_day_open_uk
  ON arena_sessions (setup_day)
  WHERE setup_day IS NOT NULL AND state <> 'closed';

-- ── (3) ONE COPY OF A READY-MADE PLAN PER DAY ───────────────────────────────
-- The same guard for the spins inside it. A hand-built spin carries no
-- template_key and is not covered.
CREATE UNIQUE INDEX IF NOT EXISTS arena_spins_session_template_uk
  ON arena_spins (session_id, template_key)
  WHERE template_key IS NOT NULL;


-- ── after this lands ────────────────────────────────────────────────────────
-- The schema map (docs/schema/) describes the database these migrations build,
-- so this file makes it stale. CI refreshes it on this pull request by itself;
-- if you would rather do it by hand, with DATABASE_URL pointing at a database
-- built from these migrations:
--
--   npm run schema:snapshot     # refresh the inventory from the database
--   npm run schema:restamp      # re-stamp the map header (no database needed)
