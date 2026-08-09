-- ============================================================================
-- 503 — THE ELEMENTIX CALL LEDGER: who spent what, and a cap that survives a
--       restart and spans every instance.
--
-- ── THE OWNER'S HARD CONSTRAINT, VERBATIM ───────────────────────────────────
-- "You should never skip trace contacts, which means you should never display
--  contact phone numbers because you never retrieve contact phone numbers that
--  were not yet skip traced. If it's already skip traced, then you can look at
--  it if you want to, but if you didn't, I don't want to do this to cost me
--  money because I have only 1,000 per month."
--
-- The FIRST line of defence is that `src/lib/elementix/lookups.js` cannot reach
-- the paid tool at all — it is not in the module. This table is the second: it
-- is what makes a spend attributable and countable, so "have we used our 1,000
-- this month?" has an answer, and so does "who spent them".
--
-- ── WHY A TABLE AND NOT A COUNTER IN MEMORY ─────────────────────────────────
-- The client's rate bucket lives in process memory today, which means the
-- self-imposed 400/hour is really N × 400 across however many instances Render
-- happens to be running, and it resets to zero on every deploy. That is
-- tolerable for a throughput guard and NOT tolerable for money: a monthly cap
-- that forgets itself on a restart is not a cap. So every call is recorded here
-- and both counts are read from the database.
--
-- Cheap by construction: the hourly count reads a partial index over the last
-- hour, and the rows are pruned by the same pass that writes them.
--
-- ── WHY THE STAFF ID IS ON EVERY ROW ────────────────────────────────────────
-- Elementix only ever sees ONE company account, so the vendor's own logs cannot
-- say who asked. Without this column "who used up the month's credits?" is
-- unanswerable — and the person who knows is the person the bill surprises.
--
-- Additive and idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS elementix_calls (
  id          bigserial PRIMARY KEY,
  tool        text NOT NULL,
  -- TRUE only for a tool that spends credits. The whole reason this table
  -- exists, so it is NOT NULL with no default that could hide one.
  paid        boolean NOT NULL,
  -- Who caused it. NULL only for a call with genuinely no human behind it,
  -- which for a PAID call must never happen (the route requires an actor).
  staff_id    uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  -- For a paid call: the person whose contact details were unlocked, and the
  -- reason given. A spend nobody can explain later is a spend nobody can defend.
  subject_id  text,
  reason      text,
  ok          boolean,
  detail      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- The hourly throughput count.
CREATE INDEX IF NOT EXISTS idx_elx_calls_recent ON elementix_calls(created_at DESC);
-- The monthly MONEY count — partial, because paid calls are a tiny minority and
-- this is the read that has to stay fast forever.
CREATE INDEX IF NOT EXISTS idx_elx_calls_paid ON elementix_calls(created_at DESC) WHERE paid;

COMMENT ON TABLE elementix_calls IS
  'db/503. Every Elementix call, with WHO asked. Backs the cross-instance hourly throughput '
  'guard and the monthly PAID cap — the owner allows 1,000 skip traces a month, and a cap held '
  'in process memory forgets itself on every deploy.';

COMMENT ON COLUMN elementix_calls.paid IS
  'True only for a credit-spending tool. NOT NULL with no default: a paid call that recorded '
  'itself as free would be invisible to the cap that exists to stop it.';
