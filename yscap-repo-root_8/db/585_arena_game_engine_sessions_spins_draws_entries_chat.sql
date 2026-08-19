-- ============================================================================
-- db/585 — THE ARENA: the live spin/game engine (owner-directed 2026-08-19)
--
-- WHAT THIS CHANGES, AND WHY. The owner asked for a company-wide live game for
-- "Elementix Day" — a sales day where the loan officers sit together and make
-- calls. In their words: the super admin controls it, "we launch the spinner
-- number one", everybody who arrived before a cutoff "goes into the spin and
-- everybody needs to check in from their login", the people who check in and
-- get approved may submit what they want to win (non-business up to $500,
-- business up to $1,000), the super admin accepts each one, and then "we do the
-- spin on our side … it spins for choosing a loan officer who's going to win
-- and then it spins for the thing they're gonna win". The day is a SESSION and
-- a session holds MANY spins; the record of every spin stays visible to
-- everyone until the session closes and a new one opens. Everyone watches the
-- same wheel, chats beside it, and can suggest what the next spin should be.
--
-- FIFTEEN TABLES, ONE PREFIX. Everything here is `arena_*`. This is an
-- INTERNAL STAFF tool — it is not a loan product. It reads the shared identity
-- roster (`staff_users`) and, for the spins the owner asked to wire into the
-- CRM, it READS RTL loan files. It writes nothing outside `arena_*`.
--
-- PRODUCT SEPARATION. Not Long-Term: no `lt_*` table is read or written, no
-- Long-Term module is imported, nothing crosses. It is an RTL-side/company
-- tool, and the one product surface it touches (candidate sources built from
-- loan files) reads `applications` only.
--
-- OFF BY DEFAULT, AND INVISIBLE WHEN OFF. `arena_settings.enabled` is FALSE on
-- every existing and new database. Owner: "we should be able to turn this on
-- and off from the admin side. When it's turned off, nobody should even see
-- that setting." The switch itself stays reachable by a super admin (otherwise
-- it could never be turned back on); everybody else sees no nav entry, no
-- screen and no route while it is off. The one definition of that rule is
-- src/lib/arena/settings.js — never re-inline it.
--
-- PROVABLY FAIR IS A COLUMN, NOT A PROMISE. Every wheel turn is an
-- `arena_draws` row carrying a commit-reveal record: `commit_hash` (the SHA-256
-- of a secret server seed) is published BEFORE the candidate list is frozen,
-- `roster` + `roster_hash` freeze exactly who was on the wheel and with what
-- weight, and `server_seed` is disclosed only after the wheel lands, so anyone
-- in the room can recompute the result and confirm it was not steered. This
-- mirrors the commit-reveal scheme used by regulated sweepstakes services
-- (RandomPicker's "certificate of fairness", Provable.io's sweepstakes API)
-- and by provably-fair gaming — see docs/ARENA-GAME-ENGINE-RESEARCH.md.
--
-- IDEMPOTENT. Every statement is IF NOT EXISTS / DROP-then-ADD, because
-- `migrate-boot` replays this file on EVERY boot.
--
-- BACKFILL: none, deliberately, except the two catalogs below. There is no
-- prior state to migrate — every table here is new. `arena_settings` seeds ONE
-- row with the master switch OFF, and `arena_prizes` seeds a starter prize
-- catalog which an admin edits or deletes; both are ON CONFLICT DO NOTHING so a
-- replay never overwrites an admin's edits.
-- ============================================================================

-- ── (1) SETTINGS — one row, the master switch and the company-wide defaults ──
-- Single-row by construction: `id` is a boolean fixed at true, so a second row
-- is impossible rather than merely discouraged.
CREATE TABLE IF NOT EXISTS arena_settings (
  id                boolean PRIMARY KEY DEFAULT true,
  enabled           boolean NOT NULL DEFAULT false,
  settings          jsonb   NOT NULL DEFAULT '{}'::jsonb,
  updated_by        uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT arena_settings_singleton CHECK (id)
);
INSERT INTO arena_settings (id, enabled, settings) VALUES (true, false, '{}'::jsonb)
  ON CONFLICT (id) DO NOTHING;

