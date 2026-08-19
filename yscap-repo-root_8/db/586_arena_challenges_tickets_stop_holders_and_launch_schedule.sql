-- ============================================================================
-- db/586 — THE ARENA, part two: challenges, tickets, stop-holders, schedules
--          (owner-directed 2026-08-19, the same day as db/585)
--
-- WHAT THIS ADDS, AND WHY. db/585 built the spin engine. The owner then
-- described the two games they actually want to run on the day, and both need
-- machinery the first migration does not have:
--
--   THE EARLY BIRD SPIN — launches by itself at 10:30, nudges every fifteen
--   minutes, a hurry-up at 11:30, and locks at 11:38. Two of the people in the
--   spin are given the STOP BUTTON: "the first winner will be the one that will
--   have permission on his screen to click the start button while the spinner
--   runs … the first name is going to be the one that clicks the Stop button on
--   which loan officer, the second one … on which item is going to be the
--   winner." So a wheel needs to know WHO holds its button, and a spin needs to
--   know when to launch itself.
--
--   THE MEGA SPIN — open 11:38 to 6pm, with CHALLENGES appearing on everyone's
--   screen roughly every twenty minutes from 12:30. "Anybody can have unlimited
--   chances. For every five chances … they can choose another thing to be
--   within the spin." Some challenges are first-past-the-post ("somebody won
--   this one already"); some take everybody. Proof is an upload, or writing, or
--   a check-in. A bigger challenge earns a bigger prize cap, up to $2,000.
--
-- THE STOP BUTTON REALLY STOPS IT (owner-corrected, 2026-08-19): "he should
-- have the actual stop button on the spinner. I click Start Spin, and he has
-- the stop button. It spins till he clicks Stop … he shouldn't be able to
-- literally control it. He should be able to try."
--
-- So a HELD wheel is a genuinely different thing from an automatic one, and the
-- schema has to hold both:
--   AUTO  — the winner is settled before the wheel moves and the wheel is
--           turned to it over a fixed time. `stop_mode = 'auto'`.
--   HELD  — the wheel spins and KEEPS SPINNING. Where it lands is decided by
--           WHEN the button was pressed. Nothing is chosen in advance.
--           `stop_mode = 'held'`.
--
-- A HELD WHEEL IS STILL CHECKABLE, by the same means as an automatic one. Three
-- things decide the landing angle and all three are recorded: the sealed seed
-- (its fingerprint published before anybody entered), the speed (published
-- before the wheel started), and `stopped_at - spin_started_at` — the elapsed
-- time measured BY THE DATABASE, in one statement, so a fast laptop clock
-- cannot move it. Anyone can recompute the angle from those and land on the
-- same slice.
--
-- AND IT CANNOT BE AIMED. At the default speed the wheel crosses a whole slice
-- in a few tens of milliseconds, well inside a person's own reaction scatter —
-- so somebody concentrating can lean on roughly which QUARTER it lands in, and
-- nothing finer. That is a real thing to hold, and the screen says exactly that
-- to the person holding it rather than implying either total control or none.
-- The seed is mixed in precisely so that a stopwatch and the published speed
-- are not enough to work out where to press.
--
-- STAFF ONLY, AND SALES ONLY FOR NOW. Nothing here is reachable by a borrower
-- or a broker; the owner also asked that this run for the SALES team rather
-- than the back office, which is a per-session roster choice
-- (`arena_session_members`, db/585) and needs no new table.
--
-- IDEMPOTENT. Every statement is IF NOT EXISTS / DROP-then-ADD, because
-- `migrate-boot` replays this file on EVERY boot.
--
-- BACKFILL: none. Every column added below is NULL or has a default that means
-- exactly what the row meant before it existed, so nothing already recorded
-- changes behaviour.
-- ============================================================================

-- ── (1) SPINS THAT LAUNCH THEMSELVES ────────────────────────────────────────
-- `launch_at` is when the spin should open on its own; the minute sweep opens
-- it. NULL means "a human opens it", which is what every existing spin means.
-- `template_key` records which pre-filled plan a spin was built from, so "run
-- last week's Early Bird again" is a lookup rather than a memory.
ALTER TABLE arena_spins ADD COLUMN IF NOT EXISTS launch_at    timestamptz;
ALTER TABLE arena_spins ADD COLUMN IF NOT EXISTS template_key text;
-- Every person in the SESSION is put on a new spin automatically, and the admin
-- takes people off rather than adding them one at a time (owner: "everybody
-- gets auto selected … we can remove certain people as well"). The removals are
-- what is stored, because they are the exception; an empty list means everyone.
ALTER TABLE arena_spins ADD COLUMN IF NOT EXISTS excluded_staff_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];
CREATE INDEX IF NOT EXISTS arena_spins_launch_idx
  ON arena_spins (launch_at) WHERE state = 'draft' AND launch_at IS NOT NULL;

