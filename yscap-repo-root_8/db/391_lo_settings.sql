-- 391_lo_settings.sql — per-loan-officer BUSINESS settings (owner-directed
-- 2026-07-31: "the loan officers should have their settings section where they
-- can set different settings … different per loan officer how he wants to run
-- his business — add over there a setting section if they want to change the
-- default and automatically default to CC their borrowers [on title orders]").
--
-- One row per staffer, a validated jsonb bag (src/lib/lo-settings.js owns the
-- key whitelist + defaults — an unknown key is refused at the route, never
-- silently stored). Distinct from the notification-center tables (db/226/227/
-- 368), which are about notification delivery; this is how the officer RUNS
-- their business (first key: ccBorrowerOnTitleOrder, default false). Idempotent.

CREATE TABLE IF NOT EXISTS lo_settings (
  staff_id   uuid PRIMARY KEY REFERENCES staff_users(id) ON DELETE CASCADE,
  settings   jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