-- ── (2) SESSIONS — "Elementix Day" is one session; it holds many spins ──────
CREATE TABLE IF NOT EXISTS arena_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  subtitle          text,
  state             text NOT NULL DEFAULT 'draft',
  theme             text NOT NULL DEFAULT 'midnight',
  starts_at         timestamptz,
  ends_at           timestamptz,
  opened_at         timestamptz,
  closed_at         timestamptz,
  settings          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by        uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE arena_sessions DROP CONSTRAINT IF EXISTS arena_sessions_state_chk;
ALTER TABLE arena_sessions ADD CONSTRAINT arena_sessions_state_chk
  CHECK (state IN ('draft','live','closed'));
-- At most ONE live session at a time: the live board, the nav badge and every
-- "the current session" read would otherwise have to guess which one is meant.
CREATE UNIQUE INDEX IF NOT EXISTS arena_sessions_one_live_idx
  ON arena_sessions ((state)) WHERE state = 'live';
CREATE INDEX IF NOT EXISTS arena_sessions_created_idx ON arena_sessions (created_at DESC);

-- ── (3) SESSION MEMBERS — "we can select which users is gonna be involved" ───
-- Absence of ANY row for a session means "everyone on the active staff roster",
-- which is what an admin who never opened the picker meant. A removed_at row is
-- a person taken out, kept for the record rather than deleted.
CREATE TABLE IF NOT EXISTS arena_session_members (
  session_id        uuid NOT NULL REFERENCES arena_sessions(id) ON DELETE CASCADE,
  staff_id          uuid NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  added_by          uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  added_at          timestamptz NOT NULL DEFAULT now(),
  removed_at        timestamptz,
  PRIMARY KEY (session_id, staff_id)
);
CREATE INDEX IF NOT EXISTS arena_session_members_staff_idx ON arena_session_members (staff_id);