-- ── (2) WHO HOLDS THE STOP BUTTON ───────────────────────────────────────────
-- One holder per wheel. `stop_mode` is written when the wheel actually stops:
--   'auto'  — it ran its full time and stopped by itself;
--   'held'  — a person pressed the button and it stopped early.
-- Either way the WINNER is unchanged: it was committed before the wheel moved.
ALTER TABLE arena_draws ADD COLUMN IF NOT EXISTS stop_holder_staff_id uuid REFERENCES staff_users(id) ON DELETE SET NULL;
ALTER TABLE arena_draws ADD COLUMN IF NOT EXISTS stopped_at timestamptz;
ALTER TABLE arena_draws ADD COLUMN IF NOT EXISTS stop_mode  text;
ALTER TABLE arena_draws DROP CONSTRAINT IF EXISTS arena_draws_stop_mode_chk;
ALTER TABLE arena_draws ADD CONSTRAINT arena_draws_stop_mode_chk
  CHECK (stop_mode IS NULL OR stop_mode IN ('auto', 'held'));
-- A FOURTH DRAW STATE. db/585 knew 'committed' -> 'spinning' -> 'revealed'.
-- A held wheel has one more moment: the button has been pressed and the wheel
-- is coasting to a stop, but the winner is not announced yet. That instant has
-- to be its own state, because it is what makes the press UNREPEATABLE -- the
-- claim that moves the row out of 'spinning' is what stops a second press (or
-- the safety-net timer firing at the same moment) from landing the wheel twice.
-- Re-asserted in FULL, naming every value db/585 allowed, because that file
-- replays too and a narrower re-assert would roll this one straight back.
ALTER TABLE arena_draws DROP CONSTRAINT IF EXISTS arena_draws_state_chk;
ALTER TABLE arena_draws ADD CONSTRAINT arena_draws_state_chk
  CHECK (state IN ('committed', 'spinning', 'stopping', 'revealed', 'void'));