-- ── (4) SPINS — "spinner number one", then two, then three ──────────────────
-- `kind` is a key from the game-type catalog in src/lib/arena/game-types.js.
-- The catalog lives in CODE, not here, so the list of games can grow without a
-- migration and can never drift from the rules that read it; `config` holds the
-- answers an admin gave for that game (its wheels, deadline, caps, weights).
CREATE TABLE IF NOT EXISTS arena_spins (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id        uuid NOT NULL REFERENCES arena_sessions(id) ON DELETE CASCADE,
  seq               integer NOT NULL,
  title             text NOT NULL,
  subtitle          text,
  kind              text NOT NULL DEFAULT 'classic_raffle',
  state             text NOT NULL DEFAULT 'draft',
  config            jsonb NOT NULL DEFAULT '{}'::jsonb,
  entry_opens_at    timestamptz,
  entry_deadline_at timestamptz,
  locked_at         timestamptz,
  decided_at        timestamptz,
  outcome_note      text,
  created_by        uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE arena_spins DROP CONSTRAINT IF EXISTS arena_spins_state_chk;
ALTER TABLE arena_spins ADD CONSTRAINT arena_spins_state_chk
  CHECK (state IN ('draft','open','locked','spinning','decided','cancelled'));
CREATE UNIQUE INDEX IF NOT EXISTS arena_spins_session_seq_idx ON arena_spins (session_id, seq);
CREATE INDEX IF NOT EXISTS arena_spins_session_state_idx ON arena_spins (session_id, state);
CREATE INDEX IF NOT EXISTS arena_spins_deadline_idx
  ON arena_spins (entry_deadline_at) WHERE state = 'open';

-- ── (5) CHECK-INS — "everybody that arrived before 11:38 goes into the spin" ─
-- One row per person per spin. `status` is 'pending' until a super admin
-- approves ("everybody that checks in … and gets approved to be in the spin"),
-- unless the spin is configured to auto-approve. `checked_in_at` is the stamp
-- the cutoff is judged against — a late check-in is REFUSED at the door rather
-- than silently accepted and quietly dropped from the wheel.
CREATE TABLE IF NOT EXISTS arena_checkins (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  spin_id           uuid NOT NULL REFERENCES arena_spins(id) ON DELETE CASCADE,
  staff_id          uuid NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  status            text NOT NULL DEFAULT 'pending',
  note              text,
  checked_in_at     timestamptz NOT NULL DEFAULT now(),
  decided_by        uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  decided_at        timestamptz,
  decline_reason    text
);
ALTER TABLE arena_checkins DROP CONSTRAINT IF EXISTS arena_checkins_status_chk;
ALTER TABLE arena_checkins ADD CONSTRAINT arena_checkins_status_chk
  CHECK (status IN ('pending','approved','rejected'));
CREATE UNIQUE INDEX IF NOT EXISTS arena_checkins_spin_staff_idx ON arena_checkins (spin_id, staff_id);
CREATE INDEX IF NOT EXISTS arena_checkins_staff_idx ON arena_checkins (staff_id);

-- ── (6) ENTRIES — what a person asked to win, and the admin's decision ──────
-- Owner: "anything not related to business they can choose something up to five
-- hundred … everything that is related to business that can be up to thousand
-- dollars … they type in everything, super admin accepts everything."
-- `value_cents` is money in CENTS (integer) — never a float.
CREATE TABLE IF NOT EXISTS arena_entries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  spin_id           uuid NOT NULL REFERENCES arena_spins(id) ON DELETE CASCADE,
  staff_id          uuid NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  kind              text NOT NULL DEFAULT 'personal',
  label             text NOT NULL,
  detail            text,
  value_cents       integer NOT NULL DEFAULT 0,
  weight            integer NOT NULL DEFAULT 1,
  status            text NOT NULL DEFAULT 'pending',
  decided_by        uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  decided_at        timestamptz,
  decline_reason    text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE arena_entries DROP CONSTRAINT IF EXISTS arena_entries_kind_chk;
ALTER TABLE arena_entries ADD CONSTRAINT arena_entries_kind_chk
  CHECK (kind IN ('personal','business'));
ALTER TABLE arena_entries DROP CONSTRAINT IF EXISTS arena_entries_status_chk;
ALTER TABLE arena_entries ADD CONSTRAINT arena_entries_status_chk
  CHECK (status IN ('pending','approved','rejected'));
-- Non-negative money and a weight of at least one. The PER-KIND CAP ($500 /
-- $1,000) is deliberately NOT a check constraint: the owner set those numbers
-- as a SETTING they can change per spin, and a constraint would silently make a
-- setting unchangeable. The cap is enforced at the one door in
-- src/lib/arena/entry-rules.js, which the API and the tests both use.
ALTER TABLE arena_entries DROP CONSTRAINT IF EXISTS arena_entries_amounts_chk;
ALTER TABLE arena_entries ADD CONSTRAINT arena_entries_amounts_chk
  CHECK (value_cents >= 0 AND weight >= 1);
CREATE INDEX IF NOT EXISTS arena_entries_spin_idx ON arena_entries (spin_id, status);
CREATE INDEX IF NOT EXISTS arena_entries_staff_idx ON arena_entries (staff_id);

-- ── (7) QUALIFIERS — the "what did you do?" options on an achievement spin ───
-- Owner: "anybody either someone that had a call more than 10 minutes in the
-- call log or someone that had a tough rejection or someone that closed the
-- deal, and it spins between this three, and that person that has this and
-- comes the first showing it wins it."
CREATE TABLE IF NOT EXISTS arena_qualifiers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  spin_id           uuid NOT NULL REFERENCES arena_spins(id) ON DELETE CASCADE,
  seq               integer NOT NULL DEFAULT 1,
  label             text NOT NULL,
  description       text,
  evidence_hint     text,
  weight            integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS arena_qualifiers_spin_idx ON arena_qualifiers (spin_id, seq);

-- ── (8) CLAIMS — "I did that one", with the proof the admin reads ───────────
CREATE TABLE IF NOT EXISTS arena_claims (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  spin_id           uuid NOT NULL REFERENCES arena_spins(id) ON DELETE CASCADE,
  qualifier_id      uuid NOT NULL REFERENCES arena_qualifiers(id) ON DELETE CASCADE,
  staff_id          uuid NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  evidence          text,
  application_id    uuid REFERENCES applications(id) ON DELETE SET NULL,
  status            text NOT NULL DEFAULT 'pending',
  decided_by        uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  decided_at        timestamptz,
  decline_reason    text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE arena_claims DROP CONSTRAINT IF EXISTS arena_claims_status_chk;
ALTER TABLE arena_claims ADD CONSTRAINT arena_claims_status_chk
  CHECK (status IN ('pending','approved','rejected'));
CREATE UNIQUE INDEX IF NOT EXISTS arena_claims_one_per_qualifier_idx
  ON arena_claims (qualifier_id, staff_id);
CREATE INDEX IF NOT EXISTS arena_claims_spin_idx ON arena_claims (spin_id, status);

-- ── (9) DRAWS — one wheel turn, with its whole fairness record ──────────────
-- A "double spin" is simply two rows: seq 1 spins the people, seq 2 spins the
-- prizes (or the reverse — the owner asked to be able to choose which goes
-- first, so the order is the admin's, not the schema's).
--
-- THE FAIRNESS COLUMNS, in the order they are written:
--   commit_hash   SHA-256 of server_seed, published when the draw is created —
--                 BEFORE the roster is frozen, so no seed can be shopped
--                 against a known candidate list.
--   roster        the frozen, ordered candidate list with weights and labels.
--   roster_hash   SHA-256 of that frozen list, so it cannot be edited later.
--   client_seed   a value contributed in the room at spin time (typed by the
--                 host, or the session's own public value) so the house alone
--                 does not control the input.
--   nonce         which turn of this seed it was.
--   server_seed   NULL until the wheel lands; disclosed on reveal.
-- Anyone can then recompute HMAC-SHA256(server_seed, client_seed:nonce) and
-- confirm it selects the announced winner out of the frozen roster.
CREATE TABLE IF NOT EXISTS arena_draws (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  spin_id             uuid NOT NULL REFERENCES arena_spins(id) ON DELETE CASCADE,
  seq                 integer NOT NULL,
  title               text NOT NULL DEFAULT 'Draw',
  pool                text NOT NULL DEFAULT 'people',
  state               text NOT NULL DEFAULT 'committed',
  commit_hash         text NOT NULL,
  server_seed         text,
  client_seed         text,
  nonce               integer NOT NULL DEFAULT 1,
  roster              jsonb,
  roster_hash         text,
  winner_index        integer,
  winner_key          text,
  winner_label        text,
  winner_staff_id     uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  winner_entry_id     uuid REFERENCES arena_entries(id) ON DELETE SET NULL,
  target_rotation_deg numeric(12,4),
  duration_ms         integer NOT NULL DEFAULT 7000,
  spin_started_at     timestamptz,
  revealed_at         timestamptz,
  created_by          uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE arena_draws DROP CONSTRAINT IF EXISTS arena_draws_state_chk;
ALTER TABLE arena_draws ADD CONSTRAINT arena_draws_state_chk
  CHECK (state IN ('committed','spinning','revealed','void'));
CREATE UNIQUE INDEX IF NOT EXISTS arena_draws_spin_seq_idx ON arena_draws (spin_id, seq);
CREATE INDEX IF NOT EXISTS arena_draws_winner_idx
  ON arena_draws (winner_staff_id) WHERE winner_staff_id IS NOT NULL;

-- ── (10) AWARDS — the ledger of who actually won what ───────────────────────
-- Separate from `arena_draws` on purpose. A draw is a WHEEL TURN; an award is a
-- PRIZE HANDED TO A PERSON, which outlives the spin: the wheel that produced it
-- may be one of four on a single spin, and what somebody actually walked away
-- with is the thing people ask about weeks later. Exportable as well as
-- displayable, so a session's results can leave the screen.
CREATE TABLE IF NOT EXISTS arena_awards (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id        uuid NOT NULL REFERENCES arena_sessions(id) ON DELETE CASCADE,
  spin_id           uuid NOT NULL REFERENCES arena_spins(id) ON DELETE CASCADE,
  staff_id          uuid NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  prize_label       text NOT NULL,
  prize_kind        text NOT NULL DEFAULT 'personal',
  value_cents       integer NOT NULL DEFAULT 0,
  reason            text,
  entry_id          uuid REFERENCES arena_entries(id) ON DELETE SET NULL,
  awarded_at        timestamptz NOT NULL DEFAULT now(),
  acknowledged_at   timestamptz
);
CREATE INDEX IF NOT EXISTS arena_awards_session_idx ON arena_awards (session_id, awarded_at DESC);
CREATE INDEX IF NOT EXISTS arena_awards_staff_idx ON arena_awards (staff_id, awarded_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS arena_awards_spin_staff_idx ON arena_awards (spin_id, staff_id);

-- ── (11) MESSAGES — the live chat beside the wheel ──────────────────────────
-- Session-scoped so the whole day reads as one conversation; `spin_id` tags a
-- message to the spin that was on screen when it was written, which is what
-- makes "why did he win" readable months later.
CREATE TABLE IF NOT EXISTS arena_messages (
  id                bigserial PRIMARY KEY,
  session_id        uuid NOT NULL REFERENCES arena_sessions(id) ON DELETE CASCADE,
  spin_id           uuid REFERENCES arena_spins(id) ON DELETE SET NULL,
  staff_id          uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  kind              text NOT NULL DEFAULT 'chat',
  body              text NOT NULL,
  reaction_counts   jsonb NOT NULL DEFAULT '{}'::jsonb,
  pinned_at         timestamptz,
  deleted_at        timestamptz,
  deleted_by        uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE arena_messages DROP CONSTRAINT IF EXISTS arena_messages_kind_chk;
ALTER TABLE arena_messages ADD CONSTRAINT arena_messages_kind_chk
  CHECK (kind IN ('chat','system','celebration'));
CREATE INDEX IF NOT EXISTS arena_messages_session_idx ON arena_messages (session_id, id DESC);
CREATE INDEX IF NOT EXISTS arena_messages_pinned_idx
  ON arena_messages (session_id, pinned_at DESC) WHERE pinned_at IS NOT NULL;

-- ── (12) SUGGESTIONS — "what to put on the next spin" ───────────────────────
CREATE TABLE IF NOT EXISTS arena_suggestions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id        uuid REFERENCES arena_sessions(id) ON DELETE CASCADE,
  staff_id          uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  body              text NOT NULL,
  kind              text NOT NULL DEFAULT 'spin_idea',
  status            text NOT NULL DEFAULT 'new',
  decided_by        uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  decided_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE arena_suggestions DROP CONSTRAINT IF EXISTS arena_suggestions_status_chk;
ALTER TABLE arena_suggestions ADD CONSTRAINT arena_suggestions_status_chk
  CHECK (status IN ('new','planned','used','declined'));
CREATE INDEX IF NOT EXISTS arena_suggestions_session_idx ON arena_suggestions (session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS arena_suggestion_votes (
  suggestion_id     uuid NOT NULL REFERENCES arena_suggestions(id) ON DELETE CASCADE,
  staff_id          uuid NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (suggestion_id, staff_id)
);

-- ── (13) NOTICES — proof a reminder went out, so it goes out ONCE ───────────
-- Owner: "let's say before 11:38 there should be an alarm by eleven o'clock
-- that you still have 38 minutes to join the spin." The sweep that sends those
-- runs on a timer, and a timer that runs twice must not e-mail the company
-- twice — so each (spin, kind, offset) is claimed by a UNIQUE INDEX and the
-- sender only proceeds if the claim insert actually inserted a row.
CREATE TABLE IF NOT EXISTS arena_notices (
  id                bigserial PRIMARY KEY,
  spin_id           uuid NOT NULL REFERENCES arena_spins(id) ON DELETE CASCADE,
  kind              text NOT NULL,
  offset_minutes    integer NOT NULL DEFAULT 0,
  recipients        integer NOT NULL DEFAULT 0,
  sent_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS arena_notices_claim_idx
  ON arena_notices (spin_id, kind, offset_minutes);

-- ── (14) PRIZE CATALOG — a starter list, seeded ONCE, freely editable ───────
-- These are PRE-FILLED SETTINGS, not hard-coded behaviour: an admin edits,
-- deactivates or deletes any of them, and adds their own. Seeded ON CONFLICT DO
-- NOTHING against a stable `slug`, so replaying this migration never resurrects
-- a row an admin deleted's content or overwrites their edits.
CREATE TABLE IF NOT EXISTS arena_prizes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug              text,
  label             text NOT NULL,
  description       text,
  kind              text NOT NULL DEFAULT 'personal',
  value_cents       integer NOT NULL DEFAULT 0,
  is_active         boolean NOT NULL DEFAULT true,
  sort_order        integer NOT NULL DEFAULT 100,
  created_by        uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE arena_prizes DROP CONSTRAINT IF EXISTS arena_prizes_kind_chk;
ALTER TABLE arena_prizes ADD CONSTRAINT arena_prizes_kind_chk
  CHECK (kind IN ('personal','business','perk'));
-- PARTIAL unique index, because an admin-created prize has NO slug (a slug is
-- the seed's stable identity, not a user-facing field) and a plain UNIQUE would
-- then allow only ONE admin-created row. Any ON CONFLICT against this index
-- must therefore REPEAT the predicate — see the seed below.
CREATE UNIQUE INDEX IF NOT EXISTS arena_prizes_slug_idx ON arena_prizes (slug) WHERE slug IS NOT NULL;

INSERT INTO arena_prizes (slug, label, description, kind, value_cents, sort_order) VALUES
  ('half-day-friday',  'Leave early on Friday',        'Walk out at lunchtime with the afternoon paid.',                   'perk',     0,   10),
  ('prime-parking',    'The prime parking spot',       'The closest spot in the lot, yours for a month.',                  'perk',     0,   20),
  ('office-playlist',  'You pick the office music',    'The floor playlist is yours for a week.',                          'perk',     0,   30),
  ('no-meeting-day',   'A no-meetings day',            'One workday with your calendar cleared.',                          'perk',     0,   40),
  ('lunch-on-us',      'Lunch delivered, your choice', 'Anywhere you like, on the company.',                               'personal', 5000,  50),
  ('boss-does-admin',  'The boss does your admin',     'A manager takes your paperwork for a day.',                        'perk',     0,   60),
  ('pto-hour',         'An extra hour of PTO',         'One hour added to your time-off balance.',                         'perk',     0,   70),
  ('gift-card-250',    'Gift card — $250',             'Their choice of where to spend it.',                               'personal', 25000, 80),
  ('gift-card-500',    'Gift card — $500',             'Their choice of where to spend it.',                               'personal', 50000, 90),
  ('marketing-budget', 'Marketing budget — $1,000',    'A thousand dollars against your own marketing for the quarter.',   'business', 100000, 100),
  ('leads-package',    'A premium lead package',       'A block of premium leads routed to you first.',                    'business', 100000, 110),
  ('conference-seat',  'A seat at the next conference','Registration and travel to an industry event.',                    'business', 100000, 120)
-- The predicate is REPEATED here on purpose. Postgres cannot use a PARTIAL
-- unique index for ON CONFLICT unless the statement restates that index's
-- WHERE clause; without it this migration fails with 42P10 on its SECOND run,
-- and migrate-boot logs the failure and CONTINUES — so it would have broken
-- every future deploy quietly. (Observed, not assumed: the first replay against
-- a real Postgres failed exactly this way before the predicate was added.)
ON CONFLICT (slug) WHERE slug IS NOT NULL DO NOTHING;

-- ── after this lands ────────────────────────────────────────────────────────
-- The schema map (docs/schema/) describes the database these migrations build,
-- so this file makes it stale. CI refreshes it on this pull request by itself;
-- if you would rather do it by hand, with DATABASE_URL pointing at a database
-- built from these migrations:
--
--   npm run schema:snapshot     # refresh the inventory from the database
--   npm run schema:restamp      # re-stamp the map header (no database needed)