-- ── (3) CHALLENGES — the things that pop up during the day ──────────────────
-- A challenge belongs to a SESSION and feeds a SPIN (the Mega Spin). It is
-- scheduled, then goes live, then closes. The super admin can see everything
-- that is coming, change it, skip it, or add their own — which is why the whole
-- schedule is rows here rather than a timer in code.
--
-- `library_key` names the idea it came from (src/lib/arena/challenge-library.js)
-- so a challenge can be re-used without re-typing; NULL means somebody wrote
-- this one from scratch.
CREATE TABLE IF NOT EXISTS arena_challenges (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id       uuid NOT NULL REFERENCES arena_sessions(id) ON DELETE CASCADE,
  spin_id          uuid REFERENCES arena_spins(id) ON DELETE SET NULL,
  library_key      text,
  seq              integer NOT NULL DEFAULT 0,
  title            text NOT NULL,
  prompt           text NOT NULL,
  detail           text,
  tier             integer NOT NULL DEFAULT 1,
  proof_type       text NOT NULL DEFAULT 'text',
  award_mode       text NOT NULL DEFAULT 'everyone',
  slots            integer NOT NULL DEFAULT 1,
  tickets_awarded  integer NOT NULL DEFAULT 1,
  prize_cap_cents  integer NOT NULL DEFAULT 0,
  opens_at         timestamptz,
  closes_at        timestamptz,
  state            text NOT NULL DEFAULT 'scheduled',
  created_by       uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE arena_challenges DROP CONSTRAINT IF EXISTS arena_challenges_state_chk;
ALTER TABLE arena_challenges ADD CONSTRAINT arena_challenges_state_chk
  CHECK (state IN ('scheduled', 'live', 'closed', 'skipped', 'cancelled'));
-- How somebody proves they did it. There is deliberately no 'automatic': PILOT
-- records no call log, no dial count and no talk time, so a challenge about a
-- call is proved by a person showing it and an admin agreeing — never by a
-- number this system does not have.
ALTER TABLE arena_challenges DROP CONSTRAINT IF EXISTS arena_challenges_proof_chk;
ALTER TABLE arena_challenges ADD CONSTRAINT arena_challenges_proof_chk
  CHECK (proof_type IN ('upload', 'text', 'checkin', 'count', 'peer'));
-- 'first'    — the first approved fulfilment takes the slot, and everybody else
--              is told plainly that somebody has already won this one;
-- 'first_n'  — the first `slots` of them;
-- 'everyone' — anybody who does it earns their tickets.
ALTER TABLE arena_challenges DROP CONSTRAINT IF EXISTS arena_challenges_award_chk;
ALTER TABLE arena_challenges ADD CONSTRAINT arena_challenges_award_chk
  CHECK (award_mode IN ('first', 'first_n', 'everyone'));
ALTER TABLE arena_challenges DROP CONSTRAINT IF EXISTS arena_challenges_numbers_chk;
ALTER TABLE arena_challenges ADD CONSTRAINT arena_challenges_numbers_chk
  CHECK (tier BETWEEN 1 AND 5 AND slots >= 1 AND tickets_awarded >= 0 AND prize_cap_cents >= 0);
CREATE INDEX IF NOT EXISTS arena_challenges_session_idx ON arena_challenges (session_id, opens_at);
CREATE INDEX IF NOT EXISTS arena_challenges_due_idx
  ON arena_challenges (opens_at) WHERE state = 'scheduled';
CREATE INDEX IF NOT EXISTS arena_challenges_live_idx
  ON arena_challenges (session_id, closes_at) WHERE state = 'live';

-- ── (4) FULFILMENTS — "I did it, here is the proof" ─────────────────────────
-- One row per person per challenge. `evidence_ref` is a stored file (the
-- screenshot of a call log); `note` is what they typed. The owner asked that a
-- fulfilment always carry a reason — "needs to put a note on why they fulfilled
-- it" — so `note` is NOT NULL.
CREATE TABLE IF NOT EXISTS arena_challenge_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_id    uuid NOT NULL REFERENCES arena_challenges(id) ON DELETE CASCADE,
  staff_id        uuid NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  note            text NOT NULL,
  evidence_ref    text,
  evidence_name   text,
  evidence_mime   text,
  evidence_bytes  integer,
  count_value     integer,
  status          text NOT NULL DEFAULT 'pending',
  place           integer,
  tickets_awarded integer NOT NULL DEFAULT 0,
  decided_by      uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  decided_at      timestamptz,
  decline_reason  text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE arena_challenge_entries DROP CONSTRAINT IF EXISTS arena_challenge_entries_status_chk;
ALTER TABLE arena_challenge_entries ADD CONSTRAINT arena_challenge_entries_status_chk
  CHECK (status IN ('pending', 'approved', 'rejected'));
CREATE UNIQUE INDEX IF NOT EXISTS arena_challenge_entries_one_idx
  ON arena_challenge_entries (challenge_id, staff_id);
CREATE INDEX IF NOT EXISTS arena_challenge_entries_staff_idx ON arena_challenge_entries (staff_id);
CREATE INDEX IF NOT EXISTS arena_challenge_entries_pending_idx
  ON arena_challenge_entries (challenge_id) WHERE status = 'pending';

-- ── (5) TICKETS — the ledger, never a running total on a person ─────────────
-- A LEDGER, deliberately, not a counter column. A counter has to be right the
-- first time and stays wrong forever if a decision is reversed; rows can be
-- added, reversed with a negative, and always add up to the truth. It is also
-- the only way "why do I have seven chances?" has an answer.
CREATE TABLE IF NOT EXISTS arena_tickets (
  id            bigserial PRIMARY KEY,
  session_id    uuid NOT NULL REFERENCES arena_sessions(id) ON DELETE CASCADE,
  spin_id       uuid REFERENCES arena_spins(id) ON DELETE CASCADE,
  staff_id      uuid NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  challenge_id  uuid REFERENCES arena_challenges(id) ON DELETE SET NULL,
  entry_id      uuid REFERENCES arena_challenge_entries(id) ON DELETE SET NULL,
  count         integer NOT NULL DEFAULT 1,
  source        text NOT NULL DEFAULT 'challenge',
  reason        text,
  created_by    uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE arena_tickets DROP CONSTRAINT IF EXISTS arena_tickets_source_chk;
ALTER TABLE arena_tickets ADD CONSTRAINT arena_tickets_source_chk
  CHECK (source IN ('challenge', 'manual', 'bonus', 'reversal'));
CREATE INDEX IF NOT EXISTS arena_tickets_who_idx ON arena_tickets (session_id, staff_id);
CREATE INDEX IF NOT EXISTS arena_tickets_spin_idx ON arena_tickets (spin_id, staff_id);
-- One ticket award per fulfilment, so a double-approve or a replayed request
-- cannot quietly hand somebody two chances for one piece of work. The reversal
-- rows carry no entry_id and are therefore unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS arena_tickets_one_per_entry_idx
  ON arena_tickets (entry_id) WHERE entry_id IS NOT NULL AND source = 'challenge';

-- ── (6) NOMINATIONS EARNED — which entry a person's tickets paid for ────────
-- The owner's rule: "for every five chances that they have in the spin, they
-- can choose another thing to be within the spin to win the second level."
-- Recording WHICH entry was unlocked (rather than counting entries) means the
-- allowance is not silently re-spent if an entry is later declined.
ALTER TABLE arena_entries ADD COLUMN IF NOT EXISTS unlocked_by_tickets integer;

-- ── (7) A PERSON'S ARRIVAL — "I am here, indoors, on time" ──────────────────
-- The Early Bird spin's check-in is a real arrival claim, not just a click, so
-- the wording the person agreed to is stored with it. Kept on the existing
-- check-in row rather than in a new table: it IS a check-in.
ALTER TABLE arena_checkins ADD COLUMN IF NOT EXISTS attested text;

-- BACKFILL: none, deliberately. Every column above is NULL / empty-array /
-- default on every existing row, which reads exactly as the row read before.

-- ── after this lands ────────────────────────────────────────────────────────
-- The schema map (docs/schema/) describes the database these migrations build,
-- so this file makes it stale. CI refreshes it on this pull request by itself;
-- if you would rather do it by hand, with DATABASE_URL pointing at a database
-- built from these migrations:
--
--   npm run schema:snapshot     # refresh the inventory from the database
--   npm run schema:restamp      # re-stamp the map header (no database needed)
